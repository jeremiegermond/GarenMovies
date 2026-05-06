const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { scanFolder, getCatalog, getMedia } = require('./catalog.cjs');
const { streamMedia } = require('./streaming.cjs');

const state = {
  mediaId: null,
  paused: true,
  currentTime: 0,
  updatedAt: Date.now()
};

let hostSocketId = null;
let io = null;

function projectedState() {
  if (state.paused || state.mediaId === null) return { ...state };
  const elapsed = (Date.now() - state.updatedAt) / 1000;
  return { ...state, currentTime: state.currentTime + elapsed };
}

function safeCatalog() {
  const { catalogue, stream } = getCatalog();
  return {
    catalogue: catalogue.map(stripPath),
    stream: stream.map(stripPath)
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

function getState() {
  return projectedState();
}

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

    const server = http.createServer(app);
    io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });

    io.on('connection', (socket) => {
      socket.emit('state', projectedState());
      socket.emit('catalog', safeCatalog());
      broadcastViewers();

      socket.on('hello', ({ role: requestedRole } = {}) => {
        if (requestedRole === 'host' && hostSocketId === null) {
          hostSocketId = socket.id;
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

function stripPath(m) {
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    source: { type: m.source.type, ext: m.source.ext, size: m.source.size }
  };
}

module.exports = { startServer, scanFolder, getCatalog, getState, broadcastCatalog };
