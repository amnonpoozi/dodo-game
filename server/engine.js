'use strict';

/* ============================================================
   DODO — authoritative rule engine (server-side).

   This is the SAME custom DODO rule set that the original local
   game used, ported unchanged. It operates on a plain game state
   object `g` and never touches the network or the DOM.

   g = {
     players: [ { id, name, socketId, connected, seat, diceCount, dice[], eliminated } ],
     turnIndex, roundType ('normal'|'blind'), blindTarget (SECRET),
     currentBid ({quantity, face} | null; face === null in blind rounds),
     prevBidderIndex, lastActionWasCheck, checkerIndex,
     history[], pendingBlind, nextStarterIndex, roundNo, reveal
   }
   ============================================================ */

const START_DICE = 5;
const MAX_DICE   = 5;


/* ---------- pure bid maths ---------- */

// Switching FROM a normal face (2..6) TO a bid on 1s:
// quantity of 1s must be STRICTLY greater than half the previous quantity.
function getMinimumOnesBid(prevQuantity) {
  return Math.floor(prevQuantity / 2) + 1;
}

// Switching FROM a bid on 1s BACK TO a normal face: at least double the quantity.
function getMinimumNormalBidFromOnes(prevQuantity) {
  return prevQuantity * 2;
}

function bidText(b) { return b.quantity + ' × ' + b.face; }

/**
 * Is `next` a legal raise over `prev`? `prev` is null for the opening bid.
 * Returns { valid:boolean, reason?:string }.
 */
function isValidBid(prev, next, roundType) {
  if (!Number.isInteger(next.quantity) || next.quantity < 1) {
    return { valid: false, reason: 'Quantity must be a whole number of at least 1.' };
  }

  // --- Blind Round: quantity only, must go up ---
  if (roundType === 'blind') {
    if (!prev) return { valid: true };
    if (next.quantity > prev.quantity) return { valid: true };
    return { valid: false, reason: 'Blind Round bids may only go up. The current quantity is ' + prev.quantity + '.' };
  }

  // --- Normal round ---
  if (!Number.isInteger(next.face) || next.face < 1 || next.face > 6) {
    return { valid: false, reason: 'Pick a face from 1 to 6.' };
  }
  if (!prev) return { valid: true };

  const prevOnes = prev.face === 1;
  const nextOnes = next.face === 1;

  if (!prevOnes && !nextOnes) {
    if (next.quantity === prev.quantity && next.face > prev.face) return { valid: true };
    if (next.quantity > prev.quantity) return { valid: true };
    return {
      valid: false,
      reason: bidText(prev) + ' → ' + bidText(next) +
        ' is not higher. Keep the quantity and raise the face, or raise the quantity.',
    };
  }
  if (!prevOnes && nextOnes) {
    const min = getMinimumOnesBid(prev.quantity);
    if (next.quantity >= min) return { valid: true };
    return { valid: false, reason: bidText(prev) + ' → ' + next.quantity + ' × 1 is not a legal raise. Minimum is ' + min + ' × 1.' };
  }
  if (prevOnes && !nextOnes) {
    const min = getMinimumNormalBidFromOnes(prev.quantity);
    if (next.quantity >= min) return { valid: true };
    return { valid: false, reason: bidText(prev) + ' → ' + bidText(next) + ' is not a legal raise. Minimum quantity is ' + min + '.' };
  }
  if (next.quantity > prev.quantity) return { valid: true };
  return { valid: false, reason: bidText(prev) + ' → ' + next.quantity + ' × 1 must raise the quantity.' };
}


/* ---------- counting ---------- */

/**
 * How many dice count toward a bid on `face`.
 * `wildcards` true -> dice showing 1 also count, EXCEPT when the bid is on 1s.
 */
function countMatchingDice(dice, face, wildcards) {
  let n = 0;
  for (const d of dice) {
    if (d === face) n++;
    else if (wildcards && face !== 1 && d === 1) n++;
  }
  return n;
}


/* ---------- Check patterns ---------- */

function handCounts(hand) {
  const c = {};
  for (const d of hand) c[d] = (c[d] || 0) + 1;
  return c;
}

// 'Five of a Kind' | 'All Different' | 'Full House' | null.  1 is a normal value here.
function describeCheck(hand) {
  if (hand.length !== 5) return null;
  const counts = Object.values(handCounts(hand)).sort((a, b) => a - b);
  if (counts.length === 1) return 'Five of a Kind';
  if (counts.length === 5) return 'All Different';
  if (counts.length === 2 && counts[0] === 2 && counts[1] === 3) return 'Full House';
  return null;
}
function isValidCheck(hand) { return describeCheck(hand) !== null; }

// Eligibility to DECLARE Check. It does NOT look at the player's hand (Check may be
// a bluff) and does NOT care what the previous player did — consecutive Checks are
// legal. Whether a Check was truthful is only tested if someone challenges it with
// Dodo (see resolveCheckChallenge), and that challenge always targets the MOST
// RECENT checker via g.checkerIndex, which applyCheck overwrites every time.
function canDeclareCheck(g, player) {
  return g.roundType === 'normal'
    && player.diceCount === MAX_DICE
    && g.currentBid !== null
    && !player.eliminated
    && !player.usedCheck;           // one Check per player per round (reset in startRound)
}


/* ---------- dice ---------- */

function rollDie() { return 1 + Math.floor(Math.random() * 6); }
function rollDice(n) { const a = []; for (let i = 0; i < n; i++) a.push(rollDie()); return a; }
function rollAllPlayers(g) {
  for (const p of g.players) p.dice = p.eliminated ? [] : rollDice(p.diceCount);
}


/* ---------- state helpers ---------- */

function activePlayers(g) { return g.players.filter(p => !p.eliminated); }
function totalDiceInPlay(g) { return activePlayers(g).reduce((s, p) => s + p.diceCount, 0); }
function allActiveDice(g) { return activePlayers(g).flatMap(p => p.dice); }
function nameOf(g, seat) { return g.players[seat].name; }

function nextActiveIndex(g, from) {
  const n = g.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!g.players[idx].eliminated) return idx;
  }
  return from;
}
function firstActiveFromInclusive(g, from) {
  const n = g.players.length;
  for (let step = 0; step < n; step++) {
    const idx = (from + step) % n;
    if (!g.players[idx].eliminated) return idx;
  }
  return from;
}

// Normal round: 1s wild unless the bid is on 1s. Blind round: never wild.
function wildcardsFor(g, face) {
  if (g.roundType === 'blind') return false;
  return face !== 1;
}


/* ---------- round flow ---------- */

function startRound(g) {
  g.roundType = g.pendingBlind ? 'blind' : 'normal';
  g.pendingBlind = false;

  const starter = firstActiveFromInclusive(g, g.nextStarterIndex);
  g.turnIndex = starter;

  rollAllPlayers(g);

  // In a Blind Round the starter always holds exactly one die (that is the
  // trigger); its freshly rolled value is the secret target for the round.
  g.blindTarget = g.roundType === 'blind' ? g.players[starter].dice[0] : null;

  g.currentBid = null;
  g.prevBidderIndex = null;
  g.lastActionWasCheck = false;
  g.checkerIndex = null;
  g.reveal = null;
  g.roundNo = (g.roundNo || 0) + 1;

  // Every player is eligible for their one Check again this round.
  for (const p of g.players) p.usedCheck = false;

  if (g.roundType === 'blind') {
    g.history.push('— Blind Round started —');
    g.history.push(nameOf(g, starter) + ' starts (down to 1 die). Nobody can see their dice.');
  } else {
    g.history.push('— New round — ' + nameOf(g, starter) + ' starts —');
  }
}

function advanceTurn(g) {
  g.turnIndex = nextActiveIndex(g, g.turnIndex);
}

// Caller must have validated the bid with isValidBid() first.
function applyBid(g, seat, bid) {
  const blind = g.roundType === 'blind';
  const opening = g.currentBid === null;

  g.currentBid = blind
    ? { quantity: bid.quantity, face: null }
    : { quantity: bid.quantity, face: bid.face };
  g.prevBidderIndex = seat;
  g.lastActionWasCheck = false;
  g.checkerIndex = null;

  if (blind) {
    g.history.push(nameOf(g, seat) + (opening
      ? ' bid ' + g.currentBid.quantity + ' of the hidden target'
      : ' raised to ' + g.currentBid.quantity));
  } else {
    g.history.push(nameOf(g, seat) + (opening ? ' bid ' : ' raised to ') + bidText(g.currentBid));
  }
  advanceTurn(g);
}

function applyCheck(g, seat) {
  g.lastActionWasCheck = true;
  g.checkerIndex = seat;                 // the LATEST checker — a Dodo challenge targets only this one
  g.players[seat].usedCheck = true;      // spent this round's Check for this player
  g.history.push(nameOf(g, seat) + ' said Check');
  advanceTurn(g);
}


/* ---------- die loss / gain ---------- */

function loseDie(g, seat) {
  const p = g.players[seat];
  const before = p.diceCount;
  p.diceCount = Math.max(0, p.diceCount - 1);
  if (p.diceCount === 0) p.eliminated = true;
  return { before, after: p.diceCount, eliminated: p.eliminated };
}

function gainDie(g, seat) {
  const p = g.players[seat];
  const before = p.diceCount;
  p.diceCount = Math.min(MAX_DICE, p.diceCount + 1);      // never more than 5
  return { before, after: p.diceCount, gained: p.diceCount > before };
}

// A Blind Round is armed when a player drops from >1 die to exactly 1.
function maybeArmBlind(g, res) {
  if (!res.eliminated && res.before > 1 && res.after === 1) g.pendingBlind = true;
}

/**
 * Next-round starter priority:
 *   Rule 4: Believe succeeded -> the player whose bid was believed.
 *   Rule 3: the die-loser was eliminated -> next active player clockwise.
 *   Rule 1/2: otherwise the die-loser starts (Blind flag handled separately).
 */
function determineNextStarter(g, opts) {
  if (opts.believeBidderSeat != null) return firstActiveFromInclusive(g, opts.believeBidderSeat);
  if (g.players[opts.loserSeat].eliminated) return nextActiveIndex(g, opts.loserSeat);
  return opts.loserSeat;
}


/* ---------- resolution: Dodo / Believe / Check challenge ---------- */

function resolveDodo(g, callerSeat) {
  const bid = g.currentBid;
  const bidderSeat = g.prevBidderIndex;
  const blind = g.roundType === 'blind';
  const face = blind ? g.blindTarget : bid.face;
  const wild = wildcardsFor(g, face);

  const actual = countMatchingDice(allActiveDice(g), face, wild);
  const bidWasTrue = actual >= bid.quantity;                     // >= quantity => TRUE
  const loserSeat = bidWasTrue ? callerSeat : bidderSeat;
  const res = loseDie(g, loserSeat);
  maybeArmBlind(g, res);
  g.nextStarterIndex = determineNextStarter(g, { loserSeat });

  g.history.push(nameOf(g, callerSeat) + ' called Dodo');
  if (blind) g.history.push('Hidden target was ' + face);
  g.history.push(nameOf(g, loserSeat) + ' lost one die' + (res.eliminated ? ' — eliminated' : ''));

  g.reveal = {
    kind: 'dodo', blind, face, wild,
    bid: { quantity: bid.quantity, face: bid.face },
    actual, bidWasTrue,
    loserSeat, gainerSeat: null,
  };
}

function resolveBelieve(g, callerSeat) {
  const bid = g.currentBid;
  const bidderSeat = g.prevBidderIndex;
  const blind = g.roundType === 'blind';
  const face = blind ? g.blindTarget : bid.face;
  const wild = wildcardsFor(g, face);

  const actual = countMatchingDice(allActiveDice(g), face, wild);
  const success = actual === bid.quantity;                       // EXACTLY equal

  let loserSeat = null, gainerSeat = null, believeBidderSeat = null;

  g.history.push(nameOf(g, callerSeat) + ' pressed Believe');
  if (blind) g.history.push('Hidden target was ' + face);

  if (success) {
    const gain = gainDie(g, callerSeat);
    gainerSeat = callerSeat;
    believeBidderSeat = bidderSeat;                              // Rule 4
    g.history.push('Believe was exact — ' + nameOf(g, callerSeat) +
      (gain.gained ? ' gained one die' : ' is already at 5 dice'));
  } else {
    const res = loseDie(g, callerSeat);
    loserSeat = callerSeat;
    maybeArmBlind(g, res);
    g.history.push('Believe was wrong — ' + nameOf(g, callerSeat) +
      ' lost one die' + (res.eliminated ? ' — eliminated' : ''));
  }

  g.nextStarterIndex = determineNextStarter(g, {
    loserSeat: loserSeat == null ? callerSeat : loserSeat,
    believeBidderSeat,
  });

  g.reveal = {
    kind: 'believe', blind, face, wild,
    bid: { quantity: bid.quantity, face: bid.face },
    actual, success,
    loserSeat, gainerSeat,
  };
}

function resolveCheckChallenge(g, callerSeat) {
  const checkerSeat = g.checkerIndex;
  const pattern = describeCheck(g.players[checkerSeat].dice);
  const valid = pattern !== null;
  const loserSeat = valid ? callerSeat : checkerSeat;
  const res = loseDie(g, loserSeat);
  maybeArmBlind(g, res);
  g.nextStarterIndex = determineNextStarter(g, { loserSeat });

  g.history.push(nameOf(g, callerSeat) + ' challenged Check with Dodo');
  g.history.push(nameOf(g, checkerSeat) + "'s Check was " + (valid ? 'valid' : 'invalid'));
  g.history.push(nameOf(g, loserSeat) + ' lost one die' + (res.eliminated ? ' — eliminated' : ''));

  g.reveal = {
    kind: 'check', blind: false,
    checkerSeat, checkPattern: pattern, checkValid: valid,
    loserSeat, gainerSeat: null,
  };
}


module.exports = {
  START_DICE, MAX_DICE,
  getMinimumOnesBid, getMinimumNormalBidFromOnes,
  isValidBid, countMatchingDice, describeCheck, isValidCheck, canDeclareCheck,
  activePlayers, totalDiceInPlay,
  startRound, advanceTurn, applyBid, applyCheck,
  resolveDodo, resolveBelieve, resolveCheckChallenge,
  determineNextStarter,
};
