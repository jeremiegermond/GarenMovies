import { useEffect, useState } from 'react';

export default function SettingsModal({ onClose, nickname, onNicknameChange }) {
  const [tmdbKey, setTmdbKey] = useState('');
  const [originalKey, setOriginalKey] = useState('');
  const [nick, setNick] = useState(nickname || '');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const key = cfg.tmdbApiKey || '';
      setTmdbKey(key);
      setOriginalKey(key);
      setLoading(false);
    });
  }, []);

  const hasSavedKey = !!originalKey;
  const keyChanged = tmdbKey.trim() !== originalKey;
  const nickChanged = nick.trim() && nick !== nickname;

  async function save() {
    const cleanKey = tmdbKey.trim();
    await window.electronAPI.setConfig({ tmdbApiKey: cleanKey });
    setOriginalKey(cleanKey);
    if (nickChanged) onNicknameChange(nick.trim());
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
            <label>
              Clé API TMDB (pour les affiches)
              {hasSavedKey && !keyChanged && <span className="badge ok-badge">✓ ENREGISTRÉE</span>}
            </label>
            <div className="key-input-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={loading ? '' : tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder={loading ? 'Chargement…' : 'ex: 1234abcd5678ef...'}
                disabled={loading}
              />
              <button onClick={() => setShowKey((v) => !v)} type="button">
                {showKey ? 'Masquer' : 'Afficher'}
              </button>
            </div>
            <div className="hint">
              Crée un compte gratuit sur <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org</a>,
              demande une clé API (v3 auth, instantané) et colle-la ici.
            </div>
            <div className="hint accent">
              💡 <b>Ta clé est utilisée seulement quand tu héberges.</b> Tes amis n'ont pas besoin de leur propre clé — ils reçoivent les affiches directement de ton serveur.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          {saved && <span className="saved">✓ Enregistré</span>}
          <button onClick={onClose}>Fermer</button>
          <button className="primary" onClick={save} disabled={loading || (!keyChanged && !nickChanged)}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
