'use strict';
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { Game, GameError, listPlacements, filledSet, MAX_HELD_PUZZLES } = require('./engine/game');
const { PIECES, PIECE_IDS, orientations, normalize } = require('./engine/pieces');
const { PUZZLES } = require('./engine/puzzles');
const R = require('./render');
const { RULES } = require('./rules');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // optional: instant command registration in one server
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '../data/games.json');
const COLOR = 0x7aa2ff;

// ---------------- persistence ----------------
const games = new Map(); // channelId -> Game
const ui = new Map(); // `${channelId}:${userId}` -> panel state

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [cid, obj] of Object.entries(raw)) games.set(cid, Game.fromJSON(obj));
    console.log(`Loaded ${games.size} game(s).`);
  } catch { /* no saved games yet */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(games), null, 1));
  }, 300);
}

// ---------------- helpers ----------------
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false, emoji) => {
  const b = new ButtonBuilder().setCustomId(`tw:${id}`).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label);
  if (emoji) b.setEmoji(emoji);
  return b;
};
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const png = (buf, name) => new AttachmentBuilder(buf, { name });
const pieceLabel = id => `${PIECES[id].name} (size ${PIECES[id].size})`;
const uiKey = (cid, uid) => `${cid}:${uid}`;
function getUi(cid, uid) {
  const k = uiKey(cid, uid);
  if (!ui.has(k)) ui.set(k, { mode: 'main' });
  return ui.get(k);
}
const resetUi = (cid, uid) => ui.set(uiKey(cid, uid), { mode: 'main' });

// Hand and puzzles as they look with pending Flurry placements applied.
function virtualPlayer(p, pending = []) {
  const hand = { ...p.hand };
  const puzzles = p.puzzles.map(h => ({ puzzleId: h.puzzleId, placed: [...h.placed] }));
  for (const pl of pending) {
    hand[pl.pieceId]--;
    puzzles[pl.puzzleIdx].placed.push({ piece: pl.pieceId, cells: pl.cells });
  }
  return { ...p, hand, puzzles };
}

function transformOrient(pieceId, orient, fn) {
  const cells = normalize(orientations(pieceId)[orient].map(fn));
  const key = c => c.map(x => x.join(',')).join(';');
  const idx = orientations(pieceId).findIndex(o => key(o) === key(cells));
  return idx < 0 ? orient : idx;
}

function clampCursor(pl) {
  const pz = PUZZLES[pl.puzzleId];
  const shape = orientations(pl.pieceId)[pl.orient];
  const sw = Math.max(...shape.map(c => c[0])) + 1, sh = Math.max(...shape.map(c => c[1])) + 1;
  pl.x = Math.max(0, Math.min(pl.x, Math.max(0, pz.width - sw)));
  pl.y = Math.max(0, Math.min(pl.y, Math.max(0, pz.height - sh)));
}

// ---------------- table (public) ----------------
function tablePayload(game) {
  const file = png(R.renderTable(game), 'table.png');
  const embed = new EmbedBuilder().setColor(COLOR).setImage('attachment://table.png');
  if (game.phase === 'ended') {
    embed.setTitle('🏆 Tessera Works: final results').setDescription(
      game.standings.map((p, i) => `${['🥇', '🥈', '🥉', '4.'][i]} **${p.name}**: ${p.score} pts (${p.completed.length} puzzles${p.penalty ? `, −${p.penalty} unfinished` : ''})`).join('\n'),
    );
    return { content: '', embeds: [embed], files: [file], attachments: [], components: [] };
  }
  embed.setTitle(`Tessera Works · Round ${game.round}${game.finalRound ? ' · FINAL ROUND' : ''}`)
    .setDescription(`**Now playing:** <@${game.current.id}> (${game.actionsLeft} action${game.actionsLeft === 1 ? '' : 's'} left)\n\n${game.log.slice(-6).map(l => `• ${l}`).join('\n')}`);
  return {
    embeds: [embed], files: [file], attachments: [],
    components: [row(
      btn('panel', 'Open my panel', ButtonStyle.Primary, false, '🎮'),
      btn('rules', 'Rules', ButtonStyle.Secondary, false, '📖'),
      btn('refreshtable', null, ButtonStyle.Secondary, false, '🔄'),
    )],
  };
}

async function updateTable(channel, game, { repost = false, ping } = {}) {
  const payload = tablePayload(game);
  let old = null;
  if (game.tableMsgId) old = await channel.messages.fetch(game.tableMsgId).catch(() => null);
  if (old && !repost) { await old.edit(payload); return; }
  const msg = await channel.send({ ...payload, content: ping ? `<@${ping}>, it's your turn!` : '' });
  game.tableMsgId = msg.id;
  if (old) await old.delete().catch(() => {});
  save();
}

// ---------------- lobby ----------------
function lobbyPayload(game) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('🧩 Tessera Works: new game')
    .setDescription(`A polyomino puzzle-building game for 1–4 players.\n\n**Players (${game.players.length}/4):**\n${game.players.map(p => `• <@${p.id}>${p.id === game.hostId ? ' (host)' : ''}`).join('\n')}\n\nThe host presses **Start** when everyone has joined.`)
    .setImage('attachment://tiles.png');
  return {
    embeds: [embed], files: [png(R.renderReference(), 'tiles.png')], attachments: [],
    components: [row(
      btn('join', 'Join', ButtonStyle.Success), btn('leave', 'Leave'),
      btn('start', 'Start', ButtonStyle.Primary), btn('cancel', 'Cancel', ButtonStyle.Danger),
    )],
  };
}

// ---------------- private panel ----------------
function panelPayload(game, uid) {
  const p = game.player(uid);
  if (!p) return { content: "You're not playing in this game.", embeds: [], files: [], attachments: [], components: [] };
  if (game.phase === 'ended') return { content: 'The game is over. See the final table.', embeds: [], files: [], attachments: [], components: [] };

  const st = getUi(game.channelId, uid);
  const myTurn = game.current.id === uid;
  if (!myTurn) resetUi(game.channelId, uid);
  const mode = myTurn ? st.mode : 'wait';
  const embed = new EmbedBuilder().setColor(COLOR);
  const files = [];
  let components = [];
  let ghost = null;
  let view = p;

  const header = `Round ${game.round}${game.finalRound ? ' (FINAL)' : ''} · **${game.actionsLeft}** action${game.actionsLeft === 1 ? '' : 's'} left`;

  if (mode === 'wait') {
    embed.setTitle('⏳ Waiting').setDescription(`It's **${game.current.name}**'s turn. You'll be pinged when it's yours.`);
    components = [row(btn('refresh', 'Refresh', ButtonStyle.Secondary, false, '🔄'))];
  } else if (mode === 'main') {
    const hasTiles = PIECE_IDS.some(id => p.hand[id] > 0);
    embed.setTitle('🎮 Your turn').setDescription(`${header}\n\n🟡 **Draw**: take a Dot\n🔧 **Refine**: upgrade or swap a tile\n📜 **Commission**: take a puzzle (${p.puzzles.length}/${MAX_HELD_PUZZLES})\n🧩 **Fit**: place one tile\n⚡ **Flurry**: one tile into each puzzle${game.flurryUsed ? ' *(used)*' : ''}`);
    components = [
      row(
        btn('draw', 'Draw', ButtonStyle.Primary, game.supply.dot <= 0, '🟡'),
        btn('mode:refine', 'Refine', ButtonStyle.Primary, !hasTiles, '🔧'),
        btn('mode:commission', 'Commission', ButtonStyle.Primary, p.puzzles.length >= MAX_HELD_PUZZLES, '📜'),
        btn('mode:fit', 'Fit', ButtonStyle.Success, !hasTiles || !p.puzzles.length, '🧩'),
        btn('mode:flurry', 'Flurry', ButtonStyle.Success, !hasTiles || !p.puzzles.length || game.flurryUsed, '⚡'),
      ),
      row(btn('endturn', 'End turn early', ButtonStyle.Danger), btn('refresh', null, ButtonStyle.Secondary, false, '🔄')),
    ];
  } else if (mode === 'refine') {
    embed.setTitle('🔧 Refine').setDescription(`${header}\n\nPick a tile to return, then pick what to take. You can go up **exactly one size**, or take any tile of the same or a smaller size.`);
    const from = new StringSelectMenuBuilder().setCustomId('tw:refinefrom').setPlaceholder('Tile to return…')
      .addOptions(PIECE_IDS.filter(id => p.hand[id] > 0).map(id => ({ label: `${pieceLabel(id)} ×${p.hand[id]}`, value: id, default: st.from === id })));
    components = [row(from)];
    if (st.from) {
      const targets = game.refineTargets(st.from).filter(id => game.supply[id] > 0);
      if (targets.length) {
        components.push(row(new StringSelectMenuBuilder().setCustomId('tw:refineto').setPlaceholder('Take from the bank…')
          .addOptions(targets.map(id => ({
            label: `${PIECES[id].size > PIECES[st.from].size ? '⬆️ ' : ''}${pieceLabel(id)}`,
            description: `${game.supply[id]} left in bank`, value: id,
          })))));
      } else embed.addFields({ name: 'No options', value: 'The bank has nothing to swap for that tile.' });
    }
    components.push(row(btn('mode:main', 'Back', ButtonStyle.Secondary, false, '↩️')));
  } else if (mode === 'commission') {
    embed.setTitle('📜 Commission').setDescription(`${header}\n\nChoose a face-up puzzle or a blind draw. The circled number is its points; the tile in the corner is its reward.`)
      .setImage('attachment://market.png');
    files.push(png(R.renderMarket(game), 'market.png'));
    const opts = [];
    for (const tier of ['bronze', 'gold']) {
      game.market[tier].forEach((pid, i) => {
        if (!pid) return;
        const pz = PUZZLES[pid];
        opts.push({ label: `${tier === 'gold' ? 'G' : 'B'}${i + 1} · ${pid}`, description: `${pz.points} pts · ${pz.cells.length} squares · reward ${PIECES[pz.reward].name}`, value: `${tier}:${i}`, emoji: tier === 'gold' ? '🟨' : '🟫' });
      });
      if (game.decks[tier].length) opts.push({ label: `Blind draw: ${tier} deck`, description: `${game.decks[tier].length} cards left`, value: `${tier}:deck`, emoji: '🎴' });
    }
    components = [row(new StringSelectMenuBuilder().setCustomId('tw:commission').setPlaceholder('Take a puzzle…').addOptions(opts)),
      row(btn('mode:main', 'Back', ButtonStyle.Secondary, false, '↩️'))];
  } else if (mode === 'fit' || mode === 'flurry') {
    const pending = st.pending || [];
    view = virtualPlayer(p, pending);
    const used = new Set(pending.map(x => x.puzzleIdx));
    const title = mode === 'fit' ? '🧩 Fit a tile' : `⚡ Flurry (${pending.length} queued)`;
    embed.setTitle(title).setDescription(`${header}\n\n${mode === 'fit' ? 'Choose a puzzle and a tile.' : 'Queue one tile for each puzzle you like, then press **Finish Flurry**. Everything resolves as a single action.'}`);
    const puzzleOpts = view.puzzles.map((h, i) => ({ h, i })).filter(({ i }) => !used.has(i)).map(({ h, i }) => ({
      label: `#${i + 1} · ${h.puzzleId}`, description: `${filledSet(h).size}/${PUZZLES[h.puzzleId].cells.length} filled`, value: String(i), default: st.puzzleIdx === i,
    }));
    const pieceOpts = PIECE_IDS.filter(id => view.hand[id] > 0).map(id => ({ label: `${pieceLabel(id)} ×${view.hand[id]}`, value: id, default: st.pieceId === id }));
    if (puzzleOpts.length && pieceOpts.length) {
      components.push(row(new StringSelectMenuBuilder().setCustomId('tw:pickpuzzle').setPlaceholder('Puzzle…').addOptions(puzzleOpts)));
      components.push(row(new StringSelectMenuBuilder().setCustomId('tw:pickpiece').setPlaceholder('Tile…').addOptions(pieceOpts)));
    } else embed.addFields({ name: '​', value: 'Nothing else can be queued.' });
    const nav = [btn('mode:main', mode === 'flurry' ? 'Cancel Flurry' : 'Back', ButtonStyle.Secondary, false, '↩️')];
    if (mode === 'flurry') {
      nav.unshift(btn('flurryundo', 'Undo last', ButtonStyle.Secondary, !pending.length, '⏪'));
      nav.unshift(btn('flurrygo', `Finish Flurry (${pending.length})`, ButtonStyle.Success, !pending.length, '⚡'));
    }
    components.push(row(...nav));
    if (st.puzzleIdx != null && st.puzzleIdx >= view.puzzles.length) st.puzzleIdx = null;
  } else if (mode === 'place') {
    const pending = st.pending || [];
    view = virtualPlayer(p, pending);
    const pl = st.place;
    const held = view.puzzles[pl.puzzleIdx];
    ghost = { puzzleIdx: pl.puzzleIdx, focus: pl.puzzleIdx, ...R.ghostFor(held, pl.pieceId, pl.orient, pl.x, pl.y) };
    const anyFit = listPlacements(held.puzzleId, filledSet(held), pl.pieceId).length > 0;
    embed.setTitle(`Placing ${PIECES[pl.pieceId].name} → #${pl.puzzleIdx + 1} ${held.puzzleId}`)
      .setDescription(`${header}\n\n${ghost.valid ? '🟩 **Fits here.** Press ✅ to confirm.' : anyFit ? '🟥 Does not fit here. Move it, rotate it, or press ⏭ to jump to a spot that fits.' : '⛔ This tile fits nowhere in this puzzle. Go back and pick another.'}`);
    components = [
      row(btn('mv:up', null, ButtonStyle.Secondary, false, '⬆️'), btn('mv:left', null, ButtonStyle.Secondary, false, '⬅️'),
        btn('mv:right', null, ButtonStyle.Secondary, false, '➡️'), btn('mv:down', null, ButtonStyle.Secondary, false, '⬇️')),
      row(btn('mv:rot', '↻ Rotate'), btn('mv:flip', '⇋ Mirror'),
        btn('mv:next', 'Next fit', ButtonStyle.Secondary, !anyFit, '⏭️')),
      row(btn('confirmplace', st.place.kind === 'flurry' ? 'Queue' : 'Place', ButtonStyle.Success, !ghost.valid, '✅'),
        btn(`mode:${st.place.kind}`, 'Back', ButtonStyle.Secondary, false, '↩️')),
    ];
  }

  if (!embed.data.image) {
    embed.setImage('attachment://workshop.png');
    files.push(png(R.renderWorkshop(game, view, ghost), 'workshop.png'));
  }
  return { content: '', embeds: [embed], files, attachments: [], components };
}

function startPlacement(game, uid, st) {
  const p = game.player(uid);
  const view = virtualPlayer(p, st.pending || []);
  const held = view.puzzles[st.puzzleIdx];
  const fits = listPlacements(held.puzzleId, filledSet(held), st.pieceId);
  const first = fits[0] || { orient: 0, x: 0, y: 0 };
  st.place = { kind: st.mode, puzzleIdx: st.puzzleIdx, pieceId: st.pieceId, puzzleId: held.puzzleId, orient: first.orient, x: first.x, y: first.y };
  clampCursor(st.place);
  st.mode = 'place';
}

// ---------------- interaction handling ----------------
async function afterAction(interaction, game, before) {
  save();
  const turnChanged = before !== `${game.round}:${game.turn}` || game.phase === 'ended';
  await interaction.update(panelPayload(game, interaction.user.id));
  await updateTable(interaction.channel, game, {
    repost: turnChanged, ping: turnChanged && game.phase === 'playing' ? game.current.id : null,
  });
  if (game.phase === 'ended') { games.delete(game.channelId); save(); }
}

async function onButtonOrSelect(interaction) {
  const [, cmd, arg] = interaction.customId.split(':');
  const cid = interaction.channelId, uid = interaction.user.id;
  const game = games.get(cid);
  if (!game) return interaction.reply({ content: 'There is no active game in this channel. Start one with `/tessera new`.', flags: MessageFlags.Ephemeral });

  // lobby
  if (['join', 'leave', 'start', 'cancel'].includes(cmd)) {
    if (cmd === 'join') game.addPlayer(uid, interaction.member?.displayName || interaction.user.username);
    if (cmd === 'leave') {
      if (uid === game.hostId) throw new GameError('The host cannot leave; press Cancel instead.');
      game.removePlayer(uid);
    }
    if ((cmd === 'start' || cmd === 'cancel') && uid !== game.hostId) throw new GameError('Only the host can do that.');
    if (cmd === 'cancel') {
      games.delete(cid); save();
      return interaction.update({ content: 'Game cancelled.', embeds: [], files: [], attachments: [], components: [] });
    }
    if (cmd === 'start') {
      game.start();
      game.tableMsgId = null;
      await interaction.update({ content: `Game started with ${game.players.map(p => `<@${p.id}>`).join(', ')}!`, embeds: [], files: [], attachments: [], components: [] });
      await updateTable(interaction.channel, game, { repost: true, ping: game.current.id });
      return save();
    }
    save();
    return interaction.update(lobbyPayload(game));
  }

  if (cmd === 'rules') return interaction.reply({ ...rulesPayload(), flags: MessageFlags.Ephemeral });
  if (cmd === 'refreshtable') { await interaction.deferUpdate(); return updateTable(interaction.channel, game); }
  if (game.phase !== 'playing') throw new GameError('The game has not started yet.');
  if (cmd === 'panel') {
    if (!game.player(uid)) throw new GameError("You're not playing in this game.");
    return interaction.reply({ ...panelPayload(game, uid), flags: MessageFlags.Ephemeral });
  }

  const st = getUi(cid, uid);
  const before = `${game.round}:${game.turn}`;
  const isTurn = game.current.id === uid;
  if (cmd === 'refresh' || !isTurn) return interaction.update(panelPayload(game, uid));

  switch (cmd) {
    case 'mode':
      // Going "back" from placement into an in-progress Flurry keeps the queued tiles.
      ui.set(uiKey(cid, uid), { mode: arg, pending: arg === 'flurry' ? (st.pending || []) : [] });
      break;
    case 'draw':
      game.draw(uid); resetUi(cid, uid); return afterAction(interaction, game, before);
    case 'endturn':
      game.endTurn(uid); resetUi(cid, uid); return afterAction(interaction, game, before);
    case 'refinefrom':
      st.from = interaction.values[0]; break;
    case 'refineto':
      game.refine(uid, st.from, interaction.values[0]); resetUi(cid, uid); return afterAction(interaction, game, before);
    case 'commission': {
      const [tier, slot] = interaction.values[0].split(':');
      game.commission(uid, tier, slot === 'deck' ? 'deck' : Number(slot)); resetUi(cid, uid);
      return afterAction(interaction, game, before);
    }
    case 'pickpuzzle':
      st.puzzleIdx = Number(interaction.values[0]); break;
    case 'pickpiece':
      st.pieceId = interaction.values[0]; break;
    case 'mv': {
      const pl = st.place;
      if (!pl) break;
      if (arg === 'up') pl.y--; if (arg === 'down') pl.y++; if (arg === 'left') pl.x--; if (arg === 'right') pl.x++;
      if (arg === 'rot') pl.orient = transformOrient(pl.pieceId, pl.orient, ([x, y]) => [-y, x]);
      if (arg === 'flip') pl.orient = transformOrient(pl.pieceId, pl.orient, ([x, y]) => [-x, y]);
      if (arg === 'next') {
        const held = virtualPlayer(game.player(uid), st.pending).puzzles[pl.puzzleIdx];
        const fits = listPlacements(held.puzzleId, filledSet(held), pl.pieceId);
        const cur = fits.findIndex(f => f.orient === pl.orient && f.x === pl.x && f.y === pl.y);
        const nx = fits[(cur + 1) % fits.length];
        if (nx) Object.assign(pl, { orient: nx.orient, x: nx.x, y: nx.y });
      }
      clampCursor(pl);
      break;
    }
    case 'confirmplace': {
      const pl = st.place;
      const held = virtualPlayer(game.player(uid), st.pending).puzzles[pl.puzzleIdx];
      const ghost = R.ghostFor(held, pl.pieceId, pl.orient, pl.x, pl.y);
      if (!ghost.valid) throw new GameError("That tile doesn't fit there.");
      if (pl.kind === 'fit') {
        const done = game.fit(uid, pl.puzzleIdx, pl.pieceId, ghost.cells);
        resetUi(cid, uid);
        if (done.length) interaction.followUp({ content: `🎉 Completed ${done.join(', ')}!`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return afterAction(interaction, game, before);
      }
      st.pending = [...(st.pending || []), { puzzleIdx: pl.puzzleIdx, pieceId: pl.pieceId, cells: ghost.cells }];
      ui.set(uiKey(cid, uid), { mode: 'flurry', pending: st.pending });
      break;
    }
    case 'flurryundo':
      st.pending = (st.pending || []).slice(0, -1); st.puzzleIdx = null; st.pieceId = null; break;
    case 'flurrygo':
      game.flurry(uid, st.pending || []); resetUi(cid, uid); return afterAction(interaction, game, before);
    default:
      break;
  }

  // Auto-advance into placement mode once both a puzzle and tile are chosen.
  const st2 = getUi(cid, uid);
  if ((st2.mode === 'fit' || st2.mode === 'flurry')) {
    const view = virtualPlayer(game.player(uid), st2.pending || []);
    const usable = view.puzzles.map((_, i) => i).filter(i => !(st2.pending || []).some(x => x.puzzleIdx === i));
    if (st2.puzzleIdx == null && usable.length === 1) st2.puzzleIdx = usable[0];
    if (st2.puzzleIdx != null && st2.pieceId && view.hand[st2.pieceId] > 0) startPlacement(game, uid, st2);
  }
  return interaction.update(panelPayload(game, uid));
}

function rulesPayload() {
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📖 Tessera Works: rules').addFields(RULES).setImage('attachment://tiles.png')],
    files: [png(R.renderReference(), 'tiles.png')],
  };
}

async function onCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const cid = interaction.channelId, uid = interaction.user.id;
  let game = games.get(cid);
  if (sub === 'rules') return interaction.reply({ ...rulesPayload(), flags: MessageFlags.Ephemeral });
  if (sub === 'new') {
    if (game) throw new GameError('There is already a game in this channel. Finish it or use `/tessera end`.');
    game = new Game({ channelId: cid, hostId: uid, hostName: interaction.member?.displayName || interaction.user.username });
    games.set(cid, game); save();
    return interaction.reply(lobbyPayload(game));
  }
  if (!game) throw new GameError('There is no game in this channel. Start one with `/tessera new`.');
  if (sub === 'board') {
    if (game.phase !== 'playing') throw new GameError('The game has not started yet.');
    await interaction.reply({ content: 'Table moved to the bottom of the channel.', flags: MessageFlags.Ephemeral });
    return updateTable(interaction.channel, game, { repost: true });
  }
  if (sub === 'play') {
    if (game.phase !== 'playing') throw new GameError('The game has not started yet.');
    if (!game.player(uid)) throw new GameError("You're not playing in this game.");
    return interaction.reply({ ...panelPayload(game, uid), flags: MessageFlags.Ephemeral });
  }
  if (sub === 'end') {
    const mod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
    if (uid !== game.hostId && !mod) throw new GameError('Only the host or a moderator can end the game.');
    if (game.phase === 'playing') {
      game.forceEnd();
      await interaction.reply({ content: 'Game ended early. Final scores:' });
      await updateTable(interaction.channel, game, { repost: true });
    } else await interaction.reply({ content: 'Lobby closed.' });
    games.delete(cid); save();
  }
}

// ---------------- boot ----------------
const command = new SlashCommandBuilder().setName('tessera').setDescription('Tessera Works: a polyomino puzzle-building game')
  .addSubcommand(s => s.setName('new').setDescription('Open a lobby for a new game in this channel'))
  .addSubcommand(s => s.setName('play').setDescription('Open your private control panel'))
  .addSubcommand(s => s.setName('board').setDescription('Re-post the game table at the bottom of the channel'))
  .addSubcommand(s => s.setName('rules').setDescription('Show the rules'))
  .addSubcommand(s => s.setName('end').setDescription('End the current game (host or moderators)'));

async function main() {
  if (!TOKEN) { console.error('Set DISCORD_TOKEN (see README).'); process.exit(1); }
  if (process.env.DISCORD_CLIENT_SECRET) await require('./server').startServer(); // Activity backend
  else console.log('DISCORD_CLIENT_SECRET not set: Activity server disabled (chat bot only).');
  load();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, async c => {
    const rest = new REST().setToken(TOKEN);
    const route = GUILD_ID ? Routes.applicationGuildCommands(c.user.id, GUILD_ID) : Routes.applicationCommands(c.user.id);
    await rest.put(route, { body: [command.toJSON()] });
    console.log(`Logged in as ${c.user.tag}; /tessera registered ${GUILD_ID ? `in guild ${GUILD_ID}` : 'globally'}.`);
  });
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'tessera') await onCommand(interaction);
      else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('tw:')) await onButtonOrSelect(interaction);
    } catch (err) {
      const msg = err instanceof GameError ? `⚠️ ${err.message}` : '💥 Something went wrong.';
      if (!(err instanceof GameError)) console.error(err);
      const send = interaction.replied || interaction.deferred ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
      await send({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  await client.login(TOKEN);
}

if (require.main === module) main().catch(err => { console.error('Failed to start:', err.message); process.exit(1); });
module.exports = { panelPayload, tablePayload, lobbyPayload, onButtonOrSelect, onCommand, games, ui, getUi };
