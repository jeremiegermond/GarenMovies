import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Folder, RefreshCw, Globe, Copy, Check } from 'lucide-react';
import Tabs from '../components/Tabs.jsx';
import CatalogueView from '../components/CatalogueView.jsx';
import Chat from '../components/Chat.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import Player from '../components/Player.jsx';

const NICK_KEY = 'garenmovies-nickname';

export default function Host({ onLeave }) {
  const [tab, setTab] = useState('room');
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [copied, setCopied] = useState(false);

  const [serverInfo, setServerInfo] = useState(null);
  const [folder, setFolder] = useState(null);
  const [catalog, setCatalog] = useState({ catalogue: [], stream: [] });
  const [activeId, setActiveId] = useState(null);
  const [viewers, setViewers] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [tunnelURL, setTunnelURL] = useState(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelError, setTunnelError] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICK_KEY) || 'Hôte');
  const socketRef = useRef(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);

  useEffect(() => {
    window.electronAPI.getServerInfo().then(setServerInfo);
    window.electronAPI.getConfig().then((c) => {
      if (c?.scanFolder) setFolder(c.scanFolder);
      setHasApiKey(!!c?.tmdbApiKey);
    });
    window.electronAPI.getCatalog().then(setCatalog);
    window.electronAPI.tunnel.status().then((s) => setTunnelURL(s.url));
    const off = window.electronAPI.tunnel.onURL((url) => setTunnelURL(url));
    return off;
  }, []);

  useEffect(() => {
    if (!serverInfo) return;
    const socket = io(`http://localhost:${serverInfo.port}`, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('connect', () => socket.emit('hello', { role: 'host', nickname: nicknameRef.current }));
    socket.on('viewers', ({ count }) => setViewers(Math.max(0, count - 1)));
    socket.on('catalog', (cat) => setCatalog(cat));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [serverInfo]);

  useEffect(() => {
    socketRef.current?.emit('hello', { role: 'host', nickname });
    localStorage.setItem(NICK_KEY, nickname);
  }, [nickname]);

  async function pickFolder() {
    const f = await window.electronAPI.pickFolder();
    if (!f) return;
    setFolder(f);
    setScanning(true);
    try {
      await window.electronAPI.scanFolder(f);
      const fresh = await window.electronAPI.getCatalog();
      setCatalog(fresh);
    } finally { setScanning(false); }
  }

  async function rescan() {
    if (!folder) return;
    setScanning(true);
    try {
      await window.electronAPI.rescan();
      const fresh = await window.electronAPI.getCatalog();
      setCatalog(fresh);
    } finally { setScanning(false); }
  }

  function selectMovie(m) {
    setActiveId(m.id);
    socketRef.current?.emit('host:select', { mediaId: m.id });
    setTab('room');
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

  async function onCloseSettings() {
    setSettingsOpen(false);
    const cfg = await window.electronAPI.getConfig();
    setHasApiKey(!!cfg.tmdbApiKey);
  }

  function copyURL() {
    if (!shareURL) return;
    navigator.clipboard.writeText(shareURL);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const activeMedia = activeId
    ? (catalog.stream.find((m) => m.id === activeId) || catalog.catalogue.find((m) => m.id === activeId) || null)
    : null;

  const streamBase = serverInfo ? `http://localhost:${serverInfo.port}` : '';
  const streamSrc = activeId ? `${streamBase}/api/stream/${activeId}` : null;

  const lanIP = serverInfo?.lanIPs?.[0];
  const lanURL = lanIP && serverInfo ? `http://${lanIP}:${serverInfo.port}` : null;
  const shareURL = tunnelURL || lanURL;

  return (
    <div className="app">
      <Tabs
        tab={tab}
        onChange={setTab}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLeave={onLeave}
        badges={{ unread }}
      />
      <div className="page-body">
        <div className="page-main">
          {tab === 'catalogue' ? (
            <CatalogueView
              catalog={catalog}
              activeId={activeId}
              onSelect={selectMovie}
              canSelect={true}
              connected={true}
              hasApiKey={hasApiKey}
              isHost={true}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <div className="workspace">
              <aside className="sidebar">
                <div className="room-block">
                  <div className="section-label">
                    Salon
                    {tunnelURL && <span className="badge-online">En ligne</span>}
                  </div>
                  <div className="room-url-display">
                    <span className="room-url-text">{shareURL || 'démarrage…'}</span>
                    <button className="room-url-copy" onClick={copyURL} disabled={!shareURL} title="Copier">
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                  <div className="viewers-line">
                    <span className={viewers > 0 ? 'dot-online' : 'dot-offline'} />
                    {viewers === 0 ? 'En attente d\'invités' : `${viewers} invité${viewers > 1 ? 's' : ''} connecté${viewers > 1 ? 's' : ''}`}
                  </div>
                  {!tunnelURL && (
                    <div className="hint">Réseau local uniquement. Activez l'accès internet pour partager hors de chez vous.</div>
                  )}
                  <button
                    className={tunnelURL ? 'danger' : 'primary'}
                    onClick={toggleTunnel}
                    disabled={tunnelLoading}
                  >
                    <Globe size={14} strokeWidth={2} />
                    {tunnelLoading ? 'Connexion…' : (tunnelURL ? 'Couper l\'accès internet' : 'Activer l\'accès internet')}
                  </button>
                  {tunnelError && <div className="error">{tunnelError}</div>}
                </div>

                <div className="room-block">
                  <div className="section-label">Bibliothèque locale</div>
                  <div className="row">
                    <button onClick={pickFolder} disabled={scanning}>
                      <Folder size={14} strokeWidth={1.75} />
                      {folder ? 'Changer' : 'Choisir'}
                    </button>
                    <button onClick={rescan} disabled={scanning || !folder}>
                      <RefreshCw size={14} strokeWidth={1.75} className={scanning ? 'spin' : ''} />
                      Rescanner
                    </button>
                  </div>
                  {folder && <div className="path-display">{folder}</div>}
                </div>

                {activeMedia && (
                  <div className="now-playing">
                    <div className="np-eyebrow">En lecture</div>
                    <div className="np-title">{activeMedia.title}</div>
                    {activeMedia.meta?.year && (
                      <div className="np-meta"><span>{activeMedia.meta.year}</span></div>
                    )}
                  </div>
                )}
              </aside>

              <main className="main">
                <Player
                  src={streamSrc}
                  isHost={true}
                  onHostStateChange={pushHostState}
                  subs={activeMedia?.subs || []}
                  audioTracks={activeMedia?.audioTracks || []}
                  streamBase={streamBase}
                  mediaId={activeId}
                  mediaTitle={activeMedia?.title}
                  mediaMeta={activeMedia?.meta}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </main>
            </div>
          )}
        </div>
        <Chat
          socket={socketRef.current}
          visible={chatOpen}
          onUnreadChange={setUnread}
          currentNickname={nickname}
        />
      </div>
      {settingsOpen && (
        <SettingsModal
          onClose={onCloseSettings}
          nickname={nickname}
          onNicknameChange={setNickname}
        />
      )}
    </div>
  );
}
