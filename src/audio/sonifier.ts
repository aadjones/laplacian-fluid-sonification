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

export interface SonifierConfig {
  freqLow: number;
  freqHigh: number;
  masterGain: number;
}

const DEFAULT_CONFIG: SonifierConfig = {
  freqLow: 55,
  freqHigh: 4000,
  masterGain: 0.3,
};

/** Strategy factory functions, in cycling order */
const STRATEGY_FACTORIES: (() => SonificationStrategy)[] = [
  () => new FilterBankStrategy(),
  () => new ModalPercussionStrategy(),
  () => new HarmonicSeriesStrategy(),
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
    const { freqLow, freqHigh } = this.config;
    this.frequencies = [];
    this.eigenvalues = [];

    // Collect eigenvalues and mode pairs
    for (let k = 0; k < rank; k++) {
      this.eigenvalues.push(sim.eigenvalue(k));
      this.pairs.push({ k1: sim.pairs[k].k1, k2: sim.pairs[k].k2 });
    }
    const lamMin = this.eigenvalues[0];
    const lamMax = this.eigenvalues[rank - 1];
    const logLamRange = Math.log(lamMax) - Math.log(lamMin);

    // Log-log mapping: eigenvalue range → frequency range (perceptually uniform)
    for (let k = 0; k < rank; k++) {
      const t = logLamRange > 0
        ? (Math.log(this.eigenvalues[k]) - Math.log(lamMin)) / logLamRange
        : 0;
      this.frequencies.push(freqLow * Math.pow(freqHigh / freqLow, t));
    }

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
