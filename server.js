// Tirbix server: serves the game and passes player moves and chat between the players of a room.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_MAX = 12;          // players in one game
const MAX_ROOMS = 300;
const MAX_GAME_BYTES = 3.5e6; // a game with its pictures

const pageFile = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((f) => fs.existsSync(f));
const page = fs.readFileSync(pageFile, 'utf8')
  .replace('<head>', '<head><script>window.TIRBIX_ONLINE=1</script>');

const rooms = new Map();      // code -> room
let nextId = 1;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
function cleanColors(c) {
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
  const d = [200, 200, 200];
  c = c && typeof c === 'object' ? c : {};
  return { head: ok(c.head) ? c.head : d, arms: ok(c.arms) ? c.arms : d, torso: ok(c.torso) ? c.torso : d, legs: ok(c.legs) ? c.legs : d };
}
const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

function roomInfo(r) {
  return { code: r.code, pub: r.pub, title: r.title, owner: r.owner, players: r.players.size, max: ROOM_MAX, cover: r.cover };
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
  p.guest = !!m.guest;
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
      r = { code: newCode(), pub, title: str(m.title, 50) || 'Baseplate', owner: str(m.owner, 24) || 'Tirbix', cover: null, game: null, players: new Map(), created: Date.now() };
      rooms.set(r.code, r);
    }
  } else if (m.game && typeof m.game === 'object') {
    if (rooms.size >= MAX_ROOMS) return sendTo(p.ws, { t: 'error', code: 'busy', msg: 'The server is busy. Try again later.' });
    const g = m.game;
    if (!Array.isArray(g.parts) || g.parts.length > 600) return sendTo(p.ws, { t: 'error', code: 'bad', msg: 'This game cannot be played online.' });
    const cover = typeof g.cover === 'string' && g.cover.length < 120000 && g.cover.startsWith('data:image/') ? g.cover : null;
    r = { code: newCode(), pub: null, title: str(g.title, 50) || 'Untitled Game', owner: str(g.owner, 24) || p.name, cover,
      game: { title: str(g.title, 50), owner: str(g.owner, 24), desc: str(g.desc, 1000), parts: g.parts, textures: g.textures && typeof g.textures === 'object' ? g.textures : {} },
      players: new Map(), created: Date.now() };
    rooms.set(r.code, r);
  } else return sendTo(p.ws, { t: 'error', code: 'bad', msg: 'Nothing to join.' });

  // a different name if somebody in the room already has it
  const names = new Set([...r.players.values()].map((x) => x.name));
  if (names.has(p.name)) { let i = 2; while (names.has(`${p.name} (${i})`)) i++; p.name = `${p.name} (${i})`; }

  p.room = r; p.s = null;
  const others = [...r.players.values()].map((x) => ({ id: x.id, name: x.name, colors: x.colors, s: x.s }));
  r.players.set(p.id, p);
  sendTo(p.ws, { t: 'welcome', id: p.id, name: p.name, room: r.code, pub: r.pub, title: r.title, owner: r.owner, game: sendGame ? r.game : null, players: others });
  broadcast(r, { t: 'add', id: p.id, name: p.name, colors: p.colors }, p);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/api/rooms') {
    const list = [...rooms.values()].filter((r) => r.players.size > 0).sort((a, b) => b.players.size - a.players.size).slice(0, 40).map(roomInfo);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ rooms: list, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : page);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_GAME_BYTES });
wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, room: null, name: 'Player', colors: null, s: null, msgs: 0, win: Date.now(), lastChat: 0 };
  ws.on('pong', () => { ws._dead = false; });
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - p.win > 1000) { p.win = now; p.msgs = 0; }
    if (++p.msgs > 60) return; // too many messages
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') { if (data.length > MAX_GAME_BYTES) return; join(p, m); return; }
    if (!p.room) return;
    if (m.t === 's' && Array.isArray(m.p) && m.p.length === 3) {
      p.s = { p: m.p.map(num), r: num(m.r), a: Number.isInteger(m.a) ? m.a & 7 : 0 };
      broadcast(p.room, { t: 's', id: p.id, ...p.s }, p);
    } else if (m.t === 'chat') {
      if (now - p.lastChat < 400) return;
      p.lastChat = now;
      const text = str(m.text, 100); if (!text) return;
      broadcast(p.room, { t: 'chat', id: p.id, name: p.name, text }, p);
    } else if (m.t === 'leave') leaveRoom(p);
  });
  ws.on('close', () => leaveRoom(p));
  ws.on('error', () => {});
});
// drop players whose connection died (and keep connections busy so proxies do not close them)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log(`Tirbix server on port ${PORT}`));
