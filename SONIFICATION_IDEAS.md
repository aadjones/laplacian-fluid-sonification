# Sonification Design Ideas

Living document for brainstorming and tracking sonification approaches.

## The Core Problems

### 1. Inharmonic frequency ratios
32 eigenmodes with eigenvalues λ = k₁² + k₂² produce frequencies at irrational ratios (√2 : √5 : √8 : √10...). Playing all simultaneously = inharmonic mush regardless of synthesis method.

### 2. No narrative arc
A single subtly-evolving timbre becomes monotonous. We need tension, release, events, arcs—not just continuous texture. A drone that morphs is still a drone.

### 3. Temporal mismatch between sim and sound
The fluid sim is *continuous*—swirly, always in motion, no discrete events. Percussive/event-driven sonification (pings, chimes) feels disconnected from this continuous visual flow. There's a fundamental aesthetic mismatch between seeing smooth motion and hearing discrete plunks.

### 4. The sim itself is too static/uniform
Current sim is a square domain with no obstacles. It just swirls endlessly in the same way. Compared to e.g. 3D smoke curling around obstacles, there's no visual narrative either. The sound can't have narrative if the underlying physics doesn't.

## Design Goals

- Musically rich, not noisy
- Evolving narrative, not static drone
- Sound should feel *temporally congruent* with the visual—continuous flow needs continuous sound, events need event-sounds
- Physically motivated (the sound should "make sense" given the fluid state)
- Real-time, bidirectional (fluid↔sound)

## Candidate Sonification Approaches

### A. Harmonic Series Reinterpretation

Map mode indices to harmonics of one fundamental (mode k → harmonic k+1) instead of physical eigenvalue→freq. The w vector becomes the Fourier amplitude spectrum of a single evolving timbre.

**Pros:** Simplest change (~30 lines). Partials fuse into one percept. Timbral evolution is inherently musical.
**Cons:** Single drone gets annoying. Loses physical frequency meaning. No narrative arc on its own.
**Status:** Not yet tried.

### B. Top-N Peak Tracking

Track the 2-4 modes with highest |w[k]|, quantize to a musical scale (pentatonic, just intonation), play only those as clean oscillators with portamento.

**Pros:** Clean, melodic. Fluid "picks notes" from a palette.
**Cons:** Jumpy if modes swap dominance rapidly. Quantization disconnects from physics.
**Status:** Not yet tried.

### C. Perceptual Dimensionality Reduction

Collapse 32D w vector into perceptual parameters:
- **Pitch**: spectral centroid (where energy concentrates)
- **Brightness**: spectral tilt / spread
- **Roughness**: energy distribution evenness
- **Loudness**: total energy ‖w‖²

Drive a single expressive synth voice (FM, subtractive, etc.).

**Pros:** Most perceptually grounded. Rich control space.
**Cons:** Most design work to choose synth architecture. Still one voice.
**Status:** Not yet tried.

### D. Modal Percussion / Event-Driven

Detect changes: when |Δw[k]| spikes, trigger a short decaying ping at that mode's frequency. Wind chime aesthetic.

**Pros:** Creates events and rhythm naturally. Fluid dynamics has natural event structure (collisions, vortex shedding).
**Cons:** Could be sparse/quiet during smooth flow. Feels temporally disconnected from continuous fluid motion—seeing smooth swirl + hearing discrete plinks is aesthetically jarring. "Dinky."
**Status:** Implemented (current). Uses adaptive thresholding (mean + σ·stddev). Eigenvalue-scaled decay times. Needs listening evaluation.

### E. Spectral Envelope on Carrier

Use w as a formant filter on a harmonically-rich carrier (sawtooth, pulse). Carrier provides pitch and harmonicity; mode weights shape resonance peaks. Vocal synthesis analogy—the "mouth shape" of the fluid.

**Pros:** Rich timbral control. Harmonicity guaranteed by carrier. Continuous = matches visual flow.
**Cons:** Still one voice. Formant mapping needs careful design.
**Status:** Not yet tried.

### F. Hybrid: Continuous Texture + Event Layer

Combine a continuous base layer (A, C, or E) with an event layer (D). The base tracks the fluid's ongoing state; the event layer punctuates transitions and impulses.

**Pros:** Continuous texture + discrete events = narrative. Two layers of information.
**Cons:** Mixing/balance complexity. Two systems to tune. Risk of "hearing two unrelated things."
**Status:** Not yet tried.

### G. Resonant Filter Bank (original)

Noise → 32 parallel bandpasses → gain. Mode weights control Q and gain per filter.

**Pros:** Physically motivated—literally "what would this cavity sound like." Continuous.
**Cons:** 32 inharmonic partials = noise. The original problem.
**Status:** Re-tuned with high-Q filters (Q 200–2000), cubic gain gating, log-log frequency spread (55–4000 Hz, ~6 octaves). Much cleaner—individual modes now ring as distinct pitches rather than colored noise. Active strategy alongside modal percussion and harmonic series.

## Ideas for Narrative / Arc

The big unsolved piece: how do we get the sound to *go somewhere* rather than just exist?

### Fluid dynamics as natural narrative source
- **Turbulent cascade**: energy moves from large scales (low modes) to small scales (high modes) over time. Natural bright→dark arc if mapped to timbre.
- **Vortex collisions**: sudden energy redistribution = dramatic sonic events.
- **Viscous decay**: energy drains from high modes first, creating a natural "settling" arc.
- **Impulse injection**: user interaction = new musical phrase/event.

### Structural ideas
- **Phrase detection**: identify when the system transitions between quasi-stable states (energy concentrated in a few modes vs. distributed). Transition = musical phrase boundary.
- **Tension from entropy**: high mode entropy (energy evenly spread) = dissonance/tension. Low entropy (energy concentrated) = consonance/resolution. The fluid naturally oscillates between these.
- **Register tracking**: map the spectral centroid of w to musical register. As energy cascades to smaller scales, pitch rises—creating natural melodic contour.
- **Rhythmic extraction**: the advection step creates quasi-periodic energy exchange between coupled modes. Could drive rhythmic patterns at a tempo the fluid determines.
- **Section structure from energy**: total system energy (with viscosity on) decays over time. Each user impulse starts a new "section." The decay envelope gives natural phrase endings.
- **Harmonic rhythm from mode dominance**: when the dominant mode changes, that's a "chord change." Track dominant mode transitions as harmonic rhythm.

## Simulation Architecture: Decoupling Sim from Sonification Basis

### Key realization: the simulation basis ≠ the sonification basis

The original UCSB project sonified from PCA/POD subspace coefficients, not from analytic eigenmodes. This means:

1. Run **any** sim (Eulerian NS with obstacles, buoyancy, complex geometry)
2. **Project** the velocity field onto a basis (analytic eigenfunctions, numerically-computed eigenmodes, PCA/POD modes from training data)
3. Get a **w vector** in that basis
4. Sonify from w

The simulation doesn't need to *use* eigenfunctions internally—it just needs to produce a velocity field that we can decompose. This completely decouples the two concerns:

- **Sim** can be as rich as we want (obstacles, buoyancy, arbitrary geometry)
- **Analysis basis** can be chosen for good sonification properties (harmonic frequency ratios, perceptually meaningful modes, etc.)
- **Sonification** maps from whatever basis we choose

### Architecture options

**Option 1: Keep eigenfunction sim, add richness within its constraints**
- Time-varying forcing, particle viz, passive scalars
- Pro: already working, clean math. Con: still a square box.

**Option 2: Conventional Eulerian NS + eigenfunction projection**
- Full NS solver (pressure projection, obstacles, buoyancy)
- Project velocity field onto Laplacian eigenfunctions each frame for sonification
- Pro: rich sim + clean modal decomposition. Con: projection cost, eigenfunctions are still for rectangle.

**Option 3: Conventional NS + PCA/POD basis**
- Run training sims to collect velocity snapshots
- Compute POD modes (SVD of snapshot matrix)
- At runtime: sim produces velocity → project onto POD modes → sonify from POD coefficients
- Pro: modes are optimally adapted to the flow. Con: offline training step, modes aren't physically interpretable frequencies.

**Option 4: Numerical eigenfunctions for arbitrary domains**
- Mesh the domain (with obstacles, boundaries)
- Solve Laplacian eigenvalue problem numerically (sparse eigensolver)
- Use these as both sim basis (spectral method) and sonification basis
- Pro: Chladni-like domain-dependent modes, physically meaningful. Con: significant implementation effort, need a mesh + eigensolver.

**Option 5: Hybrid—conventional NS sim + Chladni-inspired sonification**
- Rich conventional sim for visuals
- Separately compute eigenfrequencies of the domain shape (Helmholtz equation)
- Use those frequencies as the sonification palette, driven by flow energy at those spatial scales
- Pro: "what would this shaped drum sound like" is a beautiful concept. Con: need to solve Helmholtz for the geometry.

### C++ reference findings
- The eigenfunction solver (2D/3D) is intentionally minimal: rectangular domain, no obstacles, no density
- A separate `FLUID_3D_MIC` solver in the same repo has obstacles, buoyancy, density, pressure projection—but doesn't use eigenfunctions
- The original project's PCA sonification worked on the conventional solver's output
- 3D eigenfunction code uses particle advection (10k particles) for visualization—much richer than vorticity colormap

## Simulation Improvements

### Within eigenfunction framework
- **Time-varying forcing**: sustained jets, pulsing sources → ongoing turbulence instead of single decaying swirl
- **Particle advection**: 10k+ particles traced through the flow. Visually much richer than vorticity colormap. C++ reference does this.
- **Passive scalar transport**: dye/density advected by velocity. Doesn't change sim math but adds visual narrative.
- **Mode-selective forcing**: drive specific mode groups to create structured dynamics.

### With conventional NS (bigger effort)
- **Obstacles**: vortex shedding = natural periodic events (von Kármán streets). Rhythm from physics.
- **Buoyancy**: rising/curling narrative. What made the 3D smoke compelling.
- **Inlets/outlets**: sustained turbulence with natural frequency content.
- **Non-rectangular domains**: L-shapes, circles produce qualitatively different dynamics.

## Implementation Plan

### Phase 1: Sonification A/B infrastructure ← NOW
Build a strategy pattern so we can hot-swap sonification approaches at runtime and compare by ear. Press a key to cycle through strategies.

```typescript
interface SonificationStrategy {
  readonly name: string;
  init(ctx: AudioContext, master: GainNode, frequencies: number[], eigenvalues: number[]): void;
  update(w: Float64Array, rank: number): void;
  dispose(): void;
}
```

The Sonifier class becomes a thin shell that owns the AudioContext and delegates to the active strategy. Strategies only know about `w`, frequencies, and eigenvalues—not `FluidSim` directly—so they work with any sim backend.

Strategies to implement:
1. **Resonant filter bank** (original) — baseline noise→bandpass approach
2. **Modal percussion** (current) — event-driven pings with adaptive thresholding
3. **Harmonic series** — mode k → harmonic (k+1), w = spectral amplitudes of one tone
4. **Spectral envelope** — sawtooth carrier filtered by w-shaped resonance curve

### Phase 2: Conventional NS + Chladni sonification (Option 5)

#### Architecture
```
[Obstacle Editor] → [Domain Mask]
                        ↓
              [Lanczos Eigensolver] → [Eigenmodes + Eigenfreqs]  (on mask change, ~0.5-1s)
                        ↓
[User Interaction] → [2D Navier-Stokes] → [Velocity Field]
                                               ↓
                                    [Project onto Eigenmodes] → [w vector]
                                               ↓
                                    [Sonification Strategy] → [Audio]
```

#### Lanczos eigensolver feasibility (researched)
- No JS/WASM sparse eigensolver libraries exist. Need to implement.
- Problem size: ~8K active DOFs (128² grid, ~50% masked). 5-point stencil = very sparse.
- Lanczos algorithm: ~150 lines of TypeScript. ~128-192 iterations for 32-64 eigenpairs.
- Each iteration: SpMV (40K mul-adds) + reorthogonalization. Total: **well under 1 second**.
- Don't even need explicit sparse matrix—apply stencil directly on masked grid.
- After Lanczos produces tridiagonal T (~192×192), use dense eigensolver for T (trivially small).

#### 2D Navier-Stokes solver
- Staggered MAC grid, semi-Lagrangian advection, pressure projection via Jacobi/CG
- Obstacle cells: zero velocity BCs, excluded from pressure solve
- Standard approach, well-documented, many JS/WebGL implementations exist
- 128² grid at 60fps should be comfortable in pure JS (or WebGL for bonus perf)

#### Interactive affordances
- **Every frame**: fluid interaction (inject vorticity, stir), sonification params, viz params
- **On obstacle change (~0.5-1s recompute)**: add/remove/move obstacles → re-solve Helmholtz → new eigenmodes → "instrument reshapes." Crossfade audio between old/new mode sets.
- **Instant**: switch between preset scenes (empty, pillar, L-channel, maze) with precomputed modes

#### What the user experiences
"You're playing a fluid drum. The shape of the domain IS the instrument. Place obstacles to change what it sounds like. Stir the fluid to excite different resonances. The sound you hear is literally what this shape would sound like if it were a vibrating membrane."

### Phase 3: Polish & exploration
- Particle advection visualization (richer than vorticity colormap)
- Density/dye transport for visual narrative
- Buoyancy for rising/curling dynamics
- Multiple sonification strategies evaluated against the richer sim
- Bidirectional: composed frequencies drive fluid

### Open questions
- Is the temporal mismatch (continuous visual + discrete audio) a fundamental problem, or just a tuning problem?
- Would obstacles generate enough natural events that percussive sonification feels right?
- Can we find a synthesis approach that is *both* continuous and event-responsive?
- PCA/POD modes vs numerical eigenfunctions: which produces better sonification?
- How to handle the audio crossfade when eigenmodes change (obstacle moved)?
- What's the right UI for obstacle editing? Draw mode? Drag prefab shapes?
