const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg.cjs');

// Automatic subtitle sync (the idea of ffsubsync): turn the film's audio into a
// "someone is talking" signal, turn the subtitle file into a "a line is on
// screen" signal, and slide one over the other until they line up best. That
// gives the offset; trying the usual frame-rate mismatches (25 ↔ 23.976 ↔ 24)
// as well catches subtitles that drift further and further off.
//
// Only a few windows of audio are decoded (seeking there is cheap), so even a
// 50 GB remux is analysed in seconds; the windows sit far apart so a frame-rate
// mismatch shows. Results are cached on disk per subtitle.

const SR = 8000;          // decode rate (Hz)
const RATE = 50;          // signal resolution: one value per 20 ms
const HOP = SR / RATE;
const WINDOWS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92]; // where we listen, as a share of the duration
const WIN_LEN = 240;      // seconds decoded per window
const MAX_LAG = 600;      // offsets searched: ± 10 min
const SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
const MIN_SHIFT = 0.2;    // below this the subtitles are already in sync
const MIN_CONF = 1.45;    // how far the best match must stand above the runner-up (wrong subtitles: ~1.1)

const VERSION = 1;        // bump when the algorithm changes, so cached results are redone

// ── audio → speech signal ──

// Log energy every 20 ms in the speech band, of the centre channel when there
// is one (dialogue lives there in 5.1/7.1 mixes, music and effects mostly don't).
function decodeEnergy(file, start, duration, center) {
  return new Promise((resolve, reject) => {
    const bin = ffmpeg.getFfmpegPath();
    if (!bin) return reject(new Error('ffmpeg unavailable'));
    const mix = center ? 'pan=mono|c0=FC,' : '';
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(duration),
      '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', `${mix}highpass=f=250,lowpass=f=3500`,
      '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'];
    const p = spawn(bin, args, { windowsHide: true });
    const out = [];
    let acc = 0, n = 0, carry = null;
    p.stdout.on('data', (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = buf.length & ~1;
      carry = even < buf.length ? buf.subarray(even) : null;
      for (let i = 0; i < even; i += 2) {
        const s = buf.readInt16LE(i);
        acc += s * s;
        if (++n === HOP) { out.push(10 * Math.log10(acc / HOP + 1)); acc = 0; n = 0; }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (!out.length) return reject(new Error(`no audio decoded (ffmpeg exit ${code})`));
      resolve(Float32Array.from(out));
    });
  });
}

// Speech / no speech from the energy: louder than the local noise floor by a
// margin. The floor is a low percentile over the surrounding ~20 s, so quiet
// scenes and loud ones are judged against their own background.
function voiceActivity(e) {
  const BLOCK = RATE;            // 1 s blocks
  const nb = Math.ceil(e.length / BLOCK);
  const lo = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const s = Array.from(e.subarray(b * BLOCK, (b + 1) * BLOCK)).sort((x, y) => x - y);
    lo[b] = s[Math.floor(s.length * 0.1)];
  }
  const out = new Int8Array(e.length);
  const R = 10;
  for (let b = 0; b < nb; b++) {
    const near = Array.from(lo.subarray(Math.max(0, b - R), Math.min(nb, b + R + 1))).sort((x, y) => x - y);
    const floor = near[Math.floor(near.length * 0.3)];
    for (let i = b * BLOCK; i < Math.min(e.length, (b + 1) * BLOCK); i++) {
      out[i] = e[i] > floor + 9 ? 1 : -1;
    }
  }
  return out;
}

// ── subtitles → on-screen signal ──

function parseVttTimes(vtt) {
  const cues = [];
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/g;
  let m;
  while ((m = re.exec(vtt))) {
    const t = (h, mi, s, ms) => (+(h || 0)) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    const a = t(m[1], m[2], m[3], m[4]), b = t(m[5], m[6], m[7], m[8]);
    if (b > a) cues.push([a, b]);
  }
  return cues;
}

// ── correlation ──

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = k; i < n; i += len) {
        const b = i + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[i] - tr; im[b] = im[i] - ti; re[i] += tr; im[i] += ti;
      }
    }
  }
}

// audio: Int8Array of +1 / -1 (heard) and 0 (not decoded). For one scale, the
// best lag (in samples) and how far that peak stands out from the other lags.
function bestLag(audioSpec, P, cues, scale, maxLag) {
  const re = new Float64Array(P), im = new Float64Array(P);
  re.fill(-1, 0, Math.min(P, audioSpec.len + maxLag));
  for (const [a, b] of cues) {
    const i0 = Math.max(0, Math.round(a * scale * RATE)), i1 = Math.min(P, Math.round(b * scale * RATE));
    for (let i = i0; i < i1; i++) re[i] = 1;
  }
  fft(re, im, false);
  // cross-correlation c[k] = Σ audio[i + k] · sub[i]  ⇒  A · conj(S)
  const { re: ar, im: ai } = audioSpec;
  for (let i = 0; i < P; i++) {
    const r = ar[i] * re[i] + ai[i] * im[i];
    const m = ai[i] * re[i] - ar[i] * im[i];
    re[i] = r; im[i] = m;
  }
  fft(re, im, true);
  const at = (k) => re[(k + P) % P] / P;
  let best = -Infinity, bestK = 0, sum = 0;
  for (let k = -maxLag; k <= maxLag; k++) {
    const v = at(k);
    sum += v;
    if (v > best) { best = v; bestK = k; }
  }
  const mean = sum / (2 * maxLag + 1);
  // The runner-up away from the peak: a true match stands well above it, a
  // wrong subtitle (or no dialogue) gives several peaks of about the same height.
  let second = -Infinity;
  for (let k = -maxLag; k <= maxLag; k++) if (Math.abs(k - bestK) > 5 * RATE) second = Math.max(second, at(k));
  return { lag: bestK, score: best, sharp: (best - mean) / Math.max(1, second - mean) };
}

async function align(vad, cues, duration) {
  const maxLag = MAX_LAG * RATE;
  const subEnd = Math.max(...cues.map((c) => c[1])) * Math.max(...SCALES);
  let P = 1;
  while (P < Math.max(vad.length, subEnd * RATE) + 2 * maxLag) P <<= 1;
  const re = new Float64Array(P), im = new Float64Array(P);
  for (let i = 0; i < vad.length; i++) re[i] = vad[i];
  fft(re, im, false);
  const audioSpec = { re, im, len: Math.round(duration * RATE) };
  let best = null;
  for (const scale of SCALES) {
    await new Promise((r) => setImmediate(r)); // let the server breathe between the FFTs
    const r = bestLag(audioSpec, P, cues, scale, maxLag);
    // A frame-rate fix must clearly beat "same speed" to be taken.
    const better = !best || (scale === 1 ? r.score > best.score : r.score > best.score * 1.03);
    if (better) best = { ...r, scale };
  }
  return best;
}

// ── public ──

// The speech signal only depends on the film, so every subtitle of the film
// (and every guest asking) reuses it; keep the last few films in memory.
const speechCache = new Map();

function speech(media) {
  const file = media.source.path;
  if (speechCache.has(file)) return speechCache.get(file);
  const job = listen(media);
  speechCache.set(file, job);
  job.catch(() => speechCache.delete(file));
  while (speechCache.size > 3) speechCache.delete(speechCache.keys().next().value);
  return job;
}

async function listen(media) {
  const file = media.source.path;
  const duration = media.duration;
  const track = (media.audioTracks || [])[0];
  const center = /FC|5\.1|7\.1|6\.1/i.test(track?.channelLayout || '') || (track?.channels || 0) >= 6;
  const vad = new Int8Array(Math.ceil(duration * RATE));
  for (const at of WINDOWS) {
    const start = Math.max(0, Math.min(duration - WIN_LEN, at * duration - WIN_LEN / 2));
    let e;
    try { e = await decodeEnergy(file, start, WIN_LEN, center); }
    catch (err) { if (!center) throw err; e = await decodeEnergy(file, start, WIN_LEN, false); }
    const v = voiceActivity(e);
    vad.set(v.subarray(0, Math.max(0, vad.length - Math.round(start * RATE))), Math.round(start * RATE));
  }
  return vad;
}

async function analyse(media, vtt) {
  const duration = media.duration;
  if (!media.source?.path || !duration) throw new Error('durée inconnue');
  const cues = parseVttTimes(vtt);
  if (cues.length < 20) throw new Error('trop peu de sous-titres');
  const vad = await speech(media);
  const best = await align(vad, cues, duration);
  let offset = best.lag / RATE;
  const confident = best.sharp >= MIN_CONF;
  const scale = confident ? best.scale : 1;
  if (!confident || (scale === 1 && Math.abs(offset) < MIN_SHIFT)) offset = 0;
  return {
    offset: confident ? +offset.toFixed(2) : 0, scale, confidence: +best.sharp.toFixed(2),
    sure: confident, applied: confident && (offset !== 0 || scale !== 1)
  };
}

let cacheFile = null;
let cache = {};
const inflight = new Map();

function setCachePath(p) {
  cacheFile = p;
  try { cache = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { cache = {}; }
}

function persist() {
  if (!cacheFile) return;
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* ignore */ }
}

function keyFor(media, sub) {
  let stamp = '';
  try { const st = fs.statSync(sub.type === 'sidecar' ? sub.path : media.source.path); stamp = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* ignore */ }
  return `v${VERSION}|${media.source?.path}|${sub.type}|${sub.path || sub.trackNumber}|${stamp}`;
}

// Failures are only remembered for this session (a file may be readable later).
const failed = new Map();

// Where a subtitle stands: the result, null while it runs. Starts the analysis
// when nobody did yet; getVtt() supplies the subtitle text.
function status(media, sub, getVtt) {
  const key = keyFor(media, sub);
  const done = cache[key] || failed.get(key);
  if (done) return done;
  if (media.duration) sync(media, sub, getVtt); // else: not probed yet, ask again
  return null;
}

// Run (once) the analysis for a subtitle.
function sync(media, sub, getVtt) {
  const key = keyFor(media, sub);
  if (cache[key]) return Promise.resolve(cache[key]);
  if (failed.has(key)) return Promise.resolve(failed.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const t0 = Date.now();
  const job = (async () => {
    try {
      const vtt = await getVtt();
      const res = await analyse(media, vtt);
      console.log(`[subsync] ${path.basename(media.source.path)} #${sub.idx}: offset ${res.offset}s ×${res.scale.toFixed(4)} (confidence ${res.confidence}) in ${Date.now() - t0} ms`);
      cache[key] = res;
      persist();
      return res;
    } catch (e) {
      console.warn('[subsync] failed:', e.message);
      const res = { offset: 0, scale: 1, applied: false, error: e.message };
      failed.set(key, res);
      return res;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

module.exports = { setCachePath, sync, status, analyse };
