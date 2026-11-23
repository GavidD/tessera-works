'use strict';
// Backend for the Discord Activity: OAuth code exchange + real-time game rooms over WebSocket.
// Discord's URL mapping sends `/api/*` here (the prefix may or may not be stripped, so both are handled).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, GameError } = require('./engine/game');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DEV_AUTH = process.env.ACTIVITY_DEV_AUTH === '1'; // allow ?dev=<name> logins (local testing only!)
const STATIC_DIR = process.env.ACTIVITY_STATIC_DIR; // optionally serve the built client too
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const rooms = new Map(); // instanceId -> { game, clients: Set<ws>, touched }

const route = url => url.replace(/^\/(\.proxy\/)?api(?=\/|$)/, '') || '/';

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function exchangeCode(code) {
  const r = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code }),
  });
  if (!r.ok) throw new Error(`token exchange failed (${r.status})`);
  return (await r.json()).access_token;
}

async function whoAmI(accessToken) {
  const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error('invalid access token');
  const u = await r.json();
  return { id: u.id, name: u.global_name || u.username };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const base = path.resolve(STATIC_DIR);
  const file = path.resolve(base, '.' + (rel === '/' ? '/index.html' : rel));
  if (file !== base && !file.startsWith(base + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- rooms ----------
function publicState(game) {
  if (!game) return null;
  const s = JSON.parse(JSON.stringify(game));
  if (s.decks) s.decks = { bronze: s.decks.bronze.length, gold: s.decks.gold.length }; // hide deck order
  return s;
}

function broadcast(room, extra = {}) {
  room.touched = Date.now();
  const state = publicState(room.game);
  for (const ws of room.clients) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'state', you: ws.user.id, game: state, online: onlineIds(room), ...extra }));
  }
}
const onlineIds = room => [...new Set([...room.clients].map(c => c.user.id))];

function handleMessage(ws, msg) {
  const room = rooms.get(ws.instance);
  const u = ws.user;
  const g = room.game;
  switch (msg.t) {
    case 'join':
      if (!g || g.phase === 'ended') room.game = new Game({ channelId: ws.instance, hostId: u.id, hostName: u.name });
      else g.addPlayer(u.id, u.name);
      break;
    case 'leave':
      if (!g) return;
      if (g.hostId === u.id && g.phase === 'lobby') room.game = null;
      else g.removePlayer(u.id);
      break;
    case 'start':
      if (!g || g.hostId !== u.id) throw new GameError('Only the host can start.');
      g.start();
      break;
    case 'act': {
      if (!g) throw new GameError('No game yet.');
      const a = msg.args || {};
      let done = [];
      if (msg.action === 'draw') g.draw(u.id);
      else if (msg.action === 'refine') g.refine(u.id, a.from, a.to);
      else if (msg.action === 'commission') g.commission(u.id, a.tier, a.slot === 'deck' ? 'deck' : Number(a.slot));
      else if (msg.action === 'fit') done = g.fit(u.id, Number(a.puzzleIdx), a.pieceId, a.cells);
      else if (msg.action === 'flurry') done = g.flurry(u.id, a.placements || []);
      else if (msg.action === 'endTurn') g.endTurn(u.id);
      else throw new GameError('Unknown action.');
      return broadcast(room, done.length ? { event: { kind: 'complete', who: u.id, puzzles: done } } : {});
    }
    case 'abandon':
      if (!g || g.hostId !== u.id) throw new GameError('Only the host can end the game.');
      if (g.phase === 'playing') g.forceEnd(); else room.game = null;
      break;
    default:
      return;
  }
  broadcast(room);
}

function validMessage(m) {
  return m && typeof m === 'object' && typeof m.t === 'string';
}

function startServer({ port = Number(process.env.PORT) || 3001 } = {}) {
  const server = http.createServer(async (req, res) => {
    const p = route(req.url.split('?')[0]);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      if (p === '/token' && req.method === 'POST') {
        if (!CLIENT_ID || !CLIENT_SECRET) return json(res, 500, { error: 'Server is missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET.' });
        const { code } = JSON.parse(await readBody(req));
        if (typeof code !== 'string') return json(res, 400, { error: 'missing code' });
        return json(res, 200, { access_token: await exchangeCode(code) });
      }
      if (p === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
      if (STATIC_DIR && req.method === 'GET' && !req.url.startsWith('/api')) return serveStatic(req, res);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (route(req.url.split('?')[0]) !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 15000);
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!validMessage(msg)) return;
      try {
        if (!ws.user) {
          if (msg.t !== 'hello' || typeof msg.instance !== 'string' || msg.instance.length > 200) return ws.close(4002, 'bad hello');
          if (msg.dev && DEV_AUTH) ws.user = { id: `dev-${String(msg.dev).slice(0, 20)}`, name: String(msg.dev).slice(0, 20) };
          else ws.user = await whoAmI(String(msg.token || ''));
          clearTimeout(helloTimer);
          ws.instance = msg.instance;
          if (!rooms.has(ws.instance)) rooms.set(ws.instance, { game: null, clients: new Set(), touched: Date.now() });
          rooms.get(ws.instance).clients.add(ws);
          return broadcast(rooms.get(ws.instance));
        }
        handleMessage(ws, msg);
      } catch (e) {
        if (!(e instanceof GameError) && ws.user) console.error(e);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', msg: e instanceof GameError ? e.message : (ws.user ? 'Something went wrong.' : 'Could not sign you in.') }));
        if (!ws.user) ws.close(4003, 'auth failed');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      const room = ws.instance && rooms.get(ws.instance);
      if (room) { room.clients.delete(ws); broadcast(room); }
    });
  });

  // Heartbeat + idle room cleanup.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
    for (const [id, r] of rooms) if (!r.clients.size && Date.now() - r.touched > ROOM_IDLE_MS) rooms.delete(id);
  }, 30000);
  server.on('close', () => clearInterval(timer));

  return new Promise(resolve => server.listen(port, () => {
    console.log(`Activity server on :${server.address().port}${DEV_AUTH ? ' (DEV AUTH ENABLED)' : ''}`);
    resolve(server);
  }));
}

if (require.main === module) startServer();
module.exports = { startServer, rooms };
