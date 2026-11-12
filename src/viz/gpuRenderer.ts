/**
 * The plate, drawn on the graphics card.
 *
 * The fluid is 64 numbers, and each mode's flow is an exact formula, so the
 * picture has no native resolution: every pixel can ask the formula directly.
 * This renderer does that. It is given `w` each frame and nothing else, and it
 * draws four things from it:
 *
 *  - the figure: bright lines where the fluid's rotation is zero, and a warm or
 *    cool tint for which way each cell turns;
 *  - dye, carried by the flow on its own fine grid;
 *  - a few hundred thousand particles, each leaving a fading trail;
 *
 * Dye and particles are passive. Nothing here feeds back into `w`.
 *
 * Coordinates: "plate space" is uv in [0,1]² with y pointing down, matching the
 * solver's grid. Every texture is stored in plate space; only the final pass
 * flips y for the screen.
 */

/** Dye grid, cells per side. Independent of the screen and of the solver. */
const DYE_SIZE = 1024;
/** Particles are stored in a square texture this many texels on a side. */
const PARTICLE_SIDE = 512;
/** Largest drawing surface, pixels per side. */
const MAX_PIXELS = 2048;

/** Share of the dye that survives each frame. */
const DYE_KEEP = 0.994;
/** Share of each particle trail that survives each frame. */
const TRAIL_KEEP = 0.9;

const FULLSCREEN_VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * The fluid's fields as functions of position. `uW` holds the coefficients on
 * the (k1, k2) lattice, at index (k1-1)*SIDE + (k2-1).
 *
 *   rotation   ω =  Σ w sin(k1 x) sin(k2 y)
 *   velocity   u =  Σ w (k2/λ) sin(k1 x) cos(k2 y)
 *              v = -Σ w (k1/λ) cos(k1 x) sin(k2 y)        λ = k1² + k2²
 */
const fieldGlsl = (side: number): string => `
#define SIDE ${side}
#define NN ${side * side}
const float PI = 3.141592653589793;
uniform float uW[NN];

void trig(float t, out float s[SIDE], out float c[SIDE]) {
  for (int i = 0; i < SIDE; i++) {
    float a = float(i + 1) * t;
    s[i] = sin(a);
    c[i] = cos(a);
  }
}

vec2 velocityAt(vec2 uv) {
  float sx[SIDE]; float cx[SIDE]; float sy[SIDE]; float cy[SIDE];
  trig(uv.x * PI, sx, cx);
  trig(uv.y * PI, sy, cy);
  vec2 v = vec2(0.0);
  for (int i = 0; i < SIDE; i++) {
    for (int j = 0; j < SIDE; j++) {
      float w = uW[i * SIDE + j];
      float k1 = float(i + 1);
      float k2 = float(j + 1);
      float inv = 1.0 / (k1 * k1 + k2 * k2);
      v.x += w * k2 * inv * sx[i] * cy[j];
      v.y -= w * k1 * inv * cx[i] * sy[j];
    }
  }
  return v;
}

/** Rotation in x, its gradient (per unit of the [0,π] domain) in yz. */
vec3 rotationAt(vec2 uv) {
  float sx[SIDE]; float cx[SIDE]; float sy[SIDE]; float cy[SIDE];
  trig(uv.x * PI, sx, cx);
  trig(uv.y * PI, sy, cy);
  vec3 r = vec3(0.0);
  for (int i = 0; i < SIDE; i++) {
    for (int j = 0; j < SIDE; j++) {
      float w = uW[i * SIDE + j];
      r.x += w * sx[i] * sy[j];
      r.y += w * float(i + 1) * cx[i] * sy[j];
      r.z += w * float(j + 1) * sx[i] * cy[j];
    }
  }
  return r;
}`;

const advectDyeFrag = (side: number): string => `#version 300 es
precision highp float;
${fieldGlsl(side)}
uniform sampler2D uDye;
uniform float uStep;   // tracer time step
uniform float uKeep;
in vec2 vUv;
out vec4 outColor;
void main() {
  // Semi-Lagrangian: look upstream for what arrives here.
  vec2 from = vUv - velocityAt(vUv) * uStep / PI;
  outColor = texture(uDye, from) * uKeep;
}`;

/**
 * One streak of dye per cell of mode (k1, k2), from near the cell's centre
 * toward its edge, coloured by the way that cell turns. The fluid turns faster
 * near the middle of a cell than at its rim, so a streak winds into a spiral
 * where a round drop would only drift.
 */
const INJECT_DYE_FRAG = `#version 300 es
precision highp float;
uniform vec2 uMode;
uniform float uSpin;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 c = vUv * uMode;
  vec2 cell = floor(c);
  vec2 f = c - cell;
  vec2 size = 1.0 / uMode;                       // cell size in plate space
  bool wide = size.x >= size.y;
  // Segment from 58% to 94% across the cell, along its long axis.
  vec2 a = wide ? vec2(0.58, 0.5) : vec2(0.5, 0.58);
  vec2 b = wide ? vec2(0.94, 0.5) : vec2(0.5, 0.94);
  vec2 p = (f - a) * size;
  vec2 ab = (b - a) * size;
  float t = clamp(dot(p, ab) / dot(ab, ab), 0.0, 1.0);
  float d = length(p - ab * t);
  float radius = max(0.0035, 0.03 * min(size.x, size.y));
  float amount = exp(-(d * d) / (radius * radius));
  float parity = mod(cell.x + cell.y, 2.0) < 0.5 ? 1.0 : -1.0;
  vec3 colour = parity * uSpin > 0.0 ? vec3(1.0, 0.5, 0.18) : vec3(0.18, 0.5, 1.0);
  outColor = vec4(colour * amount, 1.0);
}`;

const moveParticlesFrag = (side: number): string => `#version 300 es
precision highp float;
${fieldGlsl(side)}
uniform sampler2D uParticles;   // xy position, z age in frames, w a fixed random number
uniform float uStep;
uniform float uTime;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec4 p = texelFetch(uParticles, ivec2(gl_FragCoord.xy), 0);
  p.xy += velocityAt(p.xy) * uStep / PI;
  p.z += 1.0;
  float life = 200.0 + 500.0 * p.w;
  bool outside = p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0;
  if (p.z > life || outside) {
    // Start again somewhere else, so the flow never sweeps the plate bare.
    p.x = hash(gl_FragCoord.xy + uTime);
    p.y = hash(gl_FragCoord.yx + uTime * 1.7 + 11.0);
    p.z = 0.0;
  }
  outColor = p;
}`;

/** Each particle is a line from where it was last frame to where it is now. */
const DRAW_PARTICLES_VERT = `#version 300 es
precision highp float;
uniform sampler2D uNow;
uniform sampler2D uBefore;
uniform int uSide;
uniform float uPixel;     // one pixel of the trail surface, in plate space
out float vSpeed;
void main() {
  int id = gl_VertexID / 2;
  ivec2 tc = ivec2(id % uSide, id / uSide);
  vec4 now = texelFetch(uNow, tc, 0);
  vec2 before = texelFetch(uBefore, tc, 0).xy;
  vec2 d = now.xy - before;
  float len = length(d);
  // A particle that has just restarted jumped; it has no stroke this frame.
  if (now.z < 0.5) { d = vec2(0.0); len = 0.0; }
  vSpeed = len / uPixel;
  // Never shorter than a pixel and a half, or slow motion would not draw.
  vec2 dir = len > 1e-9 ? d / len : vec2(0.0);
  vec2 tail = now.xy - dir * max(len, 1.5 * uPixel);
  vec2 p = (gl_VertexID % 2 == 0) ? tail : now.xy;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DRAW_PARTICLES_FRAG = `#version 300 es
precision highp float;
uniform float uStrength;
in float vSpeed;
out vec4 outColor;
void main() {
  // Still fluid leaves nothing; moving fluid draws, more the faster it goes.
  float a = uStrength * smoothstep(0.02, 1.5, vSpeed);
  outColor = vec4(vec3(1.0, 0.95, 0.86) * a, 1.0);
}`;

const FADE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float uKeep;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUv) * uKeep;
}`;

const screenFrag = (side: number): string => `#version 300 es
precision highp float;
${fieldGlsl(side)}
uniform sampler2D uDye;
uniform sampler2D uTrail;
uniform float uPixels;      // drawing surface, pixels per side
uniform float uReference;   // rotation of one ordinary note
uniform float uPresence;    // 0 when the fluid is still, 1 at one note's strength
uniform float uFlat;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 r = rotationAt(uv);

  // Distance to the nearest still line, in pixels, to first order.
  float slope = length(r.yz) * PI / uPixels;
  float dist = abs(r.x) / (slope + uFlat);
  float width = 1.6 * uPixels / 512.0;
  float line = clamp(width - dist, 0.0, 1.0) * uPresence;

  float tint = min(1.0, abs(r.x) / uReference) * 0.3;
  vec3 colour = (r.x > 0.0 ? vec3(1.0, 0.5, 0.2) : vec3(0.2, 0.5, 1.0)) * tint;

  // Dye and trails can pile up past white; roll them off instead of clipping.
  vec3 light = texture(uDye, uv).rgb + texture(uTrail, uv).rgb;
  colour += 1.0 - exp(-light);
  colour += line * vec3(1.0, 0.94, 0.82);
  outColor = vec4(colour, 1.0);
}`;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  size: number;
}

export class GpuRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private side: number;

  private advectDye: WebGLProgram;
  private injectDyeProgram: WebGLProgram;
  private moveParticles: WebGLProgram;
  private drawParticles: WebGLProgram;
  private fade: WebGLProgram;
  private screen: WebGLProgram;

  private dye: [Target, Target];
  private particles: [Target, Target];
  private trail: [Target, Target] | null = null;

  private weights: Float32Array;
  private frameCount = 0;

  /** `side` is the lattice size: modes run k1, k2 = 1..side. */
  constructor(canvas: HTMLCanvasElement, side: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('This piece needs WebGL 2.');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This piece needs float render targets (EXT_color_buffer_float).');
    }
    this.gl = gl;
    this.canvas = canvas;
    this.side = side;
    this.weights = new Float32Array(side * side);

    this.advectDye = this.program(FULLSCREEN_VERT, advectDyeFrag(side));
    this.injectDyeProgram = this.program(FULLSCREEN_VERT, INJECT_DYE_FRAG);
    this.moveParticles = this.program(FULLSCREEN_VERT, moveParticlesFrag(side));
    this.drawParticles = this.program(DRAW_PARTICLES_VERT, DRAW_PARTICLES_FRAG);
    this.fade = this.program(FULLSCREEN_VERT, FADE_FRAG);
    this.screen = this.program(FULLSCREEN_VERT, screenFrag(side));

    gl.bindVertexArray(gl.createVertexArray());

    this.dye = [this.target(DYE_SIZE, gl.RGBA16F, gl.LINEAR), this.target(DYE_SIZE, gl.RGBA16F, gl.LINEAR)];

    // Particles start scattered, with staggered ages so they do not all restart together.
    const n = PARTICLE_SIDE * PARTICLE_SIDE;
    const start = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const life = Math.random();
      start[i * 4] = Math.random();
      start[i * 4 + 1] = Math.random();
      start[i * 4 + 2] = Math.random() * (200 + 500 * life);
      start[i * 4 + 3] = life;
    }
    this.particles = [
      this.target(PARTICLE_SIDE, gl.RGBA32F, gl.NEAREST, start),
      this.target(PARTICLE_SIDE, gl.RGBA32F, gl.NEAREST, start),
    ];

    this.resize();
  }

  /** Match the drawing surface to the canvas's size on screen. Returns whether it changed. */
  resize(): boolean {
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const pixels = Math.max(256, Math.min(MAX_PIXELS, Math.round(rect.width * window.devicePixelRatio)));
    if (this.trail && this.canvas.width === pixels) return false;
    this.canvas.width = pixels;
    this.canvas.height = pixels;
    if (this.trail) {
      for (const t of this.trail) {
        gl.deleteTexture(t.texture);
        gl.deleteFramebuffer(t.framebuffer);
      }
    }
    this.trail = [this.target(pixels, gl.RGBA16F, gl.LINEAR), this.target(pixels, gl.RGBA16F, gl.LINEAR)];
    return true;
  }

  /**
   * Release a note's dye. `spin` is the sign of the mode's coefficient.
   */
  injectDye(k1: number, k2: number, spin: number): void {
    const gl = this.gl;
    gl.useProgram(this.injectDyeProgram);
    gl.uniform2f(gl.getUniformLocation(this.injectDyeProgram, 'uMode'), k1, k2);
    gl.uniform1f(gl.getUniformLocation(this.injectDyeProgram, 'uSpin'), spin);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawInto(this.dye[0]);
    gl.disable(gl.BLEND);
  }

  /**
   * Advance the tracers and draw.
   *
   * `weightAt(k1, k2)` returns that mode's coefficient (0 where there is no
   * such mode). `tracerStep` is how far the dye and particles move this frame,
   * in the solver's time units. `reference` is the coefficient of one ordinary
   * note: the figure is drawn at full strength at that level and fades with
   * the fluid, so the picture goes dark when the sound goes quiet.
   */
  render(weightAt: (k1: number, k2: number) => number, tracerStep: number, reference: number): void {
    const gl = this.gl;
    const side = this.side;
    this.resize();
    const trail = this.trail!;
    this.frameCount++;

    let sumSquares = 0;
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        const w = weightAt(i + 1, j + 1);
        this.weights[i * side + j] = w;
        sumSquares += w * w;
      }
    }
    const strength = Math.sqrt(sumSquares);

    // Dye: carried by the flow.
    gl.useProgram(this.advectDye);
    this.setWeights(this.advectDye);
    this.bind(this.advectDye, 'uDye', 0, this.dye[0].texture);
    gl.uniform1f(gl.getUniformLocation(this.advectDye, 'uStep'), tracerStep);
    gl.uniform1f(gl.getUniformLocation(this.advectDye, 'uKeep'), DYE_KEEP);
    this.drawInto(this.dye[1]);
    this.dye.reverse();

    // Particles: move, keeping last frame's positions for the stroke.
    gl.useProgram(this.moveParticles);
    this.setWeights(this.moveParticles);
    this.bind(this.moveParticles, 'uParticles', 0, this.particles[0].texture);
    gl.uniform1f(gl.getUniformLocation(this.moveParticles, 'uStep'), tracerStep);
    gl.uniform1f(gl.getUniformLocation(this.moveParticles, 'uTime'), (this.frameCount % 1000) * 0.137);
    this.drawInto(this.particles[1]);
    this.particles.reverse();

    // Trails: fade what is there, then add this frame's strokes.
    gl.useProgram(this.fade);
    this.bind(this.fade, 'uTexture', 0, trail[0].texture);
    gl.uniform1f(gl.getUniformLocation(this.fade, 'uKeep'), TRAIL_KEEP);
    this.drawInto(trail[1]);
    trail.reverse();

    gl.useProgram(this.drawParticles);
    this.bind(this.drawParticles, 'uNow', 0, this.particles[0].texture);
    this.bind(this.drawParticles, 'uBefore', 1, this.particles[1].texture);
    gl.uniform1i(gl.getUniformLocation(this.drawParticles, 'uSide'), PARTICLE_SIDE);
    gl.uniform1f(gl.getUniformLocation(this.drawParticles, 'uPixel'), 1 / trail[0].size);
    // Fewer pixels per particle on a small surface, so draw each one fainter.
    gl.uniform1f(gl.getUniformLocation(this.drawParticles, 'uStrength'), 0.032 * (trail[0].size / 1024) ** 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, trail[0].framebuffer);
    gl.viewport(0, 0, trail[0].size, trail[0].size);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.LINES, 0, PARTICLE_SIDE * PARTICLE_SIDE * 2);
    gl.disable(gl.BLEND);

    // The plate.
    gl.useProgram(this.screen);
    this.setWeights(this.screen);
    this.bind(this.screen, 'uDye', 0, this.dye[0].texture);
    this.bind(this.screen, 'uTrail', 1, trail[0].texture);
    gl.uniform1f(gl.getUniformLocation(this.screen, 'uPixels'), this.canvas.width);
    gl.uniform1f(gl.getUniformLocation(this.screen, 'uReference'), reference);
    // Square root, so the figure is still readable well into a note's decay.
    gl.uniform1f(gl.getUniformLocation(this.screen, 'uPresence'), Math.sqrt(Math.min(1, strength / reference)));
    // Keeps near-flat, near-zero regions from reading as one wide line.
    gl.uniform1f(gl.getUniformLocation(this.screen, 'uFlat'), Math.max(strength, 1e-9) * 1e-3 * (512 / this.canvas.width));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private setWeights(program: WebGLProgram): void {
    this.gl.uniform1fv(this.gl.getUniformLocation(program, 'uW'), this.weights);
  }

  private bind(program: WebGLProgram, name: string, unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }

  private drawInto(target: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.size, target.size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private target(size: number, format: number, filter: number, data: Float32Array | null = null): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (!data) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return { texture, framebuffer, size };
  }

  private program(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }
}
