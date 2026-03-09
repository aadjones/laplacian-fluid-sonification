import './style.css';
import { FluidSim } from './sim/fluid';
import { FluidRenderer } from './viz/renderer';
import { Sonifier } from './audio/sonifier';

// --- Configuration (editable via panel) ---
const config = {
  rank: 32,
  grid: 128,
  canvasSize: 512,
  stepsPerFrame: 50,
  dt: 0.0001,
  viscosity: 0.005,
  force: 5000,
};

// --- Mutable state ---
type Mode = 'sim' | 'compose';
let mode: Mode = 'sim';
let audioStarted = false;
let paused = false;
let sim = new FluidSim({ rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity });
let sonifier = new Sonifier({ fundamental: 110, octaveScale: 2, masterGain: 0.3 });

// Inject initial impulse
sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);

// --- DOM setup ---
const app = document.querySelector<HTMLDivElement>('#app')!;

function createApp(): {
  canvas: HTMLCanvasElement;
  modeDisplay: HTMLDivElement;
  modeTable: HTMLDivElement;
  configPanel: HTMLDivElement;
  fpsDisplay: HTMLSpanElement;
} {
  const container = document.createElement('div');
  container.id = 'container';

  const h1 = document.createElement('h1');
  h1.textContent = 'Laplacian Fluid Sonification';
  container.appendChild(h1);

  // Main area: canvas + config panel side by side on wide screens
  const mainArea = document.createElement('div');
  mainArea.id = 'main-area';

  const canvas = document.createElement('canvas');
  canvas.id = 'fluid';
  canvas.width = config.canvasSize;
  canvas.height = config.canvasSize;
  mainArea.appendChild(canvas);

  const configPanel = document.createElement('div');
  configPanel.id = 'config-panel';
  mainArea.appendChild(configPanel);

  container.appendChild(mainArea);

  const controls = document.createElement('div');
  controls.id = 'controls';

  const statusRow = document.createElement('div');
  statusRow.id = 'status-row';

  const modeDisplay = document.createElement('div');
  modeDisplay.id = 'mode-display';
  modeDisplay.textContent = 'Mode: Simulation';
  statusRow.appendChild(modeDisplay);

  const fpsDisplay = document.createElement('span');
  fpsDisplay.id = 'fps-display';
  statusRow.appendChild(fpsDisplay);

  controls.appendChild(statusRow);

  const instructions = document.createElement('div');
  instructions.id = 'instructions';
  instructions.textContent = 'Drag canvas to inject vorticity · Space pause · S toggle sound · M switch sim/compose · R reset';
  controls.appendChild(instructions);

  const modeTable = document.createElement('div');
  modeTable.id = 'mode-table';
  controls.appendChild(modeTable);

  container.appendChild(controls);
  app.appendChild(container);

  return { canvas, modeDisplay, modeTable, configPanel, fpsDisplay };
}

const { canvas, modeDisplay, modeTable, configPanel, fpsDisplay } = createApp();
let renderer = new FluidRenderer(canvas);

// --- Config panel ---
interface SliderDef {
  key: keyof typeof config;
  label: string;
  min: number;
  max: number;
  step: number;
  cold?: boolean; // requires sim rebuild
  format?: (v: number) => string;
}

const sliders: SliderDef[] = [
  { key: 'rank', label: 'Modes (rank)', min: 4, max: 64, step: 4, cold: true },
  { key: 'grid', label: 'Grid', min: 32, max: 256, step: 32, cold: true },
  { key: 'viscosity', label: 'Viscosity', min: 0, max: 0.05, step: 0.001, format: v => v.toFixed(3) },
  { key: 'stepsPerFrame', label: 'Steps/frame', min: 1, max: 100, step: 1 },
  { key: 'force', label: 'Click force', min: 500, max: 20000, step: 500 },
  { key: 'dt', label: 'Timestep', min: 0.00001, max: 0.001, step: 0.00001, cold: true, format: v => v.toFixed(5) },
];

function buildConfigPanel(): void {
  while (configPanel.firstChild) configPanel.removeChild(configPanel.firstChild);

  const heading = document.createElement('div');
  heading.className = 'panel-heading';
  heading.textContent = 'Configuration';
  configPanel.appendChild(heading);

  for (const def of sliders) {
    const row = document.createElement('div');
    row.className = 'config-row';

    const label = document.createElement('label');
    label.textContent = def.label;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(config[def.key]);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'config-value';
    const fmt = def.format ?? ((v: number) => String(v));
    valueSpan.textContent = fmt(config[def.key]);

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      (config as Record<string, number>)[def.key] = val;
      valueSpan.textContent = fmt(val);

      if (def.cold) {
        rebuildSim();
      } else {
        // Hot update: apply immediately
        sim.config.viscosity = config.viscosity;
      }
    });

    row.appendChild(input);
    row.appendChild(valueSpan);
    configPanel.appendChild(row);
  }
}

function rebuildSim(): void {
  const oldW = sim.w;
  sim = new FluidSim({ rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity });

  // Preserve as many coefficients as possible from the old state
  const copyLen = Math.min(oldW.length, sim.w.length);
  for (let i = 0; i < copyLen; i++) sim.w[i] = oldW[i];

  // If all zeros (fresh or old was empty), seed with an impulse
  let energy = 0;
  for (let i = 0; i < sim.w.length; i++) energy += sim.w[i] * sim.w[i];
  if (energy < 1e-10) {
    sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);
  }

  sim.reconstruct();

  // Rebuild sonifier if audio was started
  if (audioStarted) {
    sonifier = new Sonifier({ fundamental: 64, octaveScale: 1.75, masterGain: 0.3 });
    audioStarted = false;
  }

  buildModeTable();
}

buildConfigPanel();

// --- Mode table ---
function buildModeTable(): void {
  while (modeTable.firstChild) modeTable.removeChild(modeTable.firstChild);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['#', '(k\u2081,k\u2082)', '\u03BB', 'freq', 'w']) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const displayRank = sim.config.rank; // cap table rows
  for (let k = 0; k < displayRank; k++) {
    const { k1, k2 } = sim.pairs[k];
    const lam = sim.eigenvalue(k);
    const freq = audioStarted ? sonifier.getFrequency(k).toFixed(1) : '\u2014';

    const tr = document.createElement('tr');
    const cells = [
      String(k),
      `(${k1},${k2})`,
      String(lam),
      freq,
      '0',
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      td.textContent = cells[i];
      if (i === 4) td.id = `w-${k}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  modeTable.appendChild(table);
}
buildModeTable();

function updateModeTable(): void {
  const displayRank = sim.config.rank;
  for (let k = 0; k < displayRank; k++) {
    const el = document.getElementById(`w-${k}`);
    if (el) el.textContent = sim.w[k].toFixed(4);
  }
}

// --- Interaction ---
function ensureAudio(): void {
  if (!audioStarted) {
    sonifier.init(sim);
    audioStarted = true;
    buildModeTable();
  }
}

function canvasInject(e: MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;
  const gx = Math.min(cx * (config.grid - 1), config.grid - 2);
  const gy = Math.min(cy * (config.grid - 1), config.grid - 2);

  const dx = gx - config.grid / 2;
  const dy = gy - config.grid / 2;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  sim.injectImpulse(gx, gy, (dx / len) * config.force, (dy / len) * config.force);
  sim.reconstruct();
}

let dragging = false;
canvas.addEventListener('mousedown', (e) => {
  ensureAudio();
  dragging = true;
  canvasInject(e);
});
canvas.addEventListener('mousemove', (e) => {
  if (dragging) canvasInject(e);
});
window.addEventListener('mouseup', () => { dragging = false; });

document.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    paused = !paused;
  } else if (e.key === 's' || e.key === 'S') {
    ensureAudio();
    sonifier.toggle();
  } else if (e.key === 'm' || e.key === 'M') {
    mode = mode === 'sim' ? 'compose' : 'sim';
    modeDisplay.textContent = `Mode: ${mode === 'sim' ? 'Simulation' : 'Compose'}`;
  } else if (e.key === 'r' || e.key === 'R') {
    sim.w.fill(0);
    sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);
    sim.reconstruct();
  } else if (e.key >= '1' && e.key <= '9' && mode === 'compose') {
    const k = parseInt(e.key) - 1;
    if (k < config.rank) {
      sim.w[k] += 10;
      sim.reconstruct();
    }
  }
});

// --- FPS counter ---
let frameCount = 0;
let lastFpsTime = performance.now();

// --- Main loop ---
function frame(): void {
  if (!paused && mode === 'sim') {
    for (let i = 0; i < config.stepsPerFrame; i++) {
      sim.step();
    }
  }

  renderer.render(sim);
  updateModeTable();

  if (audioStarted) {
    sonifier.updateFromSim(sim);
  }

  // FPS
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fpsDisplay.textContent = `${frameCount} fps`;
    frameCount = 0;
    lastFpsTime = now;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
