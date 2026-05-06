import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Chat({ socket, visible, onUnreadChange, currentNickname }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const visibleRef = useRef(visible);
  const unreadRef = useRef(0);

  useEffect(() => { visibleRef.current = visible; }, [visible]);

  useEffect(() => {
    if (!socket) return;
    const onHistory = (history) => setMessages(history || []);
    const onMessage = (msg) => {
      setMessages((m) => [...m, msg]);
      if (!visibleRef.current) {
        unreadRef.current++;
        onUnreadChange?.(unreadRef.current);
      }
    };
    socket.on('chat:history', onHistory);
    socket.on('chat:message', onMessage);
    return () => {
      socket.off('chat:history', onHistory);
      socket.off('chat:message', onMessage);
    };
  }, [socket, onUnreadChange]);

  useEffect(() => {
    if (visible) {
      unreadRef.current = 0;
      onUnreadChange?.(0);
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [visible, messages, onUnreadChange]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed || !socket) return;
    socket.emit('chat:send', { text: trimmed });
    setText('');
  }

  return (
    <aside className={`chat-panel ${visible ? 'open' : 'closed'}`}>
      <div className="chat-header">
        <h3>Chat</h3>
        <span className="chat-header-meta">{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">Aucun message.<br />Soyez le premier à écrire.</div>
        ) : (
          messages.map((m, i) => {
            const mine = m.nickname === currentNickname;
            return (
              <div key={i} className={`chat-msg ${mine ? 'mine' : ''}`}>
                <div className="chat-meta">
                  <span className="chat-name">{m.nickname}</span>
                  {m.isHost && <span className="chat-host-tag">Hôte</span>}
                  <span className="chat-time">{formatTime(m.ts)}</span>
                </div>
                <div className="chat-text">{m.text}</div>
              </div>
            );
          })
        )}
      </div>
      <div className="chat-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Écrire un message"
          maxLength={500}
        />
        <button className="primary" onClick={send} disabled={!text.trim()} title="Envoyer">
          <Send size={15} strokeWidth={2} />
        </button>
      </div>
    </aside>
  );
}
