// Automatic subtitle sync (server side: electron/server/subsync.cjs) — on by
// default, can be turned off in the settings.
export const AUTO_SUB_SYNC_KEY = 'autoSubSync';
export const autoSubSyncFromConfig = (cfg) => cfg?.[AUTO_SUB_SYNC_KEY] !== false;

// "+1.25 s" / "−0.40 s"
export const formatShift = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(2)} s`;
