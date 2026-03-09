/**
 * Subtractive sonification of eigenmode coefficients via resonant filter bank.
 *
 * Architecture: noise source → N parallel bandpass filters → gain nodes → master gain
 *
 * Each eigenmode (k1,k2) maps to a bandpass filter whose center frequency
 * is derived from the eigenvalue. The fluid's w vector controls each filter's
 * Q (resonance sharpness) and output gain. This is physically motivated:
 * the eigenmodes are resonances of the 2D domain, and filtering noise through
 * them is literally "what would this cavity sound like if excited."
 *
 * Frequency mapping (physical membrane overtone series):
 *   f_k = fundamental * λ_k^(1/s)    (s=2 gives f ∝ √λ)
 *
 * Bidirectional:
 *   - Fluid→Sound: w drives filter Q and gain
 *   - Sound→Fluid: frequenciesToCoefficients maps external frequencies to w
 */

import type { FluidSim } from '../sim/fluid';

export interface SonifierConfig {
  /** Base/fundamental frequency in Hz (default 110, A2) */
  fundamental: number;
  /** Eigenvalue-to-frequency exponent: 2 = √λ (physical membrane), 1 = λ (default 2) */
  octaveScale: number;
  /** Master gain (default 0.3) */
  masterGain: number;
  /** Base Q for bandpass filters (default 15) */
  baseQ: number;
  /** Max Q when a mode is fully active (default 80) */
  maxQ: number;
}

const DEFAULT_SONIFIER_CONFIG: SonifierConfig = {
  fundamental: 110,
  octaveScale: 2,
  masterGain: 0.3,
  baseQ: 15,
  maxQ: 80,
};

/** Duration of the noise buffer in seconds */
const NOISE_DURATION = 2;

export class Sonifier {
  private ctx: AudioContext | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private gains: GainNode[] = [];
  private masterGainNode: GainNode | null = null;
  private config: SonifierConfig;
  private frequencies: number[] = [];
  private running = false;

  constructor(config: Partial<SonifierConfig> = {}) {
    this.config = { ...DEFAULT_SONIFIER_CONFIG, ...config };
  }

  /**
   * Initialize the audio context and create the resonant filter bank.
   * Must be called from a user gesture (click/keypress) due to autoplay policy.
   */
  init(sim: FluidSim): void {
    if (this.ctx) return;

    this.ctx = new AudioContext();
    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = this.config.masterGain;
    this.masterGainNode.connect(this.ctx.destination);

    // Compute frequencies for each mode
    // Physical mapping: f_k = fundamental * λ_k^(1/octaveScale)
    // For octaveScale=2 this gives f ∝ √λ, the natural overtone series
    // of a rectangular membrane where λ = k₁² + k₂².
    const rank = sim.config.rank;
    const { fundamental, octaveScale } = this.config;
    this.frequencies = [];
    for (let k = 0; k < rank; k++) {
      const lam = sim.eigenvalue(k);
      this.frequencies.push(fundamental * Math.pow(lam, 1 / octaveScale));
    }

    // Create white noise buffer
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = sampleRate * NOISE_DURATION;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Create looping noise source
    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;

    // Create resonant filter bank: noise → bandpass[k] → gain[k] → master
    for (let k = 0; k < rank; k++) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = this.frequencies[k];
      filter.Q.value = this.config.baseQ;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;

      this.noiseSource.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGainNode);

      this.filters.push(filter);
      this.gains.push(gain);
    }

    this.noiseSource.start();
    this.running = true;
  }

  /**
   * Update filter bank from current sim state.
   * Fluid→Sound direction: w controls filter Q (resonance) and output gain.
   */
  updateFromSim(sim: FluidSim): void {
    if (!this.running || !this.ctx) return;

    const w = sim.w;
    const rank = sim.config.rank;

    // Find max |w| for normalization
    let maxW = 0;
    for (let k = 0; k < rank; k++) maxW = Math.max(maxW, Math.abs(w[k]));
    if (maxW < 1e-15) maxW = 1;

    const now = this.ctx.currentTime;
    const { baseQ, maxQ } = this.config;

    for (let k = 0; k < rank; k++) {
      const activity = Math.abs(w[k]) / maxW; // 0 to 1

      // Q: inactive modes are broad and quiet, active modes ring sharply
      const q = baseQ + activity * (maxQ - baseQ);
      this.filters[k].Q.setTargetAtTime(q, now, 0.03);

      // Gain: squared activity for more dynamic contrast
      const amplitude = activity * activity;
      this.gains[k].gain.setTargetAtTime(amplitude, now, 0.03);
    }
  }

  /**
   * Sound→Fluid direction: generate w coefficients from a set of
   * (frequency, amplitude) pairs. Finds the nearest eigenmode for each
   * frequency and sets the corresponding w coefficient.
   */
  frequenciesToCoefficients(
    freqAmps: Array<{ freq: number; amp: number }>,
    rank: number,
  ): Float64Array {
    const w = new Float64Array(rank);

    for (const { freq, amp } of freqAmps) {
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < this.frequencies.length; k++) {
        const dist = Math.abs(this.frequencies[k] - freq);
        if (dist < bestDist) {
          bestDist = dist;
          bestK = k;
        }
      }
      w[bestK] += amp;
    }

    return w;
  }

  /** Get the frequency assigned to mode k */
  getFrequency(k: number): number {
    return this.frequencies[k] ?? 0;
  }

  /** Set master gain */
  setMasterGain(value: number): void {
    if (this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(value, this.ctx!.currentTime, 0.02);
    }
    this.config.masterGain = value;
  }

  /** Suspend audio */
  suspend(): void {
    this.ctx?.suspend();
    this.running = false;
  }

  /** Resume audio */
  resume(): void {
    this.ctx?.resume();
    this.running = true;
  }

  /** Toggle audio on/off */
  toggle(): void {
    if (this.running) this.suspend();
    else this.resume();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
