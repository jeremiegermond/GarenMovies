import { useEffect, useRef, useState } from 'react';
import { Captions, Loader2, Check, Volume2, AlertTriangle, Search, RotateCcw, Crosshair } from 'lucide-react';
import SubtitleSearchModal from './SubtitleSearchModal.jsx';

const SYNC_THRESHOLD = 1.0;

function isTrackRawPlayable(track) {
  // Treat unknown (not yet probed) as playable so we don't block initial render
  return !track || track.rawPlayable !== false;
}

function buildStreamUrl(baseUrl, audioIdx, audioTracks) {
  if (!baseUrl) return null;
  // Track 0 + raw-playable codec → no audio query, browser plays raw default
  if (audioIdx === 0 && isTrackRawPlayable(audioTracks?.[0])) return baseUrl;
  // Otherwise the URL points to the cached remuxed file
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}audio=${audioIdx}`;
}

export default function Player({ src, isHost, syncState, onHostStateChange, subs = [], audioTracks = [], streamBase, mediaId, mediaTitle, mediaMeta, onOpenSettings }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const wasPlayingRef = useRef(false);
  const cancelPollRef = useRef(false);

  const [showSubMenu, setShowSubMenu] = useState(false);
  const [activeSubIdx, setActiveSubIdx] = useState(-1);
  const [loadingSubIdx, setLoadingSubIdx] = useState(-1);
  const [subOffset, setSubOffset] = useState(0); // seconds, +/-
  const originalCuesRef = useRef(new Map()); // key = `${mediaId}-${subIdx}` -> [{start, end}]

  const [showSubSearch, setShowSubSearch] = useState(false);
  const [hasOSKey, setHasOSKey] = useState(false);
  const [defaultSubLang, setDefaultSubLang] = useState('fr');

  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [audioIdx, setAudioIdx] = useState(0);
  const [audioReady, setAudioReady] = useState(true);
  const [audioPrep, setAudioPrep] = useState(null); // { idx, status, progress, duration, error }

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

  const effectiveSrc = audioReady ? buildStreamUrl(src, audioIdx, audioTracks) : null;

  // Reset on media change
  useEffect(() => {
    cancelPollRef.current = true;
    setActiveSubIdx(-1);
    setLoadingSubIdx(-1);
    setShowSubMenu(false);
    setShowSubSearch(false);
    setShowAudioMenu(false);
    setAudioIdx(0);
    setAudioPrep(null);
    setAudioReady(true);
    setSubOffset(0);
    pendingSeekRef.current = null;
    wasPlayingRef.current = false;
  }, [mediaId]);

  // Reset offset when the user picks a different subtitle track
  useEffect(() => { setSubOffset(0); }, [activeSubIdx]);

  // Auto-prepare the default audio if it's not browser-playable (e.g. AC-3 / DTS).
  // This avoids the "video plays silently" trap on default load.
  useEffect(() => {
    if (audioTracks.length === 0) return; // not yet probed — let raw default attempt play
    const def = audioTracks[0];
    if (def && def.rawPlayable === false && audioIdx === 0 && audioReady) {
      runPrepareFlow(0).catch(() => { /* error state already set */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, audioTracks.length]);

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

  async function runPrepareFlow(idx) {
    cancelPollRef.current = false;
    setAudioReady(false);
    setAudioPrep({ idx, status: 'running', progress: 0, duration: 0 });
    try {
      const r = await fetch(`${streamBase}/api/audio/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId, audioIdx: idx })
      });
      const initial = await r.json();
      if (initial.status === 'ready') {
        setAudioPrep(null);
        setAudioReady(true);
        return;
      }
      if (initial.status === 'error') {
        setAudioPrep({ idx, status: 'error', error: initial.error || 'Erreur' });
        throw new Error(initial.error);
      }
      // Poll
      await new Promise((resolve, reject) => {
        const poll = async () => {
          if (cancelPollRef.current) return;
          try {
            const sr = await fetch(`${streamBase}/api/audio/status/${mediaId}/${idx}`);
            const data = await sr.json();
            if (data.status === 'ready') {
              setAudioPrep(null);
              setAudioReady(true);
              resolve();
              return;
            }
            if (data.status === 'error') {
              setAudioPrep({ idx, status: 'error', error: data.error || 'Erreur' });
              reject(new Error(data.error));
              return;
            }
            setAudioPrep({ idx, status: 'running', progress: data.progress || 0, duration: data.duration || 0 });
            setTimeout(poll, 1000);
          } catch (e) {
            setAudioPrep({ idx, status: 'error', error: e.message });
            reject(e);
          }
        };
        poll();
      });
    } catch (e) {
      throw e;
    }
  }

  async function activateAudioTrack(idx) {
    setShowAudioMenu(false);
    if (idx === audioIdx && audioReady) return;

    // Preserve current playback position + play state for after the reload
    const v = videoRef.current;
    if (v) {
      pendingSeekRef.current = v.currentTime;
      wasPlayingRef.current = !v.paused;
    }

    const t = audioTracks[idx];
    // Track 0 + raw playable → instant switch, no remux, no prep needed
    if (idx === 0 && isTrackRawPlayable(t)) {
      cancelPollRef.current = true;
      setAudioPrep(null);
      setAudioReady(true);
      setAudioIdx(0);
      return;
    }

    setAudioIdx(idx);
    try {
      await runPrepareFlow(idx);
    } catch { /* error displayed in menu */ }
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
  const audioProgressPct = audioPrep && audioPrep.duration > 0
    ? Math.min(100, Math.round((audioPrep.progress / audioPrep.duration) * 100))
    : null;

  const showPrepOverlay = !audioReady && audioPrep?.status === 'running';
  const showErrorOverlay = audioPrep?.status === 'error';

  return (
    <div className="player-wrap">
      {effectiveSrc ? (
        <video
          ref={videoRef}
          src={effectiveSrc}
          controls={isHost}
          autoPlay={false}
          crossOrigin="anonymous"
          onLoadedMetadata={onLoadedMetadata}
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
          <div className="prep-title">Préparation de l'audio</div>
          <div className="prep-subtitle">
            {audioTracks[audioPrep.idx]?.label || `Piste ${audioPrep.idx}`}
          </div>
          <div className="prep-bar">
            <div className="prep-bar-fill" style={{ width: `${audioProgressPct ?? 0}%` }} />
          </div>
          <div className="prep-pct">{audioProgressPct != null ? `${audioProgressPct}%` : 'démarrage…'}</div>
        </div>
      )}

      {showErrorOverlay && !showPrepOverlay && (
        <div className="player-prep-overlay error">
          <AlertTriangle size={32} strokeWidth={1.75} />
          <div className="prep-title">Échec de préparation</div>
          <div className="prep-subtitle">{audioPrep.error}</div>
          <button className="primary" onClick={() => activateAudioTrack(0)}>Revenir à l'audio par défaut</button>
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
              {audioPrep?.status === 'running' && (
                <span className="overlay-progress">
                  <Loader2 size={12} className="spin" />
                  {audioProgressPct != null ? `${audioProgressPct}%` : '…'}
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
                    const prepActive = audioPrep?.idx === i && audioPrep?.status === 'running';
                    const needsRemux = !isTrackRawPlayable(t) || i !== 0;
                    return (
                      <button
                        key={i}
                        className={`overlay-item ${isActive ? 'active' : ''} ${prepActive ? 'loading' : ''}`}
                        onClick={() => activateAudioTrack(i)}
                        disabled={prepActive}
                      >
                        <span className="overlay-check">{isActive && <Check size={14} />}</span>
                        <span className="overlay-label">{t.label}</span>
                        {needsRemux && t.codec && (
                          <span className="overlay-tag" title={`${t.codec} → AAC remux`}>{t.codec.toUpperCase()}</span>
                        )}
                        {prepActive && (
                          <span className="overlay-progress-inline">
                            {audioProgressPct != null ? `${audioProgressPct}%` : '…'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {audioPrep?.status === 'error' && (
                    <div className="overlay-error">Erreur : {audioPrep.error}</div>
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
