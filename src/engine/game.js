'use strict';
const { PIECES, PIECE_IDS, SUPPLY, orientations } = require('./pieces');
const { PUZZLES, deckIds } = require('./puzzles');

const ACTIONS_PER_TURN = 3;
const MAX_HELD_PUZZLES = 4;
const MARKET_SIZE = 4;
const MAX_PLAYERS = 4;
const UNFINISHED_PENALTY = { bronze: 1, gold: 2 };
const CLOSING_BELL_ROUND = 14; // end is also triggered after this round, guaranteeing the game ends

class GameError extends Error {}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- geometry helpers (pure) ----------
const ck = (x, y) => `${x},${y}`;

function filledSet(held) {
  const s = new Set();
  for (const pl of held.placed) for (const [x, y] of pl.cells) s.add(ck(x, y));
  return s;
}

/** Cells covered by piece/orientation anchored at (x,y), or null if it does not fit. */
function tryPlace(puzzleId, filled, pieceId, orient, x, y) {
  const puzzle = PUZZLES[puzzleId];
  const shape = orientations(pieceId)[orient];
  const open = new Set(puzzle.cells.map(([a, b]) => ck(a, b)));
  const cells = shape.map(([dx, dy]) => [x + dx, y + dy]);
  for (const [cx, cy] of cells) {
    if (!open.has(ck(cx, cy)) || filled.has(ck(cx, cy))) return null;
  }
  return cells;
}

function listPlacements(puzzleId, filled, pieceId) {
  const puzzle = PUZZLES[puzzleId];
  const out = [];
  orientations(pieceId).forEach((_, o) => {
    for (let y = 0; y < puzzle.height; y++) {
      for (let x = 0; x < puzzle.width; x++) {
        const cells = tryPlace(puzzleId, filled, pieceId, o, x, y);
        if (cells) out.push({ orient: o, x, y, cells });
      }
    }
  });
  return out;
}

function cellsMatchPiece(pieceId, cells) {
  const norm = c => {
    const mx = Math.min(...c.map(p => p[0])), my = Math.min(...c.map(p => p[1]));
    return c.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]).join(';');
  };
  const n = norm(cells);
  return orientations(pieceId).some(o => norm(o) === n);
}

// ---------- game ----------
class Game {
  constructor({ channelId, hostId, hostName, rng }) {
    this.channelId = channelId;
    this.hostId = hostId;
    this.phase = 'lobby';
    this.players = [];
    this.log = [];
    this.rng = rng || Math.random;
    this.addPlayer(hostId, hostName);
  }

  static fromJSON(obj) {
    const g = Object.create(Game.prototype);
    Object.assign(g, obj);
    g.rng = Math.random;
    return g;
  }

  toJSON() {
    const { rng, ...rest } = this;
    return rest;
  }

  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new GameError('The game has already started.');
    if (this.players.some(p => p.id === id)) throw new GameError('You are already in this game.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`This game is full (${MAX_PLAYERS} players).`);
    this.players.push({ id, name, hand: {}, puzzles: [], completed: [], score: 0 });
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') throw new GameError('You can only leave before the game starts.');
    this.players = this.players.filter(p => p.id !== id);
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('The game has already started.');
    this.phase = 'playing';
    this.players = shuffle(this.players, this.rng);
    this.supply = { ...SUPPLY };
    this.decks = { bronze: shuffle(deckIds('bronze'), this.rng), gold: shuffle(deckIds('gold'), this.rng) };
    this.market = { bronze: [], gold: [] };
    for (const t of ['bronze', 'gold']) for (let i = 0; i < MARKET_SIZE; i++) this.market[t].push(this.decks[t].pop());
    for (const p of this.players) {
      p.hand = {};
      for (const id of PIECE_IDS) p.hand[id] = 0;
      this._give(p, 'dot');
      this._give(p, 'duo');
    }
    this.turn = 0;
    this.round = 1;
    this.endTriggered = false;
    this.finalRound = false;
    this._beginTurn();
    this._log(`Game started! Seat order: ${this.players.map(p => p.name).join(' → ')}.`);
  }

  get current() { return this.players[this.turn]; }
  player(id) { return this.players.find(p => p.id === id); }

  _log(msg) { this.log.push(msg); if (this.log.length > 30) this.log.shift(); }

  _give(p, pieceId) {
    if (this.supply[pieceId] <= 0) return false;
    this.supply[pieceId]--; p.hand[pieceId]++; return true;
  }

  _beginTurn() {
    this.actionsLeft = ACTIONS_PER_TURN;
    this.flurryUsed = false;
  }

  _assertTurn(userId) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    if (this.current.id !== userId) throw new GameError(`It's ${this.current.name}'s turn.`);
    if (this.actionsLeft <= 0) throw new GameError('You have no actions left.');
  }

  _spendAction() {
    this.actionsLeft--;
    if (this.actionsLeft <= 0) this.endTurn(this.current.id, true);
  }

  // --- Action: Draw ---
  draw(userId) {
    this._assertTurn(userId);
    const p = this.current;
    if (!this._give(p, 'dot')) throw new GameError('The bank is out of Dots.');
    this._log(`${p.name} drew a Dot.`);
    this._spendAction();
  }

  // --- Action: Refine (upgrade by exactly one size, or swap down / sideways) ---
  refineTargets(fromId) {
    const s = PIECES[fromId].size;
    return PIECE_IDS.filter(id => id !== fromId && (PIECES[id].size === s + 1 || PIECES[id].size <= s));
  }

  refine(userId, fromId, toId) {
    this._assertTurn(userId);
    const p = this.current;
    if (!PIECES[fromId] || !PIECES[toId]) throw new GameError('Pick a tile to refine first.');
    if (!p.hand[fromId]) throw new GameError(`You have no ${PIECES[fromId].name}.`);
    if (!this.refineTargets(fromId).includes(toId)) throw new GameError(`A ${PIECES[fromId].name} can't be refined into a ${PIECES[toId].name}.`);
    if (this.supply[toId] <= 0) throw new GameError(`The bank is out of ${PIECES[toId].name} tiles.`);
    p.hand[fromId]--; this.supply[fromId]++;
    this.supply[toId]--; p.hand[toId]++;
    this._log(`${p.name} refined a ${PIECES[fromId].name} into a ${PIECES[toId].name}.`);
    this._spendAction();
  }

  // --- Action: Commission (take a puzzle) ---
  commission(userId, tier, slot) {
    this._assertTurn(userId);
    const p = this.current;
    if (p.puzzles.length >= MAX_HELD_PUZZLES) throw new GameError(`You can hold at most ${MAX_HELD_PUZZLES} puzzles.`);
    let puzzleId;
    if (slot === 'deck') {
      if (!this.decks[tier].length) throw new GameError(`The ${tier} deck is empty.`);
      puzzleId = this.decks[tier].pop();
    } else {
      puzzleId = this.market[tier][slot];
      if (!puzzleId) throw new GameError('That market slot is empty.');
      this.market[tier][slot] = this.decks[tier].pop() || null;
    }
    p.puzzles.push({ puzzleId, placed: [] });
    this._log(`${p.name} commissioned puzzle ${puzzleId}.`);
    this._checkEndTrigger();
    this._spendAction();
  }

  _checkEndTrigger() {
    if (!this.endTriggered && this.decks.gold.length === 0) {
      this.endTriggered = true;
      this._log('⚠️ The gold deck is empty! Finish this round, then play one final round.');
    }
  }

  // --- Action: Fit (place one tile) ---
  _validatePlacement(p, puzzleIdx, pieceId, cells, extraFilled) {
    const held = p.puzzles[puzzleIdx];
    if (!held) throw new GameError('No such puzzle.');
    if (!PIECES[pieceId]) throw new GameError('Unknown tile.');
    if (!cellsMatchPiece(pieceId, cells)) throw new GameError('Those cells do not match that tile shape.');
    const filled = filledSet(held);
    const open = new Set(PUZZLES[held.puzzleId].cells.map(([x, y]) => ck(x, y)));
    for (const [x, y] of cells) {
      if (!open.has(ck(x, y)) || filled.has(ck(x, y)) || (extraFilled && extraFilled.has(ck(x, y)))) {
        throw new GameError("That tile doesn't fit there.");
      }
    }
  }

  fit(userId, puzzleIdx, pieceId, cells) {
    this._assertTurn(userId);
    const p = this.current;
    if (!p.hand[pieceId]) throw new GameError(`You have no ${PIECES[pieceId].name}.`);
    this._validatePlacement(p, puzzleIdx, pieceId, cells);
    p.hand[pieceId]--;
    p.puzzles[puzzleIdx].placed.push({ piece: pieceId, cells });
    this._log(`${p.name} fitted a ${PIECES[pieceId].name} into ${p.puzzles[puzzleIdx].puzzleId}.`);
    const done = this._resolveCompletions(p);
    this._spendAction();
    return done;
  }

  // --- Action: Flurry (once per turn: one tile into each of any number of your puzzles) ---
  flurry(userId, placements) {
    this._assertTurn(userId);
    const p = this.current;
    if (this.flurryUsed) throw new GameError('You already used Flurry this turn.');
    if (!placements.length) throw new GameError('Flurry needs at least one placement.');
    const idxs = new Set();
    const need = {};
    for (const pl of placements) {
      if (idxs.has(pl.puzzleIdx)) throw new GameError('Flurry places at most one tile per puzzle.');
      idxs.add(pl.puzzleIdx);
      need[pl.pieceId] = (need[pl.pieceId] || 0) + 1;
      this._validatePlacement(p, pl.puzzleIdx, pl.pieceId, pl.cells);
    }
    for (const [id, n] of Object.entries(need)) {
      if ((p.hand[id] || 0) < n) throw new GameError(`You don't have enough ${PIECES[id].name} tiles.`);
    }
    for (const pl of placements) {
      p.hand[pl.pieceId]--;
      p.puzzles[pl.puzzleIdx].placed.push({ piece: pl.pieceId, cells: pl.cells });
    }
    this.flurryUsed = true;
    this._log(`${p.name} used Flurry, placing ${placements.length} tile(s).`);
    const done = this._resolveCompletions(p);
    this._spendAction();
    return done;
  }

  isComplete(held) {
    return filledSet(held).size === PUZZLES[held.puzzleId].cells.length;
  }

  _resolveCompletions(p) {
    const done = [];
    p.puzzles = p.puzzles.filter(held => {
      if (!this.isComplete(held)) return true;
      const pz = PUZZLES[held.puzzleId];
      for (const pl of held.placed) p.hand[pl.piece]++; // tiles come back
      const gotReward = this._give(p, pz.reward);
      p.score += pz.points;
      p.completed.push(held.puzzleId);
      done.push(held.puzzleId);
      this._log(`🎉 ${p.name} completed ${pz.id}: +${pz.points} pts${gotReward ? `, reward ${PIECES[pz.reward].name}` : ' (reward tile out of stock)'}.`);
      return false;
    });
    if (done.length >= 2) {
      p.score += 1;
      this._log(`✨ Combo! ${p.name} finished ${done.length} puzzles in one action: +1 pt.`);
    }
    return done;
  }

  // --- turn flow ---
  endTurn(userId, auto = false) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    if (this.current.id !== userId) throw new GameError(`It's ${this.current.name}'s turn.`);
    if (!auto) this._log(`${this.current.name} ended their turn early.`);
    const lastSeat = this.turn === this.players.length - 1;
    if (lastSeat) {
      if (this.finalRound) return this._finish();
      if (!this.endTriggered && this.round >= CLOSING_BELL_ROUND) {
        this.endTriggered = true;
        this._log(`🔔 Closing bell: round ${this.round} is over.`);
      }
      if (this.endTriggered) {
        this.finalRound = true;
        this._log('🔔 Final round begins!');
      }
      this.round++;
    }
    this.turn = (this.turn + 1) % this.players.length;
    this._beginTurn();
  }

  _finish() {
    this.phase = 'ended';
    for (const p of this.players) {
      let pen = 0;
      for (const h of p.puzzles) pen += UNFINISHED_PENALTY[PUZZLES[h.puzzleId].tier];
      p.penalty = pen;
      p.score -= pen;
    }
    const tiles = p => PIECE_IDS.reduce((s, id) => s + (p.hand[id] || 0), 0);
    this.standings = [...this.players].sort((a, b) =>
      b.score - a.score || b.completed.length - a.completed.length || tiles(b) - tiles(a));
    this._log(`🏆 Game over! ${this.standings[0].name} wins with ${this.standings[0].score} pts.`);
  }

  forceEnd() { this._finish(); }
}

module.exports = {
  Game, GameError, tryPlace, listPlacements, filledSet,
  ACTIONS_PER_TURN, MAX_HELD_PUZZLES, UNFINISHED_PENALTY, CLOSING_BELL_ROUND,
};
