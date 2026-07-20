import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Play, Pause, FolderOpen, Film, Library, Volume2 } from 'lucide-react';
import CatalogueView from '../components/CatalogueView.jsx';

function fmt(t) {
  if (t == null || isNaN(t)) return '0:00';
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

export default function Solo({ onLeave }) {
  const [catalog, setCatalog] = useState({ catalogue: [], stream: [] });
  const [folder, setFolder] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [playing, setPlaying] = useState(null); // { id, name }
  const [error, setError] = useState(null);
  const [st, setSt] = useState({ position: 0, duration: 0, paused: false });
  const [scrub, setScrub] = useState(null);
  const [volume, setVolume] = useState(100);
  const stageRef = useRef(null);

  useEffect(() => {
    window.electronAPI.getConfig().then((c) => { setFolder(c?.scanFolder || null); setHasApiKey(!!c?.tmdbApiKey); }).catch(() => {});
    window.electronAPI.getCatalog().then(setCatalog).catch(() => {});
    const off = window.electronAPI.solo.onStatus((s) => {
      if (s.stopped) { setPlaying(null); setSt({ position: 0, duration: 0, paused: false }); return; }
      if (s.error) { setError(s.error); return; }
      setSt((prev) => ({ ...prev, ...s }));
    });
    return () => { off && off(); window.electronAPI.solo.stop(); };
  }, []);

  // Keep the embedded mpv window glued to the on-screen video stage.
  useEffect(() => {
    if (!playing || !stageRef.current) return;
    const el = stageRef.current;
    const send = () => {
      const r = el.getBoundingClientRect();
      window.electronAPI.solo.region({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    const iv = setInterval(send, 500); // follow window moves (no move event in the renderer)
    return () => { ro.disconnect(); window.removeEventListener('resize', send); clearInterval(iv); };
  }, [playing]);

  async function reload() { try { setCatalog(await window.electronAPI.getCatalog()); } catch {} }
  async function pickFolder() {
    const f = await window.electronAPI.pickFolder();
    if (!f) return;
    setFolder(f); setScanning(true);
    try { await window.electronAPI.scanFolder(f); await reload(); } finally { setScanning(false); }
  }
  async function rescan() {
    if (!folder) return;
    setScanning(true);
    try { await window.electronAPI.rescan(); await reload(); } finally { setScanning(false); }
  }
  async function playFilm(film) {
    const path = film?.source?.path;
    if (!path) return;
    setError(null);
    const res = await window.electronAPI.solo.open(path);
    if (res?.error) { setError(res.error); return; }
    setPlaying({ id: film.id, name: film.title });
  }
  function backToLibrary() { window.electronAPI.solo.stop(); setPlaying(null); }

  const pos = scrub != null ? scrub : (st.position || 0);
  const dur = st.duration || 0;
  const hasFilms = (catalog.stream?.length || 0) > 0;

  return (
    <div className="app solo-app">
      <div className="solo-topbar">
        <button className="icon-btn" onClick={playing ? backToLibrary : onLeave} title={playing ? 'Retour à la bibliothèque' : 'Retour à l\'accueil'}>
          <ChevronLeft size={18} strokeWidth={1.75} />
        </button>
        <div className="brand">Garen<span className="brand-accent">Movies</span> · Solo{playing ? ' · lecture' : ''}</div>
        <div style={{ width: 36 }} />
      </div>

      {playing ? (
        <div className="solo-player-view">
          <div className="solo-stage" ref={stageRef} />
          <div className="solo-playbar">
            <div className="solo-nowplaying">
              <Film size={14} strokeWidth={1.75} />
              <span className="solo-file" title={playing.name}>{playing.name}</span>
            </div>
            <button className="solo-play" onClick={() => window.electronAPI.solo.toggle()}>
              {st.paused ? <Play size={18} strokeWidth={2} fill="currentColor" /> : <Pause size={18} strokeWidth={2} fill="currentColor" />}
            </button>
            <span className="solo-time">{fmt(pos)}</span>
            <input
              className="solo-seek"
              type="range" min={0} max={Math.max(dur, 0.1)} step={0.1} value={Math.min(pos, dur || pos)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onMouseUp={(e) => { window.electronAPI.solo.seek(Number(e.target.value)); setScrub(null); }}
            />
            <span className="solo-time">{fmt(dur)}</span>
            <Volume2 size={15} strokeWidth={1.75} className="solo-vol-icon" />
            <input
              className="solo-vol" type="range" min={0} max={130} step={1} value={volume}
              onChange={(e) => { const v = Number(e.target.value); setVolume(v); window.electronAPI.solo.volume(v); }}
              title="Volume"
            />
            <button className="solo-stop" onClick={backToLibrary} title="Bibliothèque">
              <Library size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : (hasFilms || folder) ? (
        <div className="solo-main">
          <CatalogueView
            catalog={catalog}
            activeId={null}
            onSelect={playFilm}
            canSelect={true}
            connected={true}
            hasApiKey={hasApiKey}
            isHost={true}
            onRescan={rescan}
            onPickFolder={pickFolder}
            scanning={scanning}
            hideServerSection={true}
            streamTitle="Bibliothèque"
            onOpenSettings={() => {}}
          />
        </div>
      ) : (
        <div className="solo-main">
          <div className="solo-empty">
            <div className="solo-empty-icon"><Film size={40} strokeWidth={1.25} /></div>
            <h2>Regarder un film en solo</h2>
            <p>Lecture native instantanée (tous les formats, HEVC inclus), sans transcodage ni salon. Choisis le dossier où sont tes films.</p>
            <button className="primary" onClick={pickFolder} disabled={scanning}>
              <FolderOpen size={15} strokeWidth={2} />
              {scanning ? 'Analyse…' : 'Choisir le dossier de films'}
            </button>
            {error && <div className="error">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
