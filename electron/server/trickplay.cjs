const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg.cjs');

// Seek-bar preview thumbnails ("trickplay", as Jellyfin calls it): one small
// picture every INTERVAL seconds, packed COLS×ROWS per JPEG sheet so the player
// loads a handful of images instead of hundreds. One ffmpeg pass decoding only
// keyframes (≈25s for a 1h HEVC episode, ~2-3 MB on disk), in the background;
// sheets land in order, so previews near the start are ready almost at once.

const INTERVAL = 10;
const COLS = 10;
const ROWS = 10;
const THUMB_W = 320;

let baseDir = null;
function setCacheDir(dir) {
  baseDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

const sig = (m) => `${m.source?.size || 0}-${Math.round(m.source?.mtime || 0)}`;
const dirFor = (m) => (baseDir ? path.join(baseDir, `${m.id}-${sig(m)}`) : null);
const sheetName = (n) => `sheet_${String(n).padStart(3, '0')}.jpg`; // 1-based, ffmpeg's %03d

function readIndex(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8')); } catch { return null; }
}
function writeIndex(dir, index) {
  try { fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index)); } catch {}
}
function sheetCount(dir) {
  try { return fs.readdirSync(dir).filter((n) => /^sheet_\d{3}\.jpg$/.test(n)).length; } catch { return 0; }
}

const jobs = new Map(); // mediaId → { proc, dir }

function stopOthers(exceptId) {
  for (const [id, job] of jobs) {
    if (id !== exceptId && job.proc) { try { job.proc.kill(); } catch {} jobs.delete(id); }
  }
}

// What the player needs to place a thumbnail; `sheets` = how many are ready.
function view(index, dir, running) {
  const files = sheetCount(dir);
  // While ffmpeg runs, the newest sheet may still be being written.
  const sheets = index.done ? files : Math.max(0, files - (running ? 1 : 0));
  return { interval: index.interval, cols: index.cols, rows: index.rows, thumbW: index.thumbW, thumbH: index.thumbH, sheets, done: !!index.done };
}

// Start (or report on) the thumbnails of a film. Never waits for them.
async function ensure(m) {
  const dir = dirFor(m);
  if (!dir) return null;
  const index = readIndex(dir);
  if (index?.done) return view(index, dir, false);
  const job = jobs.get(m.id);
  if (job?.proc && index) return view(index, dir, true);

  stopOthers(m.id); // one viewer, one film at a time
  const info = await ffmpeg.probeFile(m.source.path).catch(() => null);
  const w = info?.videoWidth || 16, h = info?.videoHeight || 9;
  const thumbH = Math.max(2, Math.round((THUMB_W * h) / w / 2) * 2);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const fresh = { interval: INTERVAL, cols: COLS, rows: ROWS, thumbW: THUMB_W, thumbH, done: false };
  writeIndex(dir, fresh);

  const bin = ffmpeg.getFfmpegPath();
  if (!bin) return view(fresh, dir, false);
  const args = ['-hide_banner', '-loglevel', 'error',
    '-threads', '2',               // background job: leave the CPU to playback
    '-skip_frame', 'nokey',        // keyframes only — a few hundred pictures per film
    '-i', m.source.path, '-an', '-sn', '-dn',
    '-vf', `fps=1/${INTERVAL},scale=${THUMB_W}:${thumbH},tile=${COLS}x${ROWS}`,
    '-q:v', '5', path.join(dir, 'sheet_%03d.jpg')];
  const proc = spawn(bin, args, { windowsHide: true });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-600); });
  jobs.set(m.id, { proc, dir });
  proc.on('close', (code) => {
    if (jobs.get(m.id)?.proc === proc) jobs.delete(m.id);
    if (code === 0) {
      writeIndex(dir, { ...fresh, done: true });
      console.log('[trickplay]', path.basename(m.source.path), '→', sheetCount(dir), 'sheets');
    } else if (code !== null) {
      console.warn('[trickplay] failed for', path.basename(m.source.path), '—', err.trim().slice(-200));
    }
  });
  return view(fresh, dir, true);
}

function sheetPath(m, n) {
  const dir = dirFor(m);
  if (!dir || !(n >= 1)) return null;
  const file = path.join(dir, sheetName(n));
  return fs.existsSync(file) ? file : null;
}

function stopAll() {
  for (const [, job] of jobs) { try { job.proc?.kill(); } catch {} }
  jobs.clear();
}

module.exports = { setCacheDir, ensure, sheetPath, stopAll };
