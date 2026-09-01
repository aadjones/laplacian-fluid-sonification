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

import type { SonificationStrategy, ModePair } from '../strategy';
import { ModeAmplitudes } from '../amplitude';

const FUNDAMENTAL = 110; // A2

/** Highest partial worth synthesising. Above this it is inaudible anyway. */
const CEILING_HZ = 18000;

export class HarmonicSeriesStrategy implements SonificationStrategy {
  readonly name = 'Harmonic Series';

  private ctx!: AudioContext;
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private env: ModeAmplitudes = new ModeAmplitudes(0);
  /** Partials actually synthesised: those below the audible ceiling. */
  private voiceCount = 0;

  init(ctx: AudioContext, master: GainNode, frequencies: number[], _eigenvalues: number[], _pairs: ModePair[]): void {
    this.ctx = ctx;

    const rank = frequencies.length;
    this.env = new ModeAmplitudes(rank);

    // Mode k becomes harmonic (k+1), so the partial for the top mode is
    // FUNDAMENTAL * rank -- 28160 Hz at rank 256, well past both Nyquist and
    // hearing. Only build the partials that land in the audible band; the rest
    // would just be clamped oscillators burning CPU.
    const ceiling = Math.min(CEILING_HZ, ctx.sampleRate * 0.45);
    this.voiceCount = Math.max(1, Math.min(rank, Math.floor(ceiling / FUNDAMENTAL)));

    for (let k = 0; k < this.voiceCount; k++) {
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
    const now = this.ctx.currentTime;
    // L1 shape x absolute loudness, so the spectrum can swell and decay rather
    // than sitting at a fixed level. See ../amplitude.
    this.env.update(w, rank, now, 0.5);

    const n = Math.min(rank, this.voiceCount);
    for (let k = 0; k < n; k++) {
      // Natural rolloff: higher harmonics quieter (1/k on top of the shape)
      const amplitude = this.env.amps[k] / (k + 1);
      this.gains[k].gain.setTargetAtTime(amplitude, now, this.env.timeConstant(k));
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
