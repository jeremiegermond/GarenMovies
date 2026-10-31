const fs = require('fs');
const path = require('path');

// Where each film / episode was left ("reprendre là où on en était"). Fed by
// the host's playback position, keyed by media id (a hash of the file path, so
// it survives rescans), saved in userData/progress.json.
//   { [mediaId]: { pos, dur, at, done } }   pos/dur in seconds, at = Date.now()

const MIN_POS = 30;           // the first seconds don't count (and never erase a saved position)
const DONE_SHARE = 0.95;      // past 95 %…
const DONE_LEFT = 90;         // …or with less than 90 s left: watched

let file = null;
let data = {};
let saveTimer = null;

function setFile(p) {
  file = p;
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; } catch { data = {}; }
}

function save() {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { /* ignore */ }
  }, 3000);
}

// Returns true when something worth telling the viewers changed.
function record(media, pos) {
  const dur = media?.duration || 0;
  if (!media || !dur || !(pos >= MIN_POS)) return false;
  const done = pos >= dur * DONE_SHARE || dur - pos <= DONE_LEFT;
  const prev = data[media.id];
  data[media.id] = { pos: done ? 0 : Math.round(pos), dur: Math.round(dur), at: Date.now(), done };
  save();
  return !prev || prev.done !== done || Math.abs(prev.pos - data[media.id].pos) >= 5;
}

function all() { return data; }

module.exports = { setFile, record, all };
