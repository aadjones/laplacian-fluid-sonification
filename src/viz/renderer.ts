/**
 * Canvas-based fluid visualization.
 *
 * Renders the velocity field as a color-mapped vorticity image.
 * Vorticity (curl of 2D velocity) = ∂v/∂x - ∂u/∂y — a scalar field
 * that shows rotation. Blue = clockwise, red = counter-clockwise.
 */

import { FluidSim } from '../sim/fluid';
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
   * Render the current fluid state to the canvas.
   * Computes vorticity from the velocity field and maps to a diverging colormap.
   */
  render(sim: FluidSim): void {
    const { xRes, yRes } = sim.config;
    const fieldSize = xRes * yRes;
    const v = sim.velocity;

    // Compute vorticity: ω = ∂v/∂x - ∂u/∂y (finite differences)
    const vorticity = new Float64Array(fieldSize);
    const dx = Math.PI / (xRes - 1);
    const dy = Math.PI / (yRes - 1);

    for (let iy = 1; iy < yRes - 1; iy++) {
      for (let ix = 1; ix < xRes - 1; ix++) {
        const idx = iy * xRes + ix;
        // v-component is stored at offset fieldSize
        const dvdx = (v[fieldSize + idx + 1] - v[fieldSize + idx - 1]) / (2 * dx);
        const dudy = (v[idx + xRes] - v[idx - xRes]) / (2 * dy);
        vorticity[idx] = dvdx - dudy;
      }
    }

    // Find max vorticity for normalization
    let maxVort = 0;
    for (let i = 0; i < fieldSize; i++) {
      maxVort = Math.max(maxVort, Math.abs(vorticity[i]));
    }
    if (maxVort < 1e-10) maxVort = 1;

    // Render to canvas (upscale if canvas is larger than sim grid)
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const data = this.imageData.data;

    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        // Map canvas pixel to sim grid
        const gx = Math.min(Math.floor(cx * xRes / cw), xRes - 1);
        const gy = Math.min(Math.floor(cy * yRes / ch), yRes - 1);
        const idx = gy * xRes + gx;

        const val = vorticity[idx] / maxVort; // -1 to 1
        const pixIdx = (cy * cw + cx) * 4;

        // Diverging colormap: blue (negative/CW) → black → red (positive/CCW)
        if (val > 0) {
          data[pixIdx] = Math.floor(val * 255);     // R
          data[pixIdx + 1] = Math.floor(val * 60);  // G
          data[pixIdx + 2] = Math.floor(val * 30);  // B
        } else {
          data[pixIdx] = Math.floor(-val * 30);      // R
          data[pixIdx + 1] = Math.floor(-val * 60);  // G
          data[pixIdx + 2] = Math.floor(-val * 255);  // B
        }
        data[pixIdx + 3] = 255; // A
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /**
   * Render particles as small dots over the existing canvas content.
   * Call after render() to overlay particles on vorticity.
   */
  renderParticles(particles: ParticleSystem, xRes: number, yRes: number): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scaleX = cw / (xRes - 1);
    const scaleY = ch / (yRes - 1);
    const ctx = this.ctx;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';

    for (let i = 0; i < particles.count; i++) {
      const px = particles.positions[i * 2] * scaleX;
      const py = particles.positions[i * 2 + 1] * scaleY;

      // Fade in over first 10 frames after spawn
      const age = particles.ages[i];
      if (age < 10) {
        ctx.globalAlpha = age / 10 * 0.7;
        ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
      }
    }
  }
}
