import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Check, Info } from 'lucide-react';

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
    setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Paramètres</h2>
          <button className="icon-btn" onClick={onClose} title="Fermer">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">Pseudo</label>
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              placeholder="Votre pseudo, utilisé dans le chat"
              maxLength={32}
            />
          </div>

          <div className="field">
            <label className="field-label">
              Clé API TMDB
              {hasSavedKey && !keyChanged && (
                <span className="saved-tag">
                  <Check size={10} strokeWidth={3} />
                  Enregistrée
                </span>
              )}
            </label>
            <div className="input-with-action">
              <input
                type={showKey ? 'text' : 'password'}
                value={loading ? '' : tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder={loading ? 'Chargement…' : 'Collez votre clé API ici'}
                disabled={loading}
              />
              <button onClick={() => setShowKey((v) => !v)} type="button" title={showKey ? 'Masquer' : 'Afficher'}>
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div className="field-help">
              Créez un compte gratuit sur <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org</a>,
              demandez une clé API (v3 auth — instantané) puis collez-la ici. Sans clé, les films s'affichent sans poster.
            </div>
            <div className="field-help boxed">
              <Info size={14} strokeWidth={2} />
              <span>
                Cette clé n'est utilisée que lorsque <b>vous hébergez</b> un salon. Vos invités n'ont pas besoin de leur propre clé — ils reçoivent les affiches directement de votre serveur.
              </span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          {saved && (
            <span className="saved-indicator">
              <Check size={14} strokeWidth={2.5} />
              Enregistré
            </span>
          )}
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={save} disabled={loading || (!keyChanged && !nickChanged)}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
