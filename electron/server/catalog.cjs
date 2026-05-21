const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v']);
const SUB_EXTENSIONS = new Set(['.srt', '.vtt', '.ass']);

const LANG_LABELS = {
  fr: 'Français', fre: 'Français', fra: 'Français',
  en: 'English', eng: 'English',
  es: 'Español', spa: 'Español',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  it: 'Italiano', ita: 'Italiano',
  pt: 'Português', por: 'Português',
  ja: '日本語', jpn: '日本語',
  zh: '中文', chi: '中文',
  ar: 'العربية', ara: 'العربية',
  ru: 'Русский', rus: 'Русский'
};

const media = new Map();
const sources = new Map();

function makeId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
}

function prettyTitle(filename) {
  return path.parse(filename).name
    .replace(/[._]+/g, ' ')
    .replace(/\b(\d{3,4}p|x264|x265|h264|h265|hevc|10bit|bluray|brrip|dvdrip|web-?dl|hdrip|webrip|amzn|nf|hmax|atmos|dts|aac|ddp?5\.1|ac3)\b/gi, '')
    .replace(/\b\[[^\]]+\]/g, '') // strip [GROUP] tags
    .replace(/-[A-Z0-9]+$/i, '')   // strip trailing -RELEASE-GROUP
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEpisodeKey(name) {
  const m = name.toLowerCase().match(/\bs(\d{1,2})e(\d{1,2})\b/);
  if (m) return `s${m[1].padStart(2, '0')}e${m[2].padStart(2, '0')}`;
  const alt = name.toLowerCase().match(/\b(\d{1,2})x(\d{1,2})\b/);
  if (alt) return `s${alt[1].padStart(2, '0')}e${alt[2].padStart(2, '0')}`;
  return null;
}

function inferLangFromName(subBasename, videoBasename) {
  // Take what differs between sub basename and video basename, look for lang code
  const lower = subBasename.toLowerCase();
  // Common patterns: name.fr.srt, name.fr-FR.srt, name.eng.forced.srt
  const langCandidates = lower.match(/\.([a-z]{2,3})(?:[\.\-_]|$)/g) || [];
  for (const cand of langCandidates) {
    const code = cand.replace(/[\.\-_]/g, '');
    if (LANG_LABELS[code]) return code;
  }
  return null;
}

function findSidecarSubs(videoFileName, allFiles, dir) {
  const subs = [];
  const videoBasename = path.parse(videoFileName).name.toLowerCase();
  const epKey = extractEpisodeKey(videoBasename);

  for (const fname of allFiles) {
    const ext = path.extname(fname).toLowerCase();
    if (!SUB_EXTENSIONS.has(ext)) continue;

    const subBasename = path.parse(fname).name.toLowerCase();
    let matched = false;
    let lang = null;

    // Strategy 1: exact basename match (with optional .lang suffix)
    if (subBasename === videoBasename) {
      matched = true;
    } else if (subBasename.startsWith(videoBasename + '.')) {
      const suffix = subBasename.slice(videoBasename.length + 1);
      const langMatch = suffix.match(/^([a-z]{2,3})(?:[\.\-_]|$)/);
      if (langMatch && LANG_LABELS[langMatch[1]]) {
        matched = true;
        lang = langMatch[1];
      } else if (/^[a-z]{2,3}$/.test(suffix)) {
        matched = true;
        lang = suffix;
      }
    }

    // Strategy 2: TV episode key match (Show.S01E01.foo.mkv + Show.S01E01.fr.srt)
    if (!matched && epKey) {
      const subEpKey = extractEpisodeKey(subBasename);
      if (subEpKey === epKey) {
        matched = true;
        lang = inferLangFromName(subBasename, videoBasename);
      }
    }

    if (matched) {
      subs.push({
        type: 'sidecar',
        lang: lang || 'und',
        label: lang ? (LANG_LABELS[lang] || lang.toUpperCase()) : 'Sous-titres',
        path: path.join(dir, fname),
        ext: ext.slice(1)
      });
    }
  }
  return subs;
}

async function walkDir(dir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walkDir(full, depth + 1, maxDepth));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;
    try {
      const stat = await fs.stat(full);
      const subsRaw = findSidecarSubs(entry.name, fileNames, dir);
      const subs = subsRaw.map((s, idx) => ({ idx, ...s }));
      found.push({
        id: makeId(full),
        title: prettyTitle(entry.name),
        category: 'stream',
        source: {
          type: 'local',
          path: full,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: ext.slice(1)
        },
        subs,
        audioTracks: [],
        meta: null
      });
    } catch { /* skip */ }
  }
  return found;
}

async function scanFolder(folder) {
  const sourceKey = `local:${folder}`;
  for (const [id, m] of media) {
    if (m.source.type === 'local' && m.source.path.startsWith(folder + path.sep)) {
      media.delete(id);
    }
  }
  const entries = await walkDir(folder);
  for (const m of entries) media.set(m.id, m);
  sources.set(sourceKey, { type: 'local-scan', folder, category: 'stream' });
  return entries;
}

function clearLocalSources() {
  for (const [id, m] of media) {
    if (m.source.type === 'local') media.delete(id);
  }
  for (const [key, src] of sources) {
    if (src.type === 'local-scan') sources.delete(key);
  }
}

function getCatalog() {
  const all = Array.from(media.values()).sort((a, b) => a.title.localeCompare(b.title));
  return {
    catalogue: all.filter((m) => m.category === 'catalogue'),
    stream: all.filter((m) => m.category === 'stream')
  };
}

function getMedia(id) { return media.get(id) || null; }
function getAllMedia() { return Array.from(media.values()); }
function setMediaMeta(id, meta) {
  const m = media.get(id);
  if (m) m.meta = meta;
}
function setAudioTracksForMedia(mediaId, tracks) {
  const m = media.get(mediaId);
  if (!m) return;
  m.audioTracks = (tracks || []).map((t) => ({
    idx: t.idx,
    lang: t.lang,
    label: t.label,
    codec: t.codec,
    channels: t.channels,
    isDefault: !!t.isDefault,
    rawPlayable: !!t.rawPlayable
  }));
}

function addDownloadedSub(mediaId, { path: srtPath, lang, label, ext = 'srt', source = 'opensubtitles' }) {
  const m = media.get(mediaId);
  if (!m) return null;
  // Reuse 'sidecar' type so the /api/subs endpoint serves it like any other SRT
  const idx = m.subs.length;
  const sub = {
    idx,
    type: 'sidecar',
    source,
    lang: lang || 'und',
    label: label || (lang ? (LANG_LABELS[lang] || lang.toUpperCase()) : 'Téléchargé'),
    path: srtPath,
    ext
  };
  m.subs.push(sub);
  return sub;
}

function setMediaProbeInfo(mediaId, info) {
  const m = media.get(mediaId);
  if (!m || !info) return;
  m.videoCodec = info.videoCodec || null;
  m.videoProfile = info.videoProfile || null;
  m.duration = info.duration || 0;
  if (info.audioTracks) setAudioTracksForMedia(mediaId, info.audioTracks);
}

function addEmbeddedSubsToMedia(mediaId, tracks) {
  const m = media.get(mediaId);
  if (!m) return;
  let nextIdx = m.subs.length;
  for (const t of tracks) {
    if (m.subs.some((s) => s.type === 'embedded' && s.trackNumber === t.number)) continue;
    const lang = t.language || 'und';
    m.subs.push({
      idx: nextIdx++,
      type: 'embedded',
      lang,
      label: t.name || (lang !== 'und' ? (LANG_LABELS[lang] || lang.toUpperCase()) : `Piste #${t.number}`),
      trackNumber: t.number,
      codec: t.type
    });
  }
}
function getScanFolders() {
  return Array.from(sources.values()).filter((s) => s.type === 'local-scan').map((s) => s.folder);
}

module.exports = {
  scanFolder, clearLocalSources, getCatalog, getMedia, getAllMedia,
  setMediaMeta, addEmbeddedSubsToMedia, setAudioTracksForMedia,
  setMediaProbeInfo, addDownloadedSub,
  getScanFolders, LANG_LABELS
};
