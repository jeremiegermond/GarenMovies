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
const hls = require('./hls.cjs');
const markers = require('./markers.cjs');
const trickplay = require('./trickplay.cjs');
const subsync = require('./subsync.cjs');
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
let importedSubsDir = null;

const SUB_LANGS = {
  fr: 'Français', fre: 'Français', fra: 'Français', en: 'English', eng: 'English',
  es: 'Español', spa: 'Español', de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  it: 'Italiano', ita: 'Italiano', pt: 'Português', por: 'Português',
  ja: '日本語', jpn: '日本語', zh: '中文', chi: '中文', ar: 'العربية', ara: 'العربية',
  ru: 'Русский', rus: 'Русский'
};
function inferSubLang(filename) {
  const cands = String(filename).toLowerCase().match(/[.\-_ ]([a-z]{2,3})(?=[.\-_ ]|$)/g) || [];
  for (const c of cands) { const code = c.replace(/[.\-_ ]/g, ''); if (SUB_LANGS[code]) return code; }
  return null;
}

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
      title: m.meta.title, // official TMDB title — guests display it instead of the file name
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

async function subVtt(m, sub) {
  if (sub.type === 'sidecar') return subtitles.getSidecarAsVTT(sub);
  if (sub.type === 'embedded') return subtitles.getEmbeddedAsVTT(m, sub);
  return null;
}

// Start syncing a film's external subtitles (files next to it, downloaded,
// imported) as soon as it's picked, so it's ready when one is turned on.
// Embedded tracks come from the same release as the video: already in sync.
function presyncSubs(m) {
  if (!m?.duration) return; // not probed yet: the player's request starts it later
  for (const sub of m.subs || []) {
    if (sub.type === 'sidecar') subsync.sync(m, sub, () => subVtt(m, sub));
  }
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
  console.log('[remux] startRemuxJob', { id: media.id, file: path.basename(media.source.path), audioIdx, mode });
  const key = jobKey(media.id, audioIdx, mode);
  const existing = remuxJobs.get(key);
  if (existing && existing.status === 'running') {
    console.log('[remux] reusing in-flight job', key);
    return existing;
  }

  if (ffmpeg.isLikelyCorrupt(media.source.path)) {
    console.warn('[remux] file looks corrupt (leading zeros):', path.basename(media.source.path));
    const job = { status: 'error', tool: 'none', mode,
      error: 'Fichier vide ou corrompu — téléchargement probablement incomplet. Re-télécharge ce fichier.' };
    remuxJobs.set(key, job);
    return job;
  }

  const cachedPath = audioCachePath(media.id, audioIdx, mode);
  if (!cachedPath) throw new Error('audio cache directory not configured');
  if (fs.existsSync(cachedPath)) {
    const sizeKB = Math.round(fs.statSync(cachedPath).size / 1024);
    console.log('[remux] cache hit', path.basename(cachedPath), `(${sizeKB} KB)`);
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
    const sourceAudioCodec = media.audioTracks?.[audioIdx]?.codec;
    // For transcode, plug in whichever HW H.264 encoder is available on this
    // machine (NVENC / QSV / AMF, with matching HW decode when possible).
    let hwInfo = { encoder: 'libx264', hwaccel: null };
    if (videoMode === 'transcode') {
      try { hwInfo = await ffmpeg.detectHwInfo(); } catch {}
    }
    const ffmpegOpts = {
      videoMode,
      sourceAudioCodec,
      hwEncoder: hwInfo.encoder,
      hwaccel: hwInfo.hwaccel
    };
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
    // HLS segment dirs live alongside the MP4 audio cache.
    hls.setCacheDir(audioCacheDir);
  }
  importedSubsDir = opts.importedSubsDir || null;
  if (opts.markersFile) markers.setCacheFile(opts.markersFile);
  if (opts.subsyncFile) subsync.setCachePath(opts.subsyncFile);
  if (opts.trickplayDir) trickplay.setCacheDir(opts.trickplayDir);
  if (importedSubsDir) { try { fs.mkdirSync(importedSubsDir, { recursive: true }); } catch {} }

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
      if (!ffmpeg.isAvailable()) return res.status(501).json({ error: 'ffmpeg unavailable' });
      // No rawPlayable short-circuit here: the client only POSTs prepare when
      // it actually needs a cached MP4 (mode='remux' after raw failed, or
      // audioIdx>0, or mode='transcode'). Short-circuiting to 'ready' without
      // producing the cache file made /api/stream return 409 to the player.
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
      const transcode = req.query.transcode === '1';
      const mode = transcode ? 'transcode' : 'remux';
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

    // ── Progressive HLS transcoding ──
    // The fast "streaming-site" path: transcode to HLS segments and start
    // playing as soon as the first ~4s segment lands (<1s), instead of waiting
    // for a whole-file MP4 transcode. Additive — the MP4 modes above still work.

    app.post('/api/hls/prepare', async (req, res) => {
      const { mediaId, audioIdx } = req.body || {};
      const m = getMedia(mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (audioIdx == null) return res.status(400).json({ error: 'audioIdx required' });
      if (!ffmpeg.isAvailable()) return res.status(501).json({ error: 'ffmpeg unavailable' });
      try {
        await hls.startJob(m, parseInt(audioIdx, 10));
        res.json(hls.getStatus(m.id, parseInt(audioIdx, 10)));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/hls/status/:mediaId/:audioIdx', (req, res) => {
      res.json(hls.getStatus(req.params.mediaId, parseInt(req.params.audioIdx, 10)));
    });

    // Full-length playlist built from the film's duration, so the player shows
    // the real length from the start and can seek anywhere (segments are made
    // on demand below). Unknown duration → ffmpeg's own growing playlist.
    app.get('/api/hls/:mediaId/:audioIdx/index.m3u8', async (req, res) => {
      const audioIdx = parseInt(req.params.audioIdx, 10);
      const m = getMedia(req.params.mediaId);
      let text = null;
      if (m) { try { text = await hls.buildPlaylist(m, audioIdx); } catch (e) { console.warn('[hls] playlist:', e.message); } }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      if (text) return res.send(text);
      const pl = hls.playlistPath(req.params.mediaId, audioIdx);
      if (!pl || !fs.existsSync(pl)) return res.status(404).end('playlist not ready');
      fs.createReadStream(pl).pipe(res);
    });

    app.get('/api/hls/:mediaId/:audioIdx/:segment', async (req, res) => {
      const seg = req.params.segment;
      // Only allow our own segment filenames — never an arbitrary path.
      const match = /^seg_(\d{5})\.ts$/.exec(seg);
      if (!match) return res.status(400).end('bad segment');
      const audioIdx = parseInt(req.params.audioIdx, 10);
      const dir = hls.hlsDir(req.params.mediaId, audioIdx);
      if (!dir) return res.status(404).end('no cache');
      // hls.js drops the request when the user seeks away — stop waiting then,
      // so a stale request never restarts the encoder somewhere useless.
      let aborted = false;
      res.on('close', () => { if (!res.writableFinished) aborted = true; });
      const m = getMedia(req.params.mediaId);
      let segPath = path.join(dir, seg);
      if (m) {
        try { segPath = await hls.ensureSegment(m, audioIdx, parseInt(match[1], 10), () => aborted); }
        catch (e) { console.warn('[hls] segment:', e.message); segPath = null; }
      }
      if (aborted) return;
      if (!segPath || !fs.existsSync(segPath)) return res.status(404).end('segment not found');
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(segPath).pipe(res);
    });

    // Intro / end-credits positions (chapters, audio shared with `pair` — another
    // episode of the same show — or a black end screen). Cached; first call for
    // an episode takes a few seconds.
    app.get('/api/markers/:mediaId', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      const pair = req.query.pair ? getMedia(String(req.query.pair)) : null;
      try {
        res.json(await markers.getMarkers(m, pair && pair.id !== m.id ? pair : null));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Seek-bar preview thumbnails: the first call starts generating them in the
    // background and every call reports how many sheets are ready.
    app.get('/api/trickplay/:mediaId', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      try {
        const v = await trickplay.ensure(m);
        res.setHeader('Cache-Control', 'no-store');
        res.json(v || { sheets: 0, done: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // A single preview picture at slot × 10s, for times the sheets don't cover yet.
    app.get('/api/trickplay/:mediaId/frame/:slot.jpg', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      const slot = /^\d{1,5}$/.test(req.params.slot) ? parseInt(req.params.slot, 10) : -1;
      if (!m || slot < 0) return res.status(404).end('no frame');
      let aborted = false;
      res.on('close', () => { if (!res.writableFinished) aborted = true; });
      const file = await trickplay.frame(m, slot, () => aborted).catch(() => null);
      if (aborted) return;
      if (!file) return res.status(404).end('no frame');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).pipe(res);
    });

    app.get('/api/trickplay/:mediaId/:n.jpg', (req, res) => {
      const m = getMedia(req.params.mediaId);
      const n = /^\d{1,3}$/.test(req.params.n) ? parseInt(req.params.n, 10) : 0;
      const file = m && n ? trickplay.sheetPath(m, n) : null;
      if (!file) return res.status(404).end('no sheet');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).pipe(res);
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
        // Tell everyone in the room to auto-activate the freshly downloaded
        // sub, so guests get it too (not just available in their menu).
        if (io) io.emit('sub:activate', { mediaId, idx: sub.idx });
        presyncSubs(m);
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

    // Import a local subtitle file (host picks it via the OS dialog) onto a
    // film: copy it into an app-managed dir, register it, tell everyone.
    app.post('/api/subs/import', (req, res) => {
      const { mediaId, filePath, lang } = req.body || {};
      const m = getMedia(mediaId);
      if (!m) return res.status(404).json({ error: 'Unknown media' });
      if (!filePath) return res.status(400).json({ error: 'filePath requis' });
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (!['srt', 'vtt', 'ass'].includes(ext)) {
        return res.status(400).json({ error: 'Format non supporté (.srt, .vtt ou .ass)' });
      }
      if (!importedSubsDir) return res.status(500).json({ error: 'Dossier de sous-titres non configuré' });
      try {
        fs.mkdirSync(importedSubsDir, { recursive: true });
        const detectedLang = lang || inferSubLang(path.basename(filePath));
        const dest = path.join(importedSubsDir, `${mediaId}-${Date.now()}.${ext}`);
        fs.copyFileSync(filePath, dest);
        const sub = addDownloadedSub(mediaId, {
          path: dest, lang: detectedLang || 'und', ext, source: 'import',
          label: detectedLang ? undefined : 'Importé'
        });
        if (!sub) return res.status(500).json({ error: 'Ajout impossible' });
        broadcastCatalog();
        if (io) io.emit('sub:activate', { mediaId, idx: sub.idx });
        presyncSubs(m);
        res.json({ sub: { idx: sub.idx, lang: sub.lang, label: sub.label, embedded: false, type: sub.type } });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Audio-based sync of a subtitle track: { pending: true } while the film's
    // sound is analysed (a few seconds, once — the result is cached and shared
    // by every viewer), then { offset, scale, applied }.
    app.get('/api/subs/:mediaId/:idx/sync', (req, res) => {
      const m = getMedia(req.params.mediaId);
      const sub = m && (m.subs || [])[parseInt(req.params.idx, 10)];
      if (!sub) return res.status(404).json({ error: 'Unknown subtitle' });
      const result = subsync.status(m, sub, () => subVtt(m, sub));
      res.json(result || { pending: true });
    });

    app.get('/api/subs/:mediaId/:idx.vtt', async (req, res) => {
      const m = getMedia(req.params.mediaId);
      if (!m) return res.status(404).end('Unknown media');
      const idx = parseInt(req.params.idx, 10);
      const sub = (m.subs || [])[idx];
      if (!sub) return res.status(404).end('Unknown subtitle');

      try {
        const vtt = await subVtt(m, sub);
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
        presyncSubs(getMedia(mediaId));
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
