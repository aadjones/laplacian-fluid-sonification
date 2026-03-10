/**
 * Passive scalar (dye) transport for flow visualization.
 *
 * Three independent scalar channels (RGB) advected through the velocity field
 * using semi-Lagrangian advection (unconditionally stable). Dye is injected
 * at forcing and interaction points and slowly dissipates to prevent saturation.
 *
 * Semi-Lagrangian: for each grid cell, trace backward along velocity by -dt,
 * bilinear interpolate the old dye value at the departure point.
 */

export class DyeField {
  /** Three scalar channels, each xRes*yRes */
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  private rPrev: Float64Array;
  private gPrev: Float64Array;
  private bPrev: Float64Array;
  readonly xRes: number;
  readonly yRes: number;

  constructor(xRes: number, yRes: number) {
    this.xRes = xRes;
    this.yRes = yRes;
    const size = xRes * yRes;
    this.r = new Float64Array(size);
    this.g = new Float64Array(size);
    this.b = new Float64Array(size);
    this.rPrev = new Float64Array(size);
    this.gPrev = new Float64Array(size);
    this.bPrev = new Float64Array(size);
  }

  /**
   * Semi-Lagrangian advection: trace each cell backward through the velocity
   * field and interpolate the old dye value at the departure point.
   *
   * Velocity layout: u in [0..fieldSize), v in [fieldSize..2*fieldSize).
   * Velocity is in physical coordinates on [0,π]². Grid spacing dx = π/(xRes-1).
   */
  advect(velocity: Float64Array, dt: number): void {
    const { xRes, yRes } = this;
    const fieldSize = xRes * yRes;
    const scale = (xRes - 1) / Math.PI;
    const maxX = xRes - 1.001;
    const maxY = yRes - 1.001;

    // Swap buffers
    const tmpR = this.rPrev; this.rPrev = this.r; this.r = tmpR;
    const tmpG = this.gPrev; this.gPrev = this.g; this.g = tmpG;
    const tmpB = this.bPrev; this.bPrev = this.b; this.b = tmpB;

    for (let iy = 0; iy < yRes; iy++) {
      for (let ix = 0; ix < xRes; ix++) {
        const idx = iy * xRes + ix;

        // Trace backward: departure point = current position - velocity * dt
        const u = velocity[idx] * scale;
        const v = velocity[fieldSize + idx] * scale;
        let srcX = ix - u * dt;
        let srcY = iy - v * dt;

        // Clamp to grid bounds
        srcX = Math.max(0, Math.min(srcX, maxX));
        srcY = Math.max(0, Math.min(srcY, maxY));

        // Bilinear interpolation
        const x0 = Math.floor(srcX);
        const y0 = Math.floor(srcY);
        const x1 = x0 + 1;
        const y1 = y0 + 1;
        const fx = srcX - x0;
        const fy = srcY - y0;

        const i00 = y0 * xRes + x0;
        const i10 = y0 * xRes + x1;
        const i01 = y1 * xRes + x0;
        const i11 = y1 * xRes + x1;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        this.r[idx] = w00 * this.rPrev[i00] + w10 * this.rPrev[i10] + w01 * this.rPrev[i01] + w11 * this.rPrev[i11];
        this.g[idx] = w00 * this.gPrev[i00] + w10 * this.gPrev[i10] + w01 * this.gPrev[i01] + w11 * this.gPrev[i11];
        this.b[idx] = w00 * this.bPrev[i00] + w10 * this.bPrev[i10] + w01 * this.bPrev[i01] + w11 * this.bPrev[i11];
      }
    }
  }

  /**
   * Inject dye at a grid position with a Gaussian splat.
   * Color values are additive (clamped on render).
   */
  inject(gx: number, gy: number, r: number, g: number, b: number, radius: number): void {
    const { xRes, yRes } = this;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(gx - radius * 2));
    const x1 = Math.min(xRes - 1, Math.ceil(gx + radius * 2));
    const y0 = Math.max(0, Math.floor(gy - radius * 2));
    const y1 = Math.min(yRes - 1, Math.ceil(gy + radius * 2));

    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ix - gx;
        const dy = iy - gy;
        const d2 = dx * dx + dy * dy;
        const weight = Math.exp(-d2 / r2);
        const idx = iy * xRes + ix;
        this.r[idx] += r * weight;
        this.g[idx] += g * weight;
        this.b[idx] += b * weight;
      }
    }
  }

  /** Slowly fade all dye to prevent saturation */
  dissipate(rate: number): void {
    const n = this.r.length;
    for (let i = 0; i < n; i++) {
      this.r[i] *= rate;
      this.g[i] *= rate;
      this.b[i] *= rate;
    }
  }

  clear(): void {
    this.r.fill(0);
    this.g.fill(0);
    this.b.fill(0);
  }
}
