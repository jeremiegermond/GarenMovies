// "Reprendre là où on en était": the server keeps where each film / episode was
// left (electron/server/progress.cjs → { [mediaId]: { pos, dur, at, done } }).
import { episodeInfo, findNextEpisode } from './episodes.js';

const MIN_POS = 30;

// Unfinished position worth resuming from, or null.
export function resumePos(progress, id) {
  const p = progress?.[id];
  return p && !p.done && p.pos >= MIN_POS ? p.pos : null;
}

function sameShow(a, b) {
  return [...a.keys].some((k) => b.keys.has(k));
}

// What to offer when `media` is opened:
//   here      → seconds to resume this one at (or null)
//   elsewhere → { media, pos } when another episode of the show was watched
//               more recently: the one left unfinished, or the one after the
//               last episode finished. Covers "I clicked the wrong episode".
export function resumeOffer(catalog, progress, media) {
  if (!media || !progress) return null;
  const here = resumePos(progress, media.id);
  let elsewhere = null;
  const cur = episodeInfo(media);
  if (cur) {
    const all = [...(catalog?.stream || []), ...(catalog?.catalogue || [])];
    let last = null;
    for (const m of all) {
      const p = progress[m.id];
      if (!p || (last && progress[last.id].at >= p.at)) continue;
      const info = episodeInfo(m);
      if (info && sameShow(info, cur)) last = m;
    }
    const mine = progress[media.id];
    if (last && last.id !== media.id && !(mine && mine.at >= progress[last.id].at)) {
      const target = progress[last.id].done ? findNextEpisode(catalog, last) : last;
      if (target && target.id !== media.id) elsewhere = { media: target, pos: resumePos(progress, target.id) };
    }
  }
  return here != null || elsewhere ? { here, elsewhere, dur: progress[media.id]?.dur || 0 } : null;
}

// 83 → "1:23", 4980 → "1:23:00"
export function formatTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
