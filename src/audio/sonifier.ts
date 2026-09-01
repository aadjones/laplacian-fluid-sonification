/**
 * Sonifier: thin shell that owns the AudioContext and delegates to a
 * swappable SonificationStrategy. Press a key to cycle strategies at runtime.
 *
 * Strategies only receive w, frequencies, and eigenvalues—not FluidSim
 * directly—so they work with any sim backend.
 */

import type { FluidSim } from '../sim/fluid';
import type { SonificationStrategy, ModePair } from './strategy';
import { FilterBankStrategy } from './strategies/filterBank';
import { ModalPercussionStrategy } from './strategies/modalPercussion';
import { HarmonicSeriesStrategy } from './strategies/harmonicSeries';
import { SpectralEnvelopeStrategy } from './strategies/spectralEnvelope';

/** How eigenvalues become audio frequencies. See computeFrequencies. */
export type FreqMapping = 'sqrt' | 'linear' | 'stretched';

export interface SonifierConfig {
  freqLow: number;
  freqHigh: number;
  /** Pitch the lowest mode lands on, for the 'sqrt' and 'linear' mappings. */
  freqBase: number;
  mapping: FreqMapping;
  masterGain: number;
}

const DEFAULT_CONFIG: SonifierConfig = {
  freqLow: 55,
  freqHigh: 4000,
  freqBase: 110,
  mapping: 'sqrt',
  masterGain: 0.3,
};

/** Cycling order for the M key. */
export const MAPPING_ORDER: FreqMapping[] = ['sqrt', 'linear', 'stretched'];

export const MAPPING_LABELS: Record<FreqMapping, string> = {
  sqrt: '√λ bell',
  linear: 'λ harmonic',
  stretched: 'log-log',
};

/**
 * Map eigenvalues to audio frequencies.
 *
 * 'sqrt'      f = base·√(λ/λmin) — the physical modal relation. Because
 *             λ(np,nq) = n²λ(p,q), every family (p,q) lands on an EXACT harmonic
 *             series. Rank 32 carries four overlapping series on mutually
 *             inharmonic fundamentals: the internal structure of a struck bell.
 *             Narrowest spread (2.35 octaves at rank 32).
 *
 * 'linear'    f = (base/λmin)·λ. λ = k₁²+k₂² is always an integer, so every
 *             mode is an exact harmonic of a single fundamental — maximum
 *             fusion, one composite tone. Within a family the partials run
 *             1,4,9,16 rather than 1,2,3,4. Wider spread (4.70 octaves).
 *
 * 'stretched' The original log-log fit onto [freqLow, freqHigh]. Lands in the
 *             target range but is a hidden power law f ∝ λ^1.316, which destroys
 *             every integer ratio above — an exact octave renders as 3158 cents.
 *             Kept as the A/B baseline.
 */
export function computeFrequencies(eigenvalues: number[], config: SonifierConfig): number[] {
  // buildIjPairs enumerates by max(k1,k2), not by λ, so eigenvalues is NOT
  // sorted (rank 32 runs ... 18, 17, 17 ...). Taking [0]/[rank-1] as the range
  // understates λmax at 30 of the ranks 4..64 — at rank 20 it maps the top mode
  // to 4684 Hz, past the 4000 Hz ceiling.
  const lamMin = Math.min(...eigenvalues);
  const lamMax = Math.max(...eigenvalues);
  const { freqLow, freqHigh, freqBase, mapping } = config;

  if (mapping === 'sqrt') {
    return eigenvalues.map((lam) => freqBase * Math.sqrt(lam / lamMin));
  }
  if (mapping === 'linear') {
    return eigenvalues.map((lam) => (freqBase / lamMin) * lam);
  }
  const logLamRange = Math.log(lamMax) - Math.log(lamMin);
  return eigenvalues.map((lam) => {
    const t = logLamRange > 0 ? (Math.log(lam) - Math.log(lamMin)) / logLamRange : 0;
    return freqLow * Math.pow(freqHigh / freqLow, t);
  });
}

/** Strategy factory functions, in cycling order */
const STRATEGY_FACTORIES: (() => SonificationStrategy)[] = [
  () => new FilterBankStrategy(),
  () => new ModalPercussionStrategy(),
  () => new HarmonicSeriesStrategy(),
  () => new SpectralEnvelopeStrategy(),
];

export class Sonifier {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private config: SonifierConfig;
  private frequencies: number[] = [];
  private eigenvalues: number[] = [];
  private pairs: ModePair[] = [];
  private running = false;

  private activeIndex = 0;
  private activeStrategy: SonificationStrategy | null = null;
  /** Per-strategy gain node so we can hard-cut output on dispose */
  private strategyGain: GainNode | null = null;

  /** Callback fired when strategy changes (for UI updates) */
  onStrategyChange: ((name: string) => void) | null = null;
  /** Callback fired when the frequency mapping changes (for UI updates) */
  onMappingChange: ((label: string) => void) | null = null;

  constructor(config: Partial<SonifierConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize audio context and activate the first strategy.
   * Must be called from a user gesture.
   */
  init(sim: FluidSim): void {
    if (this.ctx) return;

    this.ctx = new AudioContext();
    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = this.config.masterGain;
    this.masterGainNode.connect(this.ctx.destination);

    const rank = sim.config.rank;
    this.eigenvalues = [];

    // Collect eigenvalues and mode pairs
    for (let k = 0; k < rank; k++) {
      this.eigenvalues.push(sim.eigenvalue(k));
      this.pairs.push({ k1: sim.pairs[k].k1, k2: sim.pairs[k].k2 });
    }
    this.frequencies = computeFrequencies(this.eigenvalues, this.config);

    this.activeIndex = 0;
    this.activateStrategy(0);
    this.running = true;
  }

  private activateStrategy(index: number): void {
    if (!this.ctx || !this.masterGainNode) return;

    // Hard-cut previous strategy: dispose it, then disconnect its gain node
    // so any lingering audio (in-flight pings, automation tails) is silenced
    if (this.activeStrategy) {
      this.activeStrategy.dispose();
    }
    if (this.strategyGain) {
      this.strategyGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.strategyGain.disconnect();
      this.strategyGain = null;
    }

    // Fresh instance + isolated gain node
    this.activeIndex = index;
    this.strategyGain = this.ctx.createGain();
    this.strategyGain.gain.value = 1;
    this.strategyGain.connect(this.masterGainNode);

    this.activeStrategy = STRATEGY_FACTORIES[index]();
    this.activeStrategy.init(this.ctx, this.strategyGain, this.frequencies, this.eigenvalues, this.pairs);
    this.onStrategyChange?.(this.activeStrategy.name);
  }

  /** Cycle to the next strategy */
  nextStrategy(): void {
    const count = STRATEGY_FACTORIES.length;
    this.activateStrategy((this.activeIndex + 1) % count);
  }

  /**
   * Cycle the eigenvalue→frequency mapping. Strategies cache frequencies at
   * init(), so the active one is rebuilt to pick up the new set.
   */
  nextMapping(): void {
    const i = MAPPING_ORDER.indexOf(this.config.mapping);
    this.config.mapping = MAPPING_ORDER[(i + 1) % MAPPING_ORDER.length];
    this.frequencies = computeFrequencies(this.eigenvalues, this.config);
    this.onMappingChange?.(this.mappingLabel);
    if (this.ctx) this.activateStrategy(this.activeIndex);
  }

  /** Human-readable label for the active frequency mapping */
  get mappingLabel(): string {
    return MAPPING_LABELS[this.config.mapping];
  }

  /** Cycle to the previous strategy */
  prevStrategy(): void {
    const count = STRATEGY_FACTORIES.length;
    this.activateStrategy((this.activeIndex - 1 + count) % count);
  }

  /** Get the active strategy's name */
  get strategyName(): string {
    return this.activeStrategy?.name ?? 'None';
  }

  /** Get all strategy names */
  get strategyNames(): string[] {
    return STRATEGY_FACTORIES.map(f => f().name);
  }

  /** Update from sim state — delegates to active strategy */
  updateFromSim(sim: FluidSim): void {
    if (!this.running || !this.activeStrategy) return;
    this.activeStrategy.update(sim.w, sim.config.rank);
  }

  /**
   * Sound→Fluid direction: generate w coefficients from frequency/amplitude pairs.
   */
  frequenciesToCoefficients(
    freqAmps: Array<{ freq: number; amp: number }>,
    rank: number,
  ): Float64Array {
    const w = new Float64Array(rank);
    for (const { freq, amp } of freqAmps) {
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < this.frequencies.length; k++) {
        const dist = Math.abs(this.frequencies[k] - freq);
        if (dist < bestDist) {
          bestDist = dist;
          bestK = k;
        }
      }
      w[bestK] += amp;
    }
    return w;
  }

  getFrequency(k: number): number {
    return this.frequencies[k] ?? 0;
  }

  setMasterGain(value: number): void {
    if (this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(value, this.ctx!.currentTime, 0.02);
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
