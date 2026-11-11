# CLAUDE.md

## What this is

A Chladni plate made of fluid. A real-time 2D fluid built on Laplacian eigenfunctions
(De Witt et al.), where every shape has a sound and every sound has a shape. It descends
from Aaron's 2017 dissertation, *Seeing and Hearing Fluid Subspaces*.

**The one rule: the fluid's state `w` is the only state.** The picture is drawn from it and
the sound is read from it. The synthesis may be anything, but what plays, when, how loud
and with what spectrum must come from the fluid. Nothing is triggered, scheduled or
remembered outside `w`.

Before adding anything, check it against that rule. This branch (`restart/chladni-fluid`,
cut 2026-11-11) exists because the previous instrument grew a hammer, a bow, sustain,
stacks and a memory, each a reasonable fix, until it was a modal synth with a fluid beside
it. That version is preserved on `fluid/physics-audio-overhaul`.

## Commands

```bash
npm install
npm run dev           # Vite dev server
npm run build         # Type check + production build
npm test              # 29 tests (vitest)
node tools/measure.mjs <label>     # record a fixed 110 s pointer phrase (dev server running)
node tools/compare.mjs <a> <b>     # print two renders side by side
```

## Source

- `src/sim/basis.ts` — eigenfunction basis, ij pair ordering, analytic structure tensor
- `src/sim/fluid.ts` — `FluidSim`: step loop, velocity and vorticity reconstruction, `injectImpulse`
- `src/sim/dye.ts`, `src/sim/particles.ts` — passive dye and particles carried by the flow
- `src/viz/renderer.ts` — Canvas 2D: dye, vorticity underlay, particles
- `src/audio/sonifier.ts` — one sine per mode at `f = base·√(λ/λmin)`, loudness from `w`
- `src/audio/amplitude.ts` — L1 shape and peak-referenced loudness (the dissertation's eq. 2)
- `src/main.ts` — the page: one canvas, tap to poke, drag to stir
- `tools/` — signal measurement harness; renders go to `tools/renders/` (git-ignored)

## Things that are true and were expensive to learn

- **Frequency mapping is `√λ`.** Because `λ(np,nq) = n²·λ(p,q)`, every family of modes is
  an exact harmonic series. Other mappings destroy that.
- **`w` has no audio-rate motion.** The reduced equation is first order, so λ is a decay
  rate, not a frequency. Measured oscillation in `w` is 0.02–0.2 Hz. The fluid gives
  envelopes and spectra; pitch is assigned by the mapping.
- **Low modes linger, high modes die.** Viscous decay is `ν·λ`: at default damping the
  lowest mode lasts about 80 wall seconds and the highest under a second.
- **The basis is orthogonal, not orthonormal.** Energy is `Σ w²/λ`; `Σ w²` is enstrophy.
- **Eigenvalues are not sorted.** `buildIjPairs` orders by `max(k1,k2)`; never take
  `eigenvalues[0]` as the minimum.
- **A suspended AudioContext is silent with no other symptom.** Always report its state
  and `currentTime` with any measurement.

## Data layout

- Velocity field: `Float64Array`, length `2·xRes·yRes`; u in the first half, v in the second.
- Grid domain is `[0,π]²`, `dx = π/(xRes−1)`, centred grid.
- All arrays are `Float64Array`.

## Background

- `research/FLOOR.md` — what the 2017 dissertation did, chose not to do, and could not do
- `research/REGISTER.md` and `research/proposals/` — history of the previous instrument;
  useful for measurements and dead ends, not as a to-do list
- `reference/text/*.txt` — the dissertation and papers, page-marked
- C++ reference for the solver: `~/Documents/Code/app-development/UCSB/LaplacianEigenfunctions/projects/laplacianEigen2D/laplacianEigen2D.cpp`
