// Series helpers: recognise an episode (from TMDB meta, or from the file title
// when there's no TMDB key) and find the episode that comes after it in the
// library — next episode of the season, or the first one of the next season.

const EP_PATTERNS = [
  /^(.+?)\s+s(\d{1,2})\s*e(\d{1,3})\b/i, // "Show Name S01E02"
  /^(.+?)\s+(\d{1,2})x(\d{1,3})\b/i      // "Show Name 1x02"
];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// → { keys: Set<normalised show name>, season, episode } or null for non-episodes.
export function episodeInfo(m) {
  if (!m) return null;
  const title = String(m.title || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let parsed = null;
  for (const re of EP_PATTERNS) {
    const x = title.match(re);
    if (x) { parsed = { name: x[1], season: +x[2], episode: +x[3] }; break; }
  }
  const meta = m.meta && m.meta.type === 'tv' && m.meta.episode != null ? m.meta : null;
  const season = meta?.season ?? parsed?.season;
  const episode = meta?.episode ?? parsed?.episode;
  if (season == null || episode == null) return null;
  // Match on either the TMDB show name or the name parsed from the file, so a
  // library where only some episodes got TMDB metadata still chains correctly.
  const keys = new Set([norm(meta?.showName), norm(parsed?.name)].filter(Boolean));
  if (keys.size === 0) return null;
  return { keys, season: Number(season), episode: Number(episode), showName: meta?.showName || parsed?.name };
}

export function findNextEpisode(catalog, current) {
  const cur = episodeInfo(current);
  if (!cur) return null;
  const all = [...(catalog?.stream || []), ...(catalog?.catalogue || [])];
  let best = null;
  let bestInfo = null;
  for (const m of all) {
    if (!m || m.id === current.id) continue;
    const info = episodeInfo(m);
    if (!info || ![...info.keys].some((k) => cur.keys.has(k))) continue;
    const after = info.season > cur.season || (info.season === cur.season && info.episode > cur.episode);
    if (!after) continue;
    if (!best || info.season < bestInfo.season || (info.season === bestInfo.season && info.episode < bestInfo.episode)) {
      best = m;
      bestInfo = info;
    }
  }
  return best;
}

export function findPrevEpisode(catalog, current) {
  const cur = episodeInfo(current);
  if (!cur) return null;
  const all = [...(catalog?.stream || []), ...(catalog?.catalogue || [])];
  let best = null;
  let bestInfo = null;
  for (const m of all) {
    if (!m || m.id === current.id) continue;
    const info = episodeInfo(m);
    if (!info || ![...info.keys].some((k) => cur.keys.has(k))) continue;
    const before = info.season < cur.season || (info.season === cur.season && info.episode < cur.episode);
    if (!before) continue;
    if (!best || info.season > bestInfo.season || (info.season === bestInfo.season && info.episode > bestInfo.episode)) {
      best = m;
      bestInfo = info;
    }
  }
  return best;
}

// Another episode of the same show to compare audio with (intro / credits
// detection): the next one, or the previous one for the last episode.
export function findPairEpisode(catalog, current) {
  return findNextEpisode(catalog, current) || findPrevEpisode(catalog, current);
}
