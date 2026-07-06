import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, X, Check } from 'lucide-react';

const STEPS = ['Disponible', 'Téléchargement', 'Installation'];
const fmtMB = (b) => (Number(b || 0) / 1024 / 1024).toFixed(1);

export default function UpdateModal() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.update?.onStatus) return;
    return window.electronAPI.update.onStatus((s) => {
      setStatus(s);
      // A real update event re-opens the modal even if it was dismissed before.
      if (['available', 'downloading', 'downloaded'].includes(s.phase)) setDismissed(false);
    });
  }, []);

  // Dev-only: Ctrl+Shift+U replays the whole update flow so the UI can be
  // previewed without publishing two releases. Stripped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e) => {
      if (!(e.ctrlKey && e.shiftKey && (e.key === 'u' || e.key === 'U'))) return;
      const total = 222_686_760;
      setDismissed(false);
      setStatus({ phase: 'available', version: '9.9.9' });
      let pct = 0;
      const t = setInterval(() => {
        pct += 6;
        if (pct >= 100) { clearInterval(t); setStatus({ phase: 'downloaded', version: '9.9.9' }); }
        else setStatus({ phase: 'downloading', percent: pct, transferred: (pct / 100) * total, total, bytesPerSecond: 8_500_000 });
      }, 350);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!status || dismissed) return null;
  const { phase } = status;
  // Stay silent on checking / up-to-date / transient errors — nothing to show.
  if (phase === 'checking' || phase === 'none' || phase === 'error') return null;

  const stepIndex = phase === 'available' ? 0 : phase === 'downloading' ? 1 : 2;

  return (
    <div className="update-backdrop">
      <div className="update-modal">
        <button className="update-close" onClick={() => setDismissed(true)} title="Fermer"><X size={16} /></button>
        <div className="update-icon">
          {phase === 'downloaded' ? <CheckCircle2 size={26} strokeWidth={1.75} /> : <Download size={26} strokeWidth={1.75} />}
        </div>
        <div className="update-title">
          {phase === 'available' && `Mise à jour ${status.version ? 'v' + status.version : ''} disponible`}
          {phase === 'downloading' && 'Téléchargement de la mise à jour…'}
          {phase === 'downloaded' && `Version ${status.version ? 'v' + status.version : ''} prête à installer`}
        </div>

        <div className="update-steps">
          {STEPS.map((label, i) => (
            <div key={i} className={`update-step ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}>
              <span className="update-step-dot">{i < stepIndex ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>

        {phase === 'downloading' && (
          <div className="update-progress">
            <div className="update-bar"><div className="update-bar-fill" style={{ width: `${status.percent || 0}%` }} /></div>
            <div className="update-progress-meta">
              <span>{status.percent || 0}%</span>
              <span>{fmtMB(status.transferred)} / {fmtMB(status.total)} Mo · {fmtMB(status.bytesPerSecond)} Mo/s</span>
            </div>
          </div>
        )}

        <div className="update-actions">
          {phase === 'available' && (
            <>
              <button className="ghost" onClick={() => setDismissed(true)}>Plus tard</button>
              <button className="primary" onClick={() => window.electronAPI?.update?.download?.().catch(() => {})}>
                <Download size={14} strokeWidth={2} /> Télécharger
              </button>
            </>
          )}
          {phase === 'downloading' && (
            <button className="ghost" onClick={() => setDismissed(true)}>Masquer</button>
          )}
          {phase === 'downloaded' && (
            <>
              <button className="ghost" onClick={() => setDismissed(true)}>Plus tard</button>
              <button className="primary" onClick={() => window.electronAPI?.update?.install?.().catch(() => {})}>
                <RefreshCw size={14} strokeWidth={2} /> Redémarrer et installer
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
