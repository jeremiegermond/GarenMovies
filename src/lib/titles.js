// Display titles: the catalog's `title` is the file name (kept raw — episode
// detection parses "S01E02" out of it). For display we prefer the official
// TMDB title (French, like the posters), else clean the release name up:
// "Casino Royale 2006 YIFY" → "Casino Royale", "[DKB] Inu-Oh [][BD][ ][]-Subs]"
// → "Inu-Oh". The year is shown separately.

// Release tags that never belong to a title. Deliberately no plain words that
// also appear in real titles (French, Bone, Uncut…): the release year usually
// cuts the junk off anyway.
const TAG_RE = /\b(\d{3,4}p|4k|uhd|x26[45]|h ?26[45]|hevc|av1|xvid|divx|10 ?bit|8 ?bit|hdr10\+?|hdr|dolby ?vision|dovi|blu ?ray|bdrip|brrip|bdremux|dvdrip|web ?dl|web ?rip|webmux|dlmux|bdmux|hdtv|amzn|dsnp|hmax|atvp|remux|repack|truefrench|vostfr|vff|vfq|multi ?subs?|subs|ddp ?\d|ddp|dd ?\d|e?ac ?3|aac ?\d?|dts(-?hd)?|truehd|atmos|opus|flac|yify|yts|rarbg)\b/i;
const YEAR_RE = /(^|[\s([\-])((?:19|20)\d{2})(?=$|[\s)\]-])/g;

const EP_RE = /\b(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{2,3})\b/i;

export function cleanTitle(raw) {
  const original = String(raw || '').trim();
  let t = original.replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')   // [DKB], [BD], [] … release-group / source tags
    .replace(/\{[^}]*\}/g, ' ');
  // Episode: "Breaking Bad (2008) - S03E01 - No Mas" → "Breaking Bad S03E01 – No Mas".
  // Clean the show and the episode name separately, so the year before the
  // marker doesn't cut the marker off.
  const ep = EP_RE.exec(t);
  if (ep && ep.index > 0) {
    const show = cleanTitle(t.slice(0, ep.index));
    let rest = t.slice(ep.index + ep[0].length);
    const tag = TAG_RE.exec(rest);
    if (tag) rest = rest.slice(0, tag.index);
    rest = rest.replace(/\([^)]*\)/g, ' ').replace(/^[\s\-_.:]+|[\s\-_.([{]+$/g, '').replace(/\s+/g, ' ').trim();
    const marker = ep[0].replace(/\s+/g, '').toUpperCase();
    return `${show} ${marker}${rest ? ` – ${rest}` : ''}`;
  }
  const tag = TAG_RE.exec(t);
  if (tag && tag.index > 0) t = t.slice(0, tag.index);
  // Cut at the last year before the tags: that's the release year. Keeps a
  // leading year that is the title ("1917 (2019)", "2001 A Space Odyssey 1968").
  const years = [...t.matchAll(YEAR_RE)].filter((m) => m.index + m[1].length > 0);
  if (years.length) t = t.slice(0, years[years.length - 1].index + years[years.length - 1][1].length);
  t = t.replace(/\(\s*\)/g, ' ')
    .replace(/[\s\-_.([{]+$/, '')
    .replace(/^[\s\-_.)\]}]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "THE WOLF OF WALL STREET" → "The Wolf Of Wall Street" (one-word acronyms like GOAT stay).
  if (t.includes(' ') && /[A-Z]/.test(t) && t === t.toUpperCase()) {
    t = t.toLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
  }
  return t || original;
}

// Compare two display titles the French way ("Été" next to "Ete", case-insensitive).
export const byTitle = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true });

export function displayTitle(m) {
  if (!m) return '';
  // Episodes keep their own (cleaned) name, e.g. "The Sopranos S01E02";
  // films use TMDB's official title when one was found.
  if (m.meta?.title && m.meta.type !== 'tv') return m.meta.title;
  return cleanTitle(m.title);
}
