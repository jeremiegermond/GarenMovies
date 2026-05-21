import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Check, Info } from 'lucide-react';

export default function SettingsModal({ onClose, nickname, onNicknameChange }) {
  const [tmdbKey, setTmdbKey] = useState('');
  const [originalTmdbKey, setOriginalTmdbKey] = useState('');
  const [osKey, setOsKey] = useState('');
  const [originalOsKey, setOriginalOsKey] = useState('');
  const [defaultSubLang, setDefaultSubLang] = useState('fr');
  const [originalDefaultSubLang, setOriginalDefaultSubLang] = useState('fr');
  const [nick, setNick] = useState(nickname || '');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showOsKey, setShowOsKey] = useState(false);

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setTmdbKey(cfg.tmdbApiKey || '');
      setOriginalTmdbKey(cfg.tmdbApiKey || '');
      setOsKey(cfg.openSubtitlesApiKey || '');
      setOriginalOsKey(cfg.openSubtitlesApiKey || '');
      setDefaultSubLang(cfg.defaultSubLang || 'fr');
      setOriginalDefaultSubLang(cfg.defaultSubLang || 'fr');
      setLoading(false);
    });
  }, []);

  const tmdbChanged = tmdbKey.trim() !== originalTmdbKey;
  const osChanged = osKey.trim() !== originalOsKey;
  const langChanged = defaultSubLang !== originalDefaultSubLang;
  const nickChanged = nick.trim() && nick !== nickname;
  const dirty = tmdbChanged || osChanged || langChanged || nickChanged;

  async function save() {
    await window.electronAPI.setConfig({
      tmdbApiKey: tmdbKey.trim(),
      openSubtitlesApiKey: osKey.trim(),
      defaultSubLang
    });
    setOriginalTmdbKey(tmdbKey.trim());
    setOriginalOsKey(osKey.trim());
    setOriginalDefaultSubLang(defaultSubLang);
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
              {originalTmdbKey && !tmdbChanged && (
                <span className="saved-tag">
                  <Check size={10} strokeWidth={3} />
                  Enregistrée
                </span>
              )}
            </label>
            <div className="input-with-action">
              <input
                type={showTmdbKey ? 'text' : 'password'}
                value={loading ? '' : tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder={loading ? 'Chargement…' : 'Collez votre clé API ici'}
                disabled={loading}
              />
              <button onClick={() => setShowTmdbKey((v) => !v)} type="button" title={showTmdbKey ? 'Masquer' : 'Afficher'}>
                {showTmdbKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div className="field-help">
              Compte gratuit sur <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org</a>,
              demandez une clé API (v3 auth — instantané). Sans clé, les films s'affichent sans poster.
            </div>
          </div>

          <div className="field">
            <label className="field-label">
              Clé API OpenSubtitles
              {originalOsKey && !osChanged && (
                <span className="saved-tag">
                  <Check size={10} strokeWidth={3} />
                  Enregistrée
                </span>
              )}
            </label>
            <div className="input-with-action">
              <input
                type={showOsKey ? 'text' : 'password'}
                value={loading ? '' : osKey}
                onChange={(e) => setOsKey(e.target.value)}
                placeholder={loading ? 'Chargement…' : 'Collez votre clé API ici'}
                disabled={loading}
              />
              <button onClick={() => setShowOsKey((v) => !v)} type="button" title={showOsKey ? 'Masquer' : 'Afficher'}>
                {showOsKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div className="field-help">
              Compte gratuit sur <a href="https://www.opensubtitles.com/fr/consumers" target="_blank" rel="noreferrer">opensubtitles.com</a>,
              puis créez une "App" pour obtenir une clé API. 20 téléchargements/jour en gratuit.
            </div>
          </div>

          <div className="field">
            <label className="field-label">Langue par défaut des sous-titres recherchés</label>
            <select
              className="select"
              value={defaultSubLang}
              onChange={(e) => setDefaultSubLang(e.target.value)}
              disabled={loading}
            >
              <option value="fr">Français</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="it">Italiano</option>
              <option value="de">Deutsch</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
              <option value="ja">日本語</option>
            </select>
          </div>

          <div className="field-help boxed">
            <Info size={14} strokeWidth={2} />
            <span>
              Les clés API sont utilisées uniquement <b>côté hôte</b>. Vos invités n'ont besoin de rien configurer — affiches et sous-titres téléchargés leur sont envoyés directement.
            </span>
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
          <button className="primary" onClick={save} disabled={loading || !dirty}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
