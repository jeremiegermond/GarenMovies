// Intro / credits skipping, shared by the web player (room host) and solo mode.
// Given the playback time and the markers found for the film, say what to do:
//   action 'skipIntro' → jump to the end of the opening (auto-skip on, first time)
//   action 'credits'   → the credits started on an episode with a next one:
//                        start the next-episode countdown (auto-skip on)
//   ui 'intro' | 'credits' → show the matching manual button instead
// Films never end on their own at the credits (post-credits scenes!): they only
// get a "Passer le générique" button.
export function skipStep(t, markers, { introDone, creditsDone, autoSkip, hasNext, duration }) {
  const intro = markers?.intro;
  const credits = markers?.credits;
  if (intro && t >= intro.start && t < intro.end - 1) {
    if (autoSkip && !introDone) return { action: 'skipIntro', ui: null };
    return { action: null, ui: 'intro' };
  }
  if (credits && !creditsDone && t >= credits.start && (!duration || t < duration - 1)) {
    if (autoSkip && hasNext) return { action: 'credits', ui: null };
    return { action: null, ui: 'credits' };
  }
  return { action: null, ui: null };
}

// Off by default: the viewer clicks "Passer l'intro" / "Épisode suivant".
// (v0.11.0 used `autoSkipCredits`, on by default — saving the settings then
// stored `true` without anyone choosing it, so that key is ignored.)
export const AUTO_SKIP_KEY = 'autoSkip';
export const autoSkipFromConfig = (cfg) => cfg?.[AUTO_SKIP_KEY] === true;
