import changelog from '../changelog.json';

// "0.10.0" > "0.9.1" — numeric, part by part.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Every changelog entry newer than `lastSeen` up to `current`, newest first —
// several skipped updates add up into one list.
export function entriesSince(lastSeen, current, entries = changelog) {
  return entries
    .filter((e) => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function allEntries(current, entries = changelog) {
  return entries
    .filter((e) => !current || compareVersions(e.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export const SHOW_CHANGELOG_EVENT = 'garenmovies:show-changelog';
