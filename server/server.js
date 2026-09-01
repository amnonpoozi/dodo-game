'use strict';

/* ============================================================
   DODO — real-time multiplayer server.

   Express serves the frontend from /public; Socket.IO carries the
   game. The SERVER IS AUTHORITATIVE:
     - it rolls and stores every die
     - it validates every bid / Dodo / Believe / Check
     - it decides who loses or gains a die and whose turn it is
     - it runs Blind Rounds and keeps the secret target
   A client only ever receives its OWN dice (and nobody's dice at
   all during a Blind Round, until the round is revealed).
   ============================================================ */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const engine = require('./engine');
const rooms = require('./rooms');
const bot = require('./bot');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const AWAY_MS = 45 * 1000;          // auto-move a disconnected player after this long
const MAX_PLAYERS = rooms.MAX_PLAYERS;   // total seats per table (humans + bots)
const MIN_PLAYERS = rooms.MIN_PLAYERS;

// How long a bot "thinks" before its move (ms) — enough for cup/dice animations to
// read. Overridable with DODO_BOT_THINK_MS (used by the test suite to run fast).
const BOT_THINK_OVERRIDE = Number(process.env.DODO_BOT_THINK_MS);
const BOT_THINK_MIN = Number.isFinite(BOT_THINK_OVERRIDE) ? BOT_THINK_OVERRIDE : 700;
const BOT_THINK_MAX = Number.isFinite(BOT_THINK_OVERRIDE) ? BOT_THINK_OVERRIDE : 1400;
const BOT_NAMES = [
  'Bones', 'Salty Pete', 'One-Eye Jack', 'Blackbeard', 'Calico Sue',
  'Barnacle Bill', 'Cutlass Kate', 'Old Griggs', 'Redbeard', 'Mad Morgan',
];

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.count() }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const server = http.createServer(app);
const io = new Server(server);


/* ---------------- helpers ---------------- */

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}
function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
         crypto.randomBytes(16).toString('hex');
}
function toInt(x) {
  const n = Math.trunc(Number(x));
  return Number.isFinite(n) ? n : NaN;
}
function seatToId(room, seat) {
  if (seat == null || seat < 0) return null;
  const p = room.players[seat];
  return p ? p.id : null;
}


/* ---------------- per-player redacted view ---------------- *
 * This is the ONLY place game state crosses the wire. It must never
 * include another player's dice, and never the Blind Round target.  */

function buildView(room, pid) {
  const me = room.players.find(p => p.id === pid);
  const v = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youId: pid,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      seat: p.seat,
      diceCount: p.diceCount,
      eliminated: p.eliminated,
      isHost: p.id === room.hostId,
    })),
  };

  if (room.phase === 'lobby' || !room.game) return v;

  const g = room.game;
  v.roundNo = g.roundNo;
  v.roundType = g.roundType;
  v.currentBid = g.currentBid;
  v.turnPlayerId = seatToId(room, g.turnIndex);
  v.prevBidderId = seatToId(room, g.prevBidderIndex);
  v.lastActionWasCheck = g.lastActionWasCheck;
  v.checkerId = seatToId(room, g.checkerIndex);
  v.history = g.history.slice(-80);

  // --- your own dice only ---
  // Normal round while playing: your hand. Blind round: nobody's hand until
  // the reveal. Reveal / gameover / eliminated: not here (reveal payload has it).
  if (room.phase === 'playing' && g.roundType === 'normal' && me && !me.eliminated) {
    v.yourDice = me.dice.slice();
  } else {
    v.yourDice = null;
  }

  // --- which buttons the current player may use (computed here, not trusted from client) ---
  if (room.phase === 'playing' && me && g.turnIndex === me.seat && !me.eliminated) {
    v.legalActions = {
      canBid: true,
      canDodo: !!g.currentBid,
      canBelieve: !!g.currentBid,
      canCheck: engine.canDeclareCheck(g, me),
    };
  } else {
    v.legalActions = null;
  }

  // --- reveal: the round is over, so every hand + the target may be shown ---
  if (room.phase === 'reveal' && g.reveal) {
    const r = g.reveal;
    v.reveal = {
      kind: r.kind,
      blind: r.blind,
      face: r.blind ? r.face : (r.bid ? r.bid.face : r.face),
      wild: r.wild,
      bid: r.bid ? { quantity: r.bid.quantity, face: r.bid.face } : null,
      actual: r.actual,
      bidWasTrue: r.bidWasTrue,
      success: r.success,
      checkPattern: r.checkPattern,
      checkValid: r.checkValid,
      checkerId: r.checkerSeat != null ? seatToId(room, r.checkerSeat) : null,
      loserId: r.loserSeat != null ? seatToId(room, r.loserSeat) : null,
      gainerId: r.gainerSeat != null ? seatToId(room, r.gainerSeat) : null,
      nextStarterId: seatToId(room, g.nextStarterIndex),
      pendingBlind: g.pendingBlind,
      hands: room.players
        .filter(p => Array.isArray(p.dice) && p.dice.length)
        .map(p => ({ id: p.id, name: p.name, seat: p.seat, dice: p.dice.slice(), eliminated: p.eliminated })),
    };
  }

  if (room.phase === 'gameover') {
    const alive = room.players.filter(p => !p.eliminated);
    v.winnerId = alive.length ? alive[0].id : null;
  }

  return v;
}

function broadcastState(room) {
  if (!room) return;
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state', buildView(room, p.id));
    }
  }
  armAutoPlay(room);
  scheduleBotMove(room);
}


/* ---------------- game setup shared by both modes ---------------- */

function beginGame(room) {
  room.players.forEach((p, i) => {
    p.seat = i;
    p.diceCount = engine.START_DICE;
    p.dice = [];
    p.eliminated = false;
  });
  room.game = {
    players: room.players,
    turnIndex: 0,
    roundType: 'normal',
    blindTarget: null,
    currentBid: null,
    prevBidderIndex: null,
    lastActionWasCheck: false,
    checkerIndex: null,
    history: ['Game start — ' + room.players.length + ' players, 5 dice each'],
    pendingBlind: false,
    nextStarterIndex: 0,
    roundNo: 0,
    reveal: null,
  };
  engine.startRound(room.game);
  room.phase = 'playing';
}


/* ---------------- "Play vs Bots" — server drives the bot seats ---------------- *
 * A solo room has exactly one human (the host) and 1..5 bots. When it is a
 * bot's turn the server picks a move via bot.chooseAction after a short delay
 * so the cup / dice animations read, validates it with the SAME engine calls a
 * human action goes through, then broadcasts. Bots never keep a room alive and
 * never receive state (no socket).                                              */

function scheduleBotMove(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  if (!room || !room.solo || room.phase !== 'playing' || !room.game) return;

  const g = room.game;
  const cur = g.players[g.turnIndex];
  if (!cur || !cur.isBot || cur.eliminated) return;

  const delay = BOT_THINK_MIN + Math.random() * (BOT_THINK_MAX - BOT_THINK_MIN);
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.solo || room.phase !== 'playing' || !room.game) return;
    const gg = room.game;
    const p = gg.players[gg.turnIndex];
    if (!p || !p.isBot || p.eliminated) return;

    try {
      applyBotAction(room, p.seat, bot.chooseAction(gg, p.seat));
    } catch (err) {
      botFallbackMove(room, p.seat);
    }
    broadcastState(room);
  }, delay);
}

function applyBotAction(room, seat, action) {
  const g = room.game;
  const type = action && action.type;

  if (type === 'check' && engine.canDeclareCheck(g, g.players[seat])) {
    engine.applyCheck(g, seat);
    return;
  }

  if (type === 'dodo' && g.currentBid) {
    if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, seat);
    else engine.resolveDodo(g, seat);
    room.phase = 'reveal';
    return;
  }

  if (type === 'believe' && g.currentBid) {
    engine.resolveBelieve(g, seat);
    room.phase = 'reveal';
    return;
  }

  // default: treat as a bid
  const blind = g.roundType === 'blind';
  const bid = blind
    ? { quantity: toInt(action && action.quantity), face: null }
    : { quantity: toInt(action && action.quantity), face: toInt(action && action.face) };
  const test = engine.isValidBid(g.currentBid, blind ? { quantity: bid.quantity } : bid, g.roundType);
  if (!test.valid) { botFallbackMove(room, seat); return; }
  engine.applyBid(g, seat, bid);
}

// Guaranteed-legal move, identical to the "away player" safety net.
function botFallbackMove(room, seat) {
  const g = room.game;
  if (!g.currentBid) {
    const bid = g.roundType === 'blind' ? { quantity: 1, face: null } : { quantity: 1, face: 2 };
    engine.applyBid(g, seat, bid);
  } else {
    if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, seat);
    else engine.resolveDodo(g, seat);
    room.phase = 'reveal';
  }
}

function makeBots(room, count) {
  const pool = BOT_NAMES.slice();
  for (let i = 0; i < count; i++) {
    let name = 'Bot ' + (i + 1);
    if (pool.length) name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const b = rooms.makePlayer(newId(), name, null, true);
    b.seat = room.players.length;
    room.players.push(b);
  }
}


/* ---------------- "player is away" safety net ---------------- *
 * If it is a disconnected player's turn, the game would stall. After
 * AWAY_MS the server plays a safe move for them so others can continue. */

function armAutoPlay(room) {
  if (room.autoTimer) { clearTimeout(room.autoTimer); room.autoTimer = null; }
  if (room.phase !== 'playing' || !room.game) return;

  const cur = room.game.players[room.game.turnIndex];
  if (!cur || cur.connected || cur.eliminated) return;

  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (room.phase !== 'playing' || !room.game) return;
    const g = room.game;
    const p = g.players[g.turnIndex];
    if (!p || p.connected || p.eliminated) { armAutoPlay(room); return; }

    if (!g.currentBid) {
      const bid = g.roundType === 'blind' ? { quantity: 1, face: null } : { quantity: 1, face: 2 };
      g.history.push(p.name + ' was away — auto opening bid');
      engine.applyBid(g, p.seat, bid);
    } else {
      g.history.push(p.name + ' was away — auto Dodo');
      if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, p.seat);
      else engine.resolveDodo(g, p.seat);
      room.phase = 'reveal';
    }
    broadcastState(room);
  }, AWAY_MS);
}


/* ---------------- lifecycle: disconnect / leave ---------------- */

function detach(room, pid) {
  const p = room.players.find(x => x.id === pid);
  if (!p) return;
  p.connected = false;
  p.socketId = null;

  if (room.phase === 'lobby') {
    // not started yet: free the seat entirely
    room.players = room.players.filter(x => x.id !== pid);
    room.players.forEach((pp, i) => { pp.seat = i; });
    if (room.game) room.game.players = room.players;
    if (room.players.length === 0) { rooms.markEmpty(room); return; }
    if (room.hostId === pid) room.hostId = room.players[0].id;
  } else {
    // mid-game: keep the seat + dice so they can reconnect
    if (room.hostId === pid) {
      const nextConn = room.players.find(x => x.connected && !x.isBot);
      if (nextConn) room.hostId = nextConn.id;
    }
    if (!rooms.anyHumanConnected(room)) rooms.markEmpty(room);
  }
  broadcastState(room);
}


/* ---------------- socket handlers ---------------- */

io.on('connection', (socket) => {

  const roomOf = () => rooms.get(socket.data.roomCode);
  const meIn = (room) => room && room.players.find(p => p.id === socket.data.playerId);

  // The player whose turn it is, IF this socket owns them.
  function actorOnTurn(room) {
    if (!room || room.phase !== 'playing' || !room.game) return null;
    const p = room.game.players[room.game.turnIndex];
    return (p && p.id === socket.data.playerId && !p.eliminated) ? p : null;
  }

  function attach(room, pid) {
    socket.data.roomCode = room.code;
    socket.data.playerId = pid;
    socket.join(room.code);
  }

  // ---- rooms ----

  socket.on('createRoom', (payload, cb) => {
    const name = sanitizeName(payload && payload.name);
    const pid = (payload && payload.playerId) || newId();
    const player = rooms.makePlayer(pid, name, socket.id);
    const room = rooms.create(player);
    attach(room, pid);
    if (typeof cb === 'function') cb({ ok: true, code: room.code, playerId: pid });
    broadcastState(room);
  });

  // ---- Play vs Bots: one human + (total-1) bots, starts immediately ----
  socket.on('createBotGame', (payload, cb) => {
    const name = sanitizeName(payload && payload.name);
    const pid = (payload && payload.playerId) || newId();

    let total = toInt(payload && payload.totalPlayers);
    if (!Number.isFinite(total)) total = 4;
    total = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, total));

    const human = rooms.makePlayer(pid, name, socket.id);
    const room = rooms.create(human, { solo: true });
    makeBots(room, total - 1);

    attach(room, pid);
    beginGame(room);
    if (typeof cb === 'function') cb({ ok: true, code: room.code, playerId: pid, solo: true });
    broadcastState(room);
  });

  socket.on('joinRoom', (payload, cb) => {
    const room = rooms.get(payload && payload.code);
    if (!room) { if (typeof cb === 'function') cb({ ok: false, error: 'Room not found.' }); return; }

    const pid = (payload && payload.playerId) || newId();
    const existing = room.players.find(p => p.id === pid);

    if (existing) {                                   // ---- reconnection ----
      existing.socketId = socket.id;
      existing.connected = true;
      if (payload && payload.name) existing.name = sanitizeName(payload.name);
      attach(room, pid);
      if (typeof cb === 'function') cb({ ok: true, code: room.code, playerId: pid, reconnected: true });
      broadcastState(room);
      return;
    }

    if (room.solo) { if (typeof cb === 'function') cb({ ok: false, error: 'That room is a solo game against bots.' }); return; }
    if (room.phase !== 'lobby') { if (typeof cb === 'function') cb({ ok: false, error: 'That game has already started.' }); return; }
    if (room.players.length >= MAX_PLAYERS) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Room is full (' + MAX_PLAYERS + ' players).' });
      return;
    }

    const name = sanitizeName(payload && payload.name);
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      if (typeof cb === 'function') cb({ ok: false, error: 'That name is already taken in this room.' });
      return;
    }

    const player = rooms.makePlayer(pid, name, socket.id);
    player.seat = room.players.length;
    room.players.push(player);
    attach(room, pid);
    if (typeof cb === 'function') cb({ ok: true, code: room.code, playerId: pid });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = roomOf();
    if (!room) return;
    detach(room, socket.data.playerId);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  });

  // ---- game control ----

  socket.on('startGame', () => {
    const room = roomOf();
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return socket.emit('errorMsg', 'Only the host can start the game.');
    if (room.players.length < MIN_PLAYERS) return socket.emit('errorMsg', 'You need at least ' + MIN_PLAYERS + ' players to start.');
    if (room.players.length > MAX_PLAYERS) return socket.emit('errorMsg', 'A room holds at most ' + MAX_PLAYERS + ' players.');

    beginGame(room);
    broadcastState(room);
  });

  socket.on('placeBid', (raw) => {
    const room = roomOf();
    if (!room || room.phase !== 'playing') return;
    const actor = actorOnTurn(room);
    if (!actor) return socket.emit('errorMsg', 'It is not your turn.');

    const g = room.game;
    const blind = g.roundType === 'blind';
    const bid = blind
      ? { quantity: toInt(raw && raw.quantity), face: null }
      : { quantity: toInt(raw && raw.quantity), face: toInt(raw && raw.face) };

    const test = engine.isValidBid(g.currentBid, blind ? { quantity: bid.quantity } : bid, g.roundType);
    if (!test.valid) return socket.emit('errorMsg', test.reason);

    engine.applyBid(g, actor.seat, bid);
    broadcastState(room);
  });

  socket.on('callDodo', () => {
    const room = roomOf();
    if (!room || room.phase !== 'playing') return;
    const actor = actorOnTurn(room);
    if (!actor) return socket.emit('errorMsg', 'It is not your turn.');
    const g = room.game;
    if (!g.currentBid) return socket.emit('errorMsg', 'There is no bid to challenge yet.');

    if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, actor.seat);
    else engine.resolveDodo(g, actor.seat);
    room.phase = 'reveal';
    broadcastState(room);
  });

  socket.on('callBelieve', () => {
    const room = roomOf();
    if (!room || room.phase !== 'playing') return;
    const actor = actorOnTurn(room);
    if (!actor) return socket.emit('errorMsg', 'It is not your turn.');
    const g = room.game;
    if (!g.currentBid) return socket.emit('errorMsg', 'There is no bid to believe yet.');

    engine.resolveBelieve(g, actor.seat);
    room.phase = 'reveal';
    broadcastState(room);
  });

  socket.on('declareCheck', () => {
    const room = roomOf();
    if (!room || room.phase !== 'playing') return;
    const actor = actorOnTurn(room);
    if (!actor) return socket.emit('errorMsg', 'It is not your turn.');
    const g = room.game;
    if (!engine.canDeclareCheck(g, actor)) return socket.emit('errorMsg', 'You cannot declare Check right now.');

    engine.applyCheck(g, actor.seat);
    broadcastState(room);
  });

  socket.on('nextRound', () => {
    const room = roomOf();
    if (!room || room.phase !== 'reveal') return;      // guards double-advance
    const g = room.game;
    const alive = engine.activePlayers(g);
    if (alive.length <= 1) {
      room.phase = 'gameover';
    } else {
      engine.startRound(g);
      room.phase = 'playing';
    }
    g.reveal = null;
    broadcastState(room);
  });

  socket.on('playAgain', () => {
    const room = roomOf();
    if (!room || room.phase !== 'gameover') return;
    if (socket.data.playerId !== room.hostId) return socket.emit('errorMsg', 'Only the host can start a new game.');

    if (room.solo) {                 // vs bots: just deal a fresh game with the same crew
      beginGame(room);
      broadcastState(room);
      return;
    }
    room.phase = 'lobby';
    room.game = null;
    room.players.forEach(p => { p.diceCount = engine.START_DICE; p.dice = []; p.eliminated = false; });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf();
    if (!room) return;
    detach(room, socket.data.playerId);
  });
});


server.listen(PORT, () => {
  console.log('DODO server listening on http://localhost:' + PORT);
});
