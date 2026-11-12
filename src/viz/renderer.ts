/**
 * Canvas-based fluid visualization.
 *
 * The plate is drawn the way a Chladni plate is read: by its still lines. The
 * bright lines are where the fluid's rotation is zero, the boundaries between
 * cells turning one way and cells turning the other. One mode alone gives a
 * clean grid; several give curves that drift and tangle. Dye and particles
 * ride on top and show that it is flowing.
 */

import { FluidSim } from '../sim/fluid';
import type { DyeField } from '../sim/dye';
import type { ParticleSystem } from '../sim/particles';

/** Width of a still line, in canvas pixels. */
const LINE_WIDTH = 1.8;
/** Brightness of the turning-direction tint at one note's strength. */
const TINT = 0.45;

export class FluidRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.imageData = this.ctx.createImageData(canvas.width, canvas.height);
  }

  /**
   * Draw the figure, then the dye over it.
   *
   * `vorticity` comes from `FluidSim.computeVorticity`. `reference` is the
   * vorticity of one ordinary note: the figure is drawn at full strength at
   * that level and fades as the fluid settles, so the picture goes dark when
   * the sound goes quiet. (It used to be normalised to its own maximum, which
   * drew a dying note as brightly as a fresh one.)
   */
  render(sim: FluidSim, dye: DyeField, vorticity: Float64Array, reference: number): void {
    const { xRes, yRes } = sim.config;
    const fieldSize = xRes * yRes;

    let maxVort = 0;
    for (let i = 0; i < fieldSize; i++) {
      maxVort = Math.max(maxVort, Math.abs(vorticity[i]));
    }
    // Square root, so the figure is still readable well into a note's decay.
    const presence = Math.sqrt(Math.min(1, maxVort / reference));
    // Keeps near-flat, near-zero regions from reading as one wide line.
    const flat = Math.max(maxVort, 1e-9) * 1e-3;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const data = this.imageData.data;
    const sx = (xRes - 1) / (cw - 1);
    const sy = (yRes - 1) / (ch - 1);

    for (let cy = 0; cy < ch; cy++) {
      const fy = cy * sy;
      const y0 = Math.min(Math.floor(fy), yRes - 2);
      const ty = fy - y0;
      for (let cx = 0; cx < cw; cx++) {
        const fx = cx * sx;
        const x0 = Math.min(Math.floor(fx), xRes - 2);
        const tx = fx - x0;
        const i00 = y0 * xRes + x0;
        const v00 = vorticity[i00];
        const v10 = vorticity[i00 + 1];
        const v01 = vorticity[i00 + xRes];
        const v11 = vorticity[i00 + xRes + 1];

        // Bilinear value and its gradient, in units per canvas pixel.
        const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        const dx = ((v10 - v00) * (1 - ty) + (v11 - v01) * ty) * sx;
        const dy = ((v01 - v00) * (1 - tx) + (v11 - v10) * tx) * sy;

        // Distance to the nearest still line, in pixels, to first order.
        const dist = Math.abs(v) / (Math.hypot(dx, dy) + flat);
        const line = Math.max(0, Math.min(1, LINE_WIDTH - dist)) * presence;

        // Which way each cell turns: warm one way, cool the other.
        const tint = Math.min(1, Math.abs(v) / reference) * TINT;
        let r: number, g: number, b: number;
        if (v > 0) { r = 255 * tint; g = 130 * tint; b = 50 * tint; }
        else { r = 50 * tint; g = 130 * tint; b = 255 * tint; }

        const idx = Math.min(Math.round(fy), yRes - 1) * xRes + Math.min(Math.round(fx), xRes - 1);
        const pix = (cy * cw + cx) * 4;
        data[pix]     = Math.min(255, r + line * 255 + dye.r[idx] * 255);
        data[pix + 1] = Math.min(255, g + line * 240 + dye.g[idx] * 255);
        data[pix + 2] = Math.min(255, b + line * 210 + dye.b[idx] * 255);
        data[pix + 3] = 255;
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /**
   * Render particles as small dots over the existing canvas content.
   */
  renderParticles(particles: ParticleSystem, xRes: number, yRes: number): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scaleX = cw / (xRes - 1);
    const scaleY = ch / (yRes - 1);
    const ctx = this.ctx;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';

    for (let i = 0; i < particles.count; i++) {
      const px = particles.positions[i * 2] * scaleX;
      const py = particles.positions[i * 2 + 1] * scaleY;

      const age = particles.ages[i];
      if (age < 10) {
        ctx.globalAlpha = age / 10 * 0.5;
        ctx.fillRect(px - 0.5, py - 0.5, 1, 1);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillRect(px - 0.5, py - 0.5, 1, 1);
      }
    }
  }
}
