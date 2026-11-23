'use strict';
// Drives the bot's interaction handlers with mock Discord objects (no network needed).
const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `tw-test-${process.pid}.json`);
const bot = require('../src/bot');
const { PIECES } = require('../src/engine/pieces');

function mockChannel() {
  const msgs = new Map(); let n = 0;
  return {
    msgs,
    send: async p => { const m = { id: String(++n), payload: p, edit: async q => { m.payload = q; }, delete: async () => msgs.delete(m.id) }; msgs.set(m.id, m); return m; },
    messages: { fetch: async id => { if (!msgs.has(id)) throw new Error('nf'); return msgs.get(id); } },
  };
}

function mockInteraction(channel, uid, customId, values) {
  const it = {
    channelId: 'chan', channel, user: { id: uid, username: uid }, member: { displayName: uid.toUpperCase() },
    customId, values, replied: false, deferred: false, last: null, memberPermissions: { has: () => false },
    reply: async p => { it.replied = true; it.last = p; },
    update: async p => { it.replied = true; it.last = p; },
    deferUpdate: async () => { it.deferred = true; },
    followUp: async p => { it.followed = p; },
  };
  return it;
}

async function click(ch, uid, id, values) {
  const it = mockInteraction(ch, uid, `tw:${id}`, values);
  await bot.onButtonOrSelect(it);
  validate(it.last);
  return it.last;
}

// Run discord.js builder validation, as sending to the API would.
function validate(p) {
  if (!p) return;
  for (const r of p.components || []) r.toJSON();
  for (const e of p.embeds || []) e.toJSON();
}

const componentIds = payload => payload.components.flatMap(r => r.components.map(c => c.data.custom_id));

test('lobby → start → refine → commission → fit → flurry flow', async () => {
  const ch = mockChannel();
  const cmd = { channelId: 'chan', channel: ch, user: { id: 'alice', username: 'alice' }, member: { displayName: 'Alice' },
    options: { getSubcommand: () => 'new' }, reply: async p => { cmd.last = p; } };
  await bot.onCommand(cmd);
  assert.ok(componentIds(cmd.last).includes('tw:join'));
  await click(ch, 'bob', 'join');
  await click(ch, 'alice', 'start');
  const game = bot.games.get('chan');
  assert.strictEqual(game.phase, 'playing');
  assert.strictEqual(ch.msgs.size, 1, 'table posted');

  const me = game.current.id, other = game.players.find(p => p.id !== me).id;
  // Other player's panel shows waiting
  const wait = await click(ch, other, 'refresh');
  assert.match(wait.embeds[0].data.title, /Waiting/);

  // Refine Dot -> Duo
  await click(ch, me, 'mode:refine');
  const r = await click(ch, me, 'refinefrom', ['dot']);
  assert.ok(componentIds(r).includes('tw:refineto'));
  await click(ch, me, 'refineto', ['duo']);
  assert.strictEqual(game.player(me).hand.duo, 2);
  // Commission bronze slot 0 and gold slot 0
  await click(ch, me, 'mode:commission');
  await click(ch, me, 'commission', ['bronze:0']);
  await click(ch, me, 'mode:commission');
  await click(ch, me, 'commission', ['gold:0']);
  assert.strictEqual(game.current.id, other, 'turn passed after 3 actions');

  // Other player: commission, then fit via cursor + next-fit
  await click(ch, other, 'mode:commission');
  await click(ch, other, 'commission', ['bronze:1']);
  await click(ch, other, 'mode:fit');
  let p = await click(ch, other, 'pickpiece', ['duo']); // single puzzle auto-selected
  assert.ok(componentIds(p).includes('tw:confirmplace'), 'in placement mode');
  await click(ch, other, 'mv:rot');
  await click(ch, other, 'mv:flip');
  p = await click(ch, other, 'mv:next');
  const confirm = p.components.flatMap(r => r.components).find(c => c.data.custom_id === 'tw:confirmplace');
  assert.strictEqual(confirm.data.disabled, false, 'next-fit lands on a valid spot');
  await click(ch, other, 'confirmplace');
  const placed = game.player(other).puzzles[0]?.placed.length ?? 0;
  assert.ok(placed === 1 || game.player(other).completed.length === 1);

  // Other player: Flurry with the Dot into their puzzle
  await click(ch, other, 'mode:flurry');
  await click(ch, other, 'pickpiece', ['dot']);
  await click(ch, other, 'mv:next');
  const fl = await click(ch, other, 'confirmplace');
  assert.match(fl.embeds[0].data.title, /Flurry \(1 queued\)/);
  await click(ch, other, 'flurrygo');
  assert.strictEqual(game.current.id, me, 'turn passed back');
  assert.strictEqual(ch.msgs.size, 1, 'old table replaced, not duplicated');
  const table = [...ch.msgs.values()][0].payload;
  assert.match(table.content, new RegExp(`<@${me}>`));
});

test('errors surface as GameError', async () => {
  const ch = mockChannel();
  const game = bot.games.get('chan');
  const notTurn = game.players.find(p => p.id !== game.current.id).id;
  const it = await click(ch, notTurn, 'draw');
  assert.match(it.embeds[0].data.title, /Waiting/, 'out-of-turn clicks just refresh the panel');
  await assert.rejects(() => click(ch, game.current.id, 'refineto', [Object.keys(PIECES)[8]]), { name: 'Error', message: /Pick a tile/ });
});
