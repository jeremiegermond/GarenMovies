import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Catalog from '../components/Catalog.jsx';
import Player from '../components/Player.jsx';

export default function Host() {
  const [serverInfo, setServerInfo] = useState(null);
  const [folder, setFolder] = useState(null);
  const [catalog, setCatalog] = useState({ catalogue: [], stream: [] });
  const [activeId, setActiveId] = useState(null);
  const [viewers, setViewers] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [tunnelURL, setTunnelURL] = useState(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelError, setTunnelError] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    window.electronAPI.getServerInfo().then(setServerInfo);
    window.electronAPI.getConfig().then((c) => c?.scanFolder && setFolder(c.scanFolder));
    window.electronAPI.getCatalog().then(setCatalog);
    window.electronAPI.tunnel.status().then((s) => setTunnelURL(s.url));
    const off = window.electronAPI.tunnel.onURL((url) => setTunnelURL(url));
    return off;
  }, []);

  useEffect(() => {
    if (!serverInfo) return;
    const socket = io(`http://localhost:${serverInfo.port}`, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('connect', () => socket.emit('hello', { role: 'host' }));
    socket.on('viewers', ({ count }) => setViewers(Math.max(0, count - 1)));
    socket.on('catalog', (cat) => setCatalog(cat));
    return () => socket.disconnect();
  }, [serverInfo]);

  async function pickFolder() {
    const f = await window.electronAPI.pickFolder();
    if (!f) return;
    setFolder(f);
    setScanning(true);
    try {
      await window.electronAPI.scanFolder(f);
      const fresh = await window.electronAPI.getCatalog();
      setCatalog(fresh);
    } finally {
      setScanning(false);
    }
  }

  async function rescan() {
    if (!folder) return;
    setScanning(true);
    try {
      await window.electronAPI.rescan();
      const fresh = await window.electronAPI.getCatalog();
      setCatalog(fresh);
    } finally {
      setScanning(false);
    }
  }

  function selectMovie(m) {
    setActiveId(m.id);
    socketRef.current?.emit('host:select', { mediaId: m.id });
  }

  function pushHostState(payload) {
    socketRef.current?.emit('host:state', { mediaId: activeId, ...payload });
  }

  async function toggleTunnel() {
    setTunnelError(null);
    if (tunnelURL) {
      setTunnelLoading(true);
      await window.electronAPI.tunnel.stop();
      setTunnelURL(null);
      setTunnelLoading(false);
      return;
    }
    setTunnelLoading(true);
    const result = await window.electronAPI.tunnel.start();
    setTunnelLoading(false);
    if (result.error) setTunnelError(result.error);
    else setTunnelURL(result.url);
  }

  const streamSrc = activeId && serverInfo
    ? `http://localhost:${serverInfo.port}/api/stream/${activeId}`
    : null;

  const lanIP = serverInfo?.lanIPs?.[0];
  const lanURL = lanIP && serverInfo ? `http://${lanIP}:${serverInfo.port}` : null;
  const shareURL = tunnelURL || lanURL;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="room-card">
          <h3>Room {tunnelURL && <span className="badge online">EN LIGNE</span>}</h3>
          <div className="room-code">{shareURL || 'démarrage…'}</div>
          {!tunnelURL && <div className="hint">Réseau local uniquement — clique "Mettre en ligne" pour ouvrir à internet</div>}
          <div className="viewers">
            <span className="dot" />{viewers} ami{viewers !== 1 ? 's' : ''} connecté{viewers !== 1 ? 's' : ''}
          </div>
          <div className="row">
            <button onClick={() => shareURL && navigator.clipboard.writeText(shareURL)} disabled={!shareURL}>
              Copier
            </button>
            <button
              className={tunnelURL ? '' : 'primary'}
              onClick={toggleTunnel}
              disabled={tunnelLoading}
            >
              {tunnelLoading ? '…' : (tunnelURL ? 'Arrêter' : 'Mettre en ligne')}
            </button>
          </div>
          {tunnelError && <div className="error">{tunnelError}</div>}
        </div>

        <div className="scan-form">
          <h3>Bibliothèque locale</h3>
          <div className="row">
            <button onClick={pickFolder} disabled={scanning}>
              {folder ? 'Changer' : 'Choisir'}
            </button>
            <button onClick={rescan} disabled={scanning || !folder}>
              {scanning ? 'Scan…' : 'Rescanner'}
            </button>
          </div>
          {folder && <div className="path-display">{folder}</div>}
        </div>

        <div className="section">
          <h3>🎬 Catalogue ({catalog.catalogue.length})</h3>
          <Catalog
            items={catalog.catalogue}
            activeId={activeId}
            onPick={selectMovie}
            emptyHint="Pas encore de films sur le serveur — bientôt disponible"
          />
        </div>

        <div className="section">
          <h3>📡 Stream ({catalog.stream.length})</h3>
          <Catalog
            items={catalog.stream}
            activeId={activeId}
            onPick={selectMovie}
            emptyHint={folder ? "Aucun film trouvé dans ce dossier" : "Choisis un dossier pour scanner tes films"}
          />
        </div>
      </aside>

      <main className="main">
        <Player src={streamSrc} isHost={true} onHostStateChange={pushHostState} />
      </main>
    </div>
  );
}
