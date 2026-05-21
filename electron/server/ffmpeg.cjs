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
try {
  const fp = require('ffprobe-static');
  ffprobePath = fp.path.replace('app.asar', 'app.asar.unpacked');
} catch { /* optional */ }

function isAvailable() {
  return !!ffmpegPath && !!ffprobePath && fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath);
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
  const r = await spawnProbe([
    '-v', 'quiet',
    '-fflags', '+ignidx+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-analyzeduration', '100M',
    '-probesize', '100M',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  if (r.code !== 0) {
    console.warn('[ffprobe] file probe exit', r.code, r.stderr.slice(-200));
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
  // Input flags — must come BEFORE -i:
  //   +genpts: regenerate presentation timestamps when source has gaps
  //   +discardcorrupt: drop corrupted frames instead of bailing
  //   +nofillin: don't try to fill in missing timestamps with guesses
  //   +ignidx: regenerate the index instead of trusting an incorrect one
  // -err_detect ignore_err: keep going on minor demuxer errors (PSA HEVC,
  //   weird BDRip mkvs with non-standard EBML extensions, etc.)
  // -analyzeduration / -probesize 200M: read enough of the file upfront so
  //   ffmpeg correctly identifies stream parameters on files with sparse
  //   keyframes
  const inputExt = (path.extname(inputPath).slice(1) || '').toLowerCase();
  const args = ['-y'];
  args.push('-fflags', '+genpts+discardcorrupt+nofillin+ignidx');
  args.push('-err_detect', 'ignore_err');
  args.push('-analyzeduration', '200M', '-probesize', '200M');
  if (inputExt === 'mkv') args.push('-f', 'matroska');
  args.push('-i', inputPath);
  args.push('-map', '0:v:0', '-map', `0:a:${audioIdx}`);
  args.push('-c:v', 'copy');
  if (options.videoTag) args.push('-tag:v', options.videoTag);
  args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-af', 'aresample=async=1000:first_pts=0');
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

    const args = buildRemuxArgs(inputPath, audioIdx, outputPath, options);
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
      if (code === 0) {
        resolve();
      } else {
        try { fs.unlinkSync(outputPath); } catch {}
        reject(new Error(`ffmpeg exit ${code}: ${stderrTail.slice(-400)}`));
      }
    });
    proc.on('error', (e) => {
      try { fs.unlinkSync(outputPath); } catch {}
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
  probeFile,
  probeAudioTracks,
  probeDuration,
  remuxWithAudio,
  getFfmpegPath,
  getFfprobePath
};
