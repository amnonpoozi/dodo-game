'use strict';

/* ============================================================
   6-player "Play vs Bots" rule-integrity test.

   Builds the same game state server.js builds, then plays full
   games where EVERY seat is driven by bot.chooseAction() and each
   move is applied through the SAME engine calls the real server
   uses (see applyBotAction in server.js). It checks that across
   hundreds of 6-player games no DODO rule is ever broken.

   Run:  node server/test-bots.js
   ============================================================ */

const engine = require('./engine');
const bot = require('./bot');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
}

function makeGame(n) {
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      id: 'p' + i, name: 'P' + i, socketId: null, connected: true,
      isBot: true, seat: i, diceCount: engine.START_DICE, dice: [], eliminated: false,
    });
  }
  const g = {
    players, turnIndex: 0, roundType: 'normal', blindTarget: null,
    currentBid: null, prevBidderIndex: null, lastActionWasCheck: false,
    checkerIndex: null, history: [], pendingBlind: false,
    nextStarterIndex: 0, roundNo: 0, reveal: null,
  };
  engine.startRound(g);
  return g;
}

// mirror of server.js applyBotAction + botFallbackMove
function applyAction(state, seat, action) {
  const g = state.g;
  const t = action && action.type;

  if (t === 'check' && engine.canDeclareCheck(g, g.players[seat])) {
    engine.applyCheck(g, seat);
    return;
  }
  if (t === 'dodo' && g.currentBid) {
    if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, seat);
    else engine.resolveDodo(g, seat);
    state.phase = 'reveal';
    return;
  }
  if (t === 'believe' && g.currentBid) {
    engine.resolveBelieve(g, seat);
    state.phase = 'reveal';
    return;
  }

  const blind = g.roundType === 'blind';
  const bid = blind
    ? { quantity: action && action.quantity, face: null }
    : { quantity: action && action.quantity, face: action && action.face };
  const test = engine.isValidBid(g.currentBid, blind ? { quantity: bid.quantity } : bid, g.roundType);
  if (!test.valid) {
    state.fallbacks++;
    if (!g.currentBid) {
      engine.applyBid(g, seat, blind ? { quantity: 1, face: null } : { quantity: 1, face: 2 });
    } else {
      if (g.lastActionWasCheck) engine.resolveCheckChallenge(g, seat);
      else engine.resolveDodo(g, seat);
      state.phase = 'reveal';
    }
    return;
  }
  engine.applyBid(g, seat, bid);
}

function checkInvariants(state, tag) {
  const g = state.g;
  const active = g.players.filter(p => !p.eliminated);
  const totalDice = active.reduce((s, p) => s + p.diceCount, 0);

  for (const p of g.players) {
    assert(p.diceCount >= 0 && p.diceCount <= engine.MAX_DICE,
      tag + ': dice count out of range for ' + p.name + ' = ' + p.diceCount);
    assert(p.eliminated === (p.diceCount === 0),
      tag + ': eliminated flag disagrees with dice count for ' + p.name);
  }
  assert(totalDice === state.expectedDice,
    tag + ': total dice in play = ' + totalDice + ', expected ' + state.expectedDice);

  if (state.phase === 'playing') {
    assert(!g.players[g.turnIndex].eliminated, tag + ': turn landed on an eliminated player');
    if (g.roundType === 'blind') {
      assert(g.blindTarget >= 1 && g.blindTarget <= 6, tag + ': blind target invalid = ' + g.blindTarget);
      assert(!g.currentBid || g.currentBid.face === null, tag + ': blind bid carries a face');
    }
    if (g.currentBid) assert(g.currentBid.quantity >= 1, tag + ': current bid quantity < 1');
  }
}

/* ---- focused unit test: one Check per player per round ---- */
function testCheckOncePerRound() {
  const g = makeGame(3);
  // hand-set a state where two players could legally Check
  g.players.forEach(p => { p.diceCount = engine.START_DICE; p.eliminated = false; p.usedCheck = false; });
  g.players[0].dice = [1, 2, 3, 4, 5];   // All Different
  g.players[1].dice = [6, 6, 6, 2, 2];   // Full House
  g.players[2].dice = [3, 3, 4, 5, 6];   // no pattern
  g.roundType = 'normal';
  g.currentBid = { quantity: 2, face: 3 };
  g.lastActionWasCheck = false;
  g.turnIndex = 0;

  assert(engine.canDeclareCheck(g, g.players[0]) === true, 'check-once: P0 may Check initially');
  assert(engine.canDeclareCheck(g, g.players[1]) === true, 'check-once: P1 may Check initially');

  engine.applyCheck(g, 0);
  assert(g.players[0].usedCheck === true, 'check-once: applyCheck marks usedCheck');

  // right after P0's Check (lastActionWasCheck is still true): P0 is blocked by usedCheck,
  // but a DIFFERENT player is NOT blocked just because the last action was a Check.
  assert(engine.canDeclareCheck(g, g.players[0]) === false, 'check-once: P0 CANNOT Check a second time this round');
  assert(engine.canDeclareCheck(g, g.players[1]) === true, 'check-once: P1 may Check immediately after P0');

  engine.applyCheck(g, 1);
  assert(engine.canDeclareCheck(g, g.players[1]) === false, 'check-once: P1 also cannot Check twice');

  // a new round resets it for everyone
  engine.startRound(g);
  assert(g.players.every(p => p.usedCheck === false), 'check-once: startRound resets usedCheck for all players');
  // and eligibility comes back once the round conditions are met again
  g.players[0].dice = [2, 2, 2, 2, 2];   // Five of a Kind
  g.players[0].diceCount = engine.START_DICE;
  g.roundType = 'normal';
  g.currentBid = { quantity: 1, face: 6 };
  g.lastActionWasCheck = false;
  assert(engine.canDeclareCheck(g, g.players[0]) === true, 'check-once: P0 may Check again in the new round');
}

/* ---- focused unit test: consecutive Checks; a Dodo challenges only the LATEST ---- */
function testConsecutiveCheck() {
  const g = makeGame(4);
  g.players.forEach(p => { p.diceCount = engine.START_DICE; p.eliminated = false; p.usedCheck = false; });
  g.players[0].dice = [1, 2, 3, 4, 5];   // All Different (valid) — earlier, must NOT be evaluated
  g.players[1].dice = [2, 2, 3, 4, 6];   // no pattern (bluff)  — earlier, must NOT be evaluated
  g.players[2].dice = [6, 6, 6, 6, 6];   // Five of a Kind (valid) — this is the LATEST Check
  g.players[3].dice = [1, 1, 2, 2, 3];   // the challenger
  g.roundType = 'normal';
  g.currentBid = { quantity: 2, face: 6 };
  g.lastActionWasCheck = false;
  g.turnIndex = 0;

  assert(engine.canDeclareCheck(g, g.players[0]) === true, 'consec: P0 may Check');
  engine.applyCheck(g, 0);
  assert(engine.canDeclareCheck(g, g.players[1]) === true, 'consec: P1 may Check right after P0');
  engine.applyCheck(g, 1);
  assert(engine.canDeclareCheck(g, g.players[2]) === true, 'consec: P2 may Check right after P1');
  engine.applyCheck(g, 2);

  assert(g.currentBid.quantity === 2 && g.currentBid.face === 6, 'consec: numerical bid unchanged through the Check chain');
  assert(g.checkerIndex === 2, 'consec: checkerIndex tracks the LATEST Check (P2)');

  // P3 Dodos -> challenges ONLY P2's Check. P2 had Five of a Kind (valid) -> P3 loses.
  const before = g.players.map(p => p.diceCount);
  engine.resolveCheckChallenge(g, 3);
  assert(g.reveal.checkerSeat === 2, 'consec: challenge evaluates P2 (latest checker) only');
  assert(g.reveal.checkValid === true, 'consec: P2 (latest) had a valid Check');
  assert(g.reveal.loserSeat === 3, 'consec: the Dodo caller (P3) is the loser');
  assert(g.players[3].diceCount === before[3] - 1, 'consec: P3 loses exactly one die');
  assert(g.players[2].diceCount === before[2], 'consec: P2 (valid latest Check) keeps all dice');
  assert(g.players[1].diceCount === before[1], 'consec: P1 (earlier bluff Check) is untouched — not evaluated');
  assert(g.players[0].diceCount === before[0], 'consec: P0 (earlier Check) is untouched — not evaluated');

  // and the mirror: if the LATEST checker was bluffing, the checker loses (earlier Checks still ignored)
  const g2 = makeGame(4);
  g2.players.forEach(p => { p.diceCount = engine.START_DICE; p.eliminated = false; p.usedCheck = false; });
  g2.players[0].dice = [6, 6, 6, 6, 6];  // valid — earlier, ignored
  g2.players[1].dice = [2, 2, 3, 4, 6];  // NO pattern — this is the LATEST Check (a bluff)
  g2.roundType = 'normal';
  g2.currentBid = { quantity: 2, face: 6 };
  g2.lastActionWasCheck = false;
  g2.turnIndex = 0;
  engine.applyCheck(g2, 0);
  engine.applyCheck(g2, 1);
  const b2 = g2.players.map(p => p.diceCount);
  engine.resolveCheckChallenge(g2, 2);
  assert(g2.reveal.checkerSeat === 1, 'consec: latest checker is P1');
  assert(g2.reveal.checkValid === false, 'consec: P1 (latest) was bluffing');
  assert(g2.players[1].diceCount === b2[1] - 1, 'consec: the bluffing latest checker (P1) loses one die');
  assert(g2.players[0].diceCount === b2[0], 'consec: P0 (earlier valid Check) is untouched');
}

/* ---- focused unit test: Check may be a BLUFF (declaration ignores the hand) ---- */
function testCheckBluff() {
  const g = makeGame(3);
  g.players.forEach(p => { p.diceCount = engine.START_DICE; p.eliminated = false; p.usedCheck = false; });
  g.players[0].dice = [2, 2, 3, 4, 6];   // NOT a valid Check pattern
  g.players[1].dice = [1, 1, 4, 5, 6];   // NOT a valid Check pattern
  g.roundType = 'normal';
  g.currentBid = { quantity: 2, face: 3 };
  g.lastActionWasCheck = false;
  g.turnIndex = 0;

  // eligibility does NOT depend on the hand — bluffing is allowed
  assert(engine.isValidCheck(g.players[0].dice) === false, 'bluff: [2,2,3,4,6] is genuinely NOT a valid Check');
  assert(engine.canDeclareCheck(g, g.players[0]) === true, 'bluff: P0 may still declare Check with a non-pattern hand');
  // a die short -> not eligible (unchanged)
  const p0save = g.players[0].diceCount;
  g.players[0].diceCount = 4;
  assert(engine.canDeclareCheck(g, g.players[0]) === false, 'bluff: 4 dice cannot declare Check');
  g.players[0].diceCount = p0save;

  // P0 bluffs; P1 challenges with Dodo -> the BLUFFER (P0) loses a die
  engine.applyCheck(g, 0);
  const beforeBluff = g.players[0].diceCount;
  engine.resolveCheckChallenge(g, 1);
  assert(g.reveal.checkValid === false, 'bluff: challenge reveal marks the Check invalid');
  assert(g.reveal.loserSeat === 0, 'bluff: the bluffer is the loser');
  assert(g.players[0].diceCount === beforeBluff - 1, 'bluff: challenged bluffer loses exactly one die');

  // a TRUTHFUL Check that is challenged -> the DODO caller loses a die (unchanged)
  const g2 = makeGame(3);
  g2.players.forEach(p => { p.diceCount = engine.START_DICE; p.eliminated = false; p.usedCheck = false; });
  g2.players[0].dice = [2, 2, 5, 5, 5];   // Full House
  g2.roundType = 'normal';
  g2.currentBid = { quantity: 2, face: 3 };
  g2.lastActionWasCheck = false;
  g2.turnIndex = 0;
  engine.applyCheck(g2, 0);
  const beforeTrue = g2.players[1].diceCount;
  engine.resolveCheckChallenge(g2, 1);
  assert(g2.reveal.checkValid === true, 'truthful check: challenge reveal marks the Check valid');
  assert(g2.reveal.loserSeat === 1, 'truthful check: the Dodo caller is the loser');
  assert(g2.players[1].diceCount === beforeTrue - 1, 'truthful check: Dodo caller loses exactly one die');
}

/* ---- focused unit test: Believe half-dice rule + Blind Round wildcard exception ---- */
function testBelieveAndBlindWildcards() {
  // --- Change 1: Believe only while >= half the STARTING dice remain (exactly half OK) ---
  const g2 = makeGame(2);                       // initialTotalDice = 10, half = 5
  assert(g2.initialTotalDice === 10, 'believe-threshold: initialTotalDice captured (2p => 10)');
  g2.roundType = 'normal';
  g2.players[0].diceCount = 3; g2.players[1].diceCount = 2;   // 5 remain
  assert(engine.canBelieveNow(g2) === true, 'believe-threshold: 5/10 remaining => Believe allowed (exactly half)');
  g2.players[0].diceCount = 2; g2.players[1].diceCount = 2;   // 4 remain
  assert(engine.canBelieveNow(g2) === false, 'believe-threshold: 4/10 remaining => Believe NOT allowed');

  const g3 = makeGame(3);                       // initialTotalDice = 15, half = 7.5
  g3.roundType = 'normal';
  g3.players[0].diceCount = 3; g3.players[1].diceCount = 3; g3.players[2].diceCount = 2; // 8
  assert(engine.canBelieveNow(g3) === true, 'believe-threshold: 8/15 remaining => Believe allowed');
  g3.players[0].diceCount = 3; g3.players[1].diceCount = 2; g3.players[2].diceCount = 2; // 7
  assert(engine.canBelieveNow(g3) === false, 'believe-threshold: 7/15 remaining => Believe NOT allowed');

  // --- Change 2: never during a Blind Round, regardless of dice count ---
  g3.players[0].diceCount = 5; g3.players[1].diceCount = 5; g3.players[2].diceCount = 5; // 15, full
  g3.roundType = 'blind';
  assert(engine.canBelieveNow(g3) === false, 'believe-blind: Believe is unavailable during a Blind Round even at full dice');

  // --- Change 3: Blind Round wildcard exception ---
  // Case A — NOT everyone on one die: 1s are NOT wild.
  const a = makeGame(2);
  a.roundType = 'blind';
  a.players[0].diceCount = 1; a.players[1].diceCount = 2;
  assert(engine.wildcardsFor(a, 5) === false, 'blind-wild A: mixed dice counts => 1s not wild');
  assert(engine.countMatchingDice([5, 1, 5], 5, engine.wildcardsFor(a, 5)) === 2,
    'blind-wild A: target 5 over [5],[1,5] counts 2 (the 1 does NOT count)');

  // Case B — EVERY active player on exactly one die: 1s ARE wild for a non-1 target.
  const b = makeGame(2);
  b.roundType = 'blind';
  b.players[0].diceCount = 1; b.players[1].diceCount = 1;
  assert(engine.wildcardsFor(b, 5) === true, 'blind-wild B: everyone on one die => 1s wild for target 5');
  assert(engine.countMatchingDice([5, 1], 5, engine.wildcardsFor(b, 5)) === 2,
    'blind-wild B: target 5 over [5],[1] counts 2 (the 1 IS wild)');

  // Case C — everyone on one die but the hidden target IS 1: only actual 1s count.
  const c = makeGame(2);
  c.roundType = 'blind';
  c.players[0].diceCount = 1; c.players[1].diceCount = 1;
  assert(engine.wildcardsFor(c, 1) === false, 'blind-wild C: target 1 => never "wild" (only actual 1s)');
  assert(engine.countMatchingDice([1, 5], 1, engine.wildcardsFor(c, 1)) === 1,
    'blind-wild C: target 1 over [1],[5] counts 1 (no double-count)');
}

function playGame(seedInfo, stats) {
  const state = {
    g: makeGame(6),
    phase: 'playing',
    expectedDice: 6 * engine.START_DICE,
    fallbacks: 0,
  };
  stats.games++;

  // per-round Check counters: no seat may exceed 1
  let roundChecks = Object.create(null);

  let steps = 0;
  while (steps < 8000) {
    steps++;
    const g = state.g;

    if (state.phase === 'playing') {
      const seat = g.turnIndex;
      const before = g.players.filter(p => !p.eliminated).reduce((s, p) => s + p.diceCount, 0);
      const hadBid = !!g.currentBid;
      const wasBlind = g.roundType === 'blind';

      const action = bot.chooseAction(g, seat);
      assert(action && typeof action.type === 'string', 'bot returned no action');
      if (action.type === 'bid') {
        assert(Number.isInteger(action.quantity) && action.quantity >= 1,
          'bot bid quantity not a positive integer: ' + JSON.stringify(action));
        if (!wasBlind) {
          assert(Number.isInteger(action.face) && action.face >= 1 && action.face <= 6,
            'bot bid face out of range: ' + JSON.stringify(action));
        }
      }
      if (action.type === 'check') {
        stats.checks++;
        if (!engine.isValidCheck(g.players[seat].dice)) stats.bluffChecks++;
        if (g.lastActionWasCheck) stats.consecChecks++;   // a Check right after another Check
      }
      if (action.type === 'dodo') stats.dodos++;
      if (action.type === 'believe') stats.believes++;

      const checkTaken = action.type === 'check' && engine.canDeclareCheck(g, g.players[seat]);
      // a Dodo challenge always targets the LATEST checker
      if (action.type === 'dodo' && g.lastActionWasCheck) {
        assert(g.checkerIndex != null, 'dodo-on-check: g.checkerIndex is set (latest checker)');
      }
      applyAction(state, seat, action);
      if (checkTaken) {
        roundChecks[seat] = (roundChecks[seat] || 0) + 1;
        assert(roundChecks[seat] <= 1, 'r' + g.roundNo + ': seat ' + seat + ' declared Check ' + roundChecks[seat] + ' times in one round');
      }

      if (state.phase === 'reveal') {
        // exactly one die left play, unless a Believe was exact (then +1, capped at 5)
        const after = g.players.filter(p => !p.eliminated).reduce((s, p) => s + p.diceCount, 0);
        assert(after === before - 1 || after === before + 1 || after === before,
          'round resolution changed total dice by more than 1 (' + before + ' -> ' + after + ')');
        state.expectedDice = after;
      }
      checkInvariants(state, 'r' + g.roundNo);
      continue;
    }

    if (state.phase === 'reveal') {
      if (g.roundType === 'blind') stats.blindRounds++;
      const alive = engine.activePlayers(g);
      if (alive.length <= 1) {
        state.phase = 'gameover';
        stats.winners += alive.length;
        assert(alive.length === 1, 'game ended with ' + alive.length + ' survivors');
        break;
      }
      engine.startRound(g);
      roundChecks = Object.create(null);        // every player is eligible again
      state.phase = 'playing';
      checkInvariants(state, 'start r' + g.roundNo);
      continue;
    }

    break;
  }

  assert(state.phase === 'gameover', 'game did not finish within the step budget');
  stats.steps += steps;
  stats.fallbacks += state.fallbacks;
  stats.rounds += state.g.roundNo;
}

const stats = {
  games: 0, steps: 0, rounds: 0, blindRounds: 0,
  checks: 0, bluffChecks: 0, consecChecks: 0, dodos: 0, believes: 0, fallbacks: 0, winners: 0,
};

testCheckOncePerRound();
console.log(failures ? '  check-once unit test: FAILED' : '  check-once unit test: ok');
const bluffFailBefore = failures;
testCheckBluff();
console.log(failures > bluffFailBefore ? '  check-bluff unit test: FAILED' : '  check-bluff unit test: ok');
const consecFailBefore = failures;
testConsecutiveCheck();
console.log(failures > consecFailBefore ? '  consecutive-check unit test: FAILED' : '  consecutive-check unit test: ok');
const believeFailBefore = failures;
testBelieveAndBlindWildcards();
console.log(failures > believeFailBefore ? '  believe-threshold / blind-wildcard unit test: FAILED' : '  believe-threshold / blind-wildcard unit test: ok');

const N = Number(process.argv[2]) || 300;
console.log('Playing ' + N + ' six-player all-bot games…\n');
for (let i = 0; i < N; i++) playGame(i, stats);

console.log('  games                 ' + stats.games);
console.log('  winners (want ' + stats.games + ')     ' + stats.winners);
console.log('  total rounds          ' + stats.rounds);
console.log('  blind rounds          ' + stats.blindRounds);
console.log('  total steps           ' + stats.steps);
console.log('  Dodo / Believe / Check ' + stats.dodos + ' / ' + stats.believes + ' / ' + stats.checks
  + '  (' + stats.bluffChecks + ' bluffs, ' + stats.consecChecks + ' right after another Check)');
console.log('  bot fallback moves    ' + stats.fallbacks + '  (illegal proposals caught: '
  + (100 * stats.fallbacks / Math.max(1, stats.steps)).toFixed(2) + '% of steps)');
console.log('');

if (failures) {
  console.error('FAILED — ' + failures + ' rule violation(s).');
  process.exit(1);
}
console.log('PASSED — no rule violations across ' + stats.games + ' six-player bot games.');
