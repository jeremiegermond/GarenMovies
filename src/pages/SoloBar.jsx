import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, Rewind, FastForward, Minimize, SkipForward } from 'lucide-react';

const SKIP_LABEL = { intro: "Passer l'intro", next: 'Épisode suivant', credits: 'Passer le générique' };

function fmt(t) {
  if (t == null || isNaN(t)) return '0:00';
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

// Runs in its own frameless window, floated over the mpv video in fullscreen.
export default function SoloBar() {
  const [st, setSt] = useState({ position: 0, duration: 0, paused: false });
  const [scrub, setScrub] = useState(null);
  const [volume, setVolume] = useState(100);
  const [skipHint, setSkipHint] = useState(null); // 'intro' | 'next' | 'credits' — set by the solo page
  const seekTarget = useRef(null);

  useEffect(() => {
    const off = window.electronAPI.solo.onStatus((s) => {
      if ('skipHint' in s) { setSkipHint(s.skipHint); return; }
      if (s.position == null && s.duration == null && s.paused == null) return;
      setSt((prev) => ({ ...prev, ...s }));
    });
    return () => { off && off(); };
  }, []);

  // Esc exits fullscreen even when this bar window holds focus.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') window.electronAPI.solo.fullscreen(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Stop the slider snapping back right after a seek (wait for mpv to catch up).
  useEffect(() => {
    if (seekTarget.current != null && st.position != null && Math.abs(st.position - seekTarget.current) < 1.2) {
      seekTarget.current = null; setScrub(null);
    }
  }, [st.position]);

  function seekTo(v) { window.electronAPI.solo.seek(v); setScrub(v); seekTarget.current = v; }
  const keep = (v) => window.electronAPI.solo.barKeepAlive(v);

  const pos = scrub != null ? scrub : (st.position || 0);
  const dur = st.duration || 0;

  return (
    <div className="solobar-win" onMouseEnter={() => keep(true)} onMouseLeave={() => keep(false)}>
      <button className="solo-mini" onClick={() => window.electronAPI.solo.seekRel(-10)} title="Reculer de 10 s">
        <Rewind size={15} strokeWidth={2} />
      </button>
      <button className="solo-play" onClick={() => window.electronAPI.solo.toggle()}>
        {st.paused ? <Play size={18} strokeWidth={2} fill="currentColor" /> : <Pause size={18} strokeWidth={2} fill="currentColor" />}
      </button>
      <button className="solo-mini" onClick={() => window.electronAPI.solo.seekRel(10)} title="Avancer de 10 s">
        <FastForward size={15} strokeWidth={2} />
      </button>
      <span className="solo-time">{fmt(pos)}</span>
      <input
        className="solo-seek"
        type="range" min={0} max={Math.max(dur, 0.1)} step={0.1} value={Math.min(pos, dur || pos)}
        onChange={(e) => setScrub(Number(e.target.value))}
        onMouseUp={(e) => seekTo(Number(e.target.value))}
      />
      <span className="solo-time">{fmt(dur)}</span>
      <Volume2 size={15} strokeWidth={1.75} className="solo-vol-icon" />
      <input className="solo-vol" type="range" min={0} max={130} step={1} value={volume}
        onChange={(e) => { const v = Number(e.target.value); setVolume(v); window.electronAPI.solo.volume(v); }} title="Volume" />
      {skipHint && (
        <button className="solo-skip primary" onClick={() => window.electronAPI.solo.skipAction()}>
          <SkipForward size={14} strokeWidth={2} /> {SKIP_LABEL[skipHint]}
        </button>
      )}
      <button className="solo-mini" onClick={() => window.electronAPI.solo.fullscreen()} title="Quitter le plein écran">
        <Minimize size={15} strokeWidth={2} />
      </button>
    </div>
  );
}
