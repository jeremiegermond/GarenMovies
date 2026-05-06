import { useEffect, useRef } from 'react';

const SYNC_THRESHOLD = 1.0; // seconds — re-seek client if drift exceeds this

export default function Player({ src, isHost, syncState, onHostStateChange }) {
  const videoRef = useRef(null);
  const suppressRef = useRef(false); // ignore programmatic-triggered events

  // Client: apply incoming sync state to local video
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

  // Host: forward local events to server
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
          {isHost ? 'Choisis un film dans le catalogue à gauche' : 'En attente du choix de l\'hôte…'}
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
        onPlay={() => !suppressRef.current && emitState({ paused: false })}
        onPause={() => !suppressRef.current && emitState({ paused: true })}
        onSeeked={() => !suppressRef.current && emitState()}
      />
    </div>
  );
}
