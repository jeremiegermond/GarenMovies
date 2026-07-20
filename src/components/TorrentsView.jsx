import { useState } from 'react';
import { Search, Download, Copy, Check, Loader2, UploadCloud, Magnet } from 'lucide-react';

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|webm|mov|m4v)$/i;

export default function TorrentsView() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(-1);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true); setError(null); setSearched(true);
    try {
      const { results: r, error: e } = await window.electronAPI.torrents.search(q);
      if (e) setError(e);
      setResults(r || []);
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function openMagnet(magnet) {
    const res = await window.electronAPI.torrents.openMagnet(magnet);
    if (res?.error) flash(`Erreur : ${res.error}`);
    else flash('Magnet envoyé à ton client torrent');
  }

  async function copyMagnet(magnet, idx) {
    try { await navigator.clipboard.writeText(magnet); setCopiedIdx(idx); setTimeout(() => setCopiedIdx(-1), 1500); }
    catch { flash('Impossible de copier'); }
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);

    // 1) Dropped text that is a magnet link.
    const text = e.dataTransfer.getData('text');
    if (text && text.trim().startsWith('magnet:')) {
      await openMagnet(text.trim());
      return;
    }

    // 2) Dropped files: .torrent → open in client, videos → add to library.
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const torrentFiles = [];
    const videoPaths = [];
    for (const f of files) {
      const p = window.electronAPI.getPathForFile(f);
      if (!p) continue;
      if (/\.torrent$/i.test(p)) torrentFiles.push(p);
      else if (VIDEO_EXT_RE.test(p)) videoPaths.push(p);
    }

    for (const p of torrentFiles) {
      const res = await window.electronAPI.torrents.openFile(p);
      if (res?.error) flash(`Erreur .torrent : ${res.error}`);
    }
    if (torrentFiles.length) flash(`${torrentFiles.length} .torrent ouvert(s) dans ton client`);

    if (videoPaths.length) {
      flash(`Ajout de ${videoPaths.length} vidéo(s) à la bibliothèque…`);
      const res = await window.electronAPI.torrents.addVideos(videoPaths);
      if (res?.error) flash(`Erreur : ${res.error}`);
      else flash(`${res.added} vidéo(s) ajoutée(s)${res.skipped?.length ? `, ${res.skipped.length} ignorée(s)` : ''}`);
    }

    if (!torrentFiles.length && !videoPaths.length) {
      flash('Rien à faire : dépose un .torrent, un lien magnet, ou des vidéos');
    }
  }

  return (
    <div
      className={`torrents-view ${dragOver ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={handleDrop}
    >
      <div className="torrents-head">
        <h2>Rechercher un torrent</h2>
        <p className="torrents-sub">Résultats agrégés depuis The Pirate Bay, YTS, Torrents-CSV, Nyaa (anime), AnimeTosho et YggTorrent (FR). Le magnet s'ouvre dans ton client torrent — GarenMovies ne télécharge rien lui-même.</p>
        <div className="torrents-search">
          <Search size={16} strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            placeholder="Titre du film ou de la série…"
            autoFocus
          />
          <button className="primary" onClick={runSearch} disabled={loading || !query.trim()}>
            {loading ? <Loader2 size={14} className="spin" /> : 'Rechercher'}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="torrents-results">
        {loading ? (
          <div className="torrents-empty"><Loader2 size={20} className="spin" /> Recherche…</div>
        ) : results.length > 0 ? (
          <table className="torrents-table">
            <thead>
              <tr><th>Nom</th><th>Taille</th><th className="tt-seed">Seeders</th><th>Source</th><th></th></tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td className="tt-name" title={r.title}>{r.title}</td>
                  <td className="tt-size">{r.size}</td>
                  <td className="tt-seed"><span className={r.seeders > 0 ? 'seed-ok' : 'seed-none'}>{r.seeders}</span></td>
                  <td><span className={`tt-source src-${r.source.toLowerCase()}`}>{r.source}</span></td>
                  <td className="tt-actions">
                    <button className="tt-open" onClick={() => openMagnet(r.magnet)} title="Ouvrir dans le client torrent">
                      <Download size={14} strokeWidth={2} /> Ouvrir
                    </button>
                    <button className="tt-copy" onClick={() => copyMagnet(r.magnet, i)} title="Copier le magnet">
                      {copiedIdx === i ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : searched ? (
          <div className="torrents-empty">Aucun résultat pour « {query} »</div>
        ) : (
          <div className="torrents-empty">Lance une recherche pour commencer</div>
        )}
      </div>

      <div className="torrents-dropzone">
        <UploadCloud size={22} strokeWidth={1.75} />
        <div className="dz-title">Glisser-déposer ici</div>
        <div className="dz-sub">
          <Magnet size={12} strokeWidth={2} /> un lien magnet ou un fichier <code>.torrent</code> → ouvre ton client torrent&nbsp;·&nbsp;
          des fichiers vidéo → ajoutés à la bibliothèque
        </div>
      </div>

      {dragOver && (
        <div className="torrents-drop-overlay">
          <UploadCloud size={40} strokeWidth={1.5} />
          <div>Dépose ici</div>
        </div>
      )}

      {toast && <div className="torrents-toast">{toast}</div>}
    </div>
  );
}
