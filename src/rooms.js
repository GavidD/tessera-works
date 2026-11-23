'use strict';
// Transport-agnostic room logic shared by the Node server (src/server.js) and the
// Cloudflare Worker (worker/index.js). Pure: takes the current game + a message, returns the new game.
const { Game, GameError } = require('./engine/game');

/**
 * Apply one client message from `user` to `game` (a Game or null).
 * Returns { game, event? }. Throws GameError for rule violations.
 */
function applyMessage(game, user, msg, instance) {
  const g = game;
  switch (msg.t) {
    case 'join':
      if (!g || g.phase === 'ended') return { game: new Game({ channelId: instance, hostId: user.id, hostName: user.name }) };
      g.addPlayer(user.id, user.name);
      return { game: g };
    case 'leave':
      if (!g) return { game: g };
      if (g.hostId === user.id && g.phase === 'lobby') return { game: null };
      g.removePlayer(user.id);
      return { game: g };
    case 'start':
      if (!g || g.hostId !== user.id) throw new GameError('Only the host can start.');
      g.start();
      return { game: g };
    case 'abandon':
      if (!g || g.hostId !== user.id) throw new GameError('Only the host can end the game.');
      if (g.phase === 'playing') { g.forceEnd(); return { game: g }; }
      return { game: null };
    case 'act': {
      if (!g) throw new GameError('No game yet.');
      const a = msg.args || {};
      let done = [];
      switch (msg.action) {
        case 'draw': g.draw(user.id); break;
        case 'refine': g.refine(user.id, a.from, a.to); break;
        case 'commission': g.commission(user.id, a.tier, a.slot === 'deck' ? 'deck' : Number(a.slot)); break;
        case 'fit': done = g.fit(user.id, Number(a.puzzleIdx), a.pieceId, a.cells); break;
        case 'flurry': done = g.flurry(user.id, Array.isArray(a.placements) ? a.placements : []); break;
        case 'endTurn': g.endTurn(user.id); break;
        default: throw new GameError('Unknown action.');
      }
      return { game: g, event: done.length ? { kind: 'complete', who: user.id, puzzles: done } : undefined };
    }
    default:
      throw new GameError('Unknown message.');
  }
}

/** What clients may see: everything except the hidden deck order. */
function publicState(game) {
  if (!game) return null;
  const s = JSON.parse(JSON.stringify(game));
  if (s.decks) s.decks = { bronze: s.decks.bronze.length, gold: s.decks.gold.length };
  return s;
}

async function exchangeCode(code, clientId, clientSecret) {
  const r = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
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

const loadGame = json => (json ? Game.fromJSON(typeof json === 'string' ? JSON.parse(json) : json) : null);

module.exports = { applyMessage, publicState, exchangeCode, whoAmI, loadGame, GameError };
