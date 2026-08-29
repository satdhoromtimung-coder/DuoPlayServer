const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, "..");

app.use(express.json());
app.use(express.static(ROOT_DIR));

/* =====================================================
   PAGES
===================================================== */

app.get("/", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/games", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "games.html"));
});

app.get("/games.html", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "games.html"));
});

app.get("/chess", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "chess.html"));
});

app.get("/chess.html", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "chess.html"));
});

/* =====================================================
   HEALTH
===================================================== */

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "DuoPlayServer",
        players: io.engine.clientsCount,
        rooms: rooms.size
    });
});

/* =====================================================
   ROOMS
===================================================== */

const rooms = new Map();

/*
room = {
    id,
    players: Map(clientId -> player),
    createdAt
}

player = {
    clientId,
    socketId,
    name,
    color,
    connected
}
*/

/* =====================================================
   MATCHMAKING
===================================================== */

const chessQueue = [];

function createRoom() {
    const roomId =
        "CHESS-" +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();

    const room = {
        id: roomId,
        players: new Map(),
        createdAt: Date.now()
    };

    rooms.set(roomId, room);

    return room;
}

function getRoom(roomId) {
    return rooms.get(roomId);
}

function removeFromQueue(socketId) {
    for (let i = chessQueue.length - 1; i >= 0; i--) {
        if (chessQueue[i].socketId === socketId) {
            chessQueue.splice(i, 1);
        }
    }
}

/* =====================================================
   PLAYER HELPERS
===================================================== */

function getPlayerFromRoom(room, clientId) {
    if (!room) return null;

    return room.players.get(clientId) || null;
}

function roomPlayers(room) {
    return Array.from(room.players.values()).map(player => ({
        id: player.clientId,
        socketId: player.socketId,
        name: player.name,
        color: player.color,
        connected: player.connected
    }));
}

function emitRoomUpdate(room) {
    io.to(room.id).emit("room:update", {
        roomId: room.id,
        players: roomPlayers(room)
    });
}

/* =====================================================
   START CHESS MATCH
===================================================== */

function startChessMatch(first, second) {

    const room = createRoom();

    const whitePlayer = {
        clientId: first.clientId,
        socketId: first.socketId,
        name: first.name,
        color: "white",
        connected: true
    };

    const blackPlayer = {
        clientId: second.clientId,
        socketId: second.socketId,
        name: second.name,
        color: "black",
        connected: true
    };

    room.players.set(
        whitePlayer.clientId,
        whitePlayer
    );

    room.players.set(
        blackPlayer.clientId,
        blackPlayer
    );

    const firstSocket =
        io.sockets.sockets.get(first.socketId);

    const secondSocket =
        io.sockets.sockets.get(second.socketId);

    if (firstSocket) {
        firstSocket.data.roomId = room.id;
        firstSocket.data.clientId = first.clientId;
    }

    if (secondSocket) {
        secondSocket.data.roomId = room.id;
        secondSocket.data.clientId = second.clientId;
    }

    const data = {
        roomId: room.id,

        players: roomPlayers(room),

        game: {
            started: true,
            turn: "white",
            fen: "start"
        }
    };

    if (firstSocket) {
        firstSocket.emit("match:found", data);
        firstSocket.emit("game:start", data);
    }

    if (secondSocket) {
        secondSocket.emit("match:found", data);
        secondSocket.emit("game:start", data);
    }

    console.log(
        `Chess match created: ${room.id}`
    );

    console.log(
        `${first.name} vs ${second.name}`
    );

    return room;
}

/* =====================================================
   SOCKET CONNECTION
===================================================== */

io.on("connection", socket => {

    console.log(
        "Player connected:",
        socket.id
    );

    socket.emit("server:connected", {
        socketId: socket.id,
        message: "Connected to DuoPlay server."
    });

    /* =================================================
       REGISTER PLAYER
    ================================================= */

    socket.on(
        "player:register",
        (data = {}, callback) => {

            const clientId =
                String(data.clientId || socket.id);

            const name =
                String(data.name || "Player");

            socket.data.clientId = clientId;

            socket.data.playerName = name;

            console.log(
                `Player registered: ${name} (${clientId})`
            );

            if (typeof callback === "function") {
                callback({
                    success: true,
                    clientId
                });
            }
        }
    );

    /* =================================================
       FIND CHESS OPPONENT
    ================================================= */

    socket.on(
        "chess:find",
        (data = {}) => {

            const clientId =
                String(
                    data.clientId ||
                    socket.data.clientId ||
                    socket.id
                );

            const name =
                String(
                    data.name ||
                    socket.data.playerName ||
                    "Player"
                );

            socket.data.clientId = clientId;
            socket.data.playerName = name;

            /*
             * Already in a room
             */

            if (socket.data.roomId) {

                const room =
                    getRoom(socket.data.roomId);

                if (room) {

                    socket.emit(
                        "match:found",
                        {
                            roomId: room.id,
                            players: roomPlayers(room)
                        }
                    );

                    return;
                }
            }

            /*
             * Don't add the same socket
             * to the queue twice.
             */

            removeFromQueue(socket.id);

            /*
             * Find another connected player.
             */

            let opponent = null;

            while (chessQueue.length > 0) {

                const candidate =
                    chessQueue.shift();

                const candidateSocket =
                    io.sockets.sockets.get(
                        candidate.socketId
                    );

                if (
                    candidateSocket &&
                    candidateSocket.connected &&
                    candidate.clientId !== clientId
                ) {

                    opponent = candidate;

                    break;
                }
            }

            /*
             * Nobody waiting.
             */

            if (!opponent) {

                chessQueue.push({
                    socketId: socket.id,
                    clientId,
                    name
                });

                socket.emit(
                    "match:waiting",
                    {
                        message:
                            "Waiting for another player..."
                    }
                );

                console.log(
                    `${name} is waiting for a chess opponent.`
                );

                return;
            }

            /*
             * Match found.
             */

            startChessMatch(
                opponent,
                {
                    socketId: socket.id,
                    clientId,
                    name
                }
            );
        }
    );

    /* =================================================
       JOIN EXISTING ROOM
    ================================================= */

    socket.on(
        "room:join",
        (data = {}, callback) => {

            const roomId =
                String(
                    data.roomId || ""
                )
                    .trim()
                    .toUpperCase();

            const clientId =
                String(
                    data.clientId ||
                    socket.data.clientId ||
                    socket.id
                );

            const name =
                String(
                    data.name ||
                    socket.data.playerName ||
                    "Player"
                );

            if (!roomId) {

                if (typeof callback === "function") {
                    callback({
                        success: false,
                        error: "Room ID is required."
                    });
                }

                return;
            }

            const room =
                getRoom(roomId);

            if (!room) {

                if (typeof callback === "function") {
                    callback({
                        success: false,
                        error: "Room not found."
                    });
                }

                return;
            }

            /*
             * Reconnect existing player.
             */

            const existingPlayer =
                getPlayerFromRoom(
                    room,
                    clientId
                );

            if (existingPlayer) {

                existingPlayer.socketId =
                    socket.id;

                existingPlayer.connected =
                    true;

                existingPlayer.name =
                    name || existingPlayer.name;

                socket.data.roomId =
                    room.id;

                socket.data.clientId =
                    clientId;

                socket.join(room.id);

                if (typeof callback === "function") {
                    callback({
                        success: true,
                        roomId: room.id,
                        players: roomPlayers(room),
                        player: existingPlayer
                    });
                }

                emitRoomUpdate(room);

                console.log(
                    `${name} reconnected to ${room.id}`
                );

                return;
            }

            /*
             * Room already has two players.
             */

            if (room.players.size >= 2) {

                if (typeof callback === "function") {
                    callback({
                        success: false,
                        error: "Room is full."
                    });
                }

                return;
            }

            /*
             * Add new player.
             */

            const color =
                room.players.size === 0
                    ? "white"
                    : "black";

            const player = {
                clientId,
                socketId: socket.id,
                name,
                color,
                connected: true
            };

            room.players.set(
                clientId,
                player
            );

            socket.data.roomId =
                room.id;

            socket.data.clientId =
                clientId;

            socket.join(room.id);

            const players =
                roomPlayers(room);

            if (typeof callback === "function") {
                callback({
                    success: true,
                    roomId: room.id,
                    players,
                    player
                });
            }

            io.to(room.id).emit(
                "room:update",
                {
                    roomId: room.id,
                    players
                }
            );

            /*
             * Two players are now connected.
             */

            if (room.players.size === 2) {

                const gameData = {
                    roomId: room.id,
                    players,
                    game: {
                        started: true,
                        turn: "white",
                        fen: "start"
                    }
                };

                io.to(room.id).emit(
                    "game:start",
                    gameData
                );

                console.log(
                    `Game started in room ${room.id}`
                );
            }
        }
    );

    /* =================================================
       CHESS MOVE
    ================================================= */

    socket.on(
        "chess:move",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            const room =
                getRoom(roomId);

            if (!room) return;

            socket.to(roomId).emit(
                "chess:move",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       CHESS STATE
    ================================================= */

    socket.on(
        "chess:state",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            socket.to(roomId).emit(
                "chess:state",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       CHESS TURN
    ================================================= */

    socket.on(
        "chess:turn",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            socket.to(roomId).emit(
                "chess:turn",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       CHESS CHECK
    ================================================= */

    socket.on(
        "chess:check",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            io.to(roomId).emit(
                "chess:check",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       CHESS CHECKMATE
    ================================================= */

    socket.on(
        "chess:checkmate",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            io.to(roomId).emit(
                "chess:checkmate",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       CHESS DRAW
    ================================================= */

    socket.on(
        "chess:draw",
        (data = {}) => {

            const roomId =
                socket.data.roomId;

            if (!roomId) return;

            io.to(roomId).emit(
                "chess:draw",
                {
                    ...data,
                    playerId:
                        socket.data.clientId
                }
            );
        }
    );

    /* =================================================
       ROOM LEAVE
    ================================================= */

    socket.on(
        "room:leave",
        () => {

            leaveRoom(socket);
        }
    );

    /* =================================================
       PING
    ================================================= */

    socket.on(
        "client:ping",
        () => {

            socket.emit(
                "server:pong",
                {
                    timestamp: Date.now()
                }
            );
        }
    );

    /* =================================================
       DISCONNECT
    ================================================= */

    socket.on(
        "disconnect",
        reason => {

            console.log(
                `Player disconnected: ${socket.id} (${reason})`
            );

            removeFromQueue(
                socket.id
            );

            /*
             * Don't immediately destroy
             * the chess room.
             *
             * The browser will reconnect
             * when chess.html loads.
             */

            const roomId =
                socket.data.roomId;

            const clientId =
                socket.data.clientId;

            if (!roomId || !clientId) {
                return;
            }

            const room =
                getRoom(roomId);

            if (!room) return;

            const player =
                room.players.get(clientId);

            if (!player) return;

            /*
             * Only mark disconnected.
             */

            player.connected = false;
            player.socketId = null;

            io.to(roomId).emit(
                "room:player-left",
                {
                    player: {
                        id: clientId,
                        name: player.name,
                        color: player.color
                    }
                }
            );

            emitRoomUpdate(room);
        }
    );
});

/* =====================================================
   LEAVE ROOM
===================================================== */

function leaveRoom(socket) {

    const roomId =
        socket.data.roomId;

    const clientId =
        socket.data.clientId;

    if (!roomId || !clientId) {
        return;
    }

    const room =
        getRoom(roomId);

    if (!room) {
        return;
    }

    room.players.delete(
        clientId
    );

    socket.leave(roomId);

    io.to(roomId).emit(
        "room:player-left",
        {
            player: {
                id: clientId
            }
        }
    );

    emitRoomUpdate(room);

    socket.data.roomId = null;

    console.log(
        `${clientId} left room ${roomId}`
    );

    /*
     * Delete completely empty room.
     */

    if (room.players.size === 0) {

        rooms.delete(roomId);

        console.log(
            `Room deleted: ${roomId}`
        );
    }
}

/* =====================================================
   ERROR HANDLER
===================================================== */

app.use(
    (err, req, res, next) => {

        console.error(err);

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);

/* =====================================================
   START
===================================================== */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `DuoPlayServer running on port ${PORT}`
        );

        console.log(
            `Serving DuoPlay from ${ROOT_DIR}`
        );
    }
);