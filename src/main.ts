import './style.css';
import { FluidSim } from './sim/fluid';
import { FluidRenderer } from './viz/renderer';
import { Sonifier } from './audio/sonifier';
import { ParticleSystem } from './sim/particles';
import { DyeField } from './sim/dye';

// --- Configuration (editable via panel) ---
const config = {
  rank: 32,
  grid: 128,
  canvasSize: 512,
  stepsPerFrame: 2,
  dt: 0.0001,
  viscosity: 0.5,
  force: 300,
  particleCount: 8000,
  forceStrength: 50,
};

// --- Mutable state ---
let audioStarted = false;
let paused = false;
let sim = new FluidSim({ rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity });
let sonifier = new Sonifier({ freqLow: 55, freqHigh: 4000, masterGain: 0.3 });
let particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
let dye = new DyeField(config.grid, config.grid);
let forceTime = 0;

// Mode-selective forcing: which modes are being driven (toggle with number keys)
const forcedModes = new Set<number>([1]); // start with mode 1 (the (2,1) mode)

// Inject initial impulse
sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);

// --- DOM setup ---
const app = document.querySelector<HTMLDivElement>('#app')!;

function createApp(): {
  canvas: HTMLCanvasElement;
  modeDisplay: HTMLDivElement;
  strategyDisplay: HTMLDivElement;
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
  modeDisplay.textContent = 'Modes: 1';
  statusRow.appendChild(modeDisplay);

  const strategyDisplay = document.createElement('div');
  strategyDisplay.id = 'strategy-display';
  strategyDisplay.textContent = 'Audio: —';
  statusRow.appendChild(strategyDisplay);

  const fpsDisplay = document.createElement('span');
  fpsDisplay.id = 'fps-display';
  statusRow.appendChild(fpsDisplay);

  controls.appendChild(statusRow);

  const instructions = document.createElement('div');
  instructions.id = 'instructions';
  instructions.textContent = 'Drag to inject vorticity · 1-9 toggle modes · 0 clear modes · Space pause · S sound · A audio strategy · R reset · Enter fullscreen';
  controls.appendChild(instructions);

  const modeTable = document.createElement('div');
  modeTable.id = 'mode-table';
  controls.appendChild(modeTable);

  container.appendChild(controls);
  app.appendChild(container);

  return { canvas, modeDisplay, strategyDisplay, modeTable, configPanel, fpsDisplay };
}

const { canvas, modeDisplay, strategyDisplay, modeTable, configPanel, fpsDisplay } = createApp();
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
  { key: 'viscosity', label: 'Viscosity', min: 0, max: 5, step: 0.1, format: v => v.toFixed(1) },
  { key: 'force', label: 'Click force', min: 10, max: 1000, step: 10 },
  { key: 'dt', label: 'Timestep', min: 0.00005, max: 0.0003, step: 0.00001, cold: true, format: v => v.toFixed(5) },
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
  particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
  dye = new DyeField(config.grid, config.grid);
  forceTime = 0;

  // Rebuild sonifier if audio was started
  if (audioStarted) {
    sonifier = new Sonifier({ freqLow: 55, freqHigh: 4000, masterGain: 0.3 });
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
    sonifier.onStrategyChange = (name) => {
      strategyDisplay.textContent = `Audio: ${name}`;
    };
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
  // Inject cool dye at click point
  dye.inject(gx, gy, 0.1, 0.4, 0.9, 4);
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
  } else if (e.key === 'a' || e.key === 'A') {
    ensureAudio();
    sonifier.nextStrategy();
  } else if (e.key >= '1' && e.key <= '9') {
    const modeIdx = parseInt(e.key);
    if (modeIdx < sim.config.rank) {
      if (forcedModes.has(modeIdx)) {
        forcedModes.delete(modeIdx);
      } else {
        forcedModes.add(modeIdx);
      }
      modeDisplay.textContent = forcedModes.size > 0
        ? `Modes: ${[...forcedModes].sort().join(', ')}`
        : 'Modes: none';
    }
  } else if (e.key === '0') {
    forcedModes.clear();
    modeDisplay.textContent = 'Modes: none';
  } else if (e.key === 'r' || e.key === 'R') {
    sim.w.fill(0);
    sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);
    sim.reconstruct();
    particles.seed(config.grid, config.grid);
    dye.clear();
    forceTime = 0;
  } else if (e.key === 'Enter') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }
});

// --- FPS counter ---
let frameCount = 0;
let lastFpsTime = performance.now();

// --- Main loop ---
function frame(): void {
  if (!paused) {
    for (let i = 0; i < config.stepsPerFrame; i++) {
      // Mode-selective forcing: directly drive w[k] for toggled modes
      if (forcedModes.size > 0) {
        forceTime += config.dt;
        for (const k of forcedModes) {
          const lam = sim.eigenvalue(k);
          const phase = forceTime * Math.sqrt(lam) * 50;
          sim.w[k] += Math.sin(phase) * config.forceStrength * 0.1;
        }
      }
      sim.step();
    }

    // Inject dye at forced mode antinodes
    if (forcedModes.size > 0) {
      for (const k of forcedModes) {
        const { k1, k2 } = sim.pairs[k];
        // Antinode is at the center of the first lobe: π/(2·k₁), π/(2·k₂)
        const gx = (config.grid - 1) / (2 * k1);
        const gy = (config.grid - 1) / (2 * k2);
        // Color varies by mode index
        const hue = k * 0.7;
        dye.inject(gx, gy,
          0.15 + 0.1 * Math.sin(hue),
          0.1 + 0.1 * Math.sin(hue + 2),
          0.15 + 0.1 * Math.sin(hue + 4),
          3);
      }
    }

    // Advect dye and particles once per frame
    const frameDt = config.dt * config.stepsPerFrame;
    dye.advect(sim.velocity, frameDt);
    dye.dissipate(0.985);
    particles.advect(sim.velocity, config.grid, config.grid, frameDt, 1);
  }

  renderer.render(sim, dye);
  renderer.renderParticles(particles, config.grid, config.grid);
  updateModeTable();

  if (audioStarted) {
    sonifier.updateFromSim(sim);
  }

  // FPS
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    const cflStr = sim.cfl.toFixed(3);
    fpsDisplay.textContent = `${frameCount} fps · CFL ${cflStr}`;
    frameCount = 0;
    lastFpsTime = now;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
