# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based real-time 2D fluid simulation with bidirectional eigenmode↔frequency sonification. Uses Laplacian eigenfunctions (De Witt et al.) as the velocity basis and maps eigenmode coefficients to Web Audio oscillators.

The `w` vector (eigenmode coefficients) is the universal state shared between simulation, visualization, and sonification. The system is bidirectional: physics can drive sound, and composed frequencies can drive the fluid visualization.

## Build Commands

```bash
npm install           # Install dependencies
npm run dev           # Dev server (Vite)
npm run build         # Type check + production build
npm test              # Run 25 tests (vitest)
npm run test:watch    # Watch mode tests
```

## Architecture

### Source Layout

- `src/sim/basis.ts` — Eigenfunction basis construction, ij pair ordering, analytic structure tensor C
- `src/sim/fluid.ts` — `FluidSim` class: simulation step loop, velocity reconstruction, impulse injection, `setCoefficients` (sound→fluid)
- `src/sim/dye.ts` — Passive scalar (RGB dye) transport via semi-Lagrangian advection
- `src/viz/renderer.ts` — Canvas 2D renderer: dye primary layer + vorticity underlay + particle overlay
- `src/audio/sonifier.ts` — Web Audio strategy manager, frequency mapping, fluid↔sound bridge
- `src/audio/strategy.ts` — `SonificationStrategy` interface
- `src/audio/strategies/filterBank.ts` — Resonant filter bank: noise→high-Q bandpasses (Q 200–2000)
- `src/audio/strategies/modalPercussion.ts` — Event-driven pings on mode energy spikes
- `src/audio/strategies/harmonicSeries.ts` — Mode k → harmonic (k+1), w = spectral amplitudes
- `src/main.ts` — App shell, DOM setup, interaction handlers, main loop

### Key Concepts

**Simulation loop** (`FluidSim.step()`): advect via structure tensor → Euler integrate → energy correct → viscous diffuse → reconstruct velocity. Ported from `laplacianEigen2D.cpp::stepEigenfunctions()` in the C++ reference at `~/Documents/Code/app-development/UCSB/LaplacianEigenfunctions/`.

**Structure tensor C**: Precomputed rank³ tensor encoding nonlinear mode interactions. Uses analytic coefficients from trig product-to-sum identities (`structureCoefficientAnalytic`). Sparse due to selection rules.

**Frequency mapping**: Log-log mapping from eigenvalue range [λ_min, λ_max] to frequency range [freqLow, freqHigh] (default 55–4000 Hz, ~6 octaves). Perceptually uniform spacing across the keyboard. Configurable via `SonifierConfig.freqLow`/`freqHigh`.

**Mode-selective forcing**: Number keys 1–9 toggle direct w[k] coefficient driving (Chladni-inspired). Each forced mode is pumped sinusoidally at its natural frequency. Dye is injected at mode antinodes for visual feedback.

### Data Layout

- Velocity basis `U`: `Float64Array`, column-major, `(2 * xRes * yRes) × rank`. First half of each column is u-component, second half is v-component.
- Structure tensor `C`: `Float64Array`, flat `rank³`. Index as `C[b * rank² + a * rank + k]`.
- Velocity field: `Float64Array`, length `2 * xRes * yRes`. u-components in `[0..fieldSize)`, v-components in `[fieldSize..2*fieldSize)`.

## Testing

25 tests in `src/sim/basis.test.ts` and `src/sim/fluid.test.ts` covering:
- ij pair ordering and round-trip
- Eigenfunction boundary conditions, divergence-free property, orthogonality
- Structure tensor sparsity, self-interaction symmetry, slab extraction
- Energy conservation (inviscid), energy decay (viscous)
- Impulse injection, coefficient setting, velocity reconstruction
- Nontrivial dynamics (w evolves under advection)

Run a single test file: `npx vitest run src/sim/basis.test.ts`

## C++ Reference

The simulation math is ported from `~/Documents/Code/app-development/UCSB/LaplacianEigenfunctions/projects/laplacianEigen2D/laplacianEigen2D.cpp`. Key correspondences:
- `buildIJPairs` → `buildIjPairs`
- `buildVelocityBasis` + `eigenfunction()` → `buildVelocityBasis`
- `buildC` + `structureCoefficientAnalytic` → `buildStructureTensor` + `structureCoefficientAnalytic`
- `stepEigenfunctions` → `FluidSim.step()`

## Important Conventions

- All arrays are `Float64Array` for performance (matches C++ `double`)
- The eigenfunction uses the centered grid variant (not staggered, not FFTW-spaced)
- Grid domain is [0,π]² with `dx = π/(xRes-1)`
- Sonifier must be initialized from a user gesture (Web Audio autoplay policy)
- The `setCoefficients` method on FluidSim is the sound→fluid entry point
