/**
 * Sonifier: the instrument's body.
 *
 * It owns the AudioContext, the output chain, and the set of excitations that
 * share it. Strategies receive only w, frequencies and eigenvalues — never
 * FluidSim — so they work with any sim backend.
 *
 * There used to be five strategies and a key to cycle between them. That was
 * A/B scaffolding from before the comparison had been made, and it had a real
 * cost: a physical instrument does not switch between "hammer mode" and "bow
 * mode", it has both at once, and making them exclusive meant the bow vanished
 * the moment you started striking. The two that survived now run together and
 * always have. What was a mode switch is now just two mechanisms sharing a
 * resonating body, which is what they always were.
 */

import type { FluidSim } from '../sim/fluid';
import type { SonificationStrategy, ModePair } from './strategy';
import { StruckModalStrategy } from './strategies/struckModal';
import { FilterBankStrategy } from './strategies/filterBank';

export interface SonifierConfig {
  /** Pitch the lowest mode lands on. */
  freqBase: number;
  masterGain: number;
}

const DEFAULT_CONFIG: SonifierConfig = {
  freqBase: 110,
  masterGain: 0.3,
};

/**
 * Map eigenvalues to audio frequencies: f = base·√(λ/λmin).
 *
 * This is the physical modal relation, and it is the only mapping the rest of
 * the instrument is true under. Because λ(np,nq) = n²λ(p,q), every family (p,q)
 * lands on an exact harmonic series, which is what makes a mode stack fuse into
 * a note — see sim/families.ts.
 *
 * Two other mappings used to sit on a cycling key, and both falsified that.
 * `linear` (f ∝ λ) made a family's partials run 1,4,9,16 instead of 1,2,3,4;
 * the original log-log fit was a hidden power law f ∝ λ^1.316 that rendered an
 * exact octave as 3158 cents. An instrument does not need a control that
 * detunes it.
 */
export function computeFrequencies(eigenvalues: number[], freqBase: number): number[] {
  // buildIjPairs enumerates by max(k1,k2), not by λ, so eigenvalues is NOT
  // sorted (rank 32 runs ... 18, 17, 17 ...). Taking [0] as λmin is wrong at
  // most ranks.
  const lamMin = Math.min(...eigenvalues);
  return eigenvalues.map((lam) => freqBase * Math.sqrt(lam / lamMin));
}

/** The excitations that make up the instrument. Both are live at all times. */
const EXCITATIONS: (() => SonificationStrategy)[] = [
  () => new StruckModalStrategy(),
  () => new FilterBankStrategy(),
];

export class Sonifier {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private limiter: WaveShaperNode | null = null;
  private outputGain: GainNode | null = null;
  private config: SonifierConfig;
  private frequencies: number[] = [];
  private eigenvalues: number[] = [];
  private pairs: ModePair[] = [];
  private running = false;

  /**
   * Output-side mode mask; null means every mode sounds. See sim/families.ts
   * for why sonifying the whole rank cannot produce pitch at rank 576.
   */
  private modeMask: Float64Array | null = null;
  private maskedW = new Float64Array(0);
  private maskedStrike = new Float64Array(0);
  private maskedMemory = new Float64Array(0);

  private strategies: SonificationStrategy[] = [];
  /** Last viscosity seen, re-applied whenever the excitations are built. */
  private damping = 0.5;

  constructor(config: Partial<SonifierConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize audio and build the excitations.
   * Must be called from a user gesture.
   */
  init(sim: FluidSim): void {
    if (this.ctx) return;

    this.ctx = new AudioContext();
    // Chromium hands back a suspended context unless it is convinced the call
    // came from a user gesture, and it is not always convinced. Ask explicitly:
    // a suspended context freezes currentTime, so scheduled strikes are written
    // into a clock that never reaches them and the instrument is silent.
    void this.ctx.resume();

    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = this.config.masterGain;

    // Soft ceiling, last in the chain.
    //
    // Strikes are additive on purpose — playing a second stack over a ringing
    // first one is the instrument's whole polyphony model — so the summed
    // output is unbounded by construction. Left alone it would hit the
    // destination's hard clip, which on a percussive transient is the ugliest
    // sound a digital instrument can make. tanh is near-linear below about a
    // third of full scale, so a single note passes through untouched and only
    // a chord meets the curve. A compressor would work too, but its fast attack
    // would flatten exactly the transient the hammer exists to produce; a
    // memoryless saturator has no attack to get wrong, and a little harmonic
    // distortion as an instrument is driven hard is what a body does anyway.
    //
    // It goes *after* the master fader, not before. Ahead of a 0.3 fader its
    // own 0.76 ceiling becomes the real ceiling and caps the instrument about
    // 13 dB below full scale however hard it is struck.
    this.limiter = this.ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      curve[i] = Math.tanh((i / (curve.length - 1)) * 2 - 1);
    }
    this.limiter.curve = curve;
    this.limiter.oversample = '2x';

    this.masterGainNode.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    const rank = sim.config.rank;
    this.eigenvalues = [];
    this.pairs = [];
    for (let k = 0; k < rank; k++) {
      this.eigenvalues.push(sim.eigenvalue(k));
      this.pairs.push({ k1: sim.pairs[k].k1, k2: sim.pairs[k].k2 });
    }
    this.frequencies = computeFrequencies(this.eigenvalues, this.config.freqBase);
    this.maskedW = new Float64Array(rank);
    this.maskedStrike = new Float64Array(rank);
    this.maskedMemory = new Float64Array(rank);

    // One shared gain for every excitation, so they sum into the same body.
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = 1;
    this.outputGain.connect(this.masterGainNode);

    this.strategies = EXCITATIONS.map((make) => {
      const s = make();
      s.setDamping?.(this.damping);
      s.init(this.ctx!, this.outputGain!, this.frequencies, this.eigenvalues, this.pairs);
      return s;
    });

    this.running = true;
  }

  /**
   * Restrict which modes sound, or pass null to sound all of them.
   *
   * The mask multiplies w on its way to the excitations rather than living
   * inside one, so all of them inherit it unchanged. It lands before the L1/L2
   * normalisation, which is the point: soloing an eight-mode stack gives those
   * eight modes the entire level instead of 8/576 of it, so isolation makes the
   * stack louder as well as clearer.
   */
  setModeMask(mask: Float64Array | null): void {
    this.modeMask = mask;
    // The set of sounding modes just changed, so any running loudness
    // reference is now measuring against a norm that no longer exists.
    for (const s of this.strategies) s.resetLevel?.();
  }

  /**
   * Play a note: an out-of-band, sample-accurate excitation event.
   *
   * This is the half of the instrument `w` cannot carry. `w` is sampled once
   * per animation frame, so a gain derived from it cannot move until ~16 ms
   * after the gesture, and a hammer's identity is over in 2 ms.
   *
   * Strikes are additive by design: striking while something is still ringing
   * superposes in the resonators, so voice overlap is physical rather than an
   * allocation policy. The mask applies here too, so soloing a stack aims the
   * hammer as well as filtering what is heard.
   */
  strike(weights: Float64Array, velocity = 0.8, hardness = 0.5): void {
    if (!this.running) return;
    let w = weights;
    if (this.modeMask) {
      const n = Math.min(weights.length, this.maskedStrike.length);
      for (let k = 0; k < n; k++) this.maskedStrike[k] = weights[k] * this.modeMask[k];
      w = this.maskedStrike;
    }
    for (const s of this.strategies) s.strike?.(w, velocity, hardness);
  }

  /**
   * Hold the given modes as a sustained tone, or release with a `level` of 0.
   *
   * Masked like `strike`, so soloing aims the sustain as well as the hammer.
   */
  sustain(weights: Float64Array | null, level: number, hardness = 0.5): void {
    if (!weights || level <= 0) {
      for (const s of this.strategies) s.sustain?.(null, 0, hardness);
      return;
    }
    let w = weights;
    if (this.modeMask) {
      const n = Math.min(weights.length, this.maskedStrike.length);
      for (let k = 0; k < n; k++) this.maskedStrike[k] = weights[k] * this.modeMask[k];
      w = this.maskedStrike;
    }
    for (const s of this.strategies) s.sustain?.(w, level, hardness);
  }

  /**
   * Hand the excitations the instrument's memory (sim/sediment.ts), masked like
   * everything else so a soloed stack only remembers aloud what it contains.
   * Call once per frame, before `updateFromSim`.
   */
  setMemory(memory: Float64Array): void {
    if (!this.running) return;
    const n = Math.min(memory.length, this.maskedMemory.length);
    for (let k = 0; k < n; k++) {
      this.maskedMemory[k] = this.modeMask ? memory[k] * this.modeMask[k] : memory[k];
    }
    for (const s of this.strategies) s.setMemory?.(this.maskedMemory);
  }

  /** Forward the damping slider to excitations that ring on their own. */
  setDamping(viscosity: number): void {
    this.damping = viscosity;
    for (const s of this.strategies) s.setDamping?.(viscosity);
  }

  /** Update from sim state — every excitation sees the same masked w. */
  updateFromSim(sim: FluidSim): void {
    if (!this.running || this.strategies.length === 0) return;
    const rank = sim.config.rank;
    let w = sim.w;
    if (this.modeMask) {
      for (let k = 0; k < rank; k++) this.maskedW[k] = sim.w[k] * this.modeMask[k];
      w = this.maskedW;
    }
    for (const s of this.strategies) s.update(w, rank);
  }

  getFrequency(k: number): number {
    return this.frequencies[k] ?? 0;
  }

  setMasterGain(value: number): void {
    if (this.masterGainNode && this.ctx) {
      this.masterGainNode.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }
    this.config.masterGain = value;
  }

  suspend(): void {
    this.ctx?.suspend();
    this.running = false;
  }

  resume(): void {
    this.ctx?.resume();
    this.running = true;
  }

  toggle(): void {
    if (this.running) this.suspend();
    else this.resume();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
