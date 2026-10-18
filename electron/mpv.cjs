// Native mpv player control for "solo" mode. Spawns a bundled mpv.exe with its
// own window and drives it over the JSON IPC named pipe (play/pause/seek + live
// position/duration). mpv decodes everything (HEVC 10-bit included) instantly,
// with no transcoding — that's the whole point of solo mode.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

function mpvBinaryPath() {
  // dev: repo bin/, packaged: extraResources → resources/mpv/mpv.exe
  const dev = path.join(__dirname, '..', 'bin', 'mpv', 'mpv.exe');
  if (fs.existsSync(dev)) return dev;
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'mpv', 'mpv.exe');
    if (fs.existsSync(packed)) return packed;
  }
  return dev; // best guess; caller handles spawn error
}

class MpvPlayer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.reqId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  isRunning() { return !!this.proc; }

  async start(opts = {}) {
    if (this.proc) return;
    const pipe = `\\\\.\\pipe\\garen-mpv-${process.pid}`;
    const bin = mpvBinaryPath();
    if (!fs.existsSync(bin)) throw new Error('mpv introuvable (binaire non installé)');
    const args = [
      '--idle=yes',
      '--no-terminal',
      '--keep-open=yes',       // don't close the window at end of file
      '--sub-auto=fuzzy',      // auto-load sidecar .srt next to the video
      '--osc=no',              // no mpv OSC — the app's floating bar is the UI
      '--cursor-autohide=1000', // hide the cursor over the video after 1s idle
      '--input-default-bindings=no',
      `--input-ipc-server=${pipe}`
    ];
    if (opts.wid) {
      // Embed mpv's rendering into an existing window (the app's video area).
      args.push(`--wid=${opts.wid}`);
    } else {
      args.push('--force-window=immediate'); // fallback: mpv's own window
    }
    this.proc = spawn(bin, args, { windowsHide: false });
    this.proc.on('exit', () => { this._cleanup(); this.emit('stopped'); });
    this.proc.on('error', (e) => { this._cleanup(); this.emit('error', e); });
    await this._connect(pipe);
    // Stream live state back to the app.
    this._send(['observe_property', 1, 'time-pos']);
    this._send(['observe_property', 2, 'duration']);
    this._send(['observe_property', 3, 'pause']);
    // With --keep-open the file isn't unloaded at the end (no end-file event):
    // mpv pauses on the last frame and flips eof-reached instead.
    this._send(['observe_property', 4, 'eof-reached']);
  }

  _cleanup() { this.proc = null; this.sock = null; this.buf = ''; this.pending.clear(); }

  _connect(pipe) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const s = net.connect(pipe);
        s.on('connect', () => { this.sock = s; this._wire(s); resolve(); });
        s.on('error', () => {
          s.destroy();
          if (++tries > 60) return reject(new Error('mpv IPC: connexion impossible'));
          setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  _wire(sock) {
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'property-change') this.emit('property', msg.name, msg.data);
        else if (msg.event === 'end-file') this.emit('end');
        else if (msg.request_id != null && this.pending.has(msg.request_id)) {
          const { resolve } = this.pending.get(msg.request_id);
          this.pending.delete(msg.request_id);
          resolve(msg.data);
        }
      }
    });
    sock.on('error', () => {});
  }

  _send(command) {
    if (!this.sock) return Promise.reject(new Error('mpv non connecté'));
    const request_id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      try { this.sock.write(JSON.stringify({ command, request_id }) + '\n'); }
      catch (e) { this.pending.delete(request_id); return reject(e); }
      setTimeout(() => {
        if (this.pending.has(request_id)) { this.pending.delete(request_id); reject(new Error('mpv: timeout commande')); }
      }, 5000);
    });
  }

  async loadFile(file, wid) { await this.start(wid ? { wid } : {}); return this._send(['loadfile', file, 'replace']); }
  play() { return this._send(['set_property', 'pause', false]).catch(() => {}); }
  pause() { return this._send(['set_property', 'pause', true]).catch(() => {}); }
  togglePause() { return this._send(['cycle', 'pause']).catch(() => {}); }
  seekAbsolute(t) { return this._send(['set_property', 'time-pos', Number(t) || 0]).catch(() => {}); }
  setVolume(v) { return this._send(['set_property', 'volume', Math.max(0, Math.min(130, Number(v) || 0))]).catch(() => {}); }
  seekRelative(d) { return this._send(['seek', Number(d) || 0, 'relative']).catch(() => {}); }
  addSubtitle(path) { return this._send(['sub-add', path, 'select']).catch(() => {}); }
  // Toggle mpv's native OSC (floating control bar). 'auto' = show on hover
  // (used in fullscreen), 'never' = hidden (windowed → the app's bar is the UI).
  setOscVisible(mode) { return this._send(['script-message', 'osc-visibility', mode === 'auto' ? 'auto' : 'never', 'no-osd']).catch(() => {}); }
  // Inject a mouse-move so mpv's cursor-autohide keeps working even though the
  // embedded window doesn't forward real mouse events. Stopping these lets the
  // cursor (and any OSC) fade after --cursor-autohide.
  mouseMove(x, y) { return this._send(['mouse', Math.max(0, Math.round(x)), Math.max(0, Math.round(y))]).catch(() => {}); }
  async getPosition() { try { return await this._send(['get_property', 'time-pos']); } catch { return null; } }
  // Audio output routing: list the OS output devices and force mpv onto a
  // chosen one (e.g. the TV's HDMI), independent of the Windows default — so
  // only the film's sound goes to the TV while the rest of the PC stays put.
  async getAudioDevices() { try { return await this._send(['get_property', 'audio-device-list']) || []; } catch { return []; } }
  setAudioDevice(name) { return this._send(['set_property', 'audio-device', name || 'auto']).catch(() => {}); }
  stop() {
    if (!this.proc) return;
    try { this._send(['quit']); } catch {}
    try { this.proc.kill(); } catch {}
    this._cleanup();
  }
}

module.exports = new MpvPlayer();
