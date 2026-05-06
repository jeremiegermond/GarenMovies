import { useEffect, useRef } from 'react';

const SYNC_THRESHOLD = 1.0;

export default function Player({ src, isHost, syncState, onHostStateChange, subs = [], streamBase, mediaId }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false);

  useEffect(() => {
    if (isHost) return;
    const v = videoRef.current;
    if (!v || !syncState || syncState.mediaId == null) return;

    suppressRef.current = true;
    const drift = Math.abs(v.currentTime - syncState.currentTime);
    if (drift > SYNC_THRESHOLD) {
      try { v.currentTime = syncState.currentTime; } catch {}
    }
    if (syncState.paused && !v.paused) {
      v.pause();
    } else if (!syncState.paused && v.paused) {
      v.play().catch(() => {});
    }
    setTimeout(() => { suppressRef.current = false; }, 50);
  }, [syncState, isHost]);

  function emitState(extra = {}) {
    if (!isHost || !onHostStateChange) return;
    const v = videoRef.current;
    if (!v) return;
    onHostStateChange({
      paused: v.paused,
      currentTime: v.currentTime,
      ...extra
    });
  }

  if (!src) {
    return (
      <div className="player-wrap">
        <div className="player-empty">
          {isHost
            ? 'Choisis un film dans le Catalogue pour commencer'
            : 'En attente du choix de l\'hôte…'}
        </div>
      </div>
    );
  }

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
        {subs.map((s, i) => (
          <track
            key={`${mediaId}-${s.idx}`}
            kind="subtitles"
            src={`${streamBase}/api/subs/${mediaId}/${s.idx}.vtt`}
            srcLang={s.lang === 'und' ? undefined : s.lang}
            label={s.label}
            default={i === 0}
          />
        ))}
      </video>
    </div>
  );
}
