// Windows installer build wrapper.
//
// electron-builder's NSIS step *executes* the freshly-built installer to
// generate the uninstaller. On Windows, doing that from a Desktop / OneDrive
// folder is blocked by Controlled Folder Access / Defender, which surfaces as
// `spawn UNKNOWN` and a broken 184 KB installer. Building to a temp dir outside
// those protected paths avoids it — so we build there and copy the artifacts
// back into ./release.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = path.join(os.tmpdir(), 'gm-build');
const releaseDir = path.join(__dirname, '..', 'release');

fs.rmSync(outDir, { recursive: true, force: true });

// Run through a shell (execSync) so `npx`/`.cmd` resolves on Windows — Node 20+
// refuses to spawn .cmd files directly without a shell.
console.log(`[build-win] building installer to ${outDir} (avoids Desktop/CFA "spawn UNKNOWN")`);
execSync(`npx electron-builder --win -c.directories.output="${outDir}"`, { stdio: 'inherit' });

fs.mkdirSync(releaseDir, { recursive: true });
let copied = 0;
for (const name of fs.readdirSync(outDir)) {
  // The three files needed for a release + auto-update: installer, its blockmap,
  // and latest.yml (the update metadata electron-updater reads).
  if (/Setup.*\.exe$/.test(name) || /Setup.*\.exe\.blockmap$/.test(name) || name === 'latest.yml') {
    fs.copyFileSync(path.join(outDir, name), path.join(releaseDir, name));
    console.log('[build-win] copied', name, '-> release/');
    copied++;
  }
}
if (copied < 3) {
  console.warn(`[build-win] warning: expected 3 artifacts, copied ${copied}. Check ${outDir}.`);
  process.exit(1);
}
console.log('[build-win] done — upload release/{*.exe, *.exe.blockmap, latest.yml} to the GitHub release.');
