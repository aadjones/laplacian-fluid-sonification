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
npm test              # Run 46 tests (vitest)
npm run test:watch    # Watch mode tests
```

## Architecture

### Source Layout

- `src/sim/basis.ts` — Eigenfunction basis construction, ij pair ordering, analytic structure tensor C
- `src/sim/fluid.ts` — `FluidSim` class: simulation step loop, velocity reconstruction, impulse injection, `setCoefficients` (sound→fluid)
- `src/sim/families.ts` — Harmonic mode families ("stacks"): the instrument's notes, plus strike weights
- `src/sim/dye.ts` — Passive scalar (RGB dye) transport via semi-Lagrangian advection
- `src/viz/renderer.ts` — Canvas 2D renderer: dye primary layer + vorticity underlay + particle overlay
- `src/audio/sonifier.ts` — The instrument's body: AudioContext, output chain, √λ frequency mapping, mode mask
- `src/audio/strategy.ts` — `SonificationStrategy` interface (update / strike / setDrive / setDamping / resetLevel)
- `src/audio/strategies/struckModal.ts` — The hammer: contact-time excitation, free-ringing detuned partial pairs
- `src/audio/strategies/filterBank.ts` — The bow: noise into resonators, pressure from stirring or an asserted drive
- `src/audio/amplitude.ts` — Shared L1 shape + peak-referenced loudness
- `src/main.ts` — App shell, DOM setup, interaction handlers, main loop

### Key Concepts

**Simulation loop** (`FluidSim.step()`): advect via structure tensor → Euler integrate → energy correct → viscous diffuse → reconstruct velocity. Ported from `laplacianEigen2D.cpp::stepEigenfunctions()` in the C++ reference at `~/Documents/Code/app-development/UCSB/LaplacianEigenfunctions/`.

**Structure tensor C**: Precomputed rank³ tensor encoding nonlinear mode interactions. Uses analytic coefficients from trig product-to-sum identities (`structureCoefficientAnalytic`). Sparse due to selection rules.

**Frequency mapping**: `f = base·√(λ/λmin)` — the physical modal relation, and the only
mapping the instrument is true under. Because `λ(np,nq) = n²λ(p,q)`, every family (p,q)
lands on an exact harmonic series. Two alternative mappings (λ-linear, log-log) were
removed: both falsified the note, the log-log fit rendering an exact octave as 3158 cents.

**The instrument, and its three gestures**: the hammer and the bow are both live at all
times — there is no strategy switch. A **strike** (click, or `K`) is an impulsive event
scheduled directly on the audio clock, because `w` is sampled once per frame and a hammer
is over in 2 ms. A **stir** (drag) bows the resonators, with pressure inferred from the L1
rate of change of `w`. A **sustain** (`H`) holds the selected stack against the damping,
asserting bow pressure directly via `setDrive` because a held stack barely moves `w`.

**Two ways of aiming one hammer**: `injectImpulse` projects a point force onto the
eigenbasis, and that projection *is* a spectrum. Striking a point plays whatever the
geometry excites there (broadband, inharmonic, a drumhead); striking a stack plays one
harmonic family (pitched, a tuned bar). Neither spectrum is designed; both are read off
the same projection.

**Damping is the damper pedal**: viscosity sets the fluid's decay rate ν·λ and each
partial's ring time 1/(ν·λ) at once. The UI calls it Damping.

### Data Layout

- Velocity basis `U`: `Float64Array`, column-major, `(2 * xRes * yRes) × rank`. First half of each column is u-component, second half is v-component.
- Structure tensor `C`: `Float64Array`, flat `rank³`. Index as `C[b * rank² + a * rank + k]`.
- Velocity field: `Float64Array`, length `2 * xRes * yRes`. u-components in `[0..fieldSize)`, v-components in `[fieldSize..2*fieldSize)`.

## Testing

46 tests in `src/sim/basis.test.ts`, `src/sim/fluid.test.ts` and `src/sim/families.test.ts` covering:
- ij pair ordering and round-trip
- Eigenfunction boundary conditions, divergence-free property, orthogonality
- Structure tensor sparsity, self-interaction symmetry, slab extraction
- Energy conservation (inviscid), energy decay (viscous)
- Impulse injection, coefficient setting, velocity reconstruction
- Nontrivial dynamics (w evolves under advection)
- Harmonic family enumeration, mode masks, strike weights and the hammer's strike-point notch

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
