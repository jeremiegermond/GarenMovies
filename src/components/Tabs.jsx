import { Library, Tv, MessageCircle, Settings2, ChevronLeft } from 'lucide-react';

export default function Tabs({ tab, onChange, chatOpen, onToggleChat, onOpenSettings, onLeave, badges = {} }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">Garen<span className="brand-accent">Movies</span></div>
        <nav className="tabs">
          <button
            className={`tab ${tab === 'catalogue' ? 'active' : ''}`}
            onClick={() => onChange('catalogue')}
          >
            <Library size={14} />
            Bibliothèque
          </button>
          <button
            className={`tab ${tab === 'room' ? 'active' : ''}`}
            onClick={() => onChange('room')}
          >
            <Tv size={14} />
            Salon
          </button>
        </nav>
      </div>
      <div className="topbar-right">
        <button
          className={`icon-btn ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title="Chat"
        >
          <MessageCircle size={18} strokeWidth={1.75} />
          {badges.unread > 0 && <span className="unread-dot">{badges.unread > 9 ? '9+' : badges.unread}</span>}
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Paramètres">
          <Settings2 size={18} strokeWidth={1.75} />
        </button>
        <button className="icon-btn" onClick={onLeave} title="Retour à l'accueil">
          <ChevronLeft size={18} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
