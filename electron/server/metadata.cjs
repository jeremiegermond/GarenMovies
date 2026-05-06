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

function makeKey(title) {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseTitle(rawTitle) {
  // TV episode: "Show Name S01E01" or "Show Name s1e1"
  let m = rawTitle.match(/^(.+?)\s+s(\d{1,2})e(\d{1,2})\b/i);
  if (m) {
    return { name: m[1].trim(), season: +m[2], episode: +m[3], isTV: true };
  }
  // TV alt: "Show Name 1x01"
  m = rawTitle.match(/^(.+?)\s+(\d{1,2})x(\d{1,2})\b/i);
  if (m) {
    return { name: m[1].trim(), season: +m[2], episode: +m[3], isTV: true };
  }
  // Movie with year: "Title (2010)"
  m = rawTitle.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  if (m) return { name: m[1].trim(), year: m[2], isTV: false };
  return { name: rawTitle.trim(), isTV: false };
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

async function lookupTitle(rawTitle) {
  const key = makeKey(rawTitle);
  if (cache.has(key)) return cache.get(key);
  if (!apiKey) return null;

  const parsed = parseTitle(rawTitle);

  let data;
  if (parsed.isTV) {
    data = await searchTMDB('/search/tv', parsed.name);
  } else {
    const extras = parsed.year ? { year: parsed.year } : {};
    data = await searchTMDB('/search/movie', parsed.name, extras);
  }

  if (!data || data.error) return null;

  if (!data.results || data.results.length === 0) {
    // Fallback: try /search/multi for ambiguous cases
    const multi = await searchTMDB('/search/multi', parsed.name);
    if (multi.results && multi.results.length > 0) {
      const top = multi.results.find(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (top) {
        const result = buildResult(top, top.media_type);
        cache.set(key, result);
        persistCache();
        return result;
      }
    }
    const result = { notFound: true };
    cache.set(key, result);
    persistCache();
    return result;
  }

  const top = data.results[0];
  const result = buildResult(top, parsed.isTV ? 'tv' : 'movie');
  if (parsed.season) result.season = parsed.season;
  if (parsed.episode) result.episode = parsed.episode;
  cache.set(key, result);
  persistCache();
  return result;
}

function buildResult(top, type) {
  const isTV = type === 'tv';
  return {
    tmdbId: top.id,
    title: isTV ? (top.name || top.original_name) : (top.title || top.original_title),
    poster: top.poster_path ? `${TMDB_IMG}${top.poster_path}` : null,
    year: isTV
      ? (top.first_air_date ? top.first_air_date.slice(0, 4) : null)
      : (top.release_date ? top.release_date.slice(0, 4) : null),
    overview: top.overview || null,
    rating: top.vote_average || null,
    type
  };
}

let enrichingPromise = null;

async function enrichBatch(items, onProgress) {
  if (enrichingPromise) return enrichingPromise;
  enrichingPromise = (async () => {
    let changed = 0;
    for (const item of items) {
      if (item.meta && item.meta.poster) continue;
      const meta = await lookupTitle(item.title);
      if (meta && !meta.notFound) {
        item.meta = meta;
        changed++;
        if (onProgress) onProgress(item, changed);
      } else if (meta && meta.notFound) {
        item.meta = { notFound: true };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
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
