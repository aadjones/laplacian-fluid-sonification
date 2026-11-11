/**
 * Sonification strategy interface.
 *
 * Each strategy receives the AudioContext plumbing and mode metadata at init,
 * then gets called with the w vector each frame. Strategies know nothing about
 * FluidSim directly—just w, frequencies, and eigenvalues—so they work with
 * any sim backend (eigenfunction, conventional NS + projection, etc.).
 */

/** Mode spatial indices, passed to strategies for panning etc. */
export interface ModePair {
  k1: number;
  k2: number;
}

export interface SonificationStrategy {
  readonly name: string;

  /**
   * Set up audio nodes. Called once when the strategy becomes active.
   * The strategy should connect its output to `master`.
   */
  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[], pairs: ModePair[]): void;

  /**
   * Called each frame with the current w vector (eigenmode coefficients).
   */
  update(w: Float64Array, rank: number): void;

  /**
   * A struck excitation: an event, not a state.
   *
   * `w` alone cannot carry an attack. It is sampled once per animation frame,
   * so the earliest a gain derived from it can move is one frame (~16 ms) after
   * the event, and any smoothing adds more. A hammer's whole identity lives in
   * its first 2 ms. So a strike arrives out of band, sample-accurate, and the
   * strategy schedules it directly on the audio clock.
   *
   * `weights[k]` is the initial amplitude for mode k (zero for modes not
   * struck), `velocity` is how hard in [0,1], and `hardness` in [0,1] runs from
   * a felt mallet to a metal tine. Optional: continuous strategies ignore it.
   */
  strike?(weights: Float64Array, velocity: number, hardness: number): void;

  /**
   * Forget any running loudness reference, because the set of sounding modes
   * just changed. See ModeAmplitudes.resetLevel. Optional.
   */
  resetLevel?(): void;

  /**
   * Hold a set of modes as a sustained tone, or release with a `level` of 0.
   *
   * Event-driven like `strike`, and for the same reason: it is called when the
   * gesture changes, so moving between stacks releases the held note and
   * articulates the new one instead of layering them. Optional.
   */
  sustain?(weights: Float64Array | null, level: number, hardness: number): void;

  /**
   * Viscosity, for strategies whose ring time is a resonator property rather
   * than something read off w. A mode decays at ν·λ, so the same slider that
   * thickens the fluid is the instrument's damper pedal. Optional.
   */
  setDamping?(viscosity: number): void;

  /**
   * The instrument's memory of where it has been played: one value in [0,1] per
   * mode, read live each frame. See sim/sediment.ts. Optional.
   */
  setMemory?(memory: Float64Array | null): void;

  /**
   * Tear down audio nodes. Called when switching away from this strategy.
   */
  dispose(): void;
}
