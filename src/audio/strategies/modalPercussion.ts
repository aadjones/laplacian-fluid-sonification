/**
 * Strategy D: Modal Percussion / Wind Chime
 *
 * Event-driven: detects energy changes in w and triggers decaying sine pings.
 * Uses adaptive thresholding (mean + σ·stddev) to catch "events" regardless
 * of absolute w scale. Decay time inversely proportional to eigenvalue.
 */

import type { SonificationStrategy } from '../strategy';

const TRIGGER_SIGMA = 2.5;
const BASE_DECAY = 2.0;
const MIN_DECAY = 0.1;
const COOLDOWN = 0.08;
const MAX_VOICES = 12;

export class ModalPercussionStrategy implements SonificationStrategy {
  readonly name = 'Modal Percussion';

  private ctx!: AudioContext;
  private master!: GainNode;
  private frequencies: number[] = [];
  private eigenvalues: number[] = [];
  private wPrev: Float64Array | null = null;
  private lastTrigger: Float64Array | null = null;
  private activeVoices = 0;

  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[]): void {
    this.ctx = ctx;
    this.master = master;
    this.frequencies = frequencies;
    this.eigenvalues = eigenvalues;
    this.wPrev = new Float64Array(frequencies.length);
    this.lastTrigger = new Float64Array(frequencies.length);
    this.activeVoices = 0;
  }

  update(w: Float64Array, rank: number): void {
    if (!this.wPrev || !this.lastTrigger) return;

    const now = this.ctx.currentTime;

    // Compute deltas and statistics
    const deltas = new Float64Array(rank);
    let sum = 0;
    for (let k = 0; k < rank; k++) {
      deltas[k] = Math.abs(w[k] - this.wPrev[k]);
      sum += deltas[k];
    }
    const mean = sum / rank;

    let variance = 0;
    for (let k = 0; k < rank; k++) {
      const d = deltas[k] - mean;
      variance += d * d;
    }
    const stddev = Math.sqrt(variance / rank);

    const threshold = mean + TRIGGER_SIGMA * stddev;
    const minAbsDelta = mean * 0.1 || 1e-6;

    let maxDelta = 0;
    for (let k = 0; k < rank; k++) {
      if (deltas[k] > maxDelta) maxDelta = deltas[k];
    }

    for (let k = 0; k < rank; k++) {
      if (deltas[k] > threshold && deltas[k] > minAbsDelta
          && (now - this.lastTrigger[k]) > COOLDOWN) {
        const amp = Math.min((deltas[k] - mean) / (maxDelta - mean || 1), 1.0);
        this.triggerPing(k, amp * 0.6 + 0.1);
        this.lastTrigger[k] = now;
      }
    }

    this.wPrev.set(w);
  }

  private triggerPing(k: number, amplitude: number): void {
    if (this.activeVoices >= MAX_VOICES) return;

    const now = this.ctx.currentTime;
    const freq = this.frequencies[k];

    const maxLam = this.eigenvalues[this.eigenvalues.length - 1] || 1;
    const minLam = this.eigenvalues[0] || 1;
    const t = (this.eigenvalues[k] - minLam) / (maxLam - minLam || 1);
    const decay = BASE_DECAY - t * (BASE_DECAY - MIN_DECAY);

    const gain = Math.min(amplitude, 1.0);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + decay);

    osc.connect(env);
    env.connect(this.master);

    osc.start(now);
    osc.stop(now + decay + 0.01);

    this.activeVoices++;
    osc.onended = () => {
      this.activeVoices--;
      osc.disconnect();
      env.disconnect();
    };
  }

  dispose(): void {
    // Active pings will self-clean via onended. Just reset state.
    this.wPrev = null;
    this.lastTrigger = null;
  }
}
