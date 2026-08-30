/* ==========================================================================
   DuoPlay Server
   Express + Socket.IO + chess.js

   Responsibilities:
   - Assign / reuse permanent player IDs (DP-xxxxxx), independent of socket ID
   - Broadcast the full list of online players in real time
   - Route chess challenges between two specific players
   - Create and referee real chess games (server is the authority)
   - Handle disconnect / reconnect for both lobby presence and active games

   Socket.IO event contract (identical names used by every client file):
     register-player      (client -> server)  { playerId | null }
     player-registered     (server -> client)  { playerId }
     active-game-found     (server -> client)  { gameId, playerId, opponentId, color }
     players-online         (server -> all)     [ { id, inGame }, ... ]

     challenge-player       (client -> server)  { targetId }
     cancel-challenge       (client -> server)  { targetId }
     chess-challenge         (server -> target)  { fromId }
     accept-challenge        (client -> server)  { fromId }
     reject-challenge        (client -> server)  { fromId }
     challenge-declined      (server -> challenger) { byId }
     chess-game-error        (server -> client)  { message }

     chess-game-start         (server -> both)    { gameId, playerId, opponentId, color }
     join-chess-game          (client -> server)  { gameId, playerId }
     chess-game-joined        (server -> client)  { gameId, color, whiteId, blackId, opponentId, fen, turn, status, lastMove, opponentConnected }

     chess-move               (client -> server)  { gameId, from, to, promotion }
     opponent-move             (server -> other)   { from, to, promotion, fen }
     chess-turn                 (server -> both)    { turnPlayerId }
     chess-move-error           (server -> client)  { message, fen }

     opponent-disconnected      (server -> other)   {}
     opponent-reconnected       (server -> other)   {}
     chess-game-finished        (server -> both)    { result, winnerId, reason }
   ========================================================================== */

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = 2 * 60 * 1000; // 2 minutes to reconnect before a game is abandoned

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/* --------------------------- In-memory state ---------------------------- */

// playerId -> { id, socketId, connected, activeGameId, disconnectTimer }
const players = new Map();

// socketId -> playerId
const socketToPlayer = new Map();

// targetPlayerId -> { fromId }   (one incoming challenge at a time per target)
const pendingChallenges = new Map();

// gameId -> {
//   id, white, black, whiteSocketId, blackSocketId,
//   chess (Chess instance), status: 'active' | 'finished', lastMove
// }
const games = new Map();

/* ------------------------------ Utilities -------------------------------- */

function generatePlayerId() {
  let id;
  do {
    const num = Math.floor(100000 + Math.random() * 900000);
    id = `DP-${num}`;
  } while (players.has(id));
  return id;
}

function generateGameId() {
  let id;
  do {
    const rand = Math.random().toString(16).slice(2, 10);
    id = `chess-${rand}`;
  } while (games.has(id));
  return id;
}

function broadcastPlayerList() {
  const list = Array.from(players.values())
    .filter(p => p.connected)
    .map(p => ({ id: p.id, inGame: Boolean(p.activeGameId) }));
  io.emit("players-online", list);
}

function getSocket(socketId) {
  if (!socketId) return null;
  return io.sockets.sockets.get(socketId);
}

function emitToPlayer(playerId, event, payload) {
  const player = players.get(playerId);
  if (!player || !player.connected || !player.socketId) return;
  const sock = getSocket(player.socketId);
  if (sock) sock.emit(event, payload);
}

function otherColor(color) {
  return color === "white" ? "black" : "white";
}

function gameStateForPlayer(game, playerId) {
  const color = game.white === playerId ? "white" : "black";
  const opponentId = color === "white" ? game.black : game.white;
  const opponent = players.get(opponentId);
  return {
    gameId: game.id,
    color,
    whiteId: game.white,
    blackId: game.black,
    opponentId,
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    status: game.status,
    lastMove: game.lastMove || null,
    opponentConnected: opponent ? opponent.connected : false
  };
}

function endGame(game, result, winnerId, reason) {
  game.status = "finished";
  const payload = { result, winnerId: winnerId || null, reason };
  emitToPlayer(game.white, "chess-game-finished", payload);
  emitToPlayer(game.black, "chess-game-finished", payload);

  [game.white, game.black].forEach(pid => {
    const p = players.get(pid);
    if (p) p.activeGameId = null;
  });
}

function checkGameEnd(game) {
  const chess = game.chess;
  if (!chess.isGameOver()) return false;

  if (chess.isCheckmate()) {
    // Side to move is checkmated, so the other side wins
    const loserColor = chess.turn() === "w" ? "white" : "black";
    const winnerColor = otherColor(loserColor);
    const winnerId = winnerColor === "white" ? game.white : game.black;
    endGame(game, "checkmate", winnerId, "Checkmate");
  } else if (chess.isStalemate()) {
    endGame(game, "draw", null, "Stalemate");
  } else if (chess.isThreefoldRepetition()) {
    endGame(game, "draw", null, "Draw by threefold repetition");
  } else if (chess.isInsufficientMaterial()) {
    endGame(game, "draw", null, "Draw by insufficient material");
  } else if (chess.isDraw()) {
    endGame(game, "draw", null, "Draw (50-move rule)");
  } else {
    endGame(game, "draw", null, "Game over");
  }
  return true;
}

/* -------------------------------- Socket.IO ------------------------------ */

io.on("connection", (socket) => {

  socket.on("register-player", ({ playerId } = {}) => {
    let player = playerId ? players.get(playerId) : null;

    if (player) {
      // Reconnecting with an existing permanent ID
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      player.socketId = socket.id;
      player.connected = true;
    } else {
      // Brand new player
      const newId = generatePlayerId();
      player = {
        id: newId,
        socketId: socket.id,
        connected: true,
        activeGameId: null,
        disconnectTimer: null
      };
      players.set(newId, player);
    }

    socketToPlayer.set(socket.id, player.id);
    socket.emit("player-registered", { playerId: player.id });

    // If this player has a live game, let them (and their opponent) know
    if (player.activeGameId && games.has(player.activeGameId)) {
      const game = games.get(player.activeGameId);
      if (game.status === "active") {
        const color = game.white === player.id ? "white" : "black";
        const opponentId = color === "white" ? game.black : game.white;
        socket.emit("active-game-found", {
          gameId: game.id,
          playerId: player.id,
          opponentId,
          color
        });
        // Notify opponent that this player reconnected
        emitToPlayer(opponentId, "opponent-reconnected", {});
      } else {
        player.activeGameId = null;
      }
    }

    broadcastPlayerList();
  });

  /* ------------------------------ Challenges ----------------------------- */

  socket.on("challenge-player", ({ targetId } = {}) => {
    const fromId = socketToPlayer.get(socket.id);
    if (!fromId) return;

    const fromPlayer = players.get(fromId);
    const targetPlayer = targetId ? players.get(targetId) : null;

    if (!targetId || fromId === targetId) {
      socket.emit("chess-game-error", { message: "You cannot challenge yourself." });
      return;
    }
    if (!targetPlayer || !targetPlayer.connected) {
      socket.emit("chess-game-error", { message: "That player is no longer online." });
      return;
    }
    if (fromPlayer.activeGameId || targetPlayer.activeGameId) {
      socket.emit("chess-game-error", { message: "One of the players is already in a game." });
      return;
    }

    pendingChallenges.set(targetId, { fromId });
    emitToPlayer(targetId, "chess-challenge", { fromId });
  });

  socket.on("cancel-challenge", ({ targetId } = {}) => {
    if (targetId && pendingChallenges.get(targetId)?.fromId === socketToPlayer.get(socket.id)) {
      pendingChallenges.delete(targetId);
    }
  });

  socket.on("accept-challenge", ({ fromId } = {}) => {
    const myId = socketToPlayer.get(socket.id);
    if (!myId) return;

    const challenge = pendingChallenges.get(myId);
    if (!challenge || challenge.fromId !== fromId) {
      socket.emit("chess-game-error", { message: "That challenge is no longer available." });
      return;
    }
    pendingChallenges.delete(myId);

    const challenger = players.get(fromId);
    const accepter = players.get(myId);
    if (!challenger || !challenger.connected || !accepter) {
      socket.emit("chess-game-error", { message: "The challenger is no longer online." });
      return;
    }

    // Create a brand new chess game — game ID is always distinct from player IDs
    const gameId = generateGameId();
    const chess = new Chess();

    const game = {
      id: gameId,
      white: fromId,        // challenger plays white
      black: myId,           // accepter plays black
      chess,
      status: "active",
      lastMove: null
    };
    games.set(gameId, game);

    challenger.activeGameId = gameId;
    accepter.activeGameId = gameId;

    emitToPlayer(fromId, "chess-game-start", {
      gameId, playerId: fromId, opponentId: myId, color: "white"
    });
    emitToPlayer(myId, "chess-game-start", {
      gameId, playerId: myId, opponentId: fromId, color: "black"
    });

    broadcastPlayerList();
  });

  socket.on("reject-challenge", ({ fromId } = {}) => {
    const myId = socketToPlayer.get(socket.id);
    if (!myId) return;

    const challenge = pendingChallenges.get(myId);
    if (challenge && challenge.fromId === fromId) {
      pendingChallenges.delete(myId);
      emitToPlayer(fromId, "challenge-declined", { byId: myId });
    }
  });

  /* ------------------------------ Chess game ------------------------------ */

  socket.on("join-chess-game", ({ gameId, playerId } = {}) => {
    const myId = socketToPlayer.get(socket.id) || playerId;
    const game = games.get(gameId);

    if (!game) {
      socket.emit("chess-game-error", { message: "That chess game no longer exists." });
      return;
    }
    if (game.white !== myId && game.black !== myId) {
      socket.emit("chess-game-error", { message: "You are not part of this chess game." });
      return;
    }

    const color = game.white === myId ? "white" : "black";
    if (color === "white") game.whiteSocketId = socket.id;
    else game.blackSocketId = socket.id;

    socket.join(gameId);
    socket.emit("chess-game-joined", gameStateForPlayer(game, myId));
  });

  socket.on("chess-move", ({ gameId, from, to, promotion } = {}) => {
    const myId = socketToPlayer.get(socket.id);
    const game = games.get(gameId);

    if (!game || game.status !== "active") {
      socket.emit("chess-game-error", { message: "This game is not active." });
      return;
    }
    if (game.white !== myId && game.black !== myId) {
      socket.emit("chess-game-error", { message: "You are not part of this chess game." });
      return;
    }

    const myColorChar = game.white === myId ? "w" : "b";
    if (game.chess.turn() !== myColorChar) {
      socket.emit("chess-move-error", {
        message: "It is not your turn.",
        fen: game.chess.fen()
      });
      return;
    }

    let moveResult = null;
    try {
      moveResult = game.chess.move({ from, to, promotion: promotion || "q" });
    } catch (err) {
      moveResult = null;
    }

    if (!moveResult) {
      socket.emit("chess-move-error", {
        message: "Illegal move.",
        fen: game.chess.fen()
      });
      return;
    }

    game.lastMove = { from, to };

    const opponentId = game.white === myId ? game.black : game.white;
    emitToPlayer(opponentId, "opponent-move", {
      from, to, promotion: promotion || "q", fen: game.chess.fen()
    });

    const nextTurnPlayerId = game.chess.turn() === "w" ? game.white : game.black;
    emitToPlayer(game.white, "chess-turn", { turnPlayerId: nextTurnPlayerId });
    emitToPlayer(game.black, "chess-turn", { turnPlayerId: nextTurnPlayerId });

    checkGameEnd(game);
  });

  /* -------------------------------- Disconnect ----------------------------- */

  socket.on("disconnect", () => {
    const playerId = socketToPlayer.get(socket.id);
    socketToPlayer.delete(socket.id);
    if (!playerId) return;

    const player = players.get(playerId);
    if (!player || player.socketId !== socket.id) return; // a newer socket already took over

    player.connected = false;
    player.socketId = null;

    // Remove any pending challenge the disconnecting player sent or received
    pendingChallenges.delete(playerId);
    for (const [targetId, challenge] of pendingChallenges.entries()) {
      if (challenge.fromId === playerId) pendingChallenges.delete(targetId);
    }

    broadcastPlayerList();

    if (player.activeGameId && games.has(player.activeGameId)) {
      const game = games.get(player.activeGameId);
      if (game.status === "active") {
        const opponentId = game.white === playerId ? game.black : game.white;
        emitToPlayer(opponentId, "opponent-disconnected", {});
      }
    }

    // Give the player a grace period to reconnect before their identity
    // (and any unfinished game) is permanently cleared out.
    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return; // they came back before the timer fired

      if (player.activeGameId && games.has(player.activeGameId)) {
        const game = games.get(player.activeGameId);
        if (game.status === "active") {
          const opponentId = game.white === playerId ? game.black : game.white;
          endGame(game, "abandoned", opponentId, "Opponent did not reconnect in time");
          games.delete(game.id);
        }
      }
      players.delete(playerId);
      broadcastPlayerList();
    }, RECONNECT_GRACE_MS);
  });
});

/* --------------------------------- HTTP ----------------------------------- */

app.get("/health", (req, res) => {
  const activeGames = Array.from(games.values()).filter(g => g.status === "active").length;
  const onlinePlayers = Array.from(players.values()).filter(p => p.connected).length;
  res.json({ status: "ok", players: onlinePlayers, games: activeGames });
});

app.get("/", (req, res) => {
  res.send("DuoPlay server is running.");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DuoPlay server listening on 0.0.0.0:${PORT}`);
});