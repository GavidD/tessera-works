'use strict';
const { ACTIONS_PER_TURN, MAX_HELD_PUZZLES, UNFINISHED_PENALTY, CLOSING_BELL_ROUND } = require('./engine/game');

const RULES = [
  {
    name: '🎯 Goal',
    value: 'Fill commission puzzles with polyomino tiles. Each finished puzzle scores points **and** pays you a new tile, so your workshop grows as you play. Most points at the end wins.',
  },
  {
    name: '🧰 Setup',
    value: 'Everyone starts with a **Dot** (1 square) and a **Duo** (2 squares). Four Bronze and four Gold commissions are face-up in the market. Seat order is random.',
  },
  {
    name: `⚙️ Your turn: ${ACTIONS_PER_TURN} actions (repeats allowed)`,
    value: [
      '**Draw**: take a Dot from the bank.',
      '**Refine**: return one tile and take one that is exactly **1 size larger**, or any tile of the **same or smaller** size.',
      `**Commission**: take a face-up puzzle (it is replaced from its deck) or blind-draw the top of a deck. Hold at most ${MAX_HELD_PUZZLES}.`,
      '**Fit**: place one tile into one of your puzzles. Rotate or mirror it freely, but tiles can never overlap or stick out.',
      '**Flurry** *(once per turn)*: place one tile into **each** of any number of your puzzles, all for a single action.',
    ].join('\n'),
  },
  {
    name: '✅ Completing a puzzle',
    value: 'The moment a puzzle is full: score its points, **take back every tile** you used, and claim its reward tile from the bank (if any are left). Finishing 2+ puzzles in one action earns a **+1 combo bonus**.',
  },
  {
    name: '🏁 Game end',
    value: `When the Gold deck runs out, or after round ${CLOSING_BELL_ROUND} (the *closing bell*), finish the current round and then play **one final round**. Each unfinished puzzle costs ${UNFINISHED_PENALTY.bronze} pt (Bronze) or ${UNFINISHED_PENALTY.gold} pts (Gold). Ties go to whoever completed more puzzles, then whoever holds more tiles.`,
  },
  {
    name: '🎮 Controls',
    value: 'Press **Open my panel** under the table to get your private controls. In placement mode, move the ghost tile with the arrows, ↻ rotate, ⇋ mirror, or ⏭ jump to the next spot where it fits. A green outline means it fits; red means it does not.',
  },
];

module.exports = { RULES };
