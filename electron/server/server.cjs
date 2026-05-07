const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { scanFolder, getCatalog, getMedia } = require('./catalog.cjs');
const { streamMedia } = require('./streaming.cjs');
const subtitles = require('./subtitles.cjs');

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

function startServer(port) {
  return new Promise((resolve, reject) => {
    const app = express();

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
      streamMedia(req, res, m);
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
