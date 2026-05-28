const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LANG_LABELS = {
  fr: 'Français', fre: 'Français', fra: 'Français',
  en: 'English', eng: 'English',
  es: 'Español', spa: 'Español',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  it: 'Italiano', ita: 'Italiano',
  pt: 'Português', por: 'Português',
  ja: '日本語', jpn: '日本語',
  zh: '中文', chi: '中文',
  ar: 'العربية', ara: 'العربية',
  ru: 'Русский', rus: 'Русский'
};

// Audio codecs that browsers (Chromium/Electron) can decode raw, without remux.
// AC-3, EAC-3, DTS, TrueHD, etc. are NOT in this list — they need transcoding.
const RAW_PLAYABLE_AUDIO = new Set([
  'aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le'
]);

// Video codecs requiring the hvc1 tag in MP4 to play in browsers
const HEVC_CODECS = new Set(['hevc', 'h265']);

let ffmpegPath = null;
let ffprobePath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
} catch { /* optional */ }
// Prefer @ffprobe-installer (ffprobe 2023+, handles modern HEVC 10-bit MKVs)
// over ffprobe-static which ships an outdated 4.0.2 build from 2018.
try {
  const fp = require('@ffprobe-installer/ffprobe');
  ffprobePath = fp.path.replace('app.asar', 'app.asar.unpacked');
} catch {
  try {
    const fp = require('ffprobe-static');
    ffprobePath = fp.path.replace('app.asar', 'app.asar.unpacked');
  } catch { /* none available */ }
}

function isAvailable() {
  return !!ffmpegPath && !!ffprobePath && fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath);
}

// One-shot detection of the fastest available H.264 encoder + matching HW
// decode path. NVENC on Nvidia is ~15-30x faster than libx264 for 1080p
// HEVC->H.264 transcoding; QSV on Intel and AMF on AMD are similar wins.
let cachedHwInfo = undefined;
async function detectHwInfo() {
  if (cachedHwInfo !== undefined) return cachedHwInfo;
  if (!ffmpegPath) return (cachedHwInfo = { encoder: 'libx264', hwaccel: null });
  const encoders = await new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('exit', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 5000);
  });
  const hwaccels = await new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-hwaccels'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('exit', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 5000);
  });
  // Preference: nvenc (Nvidia) → qsv (Intel) → amf (AMD) → software
  let encoder = 'libx264';
  let hwaccel = null;
  if (/\bh264_nvenc\b/.test(encoders)) {
    encoder = 'h264_nvenc';
    if (/\bcuda\b/.test(hwaccels)) hwaccel = 'cuda';
  } else if (/\bh264_qsv\b/.test(encoders)) {
    encoder = 'h264_qsv';
    if (/\bqsv\b/.test(hwaccels)) hwaccel = 'qsv';
    else if (/\bd3d11va\b/.test(hwaccels)) hwaccel = 'd3d11va';
  } else if (/\bh264_amf\b/.test(encoders)) {
    encoder = 'h264_amf';
    if (/\bd3d11va\b/.test(hwaccels)) hwaccel = 'd3d11va';
  }
  cachedHwInfo = { encoder, hwaccel };
  console.log('[ffmpeg] HW transcode pipeline:', JSON.stringify(cachedHwInfo));
  return cachedHwInfo;
}

function isAudioRawPlayable(codec) {
  return RAW_PLAYABLE_AUDIO.has(String(codec || '').toLowerCase());
}

function isHEVC(codec) {
  return HEVC_CODECS.has(String(codec || '').toLowerCase());
}

function formatAudioLabel(stream) {
  const lang = stream.tags?.language;
  const codec = (stream.codec_name || '').toUpperCase();
  const layout = stream.channel_layout || (stream.channels ? `${stream.channels}.0` : '');
  const langLabel = LANG_LABELS[lang] || (lang && lang !== 'und' ? lang.toUpperCase() : null);
  const parts = [];
  if (langLabel) parts.push(langLabel);
  if (codec) parts.push(codec);
  if (layout) parts.push(layout);
  return parts.join(' · ') || 'Audio';
}

function spawnProbe(args) {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ code: -2, stdout, stderr: 'timeout' }); }, 30000);
  });
}

async function probeFile(filePath) {
  if (!isAvailable()) return null;
  // -v error: print errors so we can diagnose failures (was -v quiet which
  // hid them). Dropped -fflags/-err_detect/-analyzeduration which were
  // probably making ffprobe reject some files; defaults are fine.
  const r = await spawnProbe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  if (r.code !== 0) {
    console.warn('[ffprobe] file probe exit', r.code, 'for', path.basename(filePath));
    if (r.stderr) console.warn('[ffprobe] stderr:', r.stderr.slice(-500));
    return null;
  }
  let data;
  try { data = JSON.parse(r.stdout); } catch { return null; }

  const streams = data.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  const audioTracks = audioStreams.map((s, idx) => ({
    idx,
    streamIndex: s.index,
    lang: (s.tags?.language || 'und').toLowerCase(),
    label: s.tags?.title || formatAudioLabel(s),
    codec: s.codec_name,
    channels: s.channels,
    channelLayout: s.channel_layout,
    isDefault: s.disposition?.default === 1,
    rawPlayable: isAudioRawPlayable(s.codec_name)
  }));

  return {
    duration: parseFloat(data.format?.duration) || 0,
    videoCodec: videoStream?.codec_name || null,
    videoProfile: videoStream?.profile || null,
    audioTracks
  };
}

function probeAudioTracks(filePath) {
  return probeFile(filePath).then((info) => info?.audioTracks || []);
}

function probeDuration(filePath) {
  return probeFile(filePath).then((info) => info?.duration || 0);
}

function buildRemuxArgs(inputPath, audioIdx, outputPath, options = {}) {
  // options.videoMode: 'copy' | 'transcode'
  // options.sourceAudioCodec: 'aac' lets us -c:a copy (10× faster, lossless)
  // options.hwEncoder + options.hwaccel: pick the best HW pipeline if any
  const videoMode = options.videoMode || 'copy';
  const sourceAudioCodec = (options.sourceAudioCodec || '').toLowerCase();
  const hwEncoder = options.hwEncoder || 'libx264';
  const hwaccel = options.hwaccel || null;

  const args = ['-y'];
  args.push('-fflags', '+genpts+discardcorrupt');
  args.push('-err_detect', 'ignore_err');
  args.push('-analyzeduration', '100M', '-probesize', '100M');

  // Hardware-accelerated decode (must come BEFORE -i). On Nvidia + NVENC, this
  // lets the GPU decode HEVC and feed frames straight into the H.264 encoder
  // without round-tripping through system RAM — biggest perf win available.
  if (videoMode === 'transcode' && hwaccel) {
    args.push('-hwaccel', hwaccel);
    if (hwEncoder === 'h264_nvenc' && hwaccel === 'cuda') {
      args.push('-hwaccel_output_format', 'cuda');
    } else if (hwEncoder === 'h264_qsv' && hwaccel === 'qsv') {
      args.push('-hwaccel_output_format', 'qsv');
    }
  }

  args.push('-i', inputPath);
  args.push('-map', '0:v:0', '-map', `0:a:${audioIdx}`);

  if (videoMode === 'transcode') {
    if (hwEncoder === 'h264_nvenc') {
      // p4 = "balanced" preset, CQ 23 ≈ visually transparent at 1080p
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0');
      if (!hwaccel) args.push('-pix_fmt', 'yuv420p');
    } else if (hwEncoder === 'h264_qsv') {
      args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23');
      if (!hwaccel) args.push('-pix_fmt', 'nv12');
    } else if (hwEncoder === 'h264_amf') {
      args.push('-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
      args.push('-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    }
  } else {
    args.push('-c:v', 'copy');
    if (options.videoTag) args.push('-tag:v', options.videoTag);
  }

  if (sourceAudioCodec === 'aac') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  args.push('-movflags', '+faststart');
  args.push('-avoid_negative_ts', 'make_zero');
  args.push('-max_muxing_queue_size', '9999');
  args.push('-progress', 'pipe:2', '-nostats');
  args.push(outputPath);
  return args;
}

function remuxWithAudio(inputPath, audioIdx, outputPath, options = {}, onProgress) {
  if (!isAvailable()) return Promise.reject(new Error('ffmpeg unavailable'));
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    // Write to a .tmp sibling and atomic-rename on clean exit. If ffmpeg gets
    // killed (Ctrl+C, parent process dies, crash…) we end up with a partial
    // .tmp file that fails the "rename" step, so no broken `.mp4` ever
    // appears in cache.
    const tmpPath = outputPath + '.tmp';
    try { fs.unlinkSync(tmpPath); } catch {}

    const args = buildRemuxArgs(inputPath, audioIdx, tmpPath, options);
    console.log('[ffmpeg] spawning:', ffmpegPath, args.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' '));
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderrTail = '';

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      const m = text.match(/out_time_ms=(\d+)/);
      if (m && onProgress) {
        try { onProgress(parseInt(m[1], 10) / 1_000_000); } catch {}
      }
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(new Error(`ffmpeg exit ${code}: ${stderrTail.slice(-400)}`));
      }
      let stat;
      try { stat = fs.statSync(tmpPath); } catch { stat = null; }
      if (!stat || stat.size < 50_000) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(new Error(`ffmpeg produced empty/tiny output (${stat ? stat.size : 0} bytes). Tail of stderr:\n${stderrTail.slice(-600)}`));
      }
      try { fs.renameSync(tmpPath, outputPath); } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(new Error(`Cache rename failed: ${e.message}`));
      }
      console.log('[ffmpeg] done:', path.basename(outputPath), '(' + Math.round(stat.size / 1024 / 1024) + ' MB)');
      resolve();
    });
    proc.on('error', (e) => {
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(e);
    });
  });
}

function getFfmpegPath() { return ffmpegPath; }
function getFfprobePath() { return ffprobePath; }

module.exports = {
  isAvailable,
  isAudioRawPlayable,
  isHEVC,
  detectHwInfo,
  probeFile,
  probeAudioTracks,
  probeDuration,
  remuxWithAudio,
  getFfmpegPath,
  getFfprobePath
};
