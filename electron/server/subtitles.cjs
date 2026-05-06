const fs = require('fs');

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
  // Heuristic: try utf-8, fall back to latin1
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer);
    return { encoding: 'utf-8', skipBOM: 0 };
  } catch {
    return { encoding: 'latin1', skipBOM: 0 };
  }
}

function readSubtitle(filePath) {
  const buf = fs.readFileSync(filePath);
  const { encoding, skipBOM } = detectEncoding(buf);
  return new TextDecoder(encoding === 'latin1' ? 'windows-1252' : encoding).decode(buf.slice(skipBOM));
}

function srtToVtt(srt) {
  const fixed = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + fixed;
}

function getSubtitleAsVTT(subEntry) {
  const text = readSubtitle(subEntry.path);
  if (subEntry.ext === 'vtt') {
    return text.startsWith('WEBVTT') ? text : 'WEBVTT\n\n' + text;
  }
  if (subEntry.ext === 'srt') {
    return srtToVtt(text);
  }
  // .ass not supported in HTML5 video; future: convert with subsrt
  return null;
}

module.exports = { getSubtitleAsVTT };
