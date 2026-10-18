import { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { episodeInfo } from '../lib/episodes.js';

// "Next episode in 5s" card shown when an episode ends. Counts down and calls
// onPlay at zero; the viewer can start it right away or cancel.
//   variant 'corner' → small card over the last frame (web player)
//   variant 'center' → full end screen (solo: the native mpv video is hidden)
export default function NextUpOverlay({ next, seconds = 5, onPlay, onCancel, variant = 'corner' }) {
  const [left, setLeft] = useState(seconds);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;

  useEffect(() => {
    const started = Date.now();
    let fired = false;
    setLeft(seconds);
    const iv = setInterval(() => {
      const remain = Math.max(0, seconds - (Date.now() - started) / 1000);
      setLeft(remain);
      if (remain <= 0 && !fired) {
        fired = true;
        clearInterval(iv);
        onPlayRef.current?.();
      }
    }, 100);
    return () => clearInterval(iv);
  }, [next?.id, seconds]);

  if (!next) return null;
  const info = episodeInfo(next);
  const show = next.meta?.showName || info?.showName || next.title;
  const epLabel = info ? `Saison ${info.season} · Épisode ${info.episode}` : null;
  const epTitle = next.meta?.episodeTitle;
  const poster = next.meta?.poster;

  return (
    <div className={`nextup nextup-${variant}`}>
      {variant === 'center' && poster && <div className="nextup-backdrop" style={{ backgroundImage: `url(${poster})` }} />}
      <div className="nextup-card">
        {poster && <img className="nextup-poster" src={poster} alt="" />}
        <div className="nextup-body">
          <div className="nextup-eyebrow">Épisode suivant dans {Math.ceil(left)} s</div>
          <div className="nextup-show" title={show}>{show}</div>
          {epLabel && <div className="nextup-ep">{epLabel}{epTitle ? ` — ${epTitle}` : ''}</div>}
          <div className="nextup-bar"><div className="nextup-bar-fill" style={{ width: `${(1 - left / seconds) * 100}%` }} /></div>
          <div className="nextup-actions">
            <button className="primary" onClick={() => onPlayRef.current?.()}>
              <Play size={14} strokeWidth={2} fill="currentColor" /> Lire maintenant
            </button>
            <button onClick={onCancel}>
              <X size={14} strokeWidth={2} /> Annuler
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
