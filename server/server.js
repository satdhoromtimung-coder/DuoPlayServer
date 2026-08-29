const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

/*
 * Serve games.html and chess.html
 * from the same folder as server.js.
 */
app.use(express.static(__dirname));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});


/* =====================================================
   PLAYERS
===================================================== */

const players = new Map();


/*
 * player ID -> current socket ID
 *
 * This lets games.html and chess.html use
 * the SAME DuoPlay player identity.
 */
const playerSockets = new Map();


/* =====================================================
   ROOMS
===================================================== */

const rooms = new Map();


/* =====================================================
   PLAYER ID
===================================================== */

function createPlayerId() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let id = "DP-";

    for (let i = 0; i < 4; i++) {

        id += chars[
            Math.floor(
                Math.random() *
                chars.length
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
        [...players.values()]
            .some(
                player =>
                    player.id === id
            )
    );

    return id;
}


/* =====================================================
   ONLINE PLAYERS
===================================================== */

function broadcastPlayers() {

    const onlinePlayers =
        [...players.values()]
            .map(
                player => ({
                    id:
                        player.id,

                    socketId:
                        player.socketId
                })
            );


    io.emit(
        "players",
        onlinePlayers
    );
}


/* =====================================================
   FIND PLAYER
===================================================== */

function findPlayerById(playerId) {

    for (
        const player of players.values()
    ) {

        if (
            player.id === playerId
        ) {

            return player;

        }

    }

    return null;
}


/* =====================================================
   GET ROOM FOR PLAYER
===================================================== */

function getPlayerRoom(player) {

    if (
        !player ||
        !player.roomId
    ) {

        return null;

    }

    return rooms.get(
        player.roomId
    ) || null;
}


/* =====================================================
   CONNECTION
===================================================== */

io.on(
    "connection",
    socket => {

        console.log(
            "================================"
        );

        console.log(
            "SOCKET CONNECTED:",
            socket.id
        );

        console.log(
            "================================"
        );


        /*
         * games.html can send an existing
         * DuoPlay ID immediately after connecting.
         */

        let currentPlayer = null;


        /* =================================================
           REGISTER / RESTORE PLAYER
        ================================================= */

        socket.on(
            "registerPlayer",
            suppliedPlayerId => {

                console.log(
                    "REGISTER PLAYER:",
                    suppliedPlayerId
                );


                /*
                 * If this is an existing player,
                 * restore that player.
                 */

                if (
                    suppliedPlayerId
                ) {

                    const oldPlayer =
                        findPlayerById(
                            suppliedPlayerId
                        );


                    if (
                        oldPlayer
                    ) {

                        /*
                         * Remove old socket mapping.
                         */

                        if (
                            oldPlayer.socketId &&
                            oldPlayer.socketId !==
                                socket.id
                        ) {

                            playerSockets.delete(
                                oldPlayer.id
                            );

                        }


                        oldPlayer.socketId =
                            socket.id;


                        currentPlayer =
                            oldPlayer;


                        players.delete(
                            oldPlayer.oldSocketId
                        );


                        players.set(
                            socket.id,
                            oldPlayer
                        );


                        playerSockets.set(
                            oldPlayer.id,
                            socket.id
                        );


                        /*
                         * Rejoin existing room.
                         */

                        if (
                            oldPlayer.roomId
                        ) {

                            const room =
                                rooms.get(
                                    oldPlayer.roomId
                                );


                            if (
                                room
                            ) {

                                socket.join(
                                    room.id
                                );


                                console.log(
                                    "RESTORED ROOM:",
                                    room.id
                                );

                            }

                        }


                        socket.emit(
                            "yourId",
                            oldPlayer.id
                        );


                        broadcastPlayers();

                        return;

                    }

                }


                /*
                 * Create new player.
                 */

                const playerId =
                    getUniquePlayerId();


                const player = {

                    id:
                        playerId,

                    socketId:
                        socket.id,

                    roomId:
                        null

                };


                players.set(
                    socket.id,
                    player
                );


                playerSockets.set(
                    playerId,
                    socket.id
                );


                currentPlayer =
                    player;


                socket.emit(
                    "yourId",
                    playerId
                );


                broadcastPlayers();

            }
        );


        /* =================================================
           AUTOMATIC ID
        ================================================= */

        /*
         * If games.html doesn't send registerPlayer,
         * create a normal player automatically.
         */

        const playerId =
            getUniquePlayerId();


        const player = {

            id:
                playerId,

            socketId:
                socket.id,

            roomId:
                null

        };


        players.set(
            socket.id,
            player
        );


        playerSockets.set(
            playerId,
            socket.id
        );


        currentPlayer =
            player;


        socket.emit(
            "yourId",
            playerId
        );


        broadcastPlayers();


        /* =================================================
           PLAY REQUEST
        ================================================= */

        socket.on(
            "playRequest",
            targetSocketId => {

                console.log(
                    "PLAY REQUEST:",
                    socket.id,
                    "→",
                    targetSocketId
                );


                const sender =
                    players.get(
                        socket.id
                    );


                const target =
                    players.get(
                        targetSocketId
                    );


                if (
                    !sender ||
                    !target
                ) {

                    socket.emit(
                        "requestError",
                        "That player is no longer online."
                    );

                    return;

                }


                if (
                    targetSocketId ===
                    socket.id
                ) {

                    return;

                }


                if (
                    sender.roomId ||
                    target.roomId
                ) {

                    socket.emit(
                        "requestError",
                        "One of the players is already in a game."
                    );

                    return;

                }


                io.to(
                    targetSocketId
                ).emit(
                    "playRequest",
                    {

                        fromSocketId:
                            socket.id,

                        fromId:
                            sender.id

                    }
                );


                console.log(
                    "REQUEST SENT TO:",
                    target.id
                );

            }
        );


        /* =================================================
           ACCEPT REQUEST
        ================================================= */

        socket.on(
            "acceptRequest",
            fromSocketId => {

                console.log(
                    "================================"
                );

                console.log(
                    "ACCEPT REQUEST"
                );

                console.log(
                    "REQUESTER:",
                    fromSocketId
                );

                console.log(
                    "ACCEPTER:",
                    socket.id
                );

                console.log(
                    "================================"
                );


                const player1 =
                    players.get(
                        fromSocketId
                    );


                const player2 =
                    players.get(
                        socket.id
                    );


                if (
                    !player1 ||
                    !player2
                ) {

                    console.log(
                        "PLAYER NOT FOUND"
                    );


                    socket.emit(
                        "requestError",
                        "Player is no longer online."
                    );

                    return;

                }


                if (
                    player1.roomId ||
                    player2.roomId
                ) {

                    socket.emit(
                        "requestError",
                        "One of the players is already in a game."
                    );

                    return;

                }


                /* =========================================
                   CREATE ROOM
                ========================================= */

                const roomId =
                    "ROOM-" +
                    Math.random()
                        .toString(36)
                        .substring(2, 8)
                        .toUpperCase();


                const chess =
                    new Chess();


                const room = {

                    id:
                        roomId,

                    chess:
                        chess,

                    players: {

                        white:
                            player1.id,

                        black:
                            player2.id

                    }

                };


                rooms.set(
                    roomId,
                    room
                );


                player1.roomId =
                    roomId;

                player2.roomId =
                    roomId;


                console.log(
                    "ROOM CREATED:",
                    roomId
                );


                console.log(
                    "WHITE:",
                    player1.id
                );


                console.log(
                    "BLACK:",
                    player2.id
                );


                /*
                 * Both current sockets join the room.
                 */

                socket.join(
                    roomId
                );


                const opponentSocket =
                    io.sockets.sockets.get(
                        player1.socketId
                    );


                if (
                    opponentSocket
                ) {

                    opponentSocket.join(
                        roomId
                    );

                }


                /* =========================================
                   GAME DATA
                ========================================= */

                const gameData = {

                    roomId:
                        roomId,

                    white: {

                        id:
                            player1.id

                    },

                    black: {

                        id:
                            player2.id

                    },

                    turn:
                        "w",

                    fen:
                        chess.fen(),

                    history:
                        []

                };


                /*
                 * Send directly to both current sockets.
                 */

                io.to(
                    player1.socketId
                ).emit(
                    "gameReady",
                    gameData
                );


                io.to(
                    player2.socketId
                ).emit(
                    "gameReady",
                    gameData
                );


                console.log(
                    "GAME READY SENT"
                );

            }
        );


        /* =================================================
           DECLINE
        ================================================= */

        socket.on(
            "declineRequest",
            fromSocketId => {

                io.to(
                    fromSocketId
                ).emit(
                    "requestDeclined"
                );

            }
        );


        /* =================================================
           CHESS MOVE
        ================================================= */

        socket.on(
            "chessMove",
            data => {

                const player =
                    players.get(
                        socket.id
                    );


                if (
                    !player ||
                    !player.roomId
                ) {

                    socket.emit(
                        "moveError",
                        "You are not in a chess game."
                    );

                    return;

                }


                const room =
                    rooms.get(
                        player.roomId
                    );


                if (!room) {

                    socket.emit(
                        "moveError",
                        "Chess room no longer exists."
                    );

                    return;

                }


                let playerColor =
                    null;


                if (
                    room.players.white ===
                    player.id
                ) {

                    playerColor =
                        "w";

                }


                if (
                    room.players.black ===
                    player.id
                ) {

                    playerColor =
                        "b";

                }


                if (!playerColor) {

                    socket.emit(
                        "moveError",
                        "You are not assigned to this game."
                    );

                    return;

                }


                if (
                    room.chess.turn() !==
                    playerColor
                ) {

                    socket.emit(
                        "moveError",
                        "It is not your turn."
                    );

                    return;

                }


                let move;


                try {

                    move =
                        room.chess.move({

                            from:
                                data.from,

                            to:
                                data.to,

                            promotion:
                                data.promotion ||
                                "q"

                        });

                }
                catch (
                    error
                ) {

                    socket.emit(
                        "moveError",
                        "Illegal move."
                    );

                    return;

                }


                if (!move) {

                    socket.emit(
                        "moveError",
                        "Illegal move."
                    );

                    return;

                }


                const moveData = {

                    from:
                        move.from,

                    to:
                        move.to,

                    promotion:
                        move.promotion ||
                        null,

                    fen:
                        room.chess.fen(),

                    turn:
                        room.chess.turn(),

                    history:
                        room.chess.history(),

                    gameOver:
                        room.chess.isGameOver(),

                    checkmate:
                        room.chess.isCheckmate(),

                    stalemate:
                        room.chess.isStalemate(),

                    check:
                        room.chess.isCheck()

                };


                /*
                 * Send to both players.
                 */

                io.to(
                    room.id
                ).emit(
                    "moveMade",
                    moveData
                );


                if (
                    room.chess.isGameOver()
                ) {

                    let result =
                        "draw";


                    if (
                        room.chess.isCheckmate()
                    ) {

                        result =
                            room.chess.turn() ===
                            "w"
                                ? "black"
                                : "white";

                    }


                    io.to(
                        room.id
                    ).emit(
                        "gameFinished",
                        {
                            result:
                                result
                        }
                    );

                }

            }
        );


        /* =================================================
           GET GAME STATE
        ================================================= */

        socket.on(
            "getGameState",
            () => {

                const player =
                    players.get(
                        socket.id
                    );


                if (
                    !player
                ) {

                    socket.emit(
                        "gameStateError",
                        "Player not registered."
                    );

                    return;

                }


                if (
                    !player.roomId
                ) {

                    socket.emit(
                        "gameStateError",
                        "No chess room found."
                    );

                    return;

                }


                const room =
                    rooms.get(
                        player.roomId
                    );


                if (!room) {

                    socket.emit(
                        "gameStateError",
                        "Chess room no longer exists."
                    );

                    return;

                }


                socket.join(
                    room.id
                );


                socket.emit(
                    "gameState",
                    {

                        roomId:
                            room.id,

                        fen:
                            room.chess.fen(),

                        turn:
                            room.chess.turn(),

                        history:
                            room.chess.history()

                    }
                );

            }
        );


        /* =================================================
           REJOIN ROOM
        ================================================= */

        socket.on(
            "rejoinGame",
            playerId => {

                console.log(
                    "REJOIN GAME:",
                    playerId
                );


                const player =
                    findPlayerById(
                        playerId
                    );


                if (
                    !player
                ) {

                    socket.emit(
                        "gameStateError",
                        "Player ID not found."
                    );

                    return;

                }


                /*
                 * Move player to new socket.
                 */

                players.delete(
                    player.socketId
                );


                player.socketId =
                    socket.id;


                players.set(
                    socket.id,
                    player
                );


                playerSockets.set(
                    player.id,
                    socket.id
                );


                currentPlayer =
                    player;


                if (
                    player.roomId
                ) {

                    const room =
                        rooms.get(
                            player.roomId
                        );


                    if (
                        room
                    ) {

                        socket.join(
                            room.id
                        );


                        socket.emit(
                            "gameReady",
                            {

                                roomId:
                                    room.id,

                                white: {

                                    id:
                                        room.players.white

                                },

                                black: {

                                    id:
                                        room.players.black

                                },

                                turn:
                                    room.chess.turn(),

                                fen:
                                    room.chess.fen(),

                                history:
                                    room.chess.history()

                            }
                        );


                        console.log(
                            "GAME REJOINED:",
                            room.id
                        );

                    }

                }

            }
        );


        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            () => {

                const disconnectedPlayer =
                    players.get(
                        socket.id
                    );


                if (
                    !disconnectedPlayer
                ) {

                    return;

                }


                console.log(
                    "DISCONNECTED:",
                    disconnectedPlayer.id
                );


                /*
                 * IMPORTANT:
                 *
                 * Do NOT immediately destroy the room.
                 *
                 * The player may simply be moving
                 * from games.html to chess.html.
                 */

                if (
                    disconnectedPlayer.roomId
                ) {

                    const room =
                        rooms.get(
                            disconnectedPlayer.roomId
                        );


                    if (
                        room
                    ) {

                        /*
                         * Give the player time to reconnect.
                         */

                        setTimeout(
                            () => {

                                const stillPlayer =
                                    players.get(
                                        socket.id
                                    );


                                if (
                                    stillPlayer &&
                                    stillPlayer.socketId ===
                                        socket.id
                                ) {

                                    socket.to(
                                        room.id
                                    ).emit(
                                        "opponentDisconnected"
                                    );

                                }

                            },
                            10000
                        );

                    }

                }


                players.delete(
                    socket.id
                );


                broadcastPlayers();

            }
        );

    }
);


/* =====================================================
   SERVER TEST
===================================================== */

app.get(
    "/",
    (req, res) => {

        res.send(
            "DuoPlay multiplayer server is running."
        );

    }
);


/* =====================================================
   START
===================================================== */

const PORT =
    process.env.PORT ||
    3000;


server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "================================"
        );

        console.log(
            "DuoPlay server running"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "================================"
        );

    }
);