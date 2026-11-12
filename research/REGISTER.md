# Register

> **History, not a to-do list.** This describes the instrument that was abandoned on
> 2026-11-11 (hammer, bow, sustain, stacks, memory), preserved on the branch
> `fluid/physics-audio-overhaul`. The project restarted around one rule, now on `main`; see
> `CLAUDE.md` for the current state. The measurements and dead ends below are
> still worth knowing. The proposals are not queued.

Consolidated state of the research program. Rows come from the four agent reports
in `proposals/`, filtered to what was actually verified against the code. Status
is what is true on this branch.

Background: `FLOOR.md` (what the 2017 dissertation did, and what it could not do).
Corpus: `../reference/text/*.txt`, page-marked and grep-able.

---

## Verified defects

Every one of these was confirmed by measurement, not inspection.

| # | Defect | Evidence | Status |
|---|--------|----------|--------|
| D1 | "Energy correction" pinned `Sum w^2` (enstrophy), not `Sum w^2/lambda` (energy). Basis is orthogonal but not orthonormal: `norm(phi_k)^2 = pi^2/(4*lambda_k)` | inviscid 180 s: enstrophy 0.00% drift, energy -49.3% | **fixed** |
| D2 | `lamMin/lamMax` read `eigenvalues[0]`/`[rank-1]`, but `buildIjPairs` orders by `max(k1,k2)`, not lambda | wrong at 30 of ranks 4..64; slider-reachable 20, 28, 40, 44, 52, 56. Rank 20 mapped top mode to 4684 Hz past a 4000 Hz ceiling | **fixed** |
| D3 | Same unsorted-eigenvalue assumption in modal percussion decay times | same enumeration | **fixed** |
| D4 | `f ∝ lambda^1.316` destroyed the basis harmonicity | an exact octave rendered as 3158 cents | **fixed** |
| D5 | Every strategy divided by `max|w|` each frame, erasing all dynamics | amplitude dimension switched off twice over: energy correction pinned the norm, then strategies renormalised it | **fixed** |
| D6 | Filter bank Q ramp 200..2000 on activity: 11.6 s ring at the low end | corresponds to nothing in the sim; this was the mud | **fixed** |
| D7 | Gesture direction was radial from canvas centre | dragging left and right through one cell gave identical force | **fixed** |
| D8 | `updateFromSim` called last in `frame()` | ~5.3 ms of avoidable audio latency per frame | **fixed** |
| D9 | Redundant `reconstruct()` per pointer event | ~1.25 ms/event; `step()` redoes it | **fixed** |
| D10 | Reset injected at the exact symmetry point | 0% of energy into the k=1 and k=3 shells | **fixed** |
| D11 | `SpectralEnvelopeStrategy` absent from `STRATEGY_FACTORIES` | never reachable | **fixed** |
| D12 | Harmonic series built partials above Nyquist at high rank | mode 255 wanted 28160 Hz; 38 clamped oscillators | **fixed** |
| D13 | `setCoefficients` / `frequenciesToCoefficients` called from nowhere | bidirectionality is a signature, not a feature | **open** |

## Structural findings

- **The basis is more harmonic than the code allowed.** `lambda(np,nq) = n^2*lambda(p,q)`, so under `f ∝ sqrt(lambda)` each family is an exact harmonic series. Rank 32 holds four overlapping series: `(1,1)` harmonics 1-5, `(2,1)` and `(1,2)` 1-3, three more pairs. That is bell structure, and it is free.
- **Degeneracy.** `(i,j)` and `(j,i)` share lambda. Rank 32 has only 19 distinct frequencies from 32 modes; rank 256 has 122. The degenerate pair's orientation is an unused handle.
- **No audio-band temporal frequency exists in `w`.** Measured oscillation rates 0.017-0.167 Hz; zero modes above 20 Hz. The reduced equation is first-order (`wdot = wCw - nu*Lambda*w`), so lambda is a decay rate, not a temporal frequency. `omega = sqrt(lambda)` is borrowed from the second-order elastic case and does not transfer. Pitch here is assigned by analogy; the fluid supplies a slow amplitude envelope.
- **DMD is the wrong tool for this solver.** Not cost (~1 Mflop) but window length: resolving 4-120 s periods needs minutes of history, and the analytic Jacobian gives the same `(sigma, omega, phi)` with no window. Hold for a future solver whose equations are not in closed form.
- **2D dual cascade is real but condenses.** With both invariants pinned, energy runs all the way to the largest mode: 98% in `(1,1)` within 5 s, then static. See R3.

## Done

| ID | Change | Result |
|----|--------|--------|
| R1 | `sqrt(lambda)` frequency mapping, default; `lambda`-linear and log-log on the M key | `(1,1)` family ratios exactly 1,2,3,4,5; octave 1200c |
| R2 | Filter bank envelope from the fluid: L1 shape, absolute loudness vs a slow peak, asymmetric 8 ms / 250 ms, `Q ∝ 1/sqrt(lambda)` | strike decays 20:1 over 60 s with brightness 322 -> 196 Hz |
| R3 | Two-parameter invariant projection `w_k -> w_k*sqrt(alpha + beta/lambda_k)` | correct dual cascade, but condenses to one mode in 5 s. **Behind `conserveEnstrophy`, off by default** |
| R4 | Sparse structure tensor (selection rules) + separable reconstruction | exact to 2e-15; rank 256 at 2.43 ms/step, 29% of frame budget; `U` no longer built |
| R5 | Rank ceiling 64 -> 256, default 256 | 19 -> 122 distinct pitches, 2.35 -> 4.00 octaves |
| R6 | Gesture carries direction and speed | a stir is a stir, not a click target |
| R7 | Shared `ModeAmplitudes`/`PeakTracker`; L1 across all four strategies | all four can swell and decay |

## State on 2026-11-11

Everything above this line was written on 2026-08-31, against an instrument that no
longer exists. Commit `f3f7bcd` replaced the four switchable strategies with one body
(hammer, bow, sustain), made silence the ground state, raised the default rank to 576,
and removed the two alternative frequency mappings. Read the tables above as history.

**Target.** CURRENTS 2027 (Santa Fe), Installation category. Application due
2026-12-08, judged on video, stills and a work statement. If accepted, visitors play it
unattended, 2027-06-11 to 06-20, through a small MIDI controller with a few simple
controls (planned, not built).

**Baseline, measured with `tools/measure.mjs`** (110 s pointer-only phrase, real output,
AudioContext running throughout, 60 fps):

| | value |
|---|---|
| active modes in `w` (participation ratio, of 576) | 45 after one tap, ~185 while playing, 3.5 at rest |
| audible partials (within 30 dB of the strongest) | 14-19 after one tap, 17-20 while playing |
| spectral centroid | 170-290 Hz |
| ring of one tap to -20 dB | 4.9 s |
| level at rest | -92 dB RMS (silence) |
| same tap before and after 40 s of playing | no meaningful difference: the instrument has no memory |

So the August figure of "1.5-2.3 effective active modes" is superseded. `w` is broad
while it is being played. The thinness is on the audio side (a dark, low spectrum of
about 20 partials) and in time: nothing a visitor does outlasts five seconds.

One defect found and fixed on the way (D14): a point strike claimed every free hammer
voice, so the 96-voice pool sat at 62-96 while playing and later strikes were starved.
Per-strike budget plus quietest-voice stealing: 23-24 audible partials on the same phrase.

## Open, ranked for the December 8 video

The arc the video needs: a stranger's touch that grows, remembers and resolves.

1. **Sediment** (composition.md 4), reshaped. A slow per-mode memory with three outputs:
   longer ring where it has been played, a faint held hum of the remembered modes, and
   the memory drawn as its own standing pattern. Time constant 15-20 s, not 45. No tonic
   or transposition machinery. An idle drain, which doubles as the gallery reset.
2. **The Room** (composition.md 3), near regime, sound only, automatic. Playing stretches
   the room up to ~3% off square so mirror pairs beat; rest relaxes it to unison. Families
   stay exact harmonic series at any aspect ratio. The hammer's fixed 3.4-cent pair
   detune has to become the room's variable.
3. **Brightness.** Centroid 170-290 Hz is dark. Not yet diagnosed: candidates are the
   contact-time rolloff, the `lambda^-0.75` ring law, and the 110 Hz base.
4. **Decorrelate the bow's degenerate filters.** Half done: the hammer has detuned,
   panned pairs. The bow still feeds every filter one noise source.

After acceptance, not before:

5. **MIDI control surface** for the installation. Keep gestures behind named actions so
   pointer and MIDI drive the same code.
6. **Larsen feedback** through `setCoefficients` (D13, still open). Unattended
   self-oscillation needs a governor first.
7. **Ekman drag** and the condensate arc. Needs a driven fluid, which conflicts with the
   silent ground state; its timescale at this rank is unmeasured.

## Killed

Unanimous across all four agents: **Phase 2** of `SONIFICATION_IDEAS.md` (Lanczos eigensolver, obstacle editor, NS rewrite). Turbulence adds the specific reason a numerical basis is worse than expected: it loses the analytic structure coefficients and their selection rules, making the tensor rebuild ~4.3e10 flops *per obstacle move*. The eigenfunction-solver-with-obstacles route (Option 4) is dead; grid NS with eigenmode projection for sound only (Options 2/5) remains viable.

Also killed: scale quantization in top-N tracking (strictly worse than the harmonicity already in the basis); the `cascadeQ`/`cascadeMul` terms (sonified a 3D cascade in a 2D sim); modal percussion as a standalone strategy; the 60 Hz mode table; the networked second player.
