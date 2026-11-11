/**
 * Side-by-side summary of renders made by tools/measure.mjs.
 *
 *   node tools/compare.mjs baseline voices
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'renders');
const labels = process.argv.slice(2);
const runs = labels.map((l) => JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8')));

const seg = (r, name) => r.segments.find((s) => s.name === name);
const voices = (r, a, b) => {
  const v = r.state.filter((s) => s.t >= a && s.t < b).map((s) => s.voices);
  return v.length ? `${Math.min(...v)}-${Math.max(...v)}` : '';
};
const ring = (p) => (p.ringTo20dB ? `${p.ringTo20dB.censored ? '>' : ''}${p.ringTo20dB.seconds}` : '');

const rows = [
  ['AudioContext state', (r) => r.summary.audioContext.stateLast],
  ['AudioContext currentTime (s)', (r) => r.summary.audioContext.currentTimeLast],
  ['frame rate', (r) => r.summary.fps],
  ['overall peak dB', (r) => r.summary.overall.peakDb],
  ['overall RMS dB', (r) => r.summary.overall.rmsDb],
  ['overall centroid Hz', (r) => r.summary.overall.centroidHz],
  ['probe 1 peak dB', (r) => r.summary.probe1.peakDb],
  ['probe 1 RMS dB', (r) => r.summary.probe1.rmsDb],
  ['probe 1 centroid Hz', (r) => r.summary.probe1.centroidHz],
  ['probe 1 partials', (r) => r.summary.probe1.partials],
  ['probe 1 ring to -20 dB (s)', (r) => ring(r.summary.probe1)],
  ['probe 1 beat depth', (r) => r.summary.probe1.beatDepth],
  ['probe 2 peak dB', (r) => r.summary.probe2.peakDb],
  ['probe 2 RMS dB', (r) => r.summary.probe2.rmsDb],
  ['probe 2 centroid Hz', (r) => r.summary.probe2.centroidHz],
  ['probe 2 partials', (r) => r.summary.probe2.partials],
  ['probe 2 ring to -20 dB (s)', (r) => ring(r.summary.probe2)],
  ['probe 2 beat depth', (r) => r.summary.probe2.beatDepth],
  ['busy 1st half RMS dB', (r) => seg(r, 'busy first half').rmsDb],
  ['busy 2nd half RMS dB', (r) => seg(r, 'busy second half').rmsDb],
  ['busy 1st half centroid Hz', (r) => seg(r, 'busy first half').centroidHz],
  ['busy 2nd half centroid Hz', (r) => seg(r, 'busy second half').centroidHz],
  ['busy 1st half partials', (r) => seg(r, 'busy first half').partials],
  ['busy 2nd half partials', (r) => seg(r, 'busy second half').partials],
  ['voices in use while busy', (r) => voices(r, r.marks.busy + 2, r.marks.probe2)],
  ['idle RMS dB', (r) => r.summary.idle.rmsDb],
  ['active modes after probe 1', (r) => r.summary.activeModes.afterProbe1],
  ['active modes while busy', (r) => r.summary.activeModes.duringBusy],
  ['active modes after probe 2', (r) => r.summary.activeModes.afterProbe2],
  ['active modes idle', (r) => r.summary.activeModes.idle],
];

const w0 = Math.max(...rows.map((r) => r[0].length));
console.log(''.padEnd(w0), ...labels.map((l) => l.padStart(14)));
for (const [name, get] of rows) {
  console.log(name.padEnd(w0), ...runs.map((r) => String(get(r) ?? '').padStart(14)));
}

// Evolution: RMS and centroid in 5 s windows.
console.log('\n5 s windows: RMS dB / centroid Hz');
const n = Math.max(...runs.map((r) => r.per5s.length));
for (let i = 0; i < n; i++) {
  const t = runs.find((r) => r.per5s[i])?.per5s[i].t;
  console.log(String(t).padStart(4), ...runs.map((r) => (r.per5s[i] ? `${r.per5s[i].rmsDb} / ${r.per5s[i].centroidHz}` : '').padStart(16)));
}
