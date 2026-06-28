const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg.cjs');

// Progressive HLS transcoding. Instead of transcoding a whole film to one MP4
// (and making the user wait ~the full duration before a single frame plays),
// we transcode to HLS segments and let the browser (via hls.js) start playing
// as soon as the first ~4s segment lands — typically <1s. ffmpeg stays well
// ahead of playback (≈9× realtime with NVENC), so it never stalls.
//
// This is an ADDITIVE fast path: the existing raw / remux / transcode-to-MP4
// modes remain untouched as fallbacks.

let cacheDir = null;
function setCacheDir(dir) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function hlsDir(mediaId, audioIdx) {
  if (!cacheDir) return null;
  return path.join(cacheDir, `${mediaId}-a${audioIdx}-hls`);
}

function playlistPath(mediaId, audioIdx) {
  const d = hlsDir(mediaId, audioIdx);
  return d ? path.join(d, 'index.m3u8') : null;
}

// A finished VOD playlist ends with #EXT-X-ENDLIST. We only treat a cached dir
// as reusable when it's complete; a partial dir (from a killed run) is rebuilt.
function isComplete(mediaId, audioIdx) {
  const pl = playlistPath(mediaId, audioIdx);
  if (!pl || !fs.existsSync(pl)) return false;
  try { return fs.readFileSync(pl, 'utf-8').includes('#EXT-X-ENDLIST'); }
  catch { return false; }
}

function segmentCount(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).length; }
  catch { return 0; }
}

// key = `${mediaId}:${audioIdx}`
const jobs = new Map();
function jobKey(mediaId, audioIdx) { return `${mediaId}:${audioIdx}`; }

function buildArgs(inputPath, audioIdx, dir, hwInfo) {
  const encoder = hwInfo?.encoder || 'libx264';
  const hwaccel = hwInfo?.hwaccel || null;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  // HW-accelerated decode (must precede -i).
  if (encoder === 'h264_nvenc' && hwaccel === 'cuda') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  }

  args.push('-i', inputPath);
  args.push('-map', '0:v:0', '-map', `0:a:${audioIdx}`, '-sn');

  if (encoder === 'h264_nvenc') {
    // scale_cuda downconverts 10-bit → 8-bit on the GPU; NVENC H.264 rejects
    // 10-bit input otherwise. No-op for already-8-bit sources.
    if (hwaccel === 'cuda') args.push('-vf', 'scale_cuda=format=yuv420p');
    // -forced-idr makes NVENC honour -force_key_frames (otherwise it ignores
    // on-demand keyframe requests and keeps the source's ~10s GOP).
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-forced-idr', '1');
    if (hwaccel !== 'cuda') args.push('-pix_fmt', 'yuv420p');
  } else {
    // Software fallback (also used for QSV/AMF, whose on-GPU format-conversion
    // chains we don't special-case here — correctness over peak speed).
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  }

  // Force a keyframe every 4s so HLS can cut clean ~4s segments regardless of
  // the source GOP (x265 releases often use 10s GOPs). Smaller segments → the
  // first one lands faster (quicker start) and seeking is finer-grained.
  args.push('-force_key_frames', 'expr:gte(t,n_forced*4)');

  // Always normalise audio to stereo AAC — guaranteed to play in every browser,
  // and cheap. (5.1 AAC sometimes won't decode in Chromium.)
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    // EVENT playlist: append-only, grows as we transcode, and gets an
    // #EXT-X-ENDLIST when ffmpeg finishes. hls.js treats EVENT streams as
    // starting at position 0 (not at the live edge), which is what we want.
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-start_number', '0',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, 'index.m3u8')
  );
  return args;
}

// Stop any other running HLS job to free the GPU/CPU — the single host only
// watches one thing at a time, and a 2½h transcode left running in the
// background after the user navigates away is pure waste.
function stopOthers(exceptKey) {
  for (const [k, job] of jobs) {
    if (k === exceptKey) continue;
    if (job.status === 'running' && job.proc) {
      console.log('[hls] stopping background job', k);
      try { job.proc.kill(); } catch {}
      job.status = 'stopped';
    }
  }
}

async function startJob(media, audioIdx) {
  const key = jobKey(media.id, audioIdx);
  const dir = hlsDir(media.id, audioIdx);
  if (!dir) throw new Error('HLS cache directory not configured');

  if (ffmpeg.isLikelyCorrupt(media.source.path)) {
    const job = { status: 'error', dir, complete: false,
      error: 'Fichier vide ou corrompu — téléchargement probablement incomplet. Re-télécharge ce fichier.' };
    jobs.set(key, job);
    return job;
  }

  // Complete cache → reuse as-is.
  if (isComplete(media.id, audioIdx)) {
    const job = { status: 'done', dir, complete: true, duration: media.duration || 0 };
    jobs.set(key, job);
    return job;
  }

  const existing = jobs.get(key);
  if (existing && existing.status === 'running') return existing;

  stopOthers(key);

  // Rebuild from scratch — wipe any partial dir from a previous killed run.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });

  let hwInfo = { encoder: 'libx264', hwaccel: null };
  try { hwInfo = await ffmpeg.detectHwInfo(); } catch {}

  const ffmpegPath = ffmpeg.getFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const args = buildArgs(media.source.path, audioIdx, dir, hwInfo);
  console.log('[hls] spawning:', path.basename(media.source.path), 'audio', audioIdx, 'enc', hwInfo.encoder);

  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  const job = {
    status: 'running',
    dir,
    complete: false,
    duration: media.duration || 0,
    startedAt: Date.now(),
    proc,
    stderrTail: ''
  };
  jobs.set(key, job);

  if (!job.duration) {
    ffmpeg.probeDuration(media.source.path).then((d) => { job.duration = d || 0; }).catch(() => {});
  }

  proc.stderr.on('data', (d) => { job.stderrTail = (job.stderrTail + d.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    if (code === 0) {
      job.status = 'done';
      job.complete = true;
      console.log('[hls] done', key, `(${segmentCount(dir)} segments)`);
    } else if (job.status !== 'stopped') {
      job.status = 'error';
      job.error = job.stderrTail.slice(-400) || `ffmpeg exit ${code}`;
      console.warn('[hls] failed', key, '—', job.error);
    }
    job.proc = null;
  });
  proc.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.proc = null;
  });

  return job;
}

// Snapshot for the status endpoint. Readiness is derived from the filesystem
// (≥1 segment written) so the client can start playback the moment it's safe.
function getStatus(mediaId, audioIdx) {
  const dir = hlsDir(mediaId, audioIdx);
  if (!dir) return { status: 'error', error: 'cache not configured' };
  const complete = isComplete(mediaId, audioIdx);
  const job = jobs.get(jobKey(mediaId, audioIdx));
  const segs = segmentCount(dir);

  if (job && job.status === 'error') return { status: 'error', error: job.error, ready: false };
  if (complete) {
    return { status: 'ready', ready: true, done: true, segments: segs, duration: job?.duration || 0 };
  }
  if (segs >= 1) {
    // Estimate progress from segments produced (4s each) vs. total duration.
    const producedSec = segs * 4;
    return {
      status: 'ready', ready: true, done: false, segments: segs,
      duration: job?.duration || 0, produced: producedSec
    };
  }
  if (job && job.status === 'running') return { status: 'running', ready: false, duration: job.duration || 0 };
  return { status: 'idle', ready: false };
}

function stopAll() {
  for (const [, job] of jobs) {
    if (job.proc) { try { job.proc.kill(); } catch {} }
  }
}

// Remove partial (incomplete) HLS dirs left by a previous run; keep complete
// ones as warm cache. Called on startup.
function sweepPartials() {
  if (!cacheDir) return;
  let entries = [];
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('-hls')) continue;
    const pl = path.join(cacheDir, e.name, 'index.m3u8');
    let complete = false;
    try { complete = fs.existsSync(pl) && fs.readFileSync(pl, 'utf-8').includes('#EXT-X-ENDLIST'); } catch {}
    if (!complete) {
      try { fs.rmSync(path.join(cacheDir, e.name), { recursive: true, force: true }); console.log('[hls] swept partial', e.name); } catch {}
    }
  }
}

module.exports = {
  setCacheDir, hlsDir, playlistPath, isComplete,
  startJob, getStatus, stopAll, stopOthers, sweepPartials
};
