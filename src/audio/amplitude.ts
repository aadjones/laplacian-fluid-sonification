/**
 * Shared amplitude mapping for sonification strategies.
 *
 * Every strategy previously divided by max|w| each frame. That pins the loudest
 * mode at full gain no matter what the fluid is doing, so a violent stir and a
 * dying wisp come out at the same level and the whole amplitude dimension is
 * lost. Two things replace it:
 *
 *  - L1 normalisation for spectral shape (a_k = |w_k| / ||w||_1), which is the
 *    dissertation's eq. 2. L1 conserves level across the partials, so energy
 *    concentrated in a few modes reads as focus and energy spread across many
 *    reads as diffuse.
 *  - An absolute loudness referenced to the loudest gesture so far, recovering
 *    over ~90 s. This is the dissertation's second normalisation mode, the one
 *    it describes as giving "a more variable volume envelope".
 *
 * The modes then carry their own envelopes for free: each decays viscously at
 * exp(-nu*lambda*t), so high modes fall away in seconds while low modes ring
 * for a minute, which is the bright-to-dark decay of a struck bell.
 */

/** Fast attack, slow release: a strike should arrive at once and ring out. */
export const ATTACK_TC = 0.008;
export const RELEASE_TC = 0.25;

/** Recovery time of the reference peak. Long, so a decay stays audible as one shape. */
const PEAK_RECOVERY_TC = 90;

/** Tracks a slowly-decaying running maximum and reports the current fraction of it. */
export class PeakTracker {
  private peak = 0;
  private lastTime = 0;

  /** Returns value/peak in [0,1], updating the peak. */
  update(value: number, now: number): number {
    const dt = Math.max(0, now - this.lastTime);
    this.lastTime = now;

    if (value > this.peak) {
      this.peak = value;
    } else if (dt > 0) {
      this.peak *= Math.exp(-dt / PEAK_RECOVERY_TC);
    }
    return this.peak > 1e-12 ? Math.min(1, value / this.peak) : 0;
  }

  reset(): void {
    this.peak = 0;
    this.lastTime = 0;
  }
}

/** Per-mode amplitudes: L1-normalised shape scaled by absolute loudness. */
export class ModeAmplitudes {
  readonly amps: Float64Array;
  private prev: Float64Array;
  private tracker = new PeakTracker();

  constructor(rank: number) {
    this.amps = new Float64Array(rank);
    this.prev = new Float64Array(rank);
  }

  /** Recompute `amps` from w. Returns the loudness in [0,1]. */
  update(w: Float64Array, rank: number, now: number, scale = 1): number {
    let l1 = 0;
    for (let k = 0; k < rank; k++) l1 += Math.abs(w[k]);

    const loudness = this.tracker.update(l1, now);
    const norm = l1 > 1e-12 ? 1 / l1 : 0;
    for (let k = 0; k < rank; k++) {
      this.amps[k] = Math.abs(w[k]) * norm * loudness * scale;
    }
    return loudness;
  }

  /** ATTACK_TC while this mode is rising, RELEASE_TC while it falls. */
  timeConstant(k: number): number {
    const tc = this.amps[k] > this.prev[k] ? ATTACK_TC : RELEASE_TC;
    this.prev[k] = this.amps[k];
    return tc;
  }
}
