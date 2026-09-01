# Instrument proposals

*Written from an instrument-design / NIME position. Not a summary of prior work — a proposal
for what to build next. All measurements below were taken by running the app (Vite dev server,
Chromium, grid 128, rank 32, 8000 particles, 512² canvas) on 2026-08-31, not estimated.*

---

## 0. Diagnosis: what the interaction design currently is

The honest description: **a well-built physics demo with a debug panel bolted to it.** Every
element that would make it an instrument is either absent, dead code, or actively cancelled by
something else in the pipeline. Seven findings, in descending order of how much they matter.

### 0.1 The gesture carries no velocity. This is the big one.

`main.ts:277–280`:

```ts
const dx = gx - config.grid / 2;
const dy = gy - config.grid / 2;
const len = Math.sqrt(dx * dx + dy * dy) || 1;
sim.injectImpulse(gx, gy, (dx / len) * config.force, (dy / len) * config.force);
```

The impulse direction is computed as **the radial direction from the canvas centre**, not from
the mouse's motion. Dragging left and dragging right through the same pixel produce the
*identical* force. Speed is discarded. There is no `movementX`, no timestamp, no previous
position anywhere in the file. The entire gestural content of a stir reduces to a stream of
positions, each mapped to a fixed-magnitude outward push.

Then `injectImpulse` (`fluid.ts:151–163`) projects a **single-cell delta function**
(`idx = floor(gy)*xRes + floor(gx)`) onto the basis. A delta excites all 32 modes with weights
equal to the basis value at that point — near-white excitation. So there is no scale dimension
either: you cannot stir *broadly* versus *finely*. Position is the only input variable, and
position only selects which modes get which *sign*.

An instrument whose input is one 2D position with no velocity, no pressure, and no scale is a
mouse-driven trigger. It has roughly the expressive bandwidth of a theremin with the volume
antenna removed.

### 0.2 The instrument cannot get louder or softer

Two independent mechanisms conspire to destroy the amplitude dimension:

- `fluid.ts:106–112` — the energy correction rescales `w` every step to exactly preserve
  `‖w‖₂`. That is correct Galerkin practice, but it means the physics has no dynamics of its own
  except viscous decay.
- Every continuous strategy then **normalises by max|w| per frame**: `filterBank.ts:86–87`,
  `harmonicSeries.ts:48–50`, `spectralEnvelope.ts:59–61`. Dividing out the maximum discards the
  overall level entirely.

Net result: a gentle stir and a violent stir produce the same output level. `FLOOR.md` §7 flags
the L∞-vs-L1 divergence, but the deeper problem is not which norm — it is that **normalising per
frame at all removes the single most important expressive dimension any instrument has.** The
dissertation knew this: it kept two normalisation modes and described the global-max one as
having a "variable, dynamic envelope" [FLOOR.md §1].

### 0.3 Measured latency, and where it leaks

| Stage | Measured / derived |
|---|---|
| `frame()` body cost | **5.3 ms** median, 5.4 ms p90 (of a 16.7 ms budget) |
| Frame rate | 59.9 fps steady, max frame interval 17.8 ms |
| `canvasInject` per pointer event | **1.25 ms** |
| `AudioContext.baseLatency` | 5.33 ms @ 48 kHz |
| Reported CFL | 0.007 → `w` e-folds over ~143 steps ≈ **1.2 s** |

Three leaks:

1. **Audio is updated last.** `main.ts:382–388` runs `renderer.render()` →
   `renderer.renderParticles()` → `updateModeTable()` → *then* `sonifier.updateFromSim()`. Audio
   inherits the full 5.3 ms of rendering as pure latency, every frame, for nothing. Moving the
   sonifier call directly after the sim-step loop is a free ~5 ms.
2. **`setTargetAtTime(…, 0.03)` everywhere, symmetric.** `filterBank.ts:123,127`,
   `harmonicSeries.ts:59`, `spectralEnvelope.ts:70`. τ = 30 ms means 63% of the change at 30 ms,
   95% at ~90 ms — and the *same* time constant on the way down, so attacks and decays are
   smeared identically. There is no transient anywhere in the design.
3. **`canvasInject` calls `sim.reconstruct()` (`main.ts:281`)** which `step()` immediately redoes
   at `fluid.ts:124`. At a 120 Hz pointer that is 150 ms of wasted main thread per second of
   dragging. Delete the line.

Total gesture→audible-change budget: ~5–22 ms of frame quantisation (audio-last), plus 30 ms to
63% / 90 ms to 95% of smoothing, plus output latency (0 reported headless; expect 10–30 ms on
real hardware). Call it **~45 ms to "something changed", ~110 ms to "fully changed"**. Wessel and
Wright's benchmark for intimate control is 10 ms with under 1 ms jitter. The architecture is not
the problem — there is 11 ms/frame of headroom sitting unused. The τ constant and the call
ordering are the problem, and both are one-line fixes.

### 0.4 The bidirectional claim is not true at runtime

- `FluidSim.setCoefficients` (`fluid.ts:169`) is referenced only from `fluid.test.ts`.
- `Sonifier.frequenciesToCoefficients` (`sonifier.ts:150`) is never called from anywhere.
- `SpectralEnvelopeStrategy` exists but is not in `STRATEGY_FACTORIES` (`sonifier.ts:28–32`), so
  it is unreachable.

The headline feature — sound drives fluid — is three unwired functions. And `setCoefficients`
*overwrites* `w` rather than adding to it, which is why it is unusable in a loop: overwriting
destroys the physics state it is supposed to perturb.

### 0.5 The number-key "keyboard" is not a keyboard

`main.ts:347–354` drives forced modes at `phase = forceTime * sqrt(λ) * 50`, with
`forceTime += dt` per substep. At dt = 1e-4, 2 substeps/frame, 60 fps, that gives a phase rate of
0.6·√λ rad/s:

| key | mode | λ | forcing rate |
|---|---|---|---|
| 1 | (2,1) | 5 | 0.21 Hz (4.7 s period) |
| 2 | (1,2) | 5 | 0.21 Hz (4.7 s period) |
| 3 | (2,2) | 8 | 0.27 Hz (3.7 s period) |
| 9 | (4,1) | 17 | 0.39 Hz (2.5 s period) |

These are sub-hertz LFOs, not notes — the docstring's "pumped sinusoidally at its natural
frequency" is off by four orders of magnitude relative to the 55–4000 Hz audio range. More
damningly: **keys 1 and 2 select (2,1) and (1,2), which share λ = 5 and therefore map to the same
frequency.** Pressing 1 versus 2 changes the picture's orientation and (in the filter bank) the
stereo pan, but not the pitch.

This generalises. Computing the basis at each reachable rank:

| rank | distinct frequencies | colliding groups | `eigenvalues[rank-1]` is max? |
|---|---|---|---|
| 16 | 10 / 16 | 6 | yes |
| 20 | 12 / 20 | 8 | **no** (last = 29, true max = 32) |
| 24 | 14 / 24 | 10 | yes |
| 32 | **19 / 32** | 13 | yes |
| 64 | 34 / 64 | 27 | yes |

At the default rank 32 the filter bank has 13 groups of filters sitting at *identical* centre
frequencies. Roughly 40% of the spectral resolution is illusory. And `sonifier.ts:77–78` assumes
`eigenvalues[]` is sorted (`lamMax = this.eigenvalues[rank-1]`), which is false at rank 20 and
false in general — the rank-32 sequence goes `… 25, 25, 32, 26, 26, 29 …`. At rank 20 that pushes
mode (4,4) to 4681 Hz, above the nominal 4000 Hz ceiling.

### 0.6 Any parameter change kills the audio

`main.ts:157–168` fires `rebuildSim()` on every `input` event of a `cold` slider, and
`rebuildSim` (`main.ts:197–200`) discards the `Sonifier` and sets `audioStarted = false`. So:
touch the Modes, Grid, or Timestep slider mid-performance and **the sound stops** until you click
the canvas again. Worse, dragging Grid from 32 to 256 rebuilds the sim on every intermediate
value — at grid 256, rank 32, `U` alone is 2·65536·32 doubles = 33 MB, allocated eight times in
one drag.

There is no reason these are `input` rather than `change`, and no reason the sonifier is thrown
away when only the sim geometry changed.

### 0.7 Nothing persists, and the display is a debug view

`updateModeTable()` (`main.ts:250–256`) does 32 `getElementById` lookups plus 32 `textContent`
writes every frame, rendering a numeric table at 60 Hz that no human can read. That table
occupies the position where an instrument's state display should be. Meanwhile there is no
preset, no undo, no save, no recording, no URL state — a good moment cannot be kept.

And per `FLOOR.md` §6, the rendering is still static: colours hardcoded at `renderer.ts:67–69`,
dye dissipation hardcoded at `main.ts:378`, particle alpha at `renderer.ts:98`. The 2017
dissertation's named unfinished business ("map the rendering system to sound") is still
unfinished, nine years on.

Finally: input is `mousedown`/`mousemove` only (`main.ts:287–295`). No PointerEvents, no touch,
no pressure. The piece is dead on a tablet or phone.

---

## Proposals

### 1. The Bow — give the gesture velocity, scale, and pressure

**Statement.** Replace point-impulse-at-a-position with a *stroke*: a force field whose direction
comes from actual pointer velocity, whose magnitude comes from speed and pressure, and whose
**spatial width** is a controlled parameter. Width is the missing axis. A wide, slow smear
projects almost entirely onto low modes; a narrow, fast flick projects onto high ones. That
single change turns one 2D input into a four-dimensional gesture (where, which way, how hard, how
coarse) without adding any hardware, and it is the difference between poking a fluid and playing
one.

**Mechanism.** Rewrite `canvasInject` (`main.ts:270–284`) on `pointerdown`/`pointermove`/
`pointerup`, consuming `event.getCoalescedEvents()` so that fast strokes are not decimated by the
rAF/event-loop sampling. Maintain previous position and timestamp; derive
`(fx, fy) = k · (Δx, Δy)/Δt` and `speed = |v|`. Replace `FluidSim.injectImpulse`'s single-cell
projection (`fluid.ts:155–162`) with a Gaussian splat projection:

```
w[col] += Σ_{cells in splat} g(cell) · ( U[col, cell]·fx + U[col, fieldSize+cell]·fy )
```

with splat radius `r = r_max · (1 − pressure)` or `r = f(1/speed)`. Cost is `rank × splatArea`
instead of `rank × 1` — at rank 32 and a 9×9 splat that is 2600 multiply-adds, i.e. nothing
against the measured 1.25 ms already spent per event (most of which is the redundant
`reconstruct()` at `main.ts:281`, which this change should delete). `pointerEvent.pressure` gives
stylus/trackpad force where available and 0.5 elsewhere; `pointerType` distinguishes pen from
touch from mouse.

**What it feels like to play.** Right now every stir feels the same because it *is* the same.
After this: a slow broad sweep across the canvas produces a low, wide swell — you can hear the
fundamental modes loading up under your hand. A quick flick in the corner produces a bright thin
scratch. Reversing direction mid-stroke actually cancels what you just put in, so you can shape
and un-shape. This is the bowing/plucking distinction, and it is what makes the difference
between a control surface and an instrument you can develop technique on. Compare the Karlax or
Waisvisz's *The Hands*: the expressive payload lives in the continuous derivatives of the
gesture, not its position.

**Why it improves the artwork.** It is the precondition for everything else here. No amount of
clever sonification rescues an input channel that carries one variable.

**Falsifiable prediction.** With splat-width bound to pointer speed, the spectral centroid of `w`
immediately after a stroke will vary by more than one octave between the slowest and fastest
usable stroke speeds, and a listener will be able to sort recordings of "slow stroke" versus
"fast stroke" above 90% correct. **Disproof:** centroid varies by less than a third of an octave —
which would mean the basis projection is dominated by position, not width, and the scale axis is
an illusion.

**Cheapest test.** Two hours. Hardcode two splat radii (3 and 12 cells), bind them to left-drag
and shift-drag, print the spectral centroid to the console, and drag. If the numbers do not
separate cleanly, stop here.

**Cost & risk.** ~80 lines. Latency-neutral or better (deleting `main.ts:281` returns ~1 ms per
event). Risk: coalesced events on a 240 Hz trackpad could deliver 4× the injections per frame and
overload `w`; mitigate by integrating force over the coalesced batch and injecting once.

**Confidence.** High (0.9) that this is necessary. High (0.8) that the width-as-scale mapping
works as described — it is just the projection theorem, a narrow splat has broadband spatial
spectrum.

---

### 2. Larsen — close the loop and let the system sing back

**Statement.** The dissertation's wish list names "the system interacting back." The mechanism for
that already half-exists and is unwired. Feed the audio output's per-band energy back into `w` as
a *force*, with a gain knob. At low gain the fluid is sympathetically excited by its own sound and
the whole thing behaves like a resonant body. Past a threshold it self-oscillates: the fluid and
the audio lock into a limit cycle and the piece plays itself while you steer. This is the one
proposal here that is *structurally impossible* offline, because it requires the loop to close in
real time.

**Mechanism.** An `AudioWorkletProcessor` taps the master bus, runs a bank of one-pole envelope
followers on the same `frequencies[]` the sonifier already computes (or, cheaper, a single
`AnalyserNode` with `getFloatFrequencyData` and per-mode bin lookup — 2048-point FFT at 48 kHz
gives 23 Hz bins, adequate above ~200 Hz, marginal for the lowest modes; the worklet is the right
answer, the analyser is the right prototype). Envelopes are posted to the main thread and applied
in `frame()` as a force term *before* `sim.step()`:

```ts
for (let k = 0; k < rank; k++) w[k] += feedbackGain * bandEnergy[k] * Math.sign(w[k] || 1) * dt;
```

Two architectural changes are required, and they are the interesting part:

- **`setCoefficients` must become additive.** `fluid.ts:169–175` overwrites `w`, which annihilates
  the physics. Add `addCoefficients(c, gain)` alongside it, and treat the existing overwrite as a
  scene-load primitive, not a feedback primitive.
- **The energy correction (`fluid.ts:106–112`) must become partial.** As written it rescales
  `‖w‖₂` back to its pre-step value every step, which will silently cancel any feedback growth —
  the loop cannot self-oscillate through a hard energy clamp. Introduce a `conservation ∈ [0,1]`
  parameter: `scale = (e1/e2)^(0.5·conservation)`. At 1 it is today's behaviour; at 0 the
  Galerkin system is free to gain and lose energy. This is exactly the dissertation's
  "fluids as they might be" licence [FLOOR.md §2] and it is a *playable* parameter, not a fix.

Add a feedback delay (a `DelayNode` on the tap, 0–500 ms) so the loop has a period you can tune,
the way moving a guitar relative to an amp tunes a Larsen tone.

**What it feels like to play.** At feedback 0 it is today's system. Turning it up, the sound
starts to bloom slightly after each stir — a tail that is not just decay but *response*, as if the
box had a body. Higher still and there is a threshold where the thing catches: a mode locks, the
image freezes into a standing pattern, and a tone stabilises that you did not put there. Then the
performance becomes about *steering* the runaway — stirring across the locked mode to break it,
easing the gain back to let it decay, choosing which mode catches next. This is the entire
practice of feedback music: Agostino Di Scipio's *Audible Ecosystemics* (a system that sounds only
because it listens to its own sound in a room), Nic Collins's handmade feedback electronics,
Tudor's *Rainforest*, and the taxonomy in Sanfilippo & Valle's survey of feedback musical systems.
The instrument stops being a thing you operate and becomes a thing you negotiate with.

**Why it improves the artwork.** It is the direct answer to the brief's central fact. It also
attacks macrostructure for free: a feedback system has *regimes* — quiescent, ringing, locked,
chaotic — and moving between regimes is form. Nine years of "no narrative arc" (`SONIFICATION_IDEAS`
problem #2) is a problem about the system having no states to move between. Feedback gives it
states.

**Falsifiable prediction.** There exists a critical gain `g*` such that above it the system enters
a sustained limit cycle within 10 seconds from *any* nonzero initial condition, and **the limit
cycle reached depends on the initial condition** — different stirs lead to different locked modes.
**Disproof:** either it always decays regardless of gain (the energy correction or viscosity wins),
or every run converges to the same single attractor. The second failure is the dangerous one: it
would mean feedback is a switch with two settings, not an expressive continuum, and the proposal
should be killed rather than tuned.

**Cheapest test.** Half a day, no worklet. `AnalyserNode` → `getFloatFrequencyData` in `frame()`
→ nearest-bin lookup per mode → additive force with a keyboard-controlled gain, plus the
`conservation` slider. Sweep the gain by hand and listen for a threshold. If there is no
threshold, there is no proposal.

**Cost & risk.** Prototype ~120 lines; production worklet ~250. Latency: the analyser adds a
frame of delay, which is *fine* — feedback loops want a delay, and a 16 ms loop delay corresponds
to a 60 Hz feedback resonance which is usefully sub-audio. Real risks: (a) uncontrolled runaway
producing a full-scale square wave into someone's headphones — a hard limiter on the master bus
is non-optional; (b) the sim going numerically unstable when `conservation < 1` (the Euler
integrator at `fluid.ts:102–104` has no stability margin to spare, though measured CFL 0.007
suggests plenty of room).

**Confidence.** Medium-high (0.7) that a usable threshold exists. Very high (0.95) that this is
the most interesting thing in this document. Medium (0.5) that it is controllable enough for
performance without a second control axis — see proposal 7.

---

### 3. Dynamics — restore the amplitude dimension

**Statement.** Delete per-frame max normalisation. Make loudness mean something. This is the
smallest change here and probably the largest perceptual return, because right now the instrument
is playing at exactly one volume forever and every other expressive gain is being measured
against a flat reference.

**Mechanism.** Three coupled edits:

1. **L1 per-mode weights, absolute overall gain.** Replace `activity = |w[k]|/maxW` in
   `filterBank.ts:117`, `harmonicSeries.ts:55`, `spectralEnvelope.ts:66` with
   `a_k = |w[k]| / ‖w‖₁` (the dissertation's eq. 2, [FLOOR.md §1]) for the *distribution*, and
   apply a separate master gain derived from `‖w‖₂` through a compressive curve
   (`(‖w‖₂/ref)^0.4`, roughly loudness-linear) with a soft ceiling. L1 conserves the partial
   budget, so energy concentrating into few modes reads as *focus* rather than as nothing.
2. **Asymmetric smoothing.** Replace the single `setTargetAtTime(…, 0.03)` with attack τ ≈ 5 ms
   and release τ ≈ 150 ms, chosen per direction. Transients become possible; the wash stays smooth.
3. **The `conservation` slider** from proposal 2, which is what actually lets an impulse read as a
   crescendo instead of being instantly renormalised away.

**What it feels like to play.** You can play quietly. You can build. A hard stroke is *loud*, and
the difference between hard and soft is the first thing anyone learns on any instrument and the
last thing they stop refining. Right now that learning curve does not exist because the dimension
does not exist.

**Why it improves the artwork.** `SONIFICATION_IDEAS` lists "no narrative arc" as the unsolved
problem and then proposes elaborate machinery (phrase detection, entropy-as-tension, harmonic
rhythm) to synthesise arc. But arc in music is, first and overwhelmingly, *dynamics*. The system
already has an energy signal; three lines of normalisation are throwing it in the bin.

**Falsifiable prediction.** In a blind A/B, listeners identify which of two 10-second recordings
contains a hard stir versus a soft stir at above 85%. Current system: chance. **Disproof:** still
near chance after the change — which would mean the energy correction is flattening `‖w‖₂` more
completely than expected and the `conservation` parameter is the real load-bearing piece.

**Cheapest test.** One hour. Record two clips before and after; A/B them yourself; if you cannot
hear it, nobody can.

**Cost & risk.** ~40 lines across four files. Zero latency cost (the asymmetric attack *reduces*
latency to 5 ms on rising edges). Risk: absolute gain means clipping is now possible — needs a
`DynamicsCompressorNode` or a soft-clip on the master. Also risk of the opposite failure: the
system spends most of its time near-silent and the performer has to work to be heard. That is
arguably correct, and is what a `ref` calibration knob is for.

**Confidence.** Very high (0.95). This is not a speculative design idea, it is a dimension that
is currently switched off.

---

### 4. Harmonicity — one knob from gong to voice

**Statement.** The eigenvalue→frequency map is not physics; it is a choice (`sonifier.ts:79–86`),
and it is currently a fixed choice with no handles. Make it two continuous parameters: the
dissertation's octave-scaling `s` (spectral *spread*) and a **harmonicity morph** that
interpolates every mode's frequency between its physical value and the nearest harmonic of a
fundamental. Turn the knob and the same fluid goes from an inharmonic plate/gong to a fused,
pitched, almost vocal tone — continuously, in real time, without changing a single thing about the
simulation.

**Mechanism.** In `Sonifier`, keep `physFreq[k]` (today's log-log map) and compute
`harmFreq[k] = f0 · round(physFreq[k]/f0)`. Expose `harmonicity ∈ [0,1]` and set
`f[k] = physFreq[k]^(1−h) · harmFreq[k]^h` (geometric interpolation, so the morph is
perceptually even). Write `f[k]` to `filter.frequency` / `osc.frequency` with a
`setTargetAtTime` on a slow τ (~200 ms) so the morph glides. Add `s` by replacing the fixed
`freqHigh` endpoint with `freqLow · (freqHigh/freqLow)^(t^(1/s))`. Also fix
`sonifier.ts:77–78` to use `Math.max(...eigenvalues)` rather than assuming sorted order (false at
rank 20, see §0.5), and de-duplicate the 13 colliding λ groups at rank 32 by adding a small
deterministic per-mode detune — degenerate pairs like (2,1)/(1,2) should beat against each other,
not sum coherently.

**What it feels like to play.** At h = 0 it is the current sound: a bar of colliding partials, a
struck plate. Sweep h upward over ten seconds and the partials slide into alignment — the sound
*fuses*, a pitch emerges from the noise, and the fluid appears to acquire a voice without changing
its motion at all. It is the most dramatic single-knob gesture available in this system, and it is
20 lines of arithmetic.

**Why it improves the artwork.** It is a direct, principled answer to `SONIFICATION_IDEAS` problem
#1 (inharmonic ratios = mush) that does *not* violate `FLOOR.md` §2's objection to quantisation.
The dissertation rejected 12-TET because "its rigidity would belie the abstract amorphous quality
of our visuals." A continuous morph is not a grid — you can sit anywhere on it, including nowhere
near either end, and the interesting territory is the middle. The theory is Sethares's
(*Tuning, Timbre, Spectrum, Scale*): consonance is a relationship between a spectrum and a scale,
so moving the spectrum is as legitimate as moving the scale, and it is the move that keeps the
physics visible.

**Falsifiable prediction.** At fixed `w`, sweeping h from 0 to 1 produces a change that listeners
describe with pitch/fusion vocabulary ("it turned into a note") rather than filter vocabulary
("it got brighter"), and the perceived fundamental at h = 1 is `f0` regardless of which modes are
active. **Disproof:** at h = 1 with a scattered `w`, no single pitch is heard — meaning the
rounding is producing sparse, non-adjacent harmonics that do not fuse, and the morph needs a
harmonic-density constraint rather than nearest-rounding.

**Cheapest test.** 45 minutes. Add `h` on the `[`/`]` keys, freeze the sim with space, sweep.

**Cost & risk.** ~50 lines. No latency cost. Risk: `BiquadFilterNode.frequency` automation on 32
filters simultaneously is cheap, but at Q up to 2000 (`filterBank.ts:14`) sweeping the centre
frequency of an extremely high-Q filter will produce zipper artefacts and possible instability —
lower Q during a morph, or crossfade between two banks.

**Confidence.** High (0.85) that it works and sounds dramatic. Medium (0.6) that the middle of the
range is more interesting than the ends, which is the actual artistic claim.

---

### 5. The Loom — record and layer the state vector, not the audio

**Statement.** `w` is shared state between physics, image, and sound. Therefore recording `w(t)`
records *all three in perfect lock*, and looping it loops the picture and the music together —
something no audio looper can do and no offline renderer could ever have offered. Build a
looper over `w`: capture, loop, overdub, undo. This is the macrostructure proposal.

**Mechanism.** A ring buffer of `Float32Array(rank)` sampled at 30 Hz (half frame rate; `w`
e-folds over ~1.2 s at the measured CFL 0.007, so 30 Hz is a 36× oversample — plenty). Ten
minutes at rank 32 is 30·600·32·4 B = 2.3 MB. Trivial.

Operations, all in `main.ts`'s frame loop:

- **Capture** — always-on rolling buffer, so the performer never has to have pressed record
  before the good bit. (Retroactive capture is the single most valuable feature of a looper and
  the one most often omitted.)
- **Bookmark / recall** — snapshot `w` to a slot; `setCoefficients` (the existing overwrite
  semantics, `fluid.ts:169`, finally justified) restores it. This is undo.
- **Loop** — replay a marked span by *blending*: `w = (1−α)·w_live + α·w_recorded`, with α a knob.
  At α = 1 the physics is bypassed and the recording plays; at α = 0.3 the recording becomes a
  *forcing* that the live fluid follows loosely and departs from. That intermediate zone is where
  the artistic value is.
- **Overdub** — `addCoefficients(w_recorded, gain)` layers a past trajectory onto the present one.

**What it feels like to play.** You stir something good, and instead of watching it decay you keep
it. Then you play *against* it: the loop carries the low modes, you work the high ones by hand.
Then you overdub, and the two trajectories interfere — sometimes reinforcing into a strong
standing pattern, sometimes cancelling. A session accretes. This is Frippertronics and the
Echoplex Digital Pro applied to a modal state vector, and it is also Pauline Oliveros's Expanded
Instrument System premise: the performer plays with their own past.

**Why it improves the artwork.** `FLOOR.md` §6 names "more complete audiovisual works, deeper in
macrostructure and musical form" as the stated nine-year gap. Layering is how form gets made in
practice by every looping musician alive. It is far more likely to produce large-scale structure
than any of the automatic phrase-detection schemes in `SONIFICATION_IDEAS`, because it puts the
structural decision in the performer's hands at the moment they can hear whether it works.

**Falsifiable prediction.** A performer can construct, in a single unedited take, a three-section
piece in which material from section 1 returns recognisably in section 3. **Disproof:** overdubbed
`w` trajectories always collapse — either the energy correction renormalises the sum into
something resembling neither layer, or the nonlinear advection destroys the recorded trajectory
within a second so the "loop" is inaudible as such. This is a real risk and the reason the α-blend
must exist: pure additive layering of a nonlinear system's state is not guaranteed to sound like
layering.

**Cheapest test.** Three hours. Ring buffer plus a single key that toggles "replay last 8 seconds
at α = 1." If the replay does not look and sound identical to what just happened, the state vector
is not as complete a description as assumed (dye and particles are *not* in `w` — they will
diverge, and you must decide whether to record them too or accept that the dye is the improvised
layer).

**Cost & risk.** ~200 lines. No latency cost. Risk noted above. Secondary risk: the dye field
(`dye.ts`) and particles (`particles.ts`) carry visual state that is *not* in `w`, so a `w`-loop
replays the motion but not the ink. Arguably a feature — the image accumulates history the sound
does not.

**Confidence.** Medium-high (0.7). The mechanism is sound; the open question is whether layered
modal trajectories are perceptually legible as layers.

---

### 6. The Look — make the image a played voice, not a readout

**Statement.** `FLOOR.md` §6 records that the 2017 rendering was static — "same lighting and
colour always" — and names mapping the renderer to sound as unfinished business. It is still
unfinished. Extract every hardcoded visual constant into a live parameter set, bind some of it to
the fluid state, and reserve an explicit *gesture* for changing the look independently. The image
should be something the performer plays, not something the sound leaves behind.

**Mechanism.** A `LookConfig` object replacing the constants at `renderer.ts:67–69` (vorticity
tint vectors), `renderer.ts:98` (particle alpha), `main.ts:378` (dye dissipation 0.985),
`main.ts:283` (injected dye colour). Parameters: exposure, vorticity/dye/particle mix, hue
rotation, dye persistence, particle trail length, and a background-decay "trail" mode where the
canvas is decayed rather than overwritten.

Then two bindings:
- **Coupled**: exposure ← `‖w‖₂`, hue rotation ← spectral centroid, particle trail length ←
  viscosity, with a per-binding depth knob so coupling is a dial from 0 (independent) to 1 (locked).
- **Independent**: a modifier gesture (right-drag, or two-finger drag) that moves look parameters
  without touching `w`. The performer gets a second voice that is purely visual.

Prerequisite: move the per-pixel loop (`renderer.ts:56–83`, 262144 iterations of JS per frame)
to a WebGL2 or WebGPU fragment shader. Measured frame cost is 5.3 ms and the renderer is most of
it; freeing that budget is what pays for proposals 2 and 5 and for raising rank past 32.

**What it feels like to play.** The instrument currently has one output surface that happens to be
displayed twice. After this it has two voices that can agree or disagree. Making the image go dark
while the sound swells is a *compositional* gesture. Golan Levin's *Audiovisual Environment Suite*
and *Yellowtail* are the reference points for a single stroke being simultaneously image and
sound; the video-synthesis lineage (Sandin Image Processor, Rutt/Etra) is the reference for
treating the look itself as a patchable, performable instrument rather than a display mode.

**Why it improves the artwork.** It doubles the expressive surface with no new physics, and it
closes out an explicitly named nine-year-old gap. It is also the proposal that most directly
improves the experience of *watching* someone else play, which matters if this is ever performed.

**Falsifiable prediction.** With coupling depth at 0, a viewer shown silent video cannot predict
the audio dynamics; with depth at 1 they can. If both are equally predictable, the visual
parameters chosen are not perceptually salient and the wrong ones were exposed. **Disproof:**
viewers report the coupled version as "obvious/cheesy" and the uncoupled as "arbitrary" — i.e.
there is no useful middle, and the whole coupling-depth framing is wrong.

**Cheapest test.** Two hours, no shader: pull the six constants into a `LookConfig`, add
exposure ← `‖w‖₂` with a depth key, and see whether the coupled version is more compelling than
the current one. The GPU port is only needed if it is.

**Cost & risk.** LookConfig extraction: ~100 lines, an afternoon. WebGL port of the renderer:
~300 lines, two days, and a real risk of spending a week on a rendering rewrite that produces the
same picture. Do the extraction first and only port if the frame budget actually binds.

**Confidence.** High (0.85) that visual parameters should be live. Medium (0.55) on the specific
coupling choices — those need listening/looking, not reasoning.

---

### 7. Two hands — Web MIDI for the continuous parameters

**Statement.** Every proposal above adds a continuous parameter: conservation, feedback gain,
harmonicity, `s`, loop blend α, coupling depth, look exposure. They cannot live on a slider panel
you have to look at, and they cannot live on the mouse, because the mouse is the gesture. Put them
on a cheap MIDI controller via Web MIDI. This is the change that makes ten hours of practice
possible rather than theoretical.

**Mechanism.** `navigator.requestMIDIAccess()` (Chromium/Edge; Safari 18+ behind a setting;
Firefox with the site-permission add-on — so it must degrade, not gate). A small
`ControlSurface` module maps CC number → parameter with a MIDI-learn mode. Crucially, add
**takeover/soft-pickup** logic so a physical knob's position does not jump the parameter when a
preset is recalled — this is the single detail that separates usable hardware mapping from
frustrating hardware mapping. Fall back to keyboard-and-slider when no device is present.

The same module should absorb the fixes from §0.6: sliders on `change` not `input`, and never
disposing the `Sonifier` on a sim rebuild.

**What it feels like to play.** Left hand on knobs, right hand on the surface, eyes on the image.
Sweeping feedback gain with the left while stirring with the right is a *different activity* from
doing either alone, and it is the activity the piece is actually about. Hunt and Kirk's
experiments are the standard citation: for real musical tasks, multiparametric interfaces where
several parameters move together beat one-slider-per-parameter interfaces, even though the latter
test better in isolation. That result is precisely an argument against the current config panel.

**Why it improves the artwork.** Practice requires a stable, eyes-free, continuous control
surface. Without one there is nothing to get better at, and an instrument nobody can improve at is
a toy.

**Falsifiable prediction.** With MIDI, a performer sustains a shaped 3-minute improvisation with
no visible fumbling; with the current mouse-plus-panel, they cannot change a continuous parameter
without stopping the gesture. The second half of that is already observably true today.

**Cheapest test.** Two hours with any $60 controller, four CCs mapped to four constants,
hardcoded. No learn mode, no persistence.

**Cost & risk.** ~150 lines for a decent version. No latency concern — MIDI input is sub-
millisecond and control-rate. Risk: browser support is uneven and it makes the piece
hardware-dependent, which cuts against sharing a URL. Mitigate by keeping full keyboard fallback
and treating MIDI as an upgrade path, never a requirement.

**Confidence.** High (0.9) that this is needed for the instrument reading. Low relevance if the
answer to "which artwork" turns out to be installation or toy — see below.

---

## Ranked

1. **Dynamics (3)** — one hour of work, restores the dimension every other proposal is measured
   against. Everything else is louder and softer in a world where nothing is louder or softer.
2. **The Bow (1)** — the input channel currently carries one variable. Nothing downstream can fix
   that.
3. **Harmonicity (4)** — best ratio of dramatic result to lines of code in the whole document, and
   it answers the ideas doc's stated problem #1 without violating the dissertation's stated
   objection.
4. **Larsen (2)** — the highest-ceiling idea and the only one that is *structurally* impossible
   offline. Ranked fourth only because 1–3 are prerequisites for hearing whether it is working.
5. **The Loom (5)** — the macrostructure play. Deferred behind the above because looping a system
   with no dynamics and one gesture is looping nothing.
6. **Two hands (7)** — necessary the moment there are more than about three continuous parameters,
   which is immediately after 2 and 4 land.
7. **The Look (6)** — real, named, unfinished business, but the least urgent because the piece
   already looks good and none of the other proposals are blocked on it. The WebGL port inside it
   may become urgent for frame budget; the aesthetic half can wait.

**Free wins to do first, in under an hour, before any of the above:** move
`sonifier.updateFromSim` above the render calls in `frame()` (~5 ms of latency, `main.ts:382–388`);
delete the redundant `sim.reconstruct()` at `main.ts:281` (~1 ms per pointer event); switch cold
sliders to `change` and stop discarding the `Sonifier` on rebuild (`main.ts:157–200`); fix
`lamMax` to use `Math.max` (`sonifier.ts:78`); throttle `updateModeTable` to 4 Hz or delete it.

## What I'd kill

- **The mode table** (`main.ts:207–256`). Thirty-two rows of `toFixed(4)` at 60 Hz. It is a
  debugger occupying the instrument's display real estate, and it costs 32 DOM lookups and 32
  layout-touching writes per frame. Replace with a single small spectrum bar — one glanceable
  image, no numbers.
- **Number-key mode forcing as currently built** (`main.ts:307–318, 347–354`). It is a bank of
  0.2–0.4 Hz LFOs whose keys 1 and 2 are literally the same pitch (§0.5). The *idea* is right —
  the dissertation's ch.6 mode isolation and superposition are exactly this — but the
  implementation should be a continuous "which spatial scales am I exciting" control (a centre and
  a width over mode index), which is also what proposal 1's splat-radius gives you for free.
- **The strategy-cycling architecture** (`sonifier.ts:28–32, 94–129`). Hot-swap-with-full-dispose
  is an excellent A/B testing rig and a terrible instrument. Instruments do not have a button that
  discards the entire synthesis engine and builds a different one. Pick one sound world — the
  filter bank, which is the physically motivated one and the one 2017 argued for on
  subtractive-modes grounds [FLOOR.md §2] — and make its differences into *knobs* (harmonicity,
  Q floor, noise colour, an event-layer send). Keep the interface for development; remove the
  key binding.
- **Modal Percussion as a standalone strategy** (`modalPercussion.ts`). `FLOOR.md` §2 records that
  2017 rejected discrete events on audiovisual-congruence grounds and the ideas doc independently
  calls the result "dinky." Two independent arrivals at the same verdict is enough. Demote it to
  a *send* — an event layer riding on the continuous bed (idea F), with its own depth knob.
- **The second-person / second-device direction.** The brief raises it; I would not build it.
  Networked co-stirring of a fluid is a novelty that reads well in a paragraph and dilutes the
  instrument reading in practice: it forces you to design for a stranger's first thirty seconds,
  which is the exact opposite constraint from designing for hour ten. Keep multi-touch (one person,
  two hands, same screen). Drop the network.
- **`SONIFICATION_IDEAS` Phase 2** (Lanczos eigensolver, obstacle editor, NS rewrite). It is a
  multi-week engineering project whose payoff — a differently-shaped spectrum you can reshape
  live — is roughly 80% obtainable from proposal 4's twenty lines of frequency-map arithmetic.
  Build the knob, live with it for a month, and only then decide whether you need the solver.
  Note also `FLOOR.md` §5: the dissertation's author raised the objection that analytic
  eigenfunctions make motion "more regular" — the honest fix for regularity is feedback and
  gesture, not a bigger eigensolver.
- **Automatic narrative machinery** (phrase detection, entropy-as-tension, harmonic-rhythm
  extraction from the ideas doc). Every one of these is an attempt to have the *system* supply
  form. Give the form to the performer (proposals 3 and 5) and the problem dissolves. If the
  performer cannot make an arc with dynamics and a looper, no phrase detector will save it.

## Which artwork is this?

**A single-player instrument, distributed as a web page.** Not an installation, not a performance
tool, not a toy — though it should be buildable *into* all three afterwards.

The argument is about ordering, not preference. Instrument is the only one of the four target
forms from which the others fall out cheaply. An instrument can be put in a gallery by locking it
to a preset and removing the panel; it can be taken on stage by adding an audio interface and MIDI
(proposal 7 already); it can be shared as a link by shipping it as-is with a good first-run state.
The reverse is never true: a toy cannot be upgraded into an instrument later, because the
decisions that make something toy-shaped — immediate legibility, no failure modes, no learning
curve, no depth to reward returning — are the same decisions that cap its ceiling. This is why the
monome, the Reactable, and Push are still interesting a decade on while the enormous field of
generative audiovisual web toys is not: the former were designed for the tenth hour.

The dissertation's own wish list points the same way. "Free improvisation" and "the system
interacting back" are instrument words. "The audience participating" reads like an installation
brief, but note what it is contrasted *against* — "letting the experience wash over them." The
complaint is about passivity, and the cure for passivity is depth of engagement, which is
instrument-shaped. An installation solves passivity by lowering the barrier; an instrument solves
it by making the barrier worth climbing. Given that this system's whole claim on attention is that
a fluid's modal state is simultaneously an image and a sound — a genuinely deep object — lowering
the barrier is the wrong move.

**What that implies for everything else:**

- **Latency is a hard requirement, not a nice-to-have.** Target under 20 ms gesture-to-sound.
  Today it is ~45 ms to first audible change and there is 11 ms/frame of unused headroom, so this
  is achievable without architectural change (§0.3).
- **Continuous, eyes-free, multi-DOF control is mandatory** (proposals 1 and 7). Sliders you have
  to look at are for setup, not performance.
- **The first thirty seconds are allowed to be unrewarding.** This is permission, and it is the
  permission a toy never gets. It licenses the feedback threshold in proposal 2 being hard to find
  and the harmonicity morph's interesting zone being in the middle rather than at a preset.
- **There must be a session.** State that persists, recalls, layers, and undoes (proposal 5). An
  instrument you cannot save a good moment from does not accumulate practice.
- **The config panel is not the interface.** It is the workshop. Ship them as separate modes.
- **Monitoring matters.** Master limiting is non-optional the moment feedback exists, and the
  design should assume headphones and an audio interface, not laptop speakers.
- **Ship it as a URL anyway.** Being a web page is a genuine 2026 advantage the 2017 system did
  not have, and it costs nothing to let a stranger open it. Just do not let the stranger's first
  thirty seconds set the design.
