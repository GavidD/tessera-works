// Tessera Works: Discord Activity client.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { PIECES, PIECE_IDS, orientations, normalize } from '../../src/engine/pieces.js';
import { PUZZLES } from '../../src/engine/puzzles.js';
import { MAX_HELD_PUZZLES, ACTIONS_PER_TURN } from '../../src/engine/game.js';

/* global __CLIENT_ID__ */
const CLIENT_ID = __CLIENT_ID__;
const params = new URLSearchParams(location.search);
const IN_DISCORD = params.has('frame_id');

// ---------------- state ----------------
const S = {
  you: null, game: null, online: [], conn: 'connecting',
  sel: null, // { pieceId, orient }
  hover: null, // { puzzleIdx, x, y }
  mode: null, // null | 'refine' | 'flurry'
  refineFrom: null,
  flurry: [], // [{ puzzleIdx, pieceId, cells }]
  armed: null, // market card key awaiting a 2nd click
};
let ws = null;

const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const me = () => S.game && S.game.players.find(p => p.id === S.you);
const myTurn = () => S.game && S.game.phase === 'playing' && S.game.players[S.game.turn].id === S.you;
const AV_COLORS = ['#f2c14e', '#f78154', '#4d9de0', '#3bb273', '#d17bd6', '#2ec4b6'];
const avColor = id => AV_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];

// ---------------- toast ----------------
let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'win' ? 3500 : 2600);
}

// ---------------- networking ----------------
async function discordAuth() {
  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  setSplash('Signing in…');
  const { code } = await sdk.commands.authorize({ client_id: CLIENT_ID, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
  const r = await fetch('/.proxy/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'token exchange failed');
  await sdk.commands.authenticate({ access_token: body.access_token });
  return { hello: { t: 'hello', token: body.access_token, instance: sdk.instanceId }, url: `wss://${location.host}/.proxy/api/ws` };
}

function devAuth() {
  const name = params.get('dev') || `guest${Math.floor(Math.random() * 1000)}`;
  const server = params.get('server') || location.host;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return { hello: { t: 'hello', dev: name, instance: params.get('room') || 'dev-room' }, url: `${proto}://${server}/api/ws` };
}

let auth = null, retry = 0;
async function connect() {
  try {
    if (!auth) auth = IN_DISCORD ? await discordAuth() : devAuth();
  } catch (e) {
    setSplash(`Couldn't sign in: ${e.message}`);
    return;
  }
  ws = new WebSocket(auth.url);
  ws.onopen = () => { retry = 0; S.conn = 'open'; ws.send(JSON.stringify(auth.hello)); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'error') { toast(m.msg, 'err'); return; }
    if (m.t === 'state') onState(m);
  };
  ws.onclose = ev => {
    S.conn = 'closed';
    if (ev.code === 4003) { setSplash("Couldn't sign you in. Reopen the activity."); return; }
    const delay = Math.min(10000, 500 * 2 ** retry++);
    if (S.game) toast('Connection lost. Reconnecting…', 'err'); else setSplash('Reconnecting…');
    setTimeout(connect, delay);
  };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('Not connected.', 'err');
  ws.send(JSON.stringify(obj));
}
const act = (action, args) => send({ t: 'act', action, args });

function onState(m) {
  const prev = S.game;
  S.you = m.you; S.game = m.game; S.online = m.online;
  const g = S.game;
  // Reset transient UI whenever it's no longer our turn or the turn changed.
  const prevKey = prev && prev.phase === 'playing' ? `${prev.round}:${prev.turn}:${prev.actionsLeft}` : '';
  const key = g && g.phase === 'playing' ? `${g.round}:${g.turn}:${g.actionsLeft}` : '';
  if (prevKey !== key) { S.mode = null; S.flurry = []; S.refineFrom = null; S.armed = null; }
  if (S.sel && (!myTurn() || !me() || !(me().hand[S.sel.pieceId] - queuedCount(S.sel.pieceId) > 0))) S.sel = null;
  if (m.event && m.event.kind === 'complete') {
    const who = g.players.find(p => p.id === m.event.who);
    toast(`🎉 ${who ? who.name : 'Someone'} completed ${m.event.puzzles.join(' & ')}!`, 'win');
  }
  if (prev && prev.phase === 'playing' && g && g.phase === 'playing' && prev.turn !== g.turn && myTurn()) toast("▶ It's your turn!");
  render();
}

function setSplash(msg) {
  const el = document.getElementById('splash-msg');
  if (el) el.textContent = msg; else $app.innerHTML = `<div class="splash"><div class="logo">TESSERA WORKS</div><div class="muted">${esc(msg)}</div></div>`;
}

// ---------------- helpers ----------------
const queuedCount = id => S.flurry.filter(f => f.pieceId === id).length;
const handCount = id => (me() ? me().hand[id] : 0) - queuedCount(id);

function refineTargets(fromId) {
  const s = PIECES[fromId].size;
  return PIECE_IDS.filter(id => id !== fromId && (PIECES[id].size === s + 1 || PIECES[id].size <= s));
}

function ghostCells(pieceId, orient, x, y) {
  const shape = orientations(pieceId)[orient];
  const [ax, ay] = shape[0];
  return shape.map(([cx, cy]) => [x + cx - ax, y + cy - ay]);
}

function filledKeys(held) {
  const s = new Set();
  for (const pl of held.placed) for (const [x, y] of pl.cells) s.add(`${x},${y}`);
  return s;
}

function fits(held, cells) {
  const open = new Set(PUZZLES[held.puzzleId].cells.map(([x, y]) => `${x},${y}`));
  const filled = filledKeys(held);
  return cells.every(([x, y]) => open.has(`${x},${y}`) && !filled.has(`${x},${y}`));
}

function transform(pieceId, orient, fn) {
  const k = c => c.map(p => p.join(',')).join(';');
  const target = k(normalize(orientations(pieceId)[orient].map(fn)));
  const i = orientations(pieceId).findIndex(o => k(o) === target);
  return i < 0 ? orient : i;
}

// ---------------- render pieces ----------------
function glyph(pieceId, orient = 0) {
  const shape = orientations(pieceId)[orient];
  const w = Math.max(...shape.map(c => c[0])) + 1, h = Math.max(...shape.map(c => c[1])) + 1;
  const set = new Set(shape.map(c => c.join(',')));
  let cells = '';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    cells += set.has(`${x},${y}`) ? `<div class="tile" style="--col:${PIECES[pieceId].color}"></div>` : '<div class="cell"></div>';
  }
  return `<div class="glyph" style="grid-template-columns:repeat(${w},var(--c))">${cells}</div>`;
}

function card(held, { label, attrs = '', cls = '', overlay = '', pending = [] } = {}) {
  const h = typeof held === 'string' ? { puzzleId: held, placed: [] } : held;
  const pz = PUZZLES[h.puzzleId];
  const colorAt = new Map();
  for (const pl of h.placed) for (const [x, y] of pl.cells) colorAt.set(`${x},${y}`, ['filled', PIECES[pl.piece].color]);
  for (const pl of pending) for (const [x, y] of pl.cells) colorAt.set(`${x},${y}`, ['pending', PIECES[pl.pieceId].color]);
  const holes = new Set(pz.cells.map(c => c.join(',')));
  const ox = Math.floor((5 - pz.width) / 2), oy = Math.floor((5 - pz.height) / 2);
  let grid = '';
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
    const x = gx - ox, y = gy - oy, k = `${x},${y}`;
    if (colorAt.has(k)) { const [c, col] = colorAt.get(k); grid += `<div class="cell ${c}" data-x="${x}" data-y="${y}" style="--col:${col}"></div>`; }
    else if (holes.has(k)) grid += `<div class="cell hole" data-x="${x}" data-y="${y}"></div>`;
    else grid += `<div class="cell" data-x="${x}" data-y="${y}"></div>`;
  }
  return `<div class="card ${pz.tier} ${cls}" ${attrs}>
    <div class="head"><span>${esc(label || pz.id)}</span><span class="pts">${pz.points}</span></div>
    <div class="grid">${grid}</div>
    <div class="foot"><span>${pz.id}</span><span style="display:flex;align-items:center;gap:4px;--c:6px"><span class="rw">REWARD</span> ${glyph(pz.reward)}</span></div>
    ${overlay}
  </div>`;
}

// ---------------- screens ----------------
function render() {
  const g = S.game;
  if (!g || g.phase === 'lobby') return renderLobby();
  if (g.phase === 'ended') return renderEnd();
  renderGame();
}

function ladder() {
  return `<div class="ladder">${[1, 2, 3, 4].map(s => `<div class="step">${PIECE_IDS.filter(id => PIECES[id].size === s).map(id => `<div style="display:grid;justify-items:center;gap:3px">${glyph(id)}<span class="hint">${PIECES[id].name}</span></div>`).join('')}</div>`).join('')}</div>`;
}

const RULES_HTML = `<div class="rules">
  <div><b>Goal:</b> Fill commission puzzles with tiles. Each one you finish scores points <i>and</i> pays a reward tile, so your workshop grows.</div>
  <div><b>Your turn, 3 actions:</b> <b>Draw</b> a Dot · <b>Refine</b> a tile (exactly 1 size up, or any same/smaller size) · <b>Commission</b> a puzzle (hold ≤ 4) · <b>Fit</b> one tile · <b>Flurry</b> (once per turn): one tile into each of your puzzles, for a single action.</div>
  <div><b>Completing:</b> score the points, get all your tiles back, plus the reward. 2+ puzzles in one action = +1 combo.</div>
  <div><b>End:</b> when the Gold deck runs out (or after round 14), finish the round and then play one final round. Unfinished puzzles cost −1 (Bronze) or −2 (Gold).</div>
</div>`;

function renderLobby() {
  const g = S.game;
  const inGame = g && g.players.some(p => p.id === S.you);
  const host = g && g.hostId === S.you;
  const players = g ? g.players : [];
  $app.innerHTML = `<div class="center">
    <h1>TESSERA WORKS</h1>
    <div class="muted">A polyomino puzzle-building game for 1–4 players.</div>
    <div class="panel"><h3>PLAYERS (${players.length}/4)</h3>
      ${players.length ? players.map(p => `<div class="player" style="margin-bottom:6px"><div class="top">${avatar(p)}<b>${esc(p.name)}</b>${p.id === g.hostId ? '<span class="hint">host</span>' : ''}</div></div>`).join('') : '<div class="muted">No one has joined yet.</div>'}
      <div class="actions" style="margin-top:10px">
        ${!inGame ? `<button class="primary" data-cmd="join" ${players.length >= 4 ? 'disabled' : ''}>${g ? 'Join game' : 'Create game'}</button>` : ''}
        ${inGame && !host ? '<button data-cmd="leave">Leave</button>' : ''}
        ${host ? `<button class="go" data-cmd="start">Start game</button><button class="danger" data-cmd="leave">Close lobby</button>` : ''}
        ${inGame && !host ? '<span class="hint">Waiting for the host to start…</span>' : ''}
      </div>
    </div>
    <div class="panel"><h3>TILES &amp; REFINE LADDER →</h3>${ladder()}</div>
    <div class="panel"><h3>HOW TO PLAY</h3>${RULES_HTML}</div>
  </div>`;
}

function renderEnd() {
  const g = S.game;
  const medals = ['🥇', '🥈', '🥉', '4.'];
  $app.innerHTML = `<div class="center">
    <h1>🏆 Final results</h1>
    ${g.standings.map((p, i) => `<div class="standing">${medals[i]} ${avatar(p)} <b>${esc(p.name)}</b><span class="hint">${p.completed.length} puzzles${p.penalty ? ` · −${p.penalty} unfinished` : ''}</span><span class="score">${p.score}</span></div>`).join('')}
    <div class="actions"><button class="primary" data-cmd="join">New game</button></div>
  </div>`;
}

function avatar(p) {
  const on = S.online.includes(p.id);
  return `<span class="avatar" style="background:${avColor(p.id)}" title="${on ? 'online' : 'offline'}">${esc(p.name[0] || '?').toUpperCase()}</span>`;
}

function renderGame() {
  const g = S.game, p = me(), mine = myTurn();
  const cur = g.players[g.turn];
  const pips = Array.from({ length: ACTIONS_PER_TURN }, (_, i) => `<span class="pip ${i < g.actionsLeft ? 'on' : ''}"></span>`).join('');

  const market = ['bronze', 'gold'].map(tier => {
    const prefix = tier === 'gold' ? 'G' : 'B';
    const canTake = mine && p && p.puzzles.length < MAX_HELD_PUZZLES && !S.mode;
    const cards = g.market[tier].map((pid, i) => {
      if (!pid) return '<div class="slot-empty mk-slot">empty</div>';
      const k = `${tier}:${i}`, armed = S.armed === k;
      return card(pid, { label: `${prefix}${i + 1}`, cls: `${canTake ? 'clickable' : ''} ${armed ? 'armed' : ''}`, attrs: `data-market="${k}"`, overlay: armed ? '<div class="take">Click again to take</div>' : '' });
    }).join('');
    const n = g.decks[tier], dk = `${tier}:deck`;
    const deck = n ? `<div class="deck ${tier} ${canTake ? 'clickable' : ''} ${S.armed === dk ? 'armed' : ''}" data-market="${dk}">${S.armed === dk ? 'Click again<br>to blind draw' : `Deck<br>${n}`}</div>` : '<div class="deck empty">Deck<br>empty</div>';
    return `<div class="panel"><h3 class="${tier}">${tier.toUpperCase()} COMMISSIONS ${canTake ? '<span class="hint">· click a card twice to take it</span>' : ''}</h3><div class="row">${cards}${deck}</div></div>`;
  }).join('');

  let workshop = '';
  if (p) {
    const slots = [];
    for (let i = 0; i < MAX_HELD_PUZZLES; i++) {
      const h = p.puzzles[i];
      if (!h) { slots.push('<div class="slot-empty ws-slot">empty slot</div>'); continue; }
      const pending = S.flurry.filter(f => f.puzzleIdx === i);
      const queuedHere = S.mode === 'flurry' && pending.length > 0;
      slots.push(card(h, { label: `#${i + 1}`, attrs: `data-puzzle="${i}"`, cls: queuedHere ? 'queued' : '', pending }));
    }
    workshop = `<div class="panel ws"><h3>YOUR WORKSHOP · ${p.score} PTS</h3><div class="row">${slots.join('')}</div>${trayHtml(p, mine)}</div>`;
  } else {
    workshop = '<div class="panel"><div class="muted">You are spectating this game.</div></div>';
  }

  const banner = mine
    ? `<div class="banner ${g.finalRound ? 'final' : ''}">▶ Your turn: ${g.actionsLeft} action${g.actionsLeft === 1 ? '' : 's'} left${g.finalRound ? ' · FINAL ROUND' : g.endTriggered ? ' · last full round' : ''}</div>` : '';

  const players = g.players.map((pl, idx) => `<div class="player ${idx === g.turn ? 'cur' : ''}">
      <div class="top">${avatar(pl)}<b>${esc(pl.name)}${pl.id === S.you ? ' (you)' : ''}</b><span class="score">${pl.score}</span></div>
      <div class="hint">${pl.completed.length} done · ${PIECE_IDS.reduce((a, id) => a + pl.hand[id], 0)} tiles</div>
      <div class="row mini" style="gap:6px">${pl.puzzles.map((h, i) => card(h, { label: `#${i + 1}` })).join('') || '<span class="hint">no puzzles</span>'}</div>
    </div>`).join('');

  const bank = `<div class="bank">${PIECE_IDS.map(id => `<div class="b">${glyph(id)}<span>${g.supply[id]}</span></div>`).join('')}</div>`;

  $app.innerHTML = `<div class="shell">
    <div class="topbar"><div class="logo">TESSERA WORKS</div><span class="muted">Round ${g.round}${g.finalRound ? ' · FINAL' : ''}</span>
      <div class="status ${mine ? 'mine' : ''}">${mine ? 'Your turn' : `${esc(cur.name)}'s turn`} <span class="pips">${pips}</span></div></div>
    <div class="main">${banner}${workshop}${market}</div>
    <div class="side">
      <div class="panel"><h3>PLAYERS</h3><div style="display:grid;gap:8px">${players}</div></div>
      <div class="panel"><h3>BANK</h3>${bank}</div>
      <div class="panel"><h3>LOG</h3><div class="log">${g.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('')}</div></div>
      ${g.hostId === S.you ? '<button class="danger" data-cmd="abandon">End game now</button>' : ''}
    </div>
  </div>`;
  paintGhost();
}

function trayHtml(p, mine) {
  const slots = PIECE_IDS.map(id => {
    const n = handCount(id);
    const sel = S.sel && S.sel.pieceId === id;
    const refineSel = S.mode === 'refine' && S.refineFrom === id;
    const pickable = mine && n > 0;
    return `<div class="tslot ${n ? '' : 'none'} ${sel || refineSel ? 'sel' : ''} ${pickable ? 'pickable' : ''}" data-tile="${id}">
      ${glyph(id, sel ? S.sel.orient : 0)}<span class="count">×${n}</span><span class="nm">${PIECES[id].name}</span></div>`;
  }).join('');

  let bar = '';
  if (mine) {
    const g = S.game;
    const hasTiles = PIECE_IDS.some(id => handCount(id) > 0);
    if (S.mode === 'refine') {
      bar = `<div class="selbar"><b>🔧 Refine:</b> <span class="hint">${S.refineFrom ? `return a ${PIECES[S.refineFrom].name}, take…` : 'pick a tile above to return'}</span><button data-cmd="cancel">Cancel</button></div>`;
      if (S.refineFrom) {
        bar += `<div class="popover">${refineTargets(S.refineFrom).map(id => `<button class="opt" data-refine="${id}" ${g.supply[id] > 0 ? '' : 'disabled'}>${glyph(id)}<span>${PIECES[id].size > PIECES[S.refineFrom].size ? '⬆ ' : ''}${PIECES[id].name}</span><span class="hint">${g.supply[id]} left</span></button>`).join('')}</div>`;
      }
    } else {
      const flurry = S.mode === 'flurry';
      bar = `<div class="selbar">
        ${S.sel ? `<b>Placing ${PIECES[S.sel.pieceId].name}</b><button data-cmd="rot" title="R">↻ Rotate</button><button data-cmd="flip" title="F">⇋ Mirror</button><button data-cmd="deselect" title="Esc">✕</button><span class="hint">Hover a puzzle; click to place · R / F / right-click to rotate</span>`
          : `<span class="hint">${flurry ? 'Flurry: pick a tile and place it in each puzzle you want (one per puzzle).' : 'Pick a tile to place it, or choose an action:'}</span>`}
      </div>
      <div class="actions" style="margin-top:10px">
        ${flurry
          ? `<button class="go" data-cmd="flurrygo" ${S.flurry.length ? '' : 'disabled'}>⚡ Finish Flurry (${S.flurry.length})</button><button data-cmd="flurryundo" ${S.flurry.length ? '' : 'disabled'}>Undo</button><button data-cmd="cancel">Cancel Flurry</button>`
          : `<button class="primary" data-cmd="draw" ${g.supply.dot > 0 ? '' : 'disabled'}>🟡 Draw a Dot</button>
             <button data-cmd="refine" ${hasTiles ? '' : 'disabled'}>🔧 Refine</button>
             <button data-cmd="flurry" ${hasTiles && p.puzzles.length && !g.flurryUsed ? '' : 'disabled'}>⚡ Flurry${g.flurryUsed ? ' (used)' : ''}</button>
             <button class="danger" data-cmd="endTurn" style="margin-left:auto">End turn</button>`}
      </div>`;
    }
  }
  return `<div style="margin-top:12px"><div class="tray">${slots}</div>${bar}</div>`;
}

// ---------------- ghost preview (cheap DOM update on hover) ----------------
function currentGhost() {
  if (!S.sel || !S.hover || !me()) return null;
  const held = me().puzzles[S.hover.puzzleIdx];
  if (!held) return null;
  const cells = ghostCells(S.sel.pieceId, S.sel.orient, S.hover.x, S.hover.y);
  const blocked = S.mode === 'flurry' && S.flurry.some(f => f.puzzleIdx === S.hover.puzzleIdx);
  const pendingHere = S.flurry.filter(f => f.puzzleIdx === S.hover.puzzleIdx).flatMap(f => f.cells.map(c => c.join(',')));
  const valid = !blocked && fits(held, cells) && !cells.some(c => pendingHere.includes(c.join(',')));
  return { puzzleIdx: S.hover.puzzleIdx, cells, valid };
}

function paintGhost() {
  document.querySelectorAll('.ghost-ok, .ghost-bad').forEach(el => { el.classList.remove('ghost-ok', 'ghost-bad'); el.style.removeProperty('--gcol'); });
  const gh = currentGhost();
  if (!gh) return;
  const cardEl = document.querySelector(`[data-puzzle="${gh.puzzleIdx}"]`);
  if (!cardEl) return;
  for (const [x, y] of gh.cells) {
    const el = cardEl.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
    if (!el) continue;
    el.classList.add(gh.valid ? 'ghost-ok' : 'ghost-bad');
    if (gh.valid) el.style.setProperty('--col', PIECES[S.sel.pieceId].color);
  }
}

function place() {
  const gh = currentGhost();
  if (!gh || !gh.valid) return;
  if (S.mode === 'flurry') {
    S.flurry.push({ puzzleIdx: gh.puzzleIdx, pieceId: S.sel.pieceId, cells: gh.cells });
    if (handCount(S.sel.pieceId) <= 0) S.sel = null;
    S.hover = null;
    render();
  } else {
    act('fit', { puzzleIdx: gh.puzzleIdx, pieceId: S.sel.pieceId, cells: gh.cells });
    S.sel = null; S.hover = null;
  }
}

// ---------------- input ----------------
function cellFromEvent(e) {
  const cell = e.target.closest('.cell');
  const cardEl = e.target.closest('[data-puzzle]');
  if (!cell || !cardEl || cell.dataset.x === undefined) return null;
  return { puzzleIdx: Number(cardEl.dataset.puzzle), x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
}
const sameCell = (a, b) => a && b && a.puzzleIdx === b.puzzleIdx && a.x === b.x && a.y === b.y;

$app.addEventListener('pointermove', e => {
  if (!S.sel || e.pointerType === 'touch') return;
  const c = cellFromEvent(e);
  if (!sameCell(c, S.hover)) { S.hover = c; paintGhost(); }
});

$app.addEventListener('contextmenu', e => {
  if (S.sel && e.target.closest('[data-puzzle]')) { e.preventDefault(); rotate(); }
});

function rotate() { if (S.sel) { S.sel.orient = transform(S.sel.pieceId, S.sel.orient, ([x, y]) => [-y, x]); render(); } }
function flip() { if (S.sel) { S.sel.orient = transform(S.sel.pieceId, S.sel.orient, ([x, y]) => [-x, y]); render(); } }

document.addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') rotate();
  else if (e.key === 'f' || e.key === 'F') flip();
  else if (e.key === 'Escape') { S.sel = null; S.armed = null; if (S.mode === 'refine') S.mode = null; render(); }
});

$app.addEventListener('click', e => {
  const t = e.target;
  const cmd = t.closest('[data-cmd]');
  if (cmd && !cmd.disabled) return command(cmd.dataset.cmd);

  const refine = t.closest('[data-refine]');
  if (refine && !refine.disabled) { act('refine', { from: S.refineFrom, to: refine.dataset.refine }); S.mode = null; S.refineFrom = null; return; }

  if (!myTurn()) return;

  const tile = t.closest('[data-tile]');
  if (tile) {
    const id = tile.dataset.tile;
    if (handCount(id) <= 0) return;
    if (S.mode === 'refine') { S.refineFrom = id; return render(); }
    S.sel = S.sel && S.sel.pieceId === id ? null : { pieceId: id, orient: 0 };
    S.armed = null;
    return render();
  }

  const mk = t.closest('[data-market]');
  if (mk && !S.mode) {
    const p = me();
    if (!p || p.puzzles.length >= MAX_HELD_PUZZLES) return;
    const k = mk.dataset.market;
    if (S.armed === k) {
      const [tier, slot] = k.split(':');
      S.armed = null;
      act('commission', { tier, slot });
    } else { S.armed = k; render(); }
    return;
  }

  if (S.sel) {
    const c = cellFromEvent(e);
    if (!c) return;
    // Touch: first tap previews, second tap on the same cell places.
    if (e.pointerType === 'touch' && !sameCell(c, S.hover)) { S.hover = c; return paintGhost(); }
    S.hover = c;
    place();
  }
});

function command(c) {
  switch (c) {
    case 'join': return send({ t: 'join' });
    case 'leave': return send({ t: 'leave' });
    case 'start': return send({ t: 'start' });
    case 'abandon': if (confirm('End the game now for everyone?')) send({ t: 'abandon' }); return;
    case 'draw': return act('draw');
    case 'endTurn': if (S.game.actionsLeft < ACTIONS_PER_TURN || confirm('End your turn without using any actions?')) act('endTurn'); return;
    case 'refine': S.mode = 'refine'; S.sel = null; S.refineFrom = null; return render();
    case 'flurry': S.mode = 'flurry'; S.flurry = []; S.sel = null; return render();
    case 'flurrygo': act('flurry', { placements: S.flurry }); S.flurry = []; S.mode = null; S.sel = null; return;
    case 'flurryundo': S.flurry.pop(); return render();
    case 'cancel': S.mode = null; S.flurry = []; S.refineFrom = null; S.sel = null; return render();
    case 'rot': return rotate();
    case 'flip': return flip();
    case 'deselect': S.sel = null; return render();
    default:
  }
}

connect();
