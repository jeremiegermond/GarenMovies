// In-app torrent search across several public indexers, aggregated into one
// list. GarenMovies never downloads anything itself — the magnet is handed off
// to the user's own torrent client (shell.openExternal).
//
// Providers (each isolated + fail-soft; one being down never breaks the others):
//   - apibay      → The Pirate Bay (broad, everything)
//   - YTS         → movies (clean, quality/seeders)
//   - torrents-csv→ broad general index (JSON)
//   - Nyaa        → anime / asian content (RSS)

// Current public UDP trackers so magnets built from an info-hash find peers.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce'
];

function buildMagnet(hash, name) {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || hash)}${tr}`;
}

function magnetHash(magnet) {
  const m = /btih:([a-z0-9]+)/i.exec(magnet || '');
  return m ? m[1].toLowerCase() : null;
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .trim();
}

async function fetchWith(url, as, timeoutMs = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'GarenMovies', 'Accept': as === 'json' ? 'application/json' : '*/*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchApibay(query) {
  try {
    const j = await fetchWith(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, 'json');
    if (!Array.isArray(j)) return [];
    return j
      .filter((x) => x.info_hash && !/^0+$/.test(x.info_hash))
      .map((x) => ({
        title: x.name,
        size: humanSize(x.size),
        sizeBytes: Number(x.size) || 0,
        seeders: Number(x.seeders) || 0,
        leechers: Number(x.leechers) || 0,
        source: 'TPB',
        magnet: buildMagnet(x.info_hash, x.name)
      }));
  } catch (e) { console.warn('[torrents] apibay failed:', e.message); return []; }
}

async function searchYTS(query) {
  try {
    const j = await fetchWith(`https://yts.mx/api/v2/list_movies.json?limit=25&sort_by=seeds&query_term=${encodeURIComponent(query)}`, 'json');
    const out = [];
    for (const m of j?.data?.movies || []) {
      for (const t of m.torrents || []) {
        const name = `${m.title} (${m.year}) ${t.quality}${t.type ? ' ' + t.type.toUpperCase() : ''}`;
        out.push({
          title: name,
          size: t.size || humanSize(t.size_bytes),
          sizeBytes: t.size_bytes || 0,
          seeders: t.seeds ?? 0,
          leechers: t.peers ?? 0,
          source: 'YTS',
          magnet: buildMagnet(t.hash, name)
        });
      }
    }
    return out;
  } catch (e) { console.warn('[torrents] YTS failed:', e.message); return []; }
}

async function searchTorrentsCsv(query) {
  try {
    const j = await fetchWith(`https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=40`, 'json');
    const arr = Array.isArray(j) ? j : (j.torrents || []);
    return arr
      .filter((x) => x.infohash && !/^0+$/.test(x.infohash))
      .map((x) => ({
        title: x.name,
        size: humanSize(x.size_bytes),
        sizeBytes: Number(x.size_bytes) || 0,
        seeders: Number(x.seeders) || 0,
        leechers: Number(x.leechers) || 0,
        source: 'CSV',
        magnet: buildMagnet(x.infohash, x.name)
      }));
  } catch (e) { console.warn('[torrents] torrents-csv failed:', e.message); return []; }
}

async function searchNyaa(query) {
  try {
    const xml = await fetchWith(`https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}`, 'text');
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const out = [];
    for (const it of items) {
      const hash = (it.match(/<nyaa:infoHash>([\s\S]*?)<\/nyaa:infoHash>/i) || [])[1];
      if (!hash) continue;
      const title = decodeXml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const size = ((it.match(/<nyaa:size>([\s\S]*?)<\/nyaa:size>/i) || [])[1] || '')
        .replace('GiB', 'Go').replace('MiB', 'Mo').replace('TiB', 'To').replace('KiB', 'Ko');
      out.push({
        title,
        size,
        sizeBytes: 0,
        seeders: Number((it.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i) || [])[1] || 0),
        leechers: Number((it.match(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/i) || [])[1] || 0),
        source: 'Nyaa',
        magnet: buildMagnet(hash, title)
      });
    }
    return out;
  } catch (e) { console.warn('[torrents] nyaa failed:', e.message); return []; }
}

// YggTorrent (French tracker) via the community yggapi.eu JSON API. The list
// endpoint doesn't include the info-hash, so we fetch it per result from the
// detail endpoint (capped + parallel). Best-effort: any failure → [].
async function searchYgg(query) {
  try {
    const list = await fetchWith(`https://yggapi.eu/torrents?q=${encodeURIComponent(query)}&order_by=seeders&page=1`, 'json', 8000);
    const arr = Array.isArray(list) ? list : (list?.torrents || list?.data || []);
    if (!arr.length) return [];
    const top = arr.slice(0, 12);
    const resolved = await Promise.all(top.map(async (x) => {
      try {
        let hash = x.hash || x.info_hash || x.infohash;
        if (!hash && x.id != null) {
          const d = await fetchWith(`https://yggapi.eu/torrent/${x.id}`, 'json', 6000);
          hash = d?.hash || d?.info_hash || d?.infohash;
        }
        if (!hash) return null;
        const name = x.title || x.name;
        return {
          title: name,
          size: humanSize(x.size || x.size_bytes),
          sizeBytes: Number(x.size || x.size_bytes) || 0,
          seeders: Number(x.seeders) || 0,
          leechers: Number(x.leechers) || 0,
          source: 'Ygg',
          magnet: buildMagnet(hash, name)
        };
      } catch { return null; }
    }));
    return resolved.filter(Boolean);
  } catch (e) { console.warn('[torrents] ygg failed:', e.message); return []; }
}

// AnimeTosho JSON feed — aggregates Nyaa + other anime sources, info-hash inline.
async function searchAnimeTosho(query) {
  try {
    const j = await fetchWith(`https://feed.animetosho.org/json?q=${encodeURIComponent(query)}`, 'json', 8000);
    const arr = Array.isArray(j) ? j : (j?.results || []);
    return arr
      .map((x) => {
        const hash = x.info_hash || x.infohash || x.hash;
        if (!hash) return null;
        const name = x.title || x.torrent_name || x.torrent_url || 'torrent';
        return {
          title: name,
          size: humanSize(x.total_size || x.size),
          sizeBytes: Number(x.total_size || x.size) || 0,
          seeders: Number(x.seeders ?? x.seed ?? 0) || 0,
          leechers: Number(x.leechers ?? x.leech ?? 0) || 0,
          source: 'Tosho',
          magnet: buildMagnet(hash, name)
        };
      })
      .filter(Boolean);
  } catch (e) { console.warn('[torrents] animetosho failed:', e.message); return []; }
}

const PROVIDERS = [searchApibay, searchYTS, searchTorrentsCsv, searchNyaa, searchYgg, searchAnimeTosho];

async function search(query) {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const all = (await Promise.all(PROVIDERS.map((p) => p(q)))).flat();
  // Dedupe by info-hash (same torrent can appear on several indexers), keep the
  // highest-seeded copy, then sort the whole list by seeders.
  const seen = new Set();
  const results = [];
  for (const r of all.filter((x) => x.magnet).sort((a, b) => b.seeders - a.seeders)) {
    const h = magnetHash(r.magnet);
    if (h) { if (seen.has(h)) continue; seen.add(h); }
    results.push(r);
  }
  return { results: results.slice(0, 80) };
}

module.exports = { search, buildMagnet };
