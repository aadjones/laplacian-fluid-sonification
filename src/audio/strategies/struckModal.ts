/**
 * Strategy H: Struck Modal Bank — the hammer.
 *
 *   hammer burst ─┬─→ contact noise ("thunk") ──────────────→ master
 *                 └─→ per-partial: 2 detuned sines → pan → fluid mod → env → master
 *
 * Why this exists, when `filterBank` already had resonators and an envelope.
 *
 * The filter bank runs a *continuously looping* noise source into its
 * bandpasses forever, and lets the fluid move a gain downstream of the filter.
 * That is a bowed instrument wearing a struck instrument's costume, and it
 * fails in a specific, audible way: a noise-driven resonator has no phase
 * origin. Each partial becomes an independent narrowband noise process whose
 * amplitude wanders at random with correlation time τ ≈ Q/(πf) — about 0.7 s at
 * Q=240, f=110. Five harmonics warbling on five uncorrelated 0.7 s clocks do
 * not fuse into a note. They read as five whistles, which is exactly the "noisy
 * and not compelling" complaint. `filterBank.ts` even says so in its own
 * comment: "compensates for L1-normalised partials summing incoherently."
 *
 * Harmonic fusion needs a **common onset and a shared phase origin**. That is
 * what a hammer supplies and what steady noise cannot. So here every partial of
 * a strike starts at the same sample, in phase, and then rings down freely.
 *
 * Three things follow from that, and all three are what make it sound played
 * rather than generated:
 *
 *  1. **Contact time is the timbre knob.** A hammer cannot excite partials
 *     whose period is shorter than the time it stays in contact, so contact
 *     time acts as a lowpass on the excitation. Long and soft is a felt mallet;
 *     short and hard is a tine. This is the physical parameter a luthier
 *     actually moves (felt density, voicing needles), not an EQ after the fact.
 *  2. **Hard blows are brighter, not just louder.** Felt stiffens as it
 *     compresses, so contact shortens with velocity. This nonlinearity is a
 *     large part of why a real piano's forte is a different *sound* and not a
 *     scaled-up piano. `VELOCITY_BRIGHTEN`.
 *  3. **Two polarisations per partial.** A real string vibrates in two planes
 *     that are slightly detuned and decay at different rates; their beating is
 *     most of what separates a piano from an organ. This basis has the same
 *     handle for free — (i,j) and (j,i) are exactly degenerate, which REGISTER
 *     lists as an unused degree of freedom — so each partial is synthesised as
 *     a detuned pair panned apart.
 *
 * Where the fluid goes. It stops being the sound source and becomes the
 * modulator, which is the only honest job for it: `w` was measured to oscillate
 * at 0.017–0.167 Hz and to contain nothing in the audio band. A sub-Hz signal
 * is excellent at *shaping* a tone and hopeless at *being* one. So the strike
 * owns the note's onset and decay, and `w` colours the ring as energy cascades
 * out of the struck stack and sloshes back — the gong bloom, audible at last
 * because there is finally a coherent tone underneath it to bloom.
 */

import type { SonificationStrategy, ModePair } from '../strategy';

/** Hammer contact time at the extremes of `hardness`, in seconds. */
const CONTACT_SOFT = 3.2e-3;
const CONTACT_HARD = 0.35e-3;

/** How much a hard blow stiffens the felt and shortens contact. */
const VELOCITY_BRIGHTEN = 0.5;

/** Ring time of the lowest mode at unit viscosity, in seconds. */
const TAU_UNIT = 3.0;
const TAU_MIN = 0.05;
const TAU_MAX = 24;

/**
 * τ_k ∝ λ_k^-slope. The viscous law is exactly 1, which on this basis means
 * τ ∝ 1/n² across a family — correct, but it kills the top of the stack fast
 * enough to sound like a woodblock. 0.75 keeps the bright→dark ordering while
 * letting the upper partials survive long enough to be heard as timbre.
 */
const DAMPING_SLOPE = 0.75;

/** Detune between a partial's two polarisation planes, in cents. */
const DETUNE_CENTS = 3.4;

/**
 * Double decay: the two planes ring for different lengths of time.
 *
 * A string's vertical plane is the one the hammer drives and the one coupled
 * most strongly to the bridge, so it dumps its energy into the body quickly.
 * The horizontal plane is driven less and radiates less, so it rings on after
 * the first has gone. What a listener hears is a fast, loud *prompt sound*
 * followed by a quiet, long *aftersound* — a two-slope decay rather than one
 * exponential. It is one of the most recognisable things about a piano, and a
 * single-exponential partial is exactly what makes cheap digital pianos sound
 * like organs. Two envelopes on one detuned pair is the whole trick.
 */
const PLANE_FAST = 0.5;
const PLANE_SLOW = 1.7;
/** Share of the partial the hammer puts into the fast plane. */
const PLANE_SPLIT = 0.62;

/**
 * Nothing acoustic repeats exactly.
 *
 * The felt meets the string at a slightly different angle every time, so
 * contact time, partial balance and the detune between planes all wander a few
 * percent per note. Without this, repeated strikes are bit-identical and the
 * ear hears a sampler triggering one sample, which is a far stronger cue of
 * "machine" than any amount of spectral detail can undo.
 */
const JITTER = 0.07;

/** A multiplier uniform in [1-amount, 1+amount]. */
function jitter(amount: number): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

/** Attack ramp. Long enough to avoid a DC click, short enough to read as a hit. */
const ATTACK = 0.0015;

/** Contact noise: the non-modal thud of hammer meeting body. */
const THUNK_DURATION = 0.014;
const THUNK_LEVEL = 0.55;

/**
 * A sustained note is held, not struck, and it is tonal, not noisy.
 *
 * Sustain used to sound through the bow — noise into resonators — which is the
 * mechanism that cannot fuse partials into a note, for the same reason the
 * original filter bank could not. It also took its level from `w`, so every
 * stack sustained in turn piled more energy into the fluid and the held tone
 * grew louder and broader until it swamped everything. Holding coherent
 * partials instead fixes both: the sound is a note rather than a band of noise,
 * and its level is set by the gesture rather than by however much energy has
 * accumulated in the simulation.
 */
const SUSTAIN_ATTACK = 0.045;
const SUSTAIN_RELEASE = 0.16;
/**
 * Peak of a held note, deliberately under a strike's.
 *
 * A sustained tone sits near its peak the whole time it sounds; a strike is at
 * its peak for a few milliseconds and below it thereafter. Matched on peak they
 * are badly mismatched by ear, so the held note is backed off.
 */
const SUSTAIN_SCALE = 0.85;

/** Live oscillator pairs. Each costs 6 nodes; strikes overlap by design. */
const MAX_PARTIALS = 96;

/**
 * Peak amplitude of a full-velocity strike, before master gain.
 *
 * Calibrated by measurement, not taste: with the 0.3 master fader this puts a
 * hard single strike near -4 dBFS at the output and a three-stack chord into
 * the saturator, which is where a struck instrument wants to sit.
 */
const OUTPUT_SCALE = 2.3;

/** How far the fluid may dim or swell a ringing partial. */
const MOD_FLOOR = 0.45;
const MOD_CEIL = 1.5;
const MOD_TC = 0.09;

/**
 * The same, much narrower, for a *held* partial.
 *
 * A struck partial's reference is |w| just after the strike, and the modulation
 * reading it downward is the note colouring outward, which is the point. A held
 * partial has no such moment: its reference is whatever |w| happened to be on
 * the first frame, and the fluid then relaxes toward the sustain target, so the
 * measured share falls and the modulation quietly halves the note over a couple
 * of seconds. A held note has to hold. It may breathe; it may not fade.
 */
const MOD_HELD_FLOOR = 0.82;
const MOD_HELD_CEIL = 1.2;

/** Stereo spread: across the stack by mode index, and across each partial's pair. */
const SPREAD_STACK = 0.25;
const SPREAD_POLARISATION = 0.45;

interface Partial {
  mode: number;
  mod: GainNode;
  /** |w| at the first frame after the strike; the modulation is relative to it. */
  refW: number;
  nodes: AudioNode[];
  /** Held partials ring until released, rather than decaying on their own. */
  env?: GainNode;
  held?: boolean;
}

export class StruckModalStrategy implements SonificationStrategy {
  readonly name = 'Struck Modal';

  private ctx!: AudioContext;
  private master!: GainNode;
  private frequencies: number[] = [];
  private eigenvalues: number[] = [];
  private pairs: ModePair[] = [];

  private thunkBuffer: AudioBuffer | null = null;
  private partials: Partial[] = [];

  private lamMin = 1;
  private maxK1 = 1;
  private viscosity = 0.5;

  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[], pairs: ModePair[]): void {
    this.ctx = ctx;
    this.master = master;
    this.frequencies = frequencies;
    this.eigenvalues = eigenvalues;
    this.pairs = pairs;
    this.partials = [];

    this.lamMin = eigenvalues.length ? Math.min(...eigenvalues) : 1;
    this.maxK1 = 1;
    for (const p of pairs) if (p.k1 > this.maxK1) this.maxK1 = p.k1;

    // One shaped noise burst, reused by every strike. The envelope is baked in
    // so a strike only needs to allocate a source and a filter.
    const n = Math.max(1, Math.floor(ctx.sampleRate * THUNK_DURATION));
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const attackSamples = Math.max(1, Math.floor(ctx.sampleRate * 0.0002));
    const decaySamples = n / 4;
    for (let i = 0; i < n; i++) {
      const rise = i < attackSamples ? i / attackSamples : 1;
      data[i] = (Math.random() * 2 - 1) * rise * Math.exp(-i / decaySamples);
    }
    this.thunkBuffer = buffer;
  }

  /**
   * Viscosity is the damper pedal.
   *
   * A mode decays at ν·λ, so its ring time is 1/(ν·λ): the same slider that
   * thickens the fluid shortens every note, and the ordering across the stack
   * is preserved. `TAU_UNIT` only sets where that lands in musical time, since
   * the sim advances 0.012 s of sim time per wall second and the raw viscous
   * ring time of the lowest mode is over a minute.
   */
  setDamping(viscosity: number): void {
    this.viscosity = viscosity;
  }

  private ringTime(k: number): number {
    const base = TAU_UNIT / Math.max(this.viscosity, 0.05);
    const tau = base * Math.pow(this.lamMin / this.eigenvalues[k], DAMPING_SLOPE);
    return Math.min(TAU_MAX, Math.max(TAU_MIN, tau));
  }

  strike(weights: Float64Array, velocity: number, hardness: number): void {
    if (!this.thunkBuffer) return;
    const now = this.ctx.currentTime;
    const vel = Math.min(1, Math.max(0, velocity));

    // Felt stiffens under a hard blow, so contact shortens and the strike
    // brightens. Without this every dynamic level is the same sound, louder.
    const effective = Math.min(1, hardness + VELOCITY_BRIGHTEN * hardness * (vel - 0.5));
    const contact = (CONTACT_SOFT + (CONTACT_HARD - CONTACT_SOFT) * Math.max(0, effective))
      * jitter(JITTER);
    // A force pulse of width T rolls off above ~1/T. Two-pole, so partials an
    // octave above the corner arrive 12 dB down rather than being erased.
    const corner = 1 / contact;

    // Strongest partials first, so hitting the voice cap drops the quiet top of
    // the stack rather than refusing the fundamental.
    const struck: number[] = [];
    for (let k = 0; k < weights.length; k++) if (weights[k] > 1e-6) struck.push(k);
    struck.sort((a, b) => weights[b] - weights[a]);

    // Normalise by the L2 norm, not L1.
    //
    // Partials at different frequencies sum in power, not in amplitude, so
    // dividing by the sum of amplitudes makes a rich stack far quieter than a
    // sparse one rather than equally loud — and the strike-point notch, which
    // removes amplitude from the numerator, quietly became a volume control on
    // top of being a timbre control. L2 is the norm that holds perceived
    // loudness steady as harmonics are added or notched out.
    let l2 = 0;
    for (const k of struck) l2 += weights[k] * weights[k];
    l2 = Math.sqrt(l2);
    if (l2 <= 0) return;

    this.fireThunk(now, vel, corner);

    for (const k of struck) {
      if (this.partials.length >= MAX_PARTIALS) break;
      const freq = this.frequencies[k];
      if (!(freq > 0) || freq > this.ctx.sampleRate * 0.45) continue;

      const rolloff = 1 / (1 + Math.pow(freq / corner, 2));
      const amp = (weights[k] / l2) * rolloff * vel * OUTPUT_SCALE * jitter(JITTER * 0.8);
      if (amp < 1e-5) continue;

      this.firePartial(k, freq, amp, now);
    }
  }

  /**
   * Hold a set of modes as a sustained tone, or release with `level` of 0.
   *
   * Event-driven like `strike`, not polled: it is called when the gesture
   * changes, so switching stacks mid-sustain releases the old note and
   * articulates the new one rather than layering them.
   */
  sustain(weights: Float64Array | null, level: number, hardness: number): void {
    this.releaseHeld();
    if (!weights || level <= 0) return;

    const now = this.ctx.currentTime;
    const lvl = Math.min(1, Math.max(0, level));

    const struck: number[] = [];
    for (let k = 0; k < weights.length; k++) if (weights[k] > 1e-6) struck.push(k);
    struck.sort((a, b) => weights[b] - weights[a]);
    let l2 = 0;
    for (const k of struck) l2 += weights[k] * weights[k];
    l2 = Math.sqrt(l2);
    if (l2 <= 0) return;

    // The bow's spectral character comes from the same contact model, so the
    // hardness slider means one thing across both gestures.
    const contact = CONTACT_SOFT + (CONTACT_HARD - CONTACT_SOFT) * Math.max(0, hardness);
    const corner = 1 / contact;

    for (const k of struck) {
      if (this.partials.length >= MAX_PARTIALS) break;
      const freq = this.frequencies[k];
      if (!(freq > 0) || freq > this.ctx.sampleRate * 0.45) continue;

      const rolloff = 1 / (1 + Math.pow(freq / corner, 2));
      const amp = (weights[k] / l2) * rolloff * lvl * SUSTAIN_SCALE;
      if (amp < 1e-5) continue;

      this.holdPartial(k, freq, amp, now);
    }
  }

  /** Damp whatever is being held, the way a damper meets a string. */
  private releaseHeld(): void {
    const now = this.ctx.currentTime;
    for (const p of this.partials) {
      if (!p.held || !p.env) continue;
      p.held = false;
      p.env.gain.cancelScheduledValues(now);
      p.env.gain.setTargetAtTime(0, now, SUSTAIN_RELEASE / 3);
      for (const nd of p.nodes) {
        if (nd instanceof OscillatorNode) {
          try { nd.stop(now + SUSTAIN_RELEASE); } catch { /* already stopped */ }
        }
      }
    }
  }

  private holdPartial(k: number, freq: number, amp: number, now: number): void {
    const mod = this.ctx.createGain();
    mod.gain.value = 1;
    mod.connect(this.master);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(amp, now + SUSTAIN_ATTACK);
    env.connect(mod);

    const basePan = this.maxK1 > 1
      ? (((this.pairs[k]?.k1 ?? 1) - 1) / (this.maxK1 - 1)) * 2 - 1
      : 0;
    const nodes: AudioNode[] = [mod, env];
    const ratio = Math.pow(2, (DETUNE_CENTS * jitter(0.3)) / 2 / 1200);
    let last: OscillatorNode | null = null;

    for (const side of [-1, 1]) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1,
        basePan * SPREAD_STACK + side * SPREAD_POLARISATION,
      ));
      const half = this.ctx.createGain();
      half.gain.value = 0.5;
      pan.connect(half);
      half.connect(env);

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = side < 0 ? freq / ratio : freq * ratio;
      osc.connect(pan);
      osc.start(now);
      nodes.push(osc, pan, half);
      last = osc;
    }

    const partial: Partial = { mode: k, mod, refW: -1, nodes, env, held: true };
    if (last) {
      last.onended = () => {
        for (const nd of nodes) nd.disconnect();
        const i = this.partials.indexOf(partial);
        if (i >= 0) this.partials.splice(i, 1);
      };
    }
    this.partials.push(partial);
  }

  private fireThunk(now: number, velocity: number, corner: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.thunkBuffer;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(corner, this.ctx.sampleRate * 0.45);
    lp.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.value = THUNK_LEVEL * velocity * velocity;

    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.onended = () => {
      src.disconnect();
      lp.disconnect();
      gain.disconnect();
    };
  }

  private firePartial(k: number, freq: number, amp: number, now: number): void {
    const tau = this.ringTime(k);

    // One modulation gain for the whole partial: the fluid colours a partial,
    // not one of its polarisation planes.
    const mod = this.ctx.createGain();
    mod.gain.value = 1;
    mod.connect(this.master);

    const basePan = this.maxK1 > 1
      ? (((this.pairs[k]?.k1 ?? 1) - 1) / (this.maxK1 - 1)) * 2 - 1
      : 0;

    const nodes: AudioNode[] = [mod];
    const ratio = Math.pow(2, (DETUNE_CENTS * jitter(0.3)) / 2 / 1200);

    let longest = 0;
    let tail: OscillatorNode | null = null;

    for (const side of [-1, 1]) {
      const fast = side < 0;
      const planeTau = tau * (fast ? PLANE_FAST : PLANE_SLOW);
      const planeAmp = amp * (fast ? PLANE_SPLIT : 1 - PLANE_SPLIT);
      // -60 dB is 6.9 time constants. Capped so a long low ring does not hold
      // an oscillator alive for minutes after it stopped being audible.
      const duration = Math.min(planeTau * 6.9, TAU_MAX);

      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(planeAmp, now + ATTACK);
      env.gain.exponentialRampToValueAtTime(
        Math.max(planeAmp * 0.001, 1e-6),
        now + ATTACK + duration,
      );
      env.connect(mod);

      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1,
        basePan * SPREAD_STACK + side * SPREAD_POLARISATION,
      ));
      pan.connect(env);

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = fast ? freq / ratio : freq * ratio;
      osc.connect(pan);
      osc.start(now);
      osc.stop(now + ATTACK + duration + 0.02);

      nodes.push(osc, pan, env);
      if (duration > longest) {
        longest = duration;
        tail = osc;
      }
    }

    if (tail) {
      tail.onended = () => {
        for (const nd of nodes) nd.disconnect();
        const i = this.partials.findIndex((p) => p.mod === mod);
        if (i >= 0) this.partials.splice(i, 1);
      };
    }

    this.partials.push({ mode: k, mod, refW: -1, nodes });
  }

  /**
   * The fluid colours what is already ringing.
   *
   * A struck stack is only approximately invariant under advection: measured
   * in-family enstrophy runs 99.9% at 0.1 s and settles around 66–86% over
   * several seconds, sloshing back rather than draining away. Reading that
   * redistribution onto each live partial is the audible form of that
   * measurement — the note holds its identity and breathes.
   *
   * The modulation is bounded well away from zero. The fluid may not silence a
   * note it did not strike; the envelope owns the decay.
   */
  update(w: Float64Array, rank: number): void {
    if (this.partials.length === 0) return;
    const now = this.ctx.currentTime;

    for (const p of this.partials) {
      if (p.mode >= rank) continue;
      const a = Math.abs(w[p.mode]);
      if (p.refW < 0) {
        p.refW = Math.max(a, 1e-9);
        continue;
      }
      const floor = p.held ? MOD_HELD_FLOOR : MOD_FLOOR;
      const ceil = p.held ? MOD_HELD_CEIL : MOD_CEIL;
      const share = Math.min(ceil, a / p.refW);
      p.mod.gain.setTargetAtTime(floor + (1 - floor) * share, now, MOD_TC);
    }
  }

  dispose(): void {
    for (const p of this.partials) {
      p.held = false;
      for (const nd of p.nodes) {
        if (nd instanceof OscillatorNode) {
          try { nd.stop(); } catch { /* already stopped */ }
        }
        nd.disconnect();
      }
    }
    this.partials = [];
    this.thunkBuffer = null;
  }
}
