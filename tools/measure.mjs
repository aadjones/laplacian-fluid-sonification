/**
 * Measure the instrument by its signal.
 *
 *   node tools/measure.mjs <label> [url]
 *
 * Drives a fixed, seeded, pointer-only phrase against the running dev server,
 * records the real post-limiter output, and writes <label>.wav and
 * <label>.json into tools/renders/. Compare two labels with tools/compare.mjs.
 *
 * The phrase, in seconds:
 *     2  tap A            (the probe: same point, same seeded direction)
 *    16  stir, 4 s
 *    32  busy playing, 40 s of taps and stirs
 *    76  tap A again      (the probe, after the instrument has been played)
 *    90  idle to 110
 *
 * Playwright comes from the npx cache, because it is not a project dependency.
 */
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from './analyse.mjs';

const label = process.argv[2] ?? 'render';
const url = process.argv[3] ?? 'http://localhost:5173/';
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'renders');
mkdirSync(outDir, { recursive: true });

function findPlaywright() {
  const root = join(homedir(), '.npm/_npx');
  for (const d of readdirSync(root)) {
    const p = join(root, d, 'node_modules/playwright');
    if (existsSync(p)) return p;
  }
  throw new Error('playwright not found in the npx cache; run `npx playwright --version` once');
}
function findChrome() {
  const root = join(homedir(), 'Library/Caches/ms-playwright');
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const b of builds) {
    const p = join(root, b, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('no chromium build found');
}

const { chromium } = createRequire(import.meta.url)(findPlaywright());
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));

await page.addInitScript(() => {
  // Seeded Math.random, so tap directions and hammer jitter repeat run to run.
  let s = 0x9e3779b9;
  window.__reseed = () => { s = 0x9e3779b9; };
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Tap whatever reaches the destination: the real post-limiter signal.
  const rec = { chunks: [], ctx: null, sampleRate: 0 };
  window.__rec = rec;
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !rec.ctx) {
      rec.ctx = dest.context;
      rec.sampleRate = dest.context.sampleRate;
      const sp = dest.context.createScriptProcessor(4096, 2, 1);
      sp.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0);
        const r = e.inputBuffer.getChannelData(1);
        const m = new Float32Array(l.length);
        for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]);
        rec.chunks.push(m);
      };
      rec.sp = sp;
      connect.call(sp, dest); // must reach the destination to be pulled; outputs silence
    }
    if (dest instanceof AudioDestinationNode && rec.sp) connect.call(this, rec.sp);
    return connect.call(this, dest, ...rest);
  };
});

await page.goto(url + '?v=' + Date.now());
const box = await page.locator('canvas#fluid').boundingBox();
const at = (fx, fy) => [box.x + fx * box.width, box.y + fy * box.height];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const until = async (sec) => { const d = t0 + sec * 1000 - Date.now(); if (d > 0) await sleep(d); };

const samples = [];
const state = [];
async function poll() {
  const r = await page.evaluate(() => {
    const rec = window.__rec;
    const chunks = rec.chunks.splice(0);
    let n = 0;
    for (const c of chunks) n += c.length;
    const all = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const bytes = new Uint8Array(all.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const w = window.__lfs?.sim?.w;
    let l1 = 0, l2 = 0, top = 0;
    if (w) for (let k = 0; k < w.length; k++) { const a = Math.abs(w[k]); l1 += a; l2 += a * a; if (a > top) top = a; }
    return {
      pcm: btoa(bin),
      sampleRate: rec.sampleRate,
      ctxState: rec.ctx ? rec.ctx.state : 'none',
      ctxTime: rec.ctx ? rec.ctx.currentTime : 0,
      rank: w ? w.length : 0,
      participation: l2 > 0 ? (l1 * l1) / l2 : 0,
      wL1: l1,
      memory: window.__lfs?.sediment?.total ?? 0,
      hum: window.__lfs?.sonifier?.strategies?.[0]?.hum?.size ?? 0,
      voices: window.__lfs?.sonifier?.strategies?.[0]?.partials?.length ?? -1,
      fps: document.querySelector('#fps-display')?.textContent ?? '',
    };
  });
  const buf = Buffer.from(r.pcm, 'base64');
  samples.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice());
  state.push({ t: (Date.now() - t0) / 1000, ctxState: r.ctxState, ctxTime: r.ctxTime, participation: r.participation, wL1: r.wL1, rank: r.rank, voices: r.voices, memory: r.memory, hum: r.hum, fps: r.fps, sampleRate: r.sampleRate });
}
let polling = true;
const poller = (async () => { while (polling) { await poll(); await sleep(500); } })();

async function tap(fx, fy) {
  const [x, y] = at(fx, fy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
/** Stir in a circle about (cx,cy) for `sec` seconds. */
async function stir(cx, cy, radius, sec, turns) {
  const steps = Math.round(sec * 60);
  const [x0, y0] = at(cx + radius, cy);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const start = Date.now();
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * turns * 2 * Math.PI;
    const [x, y] = at(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
    await page.mouse.move(x, y);
    const d = start + (i / steps) * sec * 1000 - Date.now();
    if (d > 0) await sleep(d);
  }
  await page.mouse.up();
}

const PROBE = [0.31, 0.37];
const marks = {};
const mark = (name) => { marks[name] = (Date.now() - t0) / 1000; };

// Reseed before each probe so both are the same strike: same direction, same jitter.
// Reseed and press inside one task: the frame loop also draws random numbers,
// so any frame between the reseed and the press would change the strike.
const probe = async () => {
  const [x, y] = at(...PROBE);
  await page.evaluate(([cx, cy]) => {
    window.__reseed();
    const c = document.querySelector('canvas#fluid');
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, [x, y]);
};
await until(2); mark('probe1'); await probe();
await until(16); mark('stir'); await stir(0.55, 0.5, 0.2, 4, 3);
await until(32); mark('busy');
{
  // 40 s of playing: a tap every 2 s walking a fixed lattice, a stir every 8 s.
  const pts = [[0.2, 0.25], [0.7, 0.3], [0.45, 0.7], [0.8, 0.75], [0.3, 0.55], [0.6, 0.45]];
  for (let i = 0; i < 20; i++) {
    await until(32 + i * 2);
    if (i % 4 === 3) await stir(pts[i % 6][0], pts[i % 6][1], 0.12, 1.5, 1.5);
    else await tap(...pts[i % 6]);
  }
}
await until(76); mark('probe2'); await probe();
await until(90); mark('idle');
await until(110); mark('end');

polling = false;
await poller;
await poll();
await browser.close();

let n = 0;
for (const c of samples) n += c.length;
const pcm = new Float32Array(n);
let o = 0;
for (const c of samples) { pcm.set(c, o); o += c.length; }
const sampleRate = state.at(-1).sampleRate || 48000;

// 16-bit mono WAV, so the render can be listened to as well as measured.
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
writeFileSync(join(outDir, `${label}.wav`), wav);

const report = analyse(pcm, sampleRate, marks, state);
writeFileSync(join(outDir, `${label}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
