const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// =====================================================
// PATHS
// =====================================================

const ROOT_DIR = path.join(__dirname, "..");

// =====================================================
// EXPRESS
// =====================================================

app.use(express.json());

app.use(
    express.static(ROOT_DIR)
);

// =====================================================
// SOCKET.IO
// =====================================================

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// =====================================================
// BASIC ROUTES
// =====================================================

app.get("/", (req, res) => {
    res.send("DuoPlay multiplayer server is running.");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "DuoPlayServer",
        players: players.size,
        chessWaiting: chessWaiting.length
    });
});

app.get("/chess", (req, res) => {
    res.sendFile(
        path.join(ROOT_DIR, "chess.html")
    );
});

app.get("/chess.html", (req, res) => {
    res.sendFile(
        path.join(ROOT_DIR, "chess.html")
    );
});

app.get("/games", (req, res) => {
    res.sendFile(
        path.join(ROOT_DIR, "games.html")
    );
});

app.get("/games.html", (req, res) => {
    res.sendFile(
        path.join(ROOT_DIR, "games.html")
    );
});

// =====================================================
// PLAYERS
// =====================================================

const players = new Map();

function createPlayerId() {
    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let id = "DP-";

    for (let i = 0; i < 4; i++) {
        id += chars[
            Math.floor(
                Math.random() * chars.length
            )
        ];
    }

    return id;
}

function getUniquePlayerId() {
    let id;

    do {
        id = createPlayerId();
    } while (
        [...players.values()].some(
            player => player.id === id
        )
    );

    return id;
}

// =====================================================
// GENERIC ROOMS
// =====================================================

const rooms = new Map();

function createRoom(roomId) {
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

function deleteRoomIfEmpty(roomId) {
    const room = rooms.get(roomId);

    if (!room) return;

    if (room.players.size === 0) {
        rooms.delete(roomId);
    }
}

// =====================================================
// CHESS ROOMS
// =====================================================

const chessRooms = new Map();
const chessWaiting = [];

function createChessRoom() {
    const roomId =
        "CHESS-" +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();

    const room = {
        id: roomId,

        white: null,
        black: null,

        game: new Chess(),

        createdAt: Date.now()
    };

    chessRooms.set(
        roomId,
        room
    );

    return room;
}

// =====================================================
// CHESS STATE
// =====================================================

function chessState(room) {
    return {
        roomId: room.id,

        white: room.white
            ? {
                id: room.white.playerId
            }
            : null,

        black: room.black
            ? {
                id: room.black.playerId
            }
            : null,

        fen: room.game.fen(),

        turn:
            room.game.turn() === "w"
                ? "white"
                : "black"
    };
}

// =====================================================
// START CHESS GAME
// =====================================================

function startChessGame(room) {
    if (
        !room.white ||
        !room.black
    ) {
        return;
    }

    const state =
        chessState(room);

    io.to(
        room.white.socketId
    ).emit(
        "gameReady",
        {
            ...state,
            color: "white"
        }
    );

    io.to(
        room.black.socketId
    ).emit(
        "gameReady",
        {
            ...state,
            color: "black"
        }
    );

    console.log(
        "Chess game started:",
        room.id
    );
}

// =====================================================
// PUT PLAYER INTO CHESS
// =====================================================

function joinChess(socket) {

    // Already playing
    if (socket.data.chessRoomId) {
        const existingRoom =
            chessRooms.get(
                socket.data.chessRoomId
            );

        if (existingRoom) {
            socket.emit(
                "gameReconnected",
                chessState(existingRoom)
            );

            return;
        }
    }

    // Check waiting players
    while (chessWaiting.length > 0) {

        const waitingSocket =
            chessWaiting.shift();

        if (
            !waitingSocket ||
            !waitingSocket.connected
        ) {
            continue;
        }

        const room =
            createChessRoom();

        room.white = {
            socketId:
                waitingSocket.id,

            playerId:
                players.get(
                    waitingSocket.id
                )?.id
        };

        room.black = {
            socketId:
                socket.id,

            playerId:
                players.get(
                    socket.id
                )?.id
        };

        waitingSocket.data.chessRoomId =
            room.id;

        waitingSocket.data.chessColor =
            "white";

        socket.data.chessRoomId =
            room.id;

        socket.data.chessColor =
            "black";

        startChessGame(room);

        return;
    }

    // Nobody waiting
    chessWaiting.push(socket);

    socket.emit(
        "chessWaiting"
    );

    console.log(
        "Chess player waiting:",
        socket.id
    );
}

// =====================================================
// SOCKET CONNECTION
// =====================================================

io.on(
    "connection",
    socket => {

        console.log(
            "Player connected:",
            socket.id
        );

        // -------------------------------------------------
        // PLAYER ID
        // -------------------------------------------------

        const requestedId =
            socket.handshake.auth?.playerId;

        let playerId =
            requestedId;

        if (
            !playerId ||
            [...players.values()].some(
                player =>
                    player.id === playerId
            )
        ) {
            playerId =
                getUniquePlayerId();
        }

        players.set(
            socket.id,
            {
                id: playerId,
                socketId: socket.id,
                roomId: null
            }
        );

        socket.data.playerId =
            playerId;

        // Send ID to browser
        socket.emit(
            "yourId",
            playerId
        );

        console.log(
            "DuoPlay ID:",
            playerId
        );

        // -------------------------------------------------
        // GENERIC ROOM CREATE
        // -------------------------------------------------

        socket.on(
            "room:create",
            (data = {}, callback) => {

                const roomId =
                    String(
                        data.roomId ||
                        Math.random()
                            .toString(36)
                            .substring(2, 8)
                    )
                        .trim()
                        .toUpperCase();

                if (
                    rooms.has(roomId)
                ) {
                    if (
                        typeof callback ===
                        "function"
                    ) {
                        callback({
                            success: false,
                            error:
                                "Room already exists."
                        });
                    }

                    return;
                }

                const room =
                    createRoom(roomId);

                const player = {
                    id: socket.id,
                    playerId:
                        socket.data.playerId,
                    name:
                        data.name ||
                        "Player 1"
                };

                room.players.set(
                    socket.id,
                    player
                );

                socket.join(roomId);

                socket.data.roomId =
                    roomId;

                if (
                    typeof callback ===
                    "function"
                ) {
                    callback({
                        success: true,
                        roomId,
                        player
                    });
                }

                socket.emit(
                    "room:created",
                    {
                        roomId,
                        player,
                        players:
                            Array.from(
                                room.players.values()
                            )
                    }
                );

                console.log(
                    "Room created:",
                    roomId
                );
            }
        );

        // -------------------------------------------------
        // GENERIC ROOM JOIN
        // -------------------------------------------------

        socket.on(
            "room:join",
            (data = {}, callback) => {

                const roomId =
                    String(
                        data.roomId || ""
                    )
                        .trim()
                        .toUpperCase();

                if (!roomId) {

                    if (
                        typeof callback ===
                        "function"
                    ) {
                        callback({
                            success: false,
                            error:
                                "Room ID is required."
                        });
                    }

                    return;
                }

                const room =
                    getRoom(roomId);

                if (!room) {

                    if (
                        typeof callback ===
                        "function"
                    ) {
                        callback({
                            success: false,
                            error:
                                "Room not found."
                        });
                    }

                    return;
                }

                if (
                    room.players.size >= 2
                ) {

                    if (
                        typeof callback ===
                        "function"
                    ) {
                        callback({
                            success: false,
                            error:
                                "Room is full."
                        });
                    }

                    return;
                }

                const player = {
                    id: socket.id,
                    playerId:
                        socket.data.playerId,
                    name:
                        data.name ||
                        "Player 2"
                };

                room.players.set(
                    socket.id,
                    player
                );

                socket.join(roomId);

                socket.data.roomId =
                    roomId;

                if (
                    typeof callback ===
                    "function"
                ) {
                    callback({
                        success: true,
                        roomId,
                        player
                    });
                }

                io.to(roomId).emit(
                    "room:players",
                    {
                        roomId,
                        players:
                            Array.from(
                                room.players.values()
                            )
                    }
                );

                console.log(
                    "Player joined:",
                    roomId
                );
            }
        );

        // -------------------------------------------------
        // CHESS REQUEST
        // -------------------------------------------------

        socket.on(
            "getGameState",
            () => {

                joinChess(socket);

                const roomId =
                    socket.data.chessRoomId;

                if (!roomId) {
                    return;
                }

                const room =
                    chessRooms.get(
                        roomId
                    );

                if (!room) {
                    return;
                }

                socket.emit(
                    "gameState",
                    {
                        ...chessState(room),

                        color:
                            socket.data
                                .chessColor
                    }
                );
            }
        );

        // -------------------------------------------------
        // CHESS MOVE
        // -------------------------------------------------

        socket.on(
            "chessMove",
            (data = {}) => {

                const roomId =
                    socket.data.chessRoomId;

                if (!roomId) {
                    socket.emit(
                        "moveError",
                        "You are not in a chess game."
                    );

                    return;
                }

                const room =
                    chessRooms.get(
                        roomId
                    );

                if (!room) {
                    return;
                }

                const color =
                    socket.data.chessColor;

                // Check turn
                const turn =
                    room.game.turn() === "w"
                        ? "white"
                        : "black";

                if (color !== turn) {

                    socket.emit(
                        "moveError",
                        "It is not your turn."
                    );

                    return;
                }

                if (
                    !data.from ||
                    !data.to
                ) {
                    socket.emit(
                        "moveError",
                        "Invalid move."
                    );

                    return;
                }

                try {

                    const move =
                        room.game.move({
                            from:
                                data.from,

                            to:
                                data.to,

                            promotion:
                                data.promotion ||
                                "q"
                        });

                    if (!move) {

                        socket.emit(
                            "moveError",
                            "Illegal move."
                        );

                        return;
                    }

                    const state = {
                        move: {
                            from:
                                move.from,

                            to:
                                move.to,

                            promotion:
                                move.promotion
                        },

                        fen:
                            room.game.fen(),

                        check:
                            room.game.isCheck(),

                        checkmate:
                            room.game.isCheckmate(),

                        stalemate:
                            room.game.isStalemate()
                    };

                    io.to(roomId).emit(
                        "moveMade",
                        state
                    );

                    // Game finished
                    if (
                        room.game.isGameOver()
                    ) {

                        let result =
                            "draw";

                        if (
                            room.game.isCheckmate()
                        ) {
                            result =
                                room.game.turn() === "w"
                                    ? "black"
                                    : "white";
                        }

                        io.to(roomId).emit(
                            "gameFinished",
                            {
                                result
                            }
                        );
                    }

                } catch (error) {

                    console.error(
                        "Chess move error:",
                        error
                    );

                    socket.emit(
                        "moveError",
                        "Illegal chess move."
                    );
                }
            }
        );

        // -------------------------------------------------
        // OLD CHESS EVENT COMPATIBILITY
        // -------------------------------------------------

        socket.on(
            "chess:move",
            data => {

                socket.emit(
                    "moveError",
                    "Use the current chess connection."
                );
            }
        );

        // -------------------------------------------------
        // DISCONNECT
        // -------------------------------------------------

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Player disconnected:",
                    socket.id
                );

                // Remove from generic players
                players.delete(
                    socket.id
                );

                // Remove from chess waiting
                for (
                    let i =
                        chessWaiting.length - 1;
                    i >= 0;
                    i--
                ) {
                    if (
                        chessWaiting[i]?.id ===
                        socket.id
                    ) {
                        chessWaiting.splice(
                            i,
                            1
                        );
                    }
                }

                // Chess room
                const roomId =
                    socket.data.chessRoomId;

                if (roomId) {

                    const room =
                        chessRooms.get(
                            roomId
                        );

                    if (room) {

                        io.to(roomId).emit(
                            "opponentDisconnected"
                        );

                        chessRooms.delete(
                            roomId
                        );
                    }
                }

                // Generic room
                const genericRoomId =
                    socket.data.roomId;

                if (genericRoomId) {

                    const room =
                        rooms.get(
                            genericRoomId
                        );

                    if (room) {

                        room.players.delete(
                            socket.id
                        );

                        io.to(
                            genericRoomId
                        ).emit(
                            "room:players",
                            {
                                roomId:
                                    genericRoomId,

                                players:
                                    Array.from(
                                        room.players.values()
                                    )
                            }
                        );

                        deleteRoomIfEmpty(
                            genericRoomId
                        );
                    }
                }
            }
        );
    }
);

// =====================================================
// START SERVER
// =====================================================

server.listen(
    PORT,
    () => {
        console.log(
            `DuoPlay server running on port ${PORT}`
        );
    }
);