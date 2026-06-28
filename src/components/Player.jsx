import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Captions, Loader2, Check, Volume2, AlertTriangle, Search, RotateCcw, Crosshair } from 'lucide-react';
import SubtitleSearchModal from './SubtitleSearchModal.jsx';

const SYNC_THRESHOLD = 1.0;

// HEVC (x265) is effectively never decodable by Electron's bundled Chromium,
// so for those files we skip the doomed raw / remux-copy attempts and jump
// straight to progressive HLS transcoding.
const HEVC_RE = /^(hevc|h\.?265|x265)$/i;
function isHevc(codec) { return HEVC_RE.test(String(codec || '')); }

export default function Player({ src, isHost, syncState, onHostStateChange, subs = [], audioTracks = [], videoCodec = null, streamBase, mediaId, mediaTitle, mediaMeta, onOpenSettings }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const wasPlayingRef = useRef(false);
  const pollTokenRef = useRef(0); // bumped on every reset/prep change to cancel stale polls

  const [showSubMenu, setShowSubMenu] = useState(false);
  const [activeSubIdx, setActiveSubIdx] = useState(-1);
  const [loadingSubIdx, setLoadingSubIdx] = useState(-1);
  const [subOffset, setSubOffset] = useState(0); // seconds, +/-
  const originalCuesRef = useRef(new Map()); // key = `${mediaId}-${subIdx}` -> [{start, end}]

  const [showSubSearch, setShowSubSearch] = useState(false);
  const [hasOSKey, setHasOSKey] = useState(false);
  const [defaultSubLang, setDefaultSubLang] = useState('fr');

  // ── Audio + video playback state machine ──
  //
  //   mode = 'raw'        → URL = src              (browser plays the file as-is)
  //   mode = 'remux'      → URL = src?audio=N[&force=1] (audio re-encoded, video copied)
  //   mode = 'transcode'  → URL = src?audio=N&force=1&transcode=1 (audio AAC + video H.264)
  //
  // Modes escalate automatically on <video> errors:
  //   raw       —onError→ remux       (codec/container Chromium can't read)
  //   remux     —onError→ transcode   (Chromium can't decode the copied video, e.g. HEVC w/o HW)
  //   transcode —onError→ videoError  (give up, show overlay with Retry)
  //
  // `prep` tracks the server-side job for the current mode; the video element
  // is unmounted (URL = null) whenever prep is required but not yet 'ready'.
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [audioIdx, setAudioIdx] = useState(0);
  const [mode, setMode] = useState('raw'); // 'raw' | 'remux' | 'transcode'
  const [prep, setPrep] = useState(null); // null | { status, progress, duration, tool, error }
  const [videoError, setVideoError] = useState(null);

  // Query the streaming server for OpenSubtitles availability + read local default lang
  useEffect(() => {
    if (!streamBase) return;
    fetch(`${streamBase}/api/subs/providers`).then((r) => r.json()).then((d) => {
      setHasOSKey(!!d.opensubtitles);
    }).catch(() => {});
    if (window.electronAPI?.getConfig) {
      window.electronAPI.getConfig().then((cfg) => {
        if (cfg?.defaultSubLang) setDefaultSubLang(cfg.defaultSubLang);
      }).catch(() => {});
    }
  }, [streamBase, mediaId]);

  // Compute the URL to feed to <video>.
  //   raw   → src as-is (no prep needed)
  //   hls   → no src attribute; hls.js attaches the playlist via MSE (effect)
  //   else  → src?audio=N[&force=1][&transcode=1], but only once prep is ready
  let effectiveSrc = null;
  if (src && !videoError && mode !== 'hls') {
    if (mode === 'raw') {
      effectiveSrc = src;
    } else if (prep?.status === 'ready') {
      const params = [`audio=${audioIdx}`];
      if (audioIdx === 0) params.push('force=1');
      if (mode === 'transcode') params.push('transcode=1');
      const sep = src.includes('?') ? '&' : '?';
      effectiveSrc = `${src}${sep}${params.join('&')}`;
    }
  }
  // hls.js drives the <video> element imperatively once the first segment is
  // ready. We still render the element (so hls.js can attach) but set no src.
  const hlsActive = mode === 'hls' && prep?.status === 'ready' && !videoError;
  const hlsUrl = mediaId != null ? `${streamBase}/api/hls/${mediaId}/${audioIdx}/index.m3u8` : null;

  // Reset everything on media change.
  useEffect(() => {
    pollTokenRef.current++;
    setActiveSubIdx(-1);
    setLoadingSubIdx(-1);
    setShowSubMenu(false);
    setShowSubSearch(false);
    setShowAudioMenu(false);
    setAudioIdx(0);
    setMode('raw');
    setPrep(null);
    setVideoError(null);
    setSubOffset(0);
    pendingSeekRef.current = null;
    wasPlayingRef.current = false;
  }, [mediaId]);

  // Reset offset when the user picks a different subtitle track
  useEffect(() => { setSubOffset(0); }, [activeSubIdx]);

  // Decide the starting mode for the default audio track once probe data is in.
  //   HEVC video        → 'hls'    (Chromium can't decode it; go progressive)
  //   non-raw-playable  → 'remux'  (e.g. H.264 video + AC3 audio)
  //   otherwise         → stay 'raw'
  // We only ever promote (raw → …); never demote an already-escalated mode.
  useEffect(() => {
    if (audioIdx !== 0) return;
    if (mode !== 'raw') return;
    if (isHevc(videoCodec)) {
      setMode('hls');
      setPrep(null);
      return;
    }
    if (audioTracks.length === 0) return;
    if (audioTracks[0]?.rawPlayable === false) {
      setMode('remux');
      setPrep(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, audioTracks, audioIdx, mode, videoCodec]);

  // Trigger prep whenever mode requires it. Skip 'error' to avoid loops —
  // the user retries via the overlay button which clears `prep`.
  useEffect(() => {
    if (mode === 'raw') return;
    if (prep?.status === 'running' || prep?.status === 'ready' || prep?.status === 'error') return;
    runPrep(audioIdx, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, audioIdx, mode, prep?.status]);

  // Apply selected subtitle. Tracks may load async after src changes — we listen
  // to addtrack/change events, plus retry a few times to handle race conditions.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = (i === activeSubIdx) ? 'showing' : 'hidden';
      }
    };
    apply();
    const t1 = setTimeout(apply, 100);
    const t2 = setTimeout(apply, 500);
    const t3 = setTimeout(apply, 1500);
    v.textTracks.addEventListener('addtrack', apply);
    v.textTracks.addEventListener('change', apply);
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      v.textTracks.removeEventListener('addtrack', apply);
      v.textTracks.removeEventListener('change', apply);
    };
  }, [activeSubIdx, subs.length, mediaId, effectiveSrc]);

  // Apply the manual offset to the active subtitle track's cues. Cues may load
  // asynchronously (track src is fetched lazily), so we retry a few times until
  // they're available.
  useEffect(() => {
    if (activeSubIdx < 0) return;
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    const trackId = `${mediaId}-${activeSubIdx}`;

    const apply = () => {
      const track = v.textTracks[activeSubIdx];
      if (!track || !track.cues || track.cues.length === 0) return false;
      let orig = originalCuesRef.current.get(trackId);
      if (!orig) {
        orig = [];
        for (let i = 0; i < track.cues.length; i++) {
          orig.push({ start: track.cues[i].startTime, end: track.cues[i].endTime });
        }
        originalCuesRef.current.set(trackId, orig);
      }
      const n = Math.min(track.cues.length, orig.length);
      for (let i = 0; i < n; i++) {
        const c = track.cues[i];
        const o = orig[i];
        try {
          c.startTime = Math.max(0, o.start + subOffset);
          c.endTime = Math.max(c.startTime + 0.01, o.end + subOffset);
        } catch { /* some browsers reject negative/overlapping times */ }
      }
      return true;
    };

    if (apply()) return;
    const t1 = setTimeout(apply, 200);
    const t2 = setTimeout(apply, 800);
    const t3 = setTimeout(apply, 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [activeSubIdx, subOffset, mediaId, effectiveSrc]);

  function syncSubToCurrentTime() {
    const v = videoRef.current;
    if (!v || activeSubIdx < 0 || !v.textTracks) return;
    const track = v.textTracks[activeSubIdx];
    if (!track || !track.cues || track.cues.length === 0) return;
    // Find the cue whose current (shifted) start is closest to the current time,
    // then compute the delta (currentTime - shiftedStart) to add to the offset
    // so that cue aligns exactly at currentTime.
    let bestDelta = null;
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i];
      const inRange = v.currentTime >= c.startTime && v.currentTime <= c.endTime;
      const d = v.currentTime - c.startTime; // positive = need to shift subs forward
      if (inRange) { bestDelta = d; break; }
      if (bestDelta == null || Math.abs(d) < Math.abs(bestDelta)) bestDelta = d;
    }
    if (bestDelta != null) {
      setSubOffset((prev) => +(prev + bestDelta).toFixed(3));
    }
  }

  // Client: apply sync state from server
  useEffect(() => {
    if (isHost) return;
    const v = videoRef.current;
    if (!v || !syncState || syncState.mediaId == null) return;
    suppressRef.current = true;
    const drift = Math.abs(v.currentTime - syncState.currentTime);
    if (drift > SYNC_THRESHOLD) {
      try { v.currentTime = syncState.currentTime; } catch {}
    }
    if (syncState.paused && !v.paused) v.pause();
    else if (!syncState.paused && v.paused) v.play().catch(() => {});
    setTimeout(() => { suppressRef.current = false; }, 50);
  }, [syncState, isHost]);

  // Attach hls.js to the <video> once the first segment is ready. hls.js keeps
  // re-reading the growing EVENT playlist, so playback starts immediately while
  // the transcode (≈9× realtime) races ahead of the playhead.
  useEffect(() => {
    if (mode !== 'hls' || prep?.status !== 'ready') return;
    const v = videoRef.current;
    if (!v || !hlsUrl) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, startPosition: 0, maxBufferLength: 30 });
      hls.loadSource(hlsUrl);
      hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        console.warn('[hls.js] fatal', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); return; } catch {} }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch {} }
        // Unrecoverable → fall back to the whole-file MP4 transcode path.
        setMode('transcode'); setPrep(null);
      });
      return () => { try { hls.destroy(); } catch {} };
    }
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = hlsUrl; // native HLS (Safari) — not the Electron case
      return;
    }
    // No HLS support at all → fall back to MP4 transcode.
    setMode('transcode'); setPrep(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, prep?.status, hlsUrl]);

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    if (pendingSeekRef.current != null) {
      try { v.currentTime = pendingSeekRef.current; } catch {}
      pendingSeekRef.current = null;
    }
    if (wasPlayingRef.current) {
      wasPlayingRef.current = false;
      v.play().catch(() => {});
    }
  }

  function emitState(extra = {}) {
    if (!isHost || !onHostStateChange) return;
    const v = videoRef.current;
    if (!v) return;
    onHostStateChange({ paused: v.paused, currentTime: v.currentTime, ...extra });
  }

  async function activateSubtitle(idx) {
    setShowSubMenu(false);
    if (idx === -1) {
      setActiveSubIdx(-1);
      return;
    }
    const sub = subs[idx];
    if (sub?.embedded) {
      setLoadingSubIdx(idx);
      try {
        await fetch(`${streamBase}/api/subs/${mediaId}/${idx}.vtt`);
      } catch { /* still try to activate */ }
      setLoadingSubIdx(-1);
    }
    setActiveSubIdx(idx);
  }

  // Drive the progressive-HLS prep job: kick off the transcode, then poll until
  // the first segment is ready (typically <1s). Once ready, the hls.js effect
  // attaches the growing playlist to the <video> element.
  async function runHlsPrep(idx) {
    const token = ++pollTokenRef.current;
    setPrep({ status: 'running', progress: 0, duration: 0, tool: 'hls', mode: 'hls' });
    try {
      const r = await fetch(`${streamBase}/api/hls/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId, audioIdx: idx })
      });
      if (token !== pollTokenRef.current) return;
      const init = await r.json();
      if (token !== pollTokenRef.current) return;
      if (init.error) { setPrep({ status: 'error', error: init.error, tool: 'hls', mode: 'hls' }); return; }
      if (init.ready) { setPrep({ status: 'ready', tool: 'hls', mode: 'hls' }); return; }
      const poll = async () => {
        if (token !== pollTokenRef.current) return;
        try {
          const sr = await fetch(`${streamBase}/api/hls/status/${mediaId}/${idx}`);
          if (token !== pollTokenRef.current) return;
          const data = await sr.json();
          if (data.error) { setPrep({ status: 'error', error: data.error, tool: 'hls', mode: 'hls' }); return; }
          if (data.ready) { setPrep({ status: 'ready', tool: 'hls', mode: 'hls' }); return; }
          setPrep({ status: 'running', progress: 0, duration: data.duration || 0, tool: 'hls', mode: 'hls' });
          setTimeout(poll, 600);
        } catch (e) {
          if (token === pollTokenRef.current) setPrep({ status: 'error', error: e.message, tool: 'hls', mode: 'hls' });
        }
      };
      poll();
    } catch (e) {
      if (token === pollTokenRef.current) setPrep({ status: 'error', error: e.message, tool: 'hls', mode: 'hls' });
    }
  }

  // Drive the server-side prep job. A pollToken stamp lets the reset effect
  // cancel any in-flight poll cleanly (older tokens silently stop).
  async function runPrep(idx, requestedMode) {
    if (requestedMode === 'hls') return runHlsPrep(idx);
    const token = ++pollTokenRef.current;
    setPrep({ status: 'running', progress: 0, duration: 0, tool: 'ffmpeg', mode: requestedMode });
    const statusQuery = requestedMode === 'transcode' ? '?transcode=1' : '';
    try {
      const r = await fetch(`${streamBase}/api/audio/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId, audioIdx: idx, mode: requestedMode })
      });
      if (token !== pollTokenRef.current) return;
      const init = await r.json();
      if (token !== pollTokenRef.current) return;
      if (init.status === 'ready') { setPrep({ status: 'ready', mode: requestedMode }); return; }
      if (init.status === 'error') {
        setPrep({ status: 'error', error: init.error || 'Erreur', tool: init.tool, mode: requestedMode });
        return;
      }
      setPrep({ status: 'running', progress: 0, duration: 0, tool: init.tool, mode: requestedMode });
      const poll = async () => {
        if (token !== pollTokenRef.current) return;
        try {
          const sr = await fetch(`${streamBase}/api/audio/status/${mediaId}/${idx}${statusQuery}`);
          if (token !== pollTokenRef.current) return;
          const data = await sr.json();
          if (data.status === 'ready') { setPrep({ status: 'ready', mode: requestedMode }); return; }
          if (data.status === 'error') {
            setPrep({ status: 'error', error: data.error || 'Erreur', tool: data.tool, mode: requestedMode });
            return;
          }
          setPrep({ status: 'running', progress: data.progress || 0, duration: data.duration || 0, tool: data.tool, mode: requestedMode });
          setTimeout(poll, 1000);
        } catch (e) {
          if (token === pollTokenRef.current) setPrep({ status: 'error', error: e.message, mode: requestedMode });
        }
      };
      poll();
    } catch (e) {
      if (token === pollTokenRef.current) setPrep({ status: 'error', error: e.message, mode: requestedMode });
    }
  }

  function onVideoError(e) {
    const err = e?.currentTarget?.error;
    const code = err?.code;
    console.warn('[video] error', code, err?.message, '— current mode:', mode);
    // hls.js owns error handling/recovery while it drives the element via MSE.
    if (mode === 'hls') return;
    // Codes: 1=ABORTED (we just changed src), 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
    if (code === 1) return;
    if (code !== 2 && code !== 3 && code !== 4) return;

    // Preserve playback position before the reload
    const v = videoRef.current;
    if (v) {
      pendingSeekRef.current = v.currentTime;
      wasPlayingRef.current = !v.paused;
    }

    if (mode === 'raw') {
      // HEVC → straight to progressive HLS; everything else → try a remux first.
      const next = isHevc(videoCodec) ? 'hls' : 'remux';
      console.warn('[video] raw failed → escalating to', next);
      setMode(next);
      setPrep(null);
      return;
    }
    if (mode === 'remux') {
      console.warn('[video] remux failed → escalating to progressive HLS');
      setMode('hls');
      setPrep(null);
      return;
    }
    let label = 'Lecture impossible même après transcodage';
    if (code === 3) label = 'Codec vidéo rejeté par le navigateur';
    else if (code === 4) label = 'Source non lisible';
    else if (code === 2) label = 'Erreur réseau';
    setVideoError(label);
  }

  function activateAudioTrack(idx) {
    console.log('[Player] activateAudioTrack', {
      from: audioIdx,
      to: idx,
      track: audioTracks[idx],
      previousMode: mode
    });
    setShowAudioMenu(false);
    if (idx === audioIdx) {
      console.log('[Player] activateAudioTrack: no-op (already on this track)');
      return;
    }

    const v = videoRef.current;
    if (v) {
      pendingSeekRef.current = v.currentTime;
      wasPlayingRef.current = !v.paused;
    }

    setVideoError(null);
    setAudioIdx(idx);
    setPrep(null);

    let next;
    if (isHevc(videoCodec)) {
      // Video needs transcoding regardless of which audio track — go HLS, which
      // re-muxes the chosen audio into the segments anyway.
      next = 'hls';
    } else if (idx === 0) {
      next = audioTracks[0]?.rawPlayable === false ? 'remux' : 'raw';
    } else {
      next = 'remux';
    }
    console.log('[Player] activateAudioTrack: setting mode →', next);
    setMode(next);
  }

  function retryAfterError() {
    setVideoError(null);
    setPrep(null);
    setMode('raw');
    setAudioIdx(0);
  }

  if (!src) {
    return (
      <div className="player-wrap">
        <div className="player-empty">
          {isHost ? 'Choisissez un film dans la bibliothèque pour commencer' : 'En attente du choix de l\'hôte'}
        </div>
      </div>
    );
  }

  const activeSubLabel = activeSubIdx >= 0 ? subs[activeSubIdx]?.label : null;
  const activeAudio = audioTracks[audioIdx];
  const prepProgressPct = prep && prep.duration > 0
    ? Math.min(100, Math.round((prep.progress / prep.duration) * 100))
    : null;

  const showPrepOverlay = mode !== 'raw' && prep?.status === 'running';
  const showPrepError = prep?.status === 'error';
  const showVideoError = !!videoError && !showPrepOverlay && !showPrepError;

  return (
    <div className="player-wrap">
      {(effectiveSrc || hlsActive) ? (
        <video
          ref={videoRef}
          src={effectiveSrc || undefined}
          controls={isHost}
          autoPlay={false}
          crossOrigin="anonymous"
          onLoadedMetadata={onLoadedMetadata}
          onError={onVideoError}
          onPlay={() => !suppressRef.current && emitState({ paused: false })}
          onPause={() => !suppressRef.current && emitState({ paused: true })}
          onSeeked={() => !suppressRef.current && emitState()}
        >
          {subs.map((s) => (
            <track
              key={`${mediaId}-${s.idx}`}
              kind="subtitles"
              src={`${streamBase}/api/subs/${mediaId}/${s.idx}.vtt`}
              srcLang={s.lang === 'und' ? undefined : s.lang}
              label={s.label}
              onLoad={() => {
                const v = videoRef.current;
                if (!v) return;
                for (let i = 0; i < v.textTracks.length; i++) {
                  v.textTracks[i].mode = (i === activeSubIdx) ? 'showing' : 'hidden';
                }
              }}
              onError={(e) => console.warn('[track] failed to load', s.label, e)}
            />
          ))}
        </video>
      ) : (
        <div className="player-prep-bg" />
      )}

      {showPrepOverlay && (
        <div className="player-prep-overlay">
          <Loader2 size={36} strokeWidth={1.75} className="spin" />
          <div className="prep-title">
            {mode === 'hls'
              ? 'Démarrage du flux…'
              : mode === 'transcode'
              ? 'Transcodage vidéo en H.264'
              : prep.tool === 'vlc' ? 'Préparation via VLC' : "Préparation de l'audio"}
          </div>
          <div className="prep-subtitle">
            {audioTracks[audioIdx]?.label || `Piste ${audioIdx}`}
            {mode === 'hls' && ' · lecture progressive (transcodage à la volée)'}
            {mode === 'transcode' && ' · escalade après échec du remux'}
            {mode !== 'transcode' && mode !== 'hls' && prep.tool === 'vlc' && ' · fichier non standard, ffmpeg a refusé'}
          </div>
          {mode === 'hls' ? (
            <div className="prep-pct">Préparation du premier segment — quelques secondes…</div>
          ) : mode === 'transcode' ? (
            <div className="prep-pct">Le transcodage prend ~le temps réel — patience.</div>
          ) : prep.tool === 'vlc' ? (
            <div className="prep-pct">Cela peut prendre quelques minutes — VLC ne donne pas de pourcentage</div>
          ) : (
            <>
              <div className="prep-bar">
                <div className="prep-bar-fill" style={{ width: `${prepProgressPct ?? 0}%` }} />
              </div>
              <div className="prep-pct">{prepProgressPct != null ? `${prepProgressPct}%` : 'démarrage…'}</div>
            </>
          )}
        </div>
      )}

      {showPrepError && (
        <div className="player-prep-overlay error">
          <AlertTriangle size={32} strokeWidth={1.75} />
          <div className="prep-title">Échec de préparation</div>
          <div className="prep-subtitle">{prep.error}</div>
          <button className="primary" onClick={retryAfterError}>Revenir à l'audio par défaut</button>
        </div>
      )}

      {showVideoError && (
        <div className="player-prep-overlay error">
          <AlertTriangle size={32} strokeWidth={1.75} />
          <div className="prep-title">{videoError}</div>
          <div className="prep-subtitle">
            Le format ou le codec n'est pas pris en charge par le lecteur web,
            même après remux. Essayez une autre piste audio ou un autre fichier.
          </div>
          <button className="primary" onClick={retryAfterError}>Réessayer</button>
        </div>
      )}

      <div className="player-overlay">
        {audioTracks.length > 1 && (
          <div className="overlay-control">
            <button
              className={`overlay-toggle ${audioIdx > 0 ? 'on' : ''}`}
              onClick={() => setShowAudioMenu((o) => !o)}
              title="Piste audio"
            >
              <Volume2 size={16} strokeWidth={2} />
              <span className="overlay-toggle-label">
                {activeAudio?.label || 'Audio'}
              </span>
              {prep?.status === 'running' && (
                <span className="overlay-progress">
                  <Loader2 size={12} className="spin" />
                  {prepProgressPct != null ? `${prepProgressPct}%` : '…'}
                </span>
              )}
            </button>
            {showAudioMenu && (
              <>
                <div className="overlay-menu-backdrop" onClick={() => setShowAudioMenu(false)} />
                <div className="overlay-menu">
                  <div className="overlay-menu-title">Piste audio</div>
                  {audioTracks.map((t, i) => {
                    const isActive = i === audioIdx;
                    const prepActive = isActive && prep?.status === 'running';
                    const trackNeedsRemux = i !== 0 || t?.rawPlayable === false;
                    return (
                      <button
                        key={i}
                        className={`overlay-item ${isActive ? 'active' : ''} ${prepActive ? 'loading' : ''}`}
                        onClick={() => activateAudioTrack(i)}
                        disabled={prepActive}
                      >
                        <span className="overlay-check">{isActive && <Check size={14} />}</span>
                        <span className="overlay-label">{t.label}</span>
                        {trackNeedsRemux && t.codec && (
                          <span className="overlay-tag" title={`${t.codec} → AAC remux`}>{t.codec.toUpperCase()}</span>
                        )}
                        {prepActive && (
                          <span className="overlay-progress-inline">
                            {prepProgressPct != null ? `${prepProgressPct}%` : '…'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {prep?.status === 'error' && (
                    <div className="overlay-error">Erreur : {prep.error}</div>
                  )}
                  <div className="overlay-hint">
                    Les pistes incompatibles sont remuxées en AAC (mis en cache après la 1ʳᵉ lecture)
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="overlay-control">
          <button
            className={`overlay-toggle ${activeSubIdx >= 0 ? 'on' : ''}`}
            onClick={() => setShowSubMenu((o) => !o)}
            title="Sous-titres"
          >
            <Captions size={16} strokeWidth={2} />
            <span className="overlay-toggle-label">
              {activeSubLabel || 'Sous-titres'}
            </span>
            {loadingSubIdx >= 0 && <Loader2 size={14} className="spin" />}
          </button>
          {showSubMenu && (
            <>
              <div className="overlay-menu-backdrop" onClick={() => setShowSubMenu(false)} />
              <div className="overlay-menu">
                <div className="overlay-menu-title">Sous-titres</div>
                <button
                  className={`overlay-item ${activeSubIdx === -1 ? 'active' : ''}`}
                  onClick={() => activateSubtitle(-1)}
                >
                  <span className="overlay-check">{activeSubIdx === -1 && <Check size={14} />}</span>
                  <span className="overlay-label">Désactivés</span>
                </button>
                {subs.length === 0 ? (
                  <div className="overlay-empty">Aucun sous-titre détecté</div>
                ) : (
                  subs.map((s, i) => (
                    <button
                      key={i}
                      className={`overlay-item ${activeSubIdx === i ? 'active' : ''} ${loadingSubIdx === i ? 'loading' : ''}`}
                      onClick={() => activateSubtitle(i)}
                      disabled={loadingSubIdx === i}
                    >
                      <span className="overlay-check">{activeSubIdx === i && <Check size={14} />}</span>
                      <span className="overlay-label">{s.label}</span>
                      {s.embedded && <span className="overlay-tag">intégrés</span>}
                      {loadingSubIdx === i && <Loader2 size={12} className="spin" />}
                    </button>
                  ))
                )}
                {subs.some((s) => s.embedded) && (
                  <div className="overlay-hint">Le premier chargement peut prendre quelques secondes</div>
                )}
                {activeSubIdx >= 0 && (
                  <div className="sub-offset">
                    <div className="sub-offset-head">
                      <span>Décalage</span>
                      <span className={`sub-offset-value ${subOffset !== 0 ? 'shifted' : ''}`}>
                        {subOffset === 0 ? '0.00 s' : `${subOffset > 0 ? '+' : ''}${subOffset.toFixed(2)} s`}
                      </span>
                    </div>
                    <div className="sub-offset-row">
                      <button onClick={() => setSubOffset((o) => +(o - 0.5).toFixed(3))} title="Avancer les sous-titres de 0.5 s">−0.5</button>
                      <button onClick={() => setSubOffset((o) => +(o - 0.1).toFixed(3))} title="Avancer les sous-titres de 0.1 s">−0.1</button>
                      <button onClick={() => setSubOffset((o) => +(o + 0.1).toFixed(3))} title="Retarder les sous-titres de 0.1 s">+0.1</button>
                      <button onClick={() => setSubOffset((o) => +(o + 0.5).toFixed(3))} title="Retarder les sous-titres de 0.5 s">+0.5</button>
                    </div>
                    <div className="sub-offset-row">
                      <button
                        className="sub-offset-action"
                        onClick={syncSubToCurrentTime}
                        title="Aligne la phrase la plus proche sur le temps actuel"
                      >
                        <Crosshair size={12} strokeWidth={2} /> Aligner ici
                      </button>
                      {subOffset !== 0 && (
                        <button
                          className="sub-offset-reset"
                          onClick={() => setSubOffset(0)}
                          title="Remettre à zéro"
                        >
                          <RotateCcw size={12} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <button
                  className="overlay-action"
                  onClick={() => { setShowSubMenu(false); setShowSubSearch(true); }}
                >
                  <Search size={13} strokeWidth={2} />
                  Rechercher en ligne
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showSubSearch && (
        <SubtitleSearchModal
          streamBase={streamBase}
          mediaId={mediaId}
          mediaTitle={mediaTitle}
          mediaMeta={mediaMeta}
          defaultLang={defaultSubLang}
          hasOpenSubtitlesKey={hasOSKey}
          onClose={() => setShowSubSearch(false)}
          onOpenSettings={onOpenSettings}
          onDownloaded={(newSub) => {
            // Auto-activate the freshly downloaded sub
            if (newSub?.idx != null) setActiveSubIdx(newSub.idx);
          }}
        />
      )}
    </div>
  );
}
