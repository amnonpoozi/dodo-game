'use strict';

/* ============================================================
   Room registry + player factory.
   A room holds the authoritative game state; nothing here is
   ever sent to a client directly (server.js redacts it first).
   ============================================================ */

const rooms = new Map();                 // CODE -> room

// No I / O / 0 / 1 so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

// Total seats a table can hold (humans + bots), for every mode.
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makePlayer(id, name, socketId, isBot) {
  return {
    id,                // stable id kept in the browser's localStorage (reconnection key)
    name,
    socketId,          // current live socket, or null while disconnected / for a bot
    connected: true,
    isBot: !!isBot,    // a server-driven opponent in "Play vs Bots" mode
    seat: 0,           // index in room.players; also the engine's player index
    diceCount: 5,
    dice: [],          // SECRET — never leaves the server except in a reveal payload
    eliminated: false,
  };
}

function create(hostPlayer, opts) {
  const code = genCode();
  const room = {
    code,
    hostId: hostPlayer.id,
    phase: 'lobby',    // 'lobby' | 'playing' | 'reveal' | 'gameover'
    solo: !!(opts && opts.solo),   // "Play vs Bots": one human + server-driven bots, no joining
    players: [hostPlayer],
    game: null,        // engine state once the game starts
    emptySince: null,
    autoTimer: null,   // "player is away" auto-move timer
    botTimer: null,    // pending scheduled bot move (solo rooms only)
  };
  rooms.set(code, room);
  return room;
}

function get(code) {
  if (!code) return undefined;
  return rooms.get(String(code).toUpperCase().trim());
}

function destroy(room) {
  if (!room) return;
  if (room.autoTimer) clearTimeout(room.autoTimer);
  if (room.botTimer) clearTimeout(room.botTimer);
  rooms.delete(room.code);
}

// A room is "alive" only while at least one real person is connected — bots,
// which are always flagged connected, do not keep an abandoned room open.
function anyHumanConnected(room) {
  return room.players.some(p => p.connected && !p.isBot);
}

function markEmpty(room) { room.emptySince = Date.now(); }
function count() { return rooms.size; }

// Drop rooms that have had nobody connected for over 20 minutes.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (anyHumanConnected(room)) { room.emptySince = null; continue; }
    if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > 20 * 60 * 1000) destroy(room);
  }
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

module.exports = {
  rooms, MIN_PLAYERS, MAX_PLAYERS,
  genCode, makePlayer, create, get, destroy, markEmpty, count, anyHumanConnected,
};
