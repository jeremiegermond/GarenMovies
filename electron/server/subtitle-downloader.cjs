const fs = require('fs');
const path = require('path');

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'GarenMovies v0.1.0';

let apiKey = null;
let downloadDir = null;

function setApiKey(key) {
  apiKey = key && key.trim() ? key.trim() : null;
}

function setDownloadDir(dir) {
  downloadDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function hasApiKey() { return !!apiKey; }

function authHeaders() {
  return {
    'Api-Key': apiKey,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
  };
}

async function search(opts) {
  if (!apiKey) throw new Error('OpenSubtitles API key non configurée');
  const params = new URLSearchParams();
  if (opts.query) params.set('query', opts.query);
  if (opts.language) params.set('languages', opts.language);
  if (opts.year) params.set('year', String(opts.year));
  if (opts.type) params.set('type', opts.type);
  if (opts.imdbId) params.set('imdb_id', String(opts.imdbId).replace(/^tt/, ''));
  if (opts.tmdbId) params.set('tmdb_id', String(opts.tmdbId));
  if (opts.season != null) params.set('season_number', String(opts.season));
  if (opts.episode != null) params.set('episode_number', String(opts.episode));
  params.set('order_by', 'download_count');
  params.set('order_direction', 'desc');

  const res = await fetch(`${OS_BASE}/subtitles?${params}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Recherche échouée (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.data || []).map((item) => {
    const a = item.attributes || {};
    const file = (a.files || [])[0] || {};
    return {
      id: item.id,
      language: a.language,
      release: a.release || file.file_name || a.feature_details?.title || 'sans titre',
      downloadCount: a.download_count || 0,
      rating: a.ratings || null,
      votes: a.votes || 0,
      trusted: !!a.from_trusted,
      hd: !!a.hd,
      hearingImpaired: !!a.hearing_impaired,
      machineTranslated: !!a.machine_translated || !!a.ai_translated,
      foreignPartsOnly: !!a.foreign_parts_only,
      uploadDate: a.upload_date,
      featureType: a.feature_details?.feature_type,
      movieName: a.feature_details?.movie_name || a.feature_details?.title,
      year: a.feature_details?.year,
      season: a.feature_details?.season_number,
      episode: a.feature_details?.episode_number,
      episodeTitle: a.feature_details?.title,
      fileId: file.file_id,
      fileName: file.file_name
    };
  });
}

async function downloadSubtitle(fileId, opts = {}) {
  if (!apiKey) throw new Error('OpenSubtitles API key non configurée');
  if (!downloadDir) throw new Error('Répertoire de cache non configuré');
  if (!fileId) throw new Error('fileId manquant');

  const linkRes = await fetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file_id: fileId })
  });
  if (!linkRes.ok) {
    const body = await linkRes.text().catch(() => '');
    throw new Error(`Demande de lien échouée (HTTP ${linkRes.status}): ${body.slice(0, 200)}`);
  }
  const linkData = await linkRes.json();
  if (!linkData.link) {
    throw new Error(linkData.message || 'Lien de téléchargement absent');
  }

  const srtRes = await fetch(linkData.link, { headers: { 'User-Agent': USER_AGENT } });
  if (!srtRes.ok) throw new Error(`Téléchargement du fichier échoué (HTTP ${srtRes.status})`);
  const buf = Buffer.from(await srtRes.arrayBuffer());

  const lang = (opts.lang || 'und').toLowerCase().slice(0, 5);
  const safeName = `${lang}-${fileId}.srt`;
  const subDir = path.join(downloadDir, opts.mediaId || 'misc');
  try { fs.mkdirSync(subDir, { recursive: true }); } catch {}
  const savePath = path.join(subDir, safeName);
  fs.writeFileSync(savePath, buf);

  return {
    path: savePath,
    fileName: linkData.file_name || safeName,
    remaining: linkData.remaining,
    requests: linkData.requests,
    resetTime: linkData.reset_time
  };
}

module.exports = { setApiKey, setDownloadDir, hasApiKey, search, downloadSubtitle };
