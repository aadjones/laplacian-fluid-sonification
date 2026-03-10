/**
 * Sonification strategy interface.
 *
 * Each strategy receives the AudioContext plumbing and mode metadata at init,
 * then gets called with the w vector each frame. Strategies know nothing about
 * FluidSim directly—just w, frequencies, and eigenvalues—so they work with
 * any sim backend (eigenfunction, conventional NS + projection, etc.).
 */

export interface SonificationStrategy {
  readonly name: string;

  /**
   * Set up audio nodes. Called once when the strategy becomes active.
   * The strategy should connect its output to `master`.
   */
  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[]): void;

  /**
   * Called each frame with the current w vector (eigenmode coefficients).
   */
  update(w: Float64Array, rank: number): void;

  /**
   * Tear down audio nodes. Called when switching away from this strategy.
   */
  dispose(): void;
}
