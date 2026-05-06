const fs = require('fs');
const path = require('path');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const cache = new Map(); // titleKey -> { poster, year, overview, tmdbId } | { notFound: true }
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
  // "Inception (2010)" -> { name: "Inception", year: 2010 }
  const m = rawTitle.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  if (m) return { name: m[1].trim(), year: m[2] };
  return { name: rawTitle.trim(), year: null };
}

async function lookupTitle(rawTitle) {
  const key = makeKey(rawTitle);
  if (cache.has(key)) return cache.get(key);
  if (!apiKey) return null;

  const { name, year } = parseTitle(rawTitle);
  const params = new URLSearchParams({
    api_key: apiKey,
    query: name,
    language: 'fr-FR',
    include_adult: 'false'
  });
  if (year) params.set('year', year);

  try {
    const res = await fetch(`${TMDB_BASE}/search/movie?${params}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      const result = { notFound: true, error: `HTTP ${res.status}` };
      cache.set(key, result);
      return result;
    }
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      const result = { notFound: true };
      cache.set(key, result);
      persistCache();
      return result;
    }
    const top = data.results[0];
    const result = {
      tmdbId: top.id,
      title: top.title,
      poster: top.poster_path ? `${TMDB_IMG}${top.poster_path}` : null,
      year: top.release_date ? top.release_date.slice(0, 4) : null,
      overview: top.overview || null,
      rating: top.vote_average || null
    };
    cache.set(key, result);
    persistCache();
    return result;
  } catch (e) {
    return null; // transient — don't cache failures
  }
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
      await new Promise((r) => setTimeout(r, 200)); // throttle
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
