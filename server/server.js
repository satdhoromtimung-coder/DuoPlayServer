const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// --------------------------------------------------
// PATHS
// --------------------------------------------------

const ROOT_DIR = path.join(__dirname, "..");

// --------------------------------------------------
// SOCKET.IO
// --------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --------------------------------------------------
// PORT
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// EXPRESS
// --------------------------------------------------

app.use(express.json());

// Serve the main DuoPlay files
app.use(express.static(ROOT_DIR));

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// --------------------------------------------------
// CHESS
// --------------------------------------------------

app.get("/chess", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "chess.html"));
});

app.get("/chess.html", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "chess.html"));
});

// --------------------------------------------------
// GAMES
// --------------------------------------------------

app.get("/games", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "games.html"));
});

app.get("/games.html", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "games.html"));
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "DuoPlayServer",
    players: io.engine.clientsCount
  });
});

// --------------------------------------------------
// GAME ROOMS
// --------------------------------------------------

const rooms = new Map();

function createRoom(roomId) {
  const room = {
    id: roomId,
    players: new Map(),
    game: null,
    createdAt: Date.now()
  };

  rooms.set(roomId, room);

  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function deleteRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);

  if (!room) return;

  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

// --------------------------------------------------
// SOCKET CONNECTION
// --------------------------------------------------

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.emit("server:connected", {
    socketId: socket.id,
    message: "Connected to DuoPlay server."
  });

  // ------------------------------------------------
  // CREATE ROOM
  // ------------------------------------------------

  socket.on("room:create", (data = {}, callback) => {
    const roomId =
      data.roomId ||
      Math.random().toString(36).substring(2, 8).toUpperCase();

    if (rooms.has(roomId)) {
      if (typeof callback === "function") {
        callback({
          success: false,
          error: "Room already exists."
        });
      }

      return;
    }

    const room = createRoom(roomId);

    const player = {
      id: socket.id,
      name: data.name || "Player 1",
      color: "white",
      joinedAt: Date.now()
    };

    room.players.set(socket.id, player);

    socket.join(roomId);

    socket.data.roomId = roomId;
    socket.data.playerId = socket.id;

    if (typeof callback === "function") {
      callback({
        success: true,
        roomId,
        player
      });
    }

    socket.emit("room:created", {
      roomId,
      player,
      players: Array.from(room.players.values())
    });

    console.log(
      `Room created: ${roomId} by ${player.name} (${socket.id})`
    );
  });

  // ------------------------------------------------
  // JOIN ROOM
  // ------------------------------------------------

  socket.on("room:join", (data = {}, callback) => {
    const roomId = String(data.roomId || "")
      .trim()
      .toUpperCase();

    if (!roomId) {
      if (typeof callback === "function") {
        callback({
          success: false,
          error: "Room ID is required."
        });
      }

      return;
    }

    const room = getRoom(roomId);

    if (!room) {
      if (typeof callback === "function") {
        callback({
          success: false,
          error: "Room not found."
        });
      }

      return;
    }

    if (room.players.size >= 2) {
      if (typeof callback === "function") {
        callback({
          success: false,
          error: "Room is full."
        });
      }

      return;
    }

    const player = {
      id: socket.id,
      name: data.name || "Player 2",
      color: "black",
      joinedAt: Date.now()
    };

    room.players.set(socket.id, player);

    socket.join(roomId);

    socket.data.roomId = roomId;
    socket.data.playerId = socket.id;

    const players = Array.from(room.players.values());

    if (typeof callback === "function") {
      callback({
        success: true,
        roomId,
        player,
        players
      });
    }

    socket.emit("room:joined", {
      roomId,
      player,
      players
    });

    socket.to(roomId).emit("room:player-joined", {
      player,
      players
    });

    io.to(roomId).emit("room:update", {
      roomId,
      players
    });

    console.log(
      `${player.name} joined room ${roomId}`
    );

    // Start game when two players are present
    if (room.players.size === 2) {
      room.game = {
        started: true,
        turn: "white",
        startedAt: Date.now()
      };

      io.to(roomId).emit("game:start", {
        roomId,
        players,
        game: room.game
      });

      console.log(`Game started in room ${roomId}`);
    }
  });

  // ------------------------------------------------
  // LEAVE ROOM
  // ------------------------------------------------

  socket.on("room:leave", () => {
    leaveCurrentRoom(socket);
  });

  // ------------------------------------------------
  // GENERIC GAME MOVE
  // ------------------------------------------------

  socket.on("game:move", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const room = getRoom(roomId);

    if (!room) return;

    socket.to(roomId).emit("game:move", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHESS MOVE
  // ------------------------------------------------

  socket.on("chess:move", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const room = getRoom(roomId);

    if (!room) return;

    const player = room.players.get(socket.id);

    if (!player) return;

    socket.to(roomId).emit("chess:move", {
      ...data,
      playerId: socket.id,
      playerName: player.name
    });

    console.log(
      `Chess move in ${roomId} from ${player.name}`
    );
  });

  // ------------------------------------------------
  // CHESS GAME STATE
  // ------------------------------------------------

  socket.on("chess:state", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    socket.to(roomId).emit("chess:state", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHESS TURN
  // ------------------------------------------------

  socket.on("chess:turn", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    socket.to(roomId).emit("chess:turn", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHESS CHECK
  // ------------------------------------------------

  socket.on("chess:check", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    io.to(roomId).emit("chess:check", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHESS CHECKMATE
  // ------------------------------------------------

  socket.on("chess:checkmate", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    io.to(roomId).emit("chess:checkmate", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHESS DRAW
  // ------------------------------------------------

  socket.on("chess:draw", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    io.to(roomId).emit("chess:draw", {
      ...data,
      playerId: socket.id
    });
  });

  // ------------------------------------------------
  // CHAT
  // ------------------------------------------------

  socket.on("chat:message", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const player = getPlayer(socket);

    const message = {
      id: `${Date.now()}-${socket.id}`,
      text: String(data.text || "").slice(0, 1000),
      senderId: socket.id,
      senderName: player ? player.name : "Player",
      timestamp: Date.now()
    };

    io.to(roomId).emit("chat:message", message);
  });

  // ------------------------------------------------
  // TYPING
  // ------------------------------------------------

  socket.on("chat:typing", (data = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    socket.to(roomId).emit("chat:typing", {
      playerId: socket.id,
      typing: Boolean(data.typing)
    });
  });

  // ------------------------------------------------
  // PING
  // ------------------------------------------------

  socket.on("client:ping", () => {
    socket.emit("server:pong", {
      timestamp: Date.now()
    });
  });

  // ------------------------------------------------
  // DISCONNECT
  // ------------------------------------------------

  socket.on("disconnect", (reason) => {
    console.log(
      `Player disconnected: ${socket.id} (${reason})`
    );

    leaveCurrentRoom(socket);
  });
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function getPlayer(socket) {
  const roomId = socket.data.roomId;

  if (!roomId) return null;

  const room = getRoom(roomId);

  if (!room) return null;

  return room.players.get(socket.id) || null;
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;

  if (!roomId) return;

  const room = getRoom(roomId);

  if (!room) {
    socket.data.roomId = null;
    return;
  }

  const player = room.players.get(socket.id);

  room.players.delete(socket.id);

  socket.leave(roomId);

  socket.to(roomId).emit("room:player-left", {
    player: player || {
      id: socket.id
    }
  });

  io.to(roomId).emit("room:update", {
    roomId,
    players: Array.from(room.players.values())
  });

  console.log(
    `${socket.id} left room ${roomId}`
  );

  if (room.players.size === 0) {
    rooms.delete(roomId);

    console.log(
      `Room deleted: ${roomId}`
    );
  } else {
    room.game = null;
  }

  socket.data.roomId = null;
}

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal server error"
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DuoPlayServer running on port ${PORT}`
  );

  console.log(
    `Serving DuoPlay files from: ${ROOT_DIR}`
  );
});