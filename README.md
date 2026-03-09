# Laplacian Fluid Sonification

Real-time 2D fluid simulation with bidirectional eigenmode↔frequency sonification, running in the browser.

<img width="480" alt="vorticity visualization" src="screenshot-1.png">

## Concept

Laplacian eigenfunctions form a natural basis for incompressible fluid flow on a bounded domain. Each eigenmode (k₁,k₂) has a spatial frequency λ = k₁² + k₂² that maps directly to an audible frequency—the correspondence is physically natural, not arbitrary.

The system is **bidirectional**:
- **Fluid→Sound**: The simulation evolves eigenmode coefficients `w`, which drive a resonant filter bank
- **Sound→Fluid**: Composed frequencies set `w` directly, visualizing the corresponding flow pattern

The `w` vector is the universal state. Simulation, visualization, and sonification all read/write it.

### Theory

Based on De Witt et al., "Fluid Simulation Using Laplacian Eigenfunctions" and the sonification system from Aaron Demby Jones's dissertation "Seeing and Hearing Fluid Subspaces" (UCSB 2017).

**Simulation loop** (per timestep):
1. Advect via structure tensor: `wDot[k] = w · (C_k · w)` (O(rank³) quadratic form)
2. Euler integration: `w += dt · wDot`
3. Energy correction: rescale to preserve initial enstrophy
4. Viscous diffusion: `w[k] *= exp(λ_k · dt · ν)`
5. Reconstruct velocity: `v = U · w`

**Frequency mapping** (physical membrane overtone series):
```
f_k = fundamental · λ_k^(1/s)    (s=2 gives f ∝ √λ)
```
Low spatial modes → low pitch, high spatial modes → high pitch, matching how a rectangular membrane vibrates.

**Sonification** (subtractive synthesis):
```
white noise → bandpass[k] (center=f_k, Q∝|w[k]|) → gain[k] (∝w[k]²) → master → speakers
```
Each eigenmode is a resonance of the 2D domain. Filtering noise through them is literally "what would this cavity sound like if excited."

## Quick Start

```bash
npm install
npm run dev       # Open http://localhost:5173
npm test          # 25 tests
npm run build     # Production build
```

## Controls

| Input | Action |
|---|---|
| Drag canvas | Inject vorticity (also starts audio on first click) |
| Space | Pause / unpause |
| S | Toggle sound |
| M | Switch Simulation / Compose mode |
| R | Reset |
| 1-9 (compose mode) | Directly activate individual eigenmodes |

All simulation parameters are adjustable via the config panel sliders:

| Parameter | Default | Description |
|---|---|---|
| Modes (rank) | 32 | Number of eigenmodes in the basis |
| Grid | 128 | Spatial grid resolution |
| Viscosity | 0.005 | Damping coefficient (higher modes decay faster) |
| Steps/frame | 50 | Simulation substeps per render frame (speed control) |
| Click force | 5000 | Impulse magnitude when dragging |
| Timestep | 0.0001 | Euler integration step size |

## Architecture

```
src/
  sim/
    basis.ts       Eigenfunction basis, ij pairs, structure tensor C
    fluid.ts       FluidSim class: step loop, reconstruct, inject, setCoefficients
    basis.test.ts  14 tests: pairs, basis properties, structure tensor
    fluid.test.ts  11 tests: energy conservation, dynamics, reconstruction
  viz/
    renderer.ts    Canvas vorticity colormap (red=CCW, blue=CW)
  audio/
    sonifier.ts    Resonant filter bank, bidirectional freq↔mode mapping
  main.ts          App shell, config panel, interaction, main loop
```

### Key design decisions

- **Subtractive synthesis**: Resonant bandpass filters on white noise instead of sine oscillators. Each filter's Q and gain are driven by |w[k]|, producing a sound that responds dynamically to the flow—active modes ring sharply, inactive modes fade to silence.
- **Analytic structure coefficients**: Uses closed-form trig product-to-sum identities instead of numerical integration. The tensor is sparse due to selection rules.
- **Column-major flat arrays**: Velocity basis U and structure tensor C stored as `Float64Array` for cache-friendly access in the inner loop.
- **Energy correction**: Rescales w after advection to prevent numerical energy drift (same as C++ reference).
- **Live config panel**: All parameters adjustable in real-time. "Cold" params (rank, grid, dt) rebuild the sim; "hot" params (viscosity, steps/frame, force) apply instantly.

## C++ Reference

The simulation math is ported from `laplacianEigen2D.cpp` in the UCSB LaplacianEigenfunctions codebase. Key correspondences:
- `buildIJPairs` → `buildIjPairs`
- `buildVelocityBasis` + `eigenfunction()` → `buildVelocityBasis`
- `buildC` + `structureCoefficientAnalytic` → `buildStructureTensor` + `structureCoefficientAnalytic`
- `stepEigenfunctions` → `FluidSim.step()`
