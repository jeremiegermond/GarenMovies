import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Play, Pause, Square, FolderOpen, Film, Share2, Monitor } from 'lucide-react';

function fmt(t) {
  if (t == null || isNaN(t)) return '0:00';
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

export default function Solo({ onLeave }) {
  const [fileName, setFileName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [st, setSt] = useState({ position: 0, duration: 0, paused: false });
  const [scrub, setScrub] = useState(null); // while dragging the seek bar
  const scrubbing = useRef(false);

  useEffect(() => {
    if (!window.electronAPI?.solo) return;
    const off = window.electronAPI.solo.onStatus((s) => {
      if (s.stopped) { setFileName(null); setSt({ position: 0, duration: 0, paused: false }); return; }
      if (s.error) { setError(s.error); return; }
      setSt((prev) => ({ ...prev, ...s }));
    });
    // Stop mpv when leaving solo mode.
    return () => { off && off(); window.electronAPI.solo.stop(); };
  }, []);

  async function pickAndOpen() {
    setError(null);
    const filePath = await window.electronAPI.solo.pick();
    if (!filePath) return;
    setLoading(true);
    const res = await window.electronAPI.solo.open(filePath);
    setLoading(false);
    if (res?.error) { setError(res.error); return; }
    setFileName(filePath.split(/[\\/]/).pop());
  }

  const pos = scrub != null ? scrub : (st.position || 0);
  const dur = st.duration || 0;

  return (
    <div className="app solo-app">
      <div className="solo-topbar">
        <button className="icon-btn" onClick={onLeave} title="Retour à l'accueil">
          <ChevronLeft size={18} strokeWidth={1.75} />
        </button>
        <div className="brand">Garen<span className="brand-accent">Movies</span> · Solo</div>
        <div style={{ width: 36 }} />
      </div>

      <div className="solo-body">
        {!fileName ? (
          <div className="solo-empty">
            <div className="solo-empty-icon"><Film size={40} strokeWidth={1.25} /></div>
            <h2>Regarder un film en solo</h2>
            <p>Lecture native instantanée (tous les formats, HEVC inclus), sans transcodage ni salon.</p>
            <button className="primary" onClick={pickAndOpen} disabled={loading}>
              <FolderOpen size={15} strokeWidth={2} />
              {loading ? 'Ouverture…' : 'Choisir un film'}
            </button>
            {error && <div className="error">{error}</div>}
          </div>
        ) : (
          <div className="solo-player">
            <div className="solo-window-hint">
              <Monitor size={14} strokeWidth={1.75} />
              La vidéo joue dans une fenêtre dédiée (mpv). Utilise les contrôles ci-dessous.
            </div>
            <div className="solo-nowplaying">
              <Film size={16} strokeWidth={1.75} />
              <span className="solo-file" title={fileName}>{fileName}</span>
            </div>

            <div className="solo-controls">
              <button className="solo-play" onClick={() => window.electronAPI.solo.toggle()}>
                {st.paused ? <Play size={18} strokeWidth={2} fill="currentColor" /> : <Pause size={18} strokeWidth={2} fill="currentColor" />}
              </button>
              <span className="solo-time">{fmt(pos)}</span>
              <input
                className="solo-seek"
                type="range" min={0} max={Math.max(dur, 0.1)} step={0.1} value={Math.min(pos, dur || pos)}
                onMouseDown={() => { scrubbing.current = true; }}
                onChange={(e) => setScrub(Number(e.target.value))}
                onMouseUp={(e) => { scrubbing.current = false; window.electronAPI.solo.seek(Number(e.target.value)); setScrub(null); }}
              />
              <span className="solo-time">{fmt(dur)}</span>
              <button className="solo-stop" onClick={() => { window.electronAPI.solo.stop(); }} title="Arrêter">
                <Square size={15} strokeWidth={2} fill="currentColor" />
              </button>
            </div>

            <div className="solo-actions">
              <button onClick={pickAndOpen}><FolderOpen size={14} strokeWidth={2} /> Changer de film</button>
              <button className="solo-share" disabled title="Bientôt : inviter des amis en plein film">
                <Share2 size={14} strokeWidth={2} /> Passer en mode partagé (bientôt)
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
