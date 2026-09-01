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

function playGame(seedInfo, stats) {
  const state = {
    g: makeGame(6),
    phase: 'playing',
    expectedDice: 6 * engine.START_DICE,
    fallbacks: 0,
  };
  stats.games++;

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
      if (action.type === 'check') stats.checks++;
      if (action.type === 'dodo') stats.dodos++;
      if (action.type === 'believe') stats.believes++;

      applyAction(state, seat, action);

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
  checks: 0, dodos: 0, believes: 0, fallbacks: 0, winners: 0,
};

const N = Number(process.argv[2]) || 300;
console.log('Playing ' + N + ' six-player all-bot games…\n');
for (let i = 0; i < N; i++) playGame(i, stats);

console.log('  games                 ' + stats.games);
console.log('  winners (want ' + stats.games + ')     ' + stats.winners);
console.log('  total rounds          ' + stats.rounds);
console.log('  blind rounds          ' + stats.blindRounds);
console.log('  total steps           ' + stats.steps);
console.log('  Dodo / Believe / Check ' + stats.dodos + ' / ' + stats.believes + ' / ' + stats.checks);
console.log('  bot fallback moves    ' + stats.fallbacks + '  (illegal proposals caught: '
  + (100 * stats.fallbacks / Math.max(1, stats.steps)).toFixed(2) + '% of steps)');
console.log('');

if (failures) {
  console.error('FAILED — ' + failures + ' rule violation(s).');
  process.exit(1);
}
console.log('PASSED — no rule violations across ' + stats.games + ' six-player bot games.');
