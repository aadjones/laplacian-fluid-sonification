/**
 * 2D Laplacian eigenfunction fluid simulation.
 *
 * Core simulation loop ported from laplacianEigen2D.cpp::stepEigenfunctions().
 * The w vector (eigenmode coefficients) is the universal state shared between
 * simulation, visualization, and sonification.
 */

import type { IjPair, SparseTensor, SeparableBasis } from './basis';
import {
  buildIjPairs,
  buildVelocityBasis,
  buildStructureTensor,
  buildSparseTensor,
  buildSeparableBasis,
} from './basis';

export interface FluidConfig {
  /** Number of eigenfunction modes (default 16) */
  rank: number;
  /** Grid resolution in x */
  xRes: number;
  /** Grid resolution in y */
  yRes: number;
  /** Timestep (default 0.0001) */
  dt: number;
  /**
   * Pin enstrophy as well as energy each step (see the projection in step()).
   * Physically this is what 2D Euler does and it produces a correct inverse
   * energy cascade — but in a closed box with no large-scale drag the cascade
   * runs to completion: measured at rank 256, 98% of the energy piles into the
   * single (1,1) mode within 5 seconds and the flow becomes one static vortex.
   * Off by default until there is an Ekman-style drag to arrest the condensate.
   */
  conserveEnstrophy: boolean;
  /** Viscosity coefficient (0 = inviscid, default 0) */
  viscosity: number;
}

export const DEFAULT_CONFIG: FluidConfig = {
  rank: 16,
  xRes: 64,
  yRes: 64,
  dt: 0.0001,
  viscosity: 0.0,
  conserveEnstrophy: false,
};

export class FluidSim {
  readonly config: FluidConfig;
  readonly pairs: IjPair[];

  /**
   * Structure tensor in sparse form. Advection touches only the nonzeros, which
   * are under 3% of rank³ by rank 64 and keep thinning as rank grows.
   */
  readonly sparseC: SparseTensor;
  /** Trig tables + k1 groupings for separable reconstruction (replaces U). */
  readonly separable: SeparableBasis;

  private _U: Float64Array | null = null;
  private _C: Float64Array | null = null;

  /**
   * Dense velocity basis, built on first access and cached. Nothing in the sim
   * needs it — reconstruct() and injectImpulse() evaluate the eigenfunctions
   * directly — but it stays available for tests and analysis. It is 67 MB at
   * rank 256, so touching it there is a deliberate act.
   */
  get U(): Float64Array {
    if (!this._U) {
      this._U = buildVelocityBasis(this.pairs, this.config.xRes, this.config.yRes);
    }
    return this._U;
  }

  /** Dense structure tensor, built on first access and cached. rank³ doubles. */
  get C(): Float64Array {
    if (!this._C) this._C = buildStructureTensor(this.pairs);
    return this._C;
  }

  /** Eigenmode coefficient vector — THE universal state */
  w: Float64Array;
  /** Time derivative of w (workspace, reused each step) */
  private wDot: Float64Array;

  /**
   * Current reconstructed velocity field. Split halves, not interleaved:
   * u occupies [0, fieldSize) and v occupies [fieldSize, 2*fieldSize).
   */
  velocity: Float64Array;

  /** Reconstruction workspace: per-k1-group partial sums over y. */
  private gu: Float64Array;
  private gv: Float64Array;

  /** CFL-like diagnostic: dt * max|wDot[k]| / max|w[k]|. Should stay < ~0.5. */
  cfl = 0;

  /**
   * 1/λ per mode. The velocity basis is orthogonal but NOT orthonormal:
   * ‖φ_k‖² = π²/(4λ_k). Kinetic energy is therefore ∝ Σ w[k]²/λ[k], while
   * Σ w[k]² is the enstrophy. Precomputed so the energy correction can pin
   * the right invariant without a per-step divide.
   */
  private readonly invLambda: Float64Array;

  constructor(config: Partial<FluidConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const { rank, xRes, yRes } = this.config;

    this.pairs = buildIjPairs(rank);
    this.sparseC = buildSparseTensor(this.pairs);
    this.separable = buildSeparableBasis(this.pairs, xRes, yRes);
    this.w = new Float64Array(rank);
    this.wDot = new Float64Array(rank);
    this.velocity = new Float64Array(2 * xRes * yRes);
    this.gu = new Float64Array((this.separable.maxK + 1) * yRes);
    this.gv = new Float64Array((this.separable.maxK + 1) * yRes);

    this.invLambda = new Float64Array(rank);
    for (let k = 0; k < rank; k++) {
      const { k1, k2 } = this.pairs[k];
      this.invLambda[k] = 1 / (k1 * k1 + k2 * k2);
    }
  }

  /**
   * Step the simulation forward by one timestep.
   * Implements: advect (structure tensor) → integrate → energy correct → viscous diffuse → reconstruct.
   */
  step(): void {
    const { rank, dt, viscosity } = this.config;
    const w = this.w;
    const wDot = this.wDot;

    // 2D Euler conserves BOTH energy (Σ w²/λ) and enstrophy (Σ w²); save each so
    // the projection below can restore both.
    let e1 = 0;
    let z1 = 0;
    for (let i = 0; i < rank; i++) {
      const ww = w[i] * w[i];
      e1 += ww * this.invLambda[i];
      z1 += ww;
    }

    // Advection: wDot[k] = w · (C_slab_k · w), accumulated over the nonzero
    // triads only. Identical arithmetic to the dense rank³ sweep, minus the
    // ~97% of terms that are structurally zero.
    wDot.fill(0);
    const { nnz, ks, as: sas, bs, coeffs } = this.sparseC;
    for (let i = 0; i < nnz; i++) {
      wDot[ks[i]] += coeffs[i] * w[sas[i]] * w[bs[i]];
    }

    // CFL diagnostic: max relative rate of change
    let maxWDot = 0;
    let maxW = 0;
    for (let k = 0; k < rank; k++) {
      if (Math.abs(wDot[k]) > maxWDot) maxWDot = Math.abs(wDot[k]);
      if (Math.abs(w[k]) > maxW) maxW = Math.abs(w[k]);
    }
    this.cfl = maxW > 0 ? dt * maxWDot / maxW : 0;

    // Euler integration
    for (let k = 0; k < rank; k++) {
      w[k] += dt * wDot[k];
    }

    // Invariant projection.
    //
    // A single scalar rescale can pin only one quantity, so whichever of energy
    // or enstrophy is left free absorbs the Euler error — and measured, that
    // error drives energy toward small scales, a forward cascade, which is
    // backwards for 2D. Instead rescale with a two-parameter family
    //
    //     w_k → w_k · sqrt(α + β/λ_k)
    //
    // which has exactly enough freedom to restore both. Writing
    // E = Σ w²/λ, Z = Σ w², M = Σ w²/λ², the rescaled values are
    // Z' = αZ + βE and E' = αE + βM, so matching (Z₀, E₀) is a 2x2 solve.
    // Cauchy-Schwarz gives E² ≤ Z·M, so the determinant is non-negative and
    // vanishes only when every λ is equal. With both invariants pinned the
    // cascade direction is set by the nonlinear term rather than by drift.
    let E = 0;
    let Z = 0;
    let M = 0;
    for (let k = 0; k < rank; k++) {
      const ww = w[k] * w[k];
      const il = this.invLambda[k];
      Z += ww;
      E += ww * il;
      M += ww * il * il;
    }
    const det = Z * M - E * E;
    if (this.config.conserveEnstrophy && det > 1e-30 && E > 0) {
      const alpha = (z1 * M - e1 * E) / det;
      const beta = (Z * e1 - E * z1) / det;
      for (let k = 0; k < rank; k++) {
        const s = alpha + beta * this.invLambda[k];
        w[k] *= s > 0 ? Math.sqrt(s) : 0;
      }
    } else if (E > 0) {
      // Default path: pin energy only and let enstrophy drift. Leaving enstrophy
      // free is what keeps the flow varied — with both pinned, the inverse
      // cascade condenses everything into the (1,1) mode within seconds.
      const scale = Math.sqrt(e1 / E);
      for (let k = 0; k < rank; k++) w[k] *= scale;
    }

    // Viscous diffusion
    if (viscosity > 0) {
      for (let k = 0; k < rank; k++) {
        const { k1, k2 } = this.pairs[k];
        const lambda = -(k1 * k1 + k2 * k2);
        w[k] *= Math.exp(lambda * dt * viscosity);
      }
    }

    // Reconstruct velocity field: v = U * w
    this.reconstruct();
  }

  /**
   * Reconstruct velocity from current w coefficients, without forming U.
   *
   * The eigenfunction separates:
   *   u =  ∑_k w_k (k2/λ) sin(k1 x) cos(k2 y)
   *   v = -∑_k w_k (k1/λ) cos(k1 x) sin(k2 y)
   * so modes sharing a k1 can be collapsed over y first, leaving one sweep in x
   * per distinct k1. Cost drops from O(rank·xRes·yRes) to
   * O(rank·yRes + maxK·xRes·yRes) — about 16x fewer operations at rank 256,
   * where maxK is 16 rather than 256.
   */
  reconstruct(): void {
    const { xRes, yRes } = this.config;
    const fieldSize = xRes * yRes;
    const sep = this.separable;
    const { maxK, sinX, cosX, sinY, cosY, groupStart, groupModes } = sep;
    const w = this.w;
    const v = this.velocity;
    const gu = this.gu;
    const gv = this.gv;

    // Pass 1: collapse each k1 group over y. O(rank * yRes).
    gu.fill(0);
    gv.fill(0);
    for (let k1 = 1; k1 <= maxK; k1++) {
      const base = k1 * yRes;
      for (let g = groupStart[k1]; g < groupStart[k1 + 1]; g++) {
        const m = groupModes[g];
        const wm = w[m];
        if (wm === 0) continue;
        const k2 = this.pairs[m].k2;
        const inv = this.invLambda[m];
        const au = wm * k2 * inv;
        const av = wm * k1 * inv;
        const yOff = k2 * yRes;
        for (let iy = 0; iy < yRes; iy++) {
          gu[base + iy] += au * cosY[yOff + iy];
          gv[base + iy] += av * sinY[yOff + iy];
        }
      }
    }

    // Pass 2: sweep x once per k1. O(maxK * xRes * yRes).
    v.fill(0);
    for (let k1 = 1; k1 <= maxK; k1++) {
      if (groupStart[k1] === groupStart[k1 + 1]) continue;
      const base = k1 * yRes;
      const xOff = k1 * xRes;
      for (let iy = 0; iy < yRes; iy++) {
        const guv = gu[base + iy];
        const gvv = gv[base + iy];
        if (guv === 0 && gvv === 0) continue;
        const row = iy * xRes;
        for (let ix = 0; ix < xRes; ix++) {
          v[row + ix] += sinX[xOff + ix] * guv;
          v[fieldSize + row + ix] -= cosX[xOff + ix] * gvv;
        }
      }
    }
  }

  /**
   * Inject a point impulse at grid position (gx, gy) with direction (fx, fy).
   * Projects the impulse onto the basis: w += U^T · force
   */
  injectImpulse(gx: number, gy: number, fx: number, fy: number): void {
    const { rank, xRes, yRes } = this.config;
    const sep = this.separable;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);

    // The impulse is a single cell, so the projection only needs the basis
    // evaluated at that one point — read straight off the trig tables rather
    // than out of U.
    for (let col = 0; col < rank; col++) {
      const { k1, k2 } = this.pairs[col];
      const inv = this.invLambda[col];
      const u = inv * k2 * sep.sinX[k1 * xRes + ix] * sep.cosY[k2 * yRes + iy];
      const v = -inv * k1 * sep.cosX[k1 * xRes + ix] * sep.sinY[k2 * yRes + iy];
      this.w[col] += u * fx + v * fy;
    }
  }

  /**
   * Set w directly from an external source (e.g., audio-driven mode).
   * This is the sound→fluid direction of the bidirectional mapping.
   */
  setCoefficients(coefficients: Float64Array | number[]): void {
    const len = Math.min(coefficients.length, this.config.rank);
    for (let i = 0; i < len; i++) {
      this.w[i] = coefficients[i];
    }
    this.reconstruct();
  }

  /**
   * Get the eigenvalue (spatial frequency squared) for mode k.
   * λ_k = k1² + k2² (positive; the actual Laplacian eigenvalue is negative).
   */
  eigenvalue(k: number): number {
    const { k1, k2 } = this.pairs[k];
    return k1 * k1 + k2 * k2;
  }

  /**
   * Get velocity at grid cell (x, y) as [u, v].
   * The velocity array stores u-components in [0..fieldSize) and v-components in [fieldSize..2·fieldSize).
   */
  getVelocity(x: number, y: number): [number, number] {
    const { xRes, yRes } = this.config;
    const fieldSize = xRes * yRes;
    const idx = y * xRes + x;
    return [this.velocity[idx], this.velocity[fieldSize + idx]];
  }
}
