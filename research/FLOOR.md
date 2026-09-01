# Floor: what already exists, so you don't rebuild it

**Purpose.** This is a *floor*, not a target. It records what the 2017 dissertation
("Seeing and Hearing Fluid Subspaces", Aaron Demby Jones, UCSB MAT) actually did, what it
deliberately chose *not* to do and why, and what it couldn't do in 2017. Read it so you don't
spend cycles re-deriving 2017. Then go past it.

The author's explicit position: he is **more interested in the artwork than in fidelity to the
dissertation.** If you have a better idea, the dissertation loses. Do not treat anything here as
a constraint. Treat it as a starting line and as a list of traps already stepped in.

Full text of all three sources is in `reference/text/*.txt`, page-marked. Cite as `[diss p.117]`.

---

## 1. The 2017 system, precisely

Pipeline:

```
6 full-space 3D smoke sims (buoyancy rotated to 6 outward directions)
  → snapshot matrix X (velocity fields as columns)
  → SVD → r = 150 empirical eigenvectors U, singular values σ
  → subspace trajectory q(t) ∈ R^150
  → sonification → gray noise through 150-band resonant filter bank
```

**Frequency mapping** [diss ch.5, bridges eq.1]. Singular values are *energies*, not frequencies,
so they are inverted and compressed:

```
f_i = f · (σ_max / σ_i)^(1/s)        f = 64 Hz, s = 1.75
```

`s` is an **octave-scaling** parameter — it compresses a ~13-octave singular value spread into an
acoustically usable ~8 octaves. Two decisions are buried here: *inversion* (principal modes →
low frequencies, justified perceptually: fundamentals are the prominent tones) and *compression*.

**Amplitude mapping** [bridges eq.2]. **L1** normalization:

```
a_i = |q_i| / ||q||_1
```

Sign is discarded (phase reversal only produces clicks). Two normalization modes, described as
having different musical merit: per-frame (uniform volume) vs. normalize-by-global-max
(variable, dynamic envelope).

**Synthesis.** Subtractive: **gray noise** → bank of resonant bandpass filters at `f_i`, excited
with strength `a_i` and varying decay times.

---

## 2. Aesthetic decisions already made, with reasons

This is the most valuable section. These were argued, not defaulted [diss 6.5].

- **Rejected 12-TET / quantized scales.** Reason: "its rigidity would belie the abstract
  amorphous quality of our visuals." Any proposal to quantize to a scale must answer this.
- **Rejected additive synthesis.** Reason: sinusoid stacks are "too digitally clean," a
  "computer-like purity that belies the messy, turbulent swirls." Chose subtractive because modes
  of vibration *are* natively a subtractive concept.
- **Chose gray noise specifically** — weighted to low frequencies, to bring out the principal
  singular values, which the inversion had placed low.
- **Rejected choppy/robotic results** on grounds of audiovisual *congruence*: smooth billowing
  visuals demand continuous sound. (This is the same objection the current repo's ideas doc
  raises as "temporal mismatch" — it is not a new problem, and 2017 resolved it by refusing
  discrete events entirely.)
- **Stated aesthetic stance:** a middleground between pure scientific sonification and pure
  composition. "Musical adjustments remained of a minor quality, not abandoning the logic of the
  system." Deviations from physics are allowed but must not sever the audio-visual link.
- **The central thesis** [diss 6.5.4]: fluids **"as they might be"** rather than "as they
  actually are." Non-physical time evolution is explicitly endorsed as the fertile direction.

## 3. The compositional method (ch.6) — already worked out

Three timescales, after Schenker and Roads: **sound object / meso / macro**.

| Operation | Musical analogue | Mechanism |
|---|---|---|
| Mode isolation (6.1) | a note | activate one mode |
| Mode superposition (6.2) | a chord | activate a small subset |
| Dynamic control (6.3) | crescendo / diminuendo / swell / accent | drive `\|\|w\|\|₂` directly |
| Envelopes (6.4) | timbral life within a chord | per-mode sinusoidal envelopes at *different rates* — "fader knobs moving at different speeds" |
| Mode coupling / crossfade (6.4) | chord progression | transfer energy between mode collections |

Critically: **6.3 and 6.4 abandon physics-based evolution entirely** and drive `w` algorithmically.
The physics is one available time-evolution rule among many, not the substrate.

## 4. What 2017 could not do — this is the opening

Real-time was **infeasible**: hours to days of compute per short composition [diss 6.5.3, 7.2].
The dissertation names exactly what real-time would unlock, and then cannot pursue it:

> free improvisation; the system "interacting back"; the audience participating rather than
> letting the experience wash over them; gestural control of system energy producing swells and
> frequency sweeps.

**The current project is the machine the dissertation wanted and could not build.** Everything in
ch.6 was composed offline, one render at a time. Anything that only makes sense with a human in
a real-time feedback loop is, by construction, unexplored territory.

## 5. Known dead ends

- **Training set too narrow.** Early attempts produced eigenvectors that "almost exactly mimicked
  the full-space simulation" — no variety. Fixed by training across 6 rotated buoyancy directions.
  Generalization: a basis learned from too little diversity just replays its training data.
- **Subspace lock-in** [diss 7.2]: once the basis is fixed, you can only produce dynamics near the
  training set. New motions require a fresh precompute.
- **Analytic Laplacian eigenfunctions were considered and set aside** [diss 7.2]: they would make
  the fluid modes "more regular, undermining the visual variety of the training-based approach."
  **The current repo uses exactly these.** This is a live, unresolved tension, not a settled matter
  — but note that the objection was raised by the author himself.

## 6. The author's own unfinished business [diss 7.3]

- Modulate viscosity and buoyancy as compositional parameters (never tried)
- Retrain the subspace different ways for different expressive palettes
- **Obstacles perturbing the basis to yield a novel spectrum** (named, never attempted)
- **Map the rendering system to sound** — rendering was static: same lighting and color always.
  Visual-side parameters were never part of the instrument.
- **"More complete audiovisual works, deeper in macrostructure and musical form, remain to be
  seen."** ← The stated gap. The repo's ideas doc independently calls this "no narrative arc."
  Nine years, same unsolved problem.
- Outlook: other dynamical systems entirely — wave equation, heat equation, logistic map,
  chaotic systems whose sensitivity to initial conditions makes parameter perturbation a
  compositional device.

## 7. The current repo, and where it silently diverges

TypeScript, ~2,100 lines, real-time in browser. Analytic De Witt Laplacian eigenfunctions on
[0,π]², `rank: 32` (max 64), structure-tensor advection, Canvas 2D dye + vorticity + particles,
four hot-swappable sonification strategies, and a `setCoefficients` sound→fluid path the
dissertation never had.

Divergences from the published method that appear to be accidental rather than chosen:

- `filterBank.ts:86,117` normalizes by **max|w| (L∞)**, not **L1**. L1 conserves total energy
  across partials, so concentration into few modes reads as focus; L∞ pins the loudest mode at
  full gain and flattens that dimension.
- `sonifier.ts:79-86` maps eigenvalues log-log onto fixed endpoints (55–4000 Hz). There is no
  `s` octave-scaling knob and no inversion. `s` was the dissertation's tunable handle on
  spectral spread — i.e. on inharmonicity.
- Noise source is not gray-weighted.
- The repo's `SONIFICATION_IDEAS.md` was written without access to the dissertation. Treat its
  Phase 2 plan (Lanczos eigensolver, obstacle editor, NS rewrite) as an unvalidated hypothesis.

Its ideas doc also asserts: *"turbulent cascade: energy moves from large scales to small scales."*
This is the 3D story. **This simulation is 2D**, where Kraichnan's dual cascade sends energy
*inversely* toward large scales while enstrophy cascades forward to small ones. Caveat: at
`rank: 32` there is too little scale separation for a genuine cascade to appear.

---

## Standing mandate

The dissertation is a floor. The brief is **the artwork**: a real-time, interactive, browser-based
audiovisual instrument that is genuinely worth experiencing. Research contributions are welcome
but secondary.

Bias toward ideas that (a) only become possible in real time, (b) attack macrostructure — the
nine-year-old unsolved problem, or (c) use 2026 technique unavailable in 2017. Propose what its
author could not have known.
