/**
 * Strategy A: Harmonic Series Reinterpretation
 *
 * Maps mode k → harmonic (k+1) of a single fundamental.
 * The w vector becomes the Fourier amplitude spectrum of one evolving timbre.
 * All partials are integer multiples of the fundamental, so they fuse into
 * a single pitched percept whose color shifts as the fluid evolves.
 *
 * This completely ignores the physical eigenvalue→frequency mapping in favor
 * of guaranteed harmonicity.
 */

import type { SonificationStrategy } from '../strategy';

const FUNDAMENTAL = 110; // A2

export class HarmonicSeriesStrategy implements SonificationStrategy {
  readonly name = 'Harmonic Series';

  private ctx!: AudioContext;
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];

  init(ctx: AudioContext, master: GainNode, frequencies: number[], _eigenvalues: number[]): void {
    this.ctx = ctx;

    const rank = frequencies.length;

    for (let k = 0; k < rank; k++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // Harmonic (k+1) of the fundamental — NOT the eigenvalue frequency
      osc.frequency.value = FUNDAMENTAL * (k + 1);

      const gain = ctx.createGain();
      gain.gain.value = 0;

      osc.connect(gain);
      gain.connect(master);
      osc.start();

      this.oscillators.push(osc);
      this.gains.push(gain);
    }
  }

  update(w: Float64Array, rank: number): void {
    let maxW = 0;
    for (let k = 0; k < rank; k++) maxW = Math.max(maxW, Math.abs(w[k]));
    if (maxW < 1e-15) maxW = 1;

    const now = this.ctx.currentTime;

    for (let k = 0; k < rank; k++) {
      const activity = Math.abs(w[k]) / maxW;
      // Natural rolloff: higher harmonics quieter (1/k weighting on top of activity)
      const harmonicWeight = 1.0 / (k + 1);
      const amplitude = activity * harmonicWeight * 0.5;
      this.gains[k].gain.setTargetAtTime(amplitude, now, 0.03);
    }
  }

  dispose(): void {
    for (const osc of this.oscillators) {
      osc.stop();
      osc.disconnect();
    }
    for (const g of this.gains) g.disconnect();
    this.oscillators = [];
    this.gains = [];
  }
}
