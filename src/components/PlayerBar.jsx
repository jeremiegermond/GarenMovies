import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Rewind, FastForward, Volume2, Volume1, VolumeX } from 'lucide-react';

const VOLUME_KEY = 'garenmovies-volume';
const PREVIEW_W = 192; // px width of the hover thumbnail

function fmt(t) {
  if (t == null || !Number.isFinite(t)) return '0:00';
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

// The player's own control bar (replaces Chromium's native controls so the seek
// bar can show Netflix-style hover previews and the intro / credits zones).
// The host controls playback; guests follow the host, so for them the bar only
// shows progress and offers their own volume.
export default function PlayerBar({ video, isHost, markers, trickplay, trickBase }) {
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });
  const [muted, setMuted] = useState(false);
  const [hover, setHover] = useState(null); // { x, t } over the seek bar
  const [drag, setDrag] = useState(null);   // time being scrubbed to (host)
  const trackRef = useRef(null);

  // Mirror the <video> element's state.
  useEffect(() => {
    if (!video) return;
    const duration = () => (Number.isFinite(video.duration) ? video.duration
      : video.seekable?.length ? video.seekable.end(video.seekable.length - 1) : 0);
    const sync = () => {
      setT(video.currentTime || 0);
      setDur(duration());
      setPaused(video.paused);
      const b = video.buffered;
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i));
      setBuffered(end);
    };
    const onVol = () => { setMuted(video.muted); };
    video.volume = volume;
    const evs = ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'progress', 'seeking', 'seeked'];
    evs.forEach((e) => video.addEventListener(e, sync));
    video.addEventListener('volumechange', onVol);
    sync();
    return () => { evs.forEach((e) => video.removeEventListener(e, sync)); video.removeEventListener('volumechange', onVol); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  // Warm the browser cache with every ready sheet, so hovering never flickers.
  useEffect(() => {
    if (!trickplay?.sheets || !trickBase) return;
    for (let n = 1; n <= trickplay.sheets; n++) { const img = new Image(); img.src = `${trickBase}/${n}.jpg`; }
  }, [trickplay?.sheets, trickBase]);

  const pct = (s) => (dur > 0 ? `${Math.min(100, Math.max(0, (s / dur) * 100))}%` : '0%');
  const timeAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || !dur) return null;
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    return { x, t: (x / r.width) * dur, width: r.width };
  };

  function onPointerMove(e) {
    const h = timeAt(e.clientX);
    if (!h) return;
    setHover(h);
    if (drag != null) setDrag(h.t);
  }
  function onPointerDown(e) {
    if (!isHost) return;
    const h = timeAt(e.clientX);
    if (!h) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(h.t);
  }
  function onPointerUp() {
    if (drag == null) return;
    if (video) video.currentTime = drag;
    setT(drag);
    setDrag(null);
  }

  function togglePlay() { if (!video) return; if (video.paused) video.play().catch(() => {}); else video.pause(); }
  function skip(d) { if (video) video.currentTime = Math.min(Math.max(0, video.currentTime + d), dur || Infinity); }
  function changeVolume(v) {
    setVolume(v);
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {}
    if (video) { video.volume = v; if (v > 0 && video.muted) video.muted = false; }
  }
  function toggleMute() { if (video) video.muted = !video.muted; }

  // Hover preview: which thumbnail of which sheet covers the hovered time.
  let preview = null;
  if (hover && isHost) {
    const shownT = drag ?? hover.t;
    let img = null;
    const tp = trickplay;
    if (tp?.sheets && tp.thumbW) {
      const k = Math.floor(shownT / tp.interval);
      const per = tp.cols * tp.rows;
      const sheet = Math.floor(k / per);
      if (sheet < tp.sheets) {
        const pos = k % per, col = pos % tp.cols, row = Math.floor(pos / tp.cols);
        const s = PREVIEW_W / tp.thumbW;
        img = {
          width: PREVIEW_W, height: Math.round(tp.thumbH * s),
          backgroundImage: `url(${trickBase}/${sheet + 1}.jpg)`,
          backgroundSize: `${tp.cols * tp.thumbW * s}px ${tp.rows * tp.thumbH * s}px`,
          backgroundPosition: `-${col * tp.thumbW * s}px -${row * tp.thumbH * s}px`
        };
      }
    }
    const inIntro = markers?.intro && shownT >= markers.intro.start && shownT < markers.intro.end;
    const inCredits = markers?.credits && shownT >= markers.credits.start;
    const half = (img ? PREVIEW_W : 60) / 2;
    const x = Math.min(Math.max(hover.x, half), hover.width - half);
    preview = { img, x, time: fmt(shownT), label: inIntro ? 'Générique' : inCredits ? 'Générique de fin' : null };
  }

  const shown = drag ?? t;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="player-bar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div
        className={`pb-seek ${isHost ? 'interactive' : ''}`}
        ref={trackRef}
        onPointerMove={onPointerMove}
        onPointerLeave={() => { if (drag == null) setHover(null); }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <div className="pb-track">
          {markers?.intro && (
            <div className="pb-zone" style={{ left: pct(markers.intro.start), width: pct(markers.intro.end - markers.intro.start) }} />
          )}
          {markers?.credits && dur > 0 && (
            <div className="pb-zone" style={{ left: pct(markers.credits.start), width: pct(dur - markers.credits.start) }} />
          )}
          <div className="pb-buffered" style={{ width: pct(buffered) }} />
          <div className="pb-played" style={{ width: pct(shown) }} />
          {hover && isHost && <div className="pb-hoverline" style={{ left: hover.x }} />}
        </div>
        <div className="pb-knob" style={{ left: pct(shown) }} />
        {preview && (
          <div className="pb-preview" style={{ left: preview.x }}>
            {preview.img && <div className="pb-preview-img" style={preview.img} />}
            <div className="pb-preview-time">
              {preview.time}
              {preview.label && <span>{preview.label}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="pb-row">
        {isHost && (
          <>
            <button className="pb-btn pb-play" onClick={togglePlay} title={paused ? 'Lecture (espace)' : 'Pause (espace)'}>
              {paused ? <Play size={18} strokeWidth={2} fill="currentColor" /> : <Pause size={18} strokeWidth={2} fill="currentColor" />}
            </button>
            <button className="pb-btn" onClick={() => skip(-10)} title="Reculer de 10 s (←)"><Rewind size={16} strokeWidth={2} /></button>
            <button className="pb-btn" onClick={() => skip(10)} title="Avancer de 10 s (→)"><FastForward size={16} strokeWidth={2} /></button>
          </>
        )}
        <div className="pb-volume">
          <button className="pb-btn" onClick={toggleMute} title={muted ? 'Réactiver le son (m)' : 'Couper le son (m)'}><VolIcon size={16} strokeWidth={2} /></button>
          <input
            type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            title="Volume"
          />
        </div>
        <span className="pb-time">{fmt(shown)} <span>/ {fmt(dur)}</span></span>
      </div>
    </div>
  );
}
