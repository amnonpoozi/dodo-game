# DODO — Online Multiplayer

A real-time online multiplayer dice game of bluffing and nerve — a pirate-tavern take on
Perudo / Liar's Dice, with a custom rule set (wildcard 1s, **Believe**, **Check** special
hands, and a **Blind Round**).

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
                       and the "Play vs Bots" scheduler (drives bot seats through the
                       SAME engine calls a human action uses)
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
  style.css           the full pirate dice-table theme (wooden rail, green felt, dice
                       cups, animations) + lobby / connection styling
  client.js           a THIN client: renders whatever state the server sends, sends the
                       player's chosen action, shows server error messages. It never
                       computes rules, rolls dice, or decides turns.
```

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

- set the start command to `npm start`
- the server honours the `PORT` environment variable
- no database, no build step, no external services

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

- **`server/test-bots.js`** — 300 **six-player** all-bot games (~43k steps, ~1.7k blind
  rounds, thousands of Dodos / Believes / Checks). Same invariants as above hold, and the
  bot never once proposes an illegal move.
- **`server/test-e2e.js`** — boots the real server and drives real Socket.IO clients:
  6 humans fill a room and a **7th is refused** (`Room is full (6 players).`); then a
  full game is played to a single winner. Repeats for **Play vs Bots** with 6 seats
  (auto-start, strangers can't join, played to a winner).
