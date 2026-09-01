'use strict';

/* ============================================================
   DODO — online client.

   The client is a THIN VIEW. It never computes rules, never
   rolls dice, never decides turns. It:
     - shows the lobby / waiting room / table
     - renders whatever authoritative `state` the server sends
     - sends the player's intended action to the server
     - shows server error messages
   It only ever holds this player's own dice (and none at all
   during a Blind Round, until the server sends the reveal).
   ============================================================ */

const socket = io();

/* which cells (row-major 0..8) hold a pip, per die face */
const PIP_LAYOUT = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };

/* cup positions around the table, by player count (index 0 == "you", bottom),
   going clockwise. Every name here has a matching .seat.pos-* rule in style.css. */
const SEAT_LAYOUTS = {
  2: ['bottom', 'top'],
  3: ['bottom', 'topleft', 'topright'],
  4: ['bottom', 'left', 'top', 'right'],
  5: ['bottom', 'left', 'topleft', 'topright', 'right'],
  6: ['bottom', 'left', 'topleft', 'top', 'topright', 'right'],
};

/* player cup image, fixed by SEAT number 1..6 for the whole game */
const CUP_IMAGES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'].map(c => '/cups/' + c + '.png');
function cupImageForSeat(seat) { return CUP_IMAGES[((seat % 6) + 6) % 6]; }
// warm the cache so the first reveal doesn't pop
CUP_IMAGES.forEach(src => { const im = new Image(); im.src = src; });

/* ---------- client-side animation state machine ----------
   The SERVER stays authoritative: it decides the result and sends the `reveal`
   payload (identical to every client). The client only *plays it back* through
   these states. Timings are fixed, so all clients run the same sequence in step.

   playing            -> normal play, controls live
   liftingCups        -> all involved cups rise, dice fade in
   showingDice        -> ~3s: every die visible, result still hidden
   showingResult      -> winner (green) / loser (red) + the reason
   animatingDiceChange-> one die slides out (loss) or in (gain)
   resettingRound     -> new dice dealt & hidden, cups lower again
   startingNextRound  -> new dice roll; the human's cup lifts (normal round)     */
const ANIM = {
  PLAYING: 'playing',
  ANNOUNCE: 'announcingAction',      // DODO / BELIEVE / DODO ON CHECK shown, cups still down
  LIFTING: 'liftingCups',
  SHOWING_DICE: 'showingDice',
  SHOWING_RESULT: 'showingResult',
  DICE_CHANGE: 'animatingDiceChange',
  RESETTING: 'resettingRound',
  NEXT: 'startingNextRound',
};
const ANNOUNCE_MS      = 750;   // beat where only the action + bid show, before the cups lift
const REVEAL_LIFT_MS   = 750;
const REVEAL_DICE_MS    = 3000;   // "look at every die" window — no result yet
const REVEAL_RESULT_MS  = 1200;   // result shown before the die change animates
const DICE_CHANGE_MS    = 800;
const RESET_MS          = 620;
const NEXT_MS           = 680;

let clientPhase = ANIM.PLAYING;
let animToken = 0;                 // bumping this cancels any in-flight sequence
let diceChangeApplied = false;     // has the loss/gain been folded into the counts yet
let revealDone = false;            // local reveal sequence finished -> allow "Start Next Round"
let prevPhase = null;
let nextRetryTimer = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function inRevealAnim() {
  return clientPhase === ANIM.LIFTING || clientPhase === ANIM.SHOWING_DICE
      || clientPhase === ANIM.SHOWING_RESULT || clientPhase === ANIM.DICE_CHANGE;
}

/* ---------- persisted identity (for reconnection) ---------- */
let playerId   = localStorage.getItem('dodo_playerId') || '';
let playerName = localStorage.getItem('dodo_playerName') || '';
let roomCode   = localStorage.getItem('dodo_roomCode') || '';

function persist(id, name, code) {
  playerId = id; playerName = name; roomCode = code;
  localStorage.setItem('dodo_playerId', id);
  localStorage.setItem('dodo_playerName', name);
  localStorage.setItem('dodo_roomCode', code);
}
function clearRoom() {
  roomCode = '';
  localStorage.removeItem('dodo_roomCode');
}

/* ---------- view state ---------- */
let view = null;
let selectedFace = 2;
let needControlDefaults = true;
let seatSig = '';
let lastModalKey = '';

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}
function show(screen) {
  ['lobby', 'room', 'game'].forEach(s => $(s).classList.toggle('hidden', s !== screen));
}
function setConn(ok) { $('connBanner').classList.toggle('hidden', !!ok); }

function flash(msg) {
  let id = 'lobbyMsg';
  if (!$('game').classList.contains('hidden')) id = 'msg';
  else if (!$('room').classList.contains('hidden')) id = 'roomMsg';
  const el = $(id);
  if (el) { el.textContent = msg; el.classList.remove('good'); el.classList.add('bad'); }
}
function setMsg(text, kind) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
function nameById(id) {
  if (!id || !view) return '—';
  const p = view.players.find(x => x.id === id);
  return p ? p.name : '—';
}
function playerEliminated(id) {
  const p = view && view.players.find(x => x.id === id);
  return !!(p && p.eliminated);
}

/* ============================================================
   Socket lifecycle
   ============================================================ */

socket.on('connect', () => {
  setConn(true);
  if (roomCode && playerId) {
    // reconnect / rejoin transparently
    socket.emit('joinRoom', { code: roomCode, name: playerName, playerId }, (res) => {
      if (!res || !res.ok) { clearRoom(); if (!view) show('lobby'); }
    });
  } else {
    show('lobby');
  }
});
socket.on('disconnect', () => setConn(false));
socket.on('connect_error', () => setConn(false));

socket.on('errorMsg', (m) => flash(m));

socket.on('state', (v) => {
  const from = prevPhase;
  view = v;

  if (v.phase === 'lobby') {
    animToken++;                       // cancel anything running
    clientPhase = ANIM.PLAYING;
    diceChangeApplied = false;
    revealDone = false;
    prevPhase = 'lobby';
    render();
    return;
  }

  driveAnimation(from, v);
  prevPhase = v.phase;
  render();
});

/* Decide which client-side sequence a server state-change kicks off. */
function driveAnimation(from, v) {
  if (v.phase === 'reveal' && from !== 'reveal') {
    runRevealSequence();
  } else if (v.phase === 'playing' && from === 'reveal') {
    runNextRoundSequence();
  } else if (v.phase === 'playing' && from && from !== 'playing' && from !== 'reveal') {
    quickStartSequence();             // lobby -> playing (fresh game): quick roll-in
  } else if (v.phase === 'gameover') {
    animToken++;
    clientPhase = ANIM.PLAYING;       // reveal already played out; winner modal takes over
  }
  // any other transition (in-round state update) leaves clientPhase untouched
}

async function runRevealSequence() {
  const mine = ++animToken;
  const live = () => mine === animToken;
  diceChangeApplied = false;
  revealDone = false;

  // 1. announce the action + the exact bid it refers to (cups still closed)
  clientPhase = ANIM.ANNOUNCE;    render();
  await sleep(ANNOUNCE_MS);       if (!live()) return;

  // 2. start the cup reveal — the action + bid stay on screen through it
  clientPhase = ANIM.LIFTING;     render();
  await sleep(REVEAL_LIFT_MS);    if (!live()) return;

  clientPhase = ANIM.SHOWING_DICE; render();
  await sleep(REVEAL_DICE_MS);     if (!live()) return;

  clientPhase = ANIM.SHOWING_RESULT; render();
  await sleep(REVEAL_RESULT_MS);   if (!live()) return;

  const changes = (view.reveal && view.reveal.hands || []).some(h => {
    const p = view.players.find(x => x.id === h.id);
    return p && p.diceCount !== h.dice.length;
  });
  if (changes) {
    clientPhase = ANIM.DICE_CHANGE; render();
    await sleep(DICE_CHANGE_MS);    if (!live()) return;
    diceChangeApplied = true;       render();
    await sleep(260);               if (!live()) return;
  } else {
    diceChangeApplied = true;
  }

  revealDone = true;
  clientPhase = ANIM.SHOWING_RESULT;   // hold on the result; "Start Next Round" now available
  render();
}

async function runNextRoundSequence() {
  const mine = ++animToken;
  const live = () => mine === animToken;
  diceChangeApplied = false;
  revealDone = false;

  clientPhase = ANIM.RESETTING;  render();   // fresh dice dealt & hidden; cups come down
  await sleep(RESET_MS);         if (!live()) return;

  clientPhase = ANIM.NEXT;       render();    // dice roll; the human's cup lifts if normal
  await sleep(NEXT_MS);          if (!live()) return;

  clientPhase = ANIM.PLAYING;    render();    // controls live again
}

async function quickStartSequence() {
  const mine = ++animToken;
  clientPhase = ANIM.NEXT;   render();
  await sleep(NEXT_MS);
  if (mine !== animToken) return;
  clientPhase = ANIM.PLAYING; render();
}

function emitNextRound() {
  socket.emit('nextRound');
  clearTimeout(nextRetryTimer);
  nextRetryTimer = setTimeout(() => {
    if (view && view.phase === 'reveal' && revealDone) {
      const b = $('nextRoundBtn');
      if (b) b.disabled = false;               // server held us on the 3s window — allow a retry
    }
  }, 1600);
}

/* ----- reveal helpers ----- */
function revealReason(r) {
  if (r.kind === 'check')   return r.checkValid ? 'Check was valid' : 'Check was invalid';
  if (r.kind === 'dodo')    return r.bidWasTrue ? 'Dodo was wrong' : 'Dodo was correct';
  return r.success ? 'Believe was exact' : 'Believe was incorrect';
}
function revealWinnerId(r) {
  if (r.kind === 'believe') return r.success ? (r.gainerId || r.callerId) : r.bidderId;
  const pair = r.kind === 'check' ? [r.callerId, r.checkerId] : [r.callerId, r.bidderId];
  return pair.find(id => id && id !== r.loserId) || null;
}
// which players' cups lift for this reveal
function cupLiftsInReveal(r, playerId) {
  if (r.kind !== 'check') return true;                 // normal + blind: everyone
  return playerId === r.checkerId || playerId === r.loserId;   // check: only the involved hands
}

/* ---------- the centre panel: normal bid | special-action | result ---------- *
 * The centre of the table shows ONE of:
 *   null       -> the normal Current Bid card (#tableCenter)
 *   'check'    -> "CHECK" + the active bid + who declared it (stays until the
 *                 next player action changes state)
 *   'announce' -> "DODO" / "BELIEVE" / "DODO ON CHECK" + the exact bid + who,
 *                 held through the cup-lift + dice-reveal
 *   'result'   -> the existing round result (reason + winner/loser + next)
 * Every mode is driven by SERVER-confirmed state, so all clients match.       */
function centerBannerMode() {
  const cp = clientPhase;
  if (view.phase === 'reveal' && view.reveal) {
    if (cp === ANIM.ANNOUNCE || cp === ANIM.LIFTING || cp === ANIM.SHOWING_DICE) return 'announce';
    if (cp === ANIM.SHOWING_RESULT || cp === ANIM.DICE_CHANGE || revealDone) return 'result';
  }
  if (view.phase === 'playing' && view.lastActionWasCheck && cp === ANIM.PLAYING) return 'check';
  return null;
}

// bid recap in the required order:  [QUANTITY]  ×  [visual die face]  (hidden die in a Blind Round)
function bidRecapHTML(quantity, face, blind) {
  if (quantity == null) return '';
  return '<span class="rb-q">' + quantity + '</span> <span class="rb-x">&times;</span> '
       + dieFaceHTML(blind ? null : face, { hidden: !!blind });
}

// contents for the 'check' / 'announce' centre banner
function actionBannerHTML() {
  const r = view.phase === 'reveal' ? view.reveal : null;
  const blindNow = view.roundType === 'blind';
  let title, who, qty, face, blind;

  if (!r) {                                   // CHECK just declared (still the playing phase)
    title = 'CHECK';
    who = esc(nameById(view.checkerId)) + ' declared Check';
    const b = view.currentBid;
    qty = b ? b.quantity : null; face = b ? b.face : null; blind = blindNow;
  } else if (r.kind === 'believe') {
    title = 'BELIEVE';
    who = esc(nameById(r.callerId)) + ' believes this bid';
    const b = r.bid || view.currentBid;
    qty = b ? b.quantity : null; face = b ? b.face : null; blind = !!r.blind;
  } else if (r.kind === 'check') {            // a Dodo challenging a Check
    title = 'DODO ON CHECK';
    who = esc(nameById(r.callerId)) + ' challenges ' + esc(nameById(r.checkerId)) + '&rsquo;s Check';
    const b = view.currentBid;                // active bid, for context
    qty = b ? b.quantity : null; face = b ? b.face : null; blind = blindNow;
  } else {                                    // plain Dodo
    title = 'DODO';
    who = esc(nameById(r.callerId)) + ' called Dodo';
    const b = r.bid || view.currentBid;
    qty = b ? b.quantity : null; face = b ? b.face : null; blind = !!r.blind;
  }

  let h = '<div class="rb-action">' + title + '</div>';
  if (qty != null) h += '<div class="rb-line rb-bidline">' + bidRecapHTML(qty, face, blind) + '</div>';
  h += '<div class="rb-who">' + who + '</div>';
  return h;
}

/* ============================================================
   Lobby / waiting room wiring
   ============================================================ */

$('nameInput').value = playerName;
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return flash('Enter your name first.');
  socket.emit('createRoom', { name, playerId }, (res) => {
    if (!res || !res.ok) return flash((res && res.error) || 'Could not create the room.');
    persist(res.playerId, name, res.code);
  });
};

$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return flash('Enter your name first.');
  if (!code) return flash('Enter a room code.');
  socket.emit('joinRoom', { code, name, playerId }, (res) => {
    if (!res || !res.ok) return flash((res && res.error) || 'Could not join that room.');
    persist(res.playerId, name, res.code);
  });
};

/* ---- Play vs Bots: pick a total player count (2..6), you are player 1 ---- */
let botTotal = 4;
(function wireBotCount() {
  const box = $('botCount');
  const setSel = (n) => {
    botTotal = n;
    [...box.children].forEach(b => b.classList.toggle('selected', Number(b.dataset.n) === n));
  };
  [...box.children].forEach(b => { b.onclick = () => setSel(Number(b.dataset.n)); });
  setSel(botTotal);
})();

$('botBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return flash('Enter your name first.');
  socket.emit('createBotGame', { name, playerId, totalPlayers: botTotal }, (res) => {
    if (!res || !res.ok) return flash((res && res.error) || 'Could not start the bot game.');
    persist(res.playerId, name, res.code);
  });
};

$('startBtn').onclick = () => socket.emit('startGame');

$('leaveBtn').onclick = () => {
  socket.emit('leaveRoom');
  clearRoom(); view = null; show('lobby');
};
$('leaveGameBtn').onclick = () => {
  if (confirm('Leave this game? You can rejoin with the same name and room code.')) {
    socket.emit('leaveRoom');
    clearRoom(); view = null; show('lobby');
  }
};

/* ============================================================
   Render dispatch
   ============================================================ */

function render() {
  if (!view) { show('lobby'); return; }
  if (view.phase === 'lobby') {
    $('overlay').classList.add('hidden');
    lastModalKey = '';
    seatSig = '';
    renderRoom();
    show('room');
  } else {
    renderGame();
    show('game');
  }
}

function renderRoom() {
  $('roomCodeText').textContent = view.code;

  const ul = $('playerList');
  ul.innerHTML = '';
  view.players.forEach(p => {
    const li = document.createElement('li');
    let label = p.name;
    if (p.id === view.youId) { label += ' (you)'; li.classList.add('is-you'); }
    if (p.isHost) label += ' — host';
    if (!p.connected) { label += ' • offline'; li.classList.add('is-off'); }
    li.textContent = label;
    ul.appendChild(li);
  });

  const pc = $('playerCount');
  if (pc) pc.textContent = 'Players: ' + view.players.length + ' / 6';

  const isHost = view.youId === view.hostId;
  const canStart = isHost && view.players.length >= 2 && view.players.length <= 6;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = !canStart;
  $('roomWait').classList.toggle('hidden', isHost);
  $('roomMsg').textContent = view.players.length < 2 ? 'Waiting for at least one more player…' : '';
}

/* ============================================================
   Table rendering
   ============================================================ */

function renderGame() {
  const g = $('game');
  g.classList.toggle('blind', view.roundType === 'blind');

  const badge = $('roundBadge');
  badge.textContent = view.roundType === 'blind'
    ? 'BLIND ROUND — Nobody can see their dice'
    : 'Normal Round';
  badge.classList.toggle('blind', view.roundType === 'blind');
  $('roomTag').textContent = 'Room ' + view.code;

  g.classList.toggle('revealing', view.phase === 'reveal');

  renderSeats();
  renderBid();
  renderRevealBanner();
  renderTurnLine();
  renderControls();
  renderHistory();
  renderOverlay();
}

/* ----- seats + dice cups ----- */

function roundKey() { return view.roundNo + ':' + view.roundType + ':' + view.phase; }

// order players so the local player is first ("bottom"), then clockwise
function displaySeats() {
  const n = view.players.length;
  let meIdx = view.players.findIndex(p => p.id === view.youId);
  if (meIdx < 0) meIdx = 0;
  const layout = SEAT_LAYOUTS[n] || SEAT_LAYOUTS[4];
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ p: view.players[(meIdx + k) % n], pos: layout[k] || 'top' });
  }
  return out;
}

function renderSeats() {
  const wrap = $('seats');
  const seats = displaySeats();
  const n = seats.length;
  wrap.className = 'seats players-' + n;

  const sig = n + '|' + seats.map(s => s.p.id + s.pos).join(',');
  if (seatSig !== sig) {
    seatSig = sig;
    wrap.innerHTML = '';
    seats.forEach(s => wrap.appendChild(buildSeat(s.pos)));
  }
  seats.forEach((s, i) => updateSeat(wrap.children[i], s.p));
}

function buildSeat(pos) {
  const el = document.createElement('div');
  el.className = 'seat pos-' + pos;

  const flag = document.createElement('div');
  flag.className = 'turn-flag';
  el.appendChild(flag);

  const nameEl = document.createElement('div');
  nameEl.className = 'seat-name';
  el.appendChild(nameEl);

  const cup = document.createElement('div');
  cup.className = 'cup';
  const dice = document.createElement('div');
  dice.className = 'cup-dice';
  const img = document.createElement('img');
  img.className = 'cup-img';
  img.alt = '';
  img.draggable = false;
  cup.appendChild(dice);
  cup.appendChild(img);
  el.appendChild(cup);

  const count = document.createElement('div');
  count.className = 'seat-count';
  el.appendChild(count);

  return el;
}

/* Work out exactly what a seat should show right now, from the server `view`
   plus the current client animation phase. One place, used for every player,
   so the same rules drive all 2..6 cups. */
function seatVisual(p) {
  const isMe = p.id === view.youId;
  const rev = view.phase === 'reveal' ? view.reveal : null;
  const cp = clientPhase;

  const out = {
    lifted: false,
    faces: null,        // face-up dice values to render
    hiddenCount: 0,     // face-down dice to render (under the cup)
    count: p.diceCount, // number on the seat tag
    rolling: false,
    glow: null,         // 'win' | 'lose'
    leaveLast: false,   // last face-up die animates out
    enterExtra: false,  // one extra die animates in
    matchFace: null,
    matchWild: false,
    hideCup: p.eliminated,
  };

  /* ---------- during the reveal flow ---------- */
  if (rev && (inRevealAnim() || revealDone)) {
    const hand = (rev.hands || []).find(h => h.id === p.id);
    const lifts = hand && cupLiftsInReveal(rev, p.id);

    if (lifts) {
      const before = hand.dice.length;
      const after = p.diceCount;
      out.lifted = true;
      out.hideCup = false;
      // a Blind Round's target must stay secret until the result is shown — so no
      // die-match outlines during the "look at the dice" window for a blind reveal
      const showMatches = !rev.blind
        || cp === ANIM.SHOWING_RESULT || cp === ANIM.DICE_CHANGE || revealDone;
      out.matchFace = showMatches ? rev.face : null;
      out.matchWild = rev.wild;

      if (!diceChangeApplied) {
        out.faces = hand.dice.slice();
        out.count = before;
        out.leaveLast  = cp === ANIM.DICE_CHANGE && after < before;
        out.enterExtra = cp === ANIM.DICE_CHANGE && after > before;
      } else {
        out.faces = after < before ? hand.dice.slice(0, Math.max(0, after)) : hand.dice.slice();
        out.hiddenCount = Math.max(0, after - out.faces.length);   // a gained die has no value yet
        out.count = after;
        out.hideCup = p.eliminated;                                 // now they can go dark / "OUT"
      }
    } else {
      out.hiddenCount = p.eliminated ? 0 : p.diceCount;
    }

    if (cp === ANIM.SHOWING_RESULT || cp === ANIM.DICE_CHANGE || revealDone) {
      const winId = revealWinnerId(rev);
      if (p.id === rev.loserId) out.glow = 'lose';
      else if (p.id === winId) out.glow = 'win';
    }
    return out;
  }

  /* ---------- normal play + the next-round transition ---------- */
  const normalRound = view.roundType === 'normal';
  const myHandReady = isMe && !p.eliminated && normalRound && Array.isArray(view.yourDice);

  if (myHandReady && (cp === ANIM.PLAYING || cp === ANIM.NEXT)) {
    out.lifted = true;
    out.faces = view.yourDice.slice();
    out.rolling = cp === ANIM.NEXT;
  } else if (!p.eliminated) {
    // cup down: opponents always, me during a Blind Round or while the cup is lowered
    out.hiddenCount = p.diceCount;
    out.rolling = cp === ANIM.NEXT && isMe;
  }
  return out;
}

function updateSeat(el, p) {
  const isMe = p.id === view.youId;
  const vis = seatVisual(p);
  const isTurn = p.id === view.turnPlayerId && view.phase === 'playing' && clientPhase === ANIM.PLAYING;

  el.classList.toggle('active', isTurn);
  el.classList.toggle('eliminated', p.eliminated && vis.hideCup);
  el.classList.toggle('me', isMe);
  el.classList.toggle('offline', !p.connected);
  el.classList.toggle('win', vis.glow === 'win');
  el.classList.toggle('lose', vis.glow === 'lose');

  el.querySelector('.seat-name').textContent = p.name + (p.isHost ? ' ♦' : '');
  el.querySelector('.turn-flag').textContent = isMe ? 'YOUR TURN' : 'DECIDING…';

  const count = el.querySelector('.seat-count');
  count.textContent = (p.eliminated && vis.hideCup)
    ? 'OUT'
    : (vis.count + (vis.count === 1 ? ' die' : ' dice') + (p.connected ? '' : ' • offline'));

  const img = el.querySelector('.cup-img');
  const wantSrc = cupImageForSeat(p.seat);
  if (img.getAttribute('src') !== wantSrc) img.setAttribute('src', wantSrc);

  const cup = el.querySelector('.cup');
  cup.classList.toggle('lifted', vis.lifted);
  cup.style.display = vis.hideCup ? 'none' : '';

  const diceWrap = el.querySelector('.cup-dice');
  const faces = vis.faces || [];
  const sig = JSON.stringify([
    vis.lifted, faces, vis.hiddenCount, vis.leaveLast, vis.enterExtra,
    vis.matchFace, vis.matchWild, vis.rolling, roundKey(), clientPhase, diceChangeApplied,
  ]);
  if (diceWrap.dataset.sig !== sig) {
    diceWrap.dataset.sig = sig;
    diceWrap.innerHTML = '';
    faces.forEach((val, k) => {
      const match = vis.matchFace != null &&
        (val === vis.matchFace || (vis.matchWild && vis.matchFace !== 1 && val === 1));
      diceWrap.appendChild(makeDie(val, {
        small: true,
        rolling: vis.rolling,
        match,
        leaving: vis.leaveLast && k === faces.length - 1,
      }));
    });
    for (let k = 0; k < vis.hiddenCount; k++) {
      diceWrap.appendChild(makeDie(null, { hidden: true, small: true, rolling: vis.rolling }));
    }
    if (vis.enterExtra) {
      diceWrap.appendChild(makeDie(null, { hidden: true, small: true, entering: true }));
    }
  }

  // exactly 5 dice need a wider row so the outer die clears the lifted cup (CSS)
  diceWrap.classList.toggle('five', diceWrap.children.length === 5);
}

/* ----- dice elements ----- */

function makeDie(value, opts) {
  opts = opts || {};
  const d = document.createElement('div');
  d.className = 'die'
    + (opts.hidden ? ' hidden' : '')
    + (opts.small ? ' small' : '')
    + (opts.rolling ? ' rolling' : '')
    + (opts.match ? ' match' : '')
    + (opts.leaving ? ' die-leaving' : '')
    + (opts.entering ? ' die-entering' : '');
  if (opts.hidden || !value) {
    const m = document.createElement('span');
    m.className = 'mark';
    m.textContent = '?';
    d.appendChild(m);
    return d;
  }
  for (let k = 0; k < 9; k++) {
    const c = document.createElement('span');
    c.className = 'cell' + (PIP_LAYOUT[value].includes(k) ? ' pip' : '');
    d.appendChild(c);
  }
  return d;
}

// the same die as markup, for innerHTML contexts (the reveal banner)
function dieFaceHTML(value, opts) {
  opts = opts || {};
  if (opts.hidden || !value) return '<span class="die die-inline hidden"><span class="mark">?</span></span>';
  let cells = '';
  for (let k = 0; k < 9; k++) {
    cells += '<span class="cell' + (PIP_LAYOUT[value].includes(k) ? ' pip' : '') + '"></span>';
  }
  return '<span class="die die-inline">' + cells + '</span>';
}

/* ----- bid card / turn line ----- */

function renderBid() {
  // the centre shows the special-action / result banner instead whenever one is active
  const banner = centerBannerMode();
  $('tableCenter').classList.toggle('hidden', !!banner);
  if (banner) return;

  const v = $('bidValue');
  const meta = $('bidMeta');
  const bid = view.currentBid;
  const blind = view.roundType === 'blind';

  // order:  [ QUANTITY ]  ×  [ visual die face ]
  //   - the number is HOW MANY
  //   - the DIE (real pips, large) is WHAT value is bid
  //   - Blind Round: the die is a hidden "?" — the secret target is never shown
  v.innerHTML = '';
  if (!bid) {
    const dash = document.createElement('span');
    dash.className = 'bid-empty';
    dash.textContent = '—';
    v.appendChild(dash);
    meta.textContent = 'No bid yet';
    return;
  }

  const q = document.createElement('span');
  q.className = 'bid-qty';
  q.textContent = String(bid.quantity);
  v.appendChild(q);
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  v.appendChild(x);
  v.appendChild(makeDie(blind ? null : bid.face, { hidden: blind }));

  meta.textContent = 'Previous bidder: ' + nameById(view.prevBidderId);
}

function renderTurnLine() {
  const line = $('turnLine');
  if (clientPhase === ANIM.LIFTING || clientPhase === ANIM.SHOWING_DICE) { line.textContent = 'Revealing the dice…'; return; }
  if (clientPhase === ANIM.SHOWING_RESULT || clientPhase === ANIM.DICE_CHANGE) { line.textContent = 'Round result'; return; }
  if (clientPhase === ANIM.RESETTING || clientPhase === ANIM.NEXT) { line.textContent = 'Dealing the next round…'; return; }
  if (view.phase !== 'playing') { line.textContent = ''; return; }
  line.textContent = view.turnPlayerId === view.youId
    ? 'Your turn'
    : nameById(view.turnPlayerId) + ' is deciding…';
}

/* ----- controls ----- *
 * Live ONLY when it is genuinely my turn AND no animation is running. Every
 * button is also guarded on click (canAct), so a stale DOM state can't act. */

function canAct() {
  return !!view && view.phase === 'playing'
    && clientPhase === ANIM.PLAYING
    && view.turnPlayerId === view.youId;
}

function renderControls() {
  const myTurn = canAct();
  const la = view.legalActions || {};

  $('controls').classList.toggle('disabled', !myTurn);

  if (myTurn && needControlDefaults) {
    setControlDefaults();
    needControlDefaults = false;
    setMsg('');
  }
  if (!myTurn) needControlDefaults = true;

  $('bidBtn').disabled     = !myTurn;
  $('dodoBtn').disabled    = !(myTurn && la.canDodo);
  $('believeBtn').disabled = !(myTurn && la.canBelieve);
  $('checkBtn').disabled   = !(myTurn && la.canCheck);

  // one Check per player per round — show that it has been spent
  const me = view.players.find(p => p.id === view.youId);
  const checkSpent = !!(me && me.usedCheck) && view.roundType === 'normal';
  $('checkBtn').classList.toggle('spent', checkSpent);
  $('checkBtn').title = checkSpent ? 'You have already used your Check this round' : '';
}

// pre-fill the smallest obvious legal raise
function setControlDefaults() {
  const b = view.currentBid;
  const qty = $('qtyInput');
  if (view.roundType === 'blind') {
    qty.value = b ? b.quantity + 1 : 1;
    return;
  }
  let q, f;
  if (!b) { q = 1; f = 2; }
  else if (b.face < 6) { q = b.quantity; f = b.face + 1; }
  else { q = b.quantity + 1; f = 2; }
  qty.value = q;
  selectFace(f);
}

function buildFacePicker() {
  const fp = $('facePicker');
  fp.innerHTML = '';
  for (let f = 1; f <= 6; f++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'face-btn';
    b.dataset.face = String(f);
    b.appendChild(makeDie(f, { small: true }));
    b.addEventListener('click', () => selectFace(f));
    fp.appendChild(b);
  }
  selectFace(2);
}
function selectFace(f) {
  selectedFace = f;
  document.querySelectorAll('.face-btn').forEach(b => {
    b.classList.toggle('selected', Number(b.dataset.face) === f);
  });
}
function stepQty(d) {
  const el = $('qtyInput');
  el.value = Math.max(1, (parseInt(el.value, 10) || 1) + d);
}

$('qtyMinus').onclick = () => stepQty(-1);
$('qtyPlus').onclick = () => stepQty(1);

$('bidBtn').onclick = () => {
  if (!canAct()) return;
  const q = parseInt($('qtyInput').value, 10);
  const payload = view.roundType === 'blind' ? { quantity: q } : { quantity: q, face: selectedFace };
  socket.emit('placeBid', payload);
};
$('dodoBtn').onclick    = () => { if (canAct()) socket.emit('callDodo'); };
$('believeBtn').onclick = () => { if (canAct()) socket.emit('callBelieve'); };
$('checkBtn').onclick   = () => { if (canAct()) socket.emit('declareCheck'); };

/* ----- history ----- */

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  (view.history || []).forEach(h => {
    const li = document.createElement('li');
    li.textContent = h;
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}

/* ============================================================
   Reveal banner (on the table)  +  winner screen (modal)
   ============================================================ */

// modal is used ONLY for game over now; the round reveal plays out on the table
function renderOverlay() {
  const key = view.phase === 'gameover' ? 'go:' + view.winnerId : view.phase;
  if (key === lastModalKey) return;
  lastModalKey = key;

  if (view.phase === 'gameover') showWinner();
  else $('overlay').classList.add('hidden');
}

function renderRevealBanner() {
  const el = $('revealBanner');
  const mode = centerBannerMode();
  el.classList.toggle('hidden', !mode);
  if (!mode) { el.innerHTML = ''; el.classList.remove('as-result', 'as-action'); return; }

  // CHECK announcement (playing phase) OR DODO / BELIEVE / DODO ON CHECK (reveal, pre-result)
  if (mode === 'check' || mode === 'announce') {
    el.innerHTML = actionBannerHTML();
    el.classList.add('as-action');
    el.classList.remove('as-result');
    return;
  }

  // mode === 'result' — the existing round result
  const r = view.reveal;
  const isCheck = r.kind === 'check';
  // bid recap in the required order:  [quantity] × [visual die face]
  const bidHtml = r.bid
    ? bidRecapHTML(r.bid.quantity, r.bid.face, r.blind)
    : (view.currentBid ? bidRecapHTML(view.currentBid.quantity, view.currentBid.face, r.blind) : '&mdash;');

  const winId = revealWinnerId(r);
  const loseId = r.loserId;
  let h = '<div class="rb-reason">' + esc(revealReason(r)) + '</div>';
  if (isCheck) {
    h += '<div class="rb-line">' + esc(nameById(r.checkerId)) + '&rsquo;s hand: <strong>' + esc(r.checkPattern || 'no pattern') + '</strong></div>';
  } else {
    h += '<div class="rb-line rb-bidline">Bid ' + bidHtml + ' &nbsp;&middot;&nbsp; counted <strong>' + r.actual + '</strong></div>';
    if (r.blind) h += '<div class="rb-line rb-target">Hidden target was <strong>' + r.face + '</strong> (1s are not wild)</div>';
    else h += '<div class="rb-line">' + (r.wild ? '1s counted as wildcards' : '1s did not count &mdash; the bid is on 1s') + '</div>';
  }

  if (winId) h += '<span class="rb-win">&#9650; ' + esc(nameById(winId)) + '</span>';
  if (loseId) h += '<span class="rb-lose">&#9660; ' + esc(nameById(loseId))
    + (diceChangeApplied && playerEliminated(loseId) ? ' &mdash; out' : '') + '</span>';
  if (r.gainerId && !loseId) h += '<span class="rb-win">+ ' + esc(nameById(r.gainerId)) + ' gains a die</span>';

  h += '<div class="rb-next-line">' + esc(nameById(r.nextStarterId)) + ' starts next'
    + (r.pendingBlind ? ' &mdash; <strong>BLIND ROUND</strong>' : '') + '</div>';
  if (revealDone) h += '<button id="nextRoundBtn" class="primary big" type="button">Start Next Round</button>';

  el.innerHTML = h;
  el.classList.add('as-result');
  el.classList.remove('as-action');
  const btn = $('nextRoundBtn');
  if (btn) btn.onclick = () => { btn.disabled = true; emitNextRound(); };
}

function showWinner() {
  const won = view.winnerId === view.youId;
  const wname = nameById(view.winnerId);
  const isHost = view.youId === view.hostId;

  $('modal').innerHTML =
    '<h2 class="win">' + (won ? 'YOU WIN!' : esc((wname || 'Nobody').toUpperCase()) + ' WINS!') + '</h2>' +
    '<p>' + (won ? 'The table is yours, captain.' : 'Better luck next voyage.') + '</p>' +
    (isHost
      ? '<button id="playAgainBtn" class="primary big" type="button">Play Again</button>'
      : '<p class="hint">Waiting for the host to start a new game…</p>');

  $('overlay').classList.remove('hidden');
  const pa = $('playAgainBtn');
  if (pa) pa.onclick = () => { pa.disabled = true; socket.emit('playAgain'); };
}

/* ============================================================
   Boot
   ============================================================ */

buildFacePicker();
show('lobby');
