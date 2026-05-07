const fs = require('fs');
const path = require('path');

let SubtitleParser = null;
try {
  const ms = require('matroska-subtitles');
  // v3+ exports { SubtitleParser, SubtitleStream }; older versions may default-export the class
  SubtitleParser = ms.SubtitleParser || ms.MatroskaSubtitles || ms.default || (typeof ms === 'function' ? ms : null);
} catch { /* optional */ }

let cacheDir = null;

function setCacheDir(dir) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/* ─────────── Sidecar SRT/VTT ─────────── */

function detectEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { encoding: 'utf-8', skipBOM: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { encoding: 'utf-16le', skipBOM: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { encoding: 'utf-16be', skipBOM: 2 };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf-8', skipBOM: 0 };
  } catch {
    return { encoding: 'windows-1252', skipBOM: 0 };
  }
}

function readSubtitle(filePath) {
  const buf = fs.readFileSync(filePath);
  const { encoding, skipBOM } = detectEncoding(buf);
  return new TextDecoder(encoding).decode(buf.slice(skipBOM));
}

function srtToVtt(srt) {
  const fixed = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + fixed;
}

function getSidecarAsVTT(subEntry) {
  const text = readSubtitle(subEntry.path);
  if (subEntry.ext === 'vtt') {
    return text.startsWith('WEBVTT') ? text : 'WEBVTT\n\n' + text;
  }
  if (subEntry.ext === 'srt') {
    return srtToVtt(text);
  }
  return null;
}

/* ─────────── MKV embedded ─────────── */

function probeMkv(filePath) {
  if (!SubtitleParser) {
    console.warn('[subtitles] SubtitleParser not available — matroska-subtitles export shape unexpected');
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const tracks = [];
    let resolved = false;
    let stream;
    let parser;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { stream && stream.destroy(); } catch {}
      resolve(tracks);
    };

    try {
      parser = new SubtitleParser();
      stream = fs.createReadStream(filePath);
    } catch (e) {
      console.error('[subtitles] probeMkv setup failed:', e.message);
      return finish();
    }

    parser.once('tracks', (t) => {
      if (Array.isArray(t)) tracks.push(...t);
      // Give the parser a tiny moment in case extra track events follow, then bail
      setTimeout(finish, 100);
    });
    parser.on('error', (e) => {
      console.error('[subtitles] parser error during probe:', e.message);
      finish();
    });
    stream.on('error', (e) => {
      console.error('[subtitles] stream error during probe:', e.message);
      finish();
    });
    stream.on('end', finish);

    try {
      stream.pipe(parser);
    } catch (e) {
      console.error('[subtitles] pipe failed:', e.message);
      return finish();
    }

    // Safety timeout — some files have tracks deep into the header
    setTimeout(finish, 60000);
  });
}

function extractMkvSub(filePath, trackNumber) {
  if (!SubtitleParser) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const cues = [];
    let parser, stream;
    try {
      parser = new SubtitleParser();
      stream = fs.createReadStream(filePath);
    } catch (e) { return reject(e); }

    parser.on('subtitle', (sub, trackN) => {
      if (trackN === trackNumber) cues.push(sub);
    });
    parser.on('error', reject);
    stream.on('error', reject);
    stream.on('end', () => resolve(cues));
    stream.pipe(parser);
  });
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function msToVttTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msPart = total % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

function cleanText(t) {
  if (!t) return '';
  return String(t)
    .replace(/\{\\[^}]*\}/g, '')   // ASS/SSA inline tags {\an8}
    .replace(/\\N/gi, '\n')         // ASS line break
    .replace(/<[^>]+>/g, '')        // basic HTML strip
    .trim();
}

function cuesToVtt(cues) {
  let out = 'WEBVTT\n\n';
  let n = 0;
  for (const c of cues) {
    const text = cleanText(c.text);
    if (!text) continue;
    n++;
    const start = msToVttTime(c.time);
    const end = msToVttTime(c.time + (c.duration || 2000));
    out += `${n}\n${start} --> ${end}\n${text}\n\n`;
  }
  return out;
}

function cacheKeyFile(mediaId, idx) {
  return path.join(cacheDir || '.', `${mediaId}-${idx}.vtt`);
}

async function getEmbeddedAsVTT(media, sub) {
  const cacheFile = cacheKeyFile(media.id, sub.idx);
  if (cacheDir && fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, 'utf-8');
  }
  const cues = await extractMkvSub(media.source.path, sub.trackNumber);
  const vtt = cuesToVtt(cues);
  if (cacheDir) {
    try { fs.writeFileSync(cacheFile, vtt); } catch {}
  }
  return vtt;
}

function isMkvSupported() { return !!SubtitleParser; }

module.exports = {
  setCacheDir,
  getSidecarAsVTT,
  probeMkv,
  getEmbeddedAsVTT,
  isMkvSupported
};
