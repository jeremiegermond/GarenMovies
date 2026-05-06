export default function Catalog({ items, activeId, onPick, emptyHint }) {
  if (!items || items.length === 0) {
    return <div className="catalog-empty">{emptyHint || 'Aucun film pour l\'instant'}</div>;
  }
  return (
    <div className="catalog">
      {items.map((m) => (
        <div
          key={m.id}
          className={`movie ${m.id === activeId ? 'active' : ''}`}
          onClick={() => onPick && onPick(m)}
          title={m.title}
        >
          <span className="title">{m.title}</span>
          <span className="source">{m.source?.ext || ''}</span>
        </div>
      ))}
    </div>
  );
}
