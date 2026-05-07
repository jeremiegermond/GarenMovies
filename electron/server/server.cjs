const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const { scanFolder, getCatalog, getMedia } = require('./catalog.cjs');
const { streamMedia } = require('./streaming.cjs');
const subtitles = require('./subtitles.cjs');
const ffmpeg = require('./ffmpeg.cjs');

const state = {
  mediaId: null,
  paused: true,
  currentTime: 0,
  updatedAt: Date.now()
};

const chatHistory = [];
const MAX_CHAT = 50;

let hostSocketId = null;
let io = null;
let audioCacheDir = null;

// In-memory remux job tracking: key = `${mediaId}:${audioIdx}`
const remuxJobs = new Map();

function projectedState() {
  if (state.paused || state.mediaId === null) return { ...state };
  const elapsed = (Date.now() - state.updatedAt) / 1000;
  return { ...state, currentTime: state.currentTime + elapsed };
}

function stripMedia(m) {
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    source: { type: m.source.type, ext: m.source.ext, size: m.source.size },
    subs: (m.subs || []).map((s) => ({
      idx: s.idx,
      lang: s.lang,
      label: s.label,
      type: s.type,
      embedded: s.type === 'embedded'
    })),
    audioTracks: (m.audioTracks || []).map((t) => ({
      idx: t.idx,
      lang: t.lang,
      label: t.label,
      codec: t.codec,
      channels: t.channels,
      isDefault: !!t.isDefault,
      rawPlayable: !!t.rawPlayable
    })),
    videoCodec: m.videoCodec || null,
    meta: m.meta && !m.meta.notFound ? {
      poster: m.meta.poster,
      year: m.meta.year,
      overview: m.meta.overview,
      rating: m.meta.rating,
      type: m.meta.type,
      season: m.meta.season,
      episode: m.meta.episode,
      episodeTitle: m.meta.episodeTitle,
      showName: m.meta.showName || m.meta.title
    } : null
  };
}

function safeCatalog() {
  const { catalogue, stream } = getCatalog();
  return {
    catalogue: catalogue.map(stripMedia),
    stream: stream.map(stripMedia)
  };
}

function broadcastViewers() {
  if (!io) return;
  io.emit('viewers', { count: io.engine.clientsCount });
}

function broadcastCatalog() {
  if (!io) return;
  io.emit('catalog', safeCatalog());
}

function getState() { return projectedState(); }

function audioCachePath(mediaId, audioIdx) {
  if (!audioCacheDir) return null;
  return path.join(audioCacheDir, `${mediaId}-a${audioIdx}.mp4`);
}

function jobKey(mediaId, audioIdx) {
  return `${mediaId}:${audioIdx}`;
}

async function startRemuxJob(media, audioIdx) {
  const key = jobKey(media.id, audioIdx);
  const existing = remuxJobs.get(key);
  if (existing && existing.status === 'running') return existing;

  const cachedPath = audioCachePath(media.id, audioIdx);
  if (!cachedPath) throw new Error('audio cache directory not configured');
  if (fs.existsSync(cachedPath)) {
    const job = { status: 'ready', progress: 1, duration: 1 };
    remuxJobs.set(key, job);
    return job;
  }

  const job = { status: 'running', progress: 0, duration: media.duration || 0, startedAt: Date.now() };
  remuxJobs.set(key, job);

  if (!job.duration) {
    ffmpeg.probeDuration(media.source.path).then((d) => { job.duration = d || 0; });
  }

  // Add HEVC tag for browsers that need it to decode HEVC in MP4
  const videoTag = ffmpeg.isHEVC(media.videoCodec) ? 'hvc1' : null;
  const opts = videoTag ? { videoTag } : {};

  ffmpeg.remuxWithAudio(media.source.path, audioIdx, cachedPath, opts, (sec) => {
    job.progress = sec;
  }).then(() => {
    job.status = 'ready';
    if (job.duration > 0) job.progress = job.duration;
  }).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    console.error('[ffmpeg] remux failed:', e.message);
    try { fs.unlinkSync(cachedPath); } catch {}
  });

  return job;
}

function startServer(port, opts = {}) {
  audioCacheDir = opts.audioCacheDir || null;
  if (audioCacheDir) {
    try { fs.mkdirSync(audioCacheDir, { recursive: true }); } catch {}
  }

  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });

    app.get('/api/catalog', (_req, res) => res.json(safeCatalog()));
    app.get('/api/state', (_req, res) => res.json(projectedState()));

    app.get('/api/stream/:id', (req, res) => {
      const m = getMedia(req.params.id);
      if (!m) return res.status(404).end('Unknown media');
      const audio = req.query.audio != null ? parseInt(req.query.audio, 10) : null;

      // No query → raw file (browser plays first audio track natively)
      if (audio == null) return streamMedia(req, res, m);

      // ?audio=0 + track 0 raw-playable → still serve raw, no remux needed
      if (audio === 0 && m.audioTracks?.[0]?.rawPlayable) {
        return streamMedia(req, res, m);
      }

      // Otherwise we need the cached remuxed file
      const cachedPath = audioCachePath(m.id, audio);
      if (cachedPath && fs.existsSync(cachedPath)) {
        return streamMedia(req, res, {
          source: { type: 'local', path: cachedPath, ext: 'mp4' }
        });
      }
      return res.status(409).end('Audio track not yet prepared — POST /api/audio/prepare first');
    });

    app.post('/api/audio/prepare', async (req, res) => {
      const { mediaId, audioIdx } = req.body || {};
      const m = getMedia(mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (audioIdx == null) return res.status(400).json({ error: 'audioIdx required' });

      const idx = parseInt(audioIdx, 10);
      // Track 0 with raw-playable codec needs no remux
      if (idx === 0 && m.audioTracks?.[0]?.rawPlayable) {
        return res.json({ status: 'ready', noRemux: true });
      }
      if (!ffmpeg.isAvailable()) return res.status(501).json({ error: 'ffmpeg unavailable' });
      try {
        const job = await startRemuxJob(m, idx);
        res.json({
          status: job.status,
          progress: job.progress,
          duration: job.duration,
          error: job.error
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/audio/status/:mediaId/:audioIdx', (req, res) => {
      const audioIdx = parseInt(req.params.audioIdx, 10);
      const mediaId = req.params.mediaId;
      const m = getMedia(mediaId);
      if (audioIdx === 0 && m?.audioTracks?.[0]?.rawPlayable) {
        return res.json({ status: 'ready', noRemux: true });
      }
      const cachedPath = audioCachePath(mediaId, audioIdx);
      if (cachedPath && fs.existsSync(cachedPath)) return res.json({ status: 'ready' });
      const job = remuxJobs.get(jobKey(mediaId, audioIdx));
      if (job) {
        return res.json({
          status: job.status,
          progress: job.progress,
          duration: job.duration,
          error: job.error
        });
      }
      res.json({ status: 'idle' });
    });

    app.get('/api/subs/:mediaId/:idx.vtt', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      if (!m) return res.status(404).end('Unknown media');
      const idx = parseInt(req.params.idx, 10);
      const sub = (m.subs || [])[idx];
      if (!sub) return res.status(404).end('Unknown subtitle');

      try {
        let vtt = null;
        if (sub.type === 'sidecar') {
          vtt = subtitles.getSidecarAsVTT(sub);
        } else if (sub.type === 'embedded') {
          vtt = await subtitles.getEmbeddedAsVTT(m, sub);
        }
        if (!vtt) return res.status(415).end('Unsupported subtitle format');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(vtt);
      } catch (e) {
        console.error('Subtitle error:', e);
        res.status(500).end(`Subtitle extraction failed: ${e.message}`);
      }
    });

    const server = http.createServer(app);
    io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });

    io.on('connection', (socket) => {
      socket.data.nickname = 'Anonyme';

      socket.emit('state', projectedState());
      socket.emit('catalog', safeCatalog());
      socket.emit('chat:history', chatHistory);
      broadcastViewers();

      socket.on('hello', ({ role: requestedRole, nickname } = {}) => {
        if (typeof nickname === 'string' && nickname.trim()) {
          socket.data.nickname = nickname.trim().slice(0, 32);
        }
        if (requestedRole === 'host' && hostSocketId === null) {
          hostSocketId = socket.id;
          socket.data.isHost = true;
          socket.emit('role', { role: 'host' });
        } else {
          socket.emit('role', { role: 'client' });
        }
      });

      socket.on('host:state', (payload) => {
        if (socket.id !== hostSocketId) return;
        if (payload.mediaId !== undefined) state.mediaId = payload.mediaId;
        state.paused = !!payload.paused;
        state.currentTime = Number(payload.currentTime) || 0;
        state.updatedAt = Date.now();
        socket.broadcast.emit('state', projectedState());
      });

      socket.on('host:select', ({ mediaId }) => {
        if (socket.id !== hostSocketId) return;
        state.mediaId = mediaId;
        state.paused = true;
        state.currentTime = 0;
        state.updatedAt = Date.now();
        io.emit('state', projectedState());
      });

      socket.on('client:resync', () => {
        socket.emit('state', projectedState());
        socket.emit('catalog', safeCatalog());
      });

      socket.on('chat:send', ({ text } = {}) => {
        if (typeof text !== 'string') return;
        const trimmed = text.trim().slice(0, 500);
        if (!trimmed) return;
        const msg = {
          nickname: socket.data.nickname || 'Anonyme',
          text: trimmed,
          ts: Date.now(),
          isHost: socket.id === hostSocketId
        };
        chatHistory.push(msg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();
        io.emit('chat:message', msg);
      });

      socket.on('disconnect', () => {
        if (socket.id === hostSocketId) {
          hostSocketId = null;
          state.paused = true;
          state.updatedAt = Date.now();
          io.emit('host-left');
        }
        broadcastViewers();
      });
    });

    server.on('error', reject);
    server.listen(port, () => resolve({ port, server }));
  });
}

module.exports = { startServer, scanFolder, getCatalog, getState, broadcastCatalog };
