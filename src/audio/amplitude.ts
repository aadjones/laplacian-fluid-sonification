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

  /**
   * Scale the reference, for when the measured quantity changes units.
   *
   * Resetting is almost never what you want: the next value seen becomes the
   * new peak and therefore reads as full scale, however small it is. Rescaling
   * keeps the reported level continuous across the change instead.
   */
  rescale(factor: number): void {
    if (Number.isFinite(factor) && factor > 0) this.peak *= factor;
  }
}

/** Below this, a gain change is inaudible and not worth an automation event. */
const SEND_EPSILON = 1e-5;

/** Per-mode amplitudes: L1-normalised shape scaled by absolute loudness. */
export class ModeAmplitudes {
  readonly amps: Float64Array;
  private prev: Float64Array;
  private sent: Float64Array;
  private tracker = new PeakTracker();
  private lastL1 = 0;
  private reseed = false;

  constructor(rank: number) {
    this.amps = new Float64Array(rank);
    this.prev = new Float64Array(rank);
    this.sent = new Float64Array(rank);
  }

  /** Recompute `amps` from w. Returns the loudness in [0,1]. */
  update(w: Float64Array, rank: number, now: number, scale = 1): number {
    let l1 = 0;
    for (let k = 0; k < rank; k++) l1 += Math.abs(w[k]);

    // The set of sounding modes just changed, so the reference is measuring a
    // norm that no longer exists. Scale it by however much the norm moved,
    // which keeps the level continuous across the change.
    if (this.reseed) {
      this.reseed = false;
      if (this.lastL1 > 1e-12 && l1 > 1e-12) this.tracker.rescale(l1 / this.lastL1);
    }
    this.lastL1 = l1;

    const loudness = this.tracker.update(l1, now);
    const norm = l1 > 1e-12 ? 1 / l1 : 0;
    for (let k = 0; k < rank; k++) {
      this.amps[k] = Math.abs(w[k]) * norm * loudness * scale;
    }
    return loudness;
  }

  /**
   * Re-reference the level, because the set of sounding modes just changed.
   *
   * Soloing an eight-mode stack out of 576 cuts the L1 norm by a large factor
   * against a reference set while everything was sounding, so every level
   * afterwards reads as near-zero — the bank goes quiet for a minute and a half
   * exactly when the player asks to hear one note. The cure is not to *forget*
   * the reference, which makes the next value read as full scale and arrives as
   * a crash; it is to rescale it on the next frame by however much the norm
   * actually moved.
   *
   * `sent` is filled with Infinity rather than zero so every gain is rewritten
   * once. Zero would compare equal to the new amplitude of a mode the mask has
   * just switched off, and that mode's gain would be left open.
   */
  resetLevel(): void {
    this.reseed = true;
    this.prev.fill(0);
    this.sent.fill(Infinity);
  }

  /** ATTACK_TC while this mode is rising, RELEASE_TC while it falls. */
  timeConstant(k: number): number {
    const tc = this.amps[k] > this.prev[k] ? ATTACK_TC : RELEASE_TC;
    this.prev[k] = this.amps[k];
    return tc;
  }

  /**
   * Whether mode k's gain has moved enough to be worth an automation event.
   *
   * At rank 576 a strategy that writes every mode every frame issues ~34,500
   * `setTargetAtTime` calls a second, and when a stack is soloed all but eight
   * of them are scheduling a ramp from zero to zero. Skipping those is free
   * headroom for the rank slider, which is the parameter that decides how many
   * notes the instrument has.
   */
  needsUpdate(k: number): boolean {
    if (Math.abs(this.amps[k] - this.sent[k]) < SEND_EPSILON) return false;
    this.sent[k] = this.amps[k];
    return true;
  }
}
