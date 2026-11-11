/**
 * Sonifier: the fluid's state, heard.
 *
 * One rule: every sound comes from `w`. There is one sine per eigenmode, tuned
 * to f = base·√(λ/λmin), and its loudness at any moment is how much of that
 * mode the fluid holds. Nothing is triggered, scheduled or remembered here.
 * If the fluid is still, this is silent.
 *
 * √λ is the physical modal relation (a plate's or membrane's modes sit at
 * √λ), and because λ(np,nq) = n²·λ(p,q) it puts every family of modes on an
 * exact harmonic series.
 */

import { ModeAmplitudes } from './amplitude';

/** Pitch of the lowest mode, Hz. */
const FREQ_BASE = 110;
const MASTER_GAIN = 0.5;

export function modeFrequencies(eigenvalues: number[], base = FREQ_BASE): number[] {
  // Eigenvalues arrive in enumeration order, not sorted, so find the minimum.
  const lamMin = Math.min(...eigenvalues);
  return eigenvalues.map((lam) => base * Math.sqrt(lam / lamMin));
}

export class Sonifier {
  private ctx: AudioContext | null = null;
  private gains: GainNode[] = [];
  private amplitudes = new ModeAmplitudes(0);

  /** Build the oscillators. Must be called from a user gesture. */
  init(eigenvalues: number[]): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    // Chromium can hand back a suspended context even inside a gesture, and a
    // suspended context is silent with no other symptom.
    void ctx.resume();
    this.ctx = ctx;

    // Soft ceiling so a hard stir saturates instead of clipping.
    const limiter = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      curve[i] = Math.tanh((i / (curve.length - 1)) * 2 - 1);
    }
    limiter.curve = curve;
    limiter.oversample = '2x';
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(limiter);

    const nyquist = ctx.sampleRate / 2;
    this.amplitudes = new ModeAmplitudes(eigenvalues.length);
    this.gains = modeFrequencies(eigenvalues).map((f) => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(master);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = Math.min(f, nyquist * 0.9);
      osc.connect(gain);
      osc.start();
      return gain;
    });
  }

  /** Call once per frame with the fluid's coefficients. */
  update(w: Float64Array): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const rank = Math.min(w.length, this.gains.length);
    this.amplitudes.update(w, rank, now);
    for (let k = 0; k < rank; k++) {
      const tc = this.amplitudes.timeConstant(k);
      if (this.amplitudes.needsUpdate(k)) {
        this.gains[k].gain.setTargetAtTime(this.amplitudes.amps[k], now, tc);
      }
    }
  }

  get started(): boolean {
    return this.ctx !== null;
  }
}
