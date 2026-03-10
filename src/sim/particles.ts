/**
 * Particle advection system for flow visualization.
 *
 * Particles are advected through the velocity field each frame using
 * Euler integration (matching the C++ reference). Particles that leave
 * the domain are respawned at random positions to maintain density.
 *
 * Grid domain is [0, π] × [0, π] with dx = π/(xRes-1).
 */

export class ParticleSystem {
  /** Flat array: [x0, y0, x1, y1, ...] in grid coordinates */
  positions: Float64Array;
  /** Age of each particle in frames (for fade-in/trail effects) */
  ages: Float64Array;
  readonly count: number;

  constructor(count: number, xRes: number, yRes: number) {
    this.count = count;
    this.positions = new Float64Array(count * 2);
    this.ages = new Float64Array(count);
    this.seed(xRes, yRes);
  }

  /** Randomly distribute all particles across the domain */
  seed(xRes: number, yRes: number): void {
    for (let i = 0; i < this.count; i++) {
      this.positions[i * 2] = Math.random() * (xRes - 1);
      this.positions[i * 2 + 1] = Math.random() * (yRes - 1);
      this.ages[i] = Math.floor(Math.random() * 60); // stagger initial ages
    }
  }

  /**
   * Advect all particles through the velocity field using Euler integration.
   * Velocity array layout: u in [0..fieldSize), v in [fieldSize..2*fieldSize).
   */
  advect(velocity: Float64Array, xRes: number, yRes: number, dt: number, substeps: number): void {
    const fieldSize = xRes * yRes;
    const maxX = xRes - 1;
    const maxY = yRes - 1;

    for (let i = 0; i < this.count; i++) {
      let px = this.positions[i * 2];
      let py = this.positions[i * 2 + 1];

      // Sub-step for accuracy (velocity changes over the sim substeps)
      for (let s = 0; s < substeps; s++) {
        // Bilinear interpolation of velocity at (px, py)
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        if (ix < 0 || ix >= maxX || iy < 0 || iy >= maxY) break;

        const fx = px - ix;
        const fy = py - iy;
        const idx00 = iy * xRes + ix;
        const idx10 = idx00 + 1;
        const idx01 = idx00 + xRes;
        const idx11 = idx01 + 1;

        const u = (1 - fx) * (1 - fy) * velocity[idx00]
                + fx * (1 - fy) * velocity[idx10]
                + (1 - fx) * fy * velocity[idx01]
                + fx * fy * velocity[idx11];

        const v = (1 - fx) * (1 - fy) * velocity[fieldSize + idx00]
                + fx * (1 - fy) * velocity[fieldSize + idx10]
                + (1 - fx) * fy * velocity[fieldSize + idx01]
                + fx * fy * velocity[fieldSize + idx11];

        // Grid-space velocity: multiply by grid/domain scale
        // Domain is [0,π], grid has (xRes-1) cells, so dx = π/(xRes-1)
        // v_grid = v_physical / dx = v_physical * (xRes-1) / π
        const scale = (xRes - 1) / Math.PI;
        px += u * scale * dt;
        py += v * scale * dt;
      }

      // Respawn if out of bounds
      if (px < 0 || px >= maxX || py < 0 || py >= maxY) {
        px = Math.random() * maxX;
        py = Math.random() * maxY;
        this.ages[i] = 0;
      }

      this.positions[i * 2] = px;
      this.positions[i * 2 + 1] = py;
      this.ages[i]++;
    }
  }
}
