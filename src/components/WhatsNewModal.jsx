import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { entriesSince, allEntries, SHOW_CHANGELOG_EVENT } from '../lib/changelog.js';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : '';
}
// Changelog lines use **bold** for the headline of a feature.
function Line({ text }) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))}</>;
}

// Small dismissible "Quoi de neuf ?" card shown once after an update, listing
// everything since the last version this user saw (skipped updates add up).
// Settings can reopen it with the whole history.
export default function WhatsNewModal() {
  const [view, setView] = useState(null); // { entries, since, full }

  useEffect(() => {
    const api = window.electronAPI?.whatsNew;
    if (!api) return;
    api.info().then(({ current, lastSeen }) => {
      if (!lastSeen) { api.seen(); return; } // fresh install: nothing "new" yet
      const entries = entriesSince(lastSeen, current);
      if (entries.length) setView({ entries, since: lastSeen, current });
      else if (lastSeen !== current) api.seen();
    }).catch(() => {});
    const onShow = () => api.info().then(({ current }) => setView({ entries: allEntries(current), full: true, current })).catch(() => {});
    window.addEventListener(SHOW_CHANGELOG_EVENT, onShow);
    return () => window.removeEventListener(SHOW_CHANGELOG_EVENT, onShow);
  }, []);

  if (!view) return null;
  function close() {
    if (!view.full) window.electronAPI?.whatsNew?.seen();
    setView(null);
  }
  const several = view.entries.length > 1;
  const title = view.full ? 'Toutes les nouveautés' : several ? `Quoi de neuf depuis la v${view.since} ?` : `Quoi de neuf dans la v${view.entries[0].version} ?`;

  return (
    <div className="whatsnew" role="dialog" aria-label={title}>
      <div className="whatsnew-head">
        <div className="whatsnew-icon"><Sparkles size={15} strokeWidth={2} /></div>
        <div className="whatsnew-title">{title}</div>
        <button className="whatsnew-close" onClick={close} title="Fermer"><X size={15} /></button>
      </div>
      <div className="whatsnew-body">
        {view.entries.map((e) => (
          <section key={e.version} className="whatsnew-version">
            {(several || view.full) && (
              <div className="whatsnew-version-label">v{e.version}<span>{fmtDate(e.date)}</span></div>
            )}
            <ul>
              {e.items.map((item, i) => <li key={i}><Line text={item} /></li>)}
            </ul>
          </section>
        ))}
      </div>
      <button className="primary whatsnew-ok" onClick={close}>OK</button>
    </div>
  );
}
