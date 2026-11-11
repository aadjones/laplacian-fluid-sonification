import './style.css';
import { FluidSim } from './sim/fluid';
import { FluidRenderer } from './viz/renderer';
import { Sonifier } from './audio/sonifier';
import { ParticleSystem } from './sim/particles';
import { DyeField } from './sim/dye';
import { Sediment } from './sim/sediment';
import { buildFamilies, familyMask, strikeFamily, strikeVector, strikeWeights, type HarmonicFamily } from './sim/families';

// --- Configuration (editable via panel) ---
const config = {
  rank: 576,
  grid: 128,
  canvasSize: 512,
  stepsPerFrame: 2,
  dt: 0.0001,
  viscosity: 0.5,
  particleCount: 8000,
  /** How hard you play. Sets tap force, bow pressure, strike level and velocity. */
  strikeForce: 300,
  maxHarmonics: 8,
  /** Hammer: 0 is a felt mallet, 1 a metal tine. See audio/strategies/struckModal. */
  hammerHardness: 0.55,
  /** Fractional strike point. Near 1/7 notches the septimal partial. */
  strikePosition: 0.13,
};

// --- Mutable state ---
let audioStarted = false;
let paused = false;
let sim = new FluidSim({ rank: config.rank, xRes: config.grid, yRes: config.grid, dt: config.dt, viscosity: config.viscosity });
let sonifier = new Sonifier({ masterGain: 0.3 });
let particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
let dye = new DyeField(config.grid, config.grid);
/** Where the instrument has been touched. See sim/sediment.ts. */
let sediment = new Sediment(config.rank);
/** Share of the memory's headroom one tap fills in the modes it excites most. */
const TAP_DEPOSIT = 0.2;
/** The same, per second of full-speed stirring. */
const STIR_DEPOSIT_RATE = 0.6;

/**
 * Sustain: hold the selected stack against the damping (H).
 *
 * This replaces the old per-mode forcing on 1-9, which pumped individual modes
 * sinusoidally at √λ·50 — a rate with no referent, since the reduced equation
 * is first order and λ is a decay rate rather than a temporal frequency. A
 * stack is the principled version of "drive these modes", so the mechanism
 * survived and its target changed.
 *
 * Off at startup. A struck instrument's ground state has to be silence, or
 * every note is heard against a drone and no decay resolves into anything.
 */
let sustaining = false;
/** The stack currently being held, so a change can release the previous one. */
let sustainedStack: HarmonicFamily | null = null;
/** Modes being damped back down after release. */
let releasing: number[] = [];

/** Shortest family offered as a playable stack. */
const MIN_HARMONICS = 2;

/**
 * Harmonic stacks. Sonifying every mode cannot produce pitch — the spectrum is
 * denser than the ear's critical bands — so [ and ] solo one family at a time
 * and K strikes it. See sim/families.ts.
 *
 * Two harmonics is enough to be a note: a fundamental with its octave is the
 * purest tone here, not the thinnest. Rank governs how many stacks exist, since
 * a family only extends as far as (np,nq) stays in the basis — 43 stacks at
 * rank 256, 91 at 576, 159 at 1024 — while `maxHarmonics` governs how each one
 * sounds, low for a flute and high for a reed.
 */
let families: HarmonicFamily[] = buildFamilies(sim.pairs, MIN_HARMONICS, config.maxHarmonics);
let stackIndex = -1; // -1 = no solo, every mode sounds
let stackMask: Float64Array | null = null;

/** Underlay brightening while a stack is soloed, where the pattern is the subject. */
const SOLO_VORT_GAIN = 4;


let vorticity = new Float64Array(config.grid * config.grid);

// Inject initial impulse
sim.injectImpulse(config.grid / 2, config.grid / 2, 0, 1000);

// --- DOM setup ---
const app = document.querySelector<HTMLDivElement>('#app')!;

function createApp(): {
  canvas: HTMLCanvasElement;
  modeDisplay: HTMLDivElement;
  stackDisplay: HTMLDivElement;
  strategyDisplay: HTMLDivElement;
  configPanel: HTMLDivElement;
  stackPicker: HTMLDivElement;
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

  const sidePanel = document.createElement('div');
  sidePanel.id = 'side-panel';

  const configPanel = document.createElement('div');
  configPanel.id = 'config-panel';
  sidePanel.appendChild(configPanel);

  const stackPicker = document.createElement('div');
  stackPicker.id = 'stack-picker';
  sidePanel.appendChild(stackPicker);

  mainArea.appendChild(sidePanel);

  container.appendChild(mainArea);

  const controls = document.createElement('div');
  controls.id = 'controls';

  const statusRow = document.createElement('div');
  statusRow.id = 'status-row';

  const modeDisplay = document.createElement('div');
  modeDisplay.id = 'mode-display';
  modeDisplay.textContent = 'Sustain: off';
  statusRow.appendChild(modeDisplay);

  const stackDisplay = document.createElement('div');
  stackDisplay.id = 'stack-display';
  stackDisplay.textContent = 'Stack: all modes';
  statusRow.appendChild(stackDisplay);

  const strategyDisplay = document.createElement('div');
  strategyDisplay.id = 'strategy-display';
  strategyDisplay.textContent = 'Sound: —';
  statusRow.appendChild(strategyDisplay);

  const fpsDisplay = document.createElement('span');
  fpsDisplay.id = 'fps-display';
  statusRow.appendChild(fpsDisplay);

  controls.appendChild(statusRow);

  const instructions = document.createElement('div');
  instructions.id = 'instructions';
  instructions.textContent = 'Click to strike · drag to bow · [ ] pick a stack · K strike it · H sustain · Space pause · S sound · R reset · Enter fullscreen';
  controls.appendChild(instructions);

  container.appendChild(controls);
  app.appendChild(container);

  return { canvas, modeDisplay, stackDisplay, strategyDisplay, configPanel, stackPicker, fpsDisplay };
}

const { canvas, modeDisplay, stackDisplay, strategyDisplay, configPanel, stackPicker, fpsDisplay } = createApp();
let renderer = new FluidRenderer(canvas);

// --- Config panel ---
interface SliderDef {
  key: keyof typeof config;
  label: string;
  min: number;
  max: number;
  step: number;
  cold?: boolean; // requires sim rebuild
  onChange?: () => void; // neither cold nor a hot sim field
  format?: (v: number) => string;
}

const sliders: SliderDef[] = [
  { key: 'rank', label: 'Modes (rank)', min: 4, max: 1024, step: 4, cold: true },
  { key: 'grid', label: 'Grid', min: 32, max: 256, step: 32, cold: true },
  // Viscosity by another name: it is the fluid's decay rate ν and the
  // instrument's damper pedal at once, and players read the second one.
  { key: 'viscosity', label: 'Damping', min: 0, max: 5, step: 0.1, format: v => v.toFixed(1) },
  { key: 'strikeForce', label: 'Strike force', min: 50, max: 1000, step: 10 },
  { key: 'hammerHardness', label: 'Hammer hardness', min: 0, max: 1, step: 0.05, format: v => v.toFixed(2) },
  { key: 'strikePosition', label: 'Strike point', min: 0, max: 0.5, step: 0.01, format: v => (v === 0 ? 'centre' : `1/${(1 / v).toFixed(1)}`) },
  { key: 'maxHarmonics', label: 'Harmonics per stack', min: 2, max: 24, step: 1, onChange: () => rebuildStacks() },
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
      } else if (def.onChange) {
        def.onChange();
      } else {
        applyHotConfig();
      }
    });

    row.appendChild(input);
    row.appendChild(valueSpan);
    configPanel.appendChild(row);
  }
}

/**
 * Push the hot (no-rebuild) settings through.
 *
 * Viscosity goes to two places. In the sim it is the decay rate ν·λ; in the
 * sonifier it sets each partial's ring time 1/(ν·λ), which makes the same
 * slider the instrument's damper pedal.
 */
function applyHotConfig(): void {
  sim.config.viscosity = config.viscosity;
  sonifier.setDamping(config.viscosity);
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
    sim.injectImpulse(config.grid * 0.42, config.grid * 0.37, 380, 1000);
  }

  sim.reconstruct();
  particles = new ParticleSystem(config.particleCount, config.grid, config.grid);
  dye = new DyeField(config.grid, config.grid);
  sediment = new Sediment(config.rank);
  vorticity = new Float64Array(config.grid * config.grid);

  // Both the stack list and the mask are indexed by rank, so neither survives.
  families = buildFamilies(sim.pairs, MIN_HARMONICS, config.maxHarmonics);
  selectStack(-1);
  buildStackPicker();

  // Rebuild sonifier if audio was started
  if (audioStarted) {
    sonifier = new Sonifier({ masterGain: 0.3 });
    // The fresh instance starts on its default damping, so hand it the current
    // viscosity or the first notes after a rank change ring at the wrong length.
    sonifier.setDamping(config.viscosity);
    audioStarted = false;
  }

}

buildConfigPanel();

/**
 * Strike force as a playing velocity in [0,1].
 *
 * Velocity is not just level: a hard blow compresses the felt, shortens the
 * contact time and brightens the strike, so this number also moves the timbre.
 */
function strikeVelocity(): number {
  const t = (config.strikeForce - 50) / 950;
  return 0.2 + 0.8 * Math.min(1, Math.max(0, t));
}

/**
 * Push the sustain gesture to the instrument.
 *
 * Event-driven, not polled: called when the gesture or the stack changes, so
 * moving between stacks releases the held note and articulates the new one
 * rather than layering them — which is what made sustaining feel like it was
 * piling up.
 */
function applySustain(): void {
  if (!audioStarted) return;
  const held = sustaining && stackIndex >= 0 ? families[stackIndex] : null;
  sonifier.sustain(
    held ? strikeVector(sim.config.rank, held, config.strikePosition) : null,
    held ? 1 : 0,
    config.hammerHardness,
  );
}

/** Status line for the sustain gesture. */
function refreshSustainDisplay(): void {
  modeDisplay.textContent = sustaining && stackIndex >= 0
    ? `Sustain: ${families[stackIndex].label}`
    : 'Sustain: off';
}

// --- Harmonic stacks ---

/** Solo one stack, or pass -1 to hear and see the whole rank again. */
function selectStack(index: number): void {
  stackIndex = index;
  stackMask = index < 0 ? null : familyMask(sim.config.rank, families[index]);
  sonifier.setModeMask(stackMask);
  applySustain();
  refreshSustainDisplay();

  if (index < 0) {
    stackDisplay.textContent = 'Stack: all modes';
  } else {
    const fam = families[index];
    const f0 = audioStarted ? ` · ${sonifier.getFrequency(fam.members[0]).toFixed(0)} Hz` : '';
    stackDisplay.textContent =
      `Stack: ${fam.label} · ${fam.members.length} harmonics${f0}`;
  }
  markActiveChip();
}

/**
 * Cycle through [all modes, then every stack] in either direction.
 *
 * Walks `displayOrder` rather than `families`, so the keys move through the
 * list in the order the picker is currently showing it — sorting by pitch turns
 * [ and ] into a way to play up and down.
 */
function cycleStack(step: number): void {
  const states = displayOrder.length + 1;
  const pos = stackIndex < 0 ? -1 : displayOrder.indexOf(stackIndex);
  const next = ((pos + 1 + step + states) % states) - 1;
  selectStack(next < 0 ? -1 : displayOrder[next]);
}

// --- Stack picker ---

type StackSort = 'rich' | 'pitch';

const SORT_LABELS: Record<StackSort, string> = { rich: 'rich', pitch: 'pitch' };

let stackSort: StackSort = 'rich';
/** Indices into `families`, in the order the picker is showing them. */
let displayOrder: number[] = [];
/** Chip elements indexed by family index, for the active highlight. */
let chipEls: HTMLElement[] = [];

/**
 * Recompute the display order.
 *
 * `families` itself stays richest-first — that order is what `stackIndex`
 * means, so re-sorting it would invalidate a live selection and the mask built
 * from it. Only this index list moves.
 *
 * Pitch order sorts on λ rather than on the mapped frequency: all three
 * mappings are monotonic in λ, so one ordering is correct under all of them and
 * survives a press of M. Ties are the transpose twins, which are degenerate in
 * λ; they fall back to richest-first so a pair stays adjacent.
 */
function computeDisplayOrder(): void {
  displayOrder = families.map((_, i) => i);
  if (stackSort === 'pitch') {
    displayOrder.sort((a, b) => {
      const fa = families[a];
      const fb = families[b];
      return (fa.p * fa.p + fa.q * fa.q) - (fb.p * fb.p + fb.q * fb.q) || a - b;
    });
  }
}

/**
 * Rebuild the stack list after a timbre change, holding the player on the same
 * stack — it is the same note, played with more or fewer harmonics.
 */
function rebuildStacks(): void {
  const current = stackIndex >= 0 ? families[stackIndex] : null;
  families = buildFamilies(sim.pairs, MIN_HARMONICS, config.maxHarmonics);
  const again = current
    ? families.findIndex((f) => f.p === current.p && f.q === current.q)
    : -1;
  selectStack(again);
  buildStackPicker();
}

function buildStackPicker(): void {
  while (stackPicker.firstChild) stackPicker.removeChild(stackPicker.firstChild);
  computeDisplayOrder();
  chipEls = [];

  const head = document.createElement('div');
  head.className = 'panel-heading stack-picker-head';

  const title = document.createElement('span');
  title.textContent = `Stacks \u00b7 ${families.length}`;
  head.appendChild(title);

  const sort = document.createElement('div');
  sort.className = 'stack-sort';
  for (const mode of ['rich', 'pitch'] as StackSort[]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = SORT_LABELS[mode];
    if (stackSort === mode) btn.className = 'is-active';
    btn.addEventListener('click', () => {
      if (stackSort === mode) return;
      stackSort = mode;
      buildStackPicker();
    });
    sort.appendChild(btn);
  }
  head.appendChild(sort);
  stackPicker.appendChild(head);

  const chips = document.createElement('div');
  chips.id = 'stack-chips';
  for (const i of displayOrder) {
    const fam = families[i];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stack-chip';

    const name = document.createElement('span');
    name.textContent = fam.label;

    const meta = document.createElement('span');
    meta.className = 'stack-chip-meta';
    meta.textContent = audioStarted
      ? `\u00d7${fam.members.length} \u00b7 ${sonifier.getFrequency(fam.members[0]).toFixed(0)} Hz`
      : `\u00d7${fam.members.length}`;

    chip.append(name, meta);
    chip.addEventListener('click', () => selectStack(i));
    chips.appendChild(chip);
    chipEls[i] = chip;
  }
  stackPicker.appendChild(chips);
  markActiveChip();
}

/** Move the highlight and keep the selected chip in view when [ ] scroll past it. */
function markActiveChip(): void {
  for (let i = 0; i < chipEls.length; i++) {
    chipEls[i]?.classList.toggle('is-active', i === stackIndex);
  }
  if (stackIndex >= 0) chipEls[stackIndex]?.scrollIntoView({ block: 'nearest' });
}

// --- Mode table ---

buildStackPicker();

// --- Interaction ---
function refreshAudioDisplay(): void {
  if (!audioStarted) {
    strategyDisplay.textContent = 'Sound: —';
    return;
  }
  // Say when it is muted. Touching the canvas starts audio, so S is usually the
  // *second* thing that reaches it and reads as "sound on" while actually
  // suspending the context — which is silent in every sense, since a suspended
  // context freezes currentTime and every scheduled strike waits on a clock
  // that never arrives.
  strategyDisplay.textContent = sonifier.isRunning ? 'Sound: on' : 'Sound: muted';
}

function ensureAudio(): void {
  if (!audioStarted) {
    sonifier.init(sim);
    audioStarted = true;
    refreshAudioDisplay();
    // Reapply the mask to the freshly-initialised sonifier and pick up the
    // stack fundamentals, which have no frequency until audio exists.
    selectStack(stackIndex);
    buildStackPicker();
  }
}

/** Drag speed, in grid cells per second, that reaches full click force. */
const POINTER_REF_SPEED = 300;

let lastPointer: { gx: number; gy: number; t: number } | null = null;

function canvasPos(e: MouseEvent): { gx: number; gy: number } {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;
  return {
    gx: Math.min(cx * (config.grid - 1), config.grid - 2),
    gy: Math.min(cy * (config.grid - 1), config.grid - 2),
  };
}

/**
 * Stir the fluid along the gesture.
 *
 * The force direction is the direction the pointer moved and its magnitude
 * scales with drag speed, so dragging left and right through the same cell now
 * do opposite things and a slow stir is gentler than a fast one. Previously the
 * direction was radial from the canvas centre, which meant the entire input
 * channel was one position: no direction, no speed. A press that never moves
 * imparts no momentum, which is what stirring a real fluid does.
 */
function canvasInject(e: MouseEvent): void {
  const { gx, gy } = canvasPos(e);
  const now = performance.now();

  if (lastPointer) {
    const dtSec = Math.max(1e-3, (now - lastPointer.t) / 1000);
    const dgx = gx - lastPointer.gx;
    const dgy = gy - lastPointer.gy;
    const dist = Math.sqrt(dgx * dgx + dgy * dgy);
    if (dist > 1e-6) {
      const speed = dist / dtSec;
      const strength = Math.min(1, speed / POINTER_REF_SPEED) * config.strikeForce;
      const excited = injectAndRead(gx, gy, (dgx / dist) * strength, (dgy / dist) * strength);
      sediment.deposit(
        excited,
        STIR_DEPOSIT_RATE * (strength / config.strikeForce) * Math.min(dtSec, 0.05),
      );
      // step() reconstructs every frame; only paused injection needs it here.
      if (paused) sim.reconstruct();
    }
  }

  lastPointer = { gx, gy, t: now };
  dye.inject(gx, gy, 0.1, 0.4, 0.9, 4);
}

/** Scratch for reading the spectrum an impulse actually deposited. */
let strikeSpectrum = new Float64Array(config.rank);

/**
 * Strike the fluid at a point, and play what the impulse actually excited.
 *
 * `injectImpulse` projects a point force onto the eigenbasis, and that
 * projection *is* a spectrum — so a tap is already a strike, just an untuned
 * one. Reading the change in w straight back out and handing it to the hammer
 * makes the two ways of playing one gesture with two ways of aiming: hit a
 * point and the geometry chooses the partials, broadband and inharmonic, a
 * drumhead; hit a stack and one harmonic family sounds, a tuned bar. Neither
 * spectrum is designed. Both are read off the same projection.
 */
function strikeAt(gx: number, gy: number, fx: number, fy: number): void {
  const excited = injectAndRead(gx, gy, fx, fy);
  sediment.deposit(excited, TAP_DEPOSIT);
  sonifier.strike(excited, strikeVelocity(), config.hammerHardness);
}

/** Push the fluid at a point and return what that excited, |Δw| per mode. */
function injectAndRead(gx: number, gy: number, fx: number, fy: number): Float64Array {
  const rank = sim.config.rank;
  if (strikeSpectrum.length !== rank) strikeSpectrum = new Float64Array(rank);
  for (let k = 0; k < rank; k++) strikeSpectrum[k] = sim.w[k];
  sim.injectImpulse(gx, gy, fx, fy);
  for (let k = 0; k < rank; k++) {
    strikeSpectrum[k] = Math.abs(sim.w[k] - strikeSpectrum[k]);
  }
  return strikeSpectrum;
}

let dragging = false;
canvas.addEventListener('mousedown', (e) => {
  ensureAudio();
  dragging = true;
  lastPointer = null; // don't measure velocity across the gap between drags

  // A press is a tap. Its tangential direction is not something a player
  // controls when tapping, so it is random — which also gives every tap its own
  // colour, the way no two hammer strikes on a real body are identical.
  const { gx, gy } = canvasPos(e);
  const angle = Math.random() * Math.PI * 2;
  strikeAt(gx, gy, Math.cos(angle) * config.strikeForce, Math.sin(angle) * config.strikeForce);
  if (paused) sim.reconstruct();

  lastPointer = { gx, gy, t: performance.now() };
  dye.inject(gx, gy, 0.1, 0.4, 0.9, 4);
});
canvas.addEventListener('mousemove', (e) => {
  if (dragging) canvasInject(e);
});
window.addEventListener('mouseup', () => {
  dragging = false;
  lastPointer = null;
});

document.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    paused = !paused;
  } else if (e.key === 's' || e.key === 'S') {
    // First press starts audio; `init` already leaves it running, so toggling
    // as well would suspend the context it had just opened — and every later
    // strike would then be scheduled onto a clock that never advances.
    if (audioStarted) sonifier.toggle();
    else ensureAudio();
    refreshAudioDisplay();
  } else if (e.key === ']' || e.key === '[') {
    cycleStack(e.key === ']' ? 1 : -1);
  } else if (e.key === 'k' || e.key === 'K') {
    // Play a note. The strike lands in two places at once, and it has to:
    // the fluid gets the energy, so the mode pattern moves and the stack
    // colours outward over the next seconds, while the sonifier gets the same
    // spectrum as a sample-accurate audio event. Going only through w would
    // cost the attack — w is read once per frame, so the earliest any gain
    // derived from it can move is ~16 ms after the key, and a hammer is over
    // in two. Everything that makes a strike sound struck lives in that gap.
    if (stackIndex >= 0) {
      ensureAudio();
      const fam = families[stackIndex];
      strikeFamily(sim.w, fam, config.strikeForce, config.strikePosition);
      sim.reconstruct();
      const struck = strikeVector(sim.config.rank, fam, config.strikePosition);
      sediment.deposit(struck, TAP_DEPOSIT);
      sonifier.strike(struck, strikeVelocity(), config.hammerHardness);
    }
  } else if (e.key === 'h' || e.key === 'H') {
    ensureAudio();
    sustaining = !sustaining;
    applySustain();
    refreshSustainDisplay();
  } else if (e.key === 'r' || e.key === 'R') {
    sim.w.fill(0);
    // Off-centre and off-axis: injecting at the exact centre sits on a symmetry
    // point that puts 0% of the energy into the k=1 and k=3 shells.
    sim.injectImpulse(config.grid * 0.42, config.grid * 0.37, 380, 1000);
    sim.reconstruct();
    particles.seed(config.grid, config.grid);
    dye.clear();
    sediment.clear();
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

/** Seconds for a sustained stack to reach its held amplitude. */
const SUSTAIN_ATTACK = 0.18;

/**
 * Held amplitude in the fluid, as a multiple of what a single strike deposits.
 *
 * Back to 1 now that the held *tone* is synthesised rather than read off w.
 * The fluid drive is only here to move the pattern and colour the held
 * partials, so it no longer has to be loud — and at 3 it was pumping three
 * strikes' worth of energy per stack into a cascade that takes tens of seconds
 * to clear, which is most of why sustaining through a sequence of stacks piled
 * up into a wash.
 */
const SUSTAIN_LEVEL = 1;
/** Seconds for a released stack's modes to be damped back down. */
const SUSTAIN_RELEASE = 0.3;

let lastFrameMs = performance.now();

// --- Main loop ---
function frame(): void {
  const nowMs = performance.now();
  const frameSeconds = Math.min(0.1, Math.max(1e-3, (nowMs - lastFrameMs) / 1000));
  lastFrameMs = nowMs;

  if (!paused) {
    // Sustain holds the stack at the amplitude a strike would have given it,
    // replacing whatever the damping removes. The relaxation rate is a musical
    // attack time in wall-clock seconds, deliberately *not* the viscous rate:
    // sim time advances only 0.012 s per wall second here, so relaxing at ν·λ
    // would take about a minute and a half to reach pitch. The steady state is
    // the same either way; only the approach differs.
    const held = sustaining && stackIndex >= 0 ? families[stackIndex] : null;

    // Let go of what we were holding. Without this the previous stack keeps its
    // full sustained amplitude, cascades outward, and every stack moved through
    // adds another stack's worth of energy that takes tens of seconds to clear.
    // A damper meeting the string is what the gesture already implies.
    if (held !== sustainedStack) {
      if (sustainedStack) releasing = sustainedStack.members.slice();
      sustainedStack = held;
    }
    if (releasing.length > 0) {
      const decay = Math.exp(-frameSeconds / SUSTAIN_RELEASE);
      let alive = false;
      for (const k of releasing) {
        sim.w[k] *= decay;
        if (Math.abs(sim.w[k]) > 1) alive = true;
      }
      if (!alive) releasing = [];
    }

    if (held) {
      const weights = strikeWeights(held, config.strikePosition);
      const a = 1 - Math.exp(-frameSeconds / SUSTAIN_ATTACK);
      held.members.forEach((k, n) => {
        const target = config.strikeForce * SUSTAIN_LEVEL * weights[n];
        sim.w[k] += (target - sim.w[k]) * a;
      });
    }

    for (let i = 0; i < config.stepsPerFrame; i++) {
      sim.step();
    }

    // Dye at the sustained stack's fundamental antinode: π/(2·k₁), π/(2·k₂).
    if (held) {
      const { k1, k2 } = sim.pairs[held.members[0]];
      dye.inject((config.grid - 1) / (2 * k1), (config.grid - 1) / (2 * k2),
        0.20, 0.12, 0.05, 3);
    }

    // Advect dye and particles once per frame
    const frameDt = config.dt * config.stepsPerFrame;
    dye.advect(sim.velocity, frameDt);
    dye.dissipate(0.985);
    particles.advect(sim.velocity, config.grid, config.grid, frameDt, 1);
    sediment.leak(frameSeconds);
  }

  // Audio first: updateFromSim used to run after rendering, handing the audio
  // path ~5.3 ms of pure latency per frame for nothing.
  if (audioStarted) {
    sonifier.setMemory(sediment.m);
    sonifier.updateFromSim(sim);
  }

  sim.computeVorticity(vorticity, stackMask);
  renderer.render(sim, dye, vorticity, stackMask ? SOLO_VORT_GAIN : 1);
  renderer.renderParticles(particles, config.grid, config.grid);

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

// Measurement hook, dev server only: tools/measure.mjs reads w through this.
if (import.meta.env.DEV) {
  (window as unknown as { __lfs: unknown }).__lfs = {
    get sim() { return sim; },
    get config() { return config; },
    get sonifier() { return sonifier; },
    get sediment() { return sediment; },
  };
}
