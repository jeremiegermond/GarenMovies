const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg.cjs');

// Intro / end-credits detection ("skip intro", and the next-episode countdown
// starting when the credits roll). Three sources, best first:
//   1. Chapters named Opening / Intro / Ending / Credits / Générique… (anime,
//      many WEB-DLs) — instant.
//   2. Audio fingerprints shared by two episodes of the same show (the method of
//      Jellyfin's Intro Skipper): the opening theme — and often the credits song
//      — is the same audio in every episode, so the longest common stretch near
//      the start (resp. the end) of two episodes is the intro (resp. credits).
//      Fingerprints are the classic Philips/Haitsma–Kalker scheme: 32 bits per
//      0.1s from signs of band-energy differences, robust to re-encoding.
//   3. End credits only: a long "almost black" stretch running to the end of the
//      file (text on black), sampled on keyframes so it's cheap.
// Everything runs locally on the audio/video; results are cached on disk.

const SR = 8000;          // analysis sample rate (Hz)
const FRAME = 2048;       // 0.256s analysis window
const HOP = 800;          // one fingerprint every 0.1s
const STEP = HOP / SR;    // seconds per fingerprint
const BANDS = 33;         // → 32 bits per fingerprint
const F_LO = 300, F_HI = 2000;

const INTRO_SCAN = 600;   // seconds from the start searched for the opening
const OUTRO_SCAN = 480;   // seconds before the end searched for the credits
const MIN_LEN = 15;       // shortest intro/credits we accept (s)
const MAX_INTRO = 150;
const MAX_CREDITS = 420;

const MATCH_BITS = 10;    // two fingerprints "match" when they differ by ≤ this many bits
const GAP = 20;           // a common stretch may have holes up to this many fingerprints (2s)
const DENSITY = 0.35;     // …but at least this share of its fingerprints must match

// ── audio → fingerprints ──

function decodeAudio(file, start, duration) {
  return new Promise((resolve, reject) => {
    const bin = ffmpeg.getFfmpegPath();
    if (!bin) return reject(new Error('ffmpeg unavailable'));
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-t', String(duration), '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1');
    const p = spawn(bin, args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return reject(new Error(`no audio decoded (ffmpeg exit ${code})`));
      // copy → aligned buffer for the Int16 view
      resolve(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1))));
    });
  });
}

const hann = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const bandEdges = Array.from({ length: BANDS + 1 }, (_, k) =>
  Math.round((F_LO * Math.pow(F_HI / F_LO, k / BANDS)) * FRAME / SR));

function fft(re, im) { // in-place iterative radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function fingerprint(samples) {
  const n = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const hashes = new Int32Array(n);
  const valid = new Uint8Array(n);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = null;
  for (let f = 0; f < n; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < FRAME; i++) { const s = samples[off + i]; sq += s * s; re[i] = s * hann[i]; im[i] = 0; }
    fft(re, im);
    const e = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = bandEdges[b]; k < bandEdges[b + 1]; k++) sum += re[k] * re[k] + im[k] * im[k];
      e[b] = sum;
    }
    if (prev) {
      let h = 0;
      for (let m = 0; m < 32; m++) {
        if ((e[m] - e[m + 1]) - (prev[m] - prev[m + 1]) > 0) h |= (1 << m);
      }
      hashes[f] = h;
      valid[f] = Math.sqrt(sq / FRAME) > 60 ? 1 : 0; // silence hashes to all-zeros: never count it as common audio
    }
    prev = e;
  }
  return { hashes, valid };
}

// ── longest common stretch between two fingerprint runs ──

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function longestRun(A, B, d) {
  let best = null, start = -1, last = -1, hits = 0;
  const close = () => {
    if (start < 0) return;
    const len = last - start + 1;
    if (hits / len >= DENSITY && (!best || len > best.len)) best = { len, a0: start, a1: last, d };
  };
  const i0 = Math.max(0, -d), i1 = Math.min(A.hashes.length, B.hashes.length - d);
  for (let i = i0; i < i1; i++) {
    const j = i + d;
    if (!A.valid[i] || !B.valid[j] || popcount(A.hashes[i] ^ B.hashes[j]) > MATCH_BITS) continue;
    if (start < 0 || i - last > GAP) { close(); start = i; hits = 0; }
    last = i; hits++;
  }
  close();
  return best;
}

// Common stretch of A and B (any relative offset): { aStart, aEnd, bStart, bEnd } in seconds, or null.
function commonStretch(A, B, minLen, maxLen) {
  const nA = A.hashes.length, nB = B.hashes.length;
  if (!nA || !nB) return null;
  // Coarse pass: every 3rd fingerprint, score each offset by its number of matches.
  const scores = [];
  for (let d = -(nA - 1); d < nB; d++) {
    let c = 0;
    const i0 = Math.max(0, -d), i1 = Math.min(nA, nB - d);
    for (let i = i0; i < i1; i += 3) {
      const j = i + d;
      if (A.valid[i] && B.valid[j] && popcount(A.hashes[i] ^ B.hashes[j]) <= MATCH_BITS) c++;
    }
    if (c >= 10) scores.push([c, d]);
  }
  scores.sort((x, y) => y[0] - x[0]);
  const tried = [];
  let best = null;
  for (const [, d] of scores) {
    if (tried.length >= 8) break;
    if (tried.some((t) => Math.abs(t - d) <= 3)) continue;
    tried.push(d);
    for (const dd of [d - 1, d, d + 1]) {
      const r = longestRun(A, B, dd);
      if (r && (!best || r.len > best.len)) best = r;
    }
  }
  if (!best) return null;
  const len = best.len * STEP;
  if (len < minLen || len > maxLen) return null;
  const t = (i) => i * STEP;
  return {
    aStart: t(best.a0), aEnd: t(best.a1) + FRAME / SR,
    bStart: t(best.a0 + best.d), bEnd: t(best.a1 + best.d) + FRAME / SR
  };
}

// ── 1. chapters ──

const RX_INTRO = /\b(intro|introduction|opening|op\s*\d*|ouverture|générique de début|generique de debut|title sequence|main titles?)\b/i;
const RX_CREDITS = /\b(credits?|end credits|ending|ed\s*\d*|outro|closing|générique de fin|generique de fin)\b/i;
const RX_PREVIEW = /\b(preview|next episode|prochain [ée]pisode|aper[çc]u|avant-premi[èe]re)\b/i;
const RX_GENERIC = /\b(générique|generique)\b/i;

function fromChapters(chapters, duration) {
  let intro = null, credits = null;
  (chapters || []).forEach((c, i) => {
    const title = c.title || '';
    const end = c.end > c.start ? c.end : (chapters[i + 1]?.start ?? duration);
    const pos = duration ? c.start / duration : 0;
    const generic = RX_GENERIC.test(title);
    if (!intro && pos < 0.5 && !RX_CREDITS.test(title) && (RX_INTRO.test(title) || (generic && pos < 0.4))) {
      intro = { start: c.start, end };
    } else if (!credits && pos > 0.5 && (RX_CREDITS.test(title) || RX_PREVIEW.test(title) || (generic && pos > 0.6))) {
      credits = { start: c.start, end: duration || end };
    }
  });
  if (intro && (intro.end - intro.start < 5 || intro.end - intro.start > 300)) intro = null;
  return { intro, credits };
}

// ── 3. end credits on a black background ──

function blackRuns(file, start) {
  return new Promise((resolve) => {
    const bin = ffmpeg.getFfmpegPath();
    if (!bin) return resolve([]);
    // Keyframes only (-skip_frame nokey): a few dozen pictures for 8 minutes.
    const args = ['-hide_banner', '-skip_frame', 'nokey'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', file, '-an', '-sn', '-dn',
      '-vf', 'scale=160:-2,blackdetect=d=0:pic_th=0.90:pix_th=0.10', '-f', 'null', '-');
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const runs = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
        .map((m) => ({ s: start + parseFloat(m[1]), e: start + parseFloat(m[2]) }));
      resolve(runs);
    });
  });
}

// Black stretches (merged across short non-black gaps like a channel logo) that
// run to the very end, long enough and late enough to be credits.
function creditsFromBlack(runs, duration) {
  if (!runs.length) return null;
  const last = runs[runs.length - 1];
  if (duration - last.e > 15) return null;
  let start = last.s, black = last.e - last.s;
  for (let i = runs.length - 2; i >= 0; i--) {
    // ≤ 20s: a channel logo between black stretches, as seen through ~10s keyframe sampling.
    // Not more — merging further could swallow a dark final scene.
    if (start - runs[i].e > 20) break;
    start = runs[i].s;
    black += runs[i].e - runs[i].s;
  }
  const span = duration - start;
  if (span < 20 || span > MAX_CREDITS || black / span < 0.5 || start < duration * 0.66) return null;
  return { start, end: duration };
}

// ── orchestration, cache ──

const VERSION = 1;
let cacheFile = null;
let cache = {};
function setCacheFile(file) {
  cacheFile = file;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch { cache = {}; }
}
function saveCache() {
  if (!cacheFile) return;
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
}

const sig = (m) => `${m.source?.size || 0}:${Math.round(m.source?.mtime || 0)}`;
function entryFor(m) {
  let e = cache[m.id];
  if (!e || e.v !== VERSION || e.sig !== sig(m)) {
    e = cache[m.id] = { v: VERSION, sig: sig(m), intro: null, credits: null, src: {}, done: {}, pairs: [] };
  }
  return e;
}
const view = (e) => ({ intro: e.intro || null, credits: e.credits || null, source: e.src });

async function durationOf(m) {
  if (m.videoDuration > 0) return m.videoDuration;
  if (m.duration > 0) return m.duration;
  const info = await ffmpeg.probeFile(m.source.path).catch(() => null);
  return info?.videoDuration || info?.duration || 0;
}

// Fingerprints of an episode's start ('head') or end ('tail'), kept for reuse:
// analysing E1+E2 then E2+E3 decodes E2 once.
const fpCache = new Map();
async function fpOf(m, part, duration) {
  const key = `${m.id}:${part}:${sig(m)}`;
  if (fpCache.has(key)) return fpCache.get(key);
  const start = part === 'head' ? 0 : Math.max(duration * 0.5, duration - OUTRO_SCAN);
  const len = part === 'head' ? Math.min(INTRO_SCAN, duration * 0.45) : duration - start;
  const fp = { start, ...fingerprint(await decodeAudio(m.source.path, start, len)) };
  fpCache.set(key, fp);
  if (fpCache.size > 40) fpCache.delete(fpCache.keys().next().value);
  return fp;
}

async function analyze(m, pair) {
  const e = entryFor(m);
  const dur = await durationOf(m);
  if (!dur) return view(e);

  if (!e.done.chapters) {
    const chapters = m.chapters ?? (await ffmpeg.probeFile(m.source.path).catch(() => null))?.chapters ?? [];
    const r = fromChapters(chapters, dur);
    if (r.intro) { e.intro = r.intro; e.src.intro = 'chapters'; }
    if (r.credits) { e.credits = r.credits; e.src.credits = 'chapters'; }
    e.done.chapters = true;
  }

  if (pair && (!e.intro || !e.credits) && !e.pairs.includes(pair.id)) {
    const pe = entryFor(pair);
    const pdur = await durationOf(pair);
    try {
      if (!e.intro && pdur) {
        const [A, B] = [await fpOf(m, 'head', dur), await fpOf(pair, 'head', pdur)];
        const r = commonStretch(A, B, MIN_LEN, MAX_INTRO);
        if (r && r.aStart < dur * 0.4) {
          e.intro = { start: A.start + r.aStart, end: A.start + r.aEnd }; e.src.intro = 'audio';
          if (!pe.intro) { pe.intro = { start: B.start + r.bStart, end: B.start + r.bEnd }; pe.src.intro = 'audio'; }
        }
      }
      if (!e.credits && pdur) {
        const [A, B] = [await fpOf(m, 'tail', dur), await fpOf(pair, 'tail', pdur)];
        const r = commonStretch(A, B, MIN_LEN, MAX_CREDITS);
        if (r && A.start + r.aStart > dur * 0.5) {
          e.credits = { start: A.start + r.aStart, end: dur }; e.src.credits = 'audio';
          if (!pe.credits) { pe.credits = { start: B.start + r.bStart, end: pdur }; pe.src.credits = 'audio'; }
        }
      }
    } catch (err) {
      console.warn('[markers] fingerprint failed:', err.message);
    }
    e.pairs.push(pair.id);
    pe.pairs.includes(m.id) || pe.pairs.push(m.id);
  }

  if (!e.credits && !e.done.black) {
    const start = Math.max(dur * 0.5, dur - OUTRO_SCAN);
    e.credits = creditsFromBlack(await blackRuns(m.source.path, start), dur);
    if (e.credits) e.src.credits = 'black';
    e.done.black = true;
  }

  saveCache();
  console.log('[markers]', path.basename(m.source.path), '→',
    e.intro ? `intro ${e.intro.start.toFixed(1)}–${e.intro.end.toFixed(1)}s (${e.src.intro})` : 'no intro',
    '|', e.credits ? `credits from ${e.credits.start.toFixed(1)}s (${e.src.credits})` : 'no credits');
  return view(e);
}

function settled(m, pair) {
  const e = cache[m.id];
  if (!e || e.v !== VERSION || e.sig !== sig(m) || !e.done.chapters) return false;
  if (!e.credits && !e.done.black) return false;
  if (pair && (!e.intro || !e.credits) && !e.pairs.includes(pair.id)) return false;
  return true;
}

// One analysis at a time (they decode audio/video): requests queue up, and a
// second request for a film already being analysed shares the same result.
let chain = Promise.resolve();
const inflight = new Map();
function getMarkers(m, pair = null) {
  if (settled(m, pair)) return Promise.resolve(view(cache[m.id]));
  if (inflight.has(m.id)) return inflight.get(m.id);
  const p = chain.then(() => analyze(m, pair));
  chain = p.catch(() => {});
  inflight.set(m.id, p);
  p.finally(() => inflight.delete(m.id)).catch(() => {});
  return p;
}

module.exports = {
  setCacheFile, getMarkers,
  // exposed for tests
  decodeAudio, fingerprint, commonStretch, fromChapters, blackRuns, creditsFromBlack, STEP
};
