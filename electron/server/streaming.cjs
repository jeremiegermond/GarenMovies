const fs = require('fs');
const path = require('path');

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo'
};

function streamLocal(req, res, mediaEntry) {
  const filePath = mediaEntry.source.path;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).end('File not found');
    return;
  }

  const fileSize = stat.size;
  const ext = mediaEntry.source.ext || path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;

  // no-store keeps the browser from caching a stale response across audio-
  // track switches (different ?audio=N URLs should always re-fetch).
  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
    res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': mime,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function streamMedia(req, res, mediaEntry) {
  if (mediaEntry.source.type === 'local') {
    return streamLocal(req, res, mediaEntry);
  }
  res.status(501).end('Source type not supported yet');
}

module.exports = { streamMedia };
