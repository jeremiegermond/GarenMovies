import { useState } from 'react';
import { Film, Play, X, Layers, RefreshCw, Folder, Check } from 'lucide-react';
import { displayTitle, byTitle } from '../lib/titles.js';

// Where a film / episode was left (progress.cjs entry): a thin bar along the
// bottom of the poster, or a "Vu" tag once watched.
function WatchState({ p, row = false }) {
  if (!p) return null;
  if (p.done) {
    return <span className={row ? 'episode-seen' : 'card-seen-tag'}><Check size={10} strokeWidth={3} /> Vu</span>;
  }
  if (!(p.pos >= 30 && p.dur > 0)) return null;
  return (
    <div className={row ? 'episode-progress' : 'card-progress'}>
      <div style={{ width: `${Math.min(100, (p.pos / p.dur) * 100)}%` }} />
    </div>
  );
}

function MovieCard({ movie, active, onClick, canSelect, progress }) {
  const poster = movie.meta?.poster;
  const year = movie.meta?.year;
  const hasSubs = movie.subs?.length > 0;
  const name = displayTitle(movie);
  return (
    <button
      type="button"
      className={`card ${active ? 'active' : ''} ${canSelect ? 'clickable' : ''}`}
      onClick={canSelect ? onClick : undefined}
      title={name}
      disabled={!canSelect}
    >
      <div className="card-poster">
        {poster ? (
          <img src={poster} alt={name} loading="lazy" decoding="async" />
        ) : (
          <div className="card-placeholder">
            <Film size={36} strokeWidth={1.25} />
          </div>
        )}
        {hasSubs && <div className="card-cc-tag">CC</div>}
        {active && (
          <div className="card-active-tag">
            <Play size={10} strokeWidth={2.5} fill="currentColor" />
            En cours
          </div>
        )}
        {!active && <WatchState p={progress?.[movie.id]} />}
      </div>
      <div className="card-info">
        <div className="card-title">{name}</div>
        {year && <div className="card-year">{year}</div>}
      </div>
    </button>
  );
}

function SeriesCard({ group, activeId, onSelectEpisode, canSelect, progress }) {
  const [open, setOpen] = useState(false);
  const activeEp = group.episodes.find((ep) => ep.id === activeId);
  // The episode of this season watched last: its bar on the season's poster.
  const lastEp = group.episodes.reduce((best, ep) => {
    const p = progress?.[ep.id];
    return p && !p.done && (!best || p.at > progress[best.id].at) ? ep : best;
  }, null);
  const epCount = group.episodes.length;
  const anySubs = group.episodes.some((ep) => ep.subs?.length > 0);
  return (
    <>
      <button
        type="button"
        className={`card ${activeEp ? 'active' : ''} ${canSelect ? 'clickable' : ''}`}
        onClick={canSelect ? () => setOpen(true) : undefined}
        title={`${group.showName} — Saison ${group.season}`}
        disabled={!canSelect}
      >
        <div className="card-poster">
          {group.poster ? (
            <img src={group.poster} alt={group.showName} loading="lazy" decoding="async" />
          ) : (
            <div className="card-placeholder">
              <Film size={36} strokeWidth={1.25} />
            </div>
          )}
          <div className="card-series-tag">
            <Layers size={10} strokeWidth={2.5} />
            {epCount} ép.
          </div>
          {anySubs && <div className="card-cc-tag">CC</div>}
          {activeEp && (
            <div className="card-active-tag">
              <Play size={10} strokeWidth={2.5} fill="currentColor" />
              En cours
            </div>
          )}
          {!activeEp && lastEp && <WatchState p={progress[lastEp.id]} />}
        </div>
        <div className="card-info">
          <div className="card-title">{group.showName}</div>
          <div className="card-year">
            Saison {group.season}{group.year ? ` · ${group.year}` : ''}
          </div>
        </div>
      </button>
      {open && (
        <EpisodePicker
          group={group}
          activeId={activeId}
          progress={progress}
          onSelect={(ep) => { onSelectEpisode(ep); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function EpisodePicker({ group, activeId, onSelect, onClose, progress }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal episode-picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">
          {group.poster && (
            <img src={group.poster} alt="" className="picker-poster" />
          )}
          <div className="picker-meta">
            <h2>{group.showName}</h2>
            <div className="picker-subtitle">
              Saison {group.season} · {group.episodes.length} épisode{group.episodes.length > 1 ? 's' : ''}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Fermer">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <div className="picker-list">
          {group.episodes.map((ep) => {
            const epNum = ep.meta?.episode;
            const epTitle = ep.meta?.episodeTitle;
            const hasSubs = ep.subs?.length > 0;
            const isActive = ep.id === activeId;
            return (
              <button
                key={ep.id}
                className={`episode-row ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(ep)}
              >
                <div className="episode-num">
                  {epNum != null ? `E${String(epNum).padStart(2, '0')}` : '—'}
                </div>
                <div className="episode-info">
                  <div className="episode-title">{epTitle || ep.title}</div>
                  {epTitle && <div className="episode-filename">{ep.title}</div>}
                  {!progress?.[ep.id]?.done && <WatchState p={progress?.[ep.id]} row />}
                </div>
                <div className="episode-tags">
                  {progress?.[ep.id]?.done && <WatchState p={progress[ep.id]} row />}
                  {hasSubs && <span className="episode-cc">CC</span>}
                  {isActive ? (
                    <span className="episode-playing">
                      <Play size={10} strokeWidth={2.5} fill="currentColor" /> En cours
                    </span>
                  ) : (
                    <Play size={14} strokeWidth={2} className="episode-play" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function groupItems(items) {
  const groups = [];
  const seriesMap = new Map();
  for (const item of items) {
    const isTvEpisode = item.meta?.type === 'tv' && item.meta?.season != null;
    if (isTvEpisode) {
      const showName = item.meta.showName || item.meta.title || item.title;
      const groupKey = `${normalizeKey(showName)}:s${item.meta.season}`;
      let group = seriesMap.get(groupKey);
      if (!group) {
        group = {
          type: 'tv-season',
          key: groupKey,
          showName,
          season: item.meta.season,
          poster: item.meta.poster,
          year: item.meta.year,
          episodes: []
        };
        seriesMap.set(groupKey, group);
        groups.push(group);
      }
      group.episodes.push(item);
    } else {
      groups.push({ type: 'single', key: `single:${item.id}`, item });
    }
  }
  for (const g of groups) {
    if (g.type === 'tv-season') {
      g.episodes.sort((a, b) => (a.meta?.episode || 0) - (b.meta?.episode || 0));
    }
  }
  // Alphabetical on what's shown (the server sorts on raw file names, which put
  // "[DKB] Inu-Oh" first); seasons of a show stay in order.
  const label = (g) => (g.type === 'tv-season' ? g.showName : displayTitle(g.item));
  groups.sort((a, b) => byTitle(label(a), label(b)) || (a.season || 0) - (b.season || 0));
  return groups;
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function Section({ title, subtitle, items, activeId, onSelect, canSelect, emptyMessage, progress }) {
  const groups = groupItems(items);
  return (
    <section className="cat-section">
      <div className="cat-section-head">
        <h2 className="cat-section-title">
          {title}
          <span className="cat-section-count">{items.length}</span>
        </h2>
        {subtitle && <span className="cat-section-sub">{subtitle}</span>}
      </div>
      {items.length === 0 ? (
        <div className="cat-empty">
          <Film size={32} strokeWidth={1.25} />
          <span>{emptyMessage}</span>
        </div>
      ) : (
        <div className="grid">
          {groups.map((g) => g.type === 'single' ? (
            <MovieCard
              key={g.key}
              movie={g.item}
              active={g.item.id === activeId}
              onClick={() => onSelect && onSelect(g.item)}
              canSelect={canSelect}
              progress={progress}
            />
          ) : (
            <SeriesCard
              key={g.key}
              group={g}
              activeId={activeId}
              onSelectEpisode={(ep) => onSelect && onSelect(ep)}
              canSelect={canSelect}
              progress={progress}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function CatalogueView({ catalog, activeId, onSelect, canSelect, progress = {}, connected, hasApiKey, onOpenSettings, isHost, onRescan, onPickFolder, scanning, hideServerSection, streamTitle = 'Stream' }) {
  const total = (catalog.catalogue?.length || 0) + (catalog.stream?.length || 0);
  return (
    <div className="catalogue-view">
      {isHost && (onRescan || onPickFolder) && (
        <div className="catalogue-toolbar">
          {onPickFolder && (
            <button onClick={onPickFolder} disabled={scanning} title="Choisir le dossier où sont les films">
              <Folder size={14} strokeWidth={1.75} />
              Changer le dossier
            </button>
          )}
          {onRescan && (
            <button onClick={onRescan} disabled={scanning} title="Rescanner le dossier de films">
              <RefreshCw size={14} strokeWidth={1.75} className={scanning ? 'spin' : ''} />
              {scanning ? 'Actualisation…' : 'Actualiser'}
            </button>
          )}
        </div>
      )}
      {!hasApiKey && total > 0 && isHost && (
        <div className="catalogue-banner">
          Pas d'affiches ?
          <button className="link" onClick={onOpenSettings}>Configurez votre clé TMDB</button>
          pour récupérer les images depuis themoviedb.org.
        </div>
      )}
      {!hideServerSection && (
        <Section
          title="Catalogue"
          subtitle="Films hébergés sur le serveur — bientôt disponible"
          items={catalog.catalogue || []}
          progress={progress}
          activeId={activeId}
          onSelect={onSelect}
          canSelect={canSelect}
          emptyMessage="Aucun film sur le serveur pour le moment"
        />
      )}
      <Section
        title={streamTitle}
        subtitle={isHost ? "Films de votre bibliothèque locale" : "Films partagés par l'hôte"}
        items={catalog.stream || []}
        progress={progress}
        activeId={activeId}
        onSelect={onSelect}
        canSelect={canSelect}
        emptyMessage={connected
          ? (isHost ? "Choisissez un dossier dans le Salon pour scanner vos films" : "L'hôte n'a pas encore partagé de films")
          : "Rejoignez un salon pour découvrir les films partagés"}
      />
    </div>
  );
}
