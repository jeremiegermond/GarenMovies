import { useEffect, useState } from 'react';
import { X, Search, Download, Loader2, Check, Star, ShieldCheck, AlertTriangle } from 'lucide-react';

const LANG_OPTIONS = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' }
];

export default function SubtitleSearchModal({
  streamBase,
  mediaId,
  mediaTitle,
  mediaMeta,
  defaultLang = 'fr',
  hasOpenSubtitlesKey,
  onClose,
  onDownloaded,
  onOpenSettings
}) {
  const [lang, setLang] = useState(defaultLang);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadedIds, setDownloadedIds] = useState(new Set());
  const [quota, setQuota] = useState(null); // { remaining, requests }

  useEffect(() => {
    if (hasOpenSubtitlesKey) doSearch(defaultLang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, hasOpenSubtitlesKey]);

  async function doSearch(searchLang = lang) {
    if (!hasOpenSubtitlesKey) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const r = await fetch(`${streamBase}/api/subs/search/${mediaId}?lang=${encodeURIComponent(searchLang)}`);
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `Erreur HTTP ${r.status}`);
      } else {
        setResults(data.results || []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  async function downloadOne(item) {
    if (!item.fileId) return;
    setDownloadingId(item.id);
    setError(null);
    try {
      const r = await fetch(`${streamBase}/api/subs/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId,
          fileId: item.fileId,
          lang: item.language,
          label: makeLabel(item)
        })
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `Erreur HTTP ${r.status}`);
        return;
      }
      setDownloadedIds((s) => new Set([...s, item.id]));
      if (data.remaining != null) setQuota({ remaining: data.remaining, requests: data.requests });
      if (onDownloaded && data.sub) onDownloaded(data.sub);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloadingId(null);
    }
  }

  function makeLabel(item) {
    const langPart = LANG_OPTIONS.find((l) => l.code === item.language)?.label || item.language?.toUpperCase() || 'Sous-titres';
    return `${langPart}${item.hearingImpaired ? ' (SDH)' : ''}`;
  }

  const subtitle = buildSubtitleLine(mediaMeta, mediaTitle);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal subs-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Rechercher des sous-titres</h2>
            <div className="subs-search-target">{subtitle}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Fermer">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {!hasOpenSubtitlesKey && (
          <div className="modal-body">
            <div className="field-help boxed">
              <AlertTriangle size={14} strokeWidth={2} />
              <span>
                Configurez d'abord votre clé API OpenSubtitles dans les{' '}
                <button className="link" onClick={onOpenSettings}>Paramètres</button>.
                Compte gratuit sur opensubtitles.com (20 téléchargements/jour).
              </span>
            </div>
          </div>
        )}

        {hasOpenSubtitlesKey && (
          <>
            <div className="subs-search-controls">
              <div className="subs-lang-picker">
                <label>Langue</label>
                <select
                  className="select"
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  disabled={searching}
                >
                  {LANG_OPTIONS.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </div>
              <button className="primary" onClick={() => doSearch(lang)} disabled={searching}>
                {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                Rechercher
              </button>
            </div>

            <div className="subs-search-results">
              {searching && !results && (
                <div className="subs-search-empty"><Loader2 size={20} className="spin" /> Recherche en cours…</div>
              )}
              {error && <div className="error">{error}</div>}
              {results && results.length === 0 && (
                <div className="subs-search-empty">Aucun résultat pour cette langue. Essayez-en une autre.</div>
              )}
              {results && results.length > 0 && (
                <div className="subs-result-list">
                  {results.slice(0, 30).map((item) => {
                    const isDownloading = downloadingId === item.id;
                    const isDownloaded = downloadedIds.has(item.id);
                    return (
                      <div key={item.id} className="subs-result-row">
                        <div className="subs-result-info">
                          <div className="subs-result-title">{item.release}</div>
                          <div className="subs-result-meta">
                            <span><Download size={11} strokeWidth={2} /> {formatCount(item.downloadCount)}</span>
                            {item.rating > 0 && (
                              <span><Star size={11} strokeWidth={2} /> {item.rating.toFixed(1)}</span>
                            )}
                            {item.trusted && (
                              <span className="subs-tag trusted"><ShieldCheck size={10} strokeWidth={2.5} /> Trusted</span>
                            )}
                            {item.hd && <span className="subs-tag">HD</span>}
                            {item.hearingImpaired && <span className="subs-tag">SDH</span>}
                            {item.machineTranslated && <span className="subs-tag warn">Auto-traduit</span>}
                            {item.foreignPartsOnly && <span className="subs-tag">Étrangers seulement</span>}
                          </div>
                        </div>
                        <button
                          className={isDownloaded ? '' : 'primary'}
                          onClick={() => !isDownloaded && downloadOne(item)}
                          disabled={isDownloading || isDownloaded || !item.fileId}
                        >
                          {isDownloaded ? (
                            <>
                              <Check size={14} strokeWidth={2.5} />
                              Téléchargé
                            </>
                          ) : isDownloading ? (
                            <>
                              <Loader2 size={14} className="spin" />
                              …
                            </>
                          ) : (
                            <>
                              <Download size={14} strokeWidth={2} />
                              Télécharger
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="modal-footer">
              {quota?.remaining != null && (
                <span className="quota-indicator">
                  {quota.remaining} téléchargement{quota.remaining > 1 ? 's' : ''} restant{quota.remaining > 1 ? 's' : ''} aujourd'hui
                </span>
              )}
              <button onClick={onClose}>Fermer</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatCount(n) {
  if (n == null) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')} k`;
  return String(n);
}

function buildSubtitleLine(meta, fallbackTitle) {
  if (!meta) return fallbackTitle;
  if (meta.type === 'tv') {
    const show = meta.showName || meta.title || fallbackTitle;
    const sN = meta.season != null ? `S${String(meta.season).padStart(2, '0')}` : '';
    const eN = meta.episode != null ? `E${String(meta.episode).padStart(2, '0')}` : '';
    const ep = `${sN}${eN}`;
    const epTitle = meta.episodeTitle ? ` · ${meta.episodeTitle}` : '';
    return `${show} ${ep}${epTitle}`.trim();
  }
  const t = meta.title || fallbackTitle;
  return meta.year ? `${t} (${meta.year})` : t;
}
