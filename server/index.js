/* StreamWall — self-hosted multi-stream video wall
 * Serves: /        phone remote (PWA)
 *         /tv      TV display page
 *         /api     REST (state, streams, library)
 *         /ws      WebSocket state sync
 *         /media   local video files (range requests supported)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Never let a single bad request, failed fetch, or WebSocket hiccup kill the
// whole process. Before this, an uncaught error crashed Node and Docker took
// ~a minute to restart — during which every device got "connection refused".
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));

const PORT = process.env.PORT || 8080;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STREAMS_FILE = path.join(DATA_DIR, 'streams.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const RECENT_FILE = path.join(DATA_DIR, 'recent.json');
const STARTED_AT = Date.now();

// ---------- persistence ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    fs.writeFileSync(STREAMS_FILE, JSON.stringify(streams, null, 2));
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
    fs.writeFileSync(RECENT_FILE, JSON.stringify(recent, null, 2));
  }, 300);
}

// ---------- state ----------
const defaultState = {
  power: true,                      // false = standby: TV dark, no upstream fetching
  sleepAt: null,                    // epoch ms → auto-standby (sleep timer), or null
  layout: 'single',                 // single | split-h | split-v | one-plus-two | grid
  slots: [{ source: null }, { source: null }, { source: null }, { source: null }],
  audio: 0,                         // slot index that has sound
  muted: false,                     // master mute
  playing: true,                    // global play/pause (files + HLS)
  widgets: [],                      // [{id, type:'text'|'score'|'clock'|'custom', x, y, data}]
  rects: [                          // free-layout position/size per slot, in % (may exceed 100)
    { x: 2, y: 2, w: 60, h: 60 },
    { x: 64, y: 2, w: 34, h: 45 },
    { x: 64, y: 50, w: 34, h: 45 },
    { x: 2, y: 65, w: 40, h: 33 }
  ]
};
let state = Object.assign({}, defaultState, loadJson(STATE_FILE, {}));
if (!Array.isArray(state.slots) || state.slots.length !== 4) state.slots = defaultState.slots;
if (!Array.isArray(state.widgets)) state.widgets = [];
if (!Array.isArray(state.rects) || state.rects.length !== 4) state.rects = defaultState.rects;
// migrate single-audio-slot model → per-slot volume mixing
state.slots.forEach((s, i) => {
  if (typeof s.volume !== 'number') s.volume = (state.audio === i ? 100 : 0);
});

let streams = loadJson(STREAMS_FILE, []); // [{id, name, url}]
let presets = loadJson(PRESETS_FILE, []); // [{id, name, snapshot}]
let recent = loadJson(RECENT_FILE, []);   // [{url, name, type, at}] newest first

// Remember everything that gets played so the remote can offer "Recent".
function noteRecent(src) {
  if (!src || !src.url) return;
  recent = recent.filter(r => r.url !== src.url);
  recent.unshift({ url: src.url, name: src.name || src.url, type: src.type || 'stream', at: Date.now() });
  if (recent.length > 20) recent.length = 20;
}

function applyPatch(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const key of ['layout', 'audio', 'muted', 'playing', 'power']) {
    if (key in patch) state[key] = patch[key];
  }
  if ('sleepAt' in patch) {
    const t = Number(patch.sleepAt);
    state.sleepAt = t > Date.now() ? t : null;
  }
  // switching the wall off cancels any pending sleep timer
  if (patch.power === false) state.sleepAt = null;
  if (Array.isArray(patch.widgets)) state.widgets = patch.widgets;
  if (Array.isArray(patch.rects) && patch.rects.length === 4) state.rects = patch.rects;
  if (patch.slots && typeof patch.slots === 'object') {
    for (const [idx, val] of Object.entries(patch.slots)) {
      const i = Number(idx);
      if (i >= 0 && i < 4 && val && typeof val === 'object') {
        const slot = state.slots[i] || { source: null };
        if ('source' in val) {
          slot.source = val.source || null;
          noteRecent(slot.source);
        }
        if ('paused' in val) slot.paused = !!val.paused;
        if ('fit' in val) slot.fit = val.fit === 'cover' ? 'cover' : 'contain';
        if ('quality' in val) slot.quality = String(val.quality || 'best').toLowerCase().replace(/[^a-z0-9_,]/g, '').slice(0, 20) || 'best';
        if ('volume' in val) slot.volume = Math.max(0, Math.min(100, Number(val.volume) || 0));
        state.slots[i] = slot;
      }
    }
  }
  saveSoon();
}

// ---------- media library ----------
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ts', '.mp3', '.m3u8']);
function walk(dir, base, depth, out) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel, depth + 1, out);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      out.push({ name: e.name, path: rel, size });
    }
  }
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.use('/media', express.static(MEDIA_DIR, { acceptRanges: true }));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'remote.html')));
app.get('/tv', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tv.html')));

// Serve hls.js from our own origin so the TV never depends on an external CDN.
// Many TV browsers can't reach jsdelivr, which silently broke HLS playback
// (page fell back to native HLS → black screen on Android TV browsers).
let hlsJsCache = null;
app.get('/vendor/hls.min.js', async (_req, res) => {
  try {
    if (!hlsJsCache) {
      const r = await fetch('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js');
      if (!r.ok) throw new Error('CDN HTTP ' + r.status);
      hlsJsCache = Buffer.from(await r.arrayBuffer());
      console.log('[vendor] cached hls.js (' + hlsJsCache.length + ' bytes)');
    }
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(hlsJsCache);
  } catch (e) {
    console.error('[vendor hls.js]', e && e.message);
    res.status(502).send('/* hls.js fetch failed: ' + (e && e.message) + ' */');
  }
});

app.get('/api/state', (_req, res) => res.json(state));
app.post('/api/state', (req, res) => {
  applyPatch(req.body);
  broadcastState();
  res.json(state);
});

app.get('/api/library', (_req, res) => {
  const out = [];
  walk(MEDIA_DIR, '', 0, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  res.json(out);
});

// ---- Twitch HLS resolution ----
// The Twitch embed player refuses plain-HTTP/LAN-IP parents, so instead we
// resolve the channel/VOD to its HLS playlist (the same public API their own
// web player uses) and play it directly with hls.js.
//
// IMPORTANT: the public web Client-ID may ONLY run Twitch's *persisted*
// queries — sending a raw GraphQL query is rejected with HTTP 400. So we use
// the persisted-query hash for PlaybackAccessToken. When Twitch withholds an
// anonymous token (empty token → the old "offline" symptom) it usually wants a
// device *integrity* token first, so we fetch one and retry with it.
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h0ko';
// Optional: your twitch.tv session token (the "auth-token" cookie). When set,
// streamlink authenticates as YOU → ad-free on subscribed channels / Turbo,
// sub-only VODs, and /api/twitch/followed lists your followed live channels.
const TWITCH_AUTH = (process.env.TWITCH_AUTH_TOKEN || '').trim();
const TWITCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TWITCH_PAT_HASH = '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712';
// Stable per-process identifiers (rotating them every request looks bot-like).
const TWITCH_DEVICE_ID = crypto.randomBytes(16).toString('hex');
const TWITCH_SESSION_ID = crypto.randomBytes(16).toString('hex');

function twitchHeaders(integrity) {
  const h = {
    'Client-ID': TWITCH_CLIENT_ID,
    'Content-Type': 'application/json',
    'Device-ID': TWITCH_DEVICE_ID,
    'X-Device-Id': TWITCH_DEVICE_ID,
    'Client-Session-Id': TWITCH_SESSION_ID,
    'User-Agent': TWITCH_UA,
    'Origin': 'https://www.twitch.tv',
    'Referer': 'https://www.twitch.tv/'
  };
  if (TWITCH_AUTH) h['Authorization'] = 'OAuth ' + TWITCH_AUTH;
  if (integrity) h['Client-Integrity'] = integrity;
  return h;
}

// Best-effort: acquire a device integrity token. If Twitch's anti-bot wall
// (Kasada) blocks it, this returns null and we just proceed without one.
let twitchIntegrityCache = { token: null, exp: 0 };
async function twitchIntegrity() {
  if (twitchIntegrityCache.token && Date.now() < twitchIntegrityCache.exp) return twitchIntegrityCache.token;
  try {
    const r = await fetch('https://gql.twitch.tv/integrity', { method: 'POST', headers: twitchHeaders() });
    if (!r.ok) { console.error('[twitch integrity] HTTP', r.status); return null; }
    const j = await r.json();
    if (j && j.token) {
      twitchIntegrityCache = { token: j.token, exp: (j.expiration || (Date.now() + 6 * 3600e3)) - 60000 };
      return j.token;
    }
  } catch (e) { console.error('[twitch integrity]', e && e.message); }
  return null;
}

// Primary resolver: shell out to streamlink, which handles Twitch's token +
// integrity + ad handling itself and stays current with Twitch's changes.
// execFile (no shell) + sanitized args = no injection risk.
const { execFile } = require('child_process');
function streamlinkResolve(pageUrl, quality) {
  // quality: streamlink stream selector, e.g. "720p60,best". Sanitized upstream.
  const args = ['--stream-url', '--twitch-disable-ads', '--hls-live-edge', '3'];
  if (TWITCH_AUTH) args.push('--twitch-api-header', 'Authorization=OAuth ' + TWITCH_AUTH);
  args.push(pageUrl, quality || 'best');
  return new Promise(resolve => {
    execFile('streamlink',
      args,
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') console.error('[streamlink] not installed in image');
          else console.error('[streamlink]', String(stderr || err.message || '').trim().slice(0, 300));
          return resolve(null);
        }
        const url = String(stdout).trim();
        resolve(/^https?:\/\//.test(url) ? url : null);
      });
  });
}

async function twitchToken(login, vodID, playerType, integrity) {
  const isVod = !!vodID;
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: twitchHeaders(integrity),
    body: JSON.stringify({
      operationName: 'PlaybackAccessToken',
      extensions: { persistedQuery: { version: 1, sha256Hash: TWITCH_PAT_HASH } },
      variables: { isLive: !isVod, login: (login || '').toLowerCase(), isVod, vodID: vodID || '', playerType: playerType || 'site' }
    })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('[twitch gql] HTTP ' + r.status + ' body:', body.slice(0, 300));
    throw new Error('Twitch GQL HTTP ' + r.status);
  }
  const j = await r.json();
  if (j.errors) throw new Error((j.errors[0] && j.errors[0].message) || 'Twitch GQL error');
  const tok = isVod ? (j.data && j.data.videoPlaybackAccessToken) : (j.data && j.data.streamPlaybackAccessToken);
  // when the token is null, log the raw payload once so the real cause is visible
  if (!tok) console.error('[twitch] empty token (' + playerType + (integrity ? '/integrity' : '') + '):', JSON.stringify(j).slice(0, 400));
  return tok;
}

// While in standby, refuse the heavy routes — guarantees zero upstream traffic
// (streamlink, yt-dlp, CDN fetches) until the wall is switched back on.
function standby(res) {
  if (state.power === false) { res.status(503).json({ error: 'standby' }); return true; }
  return false;
}

app.get('/api/resolve/twitch', async (req, res) => {
  if (standby(res)) return;
  const { channel, vod } = req.query;
  if (!channel && !vod) return res.status(400).json({ error: 'channel or vod required' });
  // sanitize to Twitch's allowed charset (also blocks arg injection into execFile)
  const ch = channel ? String(channel).toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
  const vd = vod ? String(vod).replace(/[^0-9]/g, '') : '';
  // quality selector, e.g. "720p60" — always falls back to best if unavailable
  const q = String(req.query.quality || 'best').toLowerCase().replace(/[^a-z0-9_,]/g, '');
  const selector = (!q || q === 'best') ? 'best' : q + ',best';
  try {
    // ---- Primary: streamlink (robust against Twitch's anti-bot) ----
    const pageUrl = ch ? 'https://www.twitch.tv/' + ch : 'https://www.twitch.tv/videos/' + vd;
    const slUrl = await streamlinkResolve(pageUrl, selector);
    if (slUrl) {
      try { console.log('[twitch] resolved', ch || vd, 'via streamlink →', new URL(slUrl).host); } catch {}
      return res.json({ url: slUrl, via: 'streamlink' });
    }

    // ---- Fallback: direct GQL token → usher (works when streamlink is absent) ----
    let tok = await twitchToken(ch, vd, 'site');
    if (!tok) {
      const integ = await twitchIntegrity();
      if (integ) tok = await twitchToken(ch, vd, 'site', integ);
    }
    if (!tok) tok = await twitchToken(ch, vd, 'embed');
    if (!tok) {
      return res.status(404).json({ error: 'could not resolve — channel offline, or Twitch is blocking this server (see container logs)' });
    }
    const params = new URLSearchParams({
      token: tok.value, sig: tok.signature,
      allow_source: 'true', allow_audio_only: 'true', player: 'twitchweb', fast_bread: 'true',
      p: String(Math.floor(Math.random() * 1e7))
    });
    const url = vd
      ? `https://usher.ttvnw.net/vod/${encodeURIComponent(vd)}.m3u8?${params}`
      : `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(ch)}.m3u8?${params}`;
    res.json({ url, via: 'gql' });
  } catch (e) {
    console.error('[twitch resolve]', e && e.message);
    res.status(502).json({ error: 'twitch resolve failed: ' + (e && e.message) });
  }
});

// ---- Twitch account: followed live channels ----
// Uses the documented validate endpoint to learn who the token belongs to,
// then Helix streams/followed. Both accept the twitch.tv website session token
// (its client-id IS the website client-id, so the pair matches).
let twitchUserCache = { id: null, exp: 0 };
let followedCache = { v: null, t: 0 };
async function twitchUserId() {
  if (twitchUserCache.id && Date.now() < twitchUserCache.exp) return twitchUserCache.id;
  const r = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': 'OAuth ' + TWITCH_AUTH }
  });
  if (!r.ok) throw new Error('token validate HTTP ' + r.status + ' — token expired/invalid? Re-copy the auth-token cookie.');
  const j = await r.json();
  if (!j.user_id) throw new Error('validate returned no user_id');
  twitchUserCache = { id: j.user_id, exp: Date.now() + 3600e3 };
  return j.user_id;
}
app.get('/api/twitch/followed', async (_req, res) => {
  if (!TWITCH_AUTH) return res.json({ enabled: false, streams: [] });
  if (followedCache.v && Date.now() - followedCache.t < 60000) return res.json(followedCache.v);
  try {
    const uid = await twitchUserId();
    const r = await fetch('https://api.twitch.tv/helix/streams/followed?first=50&user_id=' + uid, {
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + TWITCH_AUTH }
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('Helix HTTP ' + r.status + ' ' + body.slice(0, 200));
    }
    const j = await r.json();
    const out = {
      enabled: true,
      streams: (j.data || []).map(s => ({
        login: s.user_login, name: s.user_name, game: s.game_name || '',
        viewers: s.viewer_count || 0, title: s.title || '',
        startedAt: s.started_at || null,
        thumb: (s.thumbnail_url || '').replace('{width}', '320').replace('{height}', '180')
      }))
    };
    followedCache = { v: out, t: Date.now() };
    res.json(out);
  } catch (e) {
    console.error('[twitch followed]', e && e.message);
    res.status(502).json({ enabled: true, error: e.message, streams: [] });
  }
});

// ---- YouTube resolution via yt-dlp ----
// With a cookies file (export youtube.com cookies → data/youtube-cookies.txt)
// this plays as YOUR account: members-only + age-restricted content works, and
// --mark-watched records each video in your YouTube watch history.
// Prefers an HLS manifest (iOS client) so hls.js can play it through /api/hls.
const YT_COOKIES = path.join(DATA_DIR, 'youtube-cookies.txt');
app.get('/api/resolve/youtube', (req, res) => {
  if (standby(res)) return;
  const id = String(req.query.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return res.status(400).json({ error: 'id required' });
  const haveCookies = fs.existsSync(YT_COOKIES);
  const args = ['-j', '--no-warnings', '--no-playlist',
    '--extractor-args', 'youtube:player_client=ios,web'];
  if (haveCookies) args.push('--cookies', YT_COOKIES, '--mark-watched');
  args.push('https://www.youtube.com/watch?v=' + id);
  execFile('yt-dlp', args, { timeout: 45000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const msg = err.code === 'ENOENT' ? 'yt-dlp not installed in image — rebuild with the updated Dockerfile'
        : String(stderr || err.message || '').trim().slice(-400);
      console.error('[youtube resolve]', msg);
      return res.status(502).json({ error: msg });
    }
    try {
      const info = JSON.parse(stdout);
      // 1) whole-video HLS master (live streams + most VODs via iOS client)
      let url = info.manifest_url || null;
      let kind = 'hls';
      if (!url) {
        const fmts = info.formats || [];
        const hls = fmts.filter(f => /m3u8/.test(f.protocol || '') && f.vcodec !== 'none' && f.acodec !== 'none')
                        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (hls) url = hls.manifest_url || hls.url;
        else {
          // 2) best muxed progressive file (mp4)
          const prog = fmts.filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && /^https?:/.test(f.url || ''))
                           .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (prog) { url = prog.url; kind = 'direct'; }
        }
      }
      if (!url) return res.status(502).json({ error: 'no playable format found' });
      console.log('[youtube] resolved', id, kind + (haveCookies ? ' (account)' : ' (anonymous)'));
      res.json({ url, kind, account: haveCookies, title: info.title || '' });
    } catch (e) {
      console.error('[youtube resolve] bad JSON:', e && e.message);
      res.status(502).json({ error: 'could not parse yt-dlp output' });
    }
  });
});

// ---- HLS proxy ----
// The TV's browser has no (reliable) external internet, so it can't fetch the
// resolved playlist/segments from Twitch's CDN directly — hls.js died with
// manifestLoadError. Instead the TV requests /api/hls?url=… from us, and WE
// fetch from the CDN. Playlists are rewritten so every nested URL (variant
// playlists, segments, EXT-X-MAP/KEY URIs) also routes back through this proxy.
const { Readable } = require('stream');
app.get('/api/hls', async (req, res) => {
  if (standby(res)) return;
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) return res.status(400).send('valid url required');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(target, {
      signal: ctrl.signal,
      headers: { 'User-Agent': TWITCH_UA, 'Referer': 'https://player.twitch.tv/' }
    });
    clearTimeout(t);
    if (!r.ok) {
      console.error('[hls proxy] HTTP', r.status, 'for', String(target).slice(0, 120));
      return res.status(r.status).end();
    }
    const ct = r.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(target).pathname);
    res.set('Cache-Control', 'no-store');
    if (isPlaylist) {
      const text = await r.text();
      const base = new URL(target);
      const prox = u => { try { return '/api/hls?url=' + encodeURIComponent(new URL(u, base).href); } catch { return u; } };
      const out = text.split('\n').map(line => {
        const l = line.trim();
        if (!l) return line;
        if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => 'URI="' + prox(u) + '"');
        return prox(l);
      }).join('\n');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(out);
    }
    // segment (binary) — stream it through without buffering
    res.set('Content-Type', ct || 'video/mp2t');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    console.error('[hls proxy]', e && e.message);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  }
});

// ---- Presets: save/recall full wall setups ----
app.get('/api/presets', (_req, res) =>
  res.json(presets.map(p => ({ id: p.id, name: p.name }))));
app.post('/api/presets', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const p = {
    id: crypto.randomUUID(),
    name,
    snapshot: JSON.parse(JSON.stringify({
      layout: state.layout, slots: state.slots, audio: state.audio,
      widgets: state.widgets, rects: state.rects
    }))
  };
  presets.push(p);
  saveSoon();
  res.json({ id: p.id, name: p.name });
});
app.post('/api/presets/:id/apply', (req, res) => {
  const p = presets.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  Object.assign(state, JSON.parse(JSON.stringify(p.snapshot)));
  saveSoon();
  broadcastState();
  res.json({ ok: true });
});
app.delete('/api/presets/:id', (req, res) => {
  presets = presets.filter(p => p.id !== req.params.id);
  saveSoon();
  res.json({ ok: true });
});

app.get('/api/streams', (_req, res) => res.json(streams));
app.post('/api/streams', (req, res) => {
  const { name, url, tags } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const s = {
    id: crypto.randomUUID(), name: name || url, url,
    tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : []
  };
  streams.push(s);
  saveSoon();
  res.json(s);
});

// ---- PandaScore CS2 (official API — requires PANDASCORE_TOKEN env var) ----
const PS_TOKEN = process.env.PANDASCORE_TOKEN;
const psCache = new Map();
async function fetchPS(path) {
  if (!PS_TOKEN) throw new Error('PANDASCORE_TOKEN not set — add it to docker-compose.yml');
  const hit = psCache.get(path);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const r = await fetch('https://api.pandascore.co' + path, {
    headers: { Authorization: 'Bearer ' + PS_TOKEN }
  });
  if (!r.ok) throw new Error('PandaScore HTTP ' + r.status);
  const v = await r.json();
  psCache.set(path, { t: Date.now(), v });
  return v;
}
function fmtPSMatch(m) {
  const opp = m.opponents || [];
  const res = m.results || [];
  return {
    id: m.id,
    name: m.name,
    team1: opp[0]?.opponent?.name || 'TBD',
    team1_short: opp[0]?.opponent?.acronym || 'TBD',
    team2: opp[1]?.opponent?.name || 'TBD',
    team2_short: opp[1]?.opponent?.acronym || 'TBD',
    score1: res[0]?.score ?? null,
    score2: res[1]?.score ?? null,
    event: m.league?.name || '',
    serie: m.serie?.full_name || '',
    best_of: m.number_of_games || null,
    begin_at: m.begin_at,
    status: m.status,
  };
}
app.get('/api/ps/live', async (_req, res) => {
  try {
    const data = await fetchPS('/csgo/matches/running?per_page=10&sort=-begin_at');
    res.json({ count: data.length, matches: data.map(fmtPSMatch) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ps/upcoming', async (_req, res) => {
  try {
    const data = await fetchPS('/csgo/matches/upcoming?per_page=10&sort=begin_at');
    res.json({ count: data.length, matches: data.map(fmtPSMatch) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ps/tournaments', async (_req, res) => {
  try {
    const data = await fetchPS('/csgo/tournaments/running?per_page=5&sort=-begin_at');
    res.json({
      count: data.length,
      tournaments: data.map(t => ({
        id: t.id,
        name: t.name,
        league: t.league?.name || '',
        serie: t.serie?.full_name || '',
        begin_at: t.begin_at,
        end_at: t.end_at,
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Counter-Strike data (bo3.gg public API — HLTV itself has no API and blocks scrapers) ----
const BO3 = 'https://api.bo3.gg/api/v1';
const csCache = new Map();
async function bo3(pathPart) {
  const hit = csCache.get(pathPart);
  if (hit && Date.now() - hit.t < 20000) return hit.v;
  const r = await fetch(BO3 + pathPart, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
  });
  if (!r.ok) throw new Error('bo3.gg HTTP ' + r.status);
  const v = await r.json();
  csCache.set(pathPart, { t: Date.now(), v });
  return v;
}
const slugify = q => String(q || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.]/g, '');
// NOTE: with=teams is required — without it the API omits the team1/team2 objects
const MATCH_LIST = '/matches?' + new URLSearchParams({
  'filter[matches.status][in]': 'current,upcoming',
  'page[limit]': '50',
  'sort': 'start_date',
  'with': 'teams'
}).toString();

app.get('/api/cs/search', async (req, res) => {
  const type = req.query.type, q = String(req.query.q || '').trim();
  try {
    if (type === 'player') {
      const p = await bo3('/players/' + slugify(q));
      return res.json([{ type, slug: p.slug, name: p.nickname, sub: (p.team && p.team.name) || 'no team' }]);
    }
    if (type === 'team') {
      const t = await bo3('/teams/' + slugify(q));
      return res.json([{ type, slug: t.slug, name: t.name, sub: t.rank ? 'World rank #' + t.rank : '' }]);
    }
    // matches: current + upcoming, optionally filtered by team name text
    const j = await bo3(MATCH_LIST);
    const ql = q.toLowerCase();
    const out = (j.results || [])
      .filter(m => m.team1 && m.team2)
      .filter(m => !ql || (m.team1.name + ' ' + m.team2.name).toLowerCase().includes(ql))
      .slice(0, 15)
      .map(m => ({
        type: 'match', slug: m.slug,
        name: m.team1.name + ' vs ' + m.team2.name,
        sub: (m.status === 'current' ? 'LIVE' : new Date(m.start_date).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })) + ' · BO' + m.bo_type
      }));
    res.json(out);
  } catch (e) {
    res.status(404).json({ error: 'not found — try the exact nickname/slug (' + e.message + ')' });
  }
});

app.get('/api/cs/player/:slug', async (req, res) => {
  try {
    const p = await bo3('/players/' + slugify(req.params.slug));
    res.json({
      nickname: p.nickname,
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      team: (p.team && p.team.name) || '—',
      teamRank: (p.team && p.team.rank) || null,
      rating: p.six_month_avg_rating != null ? Math.round(p.six_month_avg_rating * 100) / 100 : null,
      country: (p.country && p.country.name) || null,
      prize: p.total_prize || null
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Player's CURRENT match + their live stats when bo3.gg covers the match.
// Live per-player numbers ride on match.live_updates (only for covered matches,
// usually tier S/A) — we deep-scan it since its shape isn't documented.
function findPlayerStats(obj, nick, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (Array.isArray(obj)) {
    for (const x of obj) { const r = findPlayerStats(x, nick, depth + 1); if (r) return r; }
    return null;
  }
  const name = String(obj.nickname || obj.player_nickname || obj.name || '').toLowerCase();
  if (name === nick && (obj.kills != null || obj.deaths != null || obj.adr != null)) return obj;
  for (const k of Object.keys(obj)) {
    const r = findPlayerStats(obj[k], nick, depth + 1);
    if (r) return r;
  }
  return null;
}

app.get('/api/cs/playerlive/:slug', async (req, res) => {
  try {
    const p = await bo3('/players/' + slugify(req.params.slug));
    if (!p.team_id) return res.json({ nickname: p.nickname, match: null });
    const j = await bo3(MATCH_LIST);
    const list = (j.results || []).filter(m => m.team1_id === p.team_id || m.team2_id === p.team_id);
    const m = list.find(x => x.status === 'current') || list[0];
    if (!m) return res.json({ nickname: p.nickname, team: p.team && p.team.name, match: null });

    let stats = null;
    let mDetail = m;
    if (m.status === 'current') {
      try { mDetail = await bo3('/matches/' + m.slug); } catch {}
      const raw = findPlayerStats(mDetail.live_updates || m.live_updates, p.nickname.toLowerCase(), 0);
      if (raw) {
        stats = {};
        for (const k of ['kills', 'deaths', 'assists', 'adr', 'kast', 'headshots', 'first_kills', 'rating', 'money', 'kd_diff']) {
          if (raw[k] != null) stats[k] = raw[k];
        }
      }
    }
    res.json({
      nickname: p.nickname,
      team: (p.team && p.team.name) || null,
      match: {
        vs: m.team1_id === p.team_id ? (m.team2 && m.team2.name) : (m.team1 && m.team1.name),
        score: m.team1_id === p.team_id
          ? m.team1_score + ':' + m.team2_score
          : m.team2_score + ':' + m.team1_score,
        live1: m.team1_id === p.team_id ? m.team1_last_game_score : m.team2_last_game_score,
        live2: m.team1_id === p.team_id ? m.team2_last_game_score : m.team1_last_game_score,
        status: m.status,
        start: m.start_date,
        bo: m.bo_type,
        covered: !!(m.live_coverage || (mDetail && mDetail.live_coverage))
      },
      stats
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/cs/team/:slug', async (req, res) => {
  try {
    const t = await bo3('/teams/' + slugify(req.params.slug));
    let next = null;
    try {
      const j = await bo3(MATCH_LIST);
      const m = (j.results || []).find(x => x.team1_id === t.id || x.team2_id === t.id);
      if (m) next = {
        vs: m.team1_id === t.id ? (m.team2 && m.team2.name) : (m.team1 && m.team1.name),
        status: m.status,
        start: m.start_date,
        score: m.team1_score + ':' + m.team2_score
      };
    } catch {}
    res.json({
      name: t.name,
      rank: t.rank || null,
      players: (t.players || []).filter(p => !p.is_coach).map(p => p.nickname).slice(0, 6),
      next
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/cs/match/:slug', async (req, res) => {
  try {
    const m = await bo3('/matches/' + req.params.slug);
    let maps = [];
    try {
      const g = await bo3('/games?' + new URLSearchParams({ 'filter[games.match_id][eq]': m.id }).toString());
      maps = (g.results || []).sort((a, b) => (a.number || 0) - (b.number || 0)).map(x => ({
        map: (x.map_name || '').replace(/^de_/, ''),
        status: x.status || ''
      }));
    } catch {}
    // live_updates (covered matches): round number/phase, team sides, economy
    const lu = m.live_updates || null;
    res.json({
      team1: { name: (m.team1 && m.team1.name) || 'TBD', score: m.team1_score },
      team2: { name: (m.team2 && m.team2.name) || 'TBD', score: m.team2_score },
      status: m.status,
      bo: m.bo_type,
      start: m.start_date,
      live1: m.team1_last_game_score,
      live2: m.team2_last_game_score,
      maps,
      live: lu ? {
        map: (lu.map_name || '').replace(/^de_/, ''),
        round: lu.round_number,
        phase: lu.round_phase,
        gameEnded: !!lu.game_ended,
        gameNumber: lu.game_number,
        t1: lu.team_1 ? { side: lu.team_1.side, score: lu.team_1.game_score, eq: lu.team_1.equipment_value } : null,
        t2: lu.team_2 ? { side: lu.team_2.side, score: lu.team_2.game_score, eq: lu.team_2.equipment_value } : null
      } : null
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// ---- generic data proxy for custom widgets (avoids CORS on the TV) ----
app.get('/api/proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid url required' });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 StreamWall' } });
    clearTimeout(t);
    const text = await r.text();
    res.set('Content-Type', r.headers.get('content-type') || 'text/plain');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy failed: ' + e.message });
  }
});
// Edit a saved stream (name / url / tags)
app.put('/api/streams/:id', (req, res) => {
  const s = streams.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
  if (typeof b.url === 'string' && b.url.trim()) s.url = b.url.trim();
  if (Array.isArray(b.tags)) s.tags = b.tags.map(t => String(t).trim()).filter(Boolean);
  saveSoon();
  res.json(s);
});

app.get('/api/recent', (_req, res) => res.json(recent));
app.delete('/api/recent', (_req, res) => { recent = []; saveSoon(); res.json({ ok: true }); });

// ---- System status (shown in the remote's settings sheet) ----
const toolVersions = {};
function toolVersion(bin) {
  if (bin in toolVersions) return Promise.resolve(toolVersions[bin]);
  return new Promise(resolve => {
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      const v = err ? null : String(stdout).trim().split('\n')[0].replace(/^streamlink\s+/i, '');
      toolVersions[bin] = v;
      resolve(v);
    });
  });
}
app.get('/api/status', async (_req, res) => {
  let twitchUser = null, twitchError = null;
  if (TWITCH_AUTH) {
    try {
      const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': 'OAuth ' + TWITCH_AUTH } });
      if (r.ok) twitchUser = (await r.json()).login || null;
      else twitchError = 'token rejected (HTTP ' + r.status + ') — re-copy auth-token';
    } catch (e) { twitchError = e.message; }
  }
  const [streamlink, ytdlp] = await Promise.all([toolVersion('streamlink'), toolVersion('yt-dlp')]);
  res.json({
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    clients: wss.clients.size,
    displays: tvCount(),
    twitch: { configured: !!TWITCH_AUTH, user: twitchUser, error: twitchError },
    youtube: { cookies: fs.existsSync(YT_COOKIES) },
    pandascore: !!PS_TOKEN,
    tools: { streamlink, ytdlp },
    media: (() => { const o = []; walk(MEDIA_DIR, '', 0, o); return o.length; })()
  });
});

app.delete('/api/streams/:id', (req, res) => {
  streams = streams.filter(s => s.id !== req.params.id);
  saveSoon();
  res.json({ ok: true });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
server.on('error', e => console.error('[http server error]', e && e.message));
wss.on('error', e => console.error('[wss error]', e && e.message));

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === WebSocket.OPEN) {
      try { c.send(data); } catch (e) { console.error('[ws send]', e && e.message); }
    }
  }
}
function broadcastState() {
  broadcast({ type: 'state', state });
}

// Presence: TV pages announce themselves ({type:'hello', role:'tv'}) so the
// remote can warn when no display is connected.
function tvCount() {
  let n = 0;
  for (const c of wss.clients) if (c.role === 'tv' && c.readyState === WebSocket.OPEN) n++;
  return n;
}
function broadcastPresence() { broadcast({ type: 'presence', tvs: tvCount() }); }

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('error', e => console.error('[ws client error]', e && e.message));
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { if (ws.role === 'tv') broadcastPresence(); });
  try { ws.send(JSON.stringify({ type: 'state', state })); } catch {}
  try { ws.send(JSON.stringify({ type: 'presence', tvs: tvCount() })); } catch {}
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'hello') {
        ws.role = msg.role === 'tv' ? 'tv' : 'remote';
        if (ws.role === 'tv') broadcastPresence();
      } else if (msg.type === 'patch') {
        applyPatch(msg.patch);
        broadcastState();
      } else if (msg.type === 'cmd') {
        // e.g. {type:'cmd', action:'reload', slot:0} — relayed to displays
        broadcast(msg, ws);
      }
    } catch (e) {
      console.error('[ws message handler]', e && e.message);
    }
  });
});

// Sleep timer: runs server-side so it fires even with every phone closed.
setInterval(() => {
  if (state.sleepAt && Date.now() >= state.sleepAt) {
    console.log('[sleep] timer reached — entering standby');
    state.sleepAt = null;
    state.power = false;
    saveSoon();
    broadcastState();
  }
}, 10000);

setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`StreamWall running:`);
  console.log(`  Remote:  http://localhost:${PORT}/`);
  console.log(`  TV:      http://localhost:${PORT}/tv`);
  console.log(`  Media:   ${MEDIA_DIR}`);
});
