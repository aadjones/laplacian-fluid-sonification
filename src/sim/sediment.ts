/**
 * Sediment: the instrument's memory of where it has been touched.
 *
 * One number per mode in [0,1]. Every strike and stir deposits a little into
 * the modes it excited; everything leaks away slowly. Nothing here sounds or
 * draws by itself. The hammer reads it to ring longer and to hold a faint hum
 * of what it remembers, and the renderer draws it.
 *
 * It is fed by touches, not by the fluid's state. `w` would be the obvious
 * input, but the lowest modes of `w` decay over minutes (the (1,1) mode's
 * viscous time is about 80 wall seconds at default damping), so a memory fed
 * by `w` fills with the bottom of the spectrum whatever was played and never
 * drains while anything is still moving. A deposit is the projection of the
 * gesture itself, so the memory is of the player and not of the physics.
 */

/** Seconds for an untouched memory to fall to 1/e. After a minute, under 10% is left. */
export const SEDIMENT_DECAY = 25;

export class Sediment {
  /** Memory per mode, each in [0,1]. */
  readonly m: Float64Array;

  constructor(rank: number) {
    this.m = new Float64Array(rank);
  }

  /**
   * Remember a gesture.
   *
   * `spectrum[k]` is how strongly the gesture excited mode k (any non-negative
   * scale; only its shape matters), and `amount` in [0,1] is how much of the
   * remaining headroom its strongest mode fills. Filling headroom rather than
   * adding is what makes the memory saturate: the tenth tap on one spot teaches
   * the instrument less than the first.
   */
  deposit(spectrum: ArrayLike<number>, amount: number): void {
    const n = Math.min(spectrum.length, this.m.length);
    let top = 0;
    for (let k = 0; k < n; k++) if (spectrum[k] > top) top = spectrum[k];
    if (!(top > 0) || !(amount > 0)) return;
    const g = Math.min(1, amount) / top;
    for (let k = 0; k < n; k++) {
      const s = spectrum[k];
      if (s > 0) this.m[k] += (1 - this.m[k]) * s * g;
    }
  }

  /** Let the memory fade by `seconds` of wall time. */
  leak(seconds: number): void {
    if (!(seconds > 0)) return;
    const keep = Math.exp(-seconds / SEDIMENT_DECAY);
    const m = this.m;
    for (let k = 0; k < m.length; k++) m[k] *= keep;
  }

  /** How much is remembered in all: the sum over modes. */
  get total(): number {
    let sum = 0;
    for (let k = 0; k < this.m.length; k++) sum += this.m[k];
    return sum;
  }

  clear(): void {
    this.m.fill(0);
  }
}
