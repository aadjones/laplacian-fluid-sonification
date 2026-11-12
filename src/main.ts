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
 * The picture is drawn from it and the sound is read from it. The lattice of
 * pads is the only input: each pad puts one mode into the fluid or takes it out.
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
  /**
   * How much faster the dye and particles travel than the fluid itself. They
   * are passive tracers and change nothing in `w` or the sound. At true speed
   * one note turns its cells by about an eighth of a turn before it fades,
   * which reads as a diagram, not a liquid.
   */
  tracerSpeed: 6,
  /**
   * How much one press of a lattice cell adds to its mode. Soft on purpose:
   * at 100 a two-note chord keeps about 90% of its motion in the two notes and
   * wakes a few neighbours.
   */
  press: 100,
};

/** A mode holding more than this share of a press counts as sounding. */
const SOUNDING = 0.3;
/** Seconds for a muted mode to fall to 1/e, and how long the damper stays on it. */
const MUTE_TC = 0.08;
const MUTE_HOLD = 0.5;

const sim = new FluidSim({
  rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity,
  drag: config.drag,
});
const dye = new DyeField(config.grid, config.grid);
const particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
const sonifier = new Sonifier();
const vorticity = new Float64Array(config.grid * config.grid);
/** Where each particle was before this frame, for drawing its streak. */
const previousPositions = particles.positions.slice();

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

/**
 * Modes with a damper on them, and the seconds each has left. A damper is a
 * finger on the plate: it takes that one mode out of the fluid and holds it
 * out briefly, so its neighbours cannot refill it the instant it is released.
 */
const dampers = new Map<number, number>();

// One press, one mode: a dark cell sounds, a bright cell is muted. Each finger
// is its own pointer, so several cells can be pressed at once.
lattice.addEventListener('pointerdown', (e) => {
  const index = (e.target as HTMLElement).dataset?.index;
  if (index === undefined) return;
  startAudio();
  const k = Number(index);
  if (Math.abs(sim.w[k]) > SOUNDING * config.press) {
    dampers.set(k, MUTE_HOLD);
  } else {
    dampers.delete(k);
    sim.w[k] += config.press;
    releaseDye(k);
  }
});

/**
 * A note releases dye into its own figure: one thin streak per cell, from near
 * the cell's centre out toward its edge, coloured by the way that cell turns.
 * The fluid turns faster near the middle of a cell than at its rim, so the
 * streak is wound into a spiral. A round drop would only drift.
 */
function releaseDye(k: number): void {
  const { k1, k2 } = sim.pairs[k];
  const span = config.grid - 1;
  const cellW = span / k1;
  const cellH = span / k2;
  const radius = Math.max(1.1, 0.035 * Math.min(cellW, cellH));
  const spin = Math.sign(sim.w[k]) || 1;
  const DROPS = 7;
  for (let j = 0; j < k2; j++) {
    for (let i = 0; i < k1; i++) {
      const warm = ((i + j) % 2 === 0 ? 1 : -1) * spin > 0;
      for (let d = 0; d < DROPS; d++) {
        // From 8% to 44% of the way across the cell, along its long axis.
        const t = 0.08 + (0.36 * d) / (DROPS - 1);
        dye.inject(
          (i + 0.5 + (cellW >= cellH ? t : 0)) * cellW,
          (j + 0.5 + (cellW >= cellH ? 0 : t)) * cellH,
          warm ? 1.0 : 0.25, 0.55, warm ? 0.25 : 1.0,
          radius,
        );
      }
    }
  }
}

// Escape mutes everything: a damper on every mode. No on-screen control.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (let k = 0; k < config.rank; k++) dampers.set(k, MUTE_HOLD);
});

function applyDampers(seconds: number): void {
  const keep = Math.exp(-seconds / MUTE_TC);
  for (const [k, left] of dampers) {
    sim.w[k] *= keep;
    if (left <= seconds) dampers.delete(k);
    else dampers.set(k, left - seconds);
  }
}

function drawLattice(): void {
  for (let k = 0; k < config.rank; k++) {
    // Against one press, not against the loudest mode, so a bright cell always
    // means the same thing. Square root keeps a quiet mode visible.
    const level = Math.min(1, Math.abs(sim.w[k]) / config.press);
    cells[k]?.style.setProperty('--glow', Math.sqrt(level).toFixed(3));
  }
}

// --- Loop ---

let lastFrame = performance.now();

function frame(): void {
  const now = performance.now();
  const seconds = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  applyDampers(seconds);
  for (let i = 0; i < config.stepsPerFrame; i++) sim.step();

  const tracerDt = config.dt * config.stepsPerFrame * config.tracerSpeed;
  dye.advect(sim.velocity, tracerDt);
  dye.dissipate(0.995);
  previousPositions.set(particles.positions);
  particles.advect(sim.velocity, config.grid, config.grid, tracerDt, 1);

  // Sound before picture: the audio path should not wait on rendering.
  sonifier.update(sim.w);

  sim.computeVorticity(vorticity);
  renderer.render(sim, dye, vorticity, config.press);
  renderer.renderParticles(particles, previousPositions, config.grid, config.grid);
  drawLattice();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Measurement hook, dev server only: tools/measure.mjs reads w through this.
if (import.meta.env.DEV) {
  (window as unknown as { __lfs: unknown }).__lfs = { sim, config };
}
