/**
 * 2D Laplacian eigenfunction fluid simulation.
 *
 * Core simulation loop ported from laplacianEigen2D.cpp::stepEigenfunctions().
 * The w vector (eigenmode coefficients) is the universal state shared between
 * simulation, visualization, and sonification.
 */

import type { IjPair } from './basis';
import { buildIjPairs, buildVelocityBasis, buildStructureTensor } from './basis';

export interface FluidConfig {
  /** Number of eigenfunction modes (default 16) */
  rank: number;
  /** Grid resolution in x */
  xRes: number;
  /** Grid resolution in y */
  yRes: number;
  /** Timestep (default 0.0001) */
  dt: number;
  /** Viscosity coefficient (0 = inviscid, default 0) */
  viscosity: number;
}

export const DEFAULT_CONFIG: FluidConfig = {
  rank: 16,
  xRes: 64,
  yRes: 64,
  dt: 0.0001,
  viscosity: 0.0,
};

export class FluidSim {
  readonly config: FluidConfig;
  readonly pairs: IjPair[];

  /** Velocity basis matrix U: (2·xRes·yRes) × rank, column-major */
  readonly U: Float64Array;
  /** Structure tensor C: rank³ flat array */
  readonly C: Float64Array;

  /** Eigenmode coefficient vector — THE universal state */
  w: Float64Array;
  /** Time derivative of w (workspace, reused each step) */
  private wDot: Float64Array;

  /** Current reconstructed velocity field: [u0,v0, u1,v1, ...] interleaved per cell */
  velocity: Float64Array;

  /** CFL-like diagnostic: dt * max|wDot[k]| / max|w[k]|. Should stay < ~0.5. */
  cfl = 0;

  constructor(config: Partial<FluidConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const { rank, xRes, yRes } = this.config;

    this.pairs = buildIjPairs(rank);
    this.U = buildVelocityBasis(this.pairs, xRes, yRes);
    this.C = buildStructureTensor(this.pairs);
    this.w = new Float64Array(rank);
    this.wDot = new Float64Array(rank);
    this.velocity = new Float64Array(2 * xRes * yRes);
  }

  /**
   * Step the simulation forward by one timestep.
   * Implements: advect (structure tensor) → integrate → energy correct → viscous diffuse → reconstruct.
   */
  step(): void {
    const { rank, dt, viscosity } = this.config;
    const w = this.w;
    const wDot = this.wDot;

    // Save initial energy for energy correction
    let e1 = 0;
    for (let i = 0; i < rank; i++) e1 += w[i] * w[i];

    // Advection: wDot[k] = w · (C_slab_k · w)
    for (let k = 0; k < rank; k++) {
      // Compute slab * w, then dot with w
      let dot = 0;
      for (let b = 0; b < rank; b++) {
        let slabRow = 0;
        for (let a = 0; a < rank; a++) {
          slabRow += this.C[b * rank * rank + a * rank + k] * w[a];
        }
        dot += w[b] * slabRow;
      }
      wDot[k] = dot;
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

    // Energy correction: rescale to preserve initial energy
    let e2 = 0;
    for (let k = 0; k < rank; k++) e2 += w[k] * w[k];
    if (e2 > 0) {
      const scale = Math.sqrt(e1 / e2);
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
   * Reconstruct velocity from current w coefficients.
   * v = U * w where U is (2·fieldSize) × rank.
   */
  reconstruct(): void {
    const { rank, xRes, yRes } = this.config;
    const rowCount = 2 * xRes * yRes;
    const v = this.velocity;
    v.fill(0);

    for (let col = 0; col < rank; col++) {
      const wk = this.w[col];
      if (Math.abs(wk) < 1e-15) continue;
      const colOffset = col * rowCount;
      for (let row = 0; row < rowCount; row++) {
        v[row] += this.U[colOffset + row] * wk;
      }
    }
  }

  /**
   * Inject a point impulse at grid position (gx, gy) with direction (fx, fy).
   * Projects the impulse onto the basis: w += U^T · force
   */
  injectImpulse(gx: number, gy: number, fx: number, fy: number): void {
    const { rank, xRes, yRes } = this.config;
    const fieldSize = xRes * yRes;
    const rowCount = 2 * fieldSize;
    const idx = Math.floor(gy) * xRes + Math.floor(gx);

    for (let col = 0; col < rank; col++) {
      const colOffset = col * rowCount;
      // Project: dot product of basis column with sparse impulse vector
      this.w[col] += this.U[colOffset + idx] * fx
                   + this.U[colOffset + fieldSize + idx] * fy;
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
