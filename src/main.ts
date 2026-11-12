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
  /**
   * Even damping on every mode; this is what lets a note end. At 40 a low note
   * falls 20 dB in about 4.7 s and the highest in about 1.9 s. Viscosity alone
   * left the lowest mode ringing for over a minute.
   */
  drag: 40,
  particleCount: 8000,
  /** Force of a tap, and of a stir at full speed. */
  force: 300,
  /**
   * How much one press of a lattice cell adds to its mode. Soft on purpose:
   * at 100 a two-note chord keeps about 90% of its motion in the two notes and
   * wakes a few neighbours. Pressing again adds more, and at three presses'
   * worth the same chord spreads across 14 modes.
   */
  press: 100,
};

/** Drag speed, in grid cells per second, that reaches full force. */
const FULL_SPEED = 300;

const sim = new FluidSim({
  rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity,
  drag: config.drag,
});
const dye = new DyeField(config.grid, config.grid);
const particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
const sonifier = new Sonifier();
const vorticity = new Float64Array(config.grid * config.grid);

// [page] > [stage] > [plate] (the fluid) + [lattice] (the modes)
const stage = document.createElement('div');
stage.id = 'stage';

const plate = document.createElement('div');
plate.id = 'plate';
const canvas = document.createElement('canvas');
canvas.id = 'fluid';
canvas.width = config.canvasSize;
canvas.height = config.canvasSize;
plate.appendChild(canvas);
stage.appendChild(plate);

/**
 * The lattice: one cell per eigenmode, laid out by (k1, k2) with (1,1) at the
 * bottom left. It is a keyboard and a spectrum display at once. Pressing a cell
 * puts that mode into the fluid; every cell glows with how much of its mode the
 * fluid holds, whoever put it there.
 *
 * A single mode is a steady solution of the fluid equations, so one cell alone
 * is a pure note with a fixed shape. Two or more different modes exchange
 * energy, and the pattern starts to flow.
 */
const lattice = document.createElement('div');
lattice.id = 'lattice';
const side = Math.max(...sim.pairs.map((p) => Math.max(p.k1, p.k2)));
lattice.style.setProperty('--side', String(side));
/** Cell element for each mode index, or undefined where the rank has no mode. */
const cells: (HTMLElement | undefined)[] = [];
for (let k2 = side; k2 >= 1; k2--) {
  for (let k1 = 1; k1 <= side; k1++) {
    const cell = document.createElement('div');
    cell.className = 'lattice-cell';
    const k = sim.pairs.findIndex((p) => p.k1 === k1 && p.k2 === k2);
    if (k >= 0) {
      cell.dataset.mode = `${k1},${k2}`;
      cell.dataset.index = String(k);
      cells[k] = cell;
    } else {
      cell.classList.add('is-empty');
    }
    lattice.appendChild(cell);
  }
}
stage.appendChild(lattice);

document.querySelector<HTMLDivElement>('#app')!.appendChild(stage);
const renderer = new FluidRenderer(canvas);

function startAudio(): void {
  if (sonifier.started) return;
  const eigenvalues: number[] = [];
  for (let k = 0; k < config.rank; k++) eigenvalues.push(sim.eigenvalue(k));
  sonifier.init(eigenvalues);
}

lattice.addEventListener('pointerdown', (e) => {
  const index = (e.target as HTMLElement).dataset?.index;
  if (index === undefined) return;
  startAudio();
  sim.w[Number(index)] += config.press;
});

/** Slowly-falling reference for the glow, so cells dim as the fluid settles. */
let glowPeak = 1;

function drawLattice(): void {
  let top = 0;
  for (let k = 0; k < config.rank; k++) top = Math.max(top, Math.abs(sim.w[k]));
  glowPeak = Math.max(top, glowPeak * 0.999, 1);
  for (let k = 0; k < config.rank; k++) {
    // Square root, so a mode at a tenth of the loudest is still visible.
    cells[k]?.style.setProperty('--glow', Math.sqrt(Math.abs(sim.w[k]) / glowPeak).toFixed(3));
  }
}

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
  startAudio();

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
  drawLattice();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Measurement hook, dev server only: tools/measure.mjs reads w through this.
if (import.meta.env.DEV) {
  (window as unknown as { __lfs: unknown }).__lfs = { sim, config };
}
