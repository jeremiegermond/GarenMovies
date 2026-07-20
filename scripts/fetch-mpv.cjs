// Downloads a self-contained Windows mpv.exe into bin/mpv/ (gitignored) so the
// installer can bundle it. Idempotent: skips if already present. Run before the
// Windows build (wired into `dist:win`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'bin', 'mpv');
const outExe = path.join(outDir, 'mpv.exe');

async function main() {
  if (fs.existsSync(outExe) && fs.statSync(outExe).size > 5_000_000) {
    console.log('[fetch-mpv] mpv.exe already present, skipping.');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[fetch-mpv] resolving latest mpv Windows build…');
  const rel = await (await fetch('https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest', {
    headers: { 'User-Agent': 'GarenMovies', 'Accept': 'application/vnd.github+json' }
  })).json();
  const asset = (rel.assets || []).find((a) => /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/.test(a.name));
  if (!asset) throw new Error('no plain mpv-x86_64 asset in latest release');

  const archive = path.join(root, 'bin', 'mpv-dl.7z');
  console.log(`[fetch-mpv] downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
  const buf = Buffer.from(await (await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'GarenMovies' } })).arrayBuffer());
  fs.writeFileSync(archive, buf);

  const sevenZip = require('7zip-bin').path7za;
  const tmp = path.join(root, 'bin', 'mpv-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('[fetch-mpv] extracting…');
  execFileSync(sevenZip, ['x', '-y', `-o${tmp}`, archive], { stdio: 'ignore' });
  fs.copyFileSync(path.join(tmp, 'mpv.exe'), outExe);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  console.log('[fetch-mpv] done →', outExe, `(${(fs.statSync(outExe).size / 1024 / 1024).toFixed(0)} MB)`);
}

main().catch((e) => { console.error('[fetch-mpv] failed:', e.message); process.exit(1); });
