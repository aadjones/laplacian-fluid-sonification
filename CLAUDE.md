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
npm test              # 32 tests (vitest)
node tools/measure.mjs <label>     # record a fixed 110 s phrase played on the pads (dev server running)
node tools/compare.mjs <a> <b>     # print two renders side by side
```

## Source

- `src/sim/basis.ts` — eigenfunction basis, ij pair ordering, analytic structure tensor
- `src/sim/fluid.ts` — `FluidSim`: step loop, velocity and vorticity reconstruction, `injectImpulse`
- `src/sim/dye.ts`, `src/sim/particles.ts` — passive dye and particles carried by the flow
- `src/viz/renderer.ts` — Canvas 2D: the figure (bright lines where rotation is zero, warm/cool tint for turning direction, fading with the fluid), dye, and particles drawn as streaks along their motion
- `src/audio/sonifier.ts` — one sine per mode at `f = base·√(λ/λmin)`, loudness from `w`
- `src/audio/amplitude.ts` — L1 shape and peak-referenced loudness (the dissertation's eq. 2)
- `src/main.ts` — the page: the plate (display only) and the lattice (one pad per mode; a dark pad sounds its mode, a lit pad mutes it; glow follows |w|)
- `tools/` — signal measurement harness; renders go to `tools/renders/` (git-ignored)

## Things that are true and were expensive to learn

- **Frequency mapping is `√λ`.** Because `λ(np,nq) = n²·λ(p,q)`, every family of modes is
  an exact harmonic series. Other mappings destroy that.
- **`w` has no audio-rate motion.** The reduced equation is first order, so λ is a decay
  rate, not a frequency. Measured oscillation in `w` is 0.02–0.2 Hz. The fluid gives
  envelopes and spectra; pitch is assigned by the mapping.
- **Viscosity is lopsided; drag is even.** Viscous decay is `ν·λ`, so with viscosity alone
  the lowest mode lasted about 80 wall seconds and the highest about one. `drag` damps
  every mode at the same rate and is what lets a note end: at 40, a low note falls 20 dB
  in about 5 s and the highest in about 2 s.
- **One mode is a steady note; two or more flow.** A lone eigenmode (or a mirror pair)
  never spreads. Different modes exchange energy at a rate set by how hard they were
  played: at a press of 100 a two-note chord wakes about 5 modes, at 300 about 14.
- **The basis is orthogonal, not orthonormal.** Energy is `Σ w²/λ`; `Σ w²` is enstrophy.
- **Eigenvalues are not sorted.** `buildIjPairs` orders by `max(k1,k2)`; never take
  `eigenvalues[0]` as the minimum.
- **A suspended AudioContext is silent with no other symptom.** Always report its state
  and `currentTime` with any measurement.

## Decisions already made

- **The lattice is the only input.** Poking and dragging on the plate was removed: each
  pointer move fired a full-strength point kick, which excites every mode at once. A real
  stir (a broad, gentle push) is a candidate, not yet built.
- **No figures inside the pads.** Tried; 64 small grids inside a grid was confusing.
- **Tracers run 6x faster than the fluid** (`tracerSpeed`). Dye and particles are passive and
  do not affect `w` or the sound; at true speed a note barely turns before it fades.
- **Dye alone cannot show the flow on this grid.** At 128 cells it smears within a second.
  Particle streaks carry the motion.

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
