const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Standard VLC install paths on the major platforms.
const WIN_PATHS = [
  'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
  'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
];
const MAC_PATH = '/Applications/VLC.app/Contents/MacOS/VLC';
const LINUX_PATHS = ['/usr/bin/vlc', '/usr/local/bin/vlc'];

let cached = undefined;

function findVLC() {
  if (cached !== undefined) return cached;
  if (process.platform === 'win32') {
    for (const p of WIN_PATHS) if (fs.existsSync(p)) return (cached = p);
  } else if (process.platform === 'darwin') {
    if (fs.existsSync(MAC_PATH)) return (cached = MAC_PATH);
  } else {
    for (const p of LINUX_PATHS) if (fs.existsSync(p)) return (cached = p);
  }
  // Fall back to PATH lookup
  try {
    const r = spawnSync('vlc', ['--version'], { windowsHide: true, encoding: 'utf-8' });
    if (r.status === 0) return (cached = 'vlc');
  } catch {}
  return (cached = null);
}

function isAvailable() {
  return !!findVLC();
}

function quoteForSout(p) {
  // VLC's stream-output URLs want forward slashes and don't tolerate
  // backslashes well even on Windows.
  return p.replace(/\\/g, '/').replace(/"/g, '\\"');
}

/**
 * Remux a video to MP4 (H.264-or-copied video + AAC audio) using VLC as the
 * demuxer. We use this as a fallback when ffmpeg's libavformat refuses the
 * input (PSA HEVC releases with non-standard EBML headers, etc.) — VLC's
 * libVLC demuxer is more permissive than ffmpeg's.
 *
 * Audio is always re-encoded to AAC stereo so the result plays in browsers.
 * Video is passed through unchanged.
 */
function remuxWithVLC(inputPath, audioIdx, outputPath) {
  const vlcPath = findVLC();
  if (!vlcPath) return Promise.reject(new Error('VLC introuvable sur le système'));

  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    const sout = `#transcode{acodec=mp4a,ab=192,channels=2,samplerate=48000}:standard{access=file,mux=mp4,dst="${quoteForSout(outputPath)}"}`;

    const args = [
      '-I', 'dummy',
      '--no-video-title-show',
      '--no-osd',
      '--quiet',
      // VLC counts audio-track per ES (elementary stream). 0 = default.
      // For our purposes, audioIdx is 0-based among audio streams, which
      // generally maps to VLC's expectation.
      '--audio-track', String(audioIdx),
      inputPath,
      `--sout=${sout}`,
      'vlc://quit'
    ];

    const proc = spawn(vlcPath, args, { windowsHide: true });
    let stderrTail = '';

    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    proc.on('exit', (code) => {
      const ok = code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
      if (ok) {
        resolve();
      } else {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        reject(new Error(`vlc exit ${code}: ${stderrTail.slice(-400)}`));
      }
    });

    proc.on('error', (e) => {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      reject(e);
    });
  });
}

function getVLCVersion() {
  const vlcPath = findVLC();
  if (!vlcPath) return null;
  try {
    const r = spawnSync(vlcPath, ['--version'], { windowsHide: true, encoding: 'utf-8' });
    const m = r.stdout?.match(/VLC version ([0-9.]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

module.exports = { isAvailable, findVLC, remuxWithVLC, getVLCVersion };
