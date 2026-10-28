const fs = require('fs');
const path = require('path');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const cache = new Map();
let apiKey = null;
let cacheFile = null;

function setApiKey(key) {
  apiKey = key && key.trim() ? key.trim() : null;
}

function setCachePath(p) {
  cacheFile = p;
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const [k, v] of Object.entries(data)) cache.set(k, v);
    }
  } catch { /* ignore */ }
}

function persistCache() {
  if (!cacheFile) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch { /* ignore */ }
}

function normalizeName(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cacheKey(parsed) {
  const base = normalizeName(parsed.name);
  if (parsed.isTV) return `tv:${base}:s${parsed.season || 0}`;
  return `m:${base}${parsed.year ? ':' + parsed.year : ''}`;
}

// The first of these tokens marks the start of release noise (encoding /
// quality / group), i.e. everything after it is NOT part of the real title.
// Used to trim the TMDB query when a scene name has no usable year.
const SCENE_TAG_RE = /\b(\d{3,4}p|4k|2160p|1080p|720p|480p|x264|x265|h ?264|h ?265|hevc|av1|xvid|divx|10bit|12bit|8bit|hdr10?\+?|hdr|dv|bluray|blu ray|brrip|bdrip|dvdrip|dvd|web ?dl|web ?rip|webmux|dlmux|bdmux|hdtv|amzn|nf|hmax|dsnp|atvp|atmos|dts|aac\d?|ac ?3|eac ?3|truehd|ddp?\d?|opus|flac|mp3|remux|repack|proper|extended|uncut|remastered|imax|hybrid|complete|multi|dual|vostfr|subs?|ita|eng|fra|fre|vff?|vfq|truefrench)\b/i;

function cleanupName(s) {
  // Drop leading/trailing separators and stray opening brackets left behind
  // when we slice a title right before a "(2014)" style year.
  return s.replace(/[\s\-_.([{]+$/, '').replace(/^[\s\-_.)\]}]+/, '').replace(/\s+/g, ' ').trim();
}

function parseTitle(rawTitle) {
  // Normalise separators so dotted scene names ("Show.Name.S01E01...") parse
  // the same as spaced ones.
  const t = rawTitle.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // TV episode: "Show Name S01E01" / "s1e1" / "1x01"
  let m = t.match(/^(.+?)\s+s(\d{1,2})\s*e(\d{1,2})\b/i)
       || t.match(/^(.+?)\s+(\d{1,2})x(\d{1,2})\b/i);
  if (m) {
    // "Breaking Bad (2008) - S03E01": the year is the series' first air year —
    // a search hint, not part of the name (TMDB finds nothing for "Breaking Bad (2008)").
    let name = cleanupName(m[1]);
    let year = null;
    const ym = name.match(/^(.+?)[\s\-_]*[([]?((?:19|20)\d{2})[)\]]?$/);
    if (ym && cleanupName(ym[1])) { name = cleanupName(ym[1]); year = ym[2]; }
    return { name, year, season: +m[2], episode: +m[3], isTV: true };
  }

  // Movie: cut at the first release-year token (1900–2099) wherever it sits —
  // everything after it (codec/res/group) is junk. This turns
  // "The Dark Knight 2008 bluray av1 subs-Dust" into "The Dark Knight" + 2008.
  const ym = t.match(/\b(19\d{2}|20\d{2})\b/);
  if (ym && ym.index > 0) {
    return { name: cleanupName(t.slice(0, ym.index)), year: ym[1], isTV: false };
  }

  // No year: cut at the first scene tag if there is one before real text ends.
  const tag = t.match(SCENE_TAG_RE);
  if (tag && tag.index > 0) {
    return { name: cleanupName(t.slice(0, tag.index)), isTV: false };
  }
  return { name: cleanupName(t), isTV: false };
}

async function searchTMDB(endpoint, query, extras = {}) {
  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    language: 'fr-FR',
    include_adult: 'false',
    ...extras
  });
  const res = await fetch(`${TMDB_BASE}${endpoint}?${params}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return await res.json();
}

function buildResult(top, type) {
  const isTV = type === 'tv';
  return {
    tmdbId: top.id,
    title: isTV ? (top.name || top.original_name) : (top.title || top.original_title),
    poster: top.poster_path ? `${TMDB_IMG}${top.poster_path}` : null,
    seriesPoster: top.poster_path ? `${TMDB_IMG}${top.poster_path}` : null,
    year: isTV
      ? (top.first_air_date ? top.first_air_date.slice(0, 4) : null)
      : (top.release_date ? top.release_date.slice(0, 4) : null),
    overview: top.overview || null,
    rating: top.vote_average || null,
    type
  };
}

async function getSeasonData(tmdbId, season) {
  try {
    const params = new URLSearchParams({ api_key: apiKey, language: 'fr-FR' });
    const res = await fetch(`${TMDB_BASE}/tv/${tmdbId}/season/${season}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const titles = {};
    if (Array.isArray(data.episodes)) {
      for (const ep of data.episodes) {
        if (ep.name) titles[ep.episode_number] = ep.name;
      }
    }
    return {
      poster: data.poster_path ? `${TMDB_IMG}${data.poster_path}` : null,
      overview: data.overview || null,
      episodeTitles: titles
    };
  } catch { return null; }
}

async function fetchAndCache(parsed, key) {
  let data;
  if (parsed.isTV) {
    data = await searchTMDB('/search/tv', parsed.name, parsed.year ? { first_air_date_year: parsed.year } : {});
    // A wrong year hint shouldn't cost the match: retry without it.
    if (parsed.year && data && !data.error && !data.results?.length) data = await searchTMDB('/search/tv', parsed.name);
  } else {
    const extras = parsed.year ? { year: parsed.year } : {};
    data = await searchTMDB('/search/movie', parsed.name, extras);
  }
  if (!data || data.error) return null;

  let result = null;
  if (data.results && data.results.length > 0) {
    result = buildResult(data.results[0], parsed.isTV ? 'tv' : 'movie');
  } else {
    // Fallback to multi
    const multi = await searchTMDB('/search/multi', parsed.name);
    if (multi.results && multi.results.length > 0) {
      const top = multi.results.find((r) => r.media_type === 'movie' || r.media_type === 'tv');
      if (top) result = buildResult(top, top.media_type);
    }
  }

  if (!result) {
    const notFound = { notFound: true };
    cache.set(key, notFound);
    persistCache();
    return notFound;
  }

  // For TV: enrich with season-specific poster + episode titles
  if ((parsed.isTV || result.type === 'tv') && parsed.season && result.tmdbId) {
    const seasonData = await getSeasonData(result.tmdbId, parsed.season);
    if (seasonData) {
      if (seasonData.poster) {
        result.poster = seasonData.poster;
      }
      result.season = parsed.season;
      result.seasonOverview = seasonData.overview;
      result.episodeTitles = seasonData.episodeTitles;
    }
  }

  cache.set(key, result);
  persistCache();
  return result;
}

async function lookupTitle(rawTitle) {
  if (!apiKey) return null;
  const parsed = parseTitle(rawTitle);
  const key = cacheKey(parsed);
  let cached = cache.get(key);
  if (!cached) {
    cached = await fetchAndCache(parsed, key);
  }
  if (!cached) return null;
  if (cached.notFound) return cached;

  // Per-episode wrapper: don't mutate cached, return a new object
  if (cached.type === 'tv' && parsed.isTV) {
    const wrapped = {
      ...cached,
      episode: parsed.episode,
      season: parsed.season || cached.season,
      showName: cached.title
    };
    if (cached.episodeTitles && parsed.episode != null) {
      wrapped.episodeTitle = cached.episodeTitles[parsed.episode] || null;
    }
    return wrapped;
  }
  return cached;
}

let enrichingPromise = null;

async function enrichBatch(items, onProgress) {
  if (enrichingPromise) return enrichingPromise;
  enrichingPromise = (async () => {
    // Only look up items that don't already have a poster or a known "not found"
    // result (those are cheap cache hits anyway, but skip them entirely).
    const todo = items.filter((it) => !(it.meta && (it.meta.poster || it.meta.notFound)));
    let changed = 0;
    let next = 0;
    // Run a few lookups in parallel instead of one-at-a-time with a 200 ms gap
    // between each. TMDB tolerates ~50 req/10 s, so 4 concurrent is safe and the
    // whole library gets posters + categories in seconds instead of tens of them.
    const CONCURRENCY = 4;
    async function worker() {
      while (next < todo.length) {
        const item = todo[next++];
        try {
          const meta = await lookupTitle(item.title);
          if (meta && !meta.notFound) {
            item.meta = meta;
            changed++;
            if (onProgress) onProgress(item, changed);
          } else if (meta && meta.notFound) {
            item.meta = { notFound: true };
          }
        } catch { /* skip this one, keep going */ }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return changed;
  })();
  try {
    return await enrichingPromise;
  } finally {
    enrichingPromise = null;
  }
}

function hasApiKey() { return !!apiKey; }

module.exports = { setApiKey, setCachePath, lookupTitle, enrichBatch, hasApiKey };
