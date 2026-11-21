// Tirbix server: the website, accounts, games, forum and online play.
// Data is kept in a PostgreSQL database when DATABASE_URL is set (it survives updates and restarts),
// otherwise in data/tirbix.json next to this file (lost when the free server restarts).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_MAX = 12;
const MAX_ROOMS = 300;
const MAX_BODY = 4 * 1024 * 1024;     // a game with its pictures
const MAX_PARTS = 600;
const ADMIN = 'Tirbix';

const pageFile = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((f) => fs.existsSync(f));
const page = fs.readFileSync(pageFile, 'utf8').replace('<head>', '<head><script>window.TIRBIX_ONLINE=1</script>');

// ------------------------------------------------------------------ word filter (same as the website)
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'bastard', 'dick', 'cunt', 'asshole', 'whore', 'slut',
  'бля', 'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебан', 'ёба', 'сука', 'суки', 'мудак', 'долбоеб', 'гандон'];
const BAD_RE = new RegExp(BAD_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const filter = (t) => String(t).replace(BAD_RE, (m) => '#'.repeat(m.length));
const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

// ------------------------------------------------------------------ storage: every record is a key and a JSON value
const store = { map: new Map(), dirty: new Set(), pg: null, file: path.join(__dirname, 'data', 'tirbix.json') };
async function storeLoad() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    store.pg = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 60000 });
    store.pg.on('error', (e) => console.error('database connection closed:', e.message)); // free databases sleep and drop idle connections
    for (let i = 0; ; i++) { // a sleeping free database can take a few seconds to wake up
      try { await store.pg.query('CREATE TABLE IF NOT EXISTS tirbix_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())'); break; }
      catch (e) { if (i >= 5) throw e; console.error('database not ready, trying again:', e.message); await new Promise((r) => setTimeout(r, 3000)); }
    }
    const r = await store.pg.query('SELECT k, v FROM tirbix_kv');
    for (const row of r.rows) store.map.set(row.k, row.v);
    console.log(`Database: ${r.rows.length} records loaded`);
  } else {
    try { const d = JSON.parse(fs.readFileSync(store.file, 'utf8')); for (const [k, v] of Object.entries(d)) store.map.set(k, v); } catch (e) { /* first start */ }
    console.log(`No DATABASE_URL: keeping data in ${store.file} (${store.map.size} records). It is lost when the server restarts.`);
  }
}
const get = (k) => store.map.get(k);
function put(k, v) { if (v === undefined) store.map.delete(k); else store.map.set(k, v); store.dirty.add(k); }
const keys = (prefix) => [...store.map.keys()].filter((k) => k.startsWith(prefix));
let flushing = false;
async function flush() {
  if (flushing || !store.dirty.size) return;
  flushing = true;
  const ks = [...store.dirty]; store.dirty.clear();
  try {
    if (store.pg) {
      for (const k of ks) {
        const v = store.map.get(k);
        if (v === undefined) await store.pg.query('DELETE FROM tirbix_kv WHERE k = $1', [k]);
        else await store.pg.query('INSERT INTO tirbix_kv (k, v, updated) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()', [k, JSON.stringify(v)]);
      }
    } else {
      fs.mkdirSync(path.dirname(store.file), { recursive: true });
      fs.writeFileSync(store.file + '.tmp', JSON.stringify(Object.fromEntries(store.map)));
      fs.renameSync(store.file + '.tmp', store.file);
    }
  } catch (e) {
    console.error('save failed', e.message);
    for (const k of ks) store.dirty.add(k);
  }
  flushing = false;
}
setInterval(flush, 1000);
async function shutdown() { try { await flush(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// ------------------------------------------------------------------ accounts
const lower = (n) => String(n || '').toLowerCase();
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function publicUser(a) { return a && { name: a.name, created: a.created, about: a.about || '', colors: a.colors || null }; }
function auth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok || tok.length > 100) return null;
  const s = get('ses:' + tok);
  if (!s) return null;
  const a = get('acc:' + lower(s.name));
  return a ? { token: tok, acc: a } : null;
}
function newSession(name) { const tok = crypto.randomBytes(24).toString('hex'); put('ses:' + tok, { name, created: Date.now() }); return tok; }
const COLOR_KEY = /^[a-zA-Z]{2,30}$/;
function cleanColorKeys(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const k of ['skin', 'torso', 'legs']) if (typeof c[k] === 'string' && COLOR_KEY.test(c[k])) out[k] = c[k];
  return out;
}

// ------------------------------------------------------------------ games
function gameMeta(g) {
  return { id: g.id, owner: g.owner, title: g.title, desc: g.desc, created: g.created, updated: g.updated, visits: g.visits || 0,
    lighting: g.lighting || 'day', bricks: (g.parts || []).length, cover: g.cover ? `/api/cover/${g.id}?v=${g.updated}` : null };
}
const okImage = (s, max) => typeof s === 'string' && s.length < max && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
// groups, tools, scripts outside bricks and the screen interface of a game
function cleanTree(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const out = {};
  if (Array.isArray(t.groups)) out.groups = t.groups.slice(0, 600);
  if (t.svc && typeof t.svc === 'object') out.svc = t.svc;
  if (Array.isArray(t.gui)) out.gui = t.gui.slice(0, 50);
  if (t.light && typeof t.light === 'object' && !Array.isArray(t.light)) {
    const L = t.light, n = (v, a, b, d) => (Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d);
    const col = (c) => (typeof c === 'string' && /^[A-Za-z]{1,30}$/.test(c) ? c : Array.isArray(c) && c.length === 3 && c.every((x) => Number.isFinite(x)) ? c.map((x) => Math.max(0, Math.min(255, Math.round(x)))) : null);
    out.light = { time: n(L.time, 0, 24, 14), bright: n(L.bright, 0, 5, 1), amb: col(L.amb), fog: !!L.fog, fogStart: n(L.fogStart, 0, 100000, 0), fogEnd: n(L.fogEnd, 1, 100000, 400), fogColor: col(L.fogColor) || 'mediumStoneGrey' };
  }
  return out;
}
function cleanGame(b) {
  if (!Array.isArray(b.parts) || b.parts.length > MAX_PARTS) return null;
  const textures = {};
  if (b.textures && typeof b.textures === 'object') for (const [k, v] of Object.entries(b.textures)) if (/^[A-Za-z0-9]{1,24}$/.test(k) && okImage(v, 200000)) textures[k] = v;
  return {
    title: filter(str(b.title, 50)) || 'Untitled Game', desc: filter(str(b.desc, 1000)),
    cover: okImage(b.cover, 150000) ? b.cover : null, lighting: ['day', 'morning', 'evening', 'night'].includes(b.lighting) ? b.lighting : 'day',
    parts: b.parts, textures, tree: cleanTree(b.tree),
  };
}

// ------------------------------------------------------------------ small helpers for the web API
const limits = new Map();
function limited(key, n, ms) {
  const now = Date.now(), l = limits.get(key) || { t: now, n: 0 };
  if (now - l.t > ms) { l.t = now; l.n = 0; }
  l.n++; limits.set(key, l);
  return l.n > n;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of limits) if (now - l.t > 3600e3) limits.delete(k); }, 600e3);
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function api(req, res, url) {
  const m = req.method;
  const me = auth(req);
  const parts = url.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c] = parts;

  if (a === 'signup' && m === 'POST') {
    if (limited('signup:' + ip(req), 8, 3600e3)) return send(res, 429, { error: 'Too many new accounts. Try again later.' });
    const d = await readBody(req);
    const name = str(d.name, 20);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return send(res, 400, { error: 'Username must be 3-20 characters: letters, numbers or _.' });
    if (/^guest/i.test(name) || lower(name) === lower(ADMIN)) return send(res, 400, { error: 'That username is not allowed.' });
    if (filter(name) !== name) return send(res, 400, { error: 'That username is not allowed.' });
    if (get('acc:' + lower(name))) return send(res, 409, { error: 'That username is already taken.' });
    if (String(d.pw || '').length < 6 || String(d.pw).length > 100) return send(res, 400, { error: 'Password must be at least 6 characters.' });
    const salt = crypto.randomBytes(12).toString('hex');
    const acc = { name, salt, hash: hashPw(d.pw, salt), created: Date.now(), birthday: str(d.birthday, 12), gender: str(d.gender, 8), about: '', colors: cleanColorKeys(d.colors) };
    put('acc:' + lower(name), acc);
    return send(res, 200, { token: newSession(name), user: publicUser(acc) });
  }
  if (a === 'login' && m === 'POST') {
    if (limited('login:' + ip(req), 30, 600e3)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
    const d = await readBody(req);
    const acc = get('acc:' + lower(str(d.name, 20)));
    if (!acc) return send(res, 404, { error: 'Wrong username or password.', noAccount: true });
    if (hashPw(String(d.pw || ''), acc.salt) !== acc.hash) return send(res, 401, { error: 'Wrong username or password.' });
    return send(res, 200, { token: newSession(acc.name), user: publicUser(acc) });
  }
  if (a === 'logout' && m === 'POST') { if (me) put('ses:' + me.token, undefined); return send(res, 200, { ok: true }); }
  if (a === 'me') {
    if (!me) return send(res, 401, { error: 'Please log in again.' });
    if (m === 'POST') {
      const d = await readBody(req);
      if (typeof d.about === 'string') me.acc.about = filter(str(d.about, 500));
      if (d.colors) me.acc.colors = cleanColorKeys(d.colors);
      put('acc:' + lower(me.acc.name), me.acc);
    }
    return send(res, 200, { user: publicUser(me.acc) });
  }
  if (a === 'people' && m === 'GET') {
    const people = keys('acc:').map((k) => publicUser(get(k))).sort((x, y) => y.created - x.created);
    return send(res, 200, { people });
  }
  if (a === 'games' && m === 'GET') {
    const games = keys('game:').map((k) => gameMeta(get(k)));
    return send(res, 200, { games, visits: get('visits') || {} });
  }
  if (a === 'game') {
    if (!b && m === 'POST') {
      if (!me) return send(res, 401, { error: 'Log in with an account to save games.' });
      if (limited('save:' + me.acc.name, 60, 600e3)) return send(res, 429, { error: 'Saving too often. Wait a minute.' });
      const d = await readBody(req);
      const g = cleanGame(d);
      if (!g) return send(res, 400, { error: 'This game is too big.' });
      const now = Date.now();
      let game;
      if (d.id && get('game:' + d.id)) {
        const old = get('game:' + d.id);
        if (old.owner !== me.acc.name) return send(res, 403, { error: 'You can only save your own games.' });
        game = { ...old, ...g, updated: now };
      } else {
        if (keys('game:').some((k) => get(k).owner === me.acc.name)) return send(res, 400, { error: 'You can have one game. Delete your old game on the Creators page to make a new one.' });
        game = { id: 'g' + now.toString(36) + crypto.randomBytes(3).toString('hex'), owner: me.acc.name, ...g, created: now, updated: now, visits: 0 };
      }
      put('game:' + game.id, game);
      return send(res, 200, { game: gameMeta(game) });
    }
    const g = b && get('game:' + b);
    if (!g) return send(res, 404, { error: 'This game does not exist any more.' });
    if (c === 'visit' && m === 'POST') {
      if (!limited('visit:' + ip(req) + ':' + b, 1, 60e3)) { g.visits = (g.visits || 0) + 1; put('game:' + b, g); }
      return send(res, 200, { visits: g.visits });
    }
    if (m === 'GET') return send(res, 200, { game: { ...gameMeta(g), cover: g.cover, parts: g.parts, tree: g.tree || null, textures: g.textures } });
    if (m === 'DELETE') {
      if (!me || me.acc.name !== g.owner) return send(res, 403, { error: 'You can only delete your own games.' });
      put('game:' + b, undefined);
      return send(res, 200, { ok: true });
    }
  }
  if (a === 'models') { // the Creators Box: models a player keeps for their games
    if (!me) return send(res, 401, { error: 'Log in to use your Creators Box.' });
    const key = 'models:' + lower(me.acc.name);
    const list = get(key) || [];
    if (m === 'GET' && !b) return send(res, 200, { models: list });
    if (m === 'POST' && !b) {
      if (limited('model:' + me.acc.name, 30, 600e3)) return send(res, 429, { error: 'Slow down a little and try again.' });
      const d = await readBody(req);
      if (!Array.isArray(d.parts) || !d.parts.length || d.parts.length > 300) return send(res, 400, { error: 'A model needs 1 to 300 bricks.' });
      if (list.length >= 40) return send(res, 400, { error: 'Your Creators Box is full (40 models). Remove one first.' });
      const textures = {};
      if (d.textures && typeof d.textures === 'object') for (const [k, v] of Object.entries(d.textures)) if (/^[A-Za-z0-9]{1,24}$/.test(k) && okImage(v, 200000)) textures[k] = v;
      const item = { id: 'm' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), name: filter(str(d.name, 40)) || 'Model',
        parts: d.parts, groups: Array.isArray(d.groups) ? d.groups.slice(0, 200) : [], textures, created: Date.now() };
      if (JSON.stringify(item).length > 1500000) return send(res, 400, { error: 'This model is too big.' });
      put(key, [item].concat(list));
      return send(res, 200, { model: item });
    }
    if (m === 'DELETE' && b) { put(key, list.filter((x) => x.id !== b)); return send(res, 200, { ok: true }); }
  }
  if (a === 'visit' && b && m === 'POST') { // the built-in games
    if (!/^[a-z]{1,20}$/.test(b)) return send(res, 400, { error: 'bad' });
    const v = { ...(get('visits') || {}) };
    if (!limited('visit:' + ip(req) + ':' + b, 1, 60e3)) { v[b] = (v[b] || 0) + 1; put('visits', v); }
    return send(res, 200, { visits: v[b] || 0 });
  }
  if (a === 'forum') {
    const f = get('forum') || { threads: [], replies: {} };
    if (m === 'GET') return send(res, 200, f);
    if (m === 'POST') {
      if (!me) return send(res, 401, { error: 'Log in to post.' });
      if (limited('post:' + me.acc.name, 10, 600e3)) return send(res, 429, { error: 'You are posting too fast. Wait a few minutes.' });
      const d = await readBody(req);
      const body = filter(str(d.body, 2000));
      if (!body) return send(res, 400, { error: 'Please write a message.' });
      let colors = null; // avatar colors of the post: four [r, g, b] lists
      if (d.colors && typeof d.colors === 'object') {
        colors = {};
        for (const k of ['head', 'arms', 'torso', 'legs']) {
          const v = d.colors[k];
          if (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) colors[k] = v;
        }
        if (Object.keys(colors).length !== 4) colors = null;
      }
      if (d.kind === 'thread') {
        const subject = filter(str(d.subject, 80));
        if (!subject) return send(res, 400, { error: 'Please write a subject.' });
        f.threads.push({ id: 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), subject, author: me.acc.name, colors, created: Date.now(), body });
        if (f.threads.length > 500) f.threads.shift();
      } else {
        const t = f.threads.find((x) => x.id === d.ref);
        if (!t) return send(res, 404, { error: 'This post does not exist any more.' });
        (f.replies[t.id] = f.replies[t.id] || []).push({ author: me.acc.name, colors, created: Date.now(), body });
      }
      put('forum', f);
      return send(res, 200, f);
    }
  }
  if (a === 'rooms' && m === 'GET') {
    const list = [...rooms.values()].filter((r) => r.players.size > 0).sort((x, y) => y.players.size - x.players.size).slice(0, 40).map(roomInfo);
    return send(res, 200, { rooms: list, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) });
  }
  return send(res, 404, { error: 'Not found.' });
}

// ------------------------------------------------------------------ online play: rooms
const rooms = new Map();
let nextId = 1;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanColors(c) {
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
  const d = [200, 200, 200];
  c = c && typeof c === 'object' ? c : {};
  return { head: ok(c.head) ? c.head : d, arms: ok(c.arms) ? c.arms : d, torso: ok(c.torso) ? c.torso : d, legs: ok(c.legs) ? c.legs : d };
}
const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
function roomInfo(r) {
  return { code: r.code, pub: r.pub, title: r.title, owner: r.owner, players: r.players.size, max: ROOM_MAX, cover: r.coverUrl || r.cover };
}
function sendTo(ws, m) { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
function broadcast(r, m, except) {
  const s = JSON.stringify(m);
  for (const p of r.players.values()) if (p !== except) sendTo(p.ws, s);
}
function leaveRoom(p) {
  const r = p.room; if (!r) return;
  r.players.delete(p.id);
  p.room = null;
  broadcast(r, { t: 'del', id: p.id, name: p.name });
  if (r.players.size === 0) rooms.delete(r.code);
}
function join(p, m) {
  if (p.room) leaveRoom(p);
  p.name = str(m.name, 24) || 'Player';
  p.colors = cleanColors(m.colors);
  let r = null, sendGame = false;
  if (m.room) {
    r = rooms.get(str(m.room, 8).toUpperCase());
    if (!r) return sendTo(p.ws, { t: 'error', code: 'noroom', msg: 'This game is not running any more.' });
    if (r.players.size >= ROOM_MAX) return sendTo(p.ws, { t: 'error', code: 'full', msg: 'This game is full.' });
    sendGame = !!r.game;
  } else if (m.pub) {
    const pub = str(m.pub, 40);
    for (const x of rooms.values()) if (x.pub === pub && x.players.size < ROOM_MAX) { r = x; break; }
    if (!r) {
      if (rooms.size >= MAX_ROOMS) return sendTo(p.ws, { t: 'error', code: 'busy', msg: 'The server is busy. Try again later.' });
      r = { code: newCode(), pub, title: str(m.title, 50) || 'Baseplate', owner: str(m.owner, 24) || ADMIN, cover: null, game: null, players: new Map() };
      rooms.set(r.code, r);
    }
  } else if (m.game && typeof m.game === 'object') {
    const saved = typeof m.game.id === 'string' && get('game:' + m.game.id);
    // a game saved on the server: everybody who presses Play goes into the same room (same version of the game)
    if (saved) for (const x of rooms.values()) if (x.gameId === saved.id && x.ver === saved.updated && x.players.size < ROOM_MAX) { r = x; break; }
    if (!r) {
      if (rooms.size >= MAX_ROOMS) return sendTo(p.ws, { t: 'error', code: 'busy', msg: 'The server is busy. Try again later.' });
      const g = saved ? { ...saved, desc: saved.desc || '' } : cleanGame(m.game);
      if (!g) return sendTo(p.ws, { t: 'error', code: 'bad', msg: 'This game cannot be played online.' });
      const owner = saved ? saved.owner : str(m.game.owner, 24) || p.name;
      r = { code: newCode(), pub: null, gameId: saved ? saved.id : null, ver: saved ? saved.updated : 0, title: g.title, owner, cover: saved ? null : g.cover,
        coverUrl: saved && saved.cover ? `/api/cover/${saved.id}?v=${saved.updated}` : null,
        game: { title: g.title, owner, desc: g.desc, parts: g.parts, tree: g.tree || null, textures: g.textures || {}, lighting: g.lighting || 'day' }, players: new Map() };
      rooms.set(r.code, r);
    }
  } else return sendTo(p.ws, { t: 'error', code: 'bad', msg: 'Nothing to join.' });
  const names = new Set([...r.players.values()].map((x) => x.name));
  if (names.has(p.name)) { let i = 2; while (names.has(`${p.name} (${i})`)) i++; p.name = `${p.name} (${i})`; }
  p.room = r; p.s = null;
  const others = [...r.players.values()].map((x) => ({ id: x.id, name: x.name, colors: x.colors, s: x.s }));
  r.players.set(p.id, p);
  sendTo(p.ws, { t: 'welcome', id: p.id, name: p.name, room: r.code, pub: r.pub, title: r.title, owner: r.owner, game: sendGame ? r.game : null, players: others });
  broadcast(r, { t: 'add', id: p.id, name: p.name, colors: p.colors }, p);
}

// ------------------------------------------------------------------ http
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    if (url.startsWith('/api/cover/')) {
      const g = get('game:' + url.slice(11).split('/')[0]);
      const mm = g && g.cover && /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(g.cover);
      if (!mm) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(Buffer.from(mm[2], 'base64'));
      return;
    }
    if (url.startsWith('/api/')) { await api(req, res, url); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : page);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, 400, { error: 'Something went wrong. Try again.' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_BODY });
wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, room: null, name: 'Player', colors: null, s: null, msgs: 0, win: Date.now(), lastChat: 0 };
  ws.on('pong', () => { ws._dead = false; });
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - p.win > 1000) { p.win = now; p.msgs = 0; p.evs = 0; }
    if (++p.msgs > 60) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') { join(p, m); return; }
    if (m.t === 'ping') { if (typeof m.at === 'number' && Number.isFinite(m.at)) try { ws.send(JSON.stringify({ t: 'pong', at: m.at })); } catch (e) { /* closed */ } return; }
    if (!p.room) return;
    if (m.t === 's' && Array.isArray(m.p) && m.p.length === 3) {
      p.s = { p: m.p.map(num), r: num(m.r), a: Number.isInteger(m.a) ? m.a & 7 : 0,
        h: Number.isInteger(m.h) && m.h > 0 && m.h < 1e9 ? m.h : 0, ta: Number.isInteger(m.ta) ? m.ta & 255 : 0 };
      broadcast(p.room, { t: 's', id: p.id, ...p.s }, p);
    } else if (m.t === 'chat') {
      if (now - p.lastChat < 400) return;
      p.lastChat = now;
      const text = filter(str(m.text, 100)); if (!text) return;
      broadcast(p.room, { t: 'chat', id: p.id, name: p.name, text }, p);
    } else if (m.t === 'ev' && m.k === 'hit') { // a sword (or other script) hurts one player: only that player hears it
      const to = p.room.players.get(Number(m.id)), dmg = Number(m.dmg);
      if (!to || to === p || !Number.isFinite(dmg) || dmg <= 0) return;
      p.evs = (p.evs || 0) + 1; if (p.evs > 40) return;
      sendTo(to.ws, { t: 'ev', id: p.id, name: p.name, k: 'hit', dmg: Math.min(100, dmg) });
    } else if (m.t === 'ev') { // something a script should see on every screen: a click or a touch
      const k = m.k === 'click' || m.k === 'touch' ? m.k : null;
      const id = Number(m.id);
      if (!k || !Number.isFinite(id)) return;
      p.evs = (p.evs || 0) + 1; if (p.evs > 40) return;
      broadcast(p.room, { t: 'ev', id: p.id, name: p.name, k, part: id, on: m.on ? 1 : 0 }, p);
    } else if (m.t === 'leave') leaveRoom(p);
  });
  ws.on('close', () => leaveRoom(p));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);

storeLoad().then(() => server.listen(PORT, () => console.log(`Tirbix server on port ${PORT}`)))
  .catch((e) => { console.error('Could not open the database:', e.message); process.exit(1); });
