export default function Tabs({ tab, onChange, chatOpen, onToggleChat, onOpenSettings, onLeave, badges = {} }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <h1>GarenMovies</h1>
        <nav className="tabs">
          <button
            className={`tab ${tab === 'catalogue' ? 'active' : ''}`}
            onClick={() => onChange('catalogue')}
          >
            🎬 Catalogue {badges.catalogue != null && <span className="tab-badge">{badges.catalogue}</span>}
          </button>
          <button
            className={`tab ${tab === 'room' ? 'active' : ''}`}
            onClick={() => onChange('room')}
          >
            📡 Room
          </button>
        </nav>
      </div>
      <div className="topbar-right">
        <button
          className={`icon-btn ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title="Chat"
        >
          💬 {badges.unread > 0 && <span className="badge unread">{badges.unread}</span>}
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Paramètres">⚙️</button>
        <button className="back-link" onClick={onLeave}>← Retour</button>
      </div>
    </div>
  );
}
