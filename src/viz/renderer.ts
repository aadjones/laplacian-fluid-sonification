/**
 * Canvas-based fluid visualization.
 *
 * Renders dye transport (primary) with a subtle vorticity underlay.
 * Dye creates the ink-in-water aesthetic; vorticity adds structure in dark areas.
 */

import { FluidSim } from '../sim/fluid';
import type { DyeField } from '../sim/dye';
import type { ParticleSystem } from '../sim/particles';

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
   * Render dye field blended with vorticity underlay.
   * Dye is the primary visual; vorticity shows through where dye is absent.
   */
  render(sim: FluidSim, dye: DyeField): void {
    const { xRes, yRes } = sim.config;
    const fieldSize = xRes * yRes;
    const v = sim.velocity;

    // Compute vorticity for underlay
    const vorticity = new Float64Array(fieldSize);
    const dx = Math.PI / (xRes - 1);
    const dy = Math.PI / (yRes - 1);

    for (let iy = 1; iy < yRes - 1; iy++) {
      for (let ix = 1; ix < xRes - 1; ix++) {
        const idx = iy * xRes + ix;
        const dvdx = (v[fieldSize + idx + 1] - v[fieldSize + idx - 1]) / (2 * dx);
        const dudy = (v[idx + xRes] - v[idx - xRes]) / (2 * dy);
        vorticity[idx] = dvdx - dudy;
      }
    }

    let maxVort = 0;
    for (let i = 0; i < fieldSize; i++) {
      maxVort = Math.max(maxVort, Math.abs(vorticity[i]));
    }
    if (maxVort < 1e-10) maxVort = 1;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const data = this.imageData.data;

    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const gx = Math.min(Math.floor(cx * xRes / cw), xRes - 1);
        const gy = Math.min(Math.floor(cy * yRes / ch), yRes - 1);
        const idx = gy * xRes + gx;
        const pixIdx = (cy * cw + cx) * 4;

        // Vorticity underlay (subtle)
        const vort = vorticity[idx] / maxVort;
        let vr: number, vg: number, vb: number;
        if (vort > 0) {
          vr = vort * 40; vg = vort * 15; vb = vort * 8;
        } else {
          vr = -vort * 8; vg = -vort * 15; vb = -vort * 40;
        }

        // Dye layer (primary)
        const dr = dye.r[idx];
        const dg = dye.g[idx];
        const db = dye.b[idx];

        // Additive blend: dye on top of vorticity underlay
        data[pixIdx]     = Math.min(255, Math.floor(vr + dr * 255));
        data[pixIdx + 1] = Math.min(255, Math.floor(vg + dg * 255));
        data[pixIdx + 2] = Math.min(255, Math.floor(vb + db * 255));
        data[pixIdx + 3] = 255;
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
