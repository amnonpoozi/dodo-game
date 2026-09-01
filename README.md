# DODO — Online Multiplayer

A real-time online multiplayer dice game of bluffing and nerve — a pirate-tavern take on
Perudo / Liar's Dice, with a custom rule set (wildcard 1s, **Believe**, **Check** special
hands, and a **Blind Round**).

**Check may be a bluff, and Checks may be consecutive.** You may *declare* Check whenever
it is your turn, you hold exactly 5 dice, there is an active bid, and you have not already
used your Check this round (once per player per round, reset each round). Your hand is
**not** inspected — you can declare Check with a worthless hand — and it does **not** matter
what the previous player did, so `P1 CHECK → P2 CHECK → P3 CHECK` is legal (each still holds
5 dice and hasn't used their Check). Consecutive Checks never touch the numerical bid.
A declaration's truth is only tested if the next player challenges it with **Dodo**, and a
Dodo challenges only the **most recent** Check (`engine` tracks the latest checker in
`g.checkerIndex`): that player's dice are revealed — a real Five of a Kind / All Different /
Full House means the challenger loses a die, otherwise the (bluffing) checker does; earlier
Checks in the chain are never evaluated. All of this is enforced on the authoritative server
(`engine.canDeclareCheck`, which never looks at the dice and no longer blocks a Check that
follows another Check, + the `declareCheck` handler); a client still cannot send a second
Check in the same round.

**Every bid is shown as `[quantity] × [visual die face]`** — the number is HOW MANY, the
pipped die is WHAT value is bid (a real die, not a number). Same order everywhere: the
Current Bid panel, the special-action displays, and the round result. In a Blind Round the
die is a hidden `?` and the secret target is never shown until the round is resolved.
The bid's mathematical meaning is unchanged.

**Special actions take over the centre panel.** When a player calls **Dodo** / **Believe**,
or declares **Check**, the centre of the table shows the action name (large), the exact bid
it was made on, and who did it — held on screen through the cup-lift and dice reveal, then
replaced by the result. A **Dodo that challenges a Check** shows `DODO ON CHECK` and names
who is challenging whose Check. It is all driven by server-confirmed state, so every
connected player sees the same thing.

The **game design and every custom DODO rule are unchanged** from the local version.
What changed: the game now runs on an **authoritative Node server**, players join **rooms**
over the network, and turns happen in **real time**.

**Table size: 2 to 6 total players.** Two ways to play:

- **Play vs Bots** — one human (you are Player 1) plus 2–6 total seats filled with
  server-driven bot opponents. Starts instantly, no room code.
- **Online Multiplayer** — a room of 2 to 6 human players. The lobby shows the live count
  (`Players: 4 / 6`); a 7th player is turned away.

- **Server:** Node.js + Express + Socket.IO
- **Client:** vanilla HTML / CSS / JavaScript (no framework, no build step)
- The Express server also serves the frontend, so the whole thing deploys as **one app**.

---

## Run it locally

You need **Node.js 18 or newer**.

```bash
# from the project folder
npm install
npm start
```

Then open **http://localhost:3000** in a browser.

To play a real multiplayer game on one machine, open several browser tabs/windows
(or use other devices on your network pointing at `http://<your-lan-ip>:3000`).

- `npm start` – run the server
- `npm run dev` – run with `node --watch` (auto-restart on file changes)
- `PORT=8080 npm start` – run on a different port

### From VS Code

1. `File → Open Folder…` → the `dodo game` folder.
2. Open the integrated terminal (`` Ctrl+` ``).
3. `npm install` then `npm start`.
4. Open `http://localhost:3000`. Click the port in the "Ports" panel to forward it if you're
   on a remote/dev container.

---

## How to play online

1. **Create Room** – enter a name, press *Create Room*. You are the **host**.
2. Share the **4-letter room code** with up to 5 friends.
3. Each friend enters their name + the code and presses **Join** (2–6 players total; the
   lobby shows `Players: N / 6` and the room refuses a 7th).
4. The **host** presses **Start Game**.
5. Play proceeds clockwise in real time. On your turn the controls light up; everyone else
   sees *"… is deciding…"*.
6. When a round is resolved by **Dodo** or **Believe**, all hands are revealed to everyone,
   then anyone can press **Start Next Round**.
7. Last player with dice wins. The host can press **Play Again** to return everyone to the
   waiting room with the same crew.

### Reconnection

Your identity is stored in the browser (`localStorage`). If you refresh, lose Wi-Fi, or close
the tab, just reopen `http://localhost:3000` — you rejoin your seat automatically with your
dice intact. A red banner shows while you're disconnected. If a disconnected player stalls
their own turn, the server auto-plays a safe move for them after 45 seconds so the game
keeps going.

---

## Files

```
package.json          npm scripts + dependencies (express, socket.io)

server/
  server.js           Express + Socket.IO wiring, rooms, per-player state redaction,
                       every socket action handler, the "away player" auto-move timer,
                       the "Play vs Bots" scheduler (drives bot seats through the SAME
                       engine calls a human action uses), the /cups/:file route that
                       serves the six player-cup PNGs from the project root, and the
                       reveal-hold timestamp that keeps every client's round-reveal
                       animation in step (see "Round-reveal animation" below)
  engine.js           the AUTHORITATIVE DODO rule engine — the same custom rules as the
                       local game, ported unchanged: bid validation, wildcard counting,
                       Check patterns, Dodo/Believe/Check resolution, Blind Rounds,
                       die loss/gain, next-starter priority
  bot.js              bot opponent decision-making — picks bid / Dodo / Believe / Check
                       from ONLY its own dice + public dice counts (never peeks at other
                       hands or the Blind target); every move is engine-validated
  rooms.js            in-memory room registry (2–6 seats), room-code generator, player
                       factory, idle-room cleanup
  test-bots.js        300 six-player all-bot games — asserts no rule is ever broken
  test-e2e.js         real server + real sockets: 6-player online (7th refused) and
                       6-player bot mode, each played to a winner

public/               served as static files by Express
  index.html          lobby + waiting room + game table markup
  style.css           the full pirate dice-table theme (wooden rail, green felt, image
                       cups, round-reveal banner, win/lose glow) + lobby / connection styling
  client.js           a THIN client: renders whatever state the server sends, sends the
                       player's chosen action, shows server error messages. It never
                       computes rules, rolls dice, or decides turns — it only PLAYS BACK
                       the server's confirmed result through a small animation-state
                       machine (see below).

red.png, blue.png, green.png, yellow.png, purple.png, orange.png
                       the six player-cup images, in the project root. Seats 1-6 are
                       assigned these colours in order and keep them for the whole game.
                       Served at /cups/<name>.png (see server.js).
```


## Round-reveal animation

When a round is resolved (Dodo, Believe, or a Check challenge), the client walks through
a fixed client-side animation state machine — `playing → liftingCups → showingDice →
showingResult → animatingDiceChange → resettingRound → startingNextRound → playing` — all
driven off the ONE `reveal` payload the server already sent (see `buildView` in
`server.js`). No client computes or guesses the result; it only plays back what the
server confirmed, on a fixed timeline, so every client's table looks the same:

1. Controls disable and every involved cup lifts (stays visible, raised — never removed).
2. Every die is shown for ~3s with **no winner/loser yet**, so players can look first.
3. The result appears: reason text ("Dodo was correct", "Believe was exact", …), the
   winner's seat glows **green**, the loser's glows **red**.
4. The die that's lost slides/fades away (or a new one slides in for a successful
   Believe) and only THEN does the dice count on the seat change.
5. Once everyone agrees to continue, the server deals the next round; cups lower back
   over the new (hidden) dice, then the human's cup lifts again — unless it's a Blind
   Round, when every cup, including the human's, stays shut and the hidden target stays
   hidden until the next reveal.

A Check reveal only lifts the checker's and (if different) the loser's cup, since only
those hands are relevant. The server enforces a minimum reveal time (`REVEAL_MIN_MS`,
default 3s) before it will accept "next round", so no client can rush the others past
the "look at the dice" window — this is a pacing guard only; it never changes who wins.

---

## Server is authoritative — what that means here

All secret state lives on the server. The client is never trusted.

The **server** alone:

- rolls every die and stores every player's hand
- validates every **bid** (`isValidBid`), **Dodo**, **Believe**, and **Check**
- verifies each action came from the socket whose turn it actually is
- decides who loses or gains a die, and who starts the next round
- runs **Blind Rounds** and holds the secret target face
- ends the game and names the winner

**What a client receives** (`buildView` in `server.js` is the only place state crosses the wire):

| Situation | Your own dice | Other players' dice | Blind target |
|---|---|---|---|
| Lobby / waiting room | — | — | — |
| Normal round, in play | **sent to you only** | never (just a die *count*) | n/a |
| Blind round, in play | **not sent to anyone** | never | never |
| Reveal (after Dodo / Believe) | shown | shown to everyone | shown to everyone |
| Game over | — | — | — |

A client physically cannot receive another player's hidden dice, and during a Blind Round no
client receives any dice until the round is revealed. Illegal or out-of-turn actions from a
browser are rejected with an error message and never change the game state.

---

## Deployment

It is a single application: `npm start` serves both the API (Socket.IO) and the frontend on
one port. Any Node host works (Render, Railway, Fly.io, a VPS, etc.):

- **Build command:** `npm ci`  ·  **Start command:** `npm start`  ·  **Health check:** `/health`
- the server binds `0.0.0.0` on `process.env.PORT` (never a fixed host or port) and sets
  `trust proxy`, so it runs unchanged behind a platform's HTTPS reverse proxy
- the browser connects Socket.IO to its **own origin** (`io()` with no URL) and loads every
  asset by relative path, so it works on any `https://…` domain with no config
- no database, no build step, no external services, no CORS setup (frontend + backend are
  the same origin)

**Render:** the repo ships a `render.yaml` blueprint (`New + → Blueprint`), or configure a
Web Service by hand with the build/start/health values above. `PORT` is injected
automatically; `.node-version` pins Node 20.

---

## Rule tests

`server/engine.js` was verified with the same checks the local version passed, run against
the ported code:

- **19 rule assertions** including all the required scenarios: `3×4 → 3×5` legal,
  `3×6 → 4×2` legal, `3×4 → 2×1` legal, `6×5 → 3×1` **illegal** (min `4×1`, exact message),
  `6×5 → 4×1` legal, `3×1 → 6×4` legal; Five of a Kind / All Different / Full House valid,
  `2 2 3 4 5` invalid; Believe exact vs overcount; Blind-round target `4` with dice `4,4,1`
  counts **2** (1s not wild).
- a **200-game auto-play simulation** (mixed 2/3/4 players, ~14k steps, thousands of
  blind-round steps, hundreds of Checks and Believes) with **no rule violations** — dice
  counts stay in 0–5, elimination stays consistent, the Blind target is always valid, and
  no turn ever lands on an eliminated player.

Run `npm test` for the current suite:

- **`server/test-bots.js`** — focused unit tests for **one-Check-per-player-per-round** (a
  player who Checked cannot Check again until `startRound` resets the flag; a different
  player still may, *immediately* after another Check), **Check-as-a-bluff** (a non-pattern
  hand can still declare Check; a challenged bluffer loses a die; a challenged truthful
  Check makes the Dodo caller lose), and **consecutive Checks** (`P0/P1/P2` Check in a row;
  a `P3` Dodo evaluates only `P2`'s hand — `P0` and `P1` are untouched — and the numerical
  bid is unchanged through the chain). Then 300 **six-player** all-bot games (~43k steps,
  ~1.7k blind rounds, thousands of Dodos / Believes / Checks — many Checks are bluffs and
  some follow another Check). Same invariants as above hold, no seat ever Checks twice in
  one round, and the bot never proposes an illegal move.
- **`server/test-e2e.js`** — boots the real server and drives real Socket.IO clients:
  6 humans fill a room and a **7th is refused** (`Room is full (6 players).`); then a
  full game is played to a single winner. Repeats for **Play vs Bots** with 6 seats
  (auto-start, strangers can't join, played to a winner). Also asserts, on every state
  a client receives: no other player's dice or the Blind target ever arrive before the
  official reveal; the `reveal` payload always carries every hand plus who called and
  who bid/checked; a "next round" sent before the reveal-hold window closes is ignored
  while one sent after it goes through; after a human legitimately Checks once, a
  **second Check in the same round is rejected by the server** (`You have already used
  your Check this round.`) and never registers; and the server **accepts a Check declared
  immediately after another player's Check** (keeping `canCheck: true` for an eligible
  player) while the numerical bid stays put through the chain.
