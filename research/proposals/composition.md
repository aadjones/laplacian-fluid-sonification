# Composition proposals: making the fluid instrument worth listening to

Written as an outside colleague, not a summarizer. Everything below is a proposal to build,
not a report on what exists. Where I contradict the dissertation I say so and argue it.

---

## Before the proposals: three things I found in the code that change the problem statement

These are load-bearing. Two of the project's three "core problems" are partly artifacts of
implementation choices, not of the physics.

### 1. The inharmonicity problem is smaller than stated, and partly self-inflicted

`SONIFICATION_IDEAS.md` says eigenvalues give "irrational ratios √2 : √5 : √8 : √10 …
regardless of synthesis method." That is true of λ, but the frequencies of a vibrating
membrane go as **√λ**, not λ. And the current mapping does neither. From
`sonifier.ts:79-86`:

```
f = 55 · (4000/55)^((ln λ − ln λ_min)/(ln λ_max − ln λ_min))
```

For rank 32 this is `f ∝ λ^1.316 = (√λ)^2.631`. The physical spectral spread of the rank-32
basis is √(52/2) = 5.10, i.e. **2.35 octaves**. The code stretches it to **6.18 octaves**.
The mapping is not "log-log perceptually uniform"; it is a 2.63-power warp that takes a
compact, nearly-harmonic spectrum and tears it apart. The dissertation had a principled knob
here (the octave-scaling `s`), applied to singular values that genuinely *were* energies with
a 13-octave spread. This basis is not that basis. The knob was inherited without the problem
it solved.

Restore `f = f₀·√(λ/λ_min)` and look at what the basis actually contains
(rank 32, mirror families merged):

| family (primitive ray) | harmonics present | fundamental vs (1,1) | cents |
|---|---|---|---|
| (1,1) | **1, 2, 3, 4, 5** | 1.0000 | 0 |
| (2,1),(1,2) | **1, 2, 3** (×2 orientations) | 1.5811 | 793.2 |
| (3,1),(1,3) | 1, 2 (×2) | 2.2361 | 1393.2 |
| (3,2),(2,3) | 1, 2 / 1 | 2.5495 | 1620.3 |
| (4,1),(1,4) … (5,4),(4,5) | 1 only | 2.92 … 4.53 | 1852 … 2615 |

Because λ(nk₁,nk₂) = n²λ(k₁,k₂), **every mode (nk₁,nk₂) is the exact nth harmonic of
(k₁,k₂)**. The (1,1) family alone contains a perfect 1:2:3:4:5 harmonic series. This is
intrinsic to the domain. It is not a scale imposed on the data. The dissertation's rejection
of 12-TET has no purchase on it.

The basis is therefore not "32 inharmonic partials." It is **four harmonic spectra on
mutually inharmonic fundamentals, plus a residue of singletons**. That is the internal
structure of a bell, a gamelan bonang, or a Grisey chord. It is a good sound, and nobody has
tried to hear it because the mapping is currently destroying it.

### 2. Rank 32 contains only 19 distinct frequencies

Every mirror pair (i,j)/(j,i) is exactly degenerate. So the filter bank builds 32 filters at
19 distinct centres, feeding **13 duplicate pairs from one shared white-noise
`AudioBufferSourceNode`**. Identical filter, identical input signal, identical output. The
per-mode `StereoPannerNode` sends the two copies to different pan positions, but two identical
signals at two pan positions sum to one centred phantom image with no width. Roughly 40% of
the CPU in the bank is producing a mono duplicate.

The degeneracy is not a defect. It is a free two-dimensional handle: the pair
(w[(i,j)], w[(j,i)]) is a complex amplitude whose **argument is the spatial orientation of the
mode**, and the code currently discards it. Proposals 1 and 3 both spend it.

### 3. The filter bank's Q values make it a reverb, not a bank of modes

`Q ∈ [200, 2000]`. Resonator ring time is τ ≈ Q/(πf). At Q=2000 and f=55 Hz that is
**11.6 seconds**; at Q=200 and f=4000 Hz it is 0.016 s. A 700:1 spread in decay time that
corresponds to nothing in the simulation. The low end is a freeze pedal. Anything the fluid
does below ~1 Hz is smeared past recognition, which is very likely why the bank reads as an
undifferentiated wash rather than as modes. There is a physically correct value available for
free: viscous decay of mode k is e^(−νλ_k t), so τ_k = 1/(νλ_k), so

```
Q_k = π · f_k · τ_k = π · f_k / (ν · λ_k)
```

One line, and the resonator's ring time becomes the mode's actual dissipation rate. Also
worth knowing: Web Audio `BiquadFilterNode` is float32 in most engines. Q=2000 at 55 Hz is a
0.027 Hz bandwidth and sits at the edge of coefficient precision; `setTargetAtTime` on `Q` at
those values is a plausible source of zipper artifacts.

---

# The proposals

---

## 1. The Sieve

**Statement.** Stop sonifying 32 modes. Sonify the **four harmonic families** that the domain
already contains, as four fused voices, plus a deliberately unfused residue. Restore
`f ∝ √λ` so that (1,1)→(2,2)→(3,3)→(4,4)→(5,5) is heard as a true 1:2:3:4:5 harmonic series
and not as five unrelated pitches. What the listener then hears is not a 32-partial cloud but
a small chord of pitched objects, each with a fluid-controlled timbre. The fluid's stirring
moves energy between families, and *that* is harmonic rhythm: real chord change, arising from
advection, with no scale and no quantization. This is the direct answer to the "inharmonic
mush" problem and it costs nothing in fidelity, because the harmonicity is a property of the
Laplacian on a square, not something I added.

**Mechanism.**

Precompute once, at basis build time:

```ts
// family key = primitive ray (k1/g, k2/g), g = gcd(k1,k2)
// harmonic index within family = g
type Family = { p: number; q: number; f0: number; members: {k: number; n: number}[] };
```

For rank 32 this yields 4 families with ≥2 members ((1,1); (2,1)&(1,2); (3,1)&(1,3);
(3,2)&(2,3)) and 12 singletons. Merge each mirror pair into one family with two orientations.

Per family, one **voice**:

- fundamental `f0 = fRef · sqrt(λ_prim / 2)`, `fRef` ≈ 82.4 Hz (E2) so the five-partial (1,1)
  family lands at 82/165/247/330/412 Hz, squarely in the register where harmonic fusion is
  strongest.
- partial n gain = `|w[member n]| / Σ_families Σ_n |w|`—**L1 across the whole vector**, per
  the dissertation's eq. 2, restoring the property that concentration of energy into few modes
  reads as focus. (The repo currently uses L∞: `filterBank.ts:86`. L∞ pins the loudest mode at
  full gain, which flattens exactly the dimension you want to hear.)
- Web Audio: `OscillatorNode(sine)` per partial → `GainNode` → family `GainNode` →
  family `StereoPannerNode` → master. 32 oscillators total, trivially cheap. See proposal 2
  for the anti-sterility argument, which this depends on.
- The 12 singletons go to a *separate* bus, deliberately unfused: detuned ±8 cents by
  orientation, wider pan, ~6 dB down, longer smoothing time constant. They are the haze
  around the pitched core.

Family panning uses the discarded degeneracy: `θ = atan2(w[(j,i)], w[(i,j)])`,
`pan = sin(2θ) · 0.7`. The mode's spatial orientation becomes its stereo position, so a
rotating vortex audibly rotates.

**What it sounds like.** A low E with a genuine, singable pitch, its 2nd/3rd/4th/5th partials
swelling and receding independently—closer to a bowed string or a synthetic vowel than to
noise. Sitting above it, a second pitched object a wide minor sixth up (793 cents, about 20
cents flat of 8:5), a third an octave-plus-major-second up, a fourth an octave-plus-tritone-ish
up. Those four fundamentals do not form a tempered chord and do not want to; they are a
bell-like aggregate, warm at the bottom and clangorous at the top, and between them sits a
faint metallic haze from the singletons. When you stir the fluid low and broad, the E family
dominates and the whole thing pulls into a single fused pitch. When you stir it in tight
fast circles, the higher families take over and the aggregate splays open. That opening and
closing of fusion is the musical event.

**Why it improves the artwork.** It converts a 32-dimensional undifferentiated texture into a
small number of auditory objects, which is the precondition for any of the rest of music. You
cannot have melody, harmonic rhythm, voice leading, or formal return between 32 anonymous
partials; you can have all of them between four objects. And it does so by *reading* the
system more carefully rather than by overriding it, which is precisely the dissertation's
stated aesthetic stance.

**Falsifiable prediction.** With `f ∝ √λ` and family grouping, naive listeners asked "how many
sounds do you hear?" will answer 3–5. With the current mapping they will answer "one wash" or
"lots." Disproof: listeners still report an undifferentiated mass, or report *more* objects
than before, meaning the families are not fusing (likely because the amplitude ratios within a
family are too erratic frame-to-frame for the harmonic sieve to bind them; see risk).

**Cheapest test.** Change one line in `sonifier.ts`—`f = f0*Math.sqrt(lam[k]/lamMin)`—and
listen to the *existing* filter bank. That alone tests the "compact harmonic spectrum" half
of the claim in under five minutes. Family grouping is a second, ~80-line strategy file.

**Cost & risk.** Low cost. Risk: 2.35 octaves is a narrow register and may feel cramped;
mitigate by transposing whole families by octaves (a family transposed by 2ⁿ stays internally
harmonic, so this is a free and legitimate move). Second risk: if within-family amplitudes
jitter faster than ~20 Hz the sieve will not bind and you get five pitches instead of one
timbre. Fix with slower per-partial smoothing (τ ≈ 80 ms) inside families, faster between.

**Confidence: high.** The harmonic structure is arithmetic, not opinion.

---

## 2. Turbulence as bandwidth

**Statement.** The dissertation rejected additive synthesis because sinusoids are "too
digitally clean … a computer-like purity that belies the messy, turbulent swirls." That
objection is correct about *static* sinusoids and wrong about additive synthesis in general.
The messiness of turbulence has a precise spectral meaning: a partial whose amplitude and
phase are being violently modulated is not a line, it is a band. So make each partial's
**bandwidth** a direct function of how fast its own coefficient is changing. A mode sitting
still is a pure tone. A mode being shredded by advection is a noise band at the same centre
frequency. One knob per partial, driven by physics, continuously interpolating between the
dissertation's two rejected extremes rather than choosing one.

**Mechanism.** Per mode, turbulence ratio

```
T_k = clamp( |ẇ_k| / (√λ_k · |w_k| + ε), 0, 1 )     // ẇ is already computed in fluid.ts
```

The √λ normalization makes T dimensionless and comparable across modes: it is the ratio of
the mode's actual rate of change to its natural oscillation rate. T ≈ 0 means "coherent,"
T → 1 means "being destroyed."

Signal chain per partial:

```
OscillatorNode(sine, f_k)
    ↑ detune ← GainNode(dev = T_k · 1200 · f_k/1000 cents)  ← lowpassed noise (BiquadFilter LP,
                                                               cutoff = T_k · f_k/4)
    → GainNode(a_k)
    → family bus
```

That is random-walk FM: a band-limited noise source modulating `osc.detune`, with deviation
and modulation bandwidth both scaled by T_k. At T=0 the deviation is zero and you have a pure
sine. At T=1 you have a noise band roughly f_k/2 wide centred on f_k. One shared noise buffer
can feed all 32 deviation paths *provided* each takes a different offset into it—do not
share the same phase, or the partials will wobble in lockstep and the whole spectrum will
sound like one detuned organ.

Complementary and cheaper variant if node count matters: keep the resonant filter bank but
give each filter **its own** noise source (or one shared source through per-mode allpass
decorrelation) and set `Q_k = π·f_k/(ν·λ_k · (1 + 8·T_k))`. Same perceptual axis, fewer nodes.

**What it sounds like.** At rest after the fluid has settled: a clean, glassy, almost organ-like
chord. Strike it: the moment of injection is a hard white flash of noise across the whole
spectrum which then *crystallizes* downward, low partials firming into pitch first while the
high ones are still hissing, because low modes have low λ and stabilize sooner. The sustained
state is a chord that is continuously breathing between vowel and breath—like a shakuhachi
tone, or the transition region in Saariaho's *NoaNoa* where the flute's sound slides between
pitch and air. Crucially the noisiness is *per-partial* and asynchronous, so the sound is never
uniformly noisy or uniformly clean; it has grain.

**Why it improves the artwork.** It is the missing physics→timbre map. Right now every mapping
in the repo is amplitude-only: `w` sets gains, full stop. There is no channel by which "the
fluid is turbulent right now" reaches the ear except as more gain on more partials. This gives
turbulence its own perceptual dimension, and it is the dimension that makes the sound *sound
like a fluid* rather than like an additive synth playing fluid data. It also retires the
dissertation's objection honestly rather than by fiat.

**Falsifiable prediction.** With T-driven bandwidth, listeners will be able to tell, with the
screen off, within about a second, whether the fluid was just struck or has been coasting.
With gain-only mapping they will not (they will hear loudness change, which is confounded with
how hard you struck it, not with turbulence). Disproof: blind A/B shows no better than chance
discrimination of "just struck" vs "coasting at matched loudness."

**Cheapest test.** Take one mode. One oscillator, one noise→detune path, one slider standing
in for T. Sweep the slider by hand and listen to the pure-tone↔noise-band axis before wiring
it to anything. Ten minutes. If that axis is not beautiful on its own, the proposal is dead
and you have lost nothing.

**Cost & risk.** ~120 lines. Risk: 32 extra noise paths is 96 nodes; fine on desktop, watch
mobile. Real risk is that `ẇ` at `dt = 1e-4` with `stepsPerFrame` iterations is dominated by
integrator noise rather than by real dynamics—measure T's distribution before trusting it,
and if it is spiky, use a one-pole smoothed |ẇ| over ~50 ms.

**Confidence: high** on the mechanism, **medium** on whether T from this particular integrator
is a clean enough signal.

---

## 3. The Room

**Statement.** Make the **shape of the domain** a continuous, playable parameter, and let it
be simultaneously the tuning system and the visual frame. On the rectangle
[0,aπ]×[0,bπ] the eigenvalues are λ = k₁²/a² + k₂²/b², so the aspect ratio r = b/a retunes the
entire spectrum continuously. At r = 1 the 32 modes collapse onto 19 distinct frequencies,
maximally fused. Push r off 1 and the 13 degenerate mirror pairs split apart into slow beating,
then shimmer, then roughness, then fully separate pitches. This is Sethares' co-design of
spectrum and scale, except that you do not have to *design* either one: they are the same
object, the room, and the performer can see it. The frame on screen literally stretches.

**Mechanism.** Verified numbers (rank 32, lowest partial pinned to 110 Hz):

| r | distinct partials | mirror-pair beat rates (Hz) | Sethares roughness |
|---|---|---|---|
| 1.000 | 19 | 0 (exact unisons) | 2.131 (global min) |
| 1.005 | 32 | 0.5–2.2 | — |
| 1.01 | 32 | 1.0–4.5 | — |
| 1.02 | 32 | 2.1–8.9 | — |
| 1.05 | 32 | 5.1–21.8 | — |
| 1.618 | 32 | fully split | 2.257 |
| 2.000 | 29 | — | 2.374 (near max) |

Two regimes, and the near one is the good one. **Between r = 1.000 and r ≈ 1.03 you have a
13-voice natural chorus** whose beat rates are all locked to the same proportional constant —
each pair beats at a rate proportional to its own frequency, which is exactly the structure of
a well-tuned celeste or a Venetian *voce umana* organ stop, and which no LFO-based chorus
produces. This is the single most immediately beautiful thing I found in this system.

The far regime (r from 1 to 2) is a genuine harmonic restructuring but the roughness only
varies by 15%, so do not oversell it as a consonance dial; sell it as *register and density*.

Implementation, cheapest honest version: leave the simulation on the square, and let `r`
affect only (a) the sonifier's λ used for frequency, and (b) a CSS/canvas transform on the
render. This is a deviation from physics of exactly the kind section 6.5.4 endorses—fluids
"as they might be." Full version: recompute the basis and structure tensor for the rectangle;
the same product-to-sum identities hold, `structureCoefficientAnalytic` needs the a,b scaling
threaded through, and you would want to crossfade `w` across the change.

Control: `r` on a slow continuous controller (trackpad vertical, or a second finger). Add a
weak detent at r = 1 so the performer can find the unison by feel—a real instrumental
affordance, like finding the harmonic node on a string.

**What it sounds like.** Start at r = 1: a clean, slightly hollow, perfectly fused chord.
Ease r to 1.008 and the whole sound *comes alive*—thirteen slow beats between 0.8 and 3.5 Hz,
each pair breathing at its own rate, the aggregate shimmering the way a large church organ's
celeste does, or the way the two strings of a slightly-out-of-tune piano unison do. Push to
1.04 and the beating tightens into the 5–20 Hz roughness band and the chord acquires a growl.
Past 1.2 the pairs have separated into audibly distinct pitches and the texture is twice as
dense and much brighter. Pulling back down to 1.000 is an *arrival*—thirteen simultaneous
resolutions to unison. That arrival is a cadence, and it is not a metaphor: it is the room
becoming square.

**Why it improves the artwork.** Three things at once. It is the tuning system, derived from
the geometry rather than imposed. It is a cadential mechanism, giving the piece a place to
resolve *to*, which is the load-bearing missing piece in "no narrative arc." And it is the
first time the visual and the sonic parameter are the *same* parameter, answering the
dissertation's unfinished item "map the rendering system to sound"—here the rendering
geometry *is* the sound.

**Falsifiable prediction.** A slow sweep from r = 1.05 down to r = 1.000 will be described by
listeners as a resolution or arrival without being told anything about the system, and will be
preferred over the reverse direction. Disproof: listeners hear the sweep as a timbral change
with no directional or cadential quality, or cannot tell the two directions apart.

**Cheapest test.** Add `aspect` to the config sliders, use it only in the frequency
computation, and add `ctx.setTransform` on the canvas. Roughly 20 lines and it is audible and
visible the same afternoon. Do this one first.

**Cost & risk.** Very low for the sonification-only version; substantial (structure tensor
rework, basis rebuild, audio crossfade) for the physically honest version. Risk: the
sonification-only version breaks the audio-visual link the project cares about, since the
simulation still thinks it is square. My view is that this is acceptable and even interesting
— see proposal 6—but it should be a conscious choice, not a shortcut you forget you took.

**Confidence: high** on the near regime (the beat-rate table is arithmetic), **medium** on the
far regime being musically as interesting as it is structurally interesting.

---

## 4. Sediment: form from irreversibility

**Statement.** This is the attack on the nine-year-old problem. A drone that morphs is still
a drone **because the state space is recurrent**—the fluid revisits, so late sounds like
early, and no amount of local morphing creates before-and-after. Form requires something that
cannot be undone. So give the instrument a second state vector that only ever accumulates: a
long-memory record of where the performer has put energy. That memory does not sound directly;
it *retunes the meaning* of everything else. The family that the performer has sustained
longest becomes the tonic; other families are heard, and tuned, relative to it. Tonicization
takes 30–60 seconds of sustained attention to achieve, and once achieved it decays only slowly.
That gives you exposition, departure, modulation, and return—the actual vocabulary of
musical form—co-authored in real time with a player, which the 2017 offline system could not
have done even in principle.

**Mechanism.** Two accumulators, both leaky integrators, both fed by `|w|`:

```
m_k  ← m_k  + (|w_k| − m_k)  · dt/τ_short     τ_short = 3 s     // recent attention
M_k  ← M_k  + (|w_k| − M_k)  · dt/τ_long      τ_long  = 45 s    // sediment
```

Aggregate to families: `M_F = Σ_{k ∈ F} M_k`. The **tonic** is the family maximizing `M_F`,
with hysteresis: a challenger must exceed the incumbent by 25% for 4 continuous seconds to
take over. Tonic changes are the piece's structural articulations, and there will be only a
handful in a five-minute improvisation, which is correct.

Three things the sediment controls:

1. **Tuning reference.** All family fundamentals are computed as ratios to the *tonic's*
   fundamental, not to (1,1). Since ratios between families are fixed by the geometry, this is
   a transposition, and a tonic change is a genuine modulation—the whole spectrum shifts
   bodily by 793, 600, or 227 cents depending on which family took over.
2. **Resonance / warmth.** Per-mode decay time (proposal 2's Q, or the family voice's release)
   scales as `1 + 2·M_k/max(M)`. Modes that have been played a lot ring longer. The
   instrument warms where it has been used, like a bell that has been rung, and the performer
   can *hear* their own history.
3. **Register ceiling.** A slowly-rising floor: `M_total` gates how many singleton modes are
   audible at all. Early in a session the sound is simple; as sediment accumulates the haze
   thickens. This gives a session a one-way arrow.

Add one reversible operation so the arrow is not a trap: a **flood** gesture (long press, or a
dedicated key) that zeros `M` over 8 seconds while the audio thins to almost nothing. That is
a *double bar*. It is how the performer starts a second movement.

**What it sounds like.** The first minute is bright, thin, and undifferentiated—you are
searching. Somewhere around 40 seconds in, if you have been working the low modes, the sound
"settles": the E family becomes the floor everything else is measured against, its partials
start ringing noticeably longer than they did, and the higher families begin to sound like
*upper structure over a bass* rather than like co-equal objects. Then you deliberately work
the (2,1) family for a while, and around the minute-and-a-half mark the whole aggregate lurches
up a minor sixth—not a glide, a shift of reference, the way a modulation feels. Later you can
work your way back and the return to the original tonic is unmistakably a *return*, because the
sediment made the first tonic sound worn-in. And at the end, the flood: everything drains, the
ringing stops, and you are back to the thin bright search.

**Why it improves the artwork.** It is the only proposal here that makes minute 5 differ from
minute 1 for a reason other than "the performer did something different." It manufactures the
thing a score normally provides—a sense that events accrue—without a score, and without
prewriting the form. And it makes practice pay: a player who understands the sediment can
*plan* a modulation thirty seconds ahead of it happening.

**Falsifiable prediction.** Listeners given a 6-minute recording and asked to mark section
boundaries will agree with each other (and with the logged tonic changes) significantly above
chance. Disproof: boundary markings scatter, or cluster on the performer's loud gestures rather
than on tonic changes—meaning the sediment is inaudible and only dynamics are carrying form.

**Cheapest test.** Skip the tuning half entirely at first. Implement only accumulator (2),
resonance-follows-history, and listen for whether "the instrument warms where you play it" is
audible at all over two minutes. About 30 lines. If that is not audible, the fancier tonic
machinery will not be either.

**Cost & risk.** Medium, maybe 200 lines across sonifier and a new `memory.ts`. Risk: the real
danger is that the effect is *too* slow to perceive. 45 s is at the edge of what auditory memory
holds; if it fails, the fix is not a longer τ but a **visual** display of the sediment (a bar
per family, always on screen) so the performer can see the state they are steering, which turns
an imperceptible slow variable into a playable one. Second risk: tonic changes as bodily
transposition may read as "the pitch jumped," i.e. as a bug. Mitigate by making the transposition
a 1.5 s portamento of every partial simultaneously, which reads as a swoop rather than a glitch.

**Confidence: medium.** The mechanism is sound and cheap; whether 45-second structure is
*perceptible* rather than merely *present* is a genuine open question and is exactly what the
cheapest test is for.

---

## 5. Crossings

**Statement.** The temporal-mismatch problem is misdiagnosed. It is not continuous-visual vs.
discrete-audio. It is that the current discrete events (`modalPercussion`'s threshold-crossing
pings) are *uncorrelated with anything visible*, so they read as noise sprinkled on top. The
2017 solution—refuse events entirely—is an overcorrection that costs you every kind of
articulation. There is a class of event that is simultaneously discrete in structure and
continuous in signal, and that a fluid genuinely produces: **the moment one mode overtakes
another in the energy ranking.** That is visible (the dominant shape changes) and audible if
you sonify it as a *glissando* rather than a ping. Build a small ensemble of monophonic voices
bound to rank slots, each sliding when its slot's occupant changes. You get melody, contour,
phrase, articulation, and not one single onset transient.

**Mechanism.** Five monophonic voices. Voice v is permanently assigned to rank slot v in the
energy-sorted mode list.

```
sorted = argsort(|w|) descending, with hysteresis:
  a mode swaps into slot v only if its |w| exceeds the incumbent's by 12%
each frame:
  target_v = f[sorted[v]]
  rate_v   = |d(log f)/dt| of the crossing, measured over the last ~4 frames
  voice_v.frequency.exponentialRampToValueAtTime(target_v, now + portamentoTime(rate_v))
  portamentoTime = clamp(0.35 / (1 + 6·rate), 0.02, 0.9)
```

So a violent crossing produces a 20 ms slide, which the ear reads as an *articulated leap*; a
lazy crossing produces a 900 ms portamento, which reads as a *bend*. The articulation type is
determined by the physics, not by a threshold you tuned. Amplitude of voice v is
`|w[sorted[v]]|` L1-normalized; voice timbre is proposal 2's oscillator-with-bandwidth so even
the melody voices can go breathy.

Voice 1 gets the widest dynamic range and the most forward pan—it is the melody. Voices 4–5
are 10 dB down and wide—they are the inner voices. This is a five-part texture, and voice
leading falls out of the physics for free, because rank slots change occupants one at a time.

Layer it *over* proposal 1's family drone rather than replacing it: the drone is the harmony,
the crossings are the surface.

**What it sounds like.** Ondes Martenot, or the glissando mass writing in Xenakis's
*Metastaseis* thinned to five parts, or Scelsi. A five-voice texture in which nothing ever
attacks and nothing ever stops, but the parts are constantly bending and occasionally
snapping between pitches. Quiet passages: slow, wide, sighing portamenti crossing each other.
A hard injection: all five voices leap almost simultaneously, which reads as a chord change
executed as a smear, and then relax into slow drift as the fluid dissipates. It is
recognizably *melodic*—you could sing back the top voice—while containing no discrete
onsets at all.

**Why it improves the artwork.** It gets the project events, phrasing, and a top line without
paying the congruence cost that made the pings feel "dinky," and it does so by finding the
event structure that the fluid actually has rather than by imposing one. It also directly
overturns the 2017 refusal, which I think was correct locally and wrong globally: the
dissertation threw out articulation to avoid choppiness, and articulation is most of what a
five-minute piece needs.

**Falsifiable prediction.** Listeners will report hearing a melody and will be able to hum a
contour. They will *not* report hearing "clicks," "plinks," or anything percussive. Disproof:
either no contour is perceived (rank slots churn too fast even with hysteresis—check the
swap rate first; if it exceeds ~4 Hz this proposal cannot work as stated and needs slot
assignment on a smoothed `m_k` from proposal 4 instead of raw `|w|`), or the fast crossings
read as glitches.

**Cheapest test.** Log the slot-swap rate for slots 1–5 over two minutes of typical play,
before writing any audio. If slot 1 changes occupant more than about twice a second, redesign
before building. That is a ten-line instrumentation change and it settles the whole proposal.

**Cost & risk.** Low, ~100 lines, and it composes cleanly with 1 and 2. Risk: exponential
ramps on `frequency` in Web Audio are well-behaved, but cancelling an in-flight ramp every
frame needs `cancelAndHoldAtTime` or you get discontinuities that click—which would be an
ironic failure mode.

**Confidence: medium-high.** High that the sound is good; medium that the fluid's slot-swap
statistics are in the right range, which is why the cheapest test is a measurement, not a
listen.

---

## 6. Canon: lead and lag as compositional material

**Statement.** The brief asks what it would mean for sound and image to be in tension rather
than agreement. Here is a version with exactly one knob and no aesthetic hand-waving: put a
**controllable time offset τ between what you see and what you hear**. At τ = 0 they are
locked, which is the 2017 default. At τ > 0 the audio lags: you watch a vortex form and hear it
a beat later, which produces a distinct feeling of the image *leading*, of watching a
consequence being set up. At τ < 0 the audio leads—genuinely possible here, and impossible
in 2017, because the simulation is cheap enough to run a shadow copy N steps ahead. Then you
*hear* what the fluid is about to do. Sound becomes prophecy. The knob is a rubber band:
stretch it during a long build and snap it back to zero at the climax, and the moment of
re-synchronization is the most powerful audiovisual event this system can produce.

**Mechanism.** Trivial for the lag direction: a ring buffer of `w` snapshots.

```ts
const history: Float64Array[] = ring(600);       // 10 s at 60 Hz
sonifier.updateFromSim( history.at(-1 - lagFrames) );   // renderer keeps using sim.w
```

For the lead direction: keep a second `FluidSim` instance, `oracle`, stepped `N·stepsPerFrame`
extra steps ahead each frame, re-synced from the live sim's `w` whenever the performer injects
(`injectImpulse` copies state into the oracle and re-runs its lookahead). The sim step is a
rank³ contraction—32³ = 32,768 mul-adds per step, negligible—so a 0.5 s lookahead is
affordable. When a performer injection invalidates the prophecy, do not hide it: the audio
audibly *swerves* to accommodate the correction. That swerve is the sound of the performer
overruling the future, and it is the most interesting thing in the proposal.

Bind τ to a continuous control with a detent at zero.

**What it sounds like.** At τ = +0.4 s: a slight, uncanny drag, like dubbing that is barely
off. At τ = +2 s: the image and the sound decouple into two related but independent
streams—you see a gesture, and while you are watching the next one, you hear the first. This
is the audiovisual equivalent of a canon at the distance of two seconds, and the ear starts
tracking the relationship rather than the sound. At τ = −0.5 s: the sound tightens *ahead* of
the picture, and every visual event feels like it has been announced. Snapping τ from 2 s to 0
during a swell produces a sudden collapse of the two streams into one object, and that collapse
is felt physically. It is the same mechanism as a suspension resolving, applied across
modalities.

**Why it improves the artwork.** It makes congruence a variable instead of a constraint, which
is the only way it can be compositional material. It also has a real formal use: an
audiovisual piece with no score can still have a large-scale tension curve if the *degree of
audiovisual agreement* is the curve. And the negative-τ direction is a genuine playability win
— it cancels perceived latency instead of fighting it.

**Falsifiable prediction.** A performance that stretches τ to ~2 s across a 60-second build and
snaps to 0 at the peak will be identified by listeners as having a clear climax at the snap
point, more often than a matched performance with τ held at 0. Disproof: listeners cannot
locate the snap, or find the desynchronized passage merely broken rather than expressive —
which is a real possibility and would tell you the useful τ range is ±0.5 s, not ±2 s.

**Cheapest test.** The ring buffer alone. Twelve lines, one slider, positive τ only. Listen at
0.2 / 0.5 / 1 / 2 seconds and find out immediately whether the decoupling is expressive or just
wrong. Do not build the oracle until the lag direction has proven the concept.

**Cost & risk.** Lag direction: trivial. Oracle: medium and fiddly (state duplication,
re-sync on injection, and a memory cost of a second `U` unless you share the basis, which you
can). Risk: the honest one is that audiovisual desync reads to most people as a technical
fault, not as art. Mitigate by making the offset *visible*—e.g. a faint ghost of the lagged
vorticity field drawn behind the live one, so the eye can see the two time-streams. That also
makes it the second proposal in which the renderer is part of the instrument.

**Confidence: medium** for positive τ, **speculative** for the oracle.

---

## 7. The fretboard: making it an instrument you can get better at

**Statement.** Right now the performer drags a mouse and toggles modes 1–9. That is a toy,
because nothing about it rewards practice: the mapping from gesture to modal content is
opaque, so the player cannot form intentions, only wishes. But the mapping is not actually
arbitrary—`injectImpulse` projects onto the basis, so **stroke position and direction
determine modal content deterministically**, exactly as bowing position determines a string's
spectrum. Make that map visible and it becomes learnable in the same way harmonics on a cello
are learnable: you find the node, you avoid or excite it, you practice.

**Mechanism.** Three parts.

1. **Nodal overlay.** Draw, faintly, the nodal lines of the currently-tonic family (proposal 4)
  —for mode (k₁,k₂) on [0,π]², vorticity ω = sin(k₁x)sin(k₂y), so nodes are the lines
   x = mπ/k₁ and y = nπ/k₂. A grid of thin lines that changes when the tonic changes. Stroking
   *along* a nodal line excites that mode minimally; stroking across an antinode excites it
   maximally. That is a fretboard, and it is derived, not decorated.
2. **Excitation preview.** While the mouse is down, show the projection `Uᵀf` as a live bar
   over the mode table. The player sees which modes their current stroke is feeding before
   they commit to the stroke's length. This is the single highest-leverage UI addition in this
   document, because it converts a blind mapping into a legible one.
3. **Two hands, two timescales.** Fast hand (pointer): excitation—position, direction, speed.
   Slow hand (keyboard or a second pointer): `r` (proposal 3), τ (proposal 6), viscosity, flood.
   Fast gestures are notes; slow gestures are form. Do not put them on the same control.

Latency budget, concretely. Perceptual onset tolerance for a struck gesture is about 20 ms;
above ~40 ms the instrument feels dead. Current chain: pointer event → next `requestAnimationFrame`
(0–16 ms) → `setTargetAtTime(τ=0.03)`, which is ~66 ms to reach 90% → Web Audio output latency
(`ctx.outputLatency`, typically 20–40 ms on desktop, worse on Bluetooth). Total worst case
~120 ms, which is well into "dead." Fixes, in order of payoff: (a) on an injection, bypass the
shared smoothing and schedule an explicit fast attack, `setValueAtTime` then
`linearRampToValueAtTime` over 5 ms; (b) handle pointer events with `pointerrawupdate` and
inject immediately rather than waiting for the frame; (c) request `latencyHint: 'interactive'`
on the `AudioContext`; (d) report `ctx.baseLatency + ctx.outputLatency` in the HUD so this stops
being invisible. Target: under 30 ms from pointer to audible change.

**What it sounds like.** Not a new sound—a new *relationship* to the sound. The audible
difference is that a practiced player can produce a clean single-family excitation (one fused
pitch, no haze) that a novice cannot, because they know to stroke across the (1,1) antinode at
the centre and along the (2,1) nodes. The existence of a technique that is audibly harder is
the point.

**Why it improves the artwork.** An instrument nobody can get better at is a toy, and every
other proposal in this document is worth more if there is a player who can execute intentions.
It is also the second half of the dissertation's unfinished business: not just "map the
rendering system to sound," but make the rendering a *control surface*.

**Falsifiable prediction.** With the nodal overlay and excitation preview on, a user given a
target sound and five minutes of practice will reproduce it more accurately than with the
overlay off, and their accuracy will keep improving over a 30-minute session. Disproof: no
learning curve, or the overlay is ignored—which would mean the projection is too diffuse for
stroke position to be a real control, and the honest response is to make injection *narrower*
in space (currently a point impulse, which excites everything).

**Cheapest test.** Instrument only: log `Uᵀf` for a set of deliberate strokes (centre, corner,
horizontal at 1/3 height, diagonal) and check whether the resulting modal distributions are
actually distinguishable. If a centre stroke and a corner stroke produce similar `w` deltas,
there is no fretboard to draw and this proposal collapses. Twenty lines of logging.

**Cost & risk.** Low-medium. The latency work is fiddly but well-understood. Risk: point
impulses may simply be too broadband for position to matter much, in which case you need a
spatially-extended forcing kernel (a Gaussian blob, width tied to stroke speed), which is a
modest change to `injectImpulse` and probably an improvement regardless.

**Confidence: high** that playability is the right target, **medium** that stroke geometry is a
strong enough control until the logging test confirms it.

---

## Ranked

By artistic payoff per unit cost.

1. **The Room (3)**—a 20-line sonification-only version buys a thirteen-voice natural chorus with beat rates locked to the geometry, plus a cadence mechanism, plus the visual frame joining the instrument. Nothing else here has this ratio. Build it this week.
2. **The Sieve (1)**—one line (`f ∝ √λ`) tests half of it; the payoff is turning a 32-partial cloud into four auditory objects, without which no other musical idea can take hold.
3. **Turbulence as bandwidth (2)**—moderate cost, and it is the only proposal that makes the sound resemble a fluid rather than a synthesizer reading fluid data. Retires the anti-additive objection honestly.
4. **Crossings (5)**—low cost, high payoff (melody, contour, articulation with zero onsets), but gated on a measurement of slot-swap statistics that could kill it outright.
5. **The fretboard (7)**—low-glamour, high-leverage. Every other proposal is worth more with a player who can aim. The latency fixes are worth doing regardless of everything else here.
6. **Sediment (4)**—the highest ceiling of anything in this document, because it is the actual attack on macrostructure, but also the highest risk that the effect exists in the code and not in anyone's ear. Build the cheap half first.
7. **Canon (6)**—the lag direction is twelve lines and worth trying tomorrow; the oracle is speculative and should wait until something else has proven the system is worth predicting.

## What I'd kill

**The current filter bank, in its present form.** Not the concept—the implementation. One
white-noise source feeding 32 high-Q biquads produces *correlated* excitation, so you hear one
filtered noise rather than 32 resonators; 13 of the 32 filters are exact duplicates at
r = 1 and contribute nothing but a centred phantom; and Q up to 2000 gives an 11.6-second ring
at 55 Hz, which makes the low register a freeze pedal and destroys every temporal cue the
simulation produces. Keep subtractive synthesis if you like it, but it needs decorrelated
excitation, deduplicated centres, and `Q = πf/(νλ)`. As written, this strategy cannot sound
like anything but a wash, and I suspect the project's belief that "32 inharmonic partials =
mush" is substantially a report on this one file rather than on the physics.

**The L∞ normalization** (`filterBank.ts:86,117`, and the same pattern in
`harmonicSeries.ts` and `spectralEnvelope.ts`). Dividing by `max|w|` guarantees that exactly
one mode is always at full gain no matter what the fluid is doing, which erases the single
most musically useful quantity in the system: how concentrated the energy is. The dissertation
used L1 for a reason. This looks like an accident, and it costs the whole dynamic dimension of
"focused vs. diffuse."

**Modal percussion as a standalone strategy.** The instinct is right—the system needs events
— but threshold-crossing on `|Δw|` with an adaptive σ produces onsets correlated with the
*integrator's* activity, not with anything a viewer can see, which is exactly why it reads as
dinky. Proposal 5 keeps the event structure and throws away the onsets. If you want to retain
percussion at all, trigger it only on *performer* injections, where the visual correlate is
unambiguous, and not on the simulation's internal churn.

**Top-N peak tracking with quantization to a scale** (idea B in `SONIFICATION_IDEAS.md`).
The tracking half is good and becomes proposal 5. The quantization half should go: the
dissertation's objection to imposed scales was right, and—more decisively—proposal 1 shows
the basis *already contains* exact harmonic series, so quantizing to a scale would be
overwriting real consonance with imported consonance. Strictly worse.

**The Phase 2 plan: Lanczos eigensolver + full Navier-Stokes rewrite + obstacle editor.** This
is weeks of work justified by an untested hypothesis ("the sim is too static, so the sound has
no narrative"). I do not believe the diagnosis. The sound has no narrative because nothing in
the audio path accumulates, tonicizes, resolves, or articulates—none of which is a property
of the simulation. Proposals 3, 4, and 5 attack narrative directly for a few hundred lines
total. If after those the sound *still* has no arc, then the sim is the problem and Phase 2 is
justified. Doing it first risks spending the project's whole budget on a richer input to an
audio path that cannot express richness.

**"Turbulent cascade: energy moves from large scales to small scales"** as a narrative source.
As FLOOR.md already notes, this is 3D reasoning applied to a 2D simulation, where Kraichnan's
dual cascade sends energy the other way; and at rank 32 there is not enough scale separation
for a cascade of either sign to be present. `filterBank.ts` already encodes the 3D story in its
`cascadeQ` and `cascadeMul` terms, which are therefore sonifying a phenomenon that is not
occurring. Cut them.
