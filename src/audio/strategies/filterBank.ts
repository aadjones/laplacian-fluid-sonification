/**
 * Strategy G: Resonant Filter Bank — the bow.
 *
 * noise -> bow gain -> N parallel bandpass filters -> panner -> gain -> master
 *
 * This is a *continuously excited* instrument and it should be honest about
 * that. Noise into a bandpass has no phase origin, so its partials cannot fuse
 * into a struck note however the output gain is shaped; see `struckModal.ts`
 * for that half of the instrument. What noise excitation is genuinely good at
 * is the sound of a body being driven — bowed, blown, scraped — and that is
 * what this strategy is for.
 *
 * The one thing it got badly wrong was running the noise source on `loop =
 * true` for the lifetime of the strategy. A bow that never leaves the string
 * is a drone, and a drone under an amplitude envelope is the wash this
 * instrument was criticised for. The excitation now tracks how hard the fluid
 * is being driven — the L1 rate of change of w — so the bank is silent at rest,
 * sings while you stir, and murmurs as the flow evolves on its own.
 *
 * The envelope is still taken from the fluid rather than imposed on it. Under
 * the sqrt-lambda mapping each mode is a resonator whose amplitude |w[k]|
 * already decays viscously at rate nu*lambda, so high modes die away in seconds
 * while low modes ring for a minute.
 */

import type { SonificationStrategy, ModePair } from '../strategy';
import { ModeAmplitudes, PeakTracker } from '../amplitude';

const NOISE_DURATION = 2;

/** Q of the lowest mode. Higher modes are damped by the 1/sqrt(lambda) law below. */
const Q_BASE = 240;
const Q_MIN = 8;
const Q_MAX = 400;

/** Compensates for L1-normalised partials summing incoherently. */
const OUTPUT_SCALE = 2.5;

/**
 * Bow pressure follows the fluid's rate of change, not its state.
 *
 * What excites a body is energy going in, so the right control signal is how
 * fast w is moving rather than how large it is. Stirring drives it hard; free
 * evolution drives it lightly; a still fluid drives it not at all.
 */
const BOW_ATTACK_TC = 0.02;
const BOW_RELEASE_TC = 0.35;
/** Above 1, so the bow leaves the string decisively instead of fading forever. */
const BOW_CURVE = 1.6;

/**
 * Makeup gain for what a high-Q bandpass does to white noise.
 *
 * A resonator only passes the noise inside its own bandwidth, f/Q. At Q=240
 * and 110 Hz that is 0.46 Hz out of a 24 kHz spectrum — a power ratio of about
 * 2e-5, so the mode comes out around 45 dB below the noise going in. Summed
 * over the whole rank that is merely quiet; with a stack soloed, eight narrow
 * bands is inaudible, which made soloing — the one gesture that gives this
 * instrument pitch — switch the bow off. Noise power through the filter goes
 * as f/Q, so the compensation is sqrt(Q/f), which on this bank reduces to
 * sqrt(lambda_min/lambda): the low modes are the narrow ones and need the most
 * help. `BOW_MAKEUP` then sets the absolute level, and is measured.
 */
const BOW_MAKEUP = 34;
/** Frames can be 16 ms or 33 ms; a rate must not depend on which. */
const MIN_FRAME = 1 / 240;

/**
 * Floor on the norm the bow's rate is measured against.
 *
 * Bow pressure is the *fractional* rate of change of w, |dw|/|w| per second,
 * not the absolute one. That is what makes it invariant to how many modes the
 * mask is letting through: the same stir reads the same whether 576 modes are
 * sounding or eight, so soloing a stack needs no re-reference and cannot
 * produce a step. The floor stops a near-empty fluid, where |w| and |dw| are
 * both nearly zero, from dividing its way to a large number.
 */
const DRIVE_NORM_FLOOR = 1;


export class FilterBankStrategy implements SonificationStrategy {
  readonly name = 'Filter Bank';

  private ctx!: AudioContext;
  private noiseSource: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private panners: StereoPannerNode[] = [];
  private gains: GainNode[] = [];

  private env: ModeAmplitudes = new ModeAmplitudes(0);

  private exciteGain: GainNode | null = null;
  private wPrev: Float64Array = new Float64Array(0);
  private drive = new PeakTracker();
  private bow = 0;
  private lastFrameTime = 0;
  private primed = false;
  /** Per-mode compensation for the resonator's noise bandwidth. */
  private comp: Float64Array = new Float64Array(0);

  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[], pairs: ModePair[]): void {
    this.ctx = ctx;
    this.env = new ModeAmplitudes(frequencies.length);
    this.wPrev = new Float64Array(frequencies.length);
    this.drive.reset();
    this.bow = 0;
    this.lastFrameTime = 0;
    this.primed = false;
    this.comp = new Float64Array(frequencies.length);

    const sampleRate = ctx.sampleRate;
    const bufferSize = sampleRate * NOISE_DURATION;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;

    this.exciteGain = ctx.createGain();
    this.exciteGain.gain.value = 0;
    this.noiseSource.connect(this.exciteGain);

    let maxK1 = 1;
    for (const p of pairs) {
      if (p.k1 > maxK1) maxK1 = p.k1;
    }
    const lamMin = Math.min(...eigenvalues);

    for (let k = 0; k < frequencies.length; k++) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequencies[k];
      // Q is a property of the resonator, not of the excitation, so it is set
      // once. A mode decays at nu*lambda and sits at f ~ sqrt(lambda), so its
      // quality factor goes as f/(nu*lambda) ~ 1/sqrt(lambda): low modes ring
      // sharp and long, high modes are broad and damped. That ordering is the
      // struck-bell law. The previous 200-2000 activity ramp had no physical
      // referent and gave the bottom of the bank an 11.6 s tail, which is what
      // smeared everything into mud.
      filter.Q.value = Math.max(Q_MIN, Math.min(Q_MAX, Q_BASE / Math.sqrt(eigenvalues[k] / lamMin)));
      // sqrt(Q/f), normalised to the lowest mode. Read off the clamped Q so the
      // compensation still matches at the ends of the bank, where Q_MIN and
      // Q_MAX have overridden the 1/sqrt(lambda) law.
      this.comp[k] = BOW_MAKEUP * Math.sqrt(
        (filter.Q.value / frequencies[k]) / (Q_BASE / frequencies[0]),
      );

      const panner = ctx.createStereoPanner();
      const pan = maxK1 > 1 ? ((pairs[k].k1 - 1) / (maxK1 - 1)) * 2 - 1 : 0;
      panner.pan.value = pan * 0.8;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      this.exciteGain.connect(filter);
      filter.connect(panner);
      panner.connect(gain);
      gain.connect(master);

      this.filters.push(filter);
      this.panners.push(panner);
      this.gains.push(gain);
    }

    this.noiseSource.start();
  }

  resetLevel(): void {
    this.env.resetLevel();
    // Re-prime: the first frame under a new mask differences a masked w against
    // an unmasked one, which is a step change, not a gesture. The drive tracker
    // is deliberately left alone — its input is a fractional rate and so
    // survives the change, and resetting it was what made every stack switch
    // read the next tiny delta as full bow pressure and crash.
    this.primed = false;
  }

  update(w: Float64Array, rank: number): void {
    const now = this.ctx.currentTime;

    // Bow pressure from the L1 rate of change of w, referenced to the hardest
    // gesture so far so a gentle swirl and a violent stir differ in level.
    // Divided by elapsed time, because the same gesture must not bow harder
    // just because the frame rate dropped and each frame's delta got bigger.
    let delta = 0;
    let l1 = 0;
    for (let k = 0; k < rank; k++) {
      delta += Math.abs(w[k] - this.wPrev[k]);
      l1 += Math.abs(w[k]);
      this.wPrev[k] = w[k];
    }
    const elapsed = Math.max(MIN_FRAME, now - this.lastFrameTime);
    this.lastFrameTime = now;

    // The first frame after init has no previous w to difference against, so
    // `delta` is the L1 norm of the whole state rather than one frame's change
    // — thousands, over a frame time, against a peak tracker that then holds
    // that reference for 90 s. Every real gesture afterwards measures as
    // essentially zero and the bank never speaks again. Swapping to this
    // strategy mid-flow is exactly when that happens, so prime and skip.
    if (!this.primed) {
      this.primed = true;
      this.env.update(w, rank, now, OUTPUT_SCALE);
      return;
    }

    const rate = delta / Math.max(l1, DRIVE_NORM_FLOOR) / elapsed;
    const target = Math.pow(this.drive.update(rate, now), BOW_CURVE);
    if (this.exciteGain) {
      const tc = target > this.bow ? BOW_ATTACK_TC : BOW_RELEASE_TC;
      this.exciteGain.gain.setTargetAtTime(target, now, tc);
    }
    this.bow = target;

    this.env.update(w, rank, now, OUTPUT_SCALE);
    for (let k = 0; k < rank; k++) {
      const tc = this.env.timeConstant(k);
      if (this.env.needsUpdate(k)) {
        this.gains[k].gain.setTargetAtTime(this.env.amps[k] * this.comp[k], now, tc);
      }
    }
  }

  dispose(): void {
    this.noiseSource?.stop();
    this.noiseSource?.disconnect();
    this.exciteGain?.disconnect();
    this.exciteGain = null;
    for (const f of this.filters) f.disconnect();
    for (const p of this.panners) p.disconnect();
    for (const g of this.gains) g.disconnect();
    this.noiseSource = null;
    this.filters = [];
    this.panners = [];
    this.gains = [];
  }
}
