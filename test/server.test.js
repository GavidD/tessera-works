'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.ACTIVITY_DEV_AUTH = '1';
const { startServer } = require('../src/server');
const WebSocket = require('ws');

function client(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', d => { const m = JSON.parse(d); const w = waiters.shift(); if (w) w(m); else inbox.push(m); });
    ws.next = () => new Promise(r => (inbox.length ? r(inbox.shift()) : waiters.push(r)));
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve(ws); });
    ws.on('error', reject);
  });
}

test('activity server: rooms, turns, hidden decks, errors', async () => {
  const server = await startServer({ port: 0 });
  const url = `ws://127.0.0.1:${server.address().port}/api/ws`;
  const a = await client(url, { t: 'hello', dev: 'alice', instance: 'r1' });
  await a.next();
  const b = await client(url, { t: 'hello', dev: 'bob', instance: 'r1' });
  await b.next(); await a.next();
  a.send(JSON.stringify({ t: 'join' })); await a.next(); await b.next();
  b.send(JSON.stringify({ t: 'join' })); await a.next(); await b.next();
  b.send(JSON.stringify({ t: 'start' }));
  assert.match((await b.next()).msg, /host/);
  a.send(JSON.stringify({ t: 'start' }));
  const st = await a.next(); await b.next();
  assert.strictEqual(st.game.phase, 'playing');
  assert.strictEqual(typeof st.game.decks.gold, 'number', 'deck order is hidden');
  const cur = st.game.players[st.game.turn].id === 'dev-alice' ? a : b;
  const other = cur === a ? b : a;
  other.send(JSON.stringify({ t: 'act', action: 'draw' }));
  assert.match((await other.next()).msg, /turn/);
  cur.send(JSON.stringify({ t: 'act', action: 'fit', args: { puzzleIdx: 0, pieceId: 'dot', cells: [[0, 0]] } }));
  assert.match((await cur.next()).msg, /No such puzzle/);
  cur.send(JSON.stringify({ t: 'act', action: 'draw' }));
  const after = await cur.next();
  assert.strictEqual(after.game.actionsLeft, 2);
  a.close(); b.close();
  await new Promise(r => server.close(r));
  for (const ws of [a, b]) ws.terminate();
});

test('activity server rejects unauthenticated hello and serves /token errors', async () => {
  delete process.env.DISCORD_CLIENT_SECRET;
  const server = await startServer({ port: 0 });
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/token`, { method: 'POST', body: '{"code":"x"}' });
  assert.strictEqual(r.status, 500);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise(res => ws.on('open', res));
  ws.send(JSON.stringify({ t: 'hello', instance: 'x', token: 'bogus' }));
  const code = await new Promise(res => ws.on('close', c => res(c)));
  assert.strictEqual(code, 4003);
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});
