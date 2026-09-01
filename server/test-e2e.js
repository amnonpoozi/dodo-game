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

// track one-shot assertions so a running game doesn't spam the same line
const once = new Set();
function okOnce(key, cond, msg) { if (once.has(key)) return; once.add(key); ok(cond, msg); }

// no client may ever receive another player's dice, or the Blind target, before reveal
function checkNoEarlyExposure(v, opts) {
  if (v.phase === 'playing' || v.phase === 'lobby') {
    const leak = (v.players || []).some(p => p.id !== v.youId && Array.isArray(p.dice) && p.dice.length);
    if (leak) okOnce(opts.tag + ':leak-dice', false, opts.tag + ': a client saw another player’s dice mid-round');
    if (v.blindTarget != null) okOnce(opts.tag + ':leak-target', false, opts.tag + ': a client saw the Blind target mid-round');
    if (v.roundType === 'blind' && Array.isArray(v.yourDice)) {
      okOnce(opts.tag + ':leak-blind-own', false, opts.tag + ': own dice sent during a Blind round');
    }
  }
}

// the reveal payload must carry what the animation needs (all non-secret)
function checkRevealPayload(r, opts) {
  if (!r) return;
  okOnce(opts.tag + ':rev-hands', Array.isArray(r.hands) && r.hands.length > 0, opts.tag + ': reveal carries every hand');
  if (r.kind === 'dodo' || r.kind === 'believe') {
    okOnce(opts.tag + ':rev-caller', !!r.callerId, opts.tag + ': reveal names the caller');
    okOnce(opts.tag + ':rev-bidder', !!r.bidderId, opts.tag + ': reveal names the bidder');
  }
  if (r.kind === 'check') {
    okOnce(opts.tag + ':rev-checker', !!r.checkerId, opts.tag + ': check reveal names the checker');
    okOnce(opts.tag + ':rev-caller-c', !!r.callerId, opts.tag + ': check reveal names the challenger');
  }
}

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
      usedCheck: !!p.usedCheck,                // one-Check-per-round flag, mirrored from the server
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

      checkNoEarlyExposure(v, opts);

      if (v.phase === 'gameover') {
        done = true;
        return finish({ winnerId: v.winnerId, roundNo: v.roundNo });
      }

      if (v.phase === 'reveal') {
        checkRevealPayload(v.reveal, opts);
        // one client advances the round — but only after the server's reveal-hold window
        if (c === clients[0]) {
          const k = 'next:' + v.roundNo;
          if (!seen.has(k)) { seen.add(k); setTimeout(() => { if (!done) c.sock.emit('nextRound'); }, 380); }
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

      const play = () => {
        if (done) return;
        const la = v.legalActions;
        if (a.type === 'check' && la.canCheck) return c.sock.emit('declareCheck');
        if (a.type === 'dodo' && la.canDodo) return c.sock.emit('callDodo');
        if (a.type === 'believe' && la.canBelieve) return c.sock.emit('callBelieve');
        if (a.type === 'bid' && Number.isInteger(a.quantity) &&
            (v.roundType === 'blind' || Number.isInteger(a.face))) {
          return c.sock.emit('placeBid', v.roundType === 'blind'
            ? { quantity: a.quantity } : { quantity: a.quantity, face: a.face });
        }
        // anything not legally emittable -> a guaranteed-legal fallback
        if (la.canDodo) return c.sock.emit('callDodo');
        c.sock.emit('placeBid', v.roundType === 'blind'
          ? { quantity: (v.currentBid ? v.currentBid.quantity : 0) + 1 } : { quantity: 1, face: 2 });
      };
      setTimeout(play, 5);
    };
    // if a move is ever rejected, the server sends only an errorMsg (no new state) —
    // nudge the client so a full game can never stall on one bad move
    c.sock.on('errorMsg', () => {
      if (done) return;
      const v = c.view;
      if (v && v.phase === 'playing' && v.turnPlayerId === v.youId && v.legalActions) {
        if (v.legalActions.canDodo) c.sock.emit('callDodo');
        else c.sock.emit('placeBid', v.roundType === 'blind' ? { quantity: 1 } : { quantity: 1, face: 2 });
      }
    });
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
    autoPlay(clients, { resolve, tag: "online" });
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
    autoPlay([me], { resolve, tag: "bots" });
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

async function runRevealGuardTest() {
  console.log('\n[3] REVEAL-HOLD GUARD — server refuses "next round" too early\n');
  const me = mkClient('Guard');
  await waitConnect(me);
  await emit(me, 'createBotGame', { name: 'Guard', totalPlayers: 2 });

  // drive my turns until the first reveal: Dodo at the first opportunity, otherwise
  // place a guaranteed-legal minimal bid. (Simple + deterministic — this test only
  // needs to *reach* a reveal, it isn't exercising strategy.)
  const reachedReveal = await new Promise((resolve) => {
    const seen = new Set();
    const act = (v) => {
      if (v.phase === 'reveal') return resolve(v);
      if (v.phase !== 'playing' || v.turnPlayerId !== v.youId || !v.legalActions) return;
      const sig = v.roundNo + ':' + (v.history ? v.history.length : 0);
      if (seen.has(sig)) return; seen.add(sig);
      setTimeout(() => {
        if (v.legalActions.canDodo) return me.sock.emit('callDodo');   // -> reveal
        const b = v.currentBid;
        if (v.roundType === 'blind') return me.sock.emit('placeBid', { quantity: (b ? b.quantity : 0) + 1 });
        // normal opening bid — always legal
        me.sock.emit('placeBid', { quantity: 1, face: 2 });
      }, 4);
    };
    me.onState = act;
    me.sock.on('errorMsg', () => {                                  // never stall on a rejected move
      const v = me.view;
      if (v && v.phase === 'playing' && v.turnPlayerId === v.youId && v.legalActions) {
        if (v.legalActions.canDodo) me.sock.emit('callDodo');
        else me.sock.emit('placeBid', v.roundType === 'blind' ? { quantity: 1 } : { quantity: 1, face: 2 });
      }
    });
    if (me.view) act(me.view);
    setTimeout(() => resolve(null), 30000);
  });

  ok(!!reachedReveal, 'reached a round reveal');
  if (reachedReveal) {
    me.onState = () => {};                              // stop auto-playing so nothing else advances rounds
    const roundAtReveal = reachedReveal.roundNo;
    me.sock.emit('nextRound');                          // immediate — should be ignored (< 250ms)
    await sleep(90);
    ok(me.view && me.view.phase === 'reveal' && me.view.roundNo === roundAtReveal,
      'an immediate "next round" is ignored — the reveal stays up');
    await sleep(320);
    me.sock.emit('nextRound');                          // now past the window
    await sleep(200);
    ok(me.view && (me.view.phase === 'playing' || me.view.phase === 'gameover'),
      'after the hold window, "next round" advances (now: ' + (me.view && me.view.phase) + ')');
  }
  me.sock.close();
}

async function runCheckOnceTest() {
  console.log('\n[4] CHECK — one per player per round, enforced by the SERVER\n');
  const NAME = 'Checker';
  let everChecked = false;         // the human successfully declared Check at least once
  let rejectedAfterUse = false;    // a 2nd Check in the same round was rejected with the right message
  let maxPerRound = 0;             // most "Checker said Check" lines seen in any single round

  const roundMarker = (l) => /^— (New round|Blind Round started)/.test(l);
  function checksThisRound(history) {
    let start = 0;
    for (let i = history.length - 1; i >= 0; i--) if (roundMarker(history[i])) { start = i; break; }
    let n = 0;
    for (let i = start; i < history.length; i++) if (history[i] === NAME + ' said Check') n++;
    return n;
  }

  // smallest always-legal raise — keeps the human's bids low so it stays TRUE and
  // the human survives at 5 dice longer, maximising the chance of a checkable hand
  const minRaise = (v) => {
    const b = v.currentBid;
    if (v.roundType === 'blind') return { quantity: (b ? b.quantity : 0) + 1 };
    if (!b) return { quantity: 1, face: 2 };
    if (b.face === 1) return { quantity: b.quantity + 1, face: 1 };       // raise the 1s count
    if (b.face < 6) return { quantity: b.quantity, face: b.face + 1 };
    return { quantity: b.quantity + 1, face: 2 };
  };

  for (let attempt = 0; attempt < 12 && !(everChecked && rejectedAfterUse); attempt++) {
    const me = mkClient(NAME);
    await waitConnect(me);
    await emit(me, 'createBotGame', { name: NAME, totalPlayers: 2 });
    const errors = [];
    me.sock.on('errorMsg', (m) => errors.push(m));

    await new Promise((resolve) => {
      const seen = new Set();
      let finished = false;
      const end = () => { if (!finished) { finished = true; resolve(); } };

      me.onState = (v) => {
        if (finished) return;
        if (v.phase === 'gameover') return end();
        if (v.phase === 'reveal') { setTimeout(() => { if (!finished) me.sock.emit('nextRound'); }, 380); return; }
        if (v.phase !== 'playing') return;

        if (v.history) maxPerRound = Math.max(maxPerRound, checksThisRound(v.history));
        if (v.history && v.history.some(l => l === NAME + ' said Check')) everChecked = true;

        if (v.turnPlayerId !== v.youId || !v.legalActions) return;
        const sig = v.roundNo + ':' + (v.history ? v.history.length : 0) + ':t';
        if (seen.has(sig)) return; seen.add(sig);

        // ALWAYS try to Check first. The server applies it only when eligible; on a
        // turn where we already spent our Check this round it must be refused with
        // the specific "already used" message.
        const alreadyCheckedThisRound = checksThisRound(v.history || []) >= 1;
        const before = errors.length;
        me.sock.emit('declareCheck');

        setTimeout(() => {
          if (finished) return;
          if (alreadyCheckedThisRound &&
              errors.slice(before).some(e => /already used your Check/i.test(e))) {
            rejectedAfterUse = true;
          }
          if (checksThisRound(me.view.history || []) > 1) {
            ok(false, 'a 2nd Check registered in history — server did NOT enforce the rule');
          }
          // then keep the round alive with the smallest legal bid (never dodo/believe,
          // so the human doesn't bleed dice and stays checkable longer)
          if (v.turnPlayerId === v.youId && me.view.phase === 'playing' && me.view.turnPlayerId === v.youId) {
            me.sock.emit('placeBid', minRaise(me.view));
          }
        }, 90);
      };
      if (me.view) me.onState(me.view);
      setTimeout(end, 22000);
    });

    me.sock.close();
  }

  ok(maxPerRound <= 1, 'no player ever declared Check more than once in a round (max seen: ' + maxPerRound + ')');
  ok(everChecked, 'the human actually declared Check at least once (path exercised)');
  ok(rejectedAfterUse, 'the server rejected a 2nd same-round Check with "already used your Check this round"');
}

async function runConsecutiveCheckTest() {
  console.log('\n[5] CHECK — consecutive Checks are legal; Dodo challenges only the latest\n');
  const NAME = 'Chainer';
  let consecutiveSeen = false;       // "A said Check" directly followed by "B said Check" (A != B)
  let canCheckAfterCheck = false;    // server offered canCheck:true while lastActionWasCheck was true
  let bidHeldThroughChain = true;    // the numerical bid never changed across a Check chain
  const roundMarker = (l) => /^— (New round|Blind Round started)/.test(l);

  const minRaise = (v) => {
    const b = v.currentBid;
    if (v.roundType === 'blind') return { quantity: (b ? b.quantity : 0) + 1 };
    if (!b) return { quantity: 1, face: 2 };
    if (b.face === 1) return { quantity: b.quantity + 1, face: 1 };
    if (b.face < 6) return { quantity: b.quantity, face: b.face + 1 };
    return { quantity: b.quantity + 1, face: 2 };
  };
  const bidStr = (b) => b ? (b.quantity + 'x' + b.face) : 'none';

  for (let attempt = 0; attempt < 10 && !(consecutiveSeen && canCheckAfterCheck); attempt++) {
    const me = mkClient(NAME);
    await waitConnect(me);
    await emit(me, 'createBotGame', { name: NAME, totalPlayers: 3 });
    let chainBid = null;   // the numerical bid seen when a Check chain is in progress

    await new Promise((resolve) => {
      let finished = false;
      const seen = new Set();
      const end = () => { if (!finished) { finished = true; resolve(); } };

      me.onState = (v) => {
        if (finished) return;
        if (v.phase === 'gameover') return end();
        if (v.phase === 'reveal') { setTimeout(() => { if (!finished) me.sock.emit('nextRound'); }, 300); return; }
        if (v.phase !== 'playing') return;

        const h = v.history || [];
        // two Checks in a row by different players?
        for (let i = 0; i + 1 < h.length; i++) {
          const a = /^(.+) said Check$/.exec(h[i]);
          const b = /^(.+) said Check$/.exec(h[i + 1]);
          if (a && b && a[1] !== b[1]) consecutiveSeen = true;
        }
        // numerical bid must be stable while a chain is active
        if (v.lastActionWasCheck) {
          if (chainBid == null) chainBid = bidStr(v.currentBid);
          else if (bidStr(v.currentBid) !== chainBid) bidHeldThroughChain = false;
        } else {
          chainBid = null;
        }
        // the human must be offered Check even right after another Check
        if (v.turnPlayerId === v.youId && v.legalActions && v.legalActions.canCheck && v.lastActionWasCheck) {
          canCheckAfterCheck = true;
        }

        if (v.turnPlayerId !== v.youId || !v.legalActions) return;
        const sig = v.roundNo + ':' + h.length;
        if (seen.has(sig)) return; seen.add(sig);

        me.sock.emit('declareCheck');     // bluff every chance
        setTimeout(() => {
          if (finished) return;
          if (me.view && me.view.phase === 'playing' && me.view.turnPlayerId === v.youId) {
            me.sock.emit('placeBid', minRaise(me.view));   // else keep the round moving
          }
        }, 70);
      };
      if (me.view) me.onState(me.view);
      setTimeout(end, 18000);
    });
    me.sock.close();
  }

  ok(consecutiveSeen, 'the server accepted a Check immediately after another player\'s Check');
  ok(canCheckAfterCheck, 'the server keeps canCheck:true for an eligible player even right after a Check');
  ok(bidHeldThroughChain, 'the numerical bid never changed during a chain of consecutive Checks');
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DODO_BOT_THINK_MS: '4',
      DODO_REVEAL_MIN_MS: '250',   // keep the reveal-hold guard, but small enough for a fast test
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => process.stdout.write('  [server] ' + d));
  srv.stderr.on('data', d => process.stderr.write('  [server:err] ' + d));

  // wait until the server actually answers before opening any sockets
  const http = require('http');
  const ping = () => new Promise((res) => {
    const req = http.get(URL + '/health', r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.setTimeout(500, () => { req.destroy(); res(false); });
  });
  for (let i = 0; i < 60; i++) { if (await ping()) break; await sleep(150); }

  try {
    await runOnlineTest();
    await runBotsTest();
    await runRevealGuardTest();
    await runCheckOnceTest();
    await runConsecutiveCheckTest();
  } finally {
    srv.kill();
  }

  console.log('');
  if (failures) { console.error('FAILED — ' + failures + ' check(s) failed.'); process.exit(1); }
  console.log('PASSED — 6-player online multiplayer and 6-player bot mode both work end to end.');
}

main().catch((e) => { console.error(e); process.exit(1); });
