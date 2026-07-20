import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Play, Pause, FolderOpen, Film, Library, Volume2, Rewind, FastForward, Maximize, Minimize, Captions } from 'lucide-react';
import CatalogueView from '../components/CatalogueView.jsx';
import SubtitleSearchModal from '../components/SubtitleSearchModal.jsx';

const BAR_H = 64; // control-bar height reserved at the bottom when controls show in fullscreen

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
  const [hasOSKey, setHasOSKey] = useState(false);
  const [streamBase, setStreamBase] = useState('');
  const [scanning, setScanning] = useState(false);
  const [playing, setPlaying] = useState(null); // { id, name, meta }
  const [error, setError] = useState(null);
  const [st, setSt] = useState({ position: 0, duration: 0, paused: false });
  const [scrub, setScrub] = useState(null);
  const [volume, setVolume] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSubSearch, setShowSubSearch] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const stageRef = useRef(null);
  const seekTarget = useRef(null);
  const uiTimer = useRef(null);
  const fsRef = useRef(false);
  const uiVisibleRef = useRef(true);
  const pokeRef = useRef(() => {});
  uiVisibleRef.current = uiVisible;

  // Show the controls + cursor, and (in fullscreen) auto-hide them after 2s idle.
  function poke() {
    setUiVisible(true);
    clearTimeout(uiTimer.current);
    if (fsRef.current) uiTimer.current = setTimeout(() => setUiVisible(false), 2000);
  }
  pokeRef.current = poke;
  useEffect(() => {
    fsRef.current = fullscreen;
    if (fullscreen) poke(); else { setUiVisible(true); clearTimeout(uiTimer.current); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  useEffect(() => {
    window.electronAPI.getConfig().then((c) => { setFolder(c?.scanFolder || null); setHasApiKey(!!c?.tmdbApiKey); setHasOSKey(!!c?.openSubtitlesApiKey); }).catch(() => {});
    window.electronAPI.getServerInfo().then((i) => setStreamBase(`http://localhost:${i.port}`)).catch(() => {});
    window.electronAPI.getCatalog().then(setCatalog).catch(() => {});
    const off = window.electronAPI.solo.onStatus((s) => {
      if (s.stopped) { setPlaying(null); setSt({ position: 0, duration: 0, paused: false }); return; }
      if (s.error) { setError(s.error); return; }
      if (s.fullscreen != null) setFullscreen(s.fullscreen);
      if (s.activity) pokeRef.current();
      setSt((prev) => ({ ...prev, ...s }));
    });
    return () => { off && off(); window.electronAPI.solo.stop(); };
  }, []);

  // Hide the native mpv window while the subtitle dialog is open (HTML can't
  // float over the native video surface), then bring it back.
  useEffect(() => {
    window.electronAPI.solo.setVisible(!showSubSearch);
  }, [showSubSearch]);

  // Clear the scrub value once mpv's real position catches up to the seek target
  // (stops the slider from snapping back visually right after a seek).
  useEffect(() => {
    if (seekTarget.current != null && st.position != null && Math.abs(st.position - seekTarget.current) < 1.2) {
      seekTarget.current = null; setScrub(null);
    }
  }, [st.position]);

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
    const iv = setInterval(send, 500);
    return () => { ro.disconnect(); window.removeEventListener('resize', send); clearInterval(iv); };
  }, [playing]);

  // In fullscreen the app's HTML bar can't float over the native video, so we
  // hand control to mpv's own floating OSC (shows on hover, hides itself, hides
  // the cursor). Windowed → OSC off, the app's bar is the UI. Also re-fit mpv
  // to the (now 100%) stage immediately on the transition.
  useEffect(() => {
    if (!playing) return;
    window.electronAPI.solo.osc(fullscreen ? 'auto' : 'never');
    if (stageRef.current) {
      const r = stageRef.current.getBoundingClientRect();
      window.electronAPI.solo.region({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
  }, [fullscreen, playing]);

  // Esc exits fullscreen.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && fullscreen) toggleFullscreen(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

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
    setPlaying({ id: film.id, name: film.title, meta: film.meta });
  }
  function backToLibrary() { if (fullscreen) toggleFullscreen(); window.electronAPI.solo.stop(); setPlaying(null); }
  async function toggleFullscreen() { const v = await window.electronAPI.solo.fullscreen(); setFullscreen(!!v); }
  function seekTo(v) { window.electronAPI.solo.seek(v); setScrub(v); seekTarget.current = v; }

  const pos = scrub != null ? scrub : (st.position || 0);
  const dur = st.duration || 0;
  const hasFilms = (catalog.stream?.length || 0) > 0;

  return (
    <div className={`app solo-app ${fullscreen ? 'solo-fs' : ''} ${fullscreen && !uiVisible ? 'solo-idle' : ''}`} onMouseMove={poke}>
      {!fullscreen && (
        <div className="solo-topbar">
          <button className="icon-btn" onClick={playing ? backToLibrary : onLeave} title={playing ? 'Retour à la bibliothèque' : 'Retour à l\'accueil'}>
            <ChevronLeft size={18} strokeWidth={1.75} />
          </button>
          <div className="brand">Garen<span className="brand-accent">Movies</span> · Solo{playing ? ' · lecture' : ''}</div>
          <div style={{ width: 36 }} />
        </div>
      )}

      {playing ? (
        <div className="solo-player-view">
          <div className="solo-stage" ref={stageRef} />
          {!fullscreen && (
          <div className="solo-playbar">
            {!fullscreen && (
              <div className="solo-nowplaying">
                <Film size={14} strokeWidth={1.75} />
                <span className="solo-file" title={playing.name}>{playing.name}</span>
              </div>
            )}
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
            <button className="solo-mini" onClick={() => setShowSubSearch(true)} title="Sous-titres">
              <Captions size={15} strokeWidth={2} />
            </button>
            <button className="solo-mini" onClick={toggleFullscreen} title={fullscreen ? 'Quitter le plein écran' : 'Plein écran'}>
              {fullscreen ? <Minimize size={15} strokeWidth={2} /> : <Maximize size={15} strokeWidth={2} />}
            </button>
            <button className="solo-mini" onClick={backToLibrary} title="Bibliothèque">
              <Library size={15} strokeWidth={2} />
            </button>
          </div>
          )}

          {showSubSearch && (
            <SubtitleSearchModal
              streamBase={streamBase}
              mediaId={playing.id}
              mediaTitle={playing.name}
              mediaMeta={playing.meta}
              defaultLang="fr"
              hasOpenSubtitlesKey={hasOSKey}
              onClose={() => setShowSubSearch(false)}
              onOpenSettings={() => {}}
              onDownloaded={(newSub) => { if (newSub?.idx != null) window.electronAPI.solo.loadSubtitle(playing.id, newSub.idx); }}
            />
          )}
        </div>
      ) : (hasFilms || folder) ? (
        <div className="solo-main">
          <CatalogueView
            catalog={catalog} activeId={null} onSelect={playFilm} canSelect={true} connected={true}
            hasApiKey={hasApiKey} isHost={true} onRescan={rescan} onPickFolder={pickFolder} scanning={scanning}
            hideServerSection={true} streamTitle="Bibliothèque" onOpenSettings={() => {}}
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
