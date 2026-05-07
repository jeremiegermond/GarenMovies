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

let ffmpegPath = null;
let ffprobePath = null;
try {
  // Both paths need .replace for asar.unpacked when packaged
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

function probeAudioTracks(filePath) {
  if (!isAvailable()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn('[ffprobe] audio probe exit', code, stderr.slice(-200));
        return resolve([]);
      }
      try {
        const data = JSON.parse(stdout);
        const streams = (data.streams || []);
        const tracks = streams.map((s, idx) => ({
          idx,
          ffmpegMapIdx: idx,
          streamIndex: s.index,
          lang: (s.tags?.language || 'und').toLowerCase(),
          label: s.tags?.title || formatAudioLabel(s),
          codec: s.codec_name,
          channels: s.channels,
          channelLayout: s.channel_layout,
          isDefault: s.disposition?.default === 1
        }));
        resolve(tracks);
      } catch (e) {
        console.warn('[ffprobe] parse error', e.message);
        resolve([]);
      }
    });
    proc.on('error', (e) => {
      console.warn('[ffprobe] spawn error', e.message);
      resolve([]);
    });
    setTimeout(() => { try { proc.kill(); } catch {} resolve([]); }, 30000);
  });
}

function probeDuration(filePath) {
  if (!isAvailable()) return Promise.resolve(0);
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('exit', () => resolve(parseFloat(stdout.trim()) || 0));
    proc.on('error', () => resolve(0));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(0); }, 15000);
  });
}

function remuxWithAudio(inputPath, audioIdx, outputPath, onProgress) {
  if (!isAvailable()) return Promise.reject(new Error('ffmpeg unavailable'));
  return new Promise((resolve, reject) => {
    // Make sure output dir exists
    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    const args = [
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', `0:a:${audioIdx}`,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      outputPath
    ];

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
  probeAudioTracks,
  probeDuration,
  remuxWithAudio,
  getFfmpegPath,
  getFfprobePath
};
