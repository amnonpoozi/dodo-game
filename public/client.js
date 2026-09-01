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
let lastRoundNo = -1;

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
socket.on('state', (v) => { view = v; render(); });

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

  renderSeats();
  renderBid();
  renderTurnLine();
  renderControls();
  renderHistory();
  renderOverlay();

  lastRoundNo = view.roundNo;
}

/* ----- seats + dice cups ----- */

function isNewRound() { return view.roundNo !== lastRoundNo; }
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
  const vessel = document.createElement('div');
  vessel.className = 'cup-vessel';
  vessel.innerHTML = '<span class="cup-rim"></span><span class="cup-shine"></span>';
  cup.appendChild(dice);
  cup.appendChild(vessel);
  el.appendChild(cup);

  const count = document.createElement('div');
  count.className = 'seat-count';
  el.appendChild(count);

  return el;
}

function updateSeat(el, p) {
  const iAmThis = p.id === view.youId;
  // the cup only opens for YOU, only in a normal round while playing, and only
  // when the server actually sent your hand
  const open = iAmThis
    && view.roundType === 'normal'
    && view.phase === 'playing'
    && Array.isArray(view.yourDice)
    && !p.eliminated;
  const isTurn = p.id === view.turnPlayerId && view.phase === 'playing';

  el.classList.toggle('active', isTurn);
  el.classList.toggle('eliminated', p.eliminated);
  el.classList.toggle('me', iAmThis);
  el.classList.toggle('offline', !p.connected);

  el.querySelector('.seat-name').textContent = p.name + (p.isHost ? ' ♦' : '');
  el.querySelector('.turn-flag').textContent = iAmThis ? 'YOUR TURN' : 'DECIDING…';

  const count = el.querySelector('.seat-count');
  count.textContent = p.eliminated
    ? 'OUT'
    : (p.diceCount + (p.diceCount === 1 ? ' die' : ' dice') + (p.connected ? '' : ' • offline'));

  const cup = el.querySelector('.cup');
  cup.classList.toggle('open', open);
  cup.classList.toggle('closed', !open);
  cup.style.display = p.eliminated ? 'none' : '';

  const diceWrap = el.querySelector('.cup-dice');
  const mine = open ? view.yourDice : [];
  const sig = (open ? 'o' : 'c') + ':' + (open ? mine.join(',') : p.diceCount) + ':' + roundKey();
  if (diceWrap.dataset.sig !== sig) {
    diceWrap.dataset.sig = sig;
    diceWrap.innerHTML = '';
    const total = open ? mine.length : (p.eliminated ? 0 : p.diceCount);
    for (let k = 0; k < total; k++) {
      diceWrap.appendChild(makeDie(open ? mine[k] : null, {
        hidden: !open, small: true, rolling: isNewRound(),
      }));
    }
  }
}

/* ----- dice elements ----- */

function makeDie(value, opts) {
  opts = opts || {};
  const d = document.createElement('div');
  d.className = 'die'
    + (opts.hidden ? ' hidden' : '')
    + (opts.small ? ' small' : '')
    + (opts.rolling ? ' rolling' : '');
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

function dieHTML(value, match) {
  let cells = '';
  for (let k = 0; k < 9; k++) {
    cells += '<span class="cell' + (PIP_LAYOUT[value].includes(k) ? ' pip' : '') + '"></span>';
  }
  return '<div class="die' + (match ? ' match' : '') + '">' + cells + '</div>';
}

/* ----- bid card / turn line ----- */

function renderBid() {
  const v = $('bidValue');
  const meta = $('bidMeta');
  const ht = $('hiddenTarget');
  const bid = view.currentBid;

  if (!bid) {
    v.innerHTML = '&mdash;';
    meta.textContent = 'No bid yet';
  } else if (view.roundType === 'blind') {
    v.innerHTML = bid.quantity + ' <span class="x">of the</span> Hidden Target';
    meta.textContent = 'Previous bidder: ' + nameById(view.prevBidderId);
  } else {
    v.innerHTML = bid.quantity + ' <span class="x">×</span> ' + bid.face;
    meta.textContent = 'Previous bidder: ' + nameById(view.prevBidderId)
      + (view.lastActionWasCheck ? ' · ' + nameById(view.checkerId) + ' declared Check' : '');
  }
  ht.classList.toggle('hidden', view.roundType !== 'blind');
}

function renderTurnLine() {
  const line = $('turnLine');
  if (view.phase !== 'playing') { line.textContent = ''; return; }
  line.textContent = view.turnPlayerId === view.youId
    ? 'Your turn'
    : nameById(view.turnPlayerId) + ' is deciding…';
}

/* ----- controls ----- */

function renderControls() {
  const myTurn = view.phase === 'playing' && view.turnPlayerId === view.youId;
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
  if (view.phase !== 'playing' || view.turnPlayerId !== view.youId) return;
  const q = parseInt($('qtyInput').value, 10);
  const payload = view.roundType === 'blind' ? { quantity: q } : { quantity: q, face: selectedFace };
  socket.emit('placeBid', payload);
};
$('dodoBtn').onclick    = () => socket.emit('callDodo');
$('believeBtn').onclick = () => socket.emit('callBelieve');
$('checkBtn').onclick   = () => socket.emit('declareCheck');

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
   Reveal screen + winner screen
   ============================================================ */

function renderOverlay() {
  let key = view.phase;
  if (view.phase === 'reveal') key += ':' + view.roundNo + ':' + (view.history.slice(-1)[0] || '');
  if (view.phase === 'gameover') key += ':' + view.winnerId;
  if (key === lastModalKey) return;
  lastModalKey = key;

  if (view.phase === 'reveal' && view.reveal) showReveal(view.reveal);
  else if (view.phase === 'gameover') showWinner();
  else $('overlay').classList.add('hidden');
}

function revealCupBlock(label, innerDiceHtml, idx) {
  return '<div class="reveal-p" style="--i:' + idx + '">'
    + '<div class="rp-name">' + esc(label) + '</div>'
    + '<div class="reveal-cup"><div class="rp-dice">' + innerDiceHtml + '</div>'
    + '<div class="cup-vessel"><span class="cup-rim"></span><span class="cup-shine"></span></div></div></div>';
}

// rotate revealed hands so the local player is first (matches the table order)
function orderedHands(hands) {
  const meIdx = hands.findIndex(h => h.id === view.youId);
  if (meIdx < 0) return hands;
  return hands.slice(meIdx).concat(hands.slice(0, meIdx));
}

function showReveal(r) {
  const rows = [];

  if (r.kind === 'check') {
    rows.push('<h2>Check Challenge</h2>');
    rows.push('<p>' + esc(nameById(r.checkerId)) + ' declared <strong>Check</strong>.</p>');
    const hand = (r.hands.find(h => h.id === r.checkerId) || { dice: [] }).dice;
    rows.push('<div class="reveal-players">' +
      revealCupBlock(nameById(r.checkerId), hand.map(v => dieHTML(v, false)).join(''), 0) +
      '</div>');
    rows.push('<p>Pattern: <strong>' + (r.checkPattern || 'none') +
      '</strong> — the Check was <strong>' + (r.checkValid ? 'VALID' : 'INVALID') + '</strong>.</p>');
  } else {
    rows.push('<h2>' + (r.kind === 'dodo' ? 'Dodo!' : 'Believe') + '</h2>');
    if (r.blind) rows.push('<p class="target">The hidden target was <strong>' + r.face + '</strong>.</p>');
    rows.push('<p>Previous bid: <strong>' +
      (r.blind ? r.bid.quantity + ' of the hidden target' : (r.bid.quantity + ' × ' + r.bid.face)) +
      '</strong></p>');

    let grid = '<div class="reveal-players">';
    orderedHands(r.hands).forEach((h, idx) => {
      const inner = h.dice
        .map(v => dieHTML(v, v === r.face || (r.wild && r.face !== 1 && v === 1)))
        .join('');
      grid += revealCupBlock(h.name + (h.id === view.youId ? ' (you)' : ''), inner, idx);
    });
    grid += '</div>';
    rows.push(grid);

    let wildNote = r.blind
      ? '1s are NOT wild in a Blind Round'
      : (r.wild ? '1s counted as wildcards' : '1s did NOT count — the bid is on 1s');
    rows.push('<p>Matching dice (' + wildNote + '): <strong>' + r.actual + '</strong></p>');

    if (r.kind === 'dodo') {
      rows.push('<p class="verdict">The bid was <strong>' + (r.bidWasTrue ? 'TRUE' : 'FALSE') + '</strong>.</p>');
    } else {
      rows.push('<p class="verdict">Believe was <strong>' +
        (r.success ? 'EXACT — success' : 'not exact — failed') + '</strong>.</p>');
    }
  }

  if (r.loserId) {
    rows.push('<p>' + esc(nameById(r.loserId)) + ' loses one die' +
      (playerEliminated(r.loserId) ? ' and is eliminated' : '') + '.</p>');
  }
  if (r.gainerId) {
    rows.push('<p>' + esc(nameById(r.gainerId)) + ' gains one die (max 5).</p>');
  }
  rows.push('<p>' + esc(nameById(r.nextStarterId)) + ' starts the next round' +
    (r.pendingBlind ? ' — it will be a <strong>BLIND ROUND</strong>' : '') + '.</p>');

  rows.push('<button id="nextRoundBtn" class="primary big" type="button">Start Next Round</button>');

  $('modal').innerHTML = rows.join('');
  $('overlay').classList.remove('hidden');
  $('nextRoundBtn').onclick = () => {
    $('nextRoundBtn').disabled = true;
    socket.emit('nextRound');
  };
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
