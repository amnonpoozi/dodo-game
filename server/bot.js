'use strict';

/* ============================================================
   DODO — bot opponent for "Play vs Bots" mode.

   A bot is picked a move by chooseAction(g, seat). It returns one
   of:
     { type: 'bid', quantity, face }   (face omitted in a Blind Round)
     { type: 'dodo' }
     { type: 'believe' }
     { type: 'check' }

   IMPORTANT — the bot NEVER changes the rules and NEVER cheats:
     - it only ever looks at its OWN dice (g.players[seat].dice) and
       the public dice COUNTS of the other players;
     - it never reads another player's dice;
     - it never reads g.blindTarget (the hidden target) — in a Blind
       Round it plays purely on probability, like a human would.
   Every move it proposes is checked against engine.isValidBid /
   engine.canDeclareCheck before it is played; if somehow nothing is
   legal it falls back to a guaranteed-legal move.
   ============================================================ */

const engine = require('./engine');

function rnd() { return Math.random(); }

// Total dice the bot cannot see = every other living player's dice count.
function unknownDiceCount(g, seat) {
  let n = 0;
  for (const p of g.players) {
    if (!p.eliminated && p.seat !== seat) n += p.diceCount;
  }
  return n;
}

// How many of the bot's own dice count toward `face`
// (1s are wild for a non-1 face in a normal round).
function countOwn(dice, face, wild) {
  let n = 0;
  for (const d of dice) {
    if (d === face) n++;
    else if (wild && face !== 1 && d === 1) n++;
  }
  return n;
}

// The bot's strongest normal face (2..6), and how many it holds (wild 1s included).
function bestFace(dice) {
  let face = 2, count = -1;
  for (let f = 2; f <= 6; f++) {
    const c = countOwn(dice, f, true);
    if (c > count) { count = c; face = f; }
  }
  return { face, count };
}

/* ---------------- normal round ---------------- */

function openingBid(dice, unknown) {
  const { face, count } = bestFace(dice);
  const pMatch = 2 / 6;                                  // wildcard 1s help a non-1 face
  // Start modestly: what we hold, plus a conservative slice of the unknown dice.
  const est = count + Math.round(unknown * pMatch * 0.8);
  const cap = count + Math.ceil(unknown / 3);
  const quantity = Math.max(1, Math.min(est, cap));
  return { type: 'bid', quantity, face };
}

function raiseBid(bid, dice, unknown) {
  const { face: myFace, count: myCount } = bestFace(dice);
  const est = Math.max(1, Math.round(myCount + unknown * (2 / 6)));

  const candidates = [];
  if (bid.face !== 1 && bid.face < 6) candidates.push({ quantity: bid.quantity, face: bid.face + 1 });
  candidates.push({ quantity: bid.quantity + 1, face: 2 });
  candidates.push({ quantity: bid.quantity + 1, face: myFace });
  candidates.push({ quantity: Math.max(bid.quantity, est), face: myFace });
  candidates.push({ quantity: bid.quantity * 2, face: myFace });        // legal way back out of a 1s bid
  candidates.push({ quantity: Math.floor(bid.quantity / 2) + 1, face: 1 }); // switch onto 1s
  candidates.push({ quantity: bid.quantity + 1, face: 1 });               // raise a 1s bid

  const legal = candidates.filter(c => engine.isValidBid(bid, c, 'normal').valid);
  if (!legal.length) return { type: 'dodo' };            // cannot raise -> challenge instead

  // cheapest raise first (quantity dominates, then face)
  legal.sort((a, b) => (a.quantity * 7 + a.face) - (b.quantity * 7 + b.face));
  const pick = legal[rnd() < 0.7 ? 0 : Math.min(legal.length - 1, 1)];
  return { type: 'bid', quantity: pick.quantity, face: pick.face };
}

function chooseNormal(g, seat) {
  const me = g.players[seat];
  const dice = me.dice.slice();
  const unknown = unknownDiceCount(g, seat);
  const bid = g.currentBid;

  // A valid Check (5 dice forming a pattern) is a strong, safe play.
  if (engine.canDeclareCheck(g, me) && rnd() < 0.7) return { type: 'check' };

  if (!bid) return openingBid(dice, unknown);

  const face = bid.face;
  const wild = face !== 1;
  const mine = countOwn(dice, face, wild);
  const pMatch = face === 1 ? 1 / 6 : 2 / 6;
  const expected = mine + unknown * pMatch;
  const gap = bid.quantity - expected;                   // how far the bid overreaches

  // Believe means EXACTLY right — only when the bid sits on the expectation and is small.
  if (Math.abs(gap) < 0.6 && bid.quantity <= Math.max(2, Math.ceil(unknown / 3)) && rnd() < 0.15) {
    return { type: 'believe' };
  }

  let pDodo = 0;
  if (gap >= 2.5) pDodo = 0.92;
  else if (gap >= 1.5) pDodo = 0.7;
  else if (gap >= 0.8) pDodo = 0.4;
  else if (gap >= 0.2) pDodo = 0.15;
  if (bid.quantity <= 1) pDodo = 0;                      // a bid of 1 is almost never a lie
  if (rnd() < pDodo) return { type: 'dodo' };

  return raiseBid(bid, dice, unknown);
}

/* ---------------- blind round (no dice visible to anyone) ---------------- */

function chooseBlind(g, seat) {
  const bid = g.currentBid;
  const alive = g.players.filter(p => !p.eliminated);
  const totalDice = alive.reduce((s, p) => s + p.diceCount, 0);
  const expected = totalDice / 6;                        // each die: 1/6 chance to be the target

  if (!bid) {
    return { type: 'bid', quantity: Math.max(1, Math.round(expected * 0.9)) };
  }

  const gap = bid.quantity - expected;
  let pDodo = 0;
  if (gap >= 2) pDodo = 0.9;
  else if (gap >= 1.2) pDodo = 0.6;
  else if (gap >= 0.5) pDodo = 0.3;
  if (bid.quantity <= 1) pDodo = 0;
  if (rnd() < pDodo) return { type: 'dodo' };

  if (Math.abs(gap) < 0.5 && rnd() < 0.1) return { type: 'believe' };

  return { type: 'bid', quantity: bid.quantity + 1 };
}

/* ---------------- entry point ---------------- */

function chooseAction(g, seat) {
  return g.roundType === 'blind' ? chooseBlind(g, seat) : chooseNormal(g, seat);
}

module.exports = { chooseAction };
