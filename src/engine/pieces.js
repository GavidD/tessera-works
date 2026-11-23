'use strict';
// Tile definitions for Tessera Works: generic polyominoes of size 1-4.
// Each shape is a list of [x, y] cells.

const PIECES = {
  dot:   { name: 'Dot',    size: 1, color: '#f2c14e', cells: [[0, 0]] },
  duo:   { name: 'Duo',    size: 2, color: '#f78154', cells: [[0, 0], [1, 0]] },
  bar3:  { name: 'Bar',    size: 3, color: '#4d9de0', cells: [[0, 0], [1, 0], [2, 0]] },
  bend:  { name: 'Bend',   size: 3, color: '#7768ae', cells: [[0, 0], [0, 1], [1, 1]] },
  bar4:  { name: 'Beam',   size: 4, color: '#3bb273', cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  block: { name: 'Block',  size: 4, color: '#e15554', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  tee:   { name: 'Tee',    size: 4, color: '#d17bd6', cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
  zig:   { name: 'Zig',    size: 4, color: '#2ec4b6', cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  hook:  { name: 'Hook',   size: 4, color: '#ff9f1c', cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
};

const PIECE_IDS = Object.keys(PIECES);

// Starting supply per piece type (shared bank). 4 players max.
const SUPPLY = { dot: 16, duo: 14, bar3: 10, bend: 10, bar4: 8, block: 8, tee: 8, zig: 8, hook: 8 };

function normalize(cells) {
  const minX = Math.min(...cells.map(c => c[0]));
  const minY = Math.min(...cells.map(c => c[1]));
  return cells
    .map(([x, y]) => [x - minX, y - minY])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

const key = cells => cells.map(c => c.join(',')).join(';');

// All distinct rotations/reflections of a piece, normalized.
const _orientCache = {};
function orientations(pieceId) {
  if (_orientCache[pieceId]) return _orientCache[pieceId];
  const seen = new Map();
  let cur = PIECES[pieceId].cells;
  for (let flip = 0; flip < 2; flip++) {
    for (let r = 0; r < 4; r++) {
      const n = normalize(cur);
      seen.set(key(n), n);
      cur = cur.map(([x, y]) => [-y, x]); // rotate 90°
    }
    cur = cur.map(([x, y]) => [-x, y]); // mirror
  }
  return (_orientCache[pieceId] = [...seen.values()]);
}

module.exports = { PIECES, PIECE_IDS, SUPPLY, orientations, normalize };
