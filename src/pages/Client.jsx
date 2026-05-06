import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Catalog from '../components/Catalog.jsx';
import Player from '../components/Player.jsx';

function normalizeURL(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const NOT_CONNECTED_HINT = "Pas de films encore — connecte-toi à une room pour regarder";

export default function Client() {
  const [roomURL, setRoomURL] = useState('');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [catalog, setCatalog] = useState({ catalogue: [], stream: [] });
  const [syncState, setSyncState] = useState(null);
  const [viewers, setViewers] = useState(0);
  const socketRef = useRef(null);
  const baseRef = useRef(null);

  function disconnect() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    baseRef.current = null;
    setConnected(false);
    setCatalog({ catalogue: [], stream: [] });
    setSyncState(null);
    setViewers(0);
  }

  async function join() {
    setError(null);
    const base = normalizeURL(roomURL);
    if (!base) { setError('URL invalide'); return; }
    setConnecting(true);

    try {
      const res = await fetch(`${base}/api/catalog`);
      if (!res.ok) throw new Error('Catalogue inaccessible');
      const cat = await res.json();
      setCatalog(cat);
    } catch (e) {
      setError(`Connexion impossible : ${e.message}`);
      setConnecting(false);
      return;
    }

    const socket = io(base, { transports: ['websocket'], reconnection: true });
    socketRef.current = socket;
    baseRef.current = base;

    socket.on('connect', () => {
      setConnected(true);
      setConnecting(false);
      socket.emit('hello', { role: 'client' });
      socket.emit('client:resync');
    });
    socket.on('connect_error', (e) => { setError(`Socket: ${e.message}`); setConnecting(false); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', (s) => setSyncState(s));
    socket.on('catalog', (cat) => setCatalog(cat));
    socket.on('viewers', ({ count }) => setViewers(Math.max(0, count - 1)));
    socket.on('host-left', () => setSyncState((s) => s && { ...s, paused: true }));
  }

  useEffect(() => () => socketRef.current?.disconnect(), []);

  const activeId = syncState?.mediaId || null;
  const streamSrc = activeId && baseRef.current
    ? `${baseRef.current}/api/stream/${activeId}`
    : null;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="room-card">
          {connected ? (
            <>
              <h3>Connecté</h3>
              <div className="room-code">{baseRef.current}</div>
              <div className="viewers">
                <span className="dot" />{viewers} autre{viewers !== 1 ? 's' : ''} ami{viewers !== 1 ? 's' : ''}
              </div>
              <button onClick={disconnect}>Quitter la room</button>
            </>
          ) : (
            <>
              <h3>Rejoindre une room</h3>
              <input
                value={roomURL}
                onChange={(e) => setRoomURL(e.target.value)}
                placeholder="URL ou IP de la room"
                onKeyDown={(e) => e.key === 'Enter' && !connecting && join()}
                disabled={connecting}
              />
              <button className="primary" onClick={join} disabled={!roomURL.trim() || connecting}>
                {connecting ? 'Connexion…' : 'Rejoindre'}
              </button>
              {error && <div className="error">{error}</div>}
            </>
          )}
        </div>

        <div className="section">
          <h3>🎬 Catalogue ({catalog.catalogue.length})</h3>
          <Catalog
            items={catalog.catalogue}
            activeId={activeId}
            emptyHint={connected
              ? "Pas encore de films sur le serveur — bientôt disponible"
              : NOT_CONNECTED_HINT}
          />
        </div>

        <div className="section">
          <h3>📡 Stream ({catalog.stream.length})</h3>
          <Catalog
            items={catalog.stream}
            activeId={activeId}
            emptyHint={connected
              ? "L'hôte n'a pas encore partagé de films"
              : NOT_CONNECTED_HINT}
          />
        </div>
      </aside>

      <main className="main">
        <Player src={streamSrc} isHost={false} syncState={syncState} />
      </main>
    </div>
  );
}
