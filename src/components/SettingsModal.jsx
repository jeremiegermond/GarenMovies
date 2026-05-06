import { useEffect, useState } from 'react';

export default function SettingsModal({ onClose, nickname, onNicknameChange }) {
  const [tmdbKey, setTmdbKey] = useState('');
  const [nick, setNick] = useState(nickname || '');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setTmdbKey(cfg.tmdbApiKey || '');
      setLoading(false);
    });
  }, []);

  async function save() {
    await window.electronAPI.setConfig({ tmdbApiKey: tmdbKey.trim() });
    if (nick.trim() && nick !== nickname) onNicknameChange(nick.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙️ Paramètres</h2>
          <button className="back-link" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Pseudo (utilisé pour le chat)</label>
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              placeholder="Ton pseudo"
              maxLength={32}
            />
          </div>

          <div className="field">
            <label>Clé API TMDB (pour les affiches de films)</label>
            <input
              type="text"
              value={loading ? 'Chargement…' : tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              placeholder="ex: 1234abcd5678ef..."
              disabled={loading}
            />
            <div className="hint">
              Crée un compte gratuit sur <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org</a>,
              demande une clé API (v3 auth, c'est instantané) et colle-la ici. Sans clé, les films s'afficheront sans poster.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          {saved && <span className="saved">✓ Enregistré</span>}
          <button onClick={onClose}>Fermer</button>
          <button className="primary" onClick={save} disabled={loading}>Enregistrer</button>
        </div>
      </div>
    </div>
  );
}
