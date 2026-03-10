/**
 * Strategy G: Resonant Filter Bank (original approach)
 *
 * Noise source → N parallel bandpass filters → gain nodes → master.
 * Mode weights control filter Q (resonance sharpness) and output gain.
 * Physically motivated: "what would this cavity sound like if excited."
 *
 * Known issue: 32 inharmonic partials played simultaneously = noise.
 * Kept as baseline for A/B comparison.
 */

import type { SonificationStrategy } from '../strategy';

const NOISE_DURATION = 2;
const BASE_Q = 15;
const MAX_Q = 80;

export class FilterBankStrategy implements SonificationStrategy {
  readonly name = 'Filter Bank';

  private ctx!: AudioContext;
  private noiseSource: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private gains: GainNode[] = [];

  init(ctx: AudioContext, master: GainNode, frequencies: number[], _eigenvalues: number[]): void {
    this.ctx = ctx;

    // Create white noise buffer
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

    for (let k = 0; k < frequencies.length; k++) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequencies[k];
      filter.Q.value = BASE_Q;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      this.noiseSource.connect(filter);
      filter.connect(gain);
      gain.connect(master);

      this.filters.push(filter);
      this.gains.push(gain);
    }

    this.noiseSource.start();
  }

  update(w: Float64Array, rank: number): void {
    let maxW = 0;
    for (let k = 0; k < rank; k++) maxW = Math.max(maxW, Math.abs(w[k]));
    if (maxW < 1e-15) maxW = 1;

    const now = this.ctx.currentTime;

    for (let k = 0; k < rank; k++) {
      const activity = Math.abs(w[k]) / maxW;
      const q = BASE_Q + activity * (MAX_Q - BASE_Q);
      this.filters[k].Q.setTargetAtTime(q, now, 0.03);
      const amplitude = activity * activity;
      this.gains[k].gain.setTargetAtTime(amplitude, now, 0.03);
    }
  }

  dispose(): void {
    this.noiseSource?.stop();
    this.noiseSource?.disconnect();
    for (const f of this.filters) f.disconnect();
    for (const g of this.gains) g.disconnect();
    this.noiseSource = null;
    this.filters = [];
    this.gains = [];
  }
}
