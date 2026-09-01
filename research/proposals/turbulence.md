# Turbulence: what the fluid is actually doing, and what to build

Aaron—I read the code, then I instrumented it. Everything numeric below comes from a
faithful offline port of `src/sim/basis.ts` + `src/sim/fluid.ts` run at your `main.ts`
defaults (rank 32, grid 128, `dt` 1e-4, `stepsPerFrame` 2, viscosity 0.5, mode 1 forced),
not from memory or from the literature. Where I quote the literature I say so.

Headline, before the detail:

> **At the current defaults, 99.2% of the kinetic energy lives in the two lowest
> wavenumber shells.** Shells 3 through 7 carry 0.8% between them. There is no spectrum.
> The sonifier's 32 bands are being driven by two real signals and thirty channels of dust.
>
> **The step named "energy correction" does not conserve energy.** It conserves *enstrophy*,
> exactly, and it makes energy drain *upscale-to-downscale*—the precise opposite of 2D
> physics. Inviscid, closed, 180 s: energy 4.89e4 → 1.72e4 while the energy centroid climbs
> k_E 2.68 → 4.65. Your simulation is currently running a spurious **forward** energy cascade.
>
> Fix that with ~15 lines and the sign flips. Same run, dual-invariant projection:
> **k_E falls 2.676 → 2.226 while k_Z rises 3.607 → 5.268.** That is Kraichnan, on your
> screen, at rank 32. Your suspected spectral bifurcation is real. It is currently inverted.

---

# (A) The truth about the current sim

## A.1 How much scale range is there? Not enough for a cascade. Quantified.

`buildIjPairs` enumerates (k₁,k₂) triangularly by max(k₁,k₂). Measured:

| rank | max component | \|k\| range | **octaves** | distinct λ | rounded \|k\| shells |
|---|---|---|---|---|---|
| 16 | 4 | 1.414 – 5.657 | 2.00 | 10 | 6 |
| **32 (default)** | **6** | **1.414 – 7.211** | **2.35** | **19** | **7** |
| **64 (slider max)** | **8** | **1.414 – 11.314** | **3.00** | **34** | **11** |
| 128 | 12 | 1.414 – 15.56 | 3.46 | 64 | 16 |
| 256 | 16 | 1.414 – 22.63 | 4.00 | 122 | 23 |

**Verdict: a turbulent cascade at rank 32 is a fantasy, and I can put a number on it.**
A cascade needs an *inertial range*—a band of k where neither forcing nor dissipation acts
and the flux is scale-independent. In 2D you need one on each side of the forcing scale. The
smallest credible inertial range is ~1 decade (3.3 octaves). At rank 32 you have **2.35 octaves
total, both sides combined**, i.e. roughly 1.2 octaves per side, and only 7 shells to bin. You
cannot fit a power law to 3–4 points and call it k^-5/3. Rank 64 gives 3.0 octaves; still one
range, not two. **Rank 256 (4.0 octaves, 23 shells) is the first setting where a two-sided
spectrum is measurable**, and §C.2 shows rank 256 is real-time affordable today.

Two truncation details worth knowing:

- **The rank-32 basis is not x↔y symmetric.** The enumeration completes a full row only at
  rank = n² (4, 9, 16, 25, 36, 49, 64). Rank 32 stops mid-row: it includes (6,4) and omits
  (4,6). Your slider steps by 4, so of its 16 stops only **4, 16, 36, 64** give a symmetric
  basis. Everything else has one orphaned mode with no mirror partner and a broken reflection
  symmetry. Cosmetic, but it means the rank slider is not a smooth quality knob.
- **The small scales are under-dissipated by ~20×.** At default amplitudes the rms vorticity
  (≈ the strain rate) is ~570 sim-time⁻¹ while the viscous rate at the cutoff is νλ_max
  = 0.5×52 = 26 sim-time⁻¹. Ratio ≈ **22**. Enstrophy arriving at the top shell has nowhere
  to go, so the truncation *thermalises*: the top shells fill with equipartition noise rather
  than dissipating. This is the classic Galerkin-truncation artifact, and it is why the
  inviscid runs settle to a flat, structureless high-k tail.

## A.2 The cascade direction: you are right, the ideas doc is wrong, and the code is worse

`SONIFICATION_IDEAS.md` says *"turbulent cascade: energy moves from large scales (low modes)
to small scales (high modes)."* **That is the 3D Richardson/Kolmogorov story and it is wrong
here.** In 2D, vortex stretching vanishes, enstrophy Z = ½∫ω² becomes a second quadratic
invariant alongside energy E = ½∫|u|², and Kraichnan (1967) / Batchelor (1969) / Leith (1968)
give the **dual cascade**: energy flux is **inverse** (to large scales, E(k) ~ k^-5/3 below the
forcing scale), enstrophy flux is **forward** (to small scales, E(k) ~ k^-3 above it). You had
this right in `FLOOR.md`.

Now the part you couldn't know without reading the code.

**In this basis, ‖w‖₂² *is* the enstrophy, not the energy.** The eigenfunctions are not
normalised: with ψ_k = λ_k⁻¹ sin(k₁x)sin(k₂y) and ω_k = sin(k₁x)sin(k₂y),

```
‖φ_k‖²_L2 = π²/(4 λ_k)     (velocity)
E = (π²/8) Σ w_k² / λ_k
Z = (π²/8) Σ w_k²          ←  proportional to ‖w‖₂²,  exactly
P = (π²/8) Σ λ_k w_k²      (palinstrophy)
```

`fluid.ts:100-110` measures `e1 = Σ w²` before advection, `e2 = Σ w²` after, and rescales by
`√(e1/e2)`. **That pins enstrophy and lets energy do whatever it likes.** Measured, rank 32,
inviscid, closed, 180 s of wall clock:

| correction | E(0s) → E(180s) | Z(0s) → Z(180s) | k_E | k_Z |
|---|---|---|---|---|
| none (raw Euler) | 4.89e4 → **NaN by 60 s** | 3.98e5 → NaN |—|—|
| **enstrophy (current code)** | 4.89e4 → **1.72e4 (−65%)** | 3.98e5 → 3.98e5 (pinned) | 2.676 → **4.650 ↑** | 3.607 → 5.274 ↑ |
| energy only | 4.89e4 → 4.89e4 (pinned) | 3.98e5 → **1.31e6 (+229%)** | 2.676 → **5.046 ↑** | 3.607 → 5.515 ↑ |
| **dual (E and Z)** | 4.89e4 → 4.89e4 | 3.98e5 → 3.98e5 | 2.676 → **2.226 ↓** | 3.607 → **5.268 ↑** |

Read the last two columns. The current code moves the **energy** centroid *up* 0.80 octaves in
three minutes. That is a forward energy cascade. It is backwards. Both single-invariant fixes
are wrong—pinning either one alone forces the O(dt) Euler error entirely into the other.
Only the two-parameter projection splits them correctly, and when it does, **k_E goes down and
k_Z goes up at the same time**: the dual cascade, at rank 32, measurable in 3 minutes.

For the record, the truncated Galerkin system *itself* is fine: with no correction at all it
conserves both E and Z to O(dt) (dE/E = 1.0e-6 and dZ/Z = 1.2e-6 over T = 0.2 at dt = 1e-4,
scaling exactly linearly in dt). The problem is purely that forward Euler needs *a* stabiliser
and the one chosen destroys the invariant you care most about.

### Would the bifurcation be audible? Yes. Here are the numbers.

Under the existing log-log λ→f map (55–4000 Hz), with the dual projection, rank 64, seeded at
large scale:

```
t = 0 s    k_E 1.866 → f 97 Hz      k_Z 2.033 → f 116 Hz
t = 20 s   k_E 1.636 → f 74 Hz      k_Z 4.054 → f 482 Hz
t = 40 s   k_E 1.572 → f 68 Hz      k_Z 4.982 → f 738 Hz
```

**The bass centroid drops 0.5 octaves while the brightness centroid climbs 2.7 octaves, over
about 20 seconds.** Energy consolidating downward, enstrophy shredding upward, simultaneously,
from one physical mechanism. That is not a metaphor and it is not a mapping trick—it is the
flow. You were not fooling yourself.

**But**—and this is the honest caveat that changes the design—**in a closed system this is
a one-time transient that saturates.** I ran it to 600 s. From t ≈ 20 s onward, k_E and k_Z are
flat to three decimals for the next ten minutes. This is correct physics, not a bug: an
inviscid Galerkin-truncated 2D system does not cascade forever, it relaxes to the **Kraichnan
absolute equilibrium** E(k) ∝ k/(α + βk²) and then just fluctuates around it. You get one
gorgeous 20-second arc, then a plateau. To keep the bifurcation *running* you need a genuine
non-equilibrium flux: injection at one scale, removal at two others. That is §C.3.

## A.3 Long-run dynamics: attractors, and exactly when it gets boring

The clock first, because everything depends on it. `dt` 1e-4 × 2 steps × 60 fps =
**0.012 simulation-time units per wall second.** Measured turnover time τ ≈ 0.87/max|w|; at
default amplitudes max|w| ≈ 300, so τ ≈ 0.0029 sim-time ≈ **0.24 wall seconds—about 4
turnovers per second.** That part is healthy.

Viscous e-folding of mode k is 1/(νλ_k) sim-time = **167/λ_k wall seconds**. So λ=2 decays in
83 s, λ=52 in 3.2 s, λ=128 (rank 64) in 1.3 s.

**Three regimes, all measured over 180 s:**

**(i) Unforced, ν = 0.5—it dies, and it dies fast enough to matter.**

| t (s) | 0 | 10 | 30 | 60 | 120 | 180 |
|---|---|---|---|---|---|---|
| E | 4.9e4 | 2.0e4 | 5.7e3 | 1.0e3 | 63 | **10.5** |
| max\|w\| | 400 | 263 | 120 | 54 | 8.2 | **4.0** |
| τ_nl (wall s) | 0.18 | 0.28 | 0.61 | 1.35 | 8.9 | **18** |

Energy falls 3.7 decades. By t ≈ 60 s the turnover time exceeds a second—the picture stops
moving in any way a viewer registers as motion. By t ≈ 120 s it is a still image that is very
slowly fading. **You have roughly 45–60 seconds of life per click.** That is the answer to
"when does it get boring": under a minute, and the failure mode is *stasis*, not monotony.

**(ii) Inviscid—it equilibrates and then genuinely repeats.** Enstrophy is pinned by the
correction, energy drains to 1.7e4 and flattens, and by t ≈ 30 s the system is wandering on
the Kraichnan equilibrium manifold. It is ergodic and mixing (dominant mode wanders across
14 modes at rank 64), but it is *statistically stationary*: nothing about minute 8 differs from
minute 2. Ergodic ≠ interesting. There are no limit cycles, no strange attractor with structure
you could compose against—it is a high-dimensional Hamiltonian system relaxing to
equipartition. **A statistically stationary state is exactly the thing that has no narrative.**

**(iii) The actual default—a 0.21 Hz LFO wearing a fluid costume.** `main.ts:335-341` adds
`sin(t√λ₁·50) × 5` to `w[1]` every substep. The drive period is 2π/(√5·50) = 0.0562 sim-time
= **4.7 wall seconds (0.21 Hz)**, and it accumulates ≈ ±890 in w[1] over a half cycle—larger
than the entire rest of the state. Measured consequences at t = 180 s: normalised spectral
entropy **0.009** (of a possible 1.0). Shell spectrum at t = 60 s:

```
E(k):  k=1: 53.9%   k=2: 45.3%   k=3: 0.03%   k=4: 0.59%   k=5,6,7: <0.1%
```

Unforced at t = 20 s it is no better: 80.9 / 17.3 / 1.4 / 0.30 / 0.09 / 0.03 / 0.01, a slope of
about **k^-11**. (For reference: 2D forward range is k^-3, inverse range k^-5/3.) **This is a
laminar two-mode flow, not turbulence.** Whatever the filter bank is doing above mode ~6, it is
amplifying round-off gated by a cubic.

## A.4 Two more things the code does that you should know about

- **The reset impulse lands on a symmetry point.** `injectImpulse(grid/2, grid/2, …)` sits at
  (π/2, π/2), where sin(k₁x)cos(k₂y) vanishes for odd k₁. Measured: a centre impulse puts
  **0.0%** into the k=1 shell and 0.0% into k=3, dumping 79% into k=2. An off-centre click
  gives the more sensible 60.5 / 11.7 / 16.3 / 6.1 / 1.5 / 1.9 / 1.3. Your `R` key and your
  first frame are both starting from a degenerate state.
- **A point impulse can only inject large scales.** Projecting a delta onto φ_k gives
  w_k ∝ k/λ_k ~ 1/k, so E(k) ~ k^-4 (measured ≈ k^-3.5). **The mouse cannot stir small scales,
  at any force setting.** There is no gesture in the instrument that adds fine structure.
- **The correction hides Euler instability.** Because it renormalises every step, nothing ever
  NaNs. I ran dt from 1e-4 to 1e-1: *all "stable"*, but CFL reaches 1.8 at dt=0.01 and 14 at
  dt=0.1, i.e. the trajectory is renormalised noise. Real headroom: **CFL ≤ 0.25 up to
  dt ≈ 1e-3 at rank 32 (7e-4 at rank 64)—about 7–10× the current clock, free.**

## A.5 The real reason rank is stuck at 32

Nobody wrote this down, but it is the binding constraint on everything in §C. Measured on this
machine, per advection step (`fluid.ts:79-91`), at 120 steps/s:

| rank | C memory | dense advect | **% of one wall second** | nnz | sparse advect | % |
|---|---|---|---|---|---|---|
| 32 | 0.3 MB | 0.077 ms | 9.3% | 1620 (4.94%) | 0.014 ms | 1.7% |
| **64** | 2.1 MB | **0.631 ms** | **75.7%** ← wall | 6912 (2.64%) | 0.018 ms | 2.2% |
| 128 | 16.8 MB | 5.07 ms | 609% | 31296 (1.49%) | 0.056 ms | 6.7% |
| 256 | 134 MB | 131 ms | 15691% | 128736 (0.77%) | 0.297 ms | **35.7%** |

The dense triple loop is O(rank³) and it eats the frame at rank 64. **But C is 97–99% zeros
by the trig selection rules, and nnz grows as ~rank^1.7, not rank³.** A flat triad list
(`{a, b, value}` bucketed by k) gives 5.5× / 35× / 90× / **440×**. Same for reconstruction
(`fluid.ts:127-140`): the basis is *separable*, so v = Uw is two 1-D passes, not a dense
matvec—measured **11.9 ms → 0.61 ms at rank 256**, and the 67 MB U matrix disappears entirely.

**Rank 256—4 octaves, 23 shells, two-sided spectra—is real-time feasible today.** Nothing
else in §C matters as much as this, because everything else is starved of scale range.

---

# (B) Which invariants are perceptually available

Cost is per frame at rank 64 unless noted. Timescale is the measured autocorrelation e-folding
time from a 60 s run sampled at 60 Hz, in the proposed forced-dissipative regime (§C.3);
"app" gives the same for current defaults. rel.σ is std/mean.

| Observable | From w | Cost | Timescale (fd / app) | rel.σ | Verdict |
|---|---|---|---|---|---|
| **Energy** E = Σw²/λ | 3 flops/mode | ~0.2 µs | 4.8 s / 1.1 s | .13 / 1.08 | **Yes.** Loudness, macro-envelope. Free. |
| **Enstrophy** Z = Σw² | 2 flops/mode | ~0.1 µs | 5.2 s / 1.3 s | .15 / 1.10 | **Yes.** Already computed in `step()`. |
| **Palinstrophy** P = Σλw² | 3 flops/mode | ~0.2 µs | 5.1 s / 6.6 s | .13 / 1.19 | **Yes.** Filamentation / "sharpness". |
| **Energy centroid** k₁=√(Z/E) | free from above | 0 | **4.4 s** / 2.0 s | **.014** | **Yes, best in class.** The inverse-cascade readout. Slow, smooth, 1.4% jitter—maps straight to register with no smoothing. |
| **Enstrophy centroid** k₂=√(P/Z) | free from above | 0 | **4.0 s** / 2.3 s | .023 | **Yes.** The forward-cascade readout. Pair with k₁ for the bifurcation. |
| **Spectral flux Π_E(k), Π_Z(k)** | w_k·ẇ_k/λ_k, cumsum | **free**—`wDot` already exists | ~seconds |—| **Yes, and nobody does this.** See below. The cascade *itself*, with a sign. |
| **Spectral entropy** H(w²) | log per mode | ~1 µs | 2.8 s / 0.95 s | .048 / .62 | **Yes.** Concentration↔dispersal = the tension/release axis the ideas doc wants. |
| **Condensate fraction** E₁₁/E | O(1) | 0 | minutes |—| **Yes.** The only genuinely *macro*-timescale observable. §C.4. |
| **Spectral slope** d log E / d log k | bin + LSQ, O(r) | ~3 µs | seconds | high | **Marginal now** (7 bins at rank 32, noisy), **yes at rank ≥128** (16–23 bins). |
| Dominant mode index | O(r) | ~0.1 µs | 0.7 sw/s app, 2.4 sw/s fd |—| **Yes with hysteresis.** App visits only **3** modes in 60 s; fd visits **14**. Harmonic rhythm. |
| max\|ẇ\|/max\|w\| (your CFL) | already computed | 0 | 0.15 s | .58 | **Yes** as fast "agitation", too fast for pitch. |
| **Okubo–Weiss** vortex area frac | 2nd-diff the existing velocity field | **0.05 ms** (16k cells)† | 2.6 s / 0.5 s | .040 | **Weak yes.** Cheap, but the mean sits at 0.39 in *every* regime I tested—low information. |
| Domain-integrated Q |—|—|—|—| **No.** ∫Q dA = −4∫det∇u dA ≡ 0 under these BCs. Identically zero. Don't. |
| Circulation ∮u·dl |—|—|—|—| **No.** Identically zero under Dirichlet. |
| **Vortex count / mergers** | flood-fill ω on grid | ~1 ms | **flickers 5×/s** |—| **No, not at this rank.** Measured rank 64: mean 9.8 vortices, range 5–18, count changes 5 times per second. That is threshold flicker, not physics. App: mean **2.1** vortices. See §C.7. |
| **Intermittency of dP/dt** | free | 0 |—|—| **No, not yet.** Kurtosis 3.3 at rank 64 = **Gaussian**. No heavy tail, no bursts, no events. (App shows 6.6, but that is the sinusoidal drive, not the flow.) |
| FTLE / pair stretching | 200 tracer pairs | ~5 µs | ~0.15 s |—| Yes for "roughness", but fast (strain timescale). |

† Compute it by finite-differencing `sim.velocity`, which already exists. Evaluating the basis
analytically per grid point costs 16 ms at 64² and is a trap.

**The one to build first is the spectral flux, because it is free and it is the actual answer
to "what is this fluid doing".** `step()` already computes `wDot` (the advection term alone,
before integration). Then T(k) = w_k ẇ_k / λ_k is the energy transfer into mode k, and
Π_E(k) = −Σ_{k′≤k} T(k′) is the flux through shell k. Measured, rank 64, forced at k_f = 7,
averaged over 120 s:

```
shell:      1      2      3      4      5   | 6 (forcing)|   7      8      9     10     11
Pi_E:   -0.02  -0.27  -0.47  -1.59  -3.29  |   +2.48    | +2.02  +1.24  +0.22  +0.06   0.0
Pi_Z:   -0.05  -1.29  -3.22  -22.6  -67.0  |   +159     |  +155   +104   +23    +7.2   0.0
```

**Negative below the forcing scale, positive above.** Energy flowing down-scale, enstrophy
flowing up-scale, with the sign change exactly at k_f, from data you already have in a
register. Sonify the two signs as two counter-moving streams and the dual cascade is
*literally* what the listener hears.

Timescale summary for composition: **k₁, k₂, E, Z, P all live at 4–5 s correlation time**—
phrase length. **H and max|w| at 2.7–2.8 s**—gesture length. **CFL/strain at 0.15 s**—
articulation. **Condensate fraction at minutes**—form. That is a usable four-tier hierarchy,
and it maps almost exactly onto the dissertation's sound-object / meso / macro scheme.

---

# (C) Proposals

## C.1—Dual-invariant projection (fix the cascade direction)

Replace the enstrophy-pinning step with a two-parameter projection that conserves energy **and**
enstrophy exactly. This is a ~15-line change to `fluid.ts` and it inverts the sign of the
energy cascade, which is the single largest physics error in the build.

**Mechanism.** Before advection record Z₁ = Σw², E₁ = Σw²/λ. After the Euler update, rescale
each mode by a λ-dependent gain g_k = √(α + β/λ_k) chosen so both are restored. With
Z₂ = Σw², E₂ = Σw²/λ, S₂ = Σw²/λ²:

```
[ Z₂  E₂ ] [ α ]   [ Z₁ ]                α = (Z₁S₂ − E₁E₂)/det
[ E₂  S₂ ] [ β ] = [ E₁ ]  ,   det = Z₂S₂ − E₂² ,   β = (Z₂E₁ − E₂Z₁)/det
w_k ← w_k · √(α + β/λ_k)      (guard: if det≈0 or any α+β/λ_k < 0, fall back to the current
                               enstrophy-only rescale)
```

Cost: four O(rank) sums plus one sqrt per mode. At rank 256, ~0.003 ms/step. In 600 s of
testing at rank 32 and 64 the fallback never fired.

**Why it improves the artwork.** It turns a wrong-signed drift into the piece's only
physically-real narrative arc. Measured, rank 64, dual projection, seeded at large scale:
k_Z climbs 2.03 → 4.99 (116 Hz → 742 Hz under your existing map, **2.7 octaves**) while k_E
falls 1.87 → 1.57 (97 → 68 Hz), over ~20 seconds. Bass consolidates, treble shreds, one
mechanism, no mapping trickery. It is the audiovisual congruence the dissertation demanded,
earned from physics instead of asserted.

**Falsifiable prediction.** With the dual projection and no viscosity, over 180 s from an
off-centre click: **k_E decreases monotonically by ≥0.15 and k_Z increases by ≥1.0**, while
|ΔE|/E and |ΔZ|/Z stay below 1e-10. **Disproof:** k_E fails to decrease, or the projection
fallback fires more than once per 1000 steps, or det goes singular when the state collapses
toward a single mode (the real risk—a one-mode state has E₂² = Z₂S₂ exactly).

**Cheapest test.** Add `dualCorrect` behind a boolean, log `√(Z/E)` and `√(P/Z)` to the
console once per second, run 3 minutes with `viscosity = 0` and the mode forcing off, plot two
columns. 30 minutes of work, and you will know from the numbers before you look at the screen.

**Cost & risk.** Trivial cost. Risk: near-singular det for low-dimensional states—needs the
guard, which is 3 lines. Second risk: the dual projection is *more* faithful, so it will no
longer paper over Euler blowup as aggressively; watch CFL. Consider RK2 while you are in there
(2× the advect cost, buys ~3× the stable dt).

**Confidence: high.** I measured all four correction variants side by side; the table in §A.2
is direct output.

---

## C.2—Sparse structure tensor + separable reconstruction (buy rank 256)

Two independent 40-line rewrites that together make rank 256 cost less than rank 32 costs
today. Everything else in this document is starved for scale range; this is the supply.

**Mechanism.** (a) *Advection.* C has 128736 nonzeros out of 16.7M at rank 256 (0.77%), and
nnz ~ rank^1.7. Flatten to `{aIdx: Int32Array, bIdx: Int32Array, val: Float64Array}` bucketed
by k with a `rowStart: Int32Array(rank+1)`; the inner loop becomes
`d += val[c]*w[aIdx[c]]*w[bIdx[c]]`. Build cost 123 ms at rank 256, once.
(b) *Reconstruction.* u = Σ_k w_k (k₂/λ_k) sin(k₁x)cos(k₂y) is separable. Two passes with
K = max component (16 at rank 256):

```
g[k₁][iy] = Σ_{k₂} A[k₁][k₂] · cos(k₂ y_iy)         cost K²·N
u[iy][ix] = Σ_{k₁} g[k₁][iy] · sin(k₁ x_ix)         cost K·N²
```

**Measured** (grid 128, this machine):

| rank | advect dense→sparse | reconstruct dense→separable | U memory |
|---|---|---|---|
| 64 | 0.631 → **0.018** ms | 3.48 → **0.29** ms | 17 MB → **0** |
| 128 | 5.07 → **0.056** ms | 5.92 → **0.44** ms | 34 MB → **0** |
| 256 | 131 → **0.297** ms | 11.9 → **0.61** ms | 67 MB → **0** |

At rank 256, 120 steps/s: advection 36 ms/s (3.6% of budget), reconstruction 37 ms/s. The rank
slider becomes honest, and rebuilding on slider drag drops from seconds to 0.12 s.

**Why it improves the artwork.** 2.35 → 4.0 octaves, 7 → 23 shells. This is the difference
between "there is no spectrum" and "there are two of them". It is also what makes coherent
vortices resolvable (a vortex needs 3–4 wavenumbers to be an object), which is what makes
mergers real events rather than threshold flicker (§C.7). And 122 distinct eigenvalues instead
of 19 means the sonifier stops assigning six bands to λ=52.

**Falsifiable prediction.** Sparse and dense advection agree to 1e-12 per step; rank 256 with
grid 128 holds 60 fps with ≥40% frame budget spare on an M-series laptop; the shell energy
spectrum in the forced-dissipative regime shows a fittable power law over ≥6 consecutive shells
above k_f. **Disproof:** any of the three fails—most likely the third, if the forward range
is still contaminated by the truncation bottleneck (fix with hyperviscosity, §C.3).

**Cheapest test.** Build the sparse triad list, assert equality against dense at rank 32, then
bump the slider max and read the FPS counter you already have. Half a day.

**Cost & risk.** Real but bounded. Risk: separable reconstruction is fiddly to get index-exact
and any error is a silent visual artifact—keep the dense path behind a flag and diff the two
velocity fields once. Second risk: **viscosity must be retuned.** At ν = 0.5 the nonlinear:viscous
ratio at the cutoff falls from 22 (rank 32) to 9.4 (rank 64) to 2.8 (rank 256)—rank 256 with
today's ν is *over*-damped at small scales and will look softer, not sharper. Move to
hyperviscosity (§C.3) at the same time or the upgrade will read as a downgrade.

**Confidence: high** on the performance numbers (measured); **medium** on the visual payoff,
which depends on getting dissipation right.

---

## C.3—Forced–dissipative operating point, with the forcing scale as the main gesture

Stop treating the sim as a decaying initial-value problem and make it a driven system:
band-limited stochastic forcing at wavenumber k_f, linear (Ekman) drag on all scales,
hyperviscosity on the smallest. Then expose **k_f as the instrument's primary continuous
control**. This is the difference between a sound that dies in 45 seconds and one that can be
played.

**Mechanism.** Per substep, for modes in the shell |k| ∈ [k_f−1, k_f+1]:

```
w_k += A · ξ_k · √dt          ξ_k ~ N(0,1) i.i.d.,  A = √(ε / n_shell)
w_k *= exp(−(α + ν_h λ_k²) dt)      α = Ekman drag,  ν_h = hyperviscosity
```

Working numbers at rank 64, grid 128, the app's clock: ε = 4e4, α = 2.0, ν_h = 2e-4, k_f = 6.
Replace the current `viscosity` (∝ λ) with ν_h λ² so damping is confined to the top two or
three shells and the middle range is left inertial. Note **α sets the arc length**: α = 2.0
gives a drag time of 1/(α·0.012) ≈ 42 wall seconds.

**Measured behaviour** (60 s at 60 Hz, versus current defaults):

| | current defaults | forced–dissipative |
|---|---|---|
| distinct dominant modes in 60 s | **3** | **14** |
| dominant-mode changes | 0.70 /s | 2.43 /s |
| normalised spectral entropy | 0.25 (σ 0.62) | **0.78** (σ 0.048) |
| correlation time of E | 1.1 s | **4.8 s** |
| correlation time of k₁ | 2.0 s | 4.4 s |
| does it die? | yes, ~45–60 s | no |

And it holds a real dual cascade indefinitely: Π_E < 0 below k_f, > 0 above (table in §B),
with k₁ = 4.9 and k₂ = 7.3 separated and stable at rank 64.

**The gesture.** k_f is the knob. Measured, rank 64, k_f snapped 9 → 3 at t = 40 s:

```
t = 39 s (k_f=9):  k₁ = 8.57   k₂ = 8.77   E = 7.2e1
t = 41 s (k_f=3):  k₁ = 5.56   k₂ = 8.23   E = 1.9e2
t = 43 s:          k₁ = 3.72   k₂ = 6.84   E = 5.4e2
t = 50 s:          k₁ = 3.03   k₂ = 4.85   E = 1.1e3
```

**Response begins within one frame and completes in 3–10 seconds.** That is a playable
timescale—slower than a note, faster than a section. Sweeping k_f sweeps the spectral pivot:
the point where the sound splits into a descending and an ascending stream moves under your
finger. This is the "instrument that interacts back" the dissertation named and could not build.

**Why it improves the artwork.** It replaces the two failure modes at once—the 45-second
death and the 0.21 Hz monochrome LFO—with a system that is stationary in its statistics but
never repeats in its detail, and it gives you a continuous physical control whose sonic meaning
is unambiguous and *bidirectional* in exactly the sense your architecture already supports.

**Falsifiable prediction.** With ε, α, ν_h in the ranges above, over 10 minutes: E stays inside
a factor of 3 of its mean (no runaway, no death); k₂ − k₁ ≥ 1.0 and both are individually stable
to within 5%; Π_E measured per shell is negative below k_f and positive above, in a
30-second running average, ≥90% of the time. **Disproof:** the flux sign is not clean, or (more
likely) the inverse range at rank 64 is too short and the energy just piles into (1,1) within
a minute regardless of α—in which case the answer is C.2 first, then this.

**Cheapest test.** ~40 lines: a shell index list, a Box–Muller, and swap the viscous
`exp(λ·dt·ν)` for `exp(−(α + ν_h λ²)dt)`. Add k_f to the config panel. Then *listen*, with the
existing filter bank, while dragging k_f. You will know in one minute.

**Cost & risk.** Cheap to build; the risk is entirely in tuning. Three parameters (ε, α, ν_h)
with a narrow joint window, and the window moves when you change rank or the clock. Mitigate by
normalising: express ε as a target rms vorticity, α as a target energy e-folding in *wall*
seconds, ν_h so that ν_h λ_max² equals the rms vorticity. Then the three knobs are
"loudness / arc length / crispness" and they survive a rank change.

**Confidence: high** that it works and is playable (measured); **medium** on whether the
default preset lands somewhere beautiful without a day of tuning.

---

## C.4—The condensate arc: scale-selective friction as macro-form

Turn α down and the inverse cascade has nowhere to stop: energy piles into the gravest mode
and the flow condenses into a single box-filling vortex pair. This is the one observable in the
system that lives on a *minutes* timescale, which is precisely the macrostructure gap that has
been open since 2017.

**Mechanism.** Same as C.3 with α small (0.02–0.2 rather than 2.0). In a bounded 2D domain the
inverse cascade is arrested only by drag; without it, energy accumulates in the (1,1) mode—
the **spectral condensate** (Smith & Yakhot 1993; Chertkov et al. 2007). Measured, rank 64,
α = 0.02 vs 0.4, over 240 s:

| | α = 0.4 | α = 0.02 |
|---|---|---|
| k₁ at t=240 s | 4.92 | **4.33** |
| E₁₁/E at t=240 s | 0.3% | **5.2%** and rising |
| low-k spectral slope | +1.21 | **−0.12** |
| E at t=240 s | 1.4e3 | 3.8e3 |

The low-k slope crossing from positive (equipartition, k^+1) through zero to negative is the
signature of the condensate forming. Sonically: the whole low register collapses onto **one
sustained pitch that grows** while the high register stays busy—a pedal point emerging from
noise. Then raise α and it disperses. **That is a phrase with a beginning, a climax and a
release, driven by one slider, on a 1–4 minute timescale.** Map α to a foot pedal and you have
macrostructure.

**Why it improves the artwork.** Nine years, same unsolved problem: "no narrative arc". This is
an arc, it is physical, it is slow enough to be *form* rather than *gesture*, and it is
reversible—so it is a phrase you can play twice differently, not a one-shot. The visual and
the sonic arc are the same event: the picture consolidates into one big rotating structure as
the sound consolidates onto one low pitch.

**Falsifiable prediction.** At α ≤ 0.05 with rank ≥64 and steady forcing at k_f ≥ 6, E₁₁/E
exceeds 25% within 6 minutes and the low-k spectral slope goes negative; raising α to 2.0
returns E₁₁/E below 5% within 60 s. **Disproof:** it saturates at ~5% and stalls, which would
mean the inverse range at rank 64 is too short to feed the condensate faster than drag removes
it. My 240 s run reached 5.2% and was still climbing, so this is the prediction I am least sure
of—it may need rank ≥128 and 10 minutes.

**Cheapest test.** C.3, then set α = 0.02, log E₁₁/E once per second, and leave it running for
ten minutes while you do something else. Read the curve.

**Cost & risk.** Zero marginal cost over C.3. Risk: the timescale may be *too* slow for a
gallery context—if it takes 6 minutes, most viewers never see it. Mitigate by speeding the
clock (§A.4 shows 7–10× headroom in dt), which shortens every timescale proportionally.

**Confidence: medium.** The mechanism is textbook and the trend is measured; the *rate* at
rank 64 is not yet demonstrated to be gallery-compatible.

---

## C.5—Rotation inside degenerate eigenspaces (the wave layer)

A one-line addition to the RHS that conserves both invariants *exactly*, costs nothing, and
introduces prescribed periodicity—rhythm from structure rather than from a metronome. It is
non-physical in the sense that it is not Navier–Stokes; it is exactly "fluids as they might be".

**Mechanism.** λ = k₁² + k₂² is massively degenerate: (i,j) and (j,i) always share λ, and the
sum-of-two-squares structure gives higher multiplicities. Measured:

| rank | 1-dim | 2-dim | 3-dim | 4-dim | examples |
|---|---|---|---|---|---|
| 32 | 6 | 13 | 0 | 0 |—|
| 64 | 7 | 25 | 1 | 1 | λ=50: {(5,5),(7,1),(1,7)}; λ=65: {(7,4),(4,7),(8,1),(1,8)} |
| 128 | 11 | 47 | 1 | 5 | + λ=85, 125, 130, 145 |
| 256 | 14 | 94 | 2 | 12 | + λ=170, 185, 200, 205, 221, 250, 260, 265 |

Within each degenerate eigenspace, add an antisymmetric generator Ω:
`ẇ ← ẇ + Ω_λ · J w|_λ`, J the standard 2×2 (or block) rotation. Because every mode in the
block has the **same λ**, the rotation is antisymmetric in both the ‖·‖₂ (enstrophy) and the
λ-weighted (energy) inner products, so **both invariants are conserved to machine precision**
and it composes cleanly with C.1. Cost: 2 multiplies per doublet, ~26 flops at rank 32.

Visually this is a **continuously rotating Chladni figure**—the (i,j)↔(j,i) plane precesses,
so the standing pattern turns. In the 3- and 4-dimensional eigenspaces it does something better:
it morphs continuously between genuinely different nodal patterns at the same eigenvalue.
Sonically, Ω_λ is a *chosen* frequency per eigenvalue, so it lands as amplitude modulation /
beating at a rate you specify. Choose Ω_λ ∝ √λ and you get a dispersive wave layer competing
with the turbulence, the way Rossby waves compete on a β-plane. Choose Ω_λ from a rhythmic
ratio set and you get polyrhythm that the flow itself is performing.

*(Aside: real β-plane rotation does **not** close in this basis. βψ_x ∝ cos(k₁x)sin(k₂y),
which is outside the span and violates the no-flux condition at x = 0. You would need a
periodic channel. The degenerate rotation is the version that fits, and it is more controllable.)*

**Why it improves the artwork.** The ideas doc asks for rhythm and gets stuck between
"gimmicky pings" and "continuous drone". This is neither: a *continuous* modulation at a
*discrete* rate, generated inside the physics state, exactly congruent with a visibly rotating
pattern. And it gives you a knob that is pure composition (you pick Ω) sitting inside a system
that is otherwise pure physics—which is the dissertation's stated middleground, made
literal.

**Falsifiable prediction.** With Ω = 0 for all λ the dynamics are bit-identical to C.1. With
Ω_λ = Ω₀√λ, energy and enstrophy stay conserved to 1e-12, and a spectrogram of the filter-bank
output shows sidebands at ±Ω₀√λ/(2π) around each mode's carrier, at the predicted spacing.
**Disproof:** the sidebands are absent (mapping error), or the rotation visibly fights the
advection into incoherent mush rather than a rotating pattern—likely if Ω₀ exceeds the
nonlinear rate (~570 sim-time⁻¹ at default amplitudes), so keep Ω₀√λ well under that.

**Cheapest test.** Build the degeneracy table (10 lines), rotate only the doublets, set Ω to a
single constant, and *watch*. If the picture rotates and the sound acquires a slow beat, it
works. One hour.

**Cost & risk.** Near-zero cost. Risk: it is the most obviously non-physical thing here, and
the objection in `FLOOR.md` §5—analytic eigenfunctions make the flow "more regular"—cuts
both ways. Rotation could either relieve that regularity (patterns stop being static) or
deepen it (everything becomes visibly, mechanically periodic). Start with small Ω on doublets
only.

**Confidence: medium-high** on correctness (the conservation argument is exact); **medium** on
whether it is beautiful.

---

## C.6—Map frequency linearly in λ: the basis is already a harmonic series

`SONIFICATION_IDEAS.md` opens with "Core problem #1: inharmonic frequency ratios… √2 : √5 : √8…
inharmonic mush regardless of synthesis method." **That problem is an artifact of the mapping,
not of the physics, and it disappears completely if you map f ∝ λ instead of f ∝ √λ or
log-log.** I am putting this in a turbulence memo because λ is a *fluid* quantity, not an audio
one: it is the decay rate, the enstrophy weight and the Laplacian eigenvalue at once.

**Mechanism.** λ_k = k₁² + k₂² is an **integer**, always. So with f_k = f₀ · λ_k, every mode is
an exact integer harmonic of a virtual fundamental f₀. Measured λ sets:

```
rank 32:  2 5 8 10 13 17 18 20 25 26 29 32 34 37 40 41 45 50 52
rank 64:  … 53 58 61 65 68 72 73 74 80 85 89 98 100 113 128
```

With **f₀ = 27.5 Hz (A0)**, rank 64 spans **55.0 Hz → 3520 Hz: exactly A1 to A7, exactly six
octaves**—which is the range the sonifier is already targeting (55–4000). Rank 32 gives
55–1430 Hz (4.70 octaves); rank 128 gives 55–6655 (6.92); rank 256 gives 55–14080 (8.00, and
you would drop f₀).

The set of achievable λ is "integers expressible as a sum of two squares"—a sparse, slightly
irregular subset of the harmonic series. That irregularity is the good part: the partials fuse
into a single pitch percept at f₀ (because they are all exact integer multiples), but the
*missing* harmonics give it a specific, strange, hollow spectrum that no synthesiser would
choose. Fusion without blandness.

**Why it improves the artwork.** It dissolves the doc's #1 stated problem at a stroke, it makes
the filter bank sound like *an instrument* rather than 32 unrelated sines, it preserves the
physical meaning (higher λ = smaller scale = higher pitch, exactly as before), and it makes the
dual cascade audible as **spectral centroid motion within one fused tone**—which is far more
musical than 32 independent bands drifting. It also removes the `s`-parameter problem
`FLOOR.md` flags: you do not need octave compression when the range already fits.

**Falsifiable prediction.** Under f = 27.5λ with the existing filter bank, listeners hear a
single pitch at A0/A1 with changing timbre, not a cluster; and the perceived pitch does *not*
glide as w redistributes (only the timbre does). **Disproof:** it fuses so completely that the
mode-level information is inaudible—a real risk, since perfect harmonicity is exactly what
destroys the sense of many independent voices. Mitigation: detune by ε·√λ to taste; the
harmonicity is a continuous knob, not a binary.

**Cheapest test.** One line in `sonifier.ts:79-86`: `frequencies.push(27.5 * eigenvalues[k])`.
Compare by ear against the current log-log map using the strategy-cycle key you already have.
Ten minutes.

**Cost & risk.** One line. Risk is aesthetic and reversible, and it partly contradicts the
dissertation's rejection of quantised scales—but note the distinction: this is not imposing
12-TET on the physics, it is *reading the physics in its native integer units*. That is the
opposite of quantisation.

**Confidence: high** that the arithmetic is right (the λ are integers by construction);
**medium** on whether you prefer the sound.

---

## C.7—Kill the mode-1 sinusoid; build a vortex-dipole brush that can reach small scales

Two replacements for the current interaction layer, which is the least defensible part of the
build. Grouped because they are the same fix: **give the user access to the whole spectrum
instead of just mode 1 and the k≈1 shell.**

**Mechanism.** (a) *Delete the default sinusoidal drive* on `forcedModes = {1}`
(`main.ts:335-341`). Measured: it drives w[1] to ±890 at 0.21 Hz and pushes normalised spectral
entropy to **0.009**—one mode, everything else silent. Keep the number-key mode toggles as a
compositional device (that is the dissertation's ch.6 and it is good), but make the default
state *no* mode forcing, with C.3's stochastic forcing sustaining the flow instead.
(b) *Replace the point impulse with a dipole brush.* A delta projects as w_k ∝ 1/k, giving
E(k) ~ k^-3.5—measured 60.5% of energy in the k=1 shell from one off-centre click. Instead,
inject a Gaussian vortex **pair** of separation d and radius r, following the mouse:

```
ω_inject(x) = Γ [ G_r(x − x₊) − G_r(x − x₋) ] ,   x_± = x_mouse ± (d/2) n̂ ,  n̂ ⟂ drag direction
w_k += Γ (π²/8)⁻¹ ∫ ω_inject sin(k₁x) sin(k₂y) dA    —closed form for a Gaussian, O(rank)
```

The projection of a Gaussian of radius r is ∝ exp(−λ_k r²/4), so **r is a direct spectral
brush width**: small r injects high k, large r injects low k. Bind r to drag speed or to a
modifier key and the mouse becomes a scale-selective stirrer. Also move the `R`-key reset off
(grid/2, grid/2)—it is a symmetry point that puts 0% into the k=1 and k=3 shells.

**Why it improves the artwork.** Right now the instrument has exactly one expressive axis
(where you click, at one scale) and one automated behaviour (a 5-second LFO). This gives it two
independent axes—position and **scale**—and the scale axis is the one the sonification maps
to pitch. That is the difference between a toy and an instrument. And the dipole is the correct
primitive: it is the elementary self-propelling structure of 2D flow, so a brush stroke launches
something that *travels* rather than a splash that sits.

**Falsifiable prediction.** With r swept from π/4 to π/24, the shell centroid of the injected
enstrophy moves monotonically from k ≈ 2 to k ≈ 10, and the peak injected shell matches
k_peak ≈ 2/r to within one shell. Removing the default mode-1 drive raises measured spectral
entropy from 0.25 to >0.6 within 20 s under C.3 forcing. **Disproof:** the injection is
immediately swamped—at rank 32 the smallest brush cannot reach past k=7 no matter what r is,
so this proposal is **gated on C.2**; at rank 32 it will underdeliver and that is not a failure
of the idea.

**Cheapest test.** Add the Gaussian-dipole projection (closed form, ~20 lines), bind r to the
scroll wheel, print the injected shell centroid to the console per stroke. An hour, and the
console tells you whether the brush works before your ears do.

**Cost & risk.** Small. Risk: it is gated on rank; and removing the default forcing means the
app opens on a *silent, still* screen unless C.3 lands first. Ship them together.

**Confidence: high** on the diagnosis (all measured); **medium-high** on the dipole brush,
which is standard practice in 2D vortex codes.

---

## Ranked

1. **C.1—Dual-invariant projection.** Half a day. Inverts the sign of the energy cascade.
   Nothing else you build is trustworthy until this is right, and it is the difference between
   a fake arc and a real one. Do it today.
2. **C.2—Sparse C + separable reconstruction.** One day. 440× and 20×, measured. This is the
   supply constraint on every other idea; rank 32 is why the spectrum is empty.
3. **C.3—Forced–dissipative regime with k_f as the gesture.** Two days including tuning.
   Kills both the 45-second death and the 0.21 Hz LFO, and delivers the first genuinely
   playable physical control. Biggest single jump in how the piece *feels*.
4. **C.6—λ-linear frequency mapping.** Ten minutes. Absurd effort-to-payoff ratio; dissolves
   the ideas doc's stated problem #1. Try it while C.1 is compiling.
5. **C.7—Delete the mode-1 sinusoid, add the dipole brush.** One day, gated on C.2.
6. **C.4—The condensate arc.** Free given C.3, but the timescale risk is real. This is the
   answer to the nine-year-old macrostructure problem *if* it runs fast enough.
7. **C.5—Degenerate-eigenspace rotation.** One hour, near-zero cost, genuinely novel, but
   speculative aesthetically. Build it, keep Ω at zero by default, and find out.

Two things I would build alongside, not as proposals but as instrumentation, because they are
free and you cannot tune any of the above without them: a **live k₁ / k₂ / H / E₁₁ readout**
next to the FPS counter, and the **per-shell spectral flux Π_E(k)** from §B—`wDot` is
already sitting in a private field one line away from being the most informative number in the
program.

---

## What I'd kill

- **The word "energy" in `energy correction`.** It conserves enstrophy. As long as it is named
  that way, nobody reading the file will find the bug. (`fluid.ts:100-110`, and the test at
  `fluid.test.ts:38-51` named "energy is conserved across steps" which asserts Σw² and is
  therefore an *enstrophy* test that passes for the wrong reason.)
- **The default mode-1 sinusoidal drive.** It is 0.21 Hz on one coefficient and it reduces the
  system to normalised entropy 0.009. Everything the sonifier hears at the default settings is
  this LFO. Keep the key bindings, kill the default.
- **Vortex-merger detection as an event source, at rank ≤64.** I wanted this to work—it is
  exactly the right idea, real discrete events inside a continuous flow, not a gimmick. It does
  not work yet. Measured at rank 64: mean 9.8 "vortices" fluctuating 5–18 with 5 count changes
  per second, which is threshold flicker. And the intermittency that should mark real events is
  absent: kurtosis of Δpalinstrophy is **3.3**, i.e. Gaussian. Revisit at rank ≥192 with
  persistent-ID tracking and hysteresis. Do not ship a merger detector at rank 32; it will fire
  on noise and the audience will hear that it is arbitrary.
- **Obstacles inside the eigenfunction solver—Option 4 in the ideas doc.** The Lanczos
  feasibility analysis is right and the eigensolver is genuinely ~1 second. **The structure
  tensor is what kills it.** With a numerical basis you lose the analytic form *and* the
  selection rules, so C becomes 100% dense and each of the rank³ entries is a volume integral
  ∫(φ_a·∇)φ_b·φ_k dA over the grid. At rank 64 on a 128² grid that is 262144 × 16384 × ~10
  ≈ **4.3e10 flops**—tens of seconds in JS at best, minutes at rank 128, and it must be
  redone every time an obstacle moves. The "~0.5–1 s recompute" estimate is off by one to three
  orders of magnitude *for the simulation basis*. It remains entirely correct for the
  **sonification** basis, which is Options 2 and 5 in the same document: run a grid NS solver,
  project onto the numerical eigenmodes for sound only. That path is sound; Option 4 is not.
- **Beta-plane / rotation in this basis.** βψ_x ∝ cos(k₁x)sin(k₂y) is not in the span and
  breaks the boundary condition. It needs a periodic channel and a different basis. C.5 is what
  fits here and is more controllable anyway.
- **Domain-integrated Okubo–Weiss and circulation.** Both identically zero under these boundary
  conditions. If either ever appears in a sonification patch, it is measuring round-off.

---

## Is the simulation too impoverished to carry the artwork?

**No—but only just, and not in its current settings.** The rank-32 default genuinely is too
impoverished: 2.35 octaves, 7 shells, 99% of the energy in two of them, a spurious forward
energy cascade, a 45-second lifetime and a 0.21 Hz LFO on top. If that were the ceiling I would
tell you to replace the solver.

It is not the ceiling. The Galerkin system underneath is *correct*—it conserves both 2D
quadratic invariants to O(dt), it produces a textbook-clean dual cascade with the right flux
signs when driven properly, and it is 440× cheaper than the code currently makes it. The
architecture is right and the physics is right; the operating point is wrong and the
stabiliser is destroying the invariant that carries the whole narrative.

C.1 through C.3—call it three or four days—take you from "two modes and a sine wave" to a
sustained, non-repeating, two-sided 2D turbulent flow at rank 256 across four octaves, with a
physically real spectral bifurcation you can hear and a forcing-scale gesture you can play.
**That is enough to carry the piece.** Spend the days there before you consider a grid NS
rewrite, because after those changes the eigenfunction solver is doing something a grid solver
cannot: handing the sonifier an exact, orthogonal, integer-eigenvalued modal decomposition of
the flow, for free, every frame. That is the whole reason this project exists.
