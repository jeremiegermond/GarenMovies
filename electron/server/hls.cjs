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
// Full-length playlist, segments on demand (same idea as Jellyfin/Plex): the
// playlist served to the player is built up front from the film's duration —
// one SEG-second segment after another — so the player shows the real length
// from the first second and can seek anywhere. Segments are produced on
// demand: a request for one the encoder is about to reach waits for it; a
// request further away (a seek, a guest joining mid-film) restarts ffmpeg right
// there (-ss + -output_ts_offset keep its timestamps on the film's timeline).
// Already-produced segments are never re-encoded: a run that starts before an
// existing segment stops just before it (-t).
//
// When the duration is unknown we fall back to the original single run and
// ffmpeg's own growing (EVENT) playlist.
//
// This is an ADDITIVE fast path: the existing raw / remux / transcode-to-MP4
// modes remain untouched as fallbacks.

const SEG = 4;          // seconds per segment — matches -hls_time and the forced keyframe cadence
const AHEAD = 8;        // a missing segment at most this far past the encoder is waited for; further → restart there
const END_SLACK = 1.5;  // drop a trailing remainder this short (container duration often runs a bit past the video)
const WAIT_MS = 30000;  // give up on a segment request after this long
const POLL_MS = 150;
const RESTART_GRACE_MS = 3000; // a run this fresh isn't superseded right away (see ensureSegment)
const TS_OFFSET = 1;     // every run's timestamps = film time + this (see buildArgs)

let cacheDir = null;
function setCacheDir(dir) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function hlsDir(mediaId, audioIdx) {
  if (!cacheDir) return null;
  return path.join(cacheDir, `${mediaId}-a${audioIdx}-hls`);
}

// ffmpeg's own playlist — only served in the fallback (unknown duration) mode.
function playlistPath(mediaId, audioIdx) {
  const d = hlsDir(mediaId, audioIdx);
  return d ? path.join(d, 'index.m3u8') : null;
}

function segName(i) { return `seg_${String(i).padStart(5, '0')}.ts`; }
function segFile(dir, i) { return path.join(dir, segName(i)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Segment layout of a film: `count` segments of SEG seconds, the last one `last` long.
function layoutFor(duration) {
  if (!(duration > 0)) return null;
  const count = Math.max(1, Math.ceil((duration - END_SLACK) / SEG));
  const last = Math.max(0.1, Math.min(SEG, duration - SEG * (count - 1)));
  return { count, last, duration };
}
function readLayout(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf-8')); } catch { return null; }
}

// The playlist is built from the VIDEO track's length when known: the container
// duration can run past it (a longer audio or subtitle track), and a playlist
// announcing segments that never get produced would stall right before the end
// (so no 'ended' event, and no next-episode countdown).
const durations = new Map(); // mediaId → probed seconds (when the catalog hasn't got it yet)
async function mediaDuration(media) {
  if (media.videoDuration > 0) return media.videoDuration;
  if (durations.has(media.id)) return durations.get(media.id);
  let d = 0;
  try {
    const info = await ffmpeg.probeFile(media.source.path);
    d = info?.videoDuration || info?.duration || 0;
  } catch {}
  if (!(d > 0)) d = media.duration || 0;
  if (d > 0) durations.set(media.id, d);
  return d;
}

// A cache dir is complete when every segment of its layout exists ('complete'
// marker). Legacy dirs (single run, before on-demand segments) have no layout
// file: they're complete when ffmpeg's playlist got #EXT-X-ENDLIST.
function dirIsComplete(dir) {
  if (fs.existsSync(path.join(dir, 'complete'))) return true;
  if (fs.existsSync(path.join(dir, 'layout.json'))) return false;
  try { return fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf-8').includes('#EXT-X-ENDLIST'); }
  catch { return false; }
}
function isComplete(mediaId, audioIdx) {
  const dir = hlsDir(mediaId, audioIdx);
  return !!dir && dirIsComplete(dir);
}

function segmentCount(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).length; }
  catch { return 0; }
}
// First missing segment at or after `from`.
function frontier(dir, from, count) {
  let i = from;
  while (i < count && fs.existsSync(segFile(dir, i))) i++;
  return i;
}
function markCompleteIfFull(dir, layout) {
  if (!layout || frontier(dir, 0, layout.count) < layout.count) return;
  try { fs.writeFileSync(path.join(dir, 'complete'), ''); } catch {}
}

// key = `${mediaId}:${audioIdx}` → the current ffmpeg run for that film/track
const jobs = new Map();
const endIndex = new Map(); // key → first segment index past the real end of the video
function jobKey(mediaId, audioIdx) { return `${mediaId}:${audioIdx}`; }

function buildArgs(inputPath, audioIdx, dir, hwInfo, startSeg = 0, endSeg = Infinity) {
  const encoder = hwInfo?.encoder || 'libx264';
  const hwaccel = hwInfo?.hwaccel || null;
  const startSec = startSeg * SEG;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  // HW-accelerated decode (must precede -i).
  if (encoder === 'h264_nvenc' && hwaccel === 'cuda') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  }

  // Start mid-film (seek / guest joining late): input-seek to the segment's
  // start. Timestamps restart at 0 there, so the keyframe/segment grid below
  // stays aligned with the film's, and -output_ts_offset puts them back on the
  // film's timeline (see below).
  if (startSec > 0) args.push('-ss', String(startSec));

  args.push('-i', inputPath);
  args.push('-map', '0:v:0', '-map', `0:a:${audioIdx}`, '-sn');

  if (encoder === 'h264_nvenc') {
    // scale_cuda downconverts 10-bit → 8-bit on the GPU; NVENC H.264 rejects
    // 10-bit input otherwise. No-op for already-8-bit sources.
    if (hwaccel === 'cuda') args.push('-vf', 'scale_cuda=format=yuv420p');
    // -forced-idr makes NVENC honour -force_key_frames (otherwise it ignores
    // on-demand keyframe requests and keeps the source's ~10s GOP).
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-forced-idr', '1', '-bf', '0');
    if (hwaccel !== 'cuda') args.push('-pix_fmt', 'yuv420p');
  } else {
    // Software fallback (also used for QSV/AMF, whose on-GPU format-conversion
    // chains we don't special-case here — correctness over peak speed).
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-bf', '0');
  }
  // No B-frames (-bf 0 above): with them, decode order runs ~0.12s ahead of
  // display, so the HLS muxer cuts each segment's audio that much before the
  // video keyframe. A run started with -ss has no audio before its start, which
  // left a ~0.1s hole in the sound wherever two runs meet. Costs a little
  // bitrate, nothing visible.

  // Force a keyframe every SEG seconds so HLS can cut clean segments regardless
  // of the source GOP (x265 releases often use 10s GOPs). Smaller segments →
  // the first one lands faster (quicker start) and seeking is finer-grained.
  args.push('-force_key_frames', `expr:gte(t,n_forced*${SEG})`);

  // Always normalise audio to stereo AAC — guaranteed to play in every browser,
  // and cheap. (5.1 AAC sometimes won't decode in Chromium.)
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  // Start the MPEG-TS at PTS ~0 instead of ffmpeg's default ~1.4s mux delay.
  // Otherwise the transcoded timeline is shifted vs the source, so sidecar
  // subtitles (timed from 0, like VLC plays them) end up ~1.4s out of sync.
  args.push('-muxdelay', '0', '-muxpreload', '0');
  // Put every run on one timeline: film time + TS_OFFSET. The extra second
  // keeps each run's first timestamps positive (AAC priming starts the audio
  // ~21ms before 0; an encoder with a reorder delay does the same to video) —
  // otherwise the MPEG-TS muxer shifts a run that starts at 0 but not a run
  // started with -ss, and segments from different runs wouldn't line up.
  // hls.js removes a constant offset, so playback time (and subtitle sync) is
  // unchanged.
  args.push('-output_ts_offset', String(startSec + TS_OFFSET));

  // Stop right before segments that already exist (never re-encode them).
  if (Number.isFinite(endSeg)) args.push('-t', String((endSeg - startSeg) * SEG));

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEG),
    '-hls_list_size', '0',
    // EVENT playlist: append-only, grows as we transcode, and gets an
    // #EXT-X-ENDLIST when ffmpeg finishes. Only served in the fallback mode
    // (unknown duration); otherwise the full playlist comes from buildPlaylist.
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-start_number', String(startSeg),
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
      job.status = 'stopped';
      try { job.proc.kill(); } catch {}
    }
  }
}

// Spawn an ffmpeg run for `media` starting at segment `startSeg`, replacing the
// film's current run. `layout` null = fallback single run (whole film, from 0).
async function spawnRun(media, audioIdx, startSeg, layout) {
  const key = jobKey(media.id, audioIdx);
  const dir = hlsDir(media.id, audioIdx);
  stopOthers(key);
  const prev = jobs.get(key);
  if (prev?.proc) { prev.status = 'superseded'; try { prev.proc.kill(); } catch {} }

  // Run until the next segment that already exists, or to the end.
  let endSeg = Infinity;
  if (layout) {
    for (let i = startSeg + 1; i < layout.count; i++) {
      if (fs.existsSync(segFile(dir, i))) { endSeg = i; break; }
    }
  }

  let hwInfo = { encoder: 'libx264', hwaccel: null };
  try { hwInfo = await ffmpeg.detectHwInfo(); } catch {}
  const ffmpegPath = ffmpeg.getFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg unavailable');
  const args = buildArgs(media.source.path, audioIdx, dir, hwInfo, startSeg, endSeg);
  console.log('[hls] spawning:', path.basename(media.source.path), 'audio', audioIdx, 'enc', hwInfo.encoder,
    'from seg', startSeg, Number.isFinite(endSeg) ? `to ${endSeg}` : 'to end');

  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  const job = {
    status: 'running',
    dir,
    complete: false,
    duration: layout?.duration || media.duration || 0,
    startSeg,
    endSeg,
    frontier: startSeg,
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
    job.proc = null;
    if (job.status === 'superseded' || job.status === 'stopped') return; // killed on purpose
    if (code === 0) {
      job.status = 'done';
      if (layout) {
        // An open-ended run reached the real end of the video.
        if (!Number.isFinite(endSeg)) endIndex.set(key, frontier(dir, startSeg, layout.count));
        markCompleteIfFull(dir, layout);
        job.complete = dirIsComplete(dir);
      } else {
        job.complete = true;
      }
      console.log('[hls] done', key, `(from seg ${startSeg}, ${segmentCount(dir)} segments in cache)`);
    } else {
      job.status = 'error';
      job.error = job.stderrTail.slice(-400) || `ffmpeg exit ${code}`;
      console.warn('[hls] failed', key, '—', job.error);
    }
  });
  proc.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.proc = null;
  });
  return job;
}

// Get a film ready to play (POST /api/hls/prepare): reuse a complete cache or a
// run already going, else make sure the first segment gets produced.
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

  const layout = layoutFor(await mediaDuration(media));
  if (!layout) {
    // Fallback: one run over the whole film from a clean dir (original behaviour).
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
    endIndex.delete(key);
    return spawnRun(media, audioIdx, 0, null);
  }

  // Keep segments from an earlier session when the layout matches; anything
  // else (legacy partial dir, different layout) is rebuilt from scratch.
  const prevLayout = readLayout(dir);
  if (!prevLayout || prevLayout.count !== layout.count || prevLayout.seg !== SEG) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ seg: SEG, count: layout.count, duration: layout.duration }));
    endIndex.delete(key);
  }

  // First segment already there → nothing to start; the rest comes on demand.
  if (fs.existsSync(segFile(dir, 0))) {
    return existing || { status: 'idle', dir, complete: false, duration: layout.duration };
  }
  return spawnRun(media, audioIdx, 0, layout);
}

// Full-length VOD playlist built from the duration (null → caller falls back to
// ffmpeg's own growing playlist).
async function buildPlaylist(media, audioIdx) {
  const dir = hlsDir(media.id, audioIdx);
  if (!dir) return null;
  let layout = null;
  const saved = readLayout(dir);
  if (saved?.count && saved.seg === SEG) {
    layout = { count: saved.count, last: Math.max(0.1, Math.min(SEG, saved.duration - SEG * (saved.count - 1))) };
  } else if (!saved && dirIsComplete(dir)) {
    // Legacy complete cache (one run, every segment present) — same SEG grid.
    layout = layoutFor(await mediaDuration(media));
  }
  if (!layout) return null;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${SEG + 1}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ];
  for (let i = 0; i < layout.count; i++) {
    lines.push(`#EXTINF:${(i === layout.count - 1 ? layout.last : SEG).toFixed(3)},`, segName(i));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

// Path of segment `index`, producing it first if needed (see header). Resolves
// null when it can't be had (past the end, encoder error, timeout, client gone).
async function ensureSegment(media, audioIdx, index, isAborted = () => false) {
  const key = jobKey(media.id, audioIdx);
  const dir = hlsDir(media.id, audioIdx);
  if (!dir || !(index >= 0)) return null;
  const file = segFile(dir, index);
  if (fs.existsSync(file)) return file;

  const layout = readLayout(dir);
  if (!layout?.count || layout.seg !== SEG) return null; // fallback mode / legacy cache: serve what exists only
  if (index >= layout.count) return null;

  const deadline = Date.now() + WAIT_MS;
  let restarts = 0;
  while (Date.now() < deadline && !isAborted()) {
    if (fs.existsSync(file)) return file;
    const end = endIndex.get(key);
    if (end != null && index >= end) return null; // past the real end of the video

    const job = jobs.get(key);
    const inRange = job && index >= job.startSeg && index < job.endSeg;
    if (job?.status === 'error' && inRange) return null; // don't respawn a failing run in a loop
    let covered = false;
    if (job?.status === 'running' && inRange) {
      job.frontier = frontier(dir, job.frontier ?? job.startSeg, layout.count);
      covered = index <= job.frontier + AHEAD;
    }
    // Several viewers share one encoder. Right after a seek restarted it, the
    // others still ask for segments near their old position for a moment (until
    // their player follows and drops those requests) — don't let them yank the
    // encoder back: wait instead, and only restart once the run isn't fresh.
    if (!covered && job?.status === 'running' && job.startSeg > 0 && Date.now() - job.startedAt < RESTART_GRACE_MS) {
      await sleep(POLL_MS);
      continue;
    }
    if (!covered) {
      if (restarts++ >= 2) return null;
      try { await spawnRun(media, audioIdx, index, layout); } catch { return null; }
    }
    await sleep(POLL_MS);
  }
  return fs.existsSync(file) ? file : null;
}

// Snapshot for the status endpoint. Readiness is derived from the filesystem
// (≥1 segment written) so the client can start playback the moment it's safe.
function getStatus(mediaId, audioIdx) {
  const dir = hlsDir(mediaId, audioIdx);
  if (!dir) return { status: 'error', error: 'cache not configured' };
  const complete = isComplete(mediaId, audioIdx);
  const job = jobs.get(jobKey(mediaId, audioIdx));
  const segs = segmentCount(dir);

  if (job && job.status === 'error' && segs === 0) return { status: 'error', error: job.error, ready: false };
  if (complete) {
    return { status: 'ready', ready: true, done: true, segments: segs, duration: job?.duration || 0 };
  }
  if (segs >= 1) {
    // Estimate progress from segments produced vs. total duration.
    const producedSec = segs * SEG;
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
    if (job.proc) { job.status = 'stopped'; try { job.proc.kill(); } catch {} }
  }
}

// Remove incomplete HLS dirs left by a previous run; keep complete ones as warm
// cache. Called on startup.
function sweepPartials() {
  if (!cacheDir) return;
  let entries = [];
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('-hls')) continue;
    const dir = path.join(cacheDir, e.name);
    if (!dirIsComplete(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); console.log('[hls] swept partial', e.name); } catch {}
    }
  }
}

module.exports = {
  setCacheDir, hlsDir, playlistPath, isComplete,
  startJob, buildPlaylist, ensureSegment, getStatus, stopAll, stopOthers, sweepPartials
};
