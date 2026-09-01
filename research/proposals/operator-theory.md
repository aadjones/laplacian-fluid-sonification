# Operator-theoretic proposals

Aaron—these are proposals, not a review. Everything numeric below I ran, in
`node`, against a standalone replication of `basis.ts` + `fluid.ts` at your exact
`main.ts` config (rank 32, grid 128, dt 1e-4, viscosity 0.5, stepsPerFrame 2,
initial `injectImpulse(64,64,0,1000)`). Where I could not verify something I say so.

---

## What I measured first, because it reframes the whole problem

Four numbers, all checked:

**1. There is no temporal frequency in `w` anywhere near the audio band.**
Zero-crossing rates of each `w_k(t)`, sampled per frame over 60 s of wall clock:
**0.008–0.23 Hz**. Periods of 4 to 120 seconds. The leading eigenvalue of the
linearised reduced dynamics rotates faster—0.32–0.92 Hz wall-clock—but that is
still eight octaves below the bottom of hearing.

This matters because of *why*. In the elastic case the dissertation borrows from
(eq. 3.21), the reduced equation is second order, `q̈ᵢ + λᵢqᵢ = fᵢ`, so `ωᵢ = √λᵢ`
is a genuine temporal frequency. **The reduced fluid equation is first order:**
`ẇ = wᵀC w − ν Λ w`. There is no `ẅ + λw`. λ enters only as a *decay rate* and as a
spatial wavenumber. Mapping λ to pitch is a metaphor the equations do not support—
it sonifies spatial scale and calls it frequency. Everything audible in this system
is therefore either (a) a *ratio* structure you impose, or (b) a real temporal rate
that you transpose upward by an explicit factor. Proposals 1 and 7 take route (a).
Proposals 2–6 take route (b).

**2. The current λ→f map is harmonicity-destroying, by a factor of 2.6.**
`sonifier.ts:79-86` is a power law in disguise. Writing it out:

```
log f_k = log f_lo + (log λ_k − log λ_min) · log(f_hi/f_lo)/log(λ_max/λ_min)
        ⇒  f_k ∝ λ_k^γ ,   γ = log(f_hi/f_lo) / log(λ_max/λ_min)
```

Harmonic ratios live in `√λ`, i.e. at **γ = 0.5**. Your current values
(55→4000 Hz, λ ∈ [2, 52]) give **γ = 1.3157**. A λ-ratio of 4—an exact octave in
`√λ`—is rendered as **3158 cents**, not 1200. Any harmonic relation present in the
spectrum is annihilated before it reaches a filter. To get γ = 0.5 with `freqLow = 55`
you would need `freqHigh = 280 Hz`, a span of only 2.35 octaves. That is the real
trade: six octaves of register bought by destroying every interval. γ should be an
exposed slider, not an emergent consequence of two endpoint constants. This is the
dissertation's octave-scaling `s`—you dropped it and it turns out to have been
load-bearing.

(Also: `lamMax = eigenvalues[rank-1]` assumes `buildIjPairs` is λ-monotonic. It is
not. At rank 28 and rank 30 the true max λ is 50 but `eigenvalues[rank-1]` reads
40 and 45—those modes map above `freqHigh`. Real, minor, one line.)

**3. The flow is linearly unstable while energetic and neutrally stable once it
decays.** Computed as `σ_max = log ‖e^{JT}‖-leading-modulus / T` on the projected
Jacobian:

| wall time | ‖w‖ | σ_max (wall) | e-folding time |
|---|---|---|---|
| 0 s | 567 | 0.627 /s | 1.6 s |
| 1 s | 523 | 0.328 /s | 3.1 s |
| 10 s | 304 | 0.161 /s | 6.2 s |
| 30 s | 151 | 0.000 /s | stable |

A single scalar, in units of 1/time, in the range of musical phrase lengths, that
falls monotonically from "something is about to happen in 1.6 seconds" to "nothing
is going to happen." This is the macrostructure signal. Proposal 2.

**4. Leading oscillation frequency tracks `√energy`.** Across a 3.8× decay of ‖w‖,
`f_lead / ‖w‖` stayed within 1.62e-3 … 2.12e-3—a 31 % drift over a 380 % change.
`J` is linear in `w`, so this is expected, and it means: **with one fixed
transposition factor, the instrument glissandos downward as it loses energy**—
1.5 octaves over 30 s at your current viscosity. That is a real acoustic behaviour
(driven systems detune as they lose amplitude) obtained for free.

Cost context for everything below: `reconstruct()` already costs
`rank × 2·grid² = 1.05 M` mul-adds and runs **twice per frame**. Building `J` costs
`2r³ = 65 k`. A 32×32 nonsymmetric eigendecomposition costs ~330 k (eigenvalues) to
~800 k (with vectors). **Every operator-theoretic addition in this document is
cheaper than one call to `reconstruct()`.** Flops are not the constraint here;
lines of code and latency are. Also: `C` is 4.94 % dense (1620 of 32768 nonzeros),
so if you ever need headroom, a sparse triple-list advection is a free 20×.

---

## Verdict: analytic eigenfunctions vs. POD

**Keep the analytic basis. The 2017 objection is correct about the modes and wrong
about the consequence.**

He wrote that Laplacian eigenfunctions would be "more regular, undermining the
visual variety" [diss p.145]. They are more regular. But:

- **The viewer never sees a mode.** They see dye and 8000 particles advected by
  `U w(t)`. Variety comes from the trajectory in `w`-space, which is governed by the
  nonlinear structure tensor and is *not* more regular for being expressed in a
  regular basis. His own 2017 renders were smoke, not eigenvectors, for the same
  reason. Your current build has a richer visual channel than his did (his rendering
  was explicitly static, same lighting and colour every time [diss 7.3]).
- **The regularity is the asset, not the liability.** Proposal 1 exists *only*
  because the mode lattice is a lattice. POD modes have no arithmetic structure, so
  there is no way to extract exact harmonic relations from them—which is precisely
  why the Bridges paper had to invent an ad-hoc inversion-and-compression of singular
  values that "are energies, not frequencies." The analytic basis has exact
  eigenvalues *and* an exact, cheap, closed-form Jacobian. POD gives you neither.
- **POD is not shippable in a browser.** A rank-150 basis at 128² is
  `2·128²·150·8 B = 39 MB` (19.7 MB in Float32), plus an offline training pipeline
  and a subspace-lock-in problem the dissertation itself names as a dead end
  [diss 7.2]. Your analytic basis is ~1 M `sin`/`cos` calls at startup, tens of
  milliseconds, and a rank slider that works.

**Where he is right, and what to do instead of switching bases:** rank 32 tops out
at wavenumber 6. That *is* too regular, and it is a rank problem, not a basis
problem. Raise rank (rank 64 is already in your slider and buys the (1,1) ray four
more partials—see Proposal 1). If regularity still reads as sterile, break the
domain's symmetry—anisotropy (Proposal 7) or obstacle-perturbed modes—rather
than abandoning the structure that makes Proposals 1, 2, 3 and 7 possible.

---

## 1. Harmonic Rays

**Idea.** The eigenvalue lattice already contains exact harmonic series and nobody
has used them. For any primitive integer direction `(p,q)`, the modes
`(np, nq)` for `n = 1, 2, 3, …` have `√λ = n·√(p²+q²)`—an *exact* harmonic series
with fundamental `√(p²+q²)`. Not approximate. Exact. So instead of 32 mutually
inharmonic partials, the basis decomposes into a handful of perfectly harmonic
voices at mutually inharmonic fundamentals. That is not "mush"; that is how a
gamelan is built, and it is how an orchestra sounds. It solves your stated Core
Problem #1 without quantising to a scale, which the dissertation forbade [diss 6.5],
and without abandoning the physics.

**Mechanism.** Group mode indices by `(k₁/g, k₂/g)` where `g = gcd(k₁,k₂)`; the
harmonic number of a mode within its ray is `n = g`. Set γ = 0.5 (i.e. pitch
`∝ √λ`) so the ratios survive the mapping. Verified enumeration:

| rank | rays with ≥2 partials | structure |
|---|---|---|
| 32 | 6 | (1,1)→5 partials [idx 0,3,8,15,24]; (2,1)&(1,2)→3 each; (3,1),(1,3),(3,2)→2 each; 15 singletons |
| 64 | 11 | (1,1)→**8** partials [0,3,8,15,24,35,48,63]; (2,1)&(1,2)→4 each; eight 2-partial rays; 32 singletons |
| 100 | 19 | (1,1)→10; (2,1)&(1,2)→5; four 3-partial; twelve 2-partial |

Per ray, synthesise one voice: fundamental `f₀ = α·√(p²+q²)`, partial `n` at
`n·f₀`, amplitude `|w_{idx(n)}|` normalised by `√(Σ_k w_k²)` (the *conserved*
quantity—see the kill list). Singleton rays either get their own single-partial
voice or are pooled into a noise bed.

Two structural gifts fall out. First, viscous decay is `exp(−λ ν t)` and
`λ_n = n²λ_p`, so **higher partials decay as `n²`—the physically correct damping
law for a struck string.** Every ray voice will pluck and settle by itself, with no
envelope design. Second, the ray fundamentals `√(p²+q²)` form a genuine microtonal
scale, consistently 7–25 cents off 12-TET: (2,1) at 793 ¢ (≈ minor sixth −20 ¢),
(3,1) at 1393 ¢ (≈ major ninth −7 ¢), (3,2) at 1620 ¢, (5,3) at 2452 ¢. Exactly the
"middleground between scientific sonification and pure composition" [diss 6.5]—
not 12-TET, not arbitrary.

**Why it improves the artwork.** The current filter bank asks you to hear 32
unrelated pitches. This asks you to hear 6 (rank 32) or 11 (rank 64) *chords*, each
internally fused because its partials are exact integer multiples. Partial fusion is
the strongest grouping cue in auditory scene analysis; you will hear voices, not
bands. And the visual correlate is honest: a ray is a family of modes with the same
orientation at self-similar spatial scales, so the picture of a "voice" is a
coherent nested pattern rather than an arbitrary set of blobs.

**Falsifiable prediction.** Grouped as rays with γ = 0.5, the output will be
perceived as a small number of pitched sustained tones with independent
"pluck-and-settle" envelopes. **Wrong if:** the ray voices don't fuse—most likely
failure mode is the mirror degeneracy. `(p,q)` and `(q,p)` have *identical*
fundamentals, so `(2,1)` and `(1,2)` are exact unisons with independent amplitude
envelopes. That may read as flanging rather than as two voices. (Proposal 7 fixes
this deliberately.) Also wrong if 2.35 octaves of usable span is too cramped to hold
attention—in which case transpose whole rays by octaves, which preserves every
ratio.

**Cheapest test.** Offline, ~30 lines of node: run the sim 60 s, dump `w`, group by
gcd-ray, additively render each ray to a WAV with γ=0.5 and L2-fraction amplitudes.
Listen. No Web Audio, no integration. If it doesn't sound like voices in a wav file,
it won't in the browser.

**Cost & risk.** ~60–80 lines for a new strategy plus the γ slider. Zero new math,
zero new state, real-time trivially. Risk: at rank 32 you have one 5-partial voice
and a long tail of singletons—thin. Mitigate by defaulting rank to 64.

**Confidence: high.** The lattice fact is exact and I enumerated it. The perceptual
claim (fusion) is standard psychoacoustics. Only the aesthetic verdict is open.

---

## 2. The Tension Scalar: a running Lyapunov exponent as macrostructure

**Idea.** The nine-year-old unsolved problem is "no narrative arc." The arc is
already in the operator and nobody has read it out. The largest real part of the
Jacobian spectrum, `σ_max`, is a single number saying *how strongly the flow is
about to reorganise, and on what timescale*. Measured above: it falls from
0.63 /s (e-fold 1.6 s) right after a stir to exactly 0 once viscosity has drained
the flow. Tension → resolution, with a physically-set clock, for free.

**Mechanism.** Do not compute eigenvalues. Use Benettin's algorithm: carry a tangent
vector `δ ∈ R^32` alongside `w`, integrate the variational equation, renormalise, and
accumulate the log growth.

```
δ ← δ + dt · J(w) δ            J(w)_{km} = Σ_a C[m,a,k] w_a + Σ_b w_b C[b,m,k] − ν λ_k δ_km
g ← ‖δ‖ ; δ ← δ/g
σ̂ ← (1−β) σ̂ + β · log(g)/dt     (β ≈ 0.02, an EMA over ~1 s)
```

Cost: one `r×r` matvec per step (**1024 mul-adds**) plus rebuilding `J` when `w`
changes appreciably (`2r³ = 65 k`, still 1/32 of one `reconstruct()`). Add the
projection onto the sphere if you want it exact—the code renormalises energy each
step, so the true vector field is `P f(w) − (wᵀf/‖w‖²) w` with `P = I − ŵŵᵀ`; without
it you pick up a spurious radial eigenvalue. Two extra lines.

Then map `σ̂` to whatever carries tension: filter Q, detune spread, noise-bed level,
the depth of the ray voices' inharmonicity, dye saturation, background darkness.
Because `1/σ̂` is a *time*, you can also schedule: at `σ̂ = 0.6 /s` you know the
reorganisation lands in ~1.6 s, so you can start a crescendo that arrives with it.
**Sonified anticipation.** Nothing in the 2017 system or in `SONIFICATION_IDEAS.md`
can do this, because it requires the operator, not the signal.

Extension (Benettin with k orthonormalised tangent vectors, `k·r²` flops) gives the
first k Lyapunov exponents; the *spectral gap* `σ₁ − σ₂` distinguishes "one thing is
taking over" (large gap, a single coherent structure, consonant) from "everything is
competing" (small gap, turbulent, dissonant). That is your "tension from entropy"
idea, but with a rigorous quantity instead of a heuristic.

**Why it improves the artwork.** Every event in the current build is something the
*user* did. This is the first parameter that is genuinely the fluid's own agenda,
and it has a horizon—the instrument can telegraph. It also gives the piece a
guaranteed shape: stir (tension spikes) → 5–30 s of decay (tension drains to zero)
→ silence-ish → stir. The user's own gesture becomes a phrase boundary. That is
macrostructure derived from the physics, not imposed on it.

**Falsifiable prediction.** Plotted against wall time, `σ̂` will spike sharply on
every mouse impulse, decay on a 5–30 s timescale set by viscosity, and reach ~0
before the visuals stop moving—so it *leads* the picture. **Wrong if** `σ̂` is
dominated by the impulse discontinuity itself and carries no information between
stirs, i.e. it's just an onset detector with extra steps.

**Cheapest test.** ~40 lines in the existing node scratch harness: run the sim, plot
`σ̂(t)` against `‖w‖(t)` and against the visual. If `σ̂` is a monotone function of
`‖w‖` it adds nothing over the energy you already have—that is the decisive check,
and it is 20 minutes of work. (My four sample points hint they are *correlated but
not identical*: ‖w‖ falls smoothly 567→151 while σ_max collapses to exactly 0—
different shapes. But four points is not a curve.)

**Cost & risk.** ~50 lines. ~1 k flops/frame for the exponent, 65 k for the Jacobian
rebuild. Real-time is a non-issue. Risk: it's redundant with `‖w‖`. Test that first.

**Confidence: high** on the numbers (measured), **medium** on it being musically
distinguishable from an energy envelope.

---

## 3. The Instantaneous Koopman Spectrum

**Idea.** DMD estimates, from data, the spectrum of an operator you already possess
in closed form. Skip the estimation. The Jacobian `J(w)` of the reduced dynamics is
a 32×32 real matrix computable exactly, every frame, in 65 k flops. Its complex
eigenpairs `σ_j ± iω_j` with eigenvectors `φ_j ∈ C³²` are natively the full parameter
set of a modal synthesiser—**frequency, decay rate, Q, amplitude, phase, and a
renderable spatial shape**—with *zero window and zero latency*.

**Mechanism.** Per frame (or every 4th frame): build `J`, project onto the sphere,
reduce to Hessenberg form (Householder), run shifted Francis QR to get eigenvalues,
inverse-iterate for the eigenvectors of the k largest-|ω| pairs. For each pair:

```
pitch      f_j = α · ω_j /(2π)         α = global transposition (see below)
decay      τ_j = 1/|σ_j| / α
Q          Q_j = ω_j / (2|σ_j|)       # independent of α and of dt
amplitude  a_j = |ψ_jᵀ w| where ψ_j is the left eigenvector (biorthogonal projection)
shape      velocity ghost = Re(U φ_j e^{iθ})
```

**`Q` is invariant under time transposition.** Under `t → t/α` both `σ` and `ω` scale
by `α`, so `Q` does not. This is the whole argument for doing this: `Q` is the one
modal-synthesis parameter that has an unambiguous physical value here, and it is the
one you are currently hardcoding. Measured `Q` of the leading pair: **4.7 to 257**
across the decay. Your filter bank hardcodes 200–2000. The physics says the flow is
one to two orders of magnitude *less* resonant than you are rendering it, and that
its resonance varies over 50×. That gap is almost certainly why the filter bank
reads as a static pad.

`α` is then the instrument's single global pitch control, and a genuinely
Stockhausen-ish one: the same number is a rhythm at α=1 and a pitch at α≈300. At the
current config, wall-clock rate = sim rate × `fps·stepsPerFrame·dt` = 0.012 sim-time
per second, and measured α for the leading pair to land on 110 Hz is **120 → 344**
as the flow decays. Fix α and the instrument detunes downward as it dies (see
measurement 4); track α and it holds pitch while everything else changes. Both are
musical; make it a slider.

The ghost render is the payoff for audiovisual congruence: `U φ_j` costs one
`reconstruct()` (1.05 M), so you can afford one or two. Draw the dominant Koopman
mode as a faint overlay on the dye and you are showing the viewer *the exact object
they are hearing*, rather than 32 numbers that happen to co-vary with the picture.

**Why it improves the artwork.** It replaces every hand-tuned constant in
`filterBank.ts` (Q range, decay times, gain curve) with a measured value, and it
gives the eye and the ear the same object. It is also the only route to modal
synthesis with correct *decays*, which is what makes struck/plucked sounds live.

**Falsifiable prediction.** With Jacobian-derived Q and decay, the filter bank will
stop sounding like a static pad and start sounding like a resonant body being
excited—because Q will drop into 5–50 where it belongs and will *move*. **Wrong
if** the eigenvalues move too fast frame-to-frame and the voices chatter; the flow's
own rate is ≤1 Hz so I expect them smooth, but a bifurcation (a complex pair
colliding into two reals) is a genuine discontinuity that will need voice-matching
and portamento.

**Cheapest test.** Do not write an eigensolver yet. In the node harness, use the
`expm`-plus-power-iteration trick I used above (no eigensolver, ~60 lines total) to
extract just the leading complex pair and its Q, log it over 60 s, and check the
range and smoothness. If Q sits in 5–50 and varies smoothly, commit to the
eigensolver. If it's ratty, stop.

**Cost & risk.** The eigensolver is the cost: Householder-Hessenberg + Francis QR is
~250 lines for eigenvalues, +150 for eigenvectors, and it is the kind of code that
is subtly wrong for weeks. Consider it the one genuine engineering investment here.
Flops are irrelevant (~330–800 k/frame vs 2.1 M already spent on `reconstruct`).
Risk: eigenvector sign/phase continuity across frames, and near-defective matrices
where inverse iteration is ill-conditioned.

**Confidence: high** that the math is right and real-time (measured). **Medium** on
the aesthetic result, because I could only verify the leading pair.

---

## 4. Prony Resonators—the equation-free 40-line version

**Idea.** Proposal 3 without the eigensolver, and without needing the equations at
all. Fit each `w_k(t)` locally to a single damped sinusoid via a 2-tap linear
prediction. This is exactly Hankel-DMD truncated to a 2-dimensional Krylov subspace
of one scalar observable. It gets you frequency, decay and Q per mode for about 40
lines and a handful of running sums.

**Mechanism.** Over a sliding window, least-squares fit `y[n] = a₁y[n−1] + a₂y[n−2]`
via the 2×2 normal equations from five running sums (`Σy_{n-1}², Σy_{n-2}²,
Σy_{n-1}y_{n-2}, Σy_n y_{n-1}, Σy_n y_{n-2}`). Root `z² − a₁z − a₂ = 0`:

```
complex roots (a₁² + 4a₂ < 0):   ρ = √(−a₂),  θ = arccos(a₁/(2ρ))
    f = α · θ /(2π Δt)      σ = log ρ / Δt      Q = θ / (2|log ρ|)
real roots:                 no oscillation—mode is over-damped
```

Note `Q = θ / (2|log ρ|)` **contains no Δt at all.** Sampling rate cancels. So the
one perceptually critical parameter is recoverable without committing to any
time-scaling. That is worth a lot for an instrument whose `dt` and `stepsPerFrame`
are user sliders.

The real/complex split is a free musical gift: complex-root modes are *pitched*,
real-root modes are *unpitched*. Route pitched modes to oscillators and over-damped
modes to a filtered noise bed. The fluid then chooses, moment to moment, how much of
itself is tone and how much is air—which is a far better answer to your Core
Problem #3 (continuous vs. event) than the current binary strategy switch.

**On the latency objection.** A parametric fit is *not* Fourier-resolution-limited.
Four noiseless samples determine a 2-pole model exactly, and `w_k(t)` is an ODE
trajectory—extremely smooth, essentially noiseless. So a 1–2 s window can identify
a 10 s period. That is the fundamental advantage of Prony/DMD over an FFT here, and
it is the reason this proposal survives measurement 1 while a spectrogram would not.

**Why it improves the artwork.** It is the cheapest possible probe of the entire
"temporal spectrum as pitch" thesis. If the sound it produces is dead, Proposals 3
and 5 are almost certainly dead too, and you saved yourself an eigensolver. And it
works unchanged if you later replace the eigenfunction sim with a Navier–Stokes
solver, because it never touches `C`.

**Falsifiable prediction.** Fitted `(ρ, θ)` per mode will be stable over ~1 s and
will produce a smaller, more coherent set of distinct pitches than the current 32
bands. **Wrong if** the fits are dominated by the mode-selective forcing driver in
`main.ts` (which pumps `w[k]` at `√λ·50`, an *imposed* oscillation) rather than by
the flow—in which case Prony will faithfully recover a rate you put there by hand.
Test with forcing off.

**Cheapest test.** ~40 lines in the node harness, no audio: log `(f, Q,
real-vs-complex)` per mode over 60 s with forcing off, and check stability and
spread. Then render additively to a WAV.

**Cost & risk.** ~50 lines, O(rank) per frame with running sums, negligible. Risk:
the 2-pole model is too crude for modes that are genuinely superpositions (the
Jacobian's eigenvectors are *not* aligned with the eigenfunction basis, so a single
`w_k` will generally contain several Koopman frequencies). Fix by raising the model
order to 4 or 6—still a small Toeplitz solve, but now you need polynomial rooting.

**Confidence: high** on tractability and the Δt-free Q identity, **medium** on the
2-pole model being adequate.

---

## 5. Windowed exact DMD, and an honest verdict on it

**Idea.** This was the brief's headline suggestion, so here is the straight answer:
**for the current simulation, exact DMD is the wrong tool, and the reason is
latency, not cost.** It becomes the right tool the moment you swap in a solver whose
Jacobian you do not have.

**Mechanism (for the record).** `X = [w₀ … w_{m−2}]`, `X′ = [w₁ … w_{m−1}]`, both
32×(m−1). Economy SVD `X = UΣV*`, truncate to r, `Ã = U*X′VΣ⁻¹`, eigendecompose
`Ã y = μ y`, DMD modes `φ = X′VΣ⁻¹y`, and
`ω = Im(log μ)/Δt`, `σ = Re(log μ)/Δt`. Flops for m=128, r=32: SVD ≈ 500 k,
`Ã` ≈ 130 k, a 32×32 nonsymmetric eig ≈ 330 k. **About 1 M flops**—half of one
`reconstruct()`. It is not expensive.

**Why it fails here.** The window must span enough of a period to be conditioned. The
governing inequality is `ω_min · T_window ≳ 2π`. Measured `ω` in this system
correspond to periods of 4–120 s wall clock (measurement 1). Even targeting only the
fastest content, a defensible window is several seconds. An instrument that responds
several seconds after you touch it is not an instrument. The Jacobian (Proposal 3)
returns the same `(σ, ω, φ)` with a window of *zero*, because you have the equations.
Delay-embedding (Hankel-DMD) mitigates conditioning but does not shorten the
required physical observation time.

**Where DMD wins.** (a) It finds *coupled* modes—a Koopman mode is a linear
combination of eigenfunctions that rotates rigidly, so two eigenfunctions trading
energy in lockstep become **one voice**, and the mode shape `Uφ` is a renderable
coherent structure. Proposal 3 gets this too, and instantly. (b) It requires no
model. If you go through with the Phase 2 Navier–Stokes plan, you will *not* have a
closed-form Jacobian and DMD becomes the only route to `(σ, ω)`. **Frame it that
way: DMD is the equation-free version of Proposal 3, held in reserve for when the
equations go away.**

**On the basis-update question the brief asks:** make the update a musical event on
purpose. Recompute in a Worker every ~0.25 s; greedily match new `log μ` to old in
the complex plane; portamento matched voices; treat unmatched births and deaths as
note-on/note-off. Because the flow is slow (≤1 Hz), matched eigenvalues move very
little between updates and the portamento will be inaudible—so the only audible
discontinuities are genuine births and deaths, which *are* events. The glitch and
the event are the same thing, and you get to choose which one you hear by setting
the matching threshold.

**Falsifiable prediction.** On this sim, DMD over a 2–4 s window will return
eigenvalues that are unstable frame-to-frame (large jitter in `σ`, moderate in `ω`)
because the window is short relative to the periods, and will lag user input
perceptibly. **Wrong if** delay-embedding stabilises them at ≤1 s windows, in which
case DMD becomes competitive with the Jacobian and much less code.

**Cheapest test.** In node, dump `w(t)`, run offline DMD with windows of 0.5/1/2/4 s,
and plot eigenvalue jitter vs window length. That single plot decides the question
and needs no browser and no audio. You'll need a small SVD and a 32×32 eig—but at
this scale a Jacobi SVD is 60 lines and the eig can again be dodged with the
`expm`-power-iteration trick for the leading pair.

**Cost & risk.** Full implementation ~400 lines (SVD + eig + Worker + matching).
Real-time is fine. The risk is that you build all of it and the latency makes it
unplayable—which is why the offline jitter plot comes first.

**Confidence: high** that the latency objection is real (I measured the periods).
**Medium** that delay-embedding cannot rescue it.

---

## 6. Non-Normal Sensitivity: showing the player where to poke

**Idea.** Something a 2026 mathematician brings and a 2017 one plausibly would not:
hydrodynamic operators are strongly **non-normal**, so short-time behaviour is
governed by the singular values of `e^{Jt}`, not by its eigenvalues. Compute
`G(t) = ‖e^{Jt}‖₂` (maximum amplification over a horizon `t`) and the *optimal
perturbation*—the leading right singular vector, i.e. the poke that produces the
largest response. Then **draw it on the canvas.** The instrument shows you its own
sweet spot, live.

**Mechanism.** Measured, on the projected Jacobian:

| wall time | G(0.25 s) | G(0.5 s) | G(1 s) | G(2 s) |
|---|---|---|---|---|
| 0 s (energetic) | 1.89 | 3.10 | 6.28 | 16.45 |
| 1 s | 1.72 | 2.45 | 3.57 | 5.60 |
| 10 s | 1.22 | 1.46 | 1.99 | 3.08 |
| 30 s (quiescent) | 1.06 | 1.13 | 1.27 | 1.57 |

(I quote t ≤ 2 s only; beyond that the frozen-Jacobian linearisation stops being
physically honest because the base state itself has moved.) Departure from normality
`‖JᵀJ − JJᵀ‖_F/‖J‖_F²` ranges 0.038–0.237—non-normal, not wildly so.

So the instrument's **responsiveness varies over roughly 10×** with its own state:
a poke lands ten times harder when the flow is already alive. That is a feelable,
playable property, and it is completely invisible in the current build.

Implementation: `E = expm(J·T)` by scaling-and-squaring (~14 matmuls at `r³` = 460 k),
then `G = ‖E‖₂` and the optimal `v` by power iteration on `EᵀE` (~40 matvecs, 41 k).
Total ~500 k flops, ~1/4 of one `reconstruct()`, and **no eigensolver**—this is the
cheapest of the three Jacobian proposals to *implement*. Lift `v` to a velocity field
via `Uv` and render it as a faint vector-field or vorticity overlay. Sonically, map
`G` to input gain / excitation sensitivity so that stirring a dead fluid is quiet and
stirring a live one is explosive.

**Why it improves the artwork.** It converts the instrument from something you act
upon into something that answers back—literally the "system interacting back"
the dissertation names as what real-time would unlock and could not pursue
[diss 6.5.3]. And it is honest guidance, not decoration: `v` really is the direction
of maximum response.

**Caveat, stated up front.** Because `step()` renormalises energy, growth in `‖w‖` is
suppressed—the amplification shows up as *redistribution among modes*, i.e. as a
rapid timbral change rather than a loudness swell. Still musical, but you should
expect colour, not volume.

**Falsifiable prediction.** Two clicks of identical strength, one at ‖w‖≈550 and one
at ‖w‖≈150, will produce responses differing by roughly an order of magnitude in
rate of spectral change over the following second. **Wrong if** the energy
renormaliser flattens it entirely, or if the optimal perturbation direction turns out
to be nearly constant (in which case the overlay is a static picture and adds
nothing).

**Cheapest test.** In node, already 80 % done—I have `expm` and the 2-norm power
iteration in `scratchpad/jac.mjs`. Add: track how much the optimal `v` rotates over
time. If `|⟨v(t), v(t+1s)⟩| ≈ 1` always, kill the overlay and keep only the scalar `G`.

**Cost & risk.** ~120 lines, no eigensolver. Risk: `expm` of a non-normal matrix via
repeated squaring loses accuracy; at `‖J‖_F·t ≈ 130` with 11 squarings it was fine,
but keep `T` short. Bigger risk: the overlay is visually cluttered and nobody reads it.

**Confidence: medium.** Numbers are measured; the "player can feel it" claim is not.

---

## 7. Anisotropy first, inverse spectral design second

**Idea.** You want inverse spectral design ("hear the shape of a drum, backwards")
kept on the table. Here is the honest assessment, plus a version of it that costs
almost nothing and tests the whole premise today.

**The cheap version, which I recommend you do: two numbers.** Put the domain on
`[0,aπ] × [0,bπ]`. Then `λ = (k₁/a)² + (k₂/b)²`. Crucially, **anisotropy preserves
exact harmonicity within every ray while detuning rays against each other**:
`√λ` for the `n`-th partial of ray `(p,q)` is `n·√((p/a)² + (q/b)²)`—`n` still
factors out exactly. So Proposal 1's voices stay perfectly harmonic, but the mirror
degeneracy breaks: rays `(p,q)` and `(q,p)`, which are *exact unisons* at `a=b`,
split apart, and the split is a continuous slider. **`a/b` becomes a chorus/beating
control**, tuned in beats per second, with a direct visual correlate (the box gets
taller). This is the fix for Proposal 1's main failure mode and it is one slider.

Implementation is ~15 lines total: the eigenvalue, the basis (`sin(k₁x/a)` etc.), the
viscous decay, and the structure coefficient prefactor, which becomes
`0.25·((b₂/b)(a₁/a)L₁L₂ − (b₁/a)(a₂/b)R₁R₂) / ((b₁/a)² + (b₂/b)²)`. The integer
selection rules are unchanged, so `C`'s sparsity pattern is untouched. And since the
spectrum is closed-form, you can **exhaustively search `(a,b)` in milliseconds** for
whatever spectral objective you like—no eigensolver, no optimiser, no mesh. That is
the smallest convincing test of the entire inverse-spectral thesis: if sweeping the
aspect ratio does not audibly change how consonant the instrument sounds, the whole
programme is refuted for the price of an afternoon.

**The full version, assessed honestly.** Optimising a general 2D mask `Ω` so that its
Dirichlet spectrum approximates a target tuning is *tractable but offline*, and
`SONIFICATION_IDEAS.md` underestimates it.

- **Cost per eigensolve.** Lanczos with full reorthogonalisation on ~8 k active DOFs,
  ~192 iterations for 32–64 pairs. The doc counts the SpMV (40 k mul-adds/iter) and
  treats reorthogonalisation as free. It is not—it dominates:
  `Σ_{j=1}^{192} 2·j·8000 ≈ 295 M` flops, plus ~49 M to form 32 Ritz vectors. Call it
  **~350 Mflop, so 1–2 s in JS, not "well under 1 second."** Roughly an order of
  magnitude optimistic.
- **The optimisation is cheaper than it looks**, because Hadamard's shape derivative
  gives the gradient of *every* eigenvalue from *one* solve:
  `dλ_j = −∫_{∂Ω} |∂u_j/∂n|² (V·n) ds`. You already have the `u_j`; you just read
  normal derivatives on the boundary. So a gradient step costs one eigensolve, and
  30–80 steps converges. **1–2 minutes offline per designed shape.**
- **Verdict: this is a design tool, not a live affordance.** Do not put an optimiser
  in the browser. Ship a small library of precomputed "tuned drums"—mask + modes +
  eigenvalues, a few hundred KB each—that the user switches between instantly. The
  concept ("this shape is tuned to a major seventh chord") survives fully; only the
  optimisation moves offline, where nobody sees it.
- **The deeper caution, which cuts against the whole Phase 2 plan:** an eigensolver
  buys you control over `λ`, and `λ` only sets pitch if you keep the λ→f map. If you
  adopt Proposal 3 or 4, pitch comes from the *temporal* spectrum and `λ` demotes to a
  decay rate. **Do not build the Lanczos solver until you have decided where pitch
  comes from.** That decision is Proposal 4's cheap test, and it should come first.

**Falsifiable prediction.** Sweeping `a/b` from 1.0 to 1.2 will produce an audible,
continuously controllable beating between mirror-ray voices, at a rate you can dial
in beats per second. **Wrong if** the two mirror rays never carry energy
simultaneously (the flow may prefer one orientation), in which case there is nothing
to beat against.

**Cheapest test.** Add `a, b` to the node harness (~15 lines), run the sim at
`b/a ∈ {1.0, 1.05, 1.15, 1.4}`, and check whether mirror-ray pairs are simultaneously
excited and how the ray-fundamental scale moves. Then render to WAV.

**Cost & risk.** Anisotropy: ~15 lines, zero runtime cost, low risk. Full inverse
design: ~400 lines (Lanczos + reorthogonalisation + tridiagonal eig + shape
gradient), offline, plus an asset pipeline. Risk on the big version: it is a lot of
machinery for a knob you may not want.

**Confidence: high** on the anisotropy version (closed form, verified algebra).
**Speculative** that a general optimised shape sounds meaningfully better than a
well-chosen rectangle—a rectangle has two free parameters and a 5-partial exact
harmonic series already; the marginal return on 400 lines of eigensolver is genuinely
unclear, and I would not assume it is positive.

---

## Ranked

By artistic payoff ÷ cost.

1. **Harmonic Rays (#1)**—an exact 5-to-8-partial harmonic series is already sitting
   in your basis, unused. ~70 lines, no new math, and it directly dissolves the "32
   inharmonic partials = mush" problem you named as Core Problem #1. Highest ratio in
   the document by a wide margin. Requires the γ fix, which is three lines.
2. **The Tension Scalar (#2)**—~50 lines and 1 k flops/frame for the first
   parameter that is the fluid's own agenda rather than the user's, with a phrase-length
   clock attached. This is the most credible attack on the nine-year-old macrostructure
   problem, and its own cheapest test (is it just `‖w‖`?) costs 20 minutes.
3. **Prony Resonators (#4)**—~50 lines to test the entire "pitch from temporal
   rates" thesis and to get `Q` from data with no `dt` dependence. If it fails, it
   kills Proposals 3 and 5 before you write an eigensolver. Do this before #3.
4. **Anisotropy (#7, small version)**—~15 lines for a chorus/beating slider that
   also repairs Proposal 1's main failure mode and exhaustively tests the
   inverse-spectral premise for free. Only ranked below #4 because its value depends
   on #1 landing first.
5. **Non-Normal Sensitivity (#6)**—~120 lines, no eigensolver, and a genuinely novel
   instrument affordance (a 10× measured swing in responsiveness, made visible). Ranked
   here because the payoff is real but unproven perceptually.
6. **Instantaneous Koopman Spectrum (#3)**—the largest artistic payoff of any single
   item (physically-correct Q and decay, plus a renderable coherent structure the ear
   and eye share), but ~400 lines including a nonsymmetric eigensolver. Gate it behind
   #4's result.
7. **Windowed DMD (#5)**—I measured the periods and the latency argument is decisive
   for this sim. Keep the design; hold it in reserve for the day you replace the
   eigenfunction solver with Navier–Stokes and lose the closed-form Jacobian.

---

## What I'd kill

**The λ→frequency log-log map (`sonifier.ts:79-86`).** Two separate reasons, both
verified. First, it is a power law `f ∝ λ^γ` with `γ = 1.3157`, which renders an
exact octave as 3158 cents and destroys every harmonic relation in the spectrum
before it reaches a filter. Second, and more fundamental: the reduced fluid equation
is *first order*, so `λ` is not a temporal frequency at all—it is a spatial
wavenumber and a viscous decay rate. Replace with an exposed `γ` slider (default 0.5)
and, once Proposal 3 or 4 lands, retire λ from the pitch path entirely.
Also fix `lamMax = eigenvalues[rank-1]`: `buildIjPairs` is not λ-monotonic and this is
wrong at rank 28 and 30 (reads 40 and 45; true max 50).

**L∞ normalisation (`filterBank.ts:86`, `harmonicSeries.ts:54`,
`spectralEnvelope.ts:70`).** FLOOR.md flags this; I want to sharpen why it matters.
Dividing by `max|w|` guarantees the loudest mode is *always* at unity gain, which
projects out the single most informative global variable in the system: how
concentrated the energy is. The instrument literally cannot distinguish "one thing is
happening" from "everything is happening at once." Use the **energy fraction**
`w_k²/Σ_j w_j²` rather than the dissertation's L1—`‖w‖²` is the quantity `step()`
actually conserves, so it is the natural invariant here.

**The cascade machinery in `filterBank.ts` (`cascadeGain`, `centroidDelta`,
`energyRate`).** It is dead code, three ways over. (a) `energyRate` divides by
`this.prevEnergy` *after* that field has been overwritten with the current energy, so
it computes `ΔE/E_now`, not what the comment says. (b) With energy renormalisation on,
`E` only changes through viscosity—measured `ΔE/E ≈ −0.005` per frame—so
`cascadeMul = 1 + 5·energyRate ≈ 0.975`, a constant. The gain node does nothing.
(c) The premise is unavailable anyway: FLOOR.md already corrects the 3D-vs-2D cascade
direction, but the sharper point is that at rank 32 the maximum wavenumber is 6, so
there is no inertial range to cascade *through*, and `step()` renormalises energy
every step, which structurally forbids energy leaving the retained modes. A cascade
is not merely mis-signed here; it is impossible by construction. Delete the block.

**Modal Percussion as currently triggered.** It thresholds `|Δw|` measured
frame-to-frame. Measured `|Δw|/|w|` per frame is ~2e-3, so the frame deltas are
dominated by (a) user mouse impulses and (b) the artificial sinusoidal driver in
`main.ts` that pumps `w[k]` at `√λ·50`. It is detecting the *input*, not the flow.
Separately, the `mean + 2.5σ` test over n=32 samples is nearly degenerate—the
maximum attainable z-score for 32 samples is `(n−1)/√n = 5.48`, so 2.5σ amounts to
"is there one outlier," which fires almost always or almost never depending on the
shape of the distribution. Rebuild the trigger on Proposal 2's `σ̂` (a real event
signal with a horizon) or delete it.

**`SONIFICATION_IDEAS.md` Option 3 (POD/PCA basis).** Dead end for this target. A
rank-150 basis at 128² is 39 MB (19.7 MB as Float32), it needs an offline training
pipeline, its coefficients have no frequency meaning—which is the exact problem the
Bridges paper papered over with an ad-hoc inversion—and it reintroduces the subspace
lock-in the dissertation names as a known limitation. See the verdict section.

**`SONIFICATION_IDEAS.md` Phase 2, deprioritised rather than killed.** The Lanczos
budget is optimistic by ~10× (reorthogonalisation dominates at ~295 Mflop and is
counted as free; realistic total ~350 Mflop, 1–2 s in JS). More importantly, an
eigensolver buys control over `λ`, and `λ` should probably stop determining pitch.
Settle where pitch comes from—Proposal 4's test, ~50 lines—*before* committing 400
lines to a solver. Do the two-parameter anisotropy version first; it tests the same
hypothesis for 15 lines.

**"Quantize to a pentatonic / just-intonation scale" (Idea B).** Already argued down
in 2017 on the grounds that rigid tuning "would belie the abstract amorphous quality
of our visuals" [diss 6.5], and Proposal 1 makes it unnecessary: the ray fundamentals
`√(p²+q²)` are already a coherent microtonal scale (793 ¢, 1393 ¢, 1620 ¢, …), derived
from the geometry rather than imposed on it, and consistently 7–25 ¢ off 12-TET—
which is exactly the "middleground" the dissertation was reaching for.

---

*Scratch prototypes used to produce the numbers above (temporal spectrum, Jacobian
spectrum, transient growth, ray enumeration, γ) are in the session scratchpad, not in
the repo. Everything is ~150 lines of standalone node and reproducible from the
formulas given here.*
