import { useEffect, useRef, useState } from 'react';
import { Captions, Loader2, Check } from 'lucide-react';

const SYNC_THRESHOLD = 1.0;

export default function Player({ src, isHost, syncState, onHostStateChange, subs = [], streamBase, mediaId }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);
  const [showSubMenu, setShowSubMenu] = useState(false);
  const [activeSubIdx, setActiveSubIdx] = useState(-1);
  const [loadingSubIdx, setLoadingSubIdx] = useState(-1);

  useEffect(() => {
    setActiveSubIdx(-1);
    setLoadingSubIdx(-1);
    setShowSubMenu(false);
  }, [mediaId]);

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

  if (!src) {
    return (
      <div className="player-wrap">
        <div className="player-empty">
          {isHost ? 'Choisissez un film dans la bibliothèque pour commencer' : 'En attente du choix de l\'hôte'}
        </div>
      </div>
    );
  }

  const activeLabel = activeSubIdx >= 0 ? subs[activeSubIdx]?.label : null;

  return (
    <div className="player-wrap">
      <video
        ref={videoRef}
        src={src}
        controls={isHost}
        autoPlay={false}
        crossOrigin="anonymous"
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

      <div className="sub-controls">
        <button
          className={`sub-toggle ${activeSubIdx >= 0 ? 'on' : ''}`}
          onClick={() => setShowSubMenu((o) => !o)}
          title="Sous-titres"
        >
          <Captions size={16} strokeWidth={2} />
          <span className="sub-toggle-label">
            {activeLabel || 'Sous-titres'}
          </span>
          {loadingSubIdx >= 0 && <Loader2 size={14} className="spin" />}
        </button>
        {showSubMenu && (
          <>
            <div className="sub-menu-backdrop" onClick={() => setShowSubMenu(false)} />
            <div className="sub-menu">
              <div className="sub-menu-title">Sous-titres</div>
              <button
                className={`sub-item ${activeSubIdx === -1 ? 'active' : ''}`}
                onClick={() => activateSubtitle(-1)}
              >
                <span className="sub-check">{activeSubIdx === -1 && <Check size={14} />}</span>
                <span className="sub-label">Désactivés</span>
              </button>
              {subs.length === 0 ? (
                <div className="sub-empty">
                  Aucun sous-titre détecté pour ce fichier
                </div>
              ) : (
                subs.map((s, i) => (
                  <button
                    key={i}
                    className={`sub-item ${activeSubIdx === i ? 'active' : ''} ${loadingSubIdx === i ? 'loading' : ''}`}
                    onClick={() => activateSubtitle(i)}
                    disabled={loadingSubIdx === i}
                  >
                    <span className="sub-check">{activeSubIdx === i && <Check size={14} />}</span>
                    <span className="sub-label">{s.label}</span>
                    {s.embedded && <span className="sub-tag">intégrés</span>}
                    {loadingSubIdx === i && <Loader2 size={12} className="spin" />}
                  </button>
                ))
              )}
              {subs.some((s) => s.embedded) && (
                <div className="sub-hint">Le premier chargement peut prendre quelques secondes</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
