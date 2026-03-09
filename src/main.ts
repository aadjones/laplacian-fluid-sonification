import './style.css';
import { FluidSim } from './sim/fluid';
import { FluidRenderer } from './viz/renderer';
import { Sonifier } from './audio/sonifier';

// --- Configuration ---
const RANK = 16;
const GRID = 64;
const CANVAS_SIZE = 512;
const SIM_STEPS_PER_FRAME = 50; // multiple substeps per render frame
const DT = 0.0001;

// --- State ---
type Mode = 'sim' | 'compose';
let mode: Mode = 'sim';
let audioStarted = false;
let paused = false;

// --- Setup ---
const sim = new FluidSim({ rank: RANK, xRes: GRID, yRes: GRID, dt: DT, viscosity: 0 });
const sonifier = new Sonifier({ fundamental: 64, octaveScale: 1.75, masterGain: 0.3 });

// Inject initial impulse (vertical, center of domain)
sim.injectImpulse(GRID / 2, GRID / 2, 0, 1000);

// --- DOM setup using safe DOM methods ---
const app = document.querySelector<HTMLDivElement>('#app')!;

function createApp(): {
  canvas: HTMLCanvasElement;
  modeDisplay: HTMLDivElement;
  modeTable: HTMLDivElement;
} {
  const container = document.createElement('div');
  container.id = 'container';

  const h1 = document.createElement('h1');
  h1.textContent = 'Laplacian Fluid Sonification';
  container.appendChild(h1);

  const canvas = document.createElement('canvas');
  canvas.id = 'fluid';
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  container.appendChild(canvas);

  const controls = document.createElement('div');
  controls.id = 'controls';

  const modeDisplay = document.createElement('div');
  modeDisplay.id = 'mode-display';
  modeDisplay.textContent = 'Mode: Simulation';
  controls.appendChild(modeDisplay);

  const instructions = document.createElement('div');
  instructions.id = 'instructions';
  instructions.textContent = 'Click canvas to inject vorticity · Space pause · S toggle sound · M switch sim/compose · R reset';
  controls.appendChild(instructions);

  const modeTable = document.createElement('div');
  modeTable.id = 'mode-table';
  controls.appendChild(modeTable);

  container.appendChild(controls);
  app.appendChild(container);

  return { canvas, modeDisplay, modeTable };
}

const { canvas, modeDisplay, modeTable } = createApp();
const renderer = new FluidRenderer(canvas);

// --- Mode table: shows eigenvalue, frequency, w[k] for each mode ---
function buildModeTable(): void {
  // Clear existing content
  while (modeTable.firstChild) modeTable.removeChild(modeTable.firstChild);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['#', '(k₁,k₂)', 'λ', 'freq', 'w']) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let k = 0; k < RANK; k++) {
    const { k1, k2 } = sim.pairs[k];
    const lam = sim.eigenvalue(k);
    const freq = audioStarted ? sonifier.getFrequency(k).toFixed(1) : '—';

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
  for (let k = 0; k < RANK; k++) {
    const el = document.getElementById(`w-${k}`);
    if (el) el.textContent = sim.w[k].toFixed(4);
  }
}

// --- Interaction ---
canvas.addEventListener('click', (e) => {
  // Start audio on first click (autoplay policy)
  if (!audioStarted) {
    sonifier.init(sim);
    audioStarted = true;
    buildModeTable(); // rebuild to show frequencies
  }

  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;
  const gx = cx * GRID;
  const gy = cy * GRID;

  // Impulse direction: away from center
  const dx = gx - GRID / 2;
  const dy = gy - GRID / 2;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  sim.injectImpulse(gx, gy, (dx / len) * 500, (dy / len) * 500);
});

document.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    paused = !paused;
  } else if (e.key === 's' || e.key === 'S') {
    if (!audioStarted) {
      sonifier.init(sim);
      audioStarted = true;
      buildModeTable();
    }
    sonifier.toggle();
  } else if (e.key === 'm' || e.key === 'M') {
    mode = mode === 'sim' ? 'compose' : 'sim';
    modeDisplay.textContent = `Mode: ${mode === 'sim' ? 'Simulation' : 'Compose'}`;
  } else if (e.key === 'r' || e.key === 'R') {
    sim.w.fill(0);
    sim.injectImpulse(GRID / 2, GRID / 2, 0, 1000);
  } else if (e.key >= '1' && e.key <= '9' && mode === 'compose') {
    // In compose mode, number keys activate individual modes
    const k = parseInt(e.key) - 1;
    if (k < RANK) {
      sim.w[k] += 10;
      sim.reconstruct();
    }
  }
});

// --- Main loop ---
function frame(): void {
  if (!paused && mode === 'sim') {
    for (let i = 0; i < SIM_STEPS_PER_FRAME; i++) {
      sim.step();
    }
  }

  renderer.render(sim);
  updateModeTable();

  if (audioStarted) {
    sonifier.updateFromSim(sim);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
