const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const { scanFolder, getCatalog, getMedia } = require('./catalog.cjs');
const { streamMedia } = require('./streaming.cjs');
const subtitles = require('./subtitles.cjs');
const subtitleDownloader = require('./subtitle-downloader.cjs');
const ffmpeg = require('./ffmpeg.cjs');
const vlc = require('./vlc.cjs');
const { addDownloadedSub } = require('./catalog.cjs');

// Patterns that indicate ffmpeg couldn't even parse the input container —
// usually means we should fall back to VLC's more lenient demuxer.
const FFMPEG_PARSE_ERROR_RE = /(EBML header parsing failed|Invalid data found when processing input|moov atom not found|invalid argument|Unknown encoder)/i;

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

function audioCachePath(mediaId, audioIdx, mode = 'remux') {
  if (!audioCacheDir) return null;
  const suffix = mode === 'transcode' ? '-tx' : '';
  return path.join(audioCacheDir, `${mediaId}-a${audioIdx}${suffix}.mp4`);
}

function jobKey(mediaId, audioIdx, mode = 'remux') {
  return `${mediaId}:${audioIdx}:${mode}`;
}

async function startRemuxJob(media, audioIdx, mode = 'remux') {
  const key = jobKey(media.id, audioIdx, mode);
  const existing = remuxJobs.get(key);
  if (existing && existing.status === 'running') return existing;

  const cachedPath = audioCachePath(media.id, audioIdx, mode);
  if (!cachedPath) throw new Error('audio cache directory not configured');
  if (fs.existsSync(cachedPath)) {
    const job = { status: 'ready', progress: 1, duration: 1, tool: 'cache', mode };
    remuxJobs.set(key, job);
    return job;
  }

  const job = {
    status: 'running',
    progress: 0,
    duration: media.duration || 0,
    startedAt: Date.now(),
    tool: 'ffmpeg',
    mode
  };
  remuxJobs.set(key, job);

  if (!job.duration) {
    ffmpeg.probeDuration(media.source.path).then((d) => { job.duration = d || 0; });
  }

  // Try ffmpeg first (fast, supports our HEVC tag), fall back to VLC if the
  // input is too non-standard for libavformat — libVLC's demuxer is more
  // forgiving. videoMode tells both tools whether to copy video or transcode
  // it to H.264 (the latter is slow but works for browsers without HEVC HW).
  (async () => {
    const videoMode = mode === 'transcode' ? 'transcode' : 'copy';
    const videoTag = videoMode === 'copy' && ffmpeg.isHEVC(media.videoCodec) ? 'hvc1' : null;
    const ffmpegOpts = { videoMode };
    if (videoTag) ffmpegOpts.videoTag = videoTag;

    try {
      await ffmpeg.remuxWithAudio(media.source.path, audioIdx, cachedPath, ffmpegOpts, (sec) => {
        job.progress = sec;
      });
      job.status = 'ready';
      if (job.duration > 0) job.progress = job.duration;
      return;
    } catch (ffmpegErr) {
      console.warn('[ffmpeg] remux failed:', ffmpegErr.message);
      const shouldTryVLC = vlc.isAvailable() && FFMPEG_PARSE_ERROR_RE.test(ffmpegErr.message);
      if (!shouldTryVLC) {
        job.status = 'error';
        job.error = ffmpegErr.message;
        try { fs.unlinkSync(cachedPath); } catch {}
        return;
      }
      console.warn('[remux] falling back to VLC for', path.basename(media.source.path), `(mode=${mode})`);
      job.tool = 'vlc';
      job.progress = 0; // reset; VLC doesn't give progress
      try {
        await vlc.remuxWithVLC(media.source.path, audioIdx, cachedPath, { videoMode });
        job.status = 'ready';
        if (job.duration > 0) job.progress = job.duration;
      } catch (vlcErr) {
        job.status = 'error';
        job.error = `ffmpeg + VLC ont échoué.\nffmpeg: ${ffmpegErr.message.slice(0, 200)}\nVLC: ${vlcErr.message.slice(0, 200)}`;
        console.error('[vlc] remux failed:', vlcErr.message);
        try { fs.unlinkSync(cachedPath); } catch {}
      }
    }
  })();

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
      const force = req.query.force === '1';
      const transcode = req.query.transcode === '1';

      // No query → raw file (browser plays first audio track natively)
      if (audio == null) return streamMedia(req, res, m);

      // ?audio=0 + track 0 raw-playable + no force/transcode → still serve raw
      if (!force && !transcode && audio === 0 && m.audioTracks?.[0]?.rawPlayable) {
        return streamMedia(req, res, m);
      }

      // Otherwise we need the cached file matching this (audio, mode) combo
      const mode = transcode ? 'transcode' : 'remux';
      const cachedPath = audioCachePath(m.id, audio, mode);
      if (cachedPath && fs.existsSync(cachedPath)) {
        return streamMedia(req, res, {
          source: { type: 'local', path: cachedPath, ext: 'mp4' }
        });
      }
      return res.status(409).end('Not yet prepared — POST /api/audio/prepare first');
    });

    app.post('/api/audio/prepare', async (req, res) => {
      const { mediaId, audioIdx, mode = 'remux' } = req.body || {};
      const m = getMedia(mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (audioIdx == null) return res.status(400).json({ error: 'audioIdx required' });

      const idx = parseInt(audioIdx, 10);
      // Track 0 with raw-playable codec needs no prep at all when we're in
      // 'remux' mode (transcode always wants a fresh job).
      if (mode === 'remux' && idx === 0 && m.audioTracks?.[0]?.rawPlayable) {
        return res.json({ status: 'ready', noRemux: true, mode });
      }
      if (!ffmpeg.isAvailable()) return res.status(501).json({ error: 'ffmpeg unavailable' });
      try {
        const job = await startRemuxJob(m, idx, mode);
        res.json({
          status: job.status,
          progress: job.progress,
          duration: job.duration,
          tool: job.tool,
          mode: job.mode,
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
      const transcode = req.query.transcode === '1';
      const mode = transcode ? 'transcode' : 'remux';
      if (mode === 'remux' && audioIdx === 0 && m?.audioTracks?.[0]?.rawPlayable) {
        return res.json({ status: 'ready', noRemux: true, mode });
      }
      const cachedPath = audioCachePath(mediaId, audioIdx, mode);
      if (cachedPath && fs.existsSync(cachedPath)) return res.json({ status: 'ready', mode });
      const job = remuxJobs.get(jobKey(mediaId, audioIdx, mode));
      if (job) {
        return res.json({
          status: job.status,
          progress: job.progress,
          duration: job.duration,
          tool: job.tool,
          mode: job.mode,
          error: job.error
        });
      }
      res.json({ status: 'idle', mode });
    });

    app.get('/api/subs/providers', (_req, res) => {
      res.json({ opensubtitles: subtitleDownloader.hasApiKey() });
    });

    app.get('/api/subs/search/:mediaId', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (!subtitleDownloader.hasApiKey()) {
        return res.status(503).json({ error: 'Aucune clé OpenSubtitles configurée' });
      }

      const lang = (req.query.lang || 'fr').toString().toLowerCase().slice(0, 5);
      const opts = { language: lang };

      if (m.meta?.type === 'tv') {
        opts.type = 'episode';
        opts.query = m.meta.showName || m.meta.title || m.title;
        if (m.meta.season != null) opts.season = m.meta.season;
        if (m.meta.episode != null) opts.episode = m.meta.episode;
      } else {
        opts.type = 'movie';
        opts.query = m.meta?.title || m.title;
        if (m.meta?.year) opts.year = m.meta.year;
      }

      try {
        const results = await subtitleDownloader.search(opts);
        res.json({ results, query: opts });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/subs/download', async (req, res) => {
      const { mediaId, fileId, lang, label } = req.body || {};
      const m = getMedia(mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (!fileId) return res.status(400).json({ error: 'fileId requis' });
      if (!subtitleDownloader.hasApiKey()) {
        return res.status(503).json({ error: 'Aucune clé OpenSubtitles configurée' });
      }

      try {
        const result = await subtitleDownloader.downloadSubtitle(fileId, { lang, mediaId });
        const sub = addDownloadedSub(mediaId, {
          path: result.path,
          lang: lang || 'und',
          label: label || `${(lang || 'und').toUpperCase()} (téléchargé)`
        });
        broadcastCatalog();
        res.json({
          sub: { idx: sub.idx, lang: sub.lang, label: sub.label, embedded: false, type: sub.type },
          remaining: result.remaining,
          requests: result.requests,
          resetTime: result.resetTime
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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
