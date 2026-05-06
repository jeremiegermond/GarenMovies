const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v']);

// Categories:
//   'catalogue' = movies stored on a remote server (phase 2 — empty for now)
//   'stream'    = movies scanned from the host's local disk
const media = new Map(); // id -> entry
const sources = new Map(); // sourceKey -> { type, folder, category }

function makeId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
}

function prettyTitle(filename) {
  return path.parse(filename).name
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walkDir(full, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        try {
          const stat = await fs.stat(full);
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
            }
          });
        } catch { /* skip unreadable */ }
      }
    }
  }
  return found;
}

async function scanFolder(folder) {
  const sourceKey = `local:${folder}`;
  // Drop previous entries from this source so removed files disappear
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

function getMedia(id) {
  return media.get(id) || null;
}

function getScanFolders() {
  return Array.from(sources.values())
    .filter(s => s.type === 'local-scan')
    .map(s => s.folder);
}

module.exports = { scanFolder, clearLocalSources, getCatalog, getMedia, getScanFolders };
