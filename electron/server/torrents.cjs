// In-app torrent search. Queries public indexers (YTS for movies + apibay for
// The Pirate Bay's wider catalogue) and returns normalized results with a
// ready-to-use magnet link. GarenMovies never downloads anything itself — the
// magnet is handed off to the user's own torrent client (shell.openExternal).

// A solid, current set of public UDP trackers so freshly-built magnets from
// info-hash actually find peers.
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

function humanSize(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function fetchJSON(url, timeoutMs = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'GarenMovies', 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchYTS(query) {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?limit=25&sort_by=seeds&query_term=${encodeURIComponent(query)}`;
    const j = await fetchJSON(url);
    const movies = j?.data?.movies || [];
    const out = [];
    for (const m of movies) {
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
  } catch (e) {
    console.warn('[torrents] YTS failed:', e.message);
    return [];
  }
}

async function searchApibay(query) {
  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    const j = await fetchJSON(url);
    if (!Array.isArray(j)) return [];
    return j
      // apibay signals "no results" with a single row whose info_hash is all zeros.
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
  } catch (e) {
    console.warn('[torrents] apibay failed:', e.message);
    return [];
  }
}

async function search(query) {
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const [yts, tpb] = await Promise.all([searchYTS(q), searchApibay(q)]);
  const results = [...yts, ...tpb]
    .filter((r) => r.magnet)
    .sort((a, b) => b.seeders - a.seeders);
  return { results };
}

module.exports = { search, buildMagnet };
