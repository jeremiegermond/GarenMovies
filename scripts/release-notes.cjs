// Release notes come from src/changelog.json — the same list the app shows in
// its "Quoi de neuf ?" popup after an update, so the two never drift apart.
//
//   node scripts/release-notes.cjs           → writes RELEASE_NOTES_v<package version>.md
//   node scripts/release-notes.cjs 0.12.0    → for that version
//   node scripts/release-notes.cjs --check   → fails if the package version has no entry
//                                              (run by dist:win, so no release ships without one)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgVersion = require(path.join(root, 'package.json')).version;
const changelog = JSON.parse(fs.readFileSync(path.join(root, 'src', 'changelog.json'), 'utf-8'));

const args = process.argv.slice(2);
const check = args.includes('--check');
const version = args.find((a) => !a.startsWith('--')) || pkgVersion;
const entry = changelog.find((e) => e.version === version);

if (!entry || !entry.items?.length) {
  console.error(`[release-notes] Aucune entrée pour la v${version} dans src/changelog.json — ajoute ce qui a changé avant de builder.`);
  process.exit(1);
}
if (check) {
  console.log(`[release-notes] changelog OK pour la v${version} (${entry.items.length} ligne${entry.items.length > 1 ? 's' : ''})`);
  process.exit(0);
}

const md = [
  `# GarenMovies v${version}`,
  '',
  ...entry.items.map((i) => `- ${i}`),
  '',
  `_Installation : télécharge \`GarenMovies-Setup-${version}.exe\` ci-dessous. Déjà installé ? La mise à jour se proposera toute seule au démarrage._`,
  ''
].join('\n');
const out = path.join(root, `RELEASE_NOTES_v${version}.md`);
fs.writeFileSync(out, md);
console.log(`[release-notes] ${path.basename(out)} écrit depuis src/changelog.json`);
