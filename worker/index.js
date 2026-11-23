// Cloudflare Worker backend for the Tessera Works Discord Activity.
// - POST /token   exchanges the Discord OAuth code for an access token (secret stays here)
// - GET  /ws      WebSocket, routed to one Durable Object per Activity instance (?instance=...)
// Discord's URL mapping sends `/api/*` here; the prefix is accepted with or without stripping.
import { DurableObject } from 'cloudflare:workers';
import rooms from '../src/rooms.js';

const { applyMessage, publicState, exchangeCode, whoAmI, loadGame, GameError } = rooms;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/(\.proxy\/)?api(?=\/|$)/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/health') return json({ ok: true });

    if (path === '/token' && request.method === 'POST') {
      if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ error: 'Worker is missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET.' }, 500);
      try {
        const { code } = await request.json();
        if (typeof code !== 'string') return json({ error: 'missing code' }, 400);
        return json({ access_token: await exchangeCode(code, env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      const instance = url.searchParams.get('instance') || '';
      if (!instance || instance.length > 200) return json({ error: 'missing instance' }, 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(instance));
      return stub.fetch(request);
    }

    // Anything else: static client files (when deployed with assets), else 404.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'not found' }, 404);
  },
};

/** One game room per Discord Activity instance. Uses WebSocket hibernation, so idle rooms cost nothing. */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = undefined; // lazily loaded from storage (memory is wiped on hibernation)
  }

  async load() {
    if (this.game === undefined) this.game = loadGame(await this.ctx.storage.get('game'));
    return this.game;
  }

  async save() {
    if (this.game) await this.ctx.storage.put('game', JSON.stringify(this.game));
    else await this.ctx.storage.delete('game');
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async fetch(request) {
    const instance = new URL(request.url).searchParams.get('instance');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ instance, user: null, at: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const att = ws.deserializeAttachment() || {};
    try {
      if (!att.user) {
        if (msg.t !== 'hello') return ws.close(4002, 'bad hello');
        const user = msg.dev && this.env.ACTIVITY_DEV_AUTH === '1'
          ? { id: `dev-${String(msg.dev).slice(0, 20)}`, name: String(msg.dev).slice(0, 20) }
          : await whoAmI(String(msg.token || ''));
        ws.serializeAttachment({ ...att, user });
        return this.broadcast();
      }
      await this.load();
      const { game, event } = applyMessage(this.game, att.user, msg, att.instance);
      this.game = game;
      await this.save();
      await this.broadcast(event);
    } catch (e) {
      const known = e instanceof GameError;
      if (!known && att.user) console.error(e);
      try { ws.send(JSON.stringify({ t: 'error', msg: known ? e.message : (att.user ? 'Something went wrong.' : 'Could not sign you in.') })); } catch { /* closed */ }
      if (!att.user) ws.close(4003, 'auth failed');
      if (known) this.game = undefined; // reload clean state from storage next time
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, ''); } catch { /* already closed */ }
    await this.broadcast();
  }

  async webSocketError() { await this.broadcast(); }

  async broadcast(event) {
    await this.load();
    const socks = this.ctx.getWebSockets().filter(s => s.readyState === 1 && (s.deserializeAttachment() || {}).user);
    const online = [...new Set(socks.map(s => s.deserializeAttachment().user.id))];
    const state = publicState(this.game);
    for (const s of socks) {
      const msg = { t: 'state', you: s.deserializeAttachment().user.id, game: state, online };
      if (event) msg.event = event;
      try { s.send(JSON.stringify(msg)); } catch { /* closed */ }
    }
  }

  async alarm() {
    // Clean up rooms nobody has touched for a day.
    if (this.ctx.getWebSockets().length) return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    await this.ctx.storage.deleteAll();
    this.game = null;
  }
}
