import { describe, it, expect } from 'vitest';
import { FluidSim } from './fluid';

describe('FluidSim', () => {
  it('constructs with default config', () => {
    const sim = new FluidSim();
    expect(sim.config.rank).toBe(16);
    expect(sim.config.xRes).toBe(64);
    expect(sim.w.length).toBe(16);
  });

  it('w starts at zero', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    for (let i = 0; i < sim.w.length; i++) {
      expect(sim.w[i]).toBe(0);
    }
  });

  it('step with zero w produces zero w', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    sim.step();
    for (let i = 0; i < sim.w.length; i++) {
      expect(sim.w[i]).toBe(0);
    }
  });

  it('injectImpulse creates nonzero w', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    sim.injectImpulse(8, 8, 0, 1000);
    let norm = 0;
    for (let i = 0; i < sim.w.length; i++) norm += sim.w[i] * sim.w[i];
    expect(norm).toBeGreaterThan(0);
  });

  it('energy is conserved across steps (inviscid)', () => {
    const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16, viscosity: 0 });
    sim.injectImpulse(8, 8, 0, 1000);

    // Energy is Σ w²/λ. The basis is orthogonal but not orthonormal
    // (‖φ_k‖² = π²/4λ_k), so Σ w² is the enstrophy, which is NOT pinned.
    const energy = () => {
      let e = 0;
      for (let i = 0; i < sim.w.length; i++) e += sim.w[i] * sim.w[i] / sim.eigenvalue(i);
      return e;
    };

    const e0 = energy();
    for (let t = 0; t < 100; t++) sim.step();
    expect(energy()).toBeCloseTo(e0, 8);
  });

  it('energy decays with viscosity', () => {
    const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16, viscosity: 1.0, dt: 0.001 });
    sim.injectImpulse(8, 8, 0, 1000);

    let e0 = 0;
    for (let i = 0; i < sim.w.length; i++) e0 += sim.w[i] * sim.w[i];

    for (let t = 0; t < 100; t++) sim.step();

    let e1 = 0;
    for (let i = 0; i < sim.w.length; i++) e1 += sim.w[i] * sim.w[i];

    // Energy correction preserves energy, then viscosity decays it,
    // but since energy correction runs first, the net effect should still show decay
    // Actually: step does advect→integrate→energy_correct→viscous_decay
    // So energy correction brings it back, then viscosity knocks it down.
    // Over 100 steps with viscosity=1, high modes should decay significantly.
    expect(e1).toBeLessThan(e0);
  });

  it('drag fades a single mode at exactly the drag rate, whatever its eigenvalue', () => {
    // A lone mode is a steady state, so with no viscosity drag is all that acts.
    const dt = 0.001;
    const drag = 3;
    const steps = 200;
    const expected = Math.exp(-drag * dt * steps);
    for (const mode of [0, 5, 8]) {
      const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16, viscosity: 0, drag, dt });
      sim.w[mode] = 10;
      for (let t = 0; t < steps; t++) sim.step();
      expect(sim.w[mode] / 10).toBeCloseTo(expected, 9);
    }
  });

  it('drag, unlike viscosity, fades low and high modes equally', () => {
    const low = 0;  // (1,1), eigenvalue 2
    const high = 8; // (3,3), eigenvalue 18
    const remaining = (config: { viscosity: number; drag: number }, mode: number) => {
      const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16, dt: 0.001, ...config });
      sim.w[mode] = 1;
      for (let t = 0; t < 100; t++) sim.step();
      return sim.w[mode];
    };
    expect(remaining({ viscosity: 0, drag: 2 }, low)).toBeCloseTo(remaining({ viscosity: 0, drag: 2 }, high), 12);
    expect(remaining({ viscosity: 1, drag: 0 }, high)).toBeLessThan(0.5 * remaining({ viscosity: 1, drag: 0 }, low));
  });

  it('drag brings a stirred fluid to rest', () => {
    const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16, viscosity: 0, drag: 5, dt: 0.001 });
    sim.injectImpulse(5, 9, 300, 700);
    let before = 0;
    for (let i = 0; i < sim.w.length; i++) before += Math.abs(sim.w[i]);
    for (let t = 0; t < 2000; t++) sim.step();
    let after = 0;
    for (let i = 0; i < sim.w.length; i++) after += Math.abs(sim.w[i]);
    expect(after).toBeLessThan(before * 1e-3);
  });

  it('setCoefficients sets w and reconstructs velocity', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    sim.setCoefficients([1, 0, 0, 0]);
    expect(sim.w[0]).toBe(1);
    // Velocity should be non-zero after reconstruction
    let vNorm = 0;
    for (let i = 0; i < sim.velocity.length; i++) vNorm += sim.velocity[i] * sim.velocity[i];
    expect(vNorm).toBeGreaterThan(0);
  });

  it('step produces nontrivial dynamics (w evolves)', () => {
    const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16 });
    // Inject into two modes so advection (nonlinear) can transfer energy
    sim.w[0] = 1.0;
    sim.w[1] = 0.5;
    const w0 = new Float64Array(sim.w);

    for (let t = 0; t < 1000; t++) sim.step();

    // w should have changed from initial state
    let diff = 0;
    for (let i = 0; i < sim.w.length; i++) {
      diff += (sim.w[i] - w0[i]) ** 2;
    }
    expect(diff).toBeGreaterThan(1e-6);
  });

  it('eigenvalue returns k1² + k2²', () => {
    const sim = new FluidSim({ rank: 9, xRes: 16, yRes: 16 });
    // First pair is (1,1), eigenvalue = 2
    expect(sim.eigenvalue(0)).toBe(2);
  });

  it('getVelocity returns [u, v] at a grid cell', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    sim.setCoefficients([1, 0, 0, 0]);
    const [u, v] = sim.getVelocity(8, 8);
    // Mid-domain should have nonzero velocity for mode (1,1)
    expect(u !== 0 || v !== 0).toBe(true);
  });

  it('reconstruct produces correct velocity for a single active mode', () => {
    const sim = new FluidSim({ rank: 4, xRes: 16, yRes: 16 });
    sim.w[0] = 1.0; // mode (1,1)
    sim.reconstruct();

    // For mode (1,1) with invLambda = 1/2:
    //   u(x,y) = (1/2) * sin(x) * cos(y)
    //   v(x,y) = -(1/2) * cos(x) * sin(y)
    // At x=0: sin(0)=0, so u=0 for all y (boundary condition)
    const [u0] = sim.getVelocity(0, 4);
    expect(Math.abs(u0)).toBeLessThan(1e-12);

    // At interior point, both components should be nonzero
    // Grid point (4,2) maps to (4*π/15, 2*π/15) — both sin and cos nonzero
    const [u2, v2] = sim.getVelocity(4, 2);
    expect(Math.abs(u2)).toBeGreaterThan(0.01);
    expect(Math.abs(v2)).toBeGreaterThan(0.01);
  });
});

describe('computeVorticity', () => {
  /** Direct O(rank·N) evaluation of omega = sum_k w_k sin(k1 x) sin(k2 y). */
  function referenceVorticity(sim: FluidSim, mask?: Float64Array): Float64Array {
    const { xRes, yRes } = sim.config;
    const dx = Math.PI / (xRes - 1);
    const dy = Math.PI / (yRes - 1);
    const out = new Float64Array(xRes * yRes);
    for (let k = 0; k < sim.config.rank; k++) {
      const wk = mask ? sim.w[k] * mask[k] : sim.w[k];
      if (wk === 0) continue;
      const { k1, k2 } = sim.pairs[k];
      for (let iy = 0; iy < yRes; iy++) {
        const sy = Math.sin(k2 * iy * dy);
        for (let ix = 0; ix < xRes; ix++) {
          out[iy * xRes + ix] += wk * Math.sin(k1 * ix * dx) * sy;
        }
      }
    }
    return out;
  }

  it('matches a direct evaluation of the eigenfunction sum', () => {
    const sim = new FluidSim({ rank: 64, xRes: 32, yRes: 32 });
    sim.injectImpulse(13, 9, 380, 1000);

    const out = new Float64Array(32 * 32);
    sim.computeVorticity(out);
    const ref = referenceVorticity(sim);

    let maxDiff = 0;
    let scale = 0;
    for (let i = 0; i < out.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
      scale = Math.max(scale, Math.abs(ref[i]));
    }
    expect(maxDiff / scale).toBeLessThan(1e-12);
  });

  it('a mask keeps exactly the masked modes and drops the rest', () => {
    const sim = new FluidSim({ rank: 64, xRes: 32, yRes: 32 });
    sim.injectImpulse(13, 9, 380, 1000);

    const mask = new Float64Array(64);
    mask[0] = 1;
    mask[5] = 1;

    const out = new Float64Array(32 * 32);
    sim.computeVorticity(out, mask);
    const ref = referenceVorticity(sim, mask);

    let maxDiff = 0;
    let scale = 0;
    for (let i = 0; i < out.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
      scale = Math.max(scale, Math.abs(ref[i]));
    }
    expect(scale).toBeGreaterThan(0);
    expect(maxDiff / scale).toBeLessThan(1e-12);
  });

  it('vanishes on the boundary, as the Dirichlet condition requires', () => {
    const sim = new FluidSim({ rank: 32, xRes: 24, yRes: 24 });
    sim.injectImpulse(11, 7, 380, 1000);

    const out = new Float64Array(24 * 24);
    sim.computeVorticity(out);

    for (let i = 0; i < 24; i++) {
      expect(Math.abs(out[i])).toBeLessThan(1e-12);                 // y = 0
      expect(Math.abs(out[23 * 24 + i])).toBeLessThan(1e-12);       // y = pi
      expect(Math.abs(out[i * 24])).toBeLessThan(1e-12);            // x = 0
      expect(Math.abs(out[i * 24 + 23])).toBeLessThan(1e-12);       // x = pi
    }
  });

  it('does not disturb the reconstruction workspace', () => {
    const sim = new FluidSim({ rank: 64, xRes: 32, yRes: 32 });
    sim.injectImpulse(13, 9, 380, 1000);
    sim.reconstruct();
    const before = Float64Array.from(sim.velocity);

    sim.computeVorticity(new Float64Array(32 * 32));
    sim.reconstruct();

    for (let i = 0; i < before.length; i++) {
      expect(sim.velocity[i]).toBe(before[i]);
    }
  });
});
