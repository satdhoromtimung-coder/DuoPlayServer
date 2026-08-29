const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

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
   PLAYERS
========================================================= */

/*
    Active players:

    socket.id -> {
        playerId,
        socketId
    }
*/

const players = new Map();

/*
    Player IDs currently assigned to active sockets.

    playerId -> socketId
*/

const playerSockets = new Map();

/* =========================================================
   PLAYER ID
========================================================= */

function generatePlayerId() {
    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let id = "DP-";

    for (let i = 0; i < 4; i++) {
        id += chars[
            Math.floor(Math.random() * chars.length)
        ];
    }

    return id;
}

function createUniquePlayerId() {
    let id;

    do {
        id = generatePlayerId();
    } while (playerSockets.has(id));

    return id;
}

/* =========================================================
   NORMALIZE ID
========================================================= */

function cleanPlayerId(id) {
    if (
        typeof id !== "string" ||
        !id.trim()
    ) {
        return null;
    }

    return id
        .trim()
        .toUpperCase();
}

/* =========================================================
   SEND ALL ONLINE PLAYERS
========================================================= */

function sendPlayers() {
    const list = [...players.values()].map(player => ({
        playerId: player.playerId,
        socketId: player.socketId
    }));

    io.emit("players", list);

    console.log(
        `Online players: ${list.length}`
    );
}

/* =========================================================
   CHESS ROOMS
========================================================= */

const chessRooms = new Map();

/*
    roomId -> {

        roomId,
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
    } while (chessRooms.has(roomId));

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
        players.get(whiteSocket.id);

    const blackPlayer =
        players.get(blackSocket.id);

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
            socketId: whiteSocket.id,
            playerId: whitePlayer.playerId
        },

        black: {
            socketId: blackSocket.id,
            playerId: blackPlayer.playerId
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

        turn:
            "white",

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
   CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

        console.log(
            "Connected:",
            socket.id
        );

        let requestedId =
            cleanPlayerId(
                socket.handshake.auth?.playerId
            );

        /*
            =================================================
            PERMANENT ID LOGIC

            If browser already has an ID:

            - keep that ID
            - if an old socket is still connected,
              disconnect the old socket
            - transfer the ID to the new socket

            This prevents a refresh from creating
            a different ID.
            =================================================
        */

        let playerId =
            requestedId;

        if (playerId) {

            const oldSocketId =
                playerSockets.get(
                    playerId
                );

            if (
                oldSocketId &&
                oldSocketId !== socket.id
            ) {

                const oldSocket =
                    io.sockets.sockets.get(
                        oldSocketId
                    );

                if (oldSocket) {

                    console.log(
                        `Replacing old connection for ${playerId}`
                    );

                    /*
                        If old connection is in
                        a Chess game, tell its
                        opponent first.
                    */

                    leaveChessGame(
                        oldSocket,
                        true
                    );

                    oldSocket.disconnect(
                        true
                    );
                }

                players.delete(
                    oldSocketId
                );

                playerSockets.delete(
                    playerId
                );
            }

        }
        else {

            playerId =
                createUniquePlayerId();

        }

        /*
            Safety check.
        */

        if (
            playerSockets.has(playerId)
        ) {

            playerId =
                createUniquePlayerId();

        }

        /*
            Register player.
        */

        players.set(
            socket.id,
            {
                playerId,
                socketId: socket.id
            }
        );

        playerSockets.set(
            playerId,
            socket.id
        );

        socket.data.playerId =
            playerId;

        socket.data.chessRoom =
            null;

        socket.data.chessColor =
            null;

        /*
            Send permanent ID.
        */

        socket.emit(
            "yourId",
            playerId
        );

        /*
            Send complete player list
            to EVERY connected player.
        */

        sendPlayers();

        console.log(
            `Player online: ${playerId}`
        );

        /* =====================================================
           IDENTIFY
        ===================================================== */

        socket.on(
            "identify",
            requestedId => {

                const cleanId =
                    cleanPlayerId(
                        requestedId
                    );

                if (!cleanId) {
                    return;
                }

                /*
                    If the requested ID is
                    already assigned to another
                    socket, transfer it instead
                    of generating a new ID.
                */

                const oldSocketId =
                    playerSockets.get(
                        cleanId
                    );

                if (
                    oldSocketId &&
                    oldSocketId !== socket.id
                ) {

                    const oldSocket =
                        io.sockets.sockets.get(
                            oldSocketId
                        );

                    if (oldSocket) {

                        leaveChessGame(
                            oldSocket,
                            true
                        );

                        oldSocket.disconnect(
                            true
                        );

                    }

                    players.delete(
                        oldSocketId
                    );

                    playerSockets.delete(
                        cleanId
                    );

                }

                const player =
                    players.get(
                        socket.id
                    );

                if (!player) {
                    return;
                }

                /*
                    Remove previous mapping.
                */

                playerSockets.delete(
                    player.playerId
                );

                /*
                    Keep requested permanent ID.
                */

                player.playerId =
                    cleanId;

                playerSockets.set(
                    cleanId,
                    socket.id
                );

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
           GET PLAYERS
        ===================================================== */

        socket.on(
            "getPlayers",
            () => {

                const list =
                    [...players.values()].map(
                        player => ({
                            playerId:
                                player.playerId,

                            socketId:
                                player.socketId
                        })
                    );

                socket.emit(
                    "players",
                    list
                );

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
                    Sender already playing?
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

                /*
                    Target already playing?
                */

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

                const targetPlayer =
                    players.get(
                        targetSocketId
                    );

                if (
                    !sender ||
                    !targetPlayer
                ) {
                    return;
                }

                /*
                    Send request ONLY to selected
                    player.
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
                    `${sender.playerId} requested Chess with ${targetPlayer.playerId}`
                );

            }
        );

        /* =====================================================
           ACCEPT REQUEST
        ===================================================== */

        socket.on(
            "acceptRequest",
            fromSocketId => {

                if (!fromSocketId) {
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

                /*
                    Both must be free.
                */

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
                    Request sender = WHITE
                    Request accepter = BLACK
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
                    "================================="
                );

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

                console.log(
                    "================================="
                );

                sendGameReady(
                    room
                );

                /*
                    Refresh online list because
                    both players are now playing.
                */

                sendPlayers();

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

                if (!sender) {
                    return;
                }

                sender.emit(
                    "requestDeclined",
                    {
                        playerId:
                            players.get(
                                socket.id
                            )?.playerId ||
                            null
                    }
                );

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
                    Turn protection.
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
                        Game over.
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
                    Tell opponent.
                */

                leaveChessGame(
                    socket,
                    true
                );

                /*
                    Remove this socket.
                */

                players.delete(
                    socket.id
                );

                /*
                    Remove ID mapping ONLY if
                    it still belongs to this socket.
                */

                if (
                    player &&
                    playerSockets.get(
                        player.playerId
                    ) === socket.id
                ) {

                    playerSockets.delete(
                        player.playerId
                    );

                }

                /*
                    Update EVERYONE.
                */

                sendPlayers();

                console.log(
                    `Online players after disconnect: ${players.size}`
                );

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
        Clear player's room data.
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

    /*
        If someone simply left Chess,
        update the player list.
    */

    if (!disconnected) {
        sendPlayers();
    }

}

/* =========================================================
   START SERVER
========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `DuoPlay server running on port ${PORT}`
        );

    }
);