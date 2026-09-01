/**
 * Strategy G: Resonant Filter Bank.
 *
 * Noise source -> N parallel bandpass filters -> per-mode panner -> gain -> master.
 *
 * The envelope is taken from the fluid rather than imposed on it. Under the
 * sqrt-lambda mapping each mode is a resonator whose amplitude |w[k]| already
 * decays viscously at rate nu*lambda, so high modes die away in seconds while low
 * modes ring for a minute. Reading that out with an absolute (not per-frame
 * normalised) gain is what gives a strike its attack and its bright->dark decay.
 */

import type { SonificationStrategy, ModePair } from '../strategy';
import { ModeAmplitudes } from '../amplitude';

const NOISE_DURATION = 2;

/** Q of the lowest mode. Higher modes are damped by the 1/sqrt(lambda) law below. */
const Q_BASE = 240;
const Q_MIN = 8;
const Q_MAX = 400;

/** Compensates for L1-normalised partials summing incoherently. */
const OUTPUT_SCALE = 2.5;

export class FilterBankStrategy implements SonificationStrategy {
  readonly name = 'Filter Bank';

  private ctx!: AudioContext;
  private noiseSource: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private panners: StereoPannerNode[] = [];
  private gains: GainNode[] = [];

  private env: ModeAmplitudes = new ModeAmplitudes(0);

  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[], pairs: ModePair[]): void {
    this.ctx = ctx;
    this.env = new ModeAmplitudes(frequencies.length);

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

      const panner = ctx.createStereoPanner();
      const pan = maxK1 > 1 ? ((pairs[k].k1 - 1) / (maxK1 - 1)) * 2 - 1 : 0;
      panner.pan.value = pan * 0.8;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      this.noiseSource.connect(filter);
      filter.connect(panner);
      panner.connect(gain);
      gain.connect(master);

      this.filters.push(filter);
      this.panners.push(panner);
      this.gains.push(gain);
    }

    this.noiseSource.start();
  }

  update(w: Float64Array, rank: number): void {
    const now = this.ctx.currentTime;
    this.env.update(w, rank, now, OUTPUT_SCALE);
    for (let k = 0; k < rank; k++) {
      this.gains[k].gain.setTargetAtTime(this.env.amps[k], now, this.env.timeConstant(k));
    }
  }

  dispose(): void {
    this.noiseSource?.stop();
    this.noiseSource?.disconnect();
    for (const f of this.filters) f.disconnect();
    for (const p of this.panners) p.disconnect();
    for (const g of this.gains) g.disconnect();
    this.noiseSource = null;
    this.filters = [];
    this.panners = [];
    this.gains = [];
  }
}
