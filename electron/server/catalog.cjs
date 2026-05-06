const fs = require('fs').promises;
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
    .replace(/\b(\d{3,4}p|x264|x265|h264|h265|hevc|bluray|brrip|dvdrip|web-?dl|hdrip)\b/gi, '')
    .replace(/\b(20\d{2}|19\d{2})\b/g, (m) => ` (${m})`)
    .replace(/\s+/g, ' ')
    .trim();
}

function findSubsForVideo(videoBasename, allFiles, dir) {
  const subs = [];
  const baseLower = videoBasename.toLowerCase();
  for (const fname of allFiles) {
    const ext = path.extname(fname).toLowerCase();
    if (!SUB_EXTENSIONS.has(ext)) continue;
    const lower = fname.toLowerCase();
    if (!lower.startsWith(baseLower)) continue;
    const middle = fname.slice(videoBasename.length, fname.length - ext.length);
    let lang = null;
    if (middle === '') {
      lang = null;
    } else if (/^\.[a-z]{2,3}$/i.test(middle)) {
      lang = middle.slice(1).toLowerCase();
    } else {
      continue;
    }
    subs.push({
      lang: lang || 'und',
      label: lang ? (LANG_LABELS[lang] || lang.toUpperCase()) : 'Sous-titres',
      path: path.join(dir, fname),
      ext: ext.slice(1)
    });
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

  const fileNames = entries.filter(e => e.isFile()).map(e => e.name);

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
      const basename = path.parse(entry.name).name;
      const subs = findSubsForVideo(basename, fileNames, dir);
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
        subs: subs.map((s, idx) => ({ idx, lang: s.lang, label: s.label, path: s.path, ext: s.ext })),
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
    catalogue: all.filter(m => m.category === 'catalogue'),
    stream: all.filter(m => m.category === 'stream')
  };
}

function getMedia(id) { return media.get(id) || null; }
function getAllMedia() { return Array.from(media.values()); }
function setMediaMeta(id, meta) {
  const m = media.get(id);
  if (m) m.meta = meta;
}
function getScanFolders() {
  return Array.from(sources.values()).filter(s => s.type === 'local-scan').map(s => s.folder);
}

module.exports = {
  scanFolder, clearLocalSources, getCatalog, getMedia, getAllMedia, setMediaMeta, getScanFolders
};
