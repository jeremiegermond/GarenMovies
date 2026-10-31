import { Play, RotateCcw, X, ArrowRight } from 'lucide-react';
import { episodeInfo } from '../lib/episodes.js';
import { displayTitle } from '../lib/titles.js';
import { formatTime } from '../lib/resume.js';

const epCode = (m) => {
  const i = episodeInfo(m);
  return i ? `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : displayTitle(m);
};

// Shown when a film / episode is opened that was left halfway, or when another
// episode of the show is where we actually were (wrong episode clicked).
export default function ResumeOverlay({ media, offer, onResume, onRestart, onGoTo, onClose }) {
  if (!media || !offer) return null;
  const { here, elsewhere } = offer;
  const poster = (elsewhere && !here ? elsewhere.media : media).meta?.poster;
  const other = elsewhere?.media;
  const otherTitle = other?.meta?.episodeTitle;
  return (
    <div className="nextup resume-overlay">
      <div className="nextup-card">
        {poster && <img className="nextup-poster" src={poster} alt="" />}
        <div className="nextup-body">
          {here != null ? (
            <>
              <div className="nextup-eyebrow">Tu t'étais arrêté à {formatTime(here)}</div>
              <div className="nextup-show" title={displayTitle(media)}>{displayTitle(media)}</div>
              {media.meta?.episodeTitle && <div className="nextup-ep">{media.meta.episodeTitle}</div>}
            </>
          ) : (
            <>
              <div className="nextup-eyebrow">Tu n'en étais pas là</div>
              <div className="nextup-show">{elsewhere.pos != null ? `Tu regardais ${epCode(other)}` : `Prochain épisode : ${epCode(other)}`}</div>
              <div className="nextup-ep">
                {otherTitle ? `${otherTitle}${elsewhere.pos != null ? ` · arrêté à ${formatTime(elsewhere.pos)}` : ''}` : (elsewhere.pos != null ? `Arrêté à ${formatTime(elsewhere.pos)}` : '')}
              </div>
            </>
          )}
          {here != null && offer.dur > 0 && (
            <div className="nextup-bar"><div className="nextup-bar-fill" style={{ width: `${(here / offer.dur) * 100}%` }} /></div>
          )}
          <div className="nextup-actions">
            {here != null ? (
              <>
                <button className="primary" onClick={onResume}>
                  <Play size={14} strokeWidth={2} fill="currentColor" /> Reprendre
                </button>
                <button onClick={onRestart}>
                  <RotateCcw size={14} strokeWidth={2} /> Depuis le début
                </button>
              </>
            ) : (
              <>
                <button className="primary" onClick={onGoTo}>
                  <ArrowRight size={14} strokeWidth={2} /> {elsewhere.pos != null ? `Reprendre ${epCode(other)}` : `Aller à ${epCode(other)}`}
                </button>
                <button onClick={onClose}>Rester ici</button>
              </>
            )}
            {here != null && other && (
              <button className="ghost" onClick={onGoTo} title={otherTitle || undefined}>
                {elsewhere.pos != null ? `Ou reprendre ${epCode(other)}` : `Ou ${epCode(other)}`}
              </button>
            )}
          </div>
        </div>
        <button className="icon-btn resume-close" onClick={onClose} title="Fermer">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
