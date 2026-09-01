/**
 * Strategy E: Spectral Envelope on Carrier
 *
 * A harmonically-rich carrier (sawtooth) is filtered by a bank of bandpass
 * filters whose gains are driven by the w vector. The carrier guarantees
 * harmonicity (all partials are integer multiples of fundamental), while
 * the mode weights shape the resonance peaks—like vocal formant synthesis.
 *
 * The "mouth shape" of the fluid: carrier = vocal cords, w = tongue/lips.
 * Continuous output that matches the fluid's continuous visual flow.
 */

import type { SonificationStrategy } from '../strategy';
import { ModeAmplitudes } from '../amplitude';

const FUNDAMENTAL = 110;
const BASE_Q = 8;
const MAX_Q = 30;

export class SpectralEnvelopeStrategy implements SonificationStrategy {
  readonly name = 'Spectral Envelope';

  private ctx!: AudioContext;
  private carrier: OscillatorNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private gains: GainNode[] = [];
  private env: ModeAmplitudes = new ModeAmplitudes(0);

  init(ctx: AudioContext, master: GainNode, frequencies: number[], _eigenvalues: number[]): void {
    this.ctx = ctx;
    this.env = new ModeAmplitudes(frequencies.length);

    // Sawtooth carrier — rich harmonic content for the filters to shape
    this.carrier = ctx.createOscillator();
    this.carrier.type = 'sawtooth';
    this.carrier.frequency.value = FUNDAMENTAL;

    // One bandpass filter per eigenmode, positioned at the physical frequency.
    // The carrier's harmonics that fall near each filter's center frequency
    // get boosted or cut based on the mode's w coefficient.
    for (let k = 0; k < frequencies.length; k++) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequencies[k];
      filter.Q.value = BASE_Q;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      this.carrier.connect(filter);
      filter.connect(gain);
      gain.connect(master);

      this.filters.push(filter);
      this.gains.push(gain);
    }

    this.carrier.start();
  }

  update(w: Float64Array, rank: number): void {
    const now = this.ctx.currentTime;
    // L1 shape x absolute loudness. See ../amplitude.
    const loudness = this.env.update(w, rank, now, 1);

    for (let k = 0; k < rank; k++) {
      const shape = this.env.amps[k];

      // Q tracks how strongly this formant is being driven
      const q = BASE_Q + Math.min(1, shape * rank) * (MAX_Q - BASE_Q);
      this.filters[k].Q.setTargetAtTime(q, now, 0.03);

      const amplitude = shape * loudness * 0.6;
      this.gains[k].gain.setTargetAtTime(amplitude, now, this.env.timeConstant(k));
    }
  }

  dispose(): void {
    this.carrier?.stop();
    this.carrier?.disconnect();
    for (const f of this.filters) f.disconnect();
    for (const g of this.gains) g.disconnect();
    this.carrier = null;
    this.filters = [];
    this.gains = [];
  }
}
