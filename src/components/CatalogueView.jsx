import { Film, Play } from 'lucide-react';

function MovieCard({ movie, active, onClick, canSelect }) {
  const poster = movie.meta?.poster;
  const year = movie.meta?.year;
  const hasSubs = movie.subs?.length > 0;
  return (
    <button
      type="button"
      className={`card ${active ? 'active' : ''} ${canSelect ? 'clickable' : ''}`}
      onClick={canSelect ? onClick : undefined}
      title={movie.title}
      disabled={!canSelect}
    >
      <div className="card-poster">
        {poster ? (
          <img src={poster} alt={movie.title} loading="lazy" />
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
      </div>
      <div className="card-info">
        <div className="card-title">{movie.title}</div>
        {year && <div className="card-year">{year}</div>}
      </div>
    </button>
  );
}

function Section({ title, subtitle, items, activeId, onSelect, canSelect, emptyMessage }) {
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

export default function CatalogueView({ catalog, activeId, onSelect, canSelect, connected, hasApiKey, onOpenSettings, isHost }) {
  const total = (catalog.catalogue?.length || 0) + (catalog.stream?.length || 0);
  return (
    <div className="catalogue-view">
      {!hasApiKey && total > 0 && isHost && (
        <div className="catalogue-banner">
          Pas d'affiches ?
          <button className="link" onClick={onOpenSettings}>Configurez votre clé TMDB</button>
          pour récupérer les images depuis themoviedb.org.
        </div>
      )}
      <Section
        title="Catalogue"
        subtitle="Films hébergés sur le serveur — bientôt disponible"
        items={catalog.catalogue || []}
        activeId={activeId}
        onSelect={onSelect}
        canSelect={canSelect}
        emptyMessage="Aucun film sur le serveur pour le moment"
      />
      <Section
        title="Stream"
        subtitle={isHost ? "Films de votre bibliothèque locale" : "Films partagés par l'hôte"}
        items={catalog.stream || []}
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
