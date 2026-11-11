import './style.css';
import { FluidSim } from './sim/fluid';
import { DyeField } from './sim/dye';
import { ParticleSystem } from './sim/particles';
import { FluidRenderer } from './viz/renderer';
import { Sonifier } from './audio/sonifier';

/**
 * A Chladni plate made of fluid.
 *
 * The fluid's state `w` (one coefficient per eigenmode) is the only state.
 * The picture is drawn from it and the sound is read from it. Touching the
 * canvas pushes the fluid; nothing else is an input.
 */
const config = {
  rank: 64,
  grid: 128,
  canvasSize: 512,
  stepsPerFrame: 2,
  dt: 0.0001,
  viscosity: 0.5,
  particleCount: 8000,
  /** Force of a tap, and of a stir at full speed. */
  force: 300,
};

/** Drag speed, in grid cells per second, that reaches full force. */
const FULL_SPEED = 300;

const sim = new FluidSim({
  rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity,
});
const dye = new DyeField(config.grid, config.grid);
const particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
const sonifier = new Sonifier();
const vorticity = new Float64Array(config.grid * config.grid);

// [page] > [stage] > canvas
const stage = document.createElement('div');
stage.id = 'stage';
const canvas = document.createElement('canvas');
canvas.id = 'fluid';
canvas.width = config.canvasSize;
canvas.height = config.canvasSize;
stage.appendChild(canvas);
document.querySelector<HTMLDivElement>('#app')!.appendChild(stage);
const renderer = new FluidRenderer(canvas);

// --- Touch ---

function gridPos(e: PointerEvent): { gx: number; gy: number } {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;
  const max = config.grid - 2;
  return {
    gx: Math.min(Math.max(cx * (config.grid - 1), 0), max),
    gy: Math.min(Math.max(cy * (config.grid - 1), 0), max),
  };
}

let last: { gx: number; gy: number; t: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!sonifier.started) {
    const eigenvalues: number[] = [];
    for (let k = 0; k < config.rank; k++) eigenvalues.push(sim.eigenvalue(k));
    sonifier.init(eigenvalues);
  }

  // A tap is a poke. A finger landing has no direction the player chose, so it
  // gets a random one.
  const { gx, gy } = gridPos(e);
  const angle = Math.random() * Math.PI * 2;
  sim.injectImpulse(gx, gy, Math.cos(angle) * config.force, Math.sin(angle) * config.force);
  dye.inject(gx, gy, 0.1, 0.4, 0.9, 4);
  last = { gx, gy, t: performance.now() };
  // Keep receiving the drag if it leaves the canvas. Throws for a pointer the
  // browser is not tracking, which only a synthetic event can be.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
});

canvas.addEventListener('pointermove', (e) => {
  if (!last) return;
  // A stir pushes the fluid the way the pointer moved, harder when it moves faster.
  const { gx, gy } = gridPos(e);
  const now = performance.now();
  const seconds = Math.max(1e-3, (now - last.t) / 1000);
  const dx = gx - last.gx;
  const dy = gy - last.gy;
  const dist = Math.hypot(dx, dy);
  if (dist > 1e-6) {
    const strength = Math.min(1, dist / seconds / FULL_SPEED) * config.force;
    sim.injectImpulse(gx, gy, (dx / dist) * strength, (dy / dist) * strength);
  }
  dye.inject(gx, gy, 0.1, 0.4, 0.9, 4);
  last = { gx, gy, t: now };
});

const release = (): void => { last = null; };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// --- Loop ---

function frame(): void {
  for (let i = 0; i < config.stepsPerFrame; i++) sim.step();

  const frameDt = config.dt * config.stepsPerFrame;
  dye.advect(sim.velocity, frameDt);
  dye.dissipate(0.985);
  particles.advect(sim.velocity, config.grid, config.grid, frameDt, 1);

  // Sound before picture: the audio path should not wait on rendering.
  sonifier.update(sim.w);

  sim.computeVorticity(vorticity);
  renderer.render(sim, dye, vorticity);
  renderer.renderParticles(particles, config.grid, config.grid);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Measurement hook, dev server only: tools/measure.mjs reads w through this.
if (import.meta.env.DEV) {
  (window as unknown as { __lfs: unknown }).__lfs = { sim, config };
}
