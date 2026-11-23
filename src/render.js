'use strict';
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { PIECES, PIECE_IDS, orientations } = require('./engine/pieces');
const { PUZZLES } = require('./engine/puzzles');
const { tryPlace, filledSet } = require('./engine/game');

GlobalFonts.registerFromPath(path.join(__dirname, '../assets/fonts/Inter-Regular.otf'), 'TW');
GlobalFonts.registerFromPath(path.join(__dirname, '../assets/fonts/Inter-Bold.otf'), 'TWB');

const C = {
  bg: '#1b1f2a', panel: '#262b39', panelHi: '#30364a', text: '#eef0f6', dim: '#9aa3b8',
  card: '#f4efe4', cardEdge: '#d9d0bd', hole: '#d6ccb6', holeEdge: '#bfb398',
  bronze: '#b8743a', gold: '#d4a017', ok: '#3ddc84', bad: '#ff5a5f', accent: '#7aa2ff',
};

const font = (size, bold) => `${size}px ${bold ? 'TWB' : 'TW'}`;

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function tile(ctx, x, y, s, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  rr(ctx, x + 1, y + 1, s - 2, s - 2, Math.max(2, s * 0.18));
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.strokeStyle = shade(color, -0.25); ctx.stroke();
  // bevel highlight
  ctx.beginPath(); ctx.moveTo(x + s * 0.22, y + s * 0.2); ctx.lineTo(x + s * 0.78, y + s * 0.2);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, s * 0.08); ctx.stroke();
  ctx.restore();
}

/** Draw a piece glyph inside box (bx,by,bw,bh), centered. */
function pieceGlyph(ctx, pieceId, bx, by, bw, bh, cell, orient = 0) {
  const shape = orientations(pieceId)[orient];
  const w = Math.max(...shape.map(c => c[0])) + 1, h = Math.max(...shape.map(c => c[1])) + 1;
  const ox = bx + (bw - w * cell) / 2, oy = by + (bh - h * cell) / 2;
  for (const [x, y] of shape) tile(ctx, ox + x * cell, oy + y * cell, cell, PIECES[pieceId].color);
}

/**
 * Draw a puzzle card. held = {puzzleId, placed} or just puzzleId.
 * opts: { cell, label, ghost: {cells, valid, pieceId}, dim }
 */
function puzzleCard(ctx, x, y, held, opts = {}) {
  const cell = opts.cell || 20;
  const h0 = typeof held === 'string' ? { puzzleId: held, placed: [] } : held;
  const pz = PUZZLES[h0.puzzleId];
  const pad = Math.round(cell * 0.5), head = Math.round(cell * 1.4);
  const foot = Math.round(cell * 1.3);
  const W = cell * 5 + pad * 2, H = head + cell * 5 + pad * 1.6 + foot;
  const tierColor = pz.tier === 'gold' ? C.gold : C.bronze;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
  rr(ctx, x, y, W, H, cell * 0.45); ctx.fillStyle = C.card; ctx.fill();
  ctx.restore();
  rr(ctx, x, y, W, H, cell * 0.45); ctx.lineWidth = Math.max(2, cell * 0.12); ctx.strokeStyle = tierColor; ctx.stroke();

  // header band
  ctx.save(); rr(ctx, x, y, W, head, cell * 0.45); ctx.clip();
  ctx.fillStyle = tierColor; ctx.fillRect(x, y, W, head); ctx.restore();
  ctx.fillStyle = '#fff'; ctx.font = font(Math.round(cell * 0.62), true); ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(opts.label || pz.id, x + pad * 0.8, y + head / 2);
  // points badge
  const bx = x + W - pad * 0.7 - cell * 0.95, by = y + head / 2;
  ctx.beginPath(); ctx.arc(bx, by, cell * 0.52, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.fillStyle = tierColor; ctx.font = font(Math.round(cell * 0.62), true); ctx.textAlign = 'center';
  ctx.fillText(String(pz.points), bx, by + 1);
  // grid
  const gx = x + pad + ((5 - pz.width) * cell) / 2, gy = y + head + pad * 0.8 + ((5 - pz.height) * cell) / 2;
  for (const [cx, cy] of pz.cells) {
    rr(ctx, gx + cx * cell + 1, gy + cy * cell + 1, cell - 2, cell - 2, cell * 0.15);
    ctx.fillStyle = C.hole; ctx.fill(); ctx.strokeStyle = C.holeEdge; ctx.lineWidth = 1; ctx.stroke();
  }
  for (const pl of h0.placed) for (const [cx, cy] of pl.cells) tile(ctx, gx + cx * cell, gy + cy * cell, cell, PIECES[pl.piece].color);
  // footer: puzzle id + reward tile
  const fy = y + H - foot;
  ctx.strokeStyle = C.cardEdge; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + pad * 0.6, fy); ctx.lineTo(x + W - pad * 0.6, fy); ctx.stroke();
  ctx.fillStyle = '#8a7f6a'; ctx.font = font(Math.round(cell * 0.48), true); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(opts.sub || '', x + pad * 0.8, fy + foot / 2);
  ctx.textAlign = 'right'; ctx.fillText('REWARD', x + W - pad * 0.8 - cell * 1.7, fy + foot / 2);
  pieceGlyph(ctx, pz.reward, x + W - pad * 0.6 - cell * 1.6, fy + 2, cell * 1.6, foot - 4, Math.max(4, Math.round(cell * 0.28)));
  if (opts.ghost) {
    const g = opts.ghost;
    for (const [cx, cy] of g.cells) {
      const px = gx + cx * cell, py = gy + cy * cell;
      if (g.valid) tile(ctx, px, py, cell, PIECES[g.pieceId].color, 0.85);
      else {
        rr(ctx, px + 2, py + 2, cell - 4, cell - 4, cell * 0.15);
        ctx.fillStyle = 'rgba(255,90,95,0.35)'; ctx.fill();
      }
      rr(ctx, px + 1, py + 1, cell - 2, cell - 2, cell * 0.15);
      ctx.lineWidth = Math.max(2, cell * 0.1); ctx.strokeStyle = g.valid ? C.ok : C.bad; ctx.stroke();
    }
  }
  if (opts.dim) { rr(ctx, x, y, W, H, cell * 0.45); ctx.fillStyle = 'rgba(27,31,42,0.55)'; ctx.fill(); }
  return { W, H };
}

const cardSize = cell => {
  const pad = Math.round(cell * 0.5), head = Math.round(cell * 1.4);
  return { W: cell * 5 + pad * 2, H: head + cell * 5 + pad * 1.6 + Math.round(cell * 1.3) };
};

function handStrip(ctx, x, y, w, hand, cell = 12, opts = {}) {
  const ids = PIECE_IDS;
  const slot = w / ids.length;
  ids.forEach((id, i) => {
    const n = hand[id] || 0;
    const sx = x + i * slot;
    rr(ctx, sx + 2, y, slot - 4, cell * 4.2, 8);
    ctx.fillStyle = n ? C.panelHi : 'rgba(255,255,255,0.03)'; ctx.fill();
    ctx.save(); if (!n) ctx.globalAlpha = 0.25;
    pieceGlyph(ctx, id, sx + 2, y + 2, slot - 4, cell * 3.1, cell);
    ctx.restore();
    ctx.fillStyle = n ? C.text : C.dim; ctx.font = font(Math.round(cell * 0.95), true);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.supply ? `${n}` : `×${n}`, sx + slot / 2, y + cell * 3.6);
  });
}

function text(ctx, s, x, y, size, color = C.text, bold = false, align = 'left') {
  ctx.font = font(size, bold); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
}

function drawMarket(ctx, game, y, W) {
  const mc = 22, mcs = cardSize(mc);
  for (const tier of ['bronze', 'gold']) {
    rr(ctx, 16, y, W - 32, mcs.H + 30, 14); ctx.fillStyle = C.panel; ctx.fill();
    text(ctx, tier === 'gold' ? 'GOLD COMMISSIONS' : 'BRONZE COMMISSIONS', 32, y + 22, 14, tier === 'gold' ? C.gold : C.bronze, true);
    const prefix = tier === 'gold' ? 'G' : 'B';
    game.market[tier].forEach((pid, i) => {
      const cx = 32 + i * (mcs.W + 18);
      if (pid) puzzleCard(ctx, cx, y + 30, pid, { cell: mc, label: `${prefix}${i + 1}`, sub: pid });
      else { rr(ctx, cx, y + 30, mcs.W, mcs.H - 8, 10); ctx.strokeStyle = C.dim; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]); }
    });
    // deck
    const dx = 32 + 4 * (mcs.W + 18) + 20;
    const n = game.decks[tier].length;
    for (let k = Math.min(n, 4) - 1; k >= 0; k--) {
      rr(ctx, dx + k * 4, y + 30 + k * 4, mcs.W * 0.8, mcs.H - 20, 10);
      ctx.fillStyle = tier === 'gold' ? shade(C.gold, -0.15 + k * 0.03) : shade(C.bronze, -0.15 + k * 0.03); ctx.fill();
    }
    text(ctx, n ? `Deck: ${n}` : 'Deck empty', dx + mcs.W * 0.4, y + 30 + mcs.H / 2, 18, n ? '#fff' : C.bad, true, 'center');
    y += mcs.H + 40;
  }

  return y;
}

function renderMarket(game) {
  const W = 1100, mcs = cardSize(22);
  const cv = createCanvas(W, (mcs.H + 40) * 2 + 16);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, cv.height);
  drawMarket(ctx, game, 10, W);
  return cv.toBuffer('image/png');
}

// ---------------- public renderers ----------------

/** Full shared table: market, bank, and every player's area. */
function renderTable(game) {
  const W = 1100;
  const mc = 22, mcs = cardSize(mc);
  const pc = 16, pcs = cardSize(pc);
  const playerH = 56 + pcs.H + 10;
  const H = 70 + (mcs.H + 40) * 2 + 80 + game.players.length * (playerH + 14) + 10;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  text(ctx, 'TESSERA WORKS', 24, 44, 30, C.text, true);
  const status = game.phase === 'ended' ? 'Game over'
    : `Round ${game.round}${game.finalRound ? ' (FINAL)' : game.endTriggered ? ' (last full round)' : ''} · ${game.current.name}'s turn · ${game.actionsLeft} action${game.actionsLeft === 1 ? '' : 's'} left`;
  text(ctx, status, W - 24, 44, 18, game.finalRound ? C.gold : C.dim, true, 'right');

  let y = drawMarket(ctx, game, 70, W);

  // bank
  rr(ctx, 16, y, W - 32, 70, 14); ctx.fillStyle = C.panel; ctx.fill();
  text(ctx, 'BANK', 32, y + 40, 14, C.dim, true);
  handStrip(ctx, 100, y + 8, W - 132, game.supply, 12, { supply: true });
  y += 80;

  game.players.forEach((p, idx) => {
    const isCur = game.phase === 'playing' && idx === game.turn;
    rr(ctx, 16, y, W - 32, playerH, 14); ctx.fillStyle = isCur ? C.panelHi : C.panel; ctx.fill();
    if (isCur) { ctx.lineWidth = 3; ctx.strokeStyle = C.accent; ctx.stroke(); }
    text(ctx, `${isCur ? '▶ ' : ''}${p.name}`, 32, y + 32, 20, C.text, true);
    text(ctx, `${p.score} pts · ${p.completed.length} completed`, W - 32, y + 32, 18, C.gold, true, 'right');
    // puzzles
    for (let i = 0; i < 4; i++) {
      const cx = 32 + i * (pcs.W + 12);
      if (p.puzzles[i]) puzzleCard(ctx, cx, y + 46, p.puzzles[i], { cell: pc, label: `#${i + 1}`, sub: p.puzzles[i].puzzleId });
      else { rr(ctx, cx, y + 46, pcs.W, pcs.H - 6, 8); ctx.strokeStyle = 'rgba(154,163,184,0.35)'; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]); }
    }
    const hx = 32 + 4 * (pcs.W + 12) + 10;
    handStrip(ctx, hx, y + 56, W - 32 - hx, p.hand, 13);
    y += playerH + 14;
  });
  return cv.toBuffer('image/png');
}

/** One player's workshop (larger), optionally with a ghost placement on one puzzle. */
function renderWorkshop(game, player, ghostInfo) {
  const cell = 30, cs = cardSize(cell);
  const W = Math.max(4 * (cs.W + 16) + 32, 700), H = cs.H + 190;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  text(ctx, `${player.name}'s workshop`, 20, 34, 22, C.text, true);
  text(ctx, `${player.score} pts`, W - 20, 34, 20, C.gold, true, 'right');
  for (let i = 0; i < 4; i++) {
    const x = 20 + i * (cs.W + 16), y = 52;
    const held = player.puzzles[i];
    if (!held) {
      rr(ctx, x, y, cs.W, cs.H - 8, 10); ctx.strokeStyle = 'rgba(154,163,184,0.35)'; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]);
      text(ctx, 'empty slot', x + cs.W / 2, y + cs.H / 2, 15, C.dim, false, 'center');
      continue;
    }
    const ghost = ghostInfo && ghostInfo.puzzleIdx === i ? ghostInfo : null;
    puzzleCard(ctx, x, y, held, { cell, label: `#${i + 1}`, sub: held.puzzleId, ghost, dim: ghostInfo && ghostInfo.focus != null && ghostInfo.focus !== i });
  }
  rr(ctx, 16, cs.H + 66, W - 32, 110, 14); ctx.fillStyle = C.panel; ctx.fill();
  text(ctx, 'YOUR TILES', 32, cs.H + 88, 13, C.dim, true);
  handStrip(ctx, 28, cs.H + 96, W - 56, ghostInfo && ghostInfo.handOverride || player.hand, 17);
  return cv.toBuffer('image/png');
}

/** Ghost preview data for a pending placement. */
function ghostFor(held, pieceId, orient, x, y) {
  const shape = orientations(pieceId)[orient];
  const cells = shape.map(([dx, dy]) => [x + dx, y + dy]);
  const valid = !!tryPlace(held.puzzleId, filledSet(held), pieceId, orient, x, y);
  return { cells, valid, pieceId };
}

/** Rules / tile reference card. */
function renderReference() {
  const W = 900, H = 230;
  const cv = createCanvas(W, H); const ctx = cv.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  text(ctx, 'TILES & REFINE LADDER', 24, 38, 22, C.text, true);
  const sizes = [1, 2, 3, 4];
  sizes.forEach((s, i) => {
    const ids = PIECE_IDS.filter(id => PIECES[id].size === s);
    const x0 = 24 + i * 215;
    rr(ctx, x0, 56, 200, 160, 12); ctx.fillStyle = C.panel; ctx.fill();
    text(ctx, `Size ${s}`, x0 + 14, 80, 15, C.dim, true);
    ids.forEach((id, k) => {
      const col = k % 3, row = Math.floor(k / 3);
      const bx = x0 + 8 + col * 62, by = 90 + row * 62;
      pieceGlyph(ctx, id, bx, by, 60, 44, ids.length > 3 ? 11 : 15);
      text(ctx, PIECES[id].name, bx + 30, by + 56, 12, C.text, false, 'center');
    });
    if (i < 3) text(ctx, '→', x0 + 207, 140, 20, C.accent, true, 'center');
  });
  return cv.toBuffer('image/png');
}

module.exports = { renderMarket, renderTable, renderWorkshop, renderReference, ghostFor };
