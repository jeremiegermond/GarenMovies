import { useEffect, useRef, useState } from 'react';
import { Captions, Loader2, Check, Volume2 } from 'lucide-react';

const SYNC_THRESHOLD = 1.0;

function buildStreamUrl(baseUrl, audioIdx) {
  if (!baseUrl) return null;
  if (audioIdx == null || audioIdx === 0) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}audio=${audioIdx}`;
}

export default function Player({ src, isHost, syncState, onHostStateChange, subs = [], audioTracks = [], streamBase, mediaId }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const wasPlayingRef = useRef(false);

  const [showSubMenu, setShowSubMenu] = useState(false);
  const [activeSubIdx, setActiveSubIdx] = useState(-1);
  const [loadingSubIdx, setLoadingSubIdx] = useState(-1);

  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [audioIdx, setAudioIdx] = useState(0);
  const [audioPrep, setAudioPrep] = useState(null); // { idx, progress, duration, status, error }

  const effectiveSrc = buildStreamUrl(src, audioIdx);

  // Reset on media change
  useEffect(() => {
    setActiveSubIdx(-1);
    setLoadingSubIdx(-1);
    setShowSubMenu(false);
    setShowAudioMenu(false);
    setAudioIdx(0);
    setAudioPrep(null);
    pendingSeekRef.current = null;
  }, [mediaId]);

  // Apply selected subtitle
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = (i === activeSubIdx) ? 'showing' : 'hidden';
      }
    };
    apply();
    const t = setTimeout(apply, 150);
    return () => clearTimeout(t);
  }, [activeSubIdx, subs.length, mediaId]);

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

  // After src change (audio switch), seek + restore play state
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

  async function activateAudioTrack(idx) {
    setShowAudioMenu(false);
    if (idx === audioIdx) return;

    // Preserve current playback position + play state
    const v = videoRef.current;
    if (v) {
      pendingSeekRef.current = v.currentTime;
      wasPlayingRef.current = !v.paused;
    }

    if (idx === 0) {
      // Default audio — instant switch (raw file, full range support)
      setAudioPrep(null);
      setAudioIdx(0);
      return;
    }

    // Alternate audio — kick off remux + poll until ready
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
        setAudioIdx(idx);
        return;
      }
      // Poll
      let cancelled = false;
      const poll = async () => {
        if (cancelled) return;
        try {
          const sr = await fetch(`${streamBase}/api/audio/status/${mediaId}/${idx}`);
          const data = await sr.json();
          if (data.status === 'ready') {
            setAudioPrep(null);
            setAudioIdx(idx);
            return;
          }
          if (data.status === 'error') {
            setAudioPrep({ idx, status: 'error', error: data.error || 'Erreur' });
            return;
          }
          setAudioPrep({ idx, status: 'running', progress: data.progress || 0, duration: data.duration || 0 });
          setTimeout(poll, 1000);
        } catch (e) {
          setAudioPrep({ idx, status: 'error', error: e.message });
        }
      };
      poll();
    } catch (e) {
      setAudioPrep({ idx, status: 'error', error: e.message });
    }
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

  return (
    <div className="player-wrap">
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
          />
        ))}
      </video>

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
                    return (
                      <button
                        key={i}
                        className={`overlay-item ${isActive ? 'active' : ''} ${prepActive ? 'loading' : ''}`}
                        onClick={() => activateAudioTrack(i)}
                        disabled={prepActive}
                      >
                        <span className="overlay-check">{isActive && <Check size={14} />}</span>
                        <span className="overlay-label">{t.label}</span>
                        {i === 0 && <span className="overlay-tag">défaut</span>}
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
                    Changer de piste relit la vidéo après remux (1ʳᵉ fois ~30 s à quelques minutes selon la taille)
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
