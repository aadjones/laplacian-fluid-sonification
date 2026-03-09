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

    let e0 = 0;
    for (let i = 0; i < sim.w.length; i++) e0 += sim.w[i] * sim.w[i];

    for (let t = 0; t < 100; t++) sim.step();

    let e1 = 0;
    for (let i = 0; i < sim.w.length; i++) e1 += sim.w[i] * sim.w[i];

    expect(e1).toBeCloseTo(e0, 8);
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
