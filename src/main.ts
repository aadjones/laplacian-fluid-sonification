import './style.css';
import { FluidSim } from './sim/fluid';
import { GpuRenderer } from './viz/gpuRenderer';
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
  /**
   * The solver's own velocity grid. Nothing is drawn from it any more (the
   * renderer evaluates the modes per pixel), so it is kept as small as it goes.
   */
  grid: 32,
  stepsPerFrame: 2,
  dt: 0.0001,
  viscosity: 0.5,
  /**
   * Even damping on every mode; this is what lets a note end. At 40 a low note
   * falls 20 dB in about 4.7 s and the highest in about 1.9 s. Viscosity alone
   * left the lowest mode ringing for over a minute.
   */
  drag: 40,
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
  /**
   * Playing harder: while a pad is held it keeps pushing its mode, this much
   * per second for at most `holdSeconds`. A tap is the soft note above; a full
   * hold reaches about three times that, where a chord breaks into a wash.
   * A pad controller's strike velocity will feed the same quantity.
   */
  holdRate: 250,
  holdSeconds: 1,
  /**
   * Stirring: dragging on the plate pushes the fluid along the drag, softly
   * and over a wide area, so it sets the large slow modes drifting without
   * choosing a note. `stirRate` is the force per second at full drag speed,
   * `stirSpread` the width of the push (the plate is π wide), and
   * `stirFullSpeed` the drag speed, in plate widths per second, that reaches
   * full force.
   */
  stirRate: 1000,
  stirSpread: 0.5,
  stirFullSpeed: 1.5,
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
const sonifier = new Sonifier();

// [page] > [stage] > [plate] (the fluid) + [lattice] (the modes)
const stage = document.createElement('div');
stage.id = 'stage';

const plate = document.createElement('div');
plate.id = 'plate';
const canvas = document.createElement('canvas');
canvas.id = 'fluid';
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
const renderer = new GpuRenderer(canvas, side);

/** Mode index for each lattice position, or -1 where the rank has no mode. */
const modeAt: number[][] = [];
for (let k1 = 1; k1 <= side; k1++) {
  modeAt[k1] = [];
  for (let k2 = 1; k2 <= side; k2++) {
    modeAt[k1][k2] = sim.pairs.findIndex((p) => p.k1 === k1 && p.k2 === k2);
  }
}
const weightAt = (k1: number, k2: number): number => {
  const k = modeAt[k1][k2];
  return k >= 0 ? sim.w[k] : 0;
};

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

/** Pads being held down: pointer id to the mode it is pushing and for how long. */
const held = new Map<number, { mode: number; seconds: number }>();

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
    held.set(e.pointerId, { mode: k, seconds: 0 });
    // Keep hearing about this finger even if it slides off the pad. Throws for
    // a pointer the browser is not tracking, which only a synthetic event is.
    try { lattice.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  }
});
const letGo = (e: PointerEvent): void => { held.delete(e.pointerId); };
lattice.addEventListener('pointerup', letGo);
lattice.addEventListener('pointercancel', letGo);

/** Held pads keep pushing their modes. */
function applyHolds(seconds: number): void {
  for (const [id, h] of held) {
    const push = Math.min(seconds, config.holdSeconds - h.seconds);
    if (push <= 0) { held.delete(id); continue; }
    sim.w[h.mode] += config.holdRate * push;
    h.seconds += push;
  }
}

// --- Stir ---

/** Where the stirring pointer was last, in plate space [0,1]², and when. */
let stir: { id: number; x: number; y: number; t: number } | null = null;

function platePos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  startAudio();
  stir = { id: e.pointerId, ...platePos(e), t: performance.now() };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
});

canvas.addEventListener('pointermove', (e) => {
  if (!stir || e.pointerId !== stir.id) return;
  const { x, y } = platePos(e);
  const now = performance.now();
  const seconds = Math.min(0.05, Math.max(1e-3, (now - stir.t) / 1000));
  const dx = x - stir.x;
  const dy = y - stir.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 1e-6) {
    // Force along the drag, growing with its speed. Scaled by elapsed time, so
    // a stir is the same push however many move events the browser sends.
    const speed = Math.min(1, dist / seconds / config.stirFullSpeed);
    const force = config.stirRate * speed * seconds;
    sim.push(x * Math.PI, y * Math.PI, (dx / dist) * force, (dy / dist) * force, config.stirSpread);
  }
  stir = { id: stir.id, x, y, t: now };
});

const endStir = (e: PointerEvent): void => {
  if (stir && e.pointerId === stir.id) stir = null;
};
canvas.addEventListener('pointerup', endStir);
canvas.addEventListener('pointercancel', endStir);

/** A note releases dye into its own figure. See GpuRenderer.injectDye. */
function releaseDye(k: number): void {
  const { k1, k2 } = sim.pairs[k];
  renderer.injectDye(k1, k2, Math.sign(sim.w[k]) || 1);
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
  applyHolds(seconds);
  for (let i = 0; i < config.stepsPerFrame; i++) sim.step();

  // Sound before picture: the audio path should not wait on rendering.
  sonifier.update(sim.w);

  const tracerStep = config.dt * config.stepsPerFrame * config.tracerSpeed;
  renderer.render(weightAt, tracerStep, config.press);
  drawLattice();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Measurement hook, dev server only: tools/measure.mjs reads w through this.
if (import.meta.env.DEV) {
  (window as unknown as { __lfs: unknown }).__lfs = { sim, config };
}
