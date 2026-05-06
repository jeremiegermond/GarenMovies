function MovieCard({ movie, active, onClick, canSelect }) {
  const poster = movie.meta?.poster;
  const year = movie.meta?.year;
  return (
    <div
      className={`card ${active ? 'active' : ''} ${canSelect ? 'clickable' : ''}`}
      onClick={canSelect ? onClick : undefined}
      title={movie.title}
    >
      <div className="card-poster">
        {poster ? (
          <img src={poster} alt={movie.title} loading="lazy" />
        ) : (
          <div className="card-placeholder">
            <span>🎞️</span>
          </div>
        )}
        {movie.subs?.length > 0 && (
          <div className="card-subs" title={movie.subs.map(s => s.label).join(', ')}>CC</div>
        )}
      </div>
      <div className="card-info">
        <div className="card-title">{movie.title}</div>
        {year && <div className="card-year">{year}</div>}
      </div>
    </div>
  );
}

function Section({ title, items, activeId, onSelect, canSelect, emptyMessage }) {
  return (
    <section className="cat-section">
      <h2>{title} <span className="muted">({items.length})</span></h2>
      {items.length === 0 ? (
        <div className="cat-empty">{emptyMessage}</div>
      ) : (
        <div className="grid">
          {items.map((m) => (
            <MovieCard
              key={m.id}
              movie={m}
              active={m.id === activeId}
              onClick={() => onSelect && onSelect(m)}
              canSelect={canSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function CatalogueView({ catalog, activeId, onSelect, canSelect, connected, hasApiKey, onOpenSettings }) {
  const total = (catalog.catalogue?.length || 0) + (catalog.stream?.length || 0);
  return (
    <div className="catalogue-view">
      {!hasApiKey && total > 0 && (
        <div className="banner">
          Pas d'images de films ? <button className="link" onClick={onOpenSettings}>Configure ta clé TMDB</button> pour récupérer les affiches.
        </div>
      )}
      <Section
        title="🎬 Catalogue"
        items={catalog.catalogue || []}
        activeId={activeId}
        onSelect={onSelect}
        canSelect={canSelect}
        emptyMessage="Pas encore de films sur le serveur — bientôt disponible"
      />
      <Section
        title="📡 Stream"
        items={catalog.stream || []}
        activeId={activeId}
        onSelect={onSelect}
        canSelect={canSelect}
        emptyMessage={connected
          ? "L'hôte n'a pas encore partagé de films"
          : "Pas de films encore — connecte-toi à une room pour regarder"}
      />
    </div>
  );
}
