/**
 * Sonifier: thin shell that owns the AudioContext and delegates to a
 * swappable SonificationStrategy. Press a key to cycle strategies at runtime.
 *
 * Strategies only receive w, frequencies, and eigenvalues—not FluidSim
 * directly—so they work with any sim backend.
 */

import type { FluidSim } from '../sim/fluid';
import type { SonificationStrategy } from './strategy';
import { FilterBankStrategy } from './strategies/filterBank';
import { ModalPercussionStrategy } from './strategies/modalPercussion';
import { HarmonicSeriesStrategy } from './strategies/harmonicSeries';
import { SpectralEnvelopeStrategy } from './strategies/spectralEnvelope';

export interface SonifierConfig {
  fundamental: number;
  octaveScale: number;
  masterGain: number;
}

const DEFAULT_CONFIG: SonifierConfig = {
  fundamental: 110,
  octaveScale: 2,
  masterGain: 0.3,
};

/** All available strategies, in cycling order */
function createStrategies(): SonificationStrategy[] {
  return [
    new FilterBankStrategy(),
    new ModalPercussionStrategy(),
    new HarmonicSeriesStrategy(),
    new SpectralEnvelopeStrategy(),
  ];
}

export class Sonifier {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private config: SonifierConfig;
  private frequencies: number[] = [];
  private eigenvalues: number[] = [];
  private running = false;

  private strategies: SonificationStrategy[] = [];
  private activeIndex = 0;
  private activeStrategy: SonificationStrategy | null = null;

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
    const { fundamental, octaveScale } = this.config;
    this.frequencies = [];
    this.eigenvalues = [];
    for (let k = 0; k < rank; k++) {
      const lam = sim.eigenvalue(k);
      this.eigenvalues.push(lam);
      this.frequencies.push(fundamental * Math.pow(lam, 1 / octaveScale));
    }

    this.strategies = createStrategies();
    this.activeIndex = 0;
    this.activateStrategy(0);
    this.running = true;
  }

  private activateStrategy(index: number): void {
    if (!this.ctx || !this.masterGainNode) return;

    // Dispose current strategy
    this.activeStrategy?.dispose();

    this.activeIndex = index;
    this.activeStrategy = this.strategies[index];
    this.activeStrategy.init(this.ctx, this.masterGainNode, this.frequencies, this.eigenvalues);
    this.onStrategyChange?.(this.activeStrategy.name);
  }

  /** Cycle to the next strategy */
  nextStrategy(): void {
    if (this.strategies.length === 0) return;
    const next = (this.activeIndex + 1) % this.strategies.length;
    this.activateStrategy(next);
  }

  /** Cycle to the previous strategy */
  prevStrategy(): void {
    if (this.strategies.length === 0) return;
    const prev = (this.activeIndex - 1 + this.strategies.length) % this.strategies.length;
    this.activateStrategy(prev);
  }

  /** Get the active strategy's name */
  get strategyName(): string {
    return this.activeStrategy?.name ?? 'None';
  }

  /** Get all strategy names */
  get strategyNames(): string[] {
    return this.strategies.map(s => s.name);
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
