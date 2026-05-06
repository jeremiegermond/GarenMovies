import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Tabs from '../components/Tabs.jsx';
import CatalogueView from '../components/CatalogueView.jsx';
import Chat from '../components/Chat.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import Player from '../components/Player.jsx';

const NICK_KEY = 'garenmovies-nickname';

function normalizeURL(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

export default function Client({ onLeave }) {
  const [tab, setTab] = useState('room');
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const [roomURL, setRoomURL] = useState('');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [catalog, setCatalog] = useState({ catalogue: [], stream: [] });
  const [syncState, setSyncState] = useState(null);
  const [viewers, setViewers] = useState(0);
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICK_KEY) || 'Anonyme');
  const socketRef = useRef(null);
  const baseRef = useRef(null);
  const nicknameRef = useRef(nickname);

  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);

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
      socket.emit('hello', { role: 'client', nickname: nicknameRef.current });
      socket.emit('client:resync');
    });
    socket.on('connect_error', (e) => { setError(`Socket: ${e.message}`); setConnecting(false); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', (s) => setSyncState(s));
    socket.on('catalog', (cat) => setCatalog(cat));
    socket.on('viewers', ({ count }) => setViewers(Math.max(0, count - 1)));
    socket.on('host-left', () => setSyncState((s) => s && { ...s, paused: true }));
  }

  useEffect(() => {
    socketRef.current?.emit('hello', { role: 'client', nickname });
    localStorage.setItem(NICK_KEY, nickname);
  }, [nickname]);

  useEffect(() => () => socketRef.current?.disconnect(), []);

  function clientSelectMovie(_m) {
    // Client can't change the playing media — switching to Room shows what's playing
    setTab('room');
  }

  const activeId = syncState?.mediaId || null;
  const activeMedia = activeId
    ? (catalog.stream.find((m) => m.id === activeId) || catalog.catalogue.find((m) => m.id === activeId) || null)
    : null;

  const streamBase = baseRef.current || '';
  const streamSrc = activeId && streamBase ? `${streamBase}/api/stream/${activeId}` : null;
  const totalCount = (catalog.catalogue?.length || 0) + (catalog.stream?.length || 0);

  return (
    <div className="app">
      <Tabs
        tab={tab}
        onChange={setTab}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLeave={onLeave}
        badges={{ catalogue: totalCount, unread }}
      />
      <div className="page-body">
        <div className="page-main">
          {tab === 'catalogue' ? (
            <CatalogueView
              catalog={catalog}
              activeId={activeId}
              onSelect={clientSelectMovie}
              canSelect={connected}
              connected={connected}
              hasApiKey={true}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
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

                {activeMedia && (
                  <div className="now-playing">
                    <h3>En cours</h3>
                    <div className="np-title">{activeMedia.title}</div>
                    {activeMedia.meta?.year && <div className="np-year">{activeMedia.meta.year}</div>}
                  </div>
                )}
              </aside>

              <main className="main">
                <Player
                  src={streamSrc}
                  isHost={false}
                  syncState={syncState}
                  subs={activeMedia?.subs || []}
                  streamBase={streamBase}
                  mediaId={activeId}
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
          onClose={() => setSettingsOpen(false)}
          nickname={nickname}
          onNicknameChange={setNickname}
        />
      )}
    </div>
  );
}
