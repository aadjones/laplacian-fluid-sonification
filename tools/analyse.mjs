/**
 * Signal analysis for tools/measure.mjs.
 *
 * The recording starts when the AudioContext does (the first tap), so audio
 * time is offset from the phrase clock by the first mark. Everything below is
 * reported on the phrase clock.
 */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Magnitude spectrum of a Hann-windowed block. */
function spectrum(x, start, size) {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const v = start + i < x.length ? x[start + i] : 0;
    re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  }
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** Peak, RMS, centroid and audible-partial count for [a, b) seconds of audio. */
function windowStats(x, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(x.length, Math.floor(b * sr));
  if (i1 <= i0) return { peak: 0, rms: 0, peakDb: null, rmsDb: null, centroidHz: null, partials: 0 };
  let peak = 0, sq = 0;
  for (let i = i0; i < i1; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; sq += v * v; }
  const rms = Math.sqrt(sq / (i1 - i0));

  // Averaged spectrum over the window, 16384-point blocks (2.9 Hz bins at 48k).
  const size = 16384;
  const acc = new Float64Array(size / 2);
  let blocks = 0;
  for (let s = i0; s + size / 2 <= i1; s += size / 2) {
    const m = spectrum(x, s, size);
    for (let i = 0; i < m.length; i++) acc[i] += m[i] * m[i];
    blocks++;
  }
  let centroid = null, partials = 0;
  if (blocks > 0) {
    let num = 0, den = 0, top = 0;
    for (let i = 1; i < acc.length; i++) {
      const f = (i * sr) / size;
      if (f < 30) continue;
      num += f * acc[i]; den += acc[i];
      if (acc[i] > top) top = acc[i];
    }
    centroid = den > 0 ? num / den : null;
    // Local maxima within 30 dB (power 1e-3) of the strongest: partials a
    // listener could plausibly hear as separate components.
    for (let i = 2; i < acc.length - 2; i++) {
      if ((i * sr) / size < 30) continue;
      if (acc[i] > top * 1e-3 && acc[i] > acc[i - 1] && acc[i] >= acc[i + 1] && acc[i] > acc[i - 2] && acc[i] >= acc[i + 2]) partials++;
    }
  }
  return { peak: round(peak, 4), rms: round(rms, 5), peakDb: round(db(peak), 1), rmsDb: round(db(rms), 1), centroidHz: round(centroid, 0), partials };
}

/** Seconds from the loudest 50 ms frame after `a` until the level stays 20 dB below it. */
function ringTime(x, sr, a, b) {
  const hop = Math.floor(sr * 0.05);
  const env = [];
  for (let s = Math.floor(a * sr); s + hop <= Math.min(x.length, b * sr); s += hop) {
    let sq = 0;
    for (let i = s; i < s + hop; i++) sq += x[i] * x[i];
    env.push(Math.sqrt(sq / hop));
  }
  if (env.length === 0) return null;
  let pi = 0;
  for (let i = 1; i < Math.min(env.length, 20); i++) if (env[i] > env[pi]) pi = i;
  const thr = env[pi] * 0.1;
  // First moment the level drops below threshold and stays there for 0.5 s.
  for (let i = pi + 1; i + 10 <= env.length; i++) {
    let below = true;
    for (let j = i; j < i + 10; j++) if (env[j] >= thr) { below = false; break; }
    if (below) return { seconds: round((i - pi) * 0.05), censored: false };
  }
  // Never settled below threshold: the ring outlasts the window.
  return { seconds: round((env.length - pi) * 0.05), censored: true };
}

/**
 * Depth of slow amplitude modulation: how much of the 20 ms RMS envelope's
 * variation lies between 0.5 and 8 Hz, relative to its mean. This is the
 * number that says whether partial pairs are beating.
 */
function beatDepth(x, sr, a, b) {
  const hop = Math.floor(sr * 0.02);
  const env = [];
  for (let s = Math.floor(a * sr); s + hop <= Math.min(x.length, b * sr); s += hop) {
    let sq = 0;
    for (let i = s; i < s + hop; i++) sq += x[i] * x[i];
    env.push(Math.sqrt(sq / hop));
  }
  const size = 256; // 5.12 s of envelope
  if (env.length < size) return null;
  const start = env.length - size;
  let mean = 0;
  for (let i = 0; i < size; i++) mean += env[start + i];
  mean /= size;
  if (mean < 1e-6) return 0;
  // Detrend with a line so a plain decay does not read as modulation.
  const first = env[start], lastV = env[start + size - 1];
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const trend = first + ((lastV - first) * i) / (size - 1);
    re[i] = (env[start + i] - trend) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  }
  fft(re, im);
  let p = 0;
  for (let i = 1; i < size / 2; i++) {
    const f = i / (size * 0.02);
    if (f >= 0.5 && f <= 8) p += re[i] * re[i] + im[i] * im[i];
  }
  return round(Math.sqrt(p) / (size * mean) * 4, 4);
}

export function analyse(pcm, sr, marks, state) {
  const offset = marks.probe1; // audio t=0 is roughly the first tap
  const A = (t) => t - offset;
  const seg = (name, a, b) => ({ name, from: a, to: b, ...windowStats(pcm, sr, A(a), A(b)) });

  const segments = [
    seg('probe1 attack', marks.probe1, marks.probe1 + 1),
    seg('probe1 ring', marks.probe1 + 1, marks.probe1 + 6),
    seg('probe1 tail', marks.probe1 + 6, marks.chord),
    seg('chord', marks.chord, marks.chord + 4),
    seg('after chord', marks.chord + 4, marks.busy),
    seg('busy first half', marks.busy, marks.busy + 20),
    seg('busy second half', marks.busy + 20, marks.busy + 40),
    seg('probe2 attack', marks.probe2, marks.probe2 + 1),
    seg('probe2 ring', marks.probe2 + 1, marks.probe2 + 6),
    seg('probe2 tail', marks.probe2 + 6, marks.idle),
    seg('idle', marks.idle, marks.end),
  ];

  const per5s = [];
  for (let t = 0; t + 5 <= pcm.length / sr; t += 5) {
    per5s.push({ t: round(t + offset, 0), ...windowStats(pcm, sr, t, t + 5) });
  }

  const part = (a, b) => {
    const v = state.filter((s) => s.t >= a && s.t < b).map((s) => s.participation);
    return v.length ? round(v.reduce((x, y) => x + y, 0) / v.length, 1) : null;
  };
  const last = state.at(-1);
  const first = state.find((s) => s.ctxState !== 'none') ?? last;

  const summary = {
    audioContext: {
      stateFirst: first.ctxState,
      stateLast: last.ctxState,
      currentTimeLast: round(last.ctxTime, 2),
      wallSecondsRecorded: round(pcm.length / sr, 2),
      sampleRate: sr,
    },
    fps: last.fps,
    rank: last.rank,
    overall: windowStats(pcm, sr, 0, pcm.length / sr),
    probe1: {
      ...windowStats(pcm, sr, A(marks.probe1), A(marks.probe1 + 6)),
      ringTo20dB: ringTime(pcm, sr, A(marks.probe1), A(marks.chord) - 0.5),
      beatDepth: beatDepth(pcm, sr, A(marks.probe1), A(marks.probe1 + 8)),
    },
    probe2: {
      ...windowStats(pcm, sr, A(marks.probe2), A(marks.probe2 + 6)),
      ringTo20dB: ringTime(pcm, sr, A(marks.probe2), A(marks.idle) - 0.5),
      beatDepth: beatDepth(pcm, sr, A(marks.probe2), A(marks.probe2 + 8)),
    },
    idle: windowStats(pcm, sr, A(marks.idle + 5), A(marks.end)),
    activeModes: {
      note: 'participation ratio of w, (sum|w|)^2 / sum(w^2), out of `rank`',
      afterProbe1: part(marks.probe1 + 0.5, marks.probe1 + 6),
      duringChord: part(marks.chord, marks.chord + 4),
      duringBusy: part(marks.busy, marks.busy + 40),
      afterProbe2: part(marks.probe2 + 0.5, marks.probe2 + 6),
      idle: part(marks.idle + 5, marks.end),
    },
  };
  return { summary, marks, segments, per5s, state };
}
