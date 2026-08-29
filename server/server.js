const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

/* =========================================================
   PATHS
========================================================= */

const ROOT = path.join(__dirname, "..");

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());
app.use(express.static(ROOT));

app.get("/", (req, res) => {
    res.sendFile(path.join(ROOT, "games.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        players: players.size,
        chessRooms: chessRooms.size
    });
});

/* =========================================================
   SOCKET.IO
========================================================= */

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

/* =========================================================
   PERMANENT PLAYER IDs
========================================================= */

const players = new Map();

/*
    socket.id -> {
        playerId,
        socketId
    }
*/

function generatePlayerId() {

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

function createUniquePlayerId() {

    let id;

    do {
        id = generatePlayerId();
    } while (
        [...players.values()].some(
            player => player.playerId === id
        )
    );

    return id;
}

/* =========================================================
   SEND PLAYER LIST
========================================================= */

function sendPlayers() {

    const list = [...players.values()].map(
        player => ({
            playerId: player.playerId,
            socketId: player.socketId
        })
    );

    io.emit("players", list);
}

/* =========================================================
   CHESS
========================================================= */

const chessRooms = new Map();

/*
    roomId -> {

        game,
        white: {
            socketId,
            playerId
        },
        black: {
            socketId,
            playerId
        }

    }
*/

/* =========================================================
   CHESS ROOM ID
========================================================= */

function createRoomId() {

    let roomId;

    do {

        roomId =
            "CHESS-" +
            Math.random()
                .toString(36)
                .substring(2, 8)
                .toUpperCase();

    } while (
        chessRooms.has(roomId)
    );

    return roomId;
}

/* =========================================================
   CREATE CHESS ROOM
========================================================= */

function createChessRoom(
    whiteSocket,
    blackSocket
) {

    const whitePlayer =
        players.get(
            whiteSocket.id
        );

    const blackPlayer =
        players.get(
            blackSocket.id
        );

    if (
        !whitePlayer ||
        !blackPlayer
    ) {
        return null;
    }

    const roomId =
        createRoomId();

    const room = {

        roomId,

        game: new Chess(),

        white: {
            socketId:
                whiteSocket.id,

            playerId:
                whitePlayer.playerId
        },

        black: {
            socketId:
                blackSocket.id,

            playerId:
                blackPlayer.playerId
        }

    };

    chessRooms.set(
        roomId,
        room
    );

    whiteSocket.join(roomId);
    blackSocket.join(roomId);

    whiteSocket.data.chessRoom =
        roomId;

    whiteSocket.data.chessColor =
        "white";

    blackSocket.data.chessRoom =
        roomId;

    blackSocket.data.chessColor =
        "black";

    return room;
}

/* =========================================================
   SEND GAME READY
========================================================= */

function sendGameReady(room) {

    const whiteSocket =
        io.sockets.sockets.get(
            room.white.socketId
        );

    const blackSocket =
        io.sockets.sockets.get(
            room.black.socketId
        );

    const common = {

        roomId:
            room.roomId,

        fen:
            room.game.fen(),

        turn: "white",

        whitePlayerId:
            room.white.playerId,

        blackPlayerId:
            room.black.playerId

    };

    if (whiteSocket) {

        whiteSocket.emit(
            "gameReady",
            {
                ...common,
                color: "white"
            }
        );

    }

    if (blackSocket) {

        blackSocket.emit(
            "gameReady",
            {
                ...common,
                color: "black"
            }
        );

    }
}

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

        console.log(
            "Connected:",
            socket.id
        );

        /*
         * Client sends its permanent ID
         * through handshake.auth.playerId.
         */

        let playerId =
            socket.handshake.auth?.playerId;

        /*
         * If no ID exists, create one.
         */

        if (
            !playerId ||
            typeof playerId !== "string"
        ) {

            playerId =
                createUniquePlayerId();

        }

        playerId =
            playerId.trim().toUpperCase();

        /*
         * If this ID is already being used by
         * another active connection, give this
         * connection a new ID.
         *
         * Normally this will not happen because
         * the browser keeps its permanent ID.
         */

        const existing =
            [...players.entries()].find(
                ([socketId, player]) =>
                    socketId !== socket.id &&
                    player.playerId === playerId
            );

        if (existing) {

            playerId =
                createUniquePlayerId();

        }

        players.set(
            socket.id,
            {
                playerId,
                socketId: socket.id
            }
        );

        socket.data.playerId =
            playerId;

        /*
         * Give the client its permanent ID.
         */

        socket.emit(
            "yourId",
            playerId
        );

        sendPlayers();

        console.log(
            "Player:",
            playerId
        );

        /* =====================================================
           REFRESH / RECONNECT
        ===================================================== */

        socket.on(
            "identify",
            requestedId => {

                if (
                    !requestedId ||
                    typeof requestedId !== "string"
                ) {
                    return;
                }

                const cleanId =
                    requestedId
                        .trim()
                        .toUpperCase();

                const duplicate =
                    [...players.entries()].some(
                        ([socketId, player]) =>
                            socketId !== socket.id &&
                            player.playerId === cleanId
                    );

                if (duplicate) {

                    socket.emit(
                        "idError",
                        "This Player ID is already online."
                    );

                    return;
                }

                const player =
                    players.get(
                        socket.id
                    );

                if (!player) {
                    return;
                }

                player.playerId =
                    cleanId;

                socket.data.playerId =
                    cleanId;

                socket.emit(
                    "yourId",
                    cleanId
                );

                sendPlayers();

            }
        );

        /* =====================================================
           GET ONLINE PLAYERS
        ===================================================== */

        socket.on(
            "getPlayers",
            () => {

                sendPlayers();

            }
        );

        /* =====================================================
           PLAY REQUEST
        ===================================================== */

        socket.on(
            "playRequest",
            targetSocketId => {

                if (
                    !targetSocketId ||
                    targetSocketId === socket.id
                ) {
                    return;
                }

                const target =
                    io.sockets.sockets.get(
                        targetSocketId
                    );

                if (!target) {

                    socket.emit(
                        "requestError",
                        "Player is offline."
                    );

                    return;
                }

                /*
                 * Don't allow requests while
                 * already playing.
                 */

                if (
                    socket.data.chessRoom
                ) {

                    socket.emit(
                        "requestError",
                        "You are already in a chess game."
                    );

                    return;
                }

                if (
                    target.data.chessRoom
                ) {

                    socket.emit(
                        "requestError",
                        "That player is already playing."
                    );

                    return;
                }

                const sender =
                    players.get(
                        socket.id
                    );

                if (!sender) {
                    return;
                }

                /*
                 * Send request to exact player.
                 */

                target.emit(
                    "playRequest",
                    {
                        fromSocketId:
                            socket.id,

                        fromPlayerId:
                            sender.playerId
                    }
                );

                console.log(
                    sender.playerId,
                    "requested chess with",
                    players.get(
                        targetSocketId
                    )?.playerId
                );

            }
        );

        /* =====================================================
           ACCEPT REQUEST
        ===================================================== */

        socket.on(
            "acceptRequest",
            fromSocketId => {

                if (
                    !fromSocketId
                ) {
                    return;
                }

                const sender =
                    io.sockets.sockets.get(
                        fromSocketId
                    );

                if (!sender) {

                    socket.emit(
                        "requestError",
                        "Player is no longer online."
                    );

                    return;
                }

                if (
                    socket.data.chessRoom ||
                    sender.data.chessRoom
                ) {

                    socket.emit(
                        "requestError",
                        "One of the players is already in a game."
                    );

                    return;
                }

                /*
                 * Request acceptor becomes BLACK.
                 * Request sender becomes WHITE.
                 */

                const room =
                    createChessRoom(
                        sender,
                        socket
                    );

                if (!room) {

                    socket.emit(
                        "requestError",
                        "Could not create chess room."
                    );

                    return;
                }

                console.log(
                    "Chess room created:",
                    room.roomId
                );

                console.log(
                    "WHITE:",
                    room.white.playerId
                );

                console.log(
                    "BLACK:",
                    room.black.playerId
                );

                sendGameReady(
                    room
                );

            }
        );

        /* =====================================================
           DECLINE REQUEST
        ===================================================== */

        socket.on(
            "declineRequest",
            fromSocketId => {

                const sender =
                    io.sockets.sockets.get(
                        fromSocketId
                    );

                if (sender) {

                    sender.emit(
                        "requestDeclined",
                        {
                            playerId:
                                players.get(
                                    socket.id
                                )?.playerId
                        }
                    );

                }

            }
        );

        /* =====================================================
           CHESS MOVE
        ===================================================== */

        socket.on(
            "chessMove",
            data => {

                const roomId =
                    socket.data.chessRoom;

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

                    socket.emit(
                        "moveError",
                        "Chess room not found."
                    );

                    return;
                }

                const color =
                    socket.data.chessColor;

                const turn =
                    room.game.turn() === "w"
                        ? "white"
                        : "black";

                /*
                 * Turn protection.
                 */

                if (
                    color !== turn
                ) {

                    socket.emit(
                        "moveError",
                        "It is not your turn."
                    );

                    return;
                }

                if (
                    !data ||
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

                    const nextTurn =
                        room.game.turn() === "w"
                            ? "white"
                            : "black";

                    io.to(roomId).emit(
                        "moveMade",
                        {

                            from:
                                move.from,

                            to:
                                move.to,

                            promotion:
                                move.promotion,

                            fen:
                                room.game.fen(),

                            turn:
                                nextTurn,

                            check:
                                room.game.isCheck(),

                            checkmate:
                                room.game.isCheckmate(),

                            stalemate:
                                room.game.isStalemate()

                        }
                    );

                    /*
                     * Game finished.
                     */

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

                }
                catch (error) {

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

        /* =====================================================
           LEAVE CHESS
        ===================================================== */

        socket.on(
            "leaveChess",
            () => {

                leaveChessGame(
                    socket
                );

            }
        );

        /* =====================================================
           DISCONNECT
        ===================================================== */

        socket.on(
            "disconnect",
            () => {

                const player =
                    players.get(
                        socket.id
                    );

                console.log(
                    "Disconnected:",
                    player?.playerId ||
                    socket.id
                );

                /*
                 * Tell opponent if player
                 * was in a chess game.
                 */

                leaveChessGame(
                    socket,
                    true
                );

                /*
                 * Remove only this active
                 * connection.
                 *
                 * The browser keeps its ID
                 * in localStorage, so when
                 * it reconnects it can request
                 * the same ID again.
                 */

                players.delete(
                    socket.id
                );

                sendPlayers();

            }
        );

    }
);

/* =========================================================
   LEAVE CHESS GAME
========================================================= */

function leaveChessGame(
    socket,
    disconnected = false
) {

    const roomId =
        socket.data.chessRoom;

    if (!roomId) {
        return;
    }

    const room =
        chessRooms.get(
            roomId
        );

    /*
     * Clear this player's room data.
     */

    socket.data.chessRoom =
        null;

    socket.data.chessColor =
        null;

    if (!room) {
        return;
    }

    const opponentSocketId =
        room.white.socketId === socket.id
            ? room.black.socketId
            : room.white.socketId;

    const opponent =
        io.sockets.sockets.get(
            opponentSocketId
        );

    if (opponent) {

        opponent.data.chessRoom =
            null;

        opponent.data.chessColor =
            null;

        opponent.emit(
            "opponentLeft",
            {
                playerId:
                    players.get(
                        socket.id
                    )?.playerId ||
                    null
            }
        );

        opponent.leave(
            roomId
        );

    }

    chessRooms.delete(
        roomId
    );

    socket.leave(
        roomId
    );

    console.log(
        "Chess room closed:",
        roomId
    );

}

/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `DuoPlay server running on port ${PORT}`
        );

    }
);