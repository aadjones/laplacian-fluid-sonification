/**
 * Strategy G: Resonant Filter Bank with spatial panning and cascade dynamics.
 *
 * Noise source → N parallel bandpass filters → per-mode panner → gain → master.
 * Mode weights control filter Q and gain. Spatial panning from mode k₁ index.
 * Cascade dynamics: spectral centroid tracking modulates overall brightness
 * to exaggerate the natural attack→decay arc of energy redistribution.
 */

import type { SonificationStrategy, ModePair } from '../strategy';

const NOISE_DURATION = 2;
const BASE_Q = 200;
const MAX_Q = 2000;

export class FilterBankStrategy implements SonificationStrategy {
  readonly name = 'Filter Bank';

  private ctx!: AudioContext;
  private noiseSource: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private panners: StereoPannerNode[] = [];
  private gains: GainNode[] = [];
  private cascadeGain: GainNode | null = null;

  // Cascade dynamics state
  private prevCentroid = 0;
  private prevEnergy = 0;

  init(ctx: AudioContext, master: GainNode, frequencies: number[], _eigenvalues: number[], pairs: ModePair[]): void {
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

    // Cascade dynamics: overall gain envelope that exaggerates energy changes
    this.cascadeGain = ctx.createGain();
    this.cascadeGain.gain.value = 1;
    this.cascadeGain.connect(master);

    // Find max k1 for panning normalization
    let maxK1 = 1;
    for (const p of pairs) {
      if (p.k1 > maxK1) maxK1 = p.k1;
    }

    for (let k = 0; k < frequencies.length; k++) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequencies[k];
      filter.Q.value = BASE_Q;

      // Spatial panning from k₁: low k₁ = left, high k₁ = right
      const panner = ctx.createStereoPanner();
      const pan = (pairs[k].k1 - 1) / (maxK1 - 1) * 2 - 1; // -1 to +1
      panner.pan.value = pan * 0.8; // Don't hard-pan to extremes

      const gain = ctx.createGain();
      gain.gain.value = 0;

      this.noiseSource.connect(filter);
      filter.connect(panner);
      panner.connect(gain);
      gain.connect(this.cascadeGain);

      this.filters.push(filter);
      this.panners.push(panner);
      this.gains.push(gain);
    }

    this.noiseSource.start();
  }

  update(w: Float64Array, rank: number): void {
    let maxW = 0;
    for (let k = 0; k < rank; k++) maxW = Math.max(maxW, Math.abs(w[k]));
    if (maxW < 1e-15) maxW = 1;

    const now = this.ctx.currentTime;

    // Compute spectral centroid and total energy for cascade dynamics
    let energy = 0;
    let centroid = 0;
    for (let k = 0; k < rank; k++) {
      const e = w[k] * w[k];
      energy += e;
      centroid += e * k;
    }
    centroid = energy > 0 ? centroid / energy : rank / 2;

    // Cascade direction: positive = energy moving to higher modes (brightening)
    const centroidDelta = centroid - this.prevCentroid;
    this.prevCentroid = centroid;

    // Energy delta: positive = energy increasing (impulse just hit)
    const energyDelta = energy - this.prevEnergy;
    this.prevEnergy = energy;

    // Cascade gain: boost on energy injection, exaggerate decay
    // Impulse → loud attack. Viscous decay → quieter, more intimate
    const energyRate = this.prevEnergy > 0 ? energyDelta / this.prevEnergy : 0;
    // Map: big positive energyRate → boost (up to 2x), negative → attenuate (down to 0.3x)
    const cascadeMul = Math.max(0.3, Math.min(2.0, 1.0 + energyRate * 5));
    this.cascadeGain!.gain.setTargetAtTime(cascadeMul, now, 0.05);

    for (let k = 0; k < rank; k++) {
      const activity = Math.abs(w[k]) / maxW;

      // Q: more resonant when active, modulated by cascade direction
      // Upward cascade (centroidDelta > 0) = sharper, more tense
      const cascadeQ = 1 + Math.max(0, centroidDelta) * 2;
      const q = (BASE_Q + activity * (MAX_Q - BASE_Q)) * Math.min(cascadeQ, 2);
      this.filters[k].Q.setTargetAtTime(q, now, 0.03);

      // Cube for sharp gating: quiet modes stay silent, active modes sing
      const amplitude = activity * activity * activity * 4;
      this.gains[k].gain.setTargetAtTime(amplitude, now, 0.03);
    }
  }

  dispose(): void {
    this.noiseSource?.stop();
    this.noiseSource?.disconnect();
    for (const f of this.filters) f.disconnect();
    for (const p of this.panners) p.disconnect();
    for (const g of this.gains) g.disconnect();
    this.cascadeGain?.disconnect();
    this.noiseSource = null;
    this.filters = [];
    this.panners = [];
    this.gains = [];
    this.cascadeGain = null;
  }
}
