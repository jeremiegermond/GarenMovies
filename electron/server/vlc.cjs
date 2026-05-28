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
 * Remux a video to MP4 using VLC as the demuxer. Used as a fallback when
 * ffmpeg's libavformat refuses the input (PSA HEVC releases with non-standard
 * EBML headers, etc.) — libVLC's demuxer is more permissive.
 *
 * options.videoMode: 'copy' | 'transcode'. Copy passes the video through
 * unchanged; transcode re-encodes to H.264 (slow but works for browsers
 * without HEVC hardware decoding).
 */
function remuxWithVLC(inputPath, audioIdx, outputPath, options = {}) {
  const vlcPath = findVLC();
  if (!vlcPath) return Promise.reject(new Error('VLC introuvable sur le système'));

  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    const videoMode = options.videoMode || 'copy';
    const transcodeChain = videoMode === 'transcode'
      ? '#transcode{vcodec=h264,vb=4000,acodec=mp4a,ab=192,channels=2,samplerate=48000}'
      : '#transcode{acodec=mp4a,ab=192,channels=2,samplerate=48000}';
    const sout = `${transcodeChain}:standard{access=file,mux=mp4,dst="${quoteForSout(outputPath)}"}`;

    const args = [
      '-I', 'dummy',
      '--no-video-title-show',
      '--no-osd',
      // VLC counts audio-track per ES (elementary stream). 0 = default.
      // For our purposes, audioIdx is 0-based among audio streams, which
      // generally maps to VLC's expectation.
      '--audio-track', String(audioIdx),
      inputPath,
      `--sout=${sout}`,
      'vlc://quit'
    ];

    console.log('[vlc] spawning:', vlcPath, args.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' '));
    const proc = spawn(vlcPath, args, { windowsHide: true });
    let stderrTail = '';
    let stdoutTail = '';

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      // VLC mirrors most useful messages on stderr; surface them live so the
      // user can see progress (and our "[vlc]" prefix makes them easy to grep)
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/^\[\w+\b/.test(line)) console.log('[vlc]', line);
      }
    });
    proc.stdout.on('data', (d) => { stdoutTail = (stdoutTail + d.toString()).slice(-1000); });

    proc.on('exit', (code) => {
      let stat = null;
      try { stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null; } catch {}
      const ok = code === 0 && stat && stat.size > 50_000;
      console.log('[vlc] exited code=' + code, 'output=' + (stat ? stat.size : 0) + 'B', ok ? '— OK' : '— FAILED');
      if (ok) {
        resolve();
      } else {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        const tail = (stderrTail || stdoutTail).slice(-600);
        reject(new Error(`vlc exit ${code}, output ${stat ? stat.size : 0} bytes: ${tail}`));
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
