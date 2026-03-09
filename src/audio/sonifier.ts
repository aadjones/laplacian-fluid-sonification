/**
 * Web Audio sonification of eigenmode coefficients.
 *
 * Maps the w vector (eigenmode coefficients) to an oscillator bank.
 * Each eigenmode (k1,k2) has eigenvalue λ = k1² + k2², which maps
 * naturally to an audible frequency. The amplitude of each oscillator
 * is driven by |w[k]| / ||w||₁.
 *
 * Bidirectional:
 *   - Fluid→Sound: sim updates w, sonifier reads it to set oscillator gains
 *   - Sound→Fluid: external source sets oscillator gains, sonifier writes w
 *
 * Frequency mapping (from dissertation):
 *   f_k = fundamental * (λ_max / λ_k)^(1/s)
 * where s controls octave spread. Since λ IS spatial frequency²,
 * this mapping is physically natural—not arbitrary.
 */

import type { FluidSim } from '../sim/fluid';

export interface SonifierConfig {
  /** Base/fundamental frequency in Hz (default 64) */
  fundamental: number;
  /** Octave scaling exponent (default 1.75) */
  octaveScale: number;
  /** Master gain (default 0.3) */
  masterGain: number;
}

const DEFAULT_SONIFIER_CONFIG: SonifierConfig = {
  fundamental: 64,
  octaveScale: 1.75,
  masterGain: 0.3,
};

export class Sonifier {
  private ctx: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private masterGainNode: GainNode | null = null;
  private config: SonifierConfig;
  private frequencies: number[] = [];
  private running = false;

  constructor(config: Partial<SonifierConfig> = {}) {
    this.config = { ...DEFAULT_SONIFIER_CONFIG, ...config };
  }

  /**
   * Initialize the audio context and create oscillator bank.
   * Must be called from a user gesture (click/keypress) due to autoplay policy.
   */
  init(sim: FluidSim): void {
    if (this.ctx) return;

    this.ctx = new AudioContext();
    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = this.config.masterGain;
    this.masterGainNode.connect(this.ctx.destination);

    // Compute frequencies for each mode
    const rank = sim.config.rank;
    const eigenvalues = [];
    let maxLambda = 0;
    for (let k = 0; k < rank; k++) {
      const lam = sim.eigenvalue(k);
      eigenvalues.push(lam);
      maxLambda = Math.max(maxLambda, lam);
    }

    const { fundamental, octaveScale } = this.config;
    this.frequencies = eigenvalues.map(lam =>
      fundamental * Math.pow(maxLambda / lam, 1 / octaveScale)
    );

    // Create oscillator bank
    for (let k = 0; k < rank; k++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.frequencies[k];

      const gain = this.ctx.createGain();
      gain.gain.value = 0;

      osc.connect(gain);
      gain.connect(this.masterGainNode);
      osc.start();

      this.oscillators.push(osc);
      this.gains.push(gain);
    }

    this.running = true;
  }

  /**
   * Update oscillator amplitudes from current sim state.
   * Fluid→Sound direction: reads w, sets gains.
   */
  updateFromSim(sim: FluidSim): void {
    if (!this.running) return;

    const w = sim.w;
    const rank = sim.config.rank;

    // L1 norm for normalization
    let l1 = 0;
    for (let k = 0; k < rank; k++) l1 += Math.abs(w[k]);
    if (l1 < 1e-15) l1 = 1;

    const now = this.ctx!.currentTime;
    for (let k = 0; k < rank; k++) {
      const amplitude = Math.abs(w[k]) / l1;
      this.gains[k].gain.setTargetAtTime(amplitude, now, 0.02);
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
      // Find nearest mode by frequency
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
