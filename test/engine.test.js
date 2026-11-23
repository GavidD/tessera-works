'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PUZZLES } = require('../src/engine/puzzles');
const { PIECES, PIECE_IDS, orientations } = require('../src/engine/pieces');
const { Game, GameError, listPlacements, filledSet } = require('../src/engine/game');

test('pieces have expected orientation counts', () => {
  const expect = { dot: 1, duo: 2, bar3: 2, bend: 4, bar4: 2, block: 1, tee: 4, zig: 4, hook: 8 };
  for (const [id, n] of Object.entries(expect)) assert.strictEqual(orientations(id).length, n, id);
});

test('every puzzle is connected, fits 5x5, and has unique shape', () => {
  const seen = new Set();
  for (const pz of Object.values(PUZZLES)) {
    assert.ok(pz.width <= 5 && pz.height <= 5, pz.id);
    assert.ok(PIECES[pz.reward], pz.id + ' reward');
    const set = new Set(pz.cells.map(c => c.join(',')));
    const stack = [pz.cells[0]]; const vis = new Set([pz.cells[0].join(',')]);
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (set.has(k) && !vis.has(k)) { vis.add(k); stack.push([x + dx, y + dy]); }
      }
    }
    assert.strictEqual(vis.size, set.size, pz.id + ' connected');
    const sig = [...set].sort().join(';');
    assert.ok(!seen.has(sig), pz.id + ' duplicate shape'); seen.add(sig);
  }
});

test('turn validation and refine rules', () => {
  const g = new Game({ channelId: 'c', hostId: 'a', hostName: 'A', rng: () => 0.3 });
  g.addPlayer('b', 'B');
  g.start();
  const cur = g.current.id, other = g.players[1].id;
  assert.throws(() => g.draw(other), GameError);
  assert.throws(() => g.refine(cur, 'dot', 'bar3'), GameError); // skip a size
  g.refine(cur, 'dot', 'duo');
  assert.strictEqual(g.current.hand.duo, 2);
  g.draw(cur); g.draw(cur);
  assert.strictEqual(g.current.id, other, 'turn passes after 3 actions');
});

// Greedy random bot used to fuzz full games.
function botTurn(g, rng) {
  const p = g.current; const id = p.id; const startTurn = g.turn;
  let guard = 0;
  while (g.phase === 'playing' && g.turn === startTurn && g.current.id === id && guard++ < 10) {
    const opts = [];
    for (let i = 0; i < p.puzzles.length; i++) {
      for (const pid of PIECE_IDS) if (p.hand[pid]) {
        const pl = listPlacements(p.puzzles[i].puzzleId, filledSet(p.puzzles[i]), pid);
        if (pl.length) opts.push(() => g.fit(id, i, pid, pl[Math.floor(rng() * pl.length)].cells));
      }
    }
    if (p.puzzles.length < 2 || (p.puzzles.length < 4 && rng() < 0.2)) {
      const tier = rng() < 0.5 ? 'bronze' : 'gold';
      const slot = g.market[tier].findIndex(Boolean);
      if (slot >= 0) opts.unshift(() => g.commission(id, tier, slot));
    }
    const up = PIECE_IDS.filter(x => p.hand[x] && PIECES[x].size < 4);
    if (up.length && rng() < 0.4) {
      const from = up[Math.floor(rng() * up.length)];
      const to = g.refineTargets(from).filter(t => PIECES[t].size > PIECES[from].size && g.supply[t] > 0);
      if (to.length) opts.unshift(() => g.refine(id, from, to[Math.floor(rng() * to.length)]));
    }
    try {
      if (opts.length) opts[Math.floor(rng() * Math.min(opts.length, 3))]();
      else if (g.supply.dot > 0) g.draw(id);
      else g.endTurn(id);
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      g.endTurn(id);
    }
  }
}

test('random full games terminate with conserved tiles', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let s = seed;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const n = 1 + (seed % 4);
    const g = new Game({ channelId: 'c', hostId: 'p0', hostName: 'P0', rng });
    for (let i = 1; i < n; i++) g.addPlayer('p' + i, 'P' + i);
    g.start();
    const total = PIECE_IDS.reduce((acc, id) => acc + g.supply[id], 0) + 2 * n;
    let turns = 0;
    while (g.phase === 'playing' && turns++ < 2000) botTurn(g, rng);
    assert.strictEqual(g.phase, 'ended', `seed ${seed} ended`);
    const now = PIECE_IDS.reduce((acc, id) => acc + g.supply[id]
      + g.players.reduce((a, p) => a + p.hand[id] + p.puzzles.reduce((b, h) => b + h.placed.filter(x => x.piece === id).length, 0), 0), 0);
    assert.strictEqual(now, total, 'tile conservation');
    // JSON round-trip
    const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g)));
    assert.strictEqual(g2.standings[0].name, g.standings[0].name);
  }
});
