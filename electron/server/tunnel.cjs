const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');

function getAssetName() {
  if (process.platform !== 'win32') return null; // v0: Windows only
  return process.arch === 'arm64'
    ? 'cloudflared-windows-arm64.exe'
    : 'cloudflared-windows-amd64.exe';
}

function detectInstalled() {
  try {
    const r = spawnSync('cloudflared', ['--version'], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0) return 'cloudflared';
  } catch {}
  return null;
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Trop de redirections'));
    https.get(url, { headers: { 'User-Agent': 'GarenMovies' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary() {
  const installed = detectInstalled();
  if (installed) return installed;

  const asset = getAssetName();
  if (!asset) throw new Error(`Plateforme non supportée: ${process.platform}`);

  const dir = path.join(app.getPath('userData'), 'bin');
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, asset);

  if (fs.existsSync(dest)) return dest;

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  await downloadFile(url, dest);
  return dest;
}

let proc = null;
let currentURL = null;

async function start(localPort, onURL, onLog) {
  await stop();
  const bin = await ensureBinary();

  proc = spawn(bin, [
    'tunnel',
    '--url', `http://localhost:${localPort}`,
    '--no-autoupdate'
  ], { windowsHide: true });

  return new Promise((resolve, reject) => {
    let resolved = false;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

    const handle = (chunk) => {
      const text = chunk.toString();
      if (onLog) onLog(text);
      if (!resolved) {
        const m = text.match(urlRegex);
        if (m) {
          resolved = true;
          currentURL = m[0];
          if (onURL) onURL(currentURL);
          resolve(currentURL);
        }
      }
    };

    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);

    proc.on('exit', (code) => {
      const wasResolved = resolved;
      proc = null;
      currentURL = null;
      if (!wasResolved) reject(new Error(`cloudflared a quitté (code ${code}) avant l'obtention de l'URL`));
    });

    proc.on('error', (err) => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) {
        reject(new Error('Timeout : URL non trouvée en 30s'));
      }
    }, 30000);
  });
}

async function stop() {
  if (!proc) { currentURL = null; return; }
  return new Promise((resolve) => {
    const p = proc;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      proc = null;
      currentURL = null;
      resolve();
    };
    p.once('exit', finish);
    try { p.kill(); } catch {}
    setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      finish();
    }, 3000);
  });
}

function getURL() { return currentURL; }
function isRunning() { return !!proc; }

module.exports = { start, stop, getURL, isRunning };
