'use strict';

/* ============================================================
   End-to-end test over a REAL server + REAL Socket.IO clients.

   1. ONLINE MULTIPLAYER, 6 players:
        - 6 clients create/join one room
        - a 7th client is refused ("Room is full (6 players).")
        - the lobby view reports "6 / 6"
        - the host starts and a full game is played to a winner,
          every move validated by the server
   2. PLAY VS BOTS, 6 players:
        - one client starts a 6-seat bot game (you + 5 bots)
        - a stranger cannot join the solo room
        - the human plays; the server drives the 5 bots; the game
          runs to a winner

   Needs socket.io-client (a devDependency for tests).
   Run:  node server/test-e2e.js
   ============================================================ */

const { spawn } = require('child_process');
const path = require('path');

let ioClient;
try {
  ioClient = require('socket.io-client').io;
} catch (e) {
  console.error('SKIPPED — socket.io-client is not installed. Run: npm install --no-save socket.io-client');
  process.exit(0);
}

const bot = require('./bot');
const engine = require('./engine');

const PORT = 4123;
const URL = 'http://localhost:' + PORT;

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ' + msg); else { failures++; console.error('  ✗   ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* --- turn a server view into the shape bot.chooseAction expects --- */
function synthGame(view) {
  return {
    roundType: view.roundType,
    currentBid: view.currentBid,
    lastActionWasCheck: view.lastActionWasCheck,
    blindTarget: null,                         // never known to a client — bot must not need it
    players: view.players.map(p => ({
      seat: p.seat,
      diceCount: p.diceCount,
      eliminated: p.eliminated,
      dice: p.id === view.youId ? (view.yourDice || []) : [],
    })),
  };
}

function mkClient(tag) {
  const sock = ioClient(URL, { transports: ['websocket'], forceNew: true });
  const c = { sock, tag, view: null, errors: [] };
  sock.on('state', (v) => { c.view = v; if (c.onState) c.onState(v); });
  sock.on('errorMsg', (m) => { c.errors.push(m); });
  return c;
}
const emit = (c, ev, payload) => new Promise((res) => {
  c.sock.emit(ev, payload, (r) => res(r));
});
const waitConnect = (c) => new Promise((res, rej) => {
  c.sock.on('connect', res);
  c.sock.on('connect_error', rej);
});

/* --- play whichever seat is "me" whenever it is my turn --- */
function autoPlay(clients, opts) {
  const seen = new Set();
  let done = false;
  const finish = opts.resolve;

  clients.forEach((c) => {
    c.onState = (v) => {
      if (done) return;

      if (v.phase === 'gameover') {
        done = true;
        return finish({ winnerId: v.winnerId, roundNo: v.roundNo });
      }

      if (v.phase === 'reveal') {
        // one client advances the round
        if (c === clients[0]) {
          const k = 'next:' + v.roundNo;
          if (!seen.has(k)) { seen.add(k); c.sock.emit('nextRound'); }
        }
        return;
      }

      if (v.phase !== 'playing') return;
      if (v.turnPlayerId !== v.youId || !v.legalActions) return;

      const sig = 'act:' + v.roundNo + ':' + v.turnPlayerId + ':' + (v.history ? v.history.length : 0)
        + ':' + (v.currentBid ? v.currentBid.quantity + '/' + v.currentBid.face : 'none')
        + ':' + v.lastActionWasCheck;
      if (seen.has(sig)) return;
      seen.add(sig);

      const meSeat = v.players.find(p => p.id === v.youId).seat;
      let a;
      try { a = bot.chooseAction(synthGame(v), meSeat); }
      catch (e) { a = { type: v.currentBid ? 'dodo' : 'bid', quantity: 1, face: 2 }; }

      setTimeout(() => {
        if (done) return;
        if (a.type === 'check' && v.legalActions.canCheck) c.sock.emit('declareCheck');
        else if (a.type === 'dodo' && v.legalActions.canDodo) c.sock.emit('callDodo');
        else if (a.type === 'believe' && v.legalActions.canBelieve) c.sock.emit('callBelieve');
        else if (v.roundType === 'blind') c.sock.emit('placeBid', { quantity: a.quantity });
        else c.sock.emit('placeBid', { quantity: a.quantity, face: a.face });
      }, 5);
    };
  });
}

async function runOnlineTest() {
  console.log('\n[1] ONLINE MULTIPLAYER — 6 players\n');
  const names = ['Cap1', 'Cap2', 'Cap3', 'Cap4', 'Cap5', 'Cap6'];
  const clients = names.map((n, i) => mkClient(n));
  await Promise.all(clients.map(waitConnect));

  const created = await emit(clients[0], 'createRoom', { name: names[0] });
  ok(created && created.ok, 'host created a room');
  const code = created.code;

  for (let i = 1; i < 6; i++) {
    const r = await emit(clients[i], 'joinRoom', { code, name: names[i] });
    ok(r && r.ok, names[i] + ' joined (' + (i + 1) + '/6)');
  }

  await sleep(120);
  ok(clients[0].view && clients[0].view.players.length === 6, 'room holds 6 players');

  // 7th is refused
  const c7 = mkClient('Cap7');
  await waitConnect(c7);
  const r7 = await emit(c7, 'joinRoom', { code, name: 'Cap7' });
  ok(r7 && r7.ok === false, '7th player refused');
  ok(r7 && /full/i.test(r7.error || '') && /6/.test(r7.error || ''),
    '  refusal message: "' + (r7 && r7.error) + '"');
  c7.sock.close();

  // play it out
  const result = await new Promise((resolve, reject) => {
    autoPlay(clients, { resolve });
    clients[0].sock.emit('startGame');
    setTimeout(() => reject(new Error('online game did not finish in 60s')), 60000);
  }).catch((e) => { failures++; console.error('  ✗   ' + e.message); return null; });

  if (result) {
    ok(!!result.winnerId, 'game finished with a winner after ' + result.roundNo + ' rounds');
    const w = clients[0].view.players.find(p => p.id === result.winnerId);
    ok(w && !w.eliminated, 'the winner is the last player standing (' + (w && w.name) + ')');
    const survivors = clients[0].view.players.filter(p => !p.eliminated).length;
    ok(survivors === 1, 'exactly one survivor');
  }

  clients.forEach(c => c.sock.close());
}

async function runBotsTest() {
  console.log('\n[2] PLAY VS BOTS — 6 players (you + 5 bots)\n');
  const me = mkClient('Solo');
  await waitConnect(me);

  const r = await emit(me, 'createBotGame', { name: 'Solo', totalPlayers: 6 });
  ok(r && r.ok && r.solo === true, 'bot game created (solo flag set)');
  const code = r.code;

  await sleep(150);
  ok(me.view && me.view.players.length === 6, 'table has 6 seats (you + 5 bots)');
  ok(me.view && me.view.phase === 'playing', 'game auto-started, no waiting room');
  ok(me.view && me.view.players.filter(p => p.id === me.view.youId).length === 1, 'you occupy exactly one seat');

  // a stranger cannot join a solo room
  const stranger = mkClient('Nosey');
  await waitConnect(stranger);
  const sj = await emit(stranger, 'joinRoom', { code, name: 'Nosey' });
  ok(sj && sj.ok === false && /solo/i.test(sj.error || ''),
    'stranger cannot join the bot room: "' + (sj && sj.error) + '"');
  stranger.sock.close();

  const result = await new Promise((resolve, reject) => {
    autoPlay([me], { resolve });
    // nudge: if it is already the human's turn, onState fires on the next broadcast;
    // trigger one by re-emitting nothing — the initial state already arrived.
    if (me.view) me.onState(me.view);
    setTimeout(() => reject(new Error('bot game did not finish in 60s')), 60000);
  }).catch((e) => { failures++; console.error('  ✗   ' + e.message); return null; });

  if (result) {
    ok(!!result.winnerId, 'bot game finished with a winner after ' + result.roundNo + ' rounds');
    const survivors = me.view.players.filter(p => !p.eliminated).length;
    ok(survivors === 1, 'exactly one survivor');
  }

  me.sock.close();
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DODO_BOT_THINK_MS: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => process.stdout.write('  [server] ' + d));
  srv.stderr.on('data', d => process.stderr.write('  [server:err] ' + d));

  await new Promise((res) => {
    const t = setTimeout(res, 2500);
    srv.stdout.on('data', (d) => { if (/listening/.test(String(d))) { clearTimeout(t); res(); } });
  });

  try {
    await runOnlineTest();
    await runBotsTest();
  } finally {
    srv.kill();
  }

  console.log('');
  if (failures) { console.error('FAILED — ' + failures + ' check(s) failed.'); process.exit(1); }
  console.log('PASSED — 6-player online multiplayer and 6-player bot mode both work end to end.');
}

main().catch((e) => { console.error(e); process.exit(1); });
