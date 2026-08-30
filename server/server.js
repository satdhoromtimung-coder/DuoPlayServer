const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

/* =========================================================
   DATA
========================================================= */

// playerId -> player
const players = new Map();

// socketId -> playerId
const socketToPlayer = new Map();

// challengeId -> challenge
const challenges = new Map();

// gameId -> chess game
const chessGames = new Map();


/* =========================================================
   SERVER ROUTES
========================================================= */

app.get("/", (req, res) => {
    res.send("DuoPlay server is running.");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        onlinePlayers: getOnlinePlayers().length,
        chessGames: chessGames.size
    });
});


/* =========================================================
   PLAYER ID
========================================================= */

function generatePlayerId() {
    let id;

    do {
        id =
            "DP-" +
            Math.floor(
                100000 + Math.random() * 900000
            );
    } while (players.has(id));

    return id;
}


/* =========================================================
   ONLINE PLAYERS
========================================================= */

function getOnlinePlayers() {
    return [...players.values()]
        .filter(player => player.online)
        .map(player => ({
            playerId: player.playerId,
            socketId: player.socketId,
            inGame: !!player.gameId
        }));
}


function broadcastPlayers() {
    io.emit(
        "players-online",
        getOnlinePlayers()
    );
}


/* =========================================================
   PLAYER LOOKUP
========================================================= */

function getPlayerBySocket(socketId) {
    const playerId =
        socketToPlayer.get(socketId);

    if (!playerId) {
        return null;
    }

    return players.get(playerId) || null;
}


/* =========================================================
   GAME ID
========================================================= */

function generateGameId() {
    let id;

    do {
        id =
            "chess-" +
            Date.now() +
            "-" +
            Math.random()
                .toString(36)
                .substring(2, 8);
    } while (chessGames.has(id));

    return id;
}


/* =========================================================
   CHALLENGE ID
========================================================= */

function generateChallengeId() {
    return (
        "challenge-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 8)
    );
}


/* =========================================================
   CONNECTION
========================================================= */

io.on("connection", (socket) => {

    console.log(
        "Socket connected:",
        socket.id
    );


    /* =====================================================
       REGISTER PLAYER
    ===================================================== */

    socket.on(
        "register-player",
        (savedPlayerId) => {

            let playerId = null;

            /*
             * If the browser already has an ID,
             * keep that exact ID.
             */

            if (
                typeof savedPlayerId === "string" &&
                /^DP-\d{6}$/.test(savedPlayerId)
            ) {

                const existing =
                    players.get(savedPlayerId);

                if (existing) {

                    /*
                     * Refresh/reconnect:
                     * update the socket but KEEP ID.
                     */

                    if (
                        existing.socketId &&
                        existing.socketId !== socket.id
                    ) {

                        const oldSocket =
                            io.sockets.sockets.get(
                                existing.socketId
                            );

                        if (oldSocket) {
                            oldSocket.disconnect(true);
                        }

                        socketToPlayer.delete(
                            existing.socketId
                        );
                    }

                    playerId =
                        savedPlayerId;

                    existing.socketId =
                        socket.id;

                    existing.online =
                        true;

                } else {

                    playerId =
                        savedPlayerId;

                    players.set(
                        playerId,
                        {
                            playerId,
                            socketId: socket.id,
                            online: true,
                            gameId: null
                        }
                    );
                }

            } else {

                /*
                 * New browser/player.
                 */

                playerId =
                    generatePlayerId();

                players.set(
                    playerId,
                    {
                        playerId,
                        socketId: socket.id,
                        online: true,
                        gameId: null
                    }
                );
            }


            socketToPlayer.set(
                socket.id,
                playerId
            );

            socket.data.playerId =
                playerId;


            /*
             * Send ID to this browser.
             */

            socket.emit(
                "player-registered",
                {
                    playerId
                }
            );


            /*
             * Send complete online list
             * to EVERYONE.
             */

            broadcastPlayers();


            console.log(
                `Player online: ${playerId}`
            );
        }
    );


    /* =====================================================
       REQUEST ONLINE PLAYERS
    ===================================================== */

    socket.on(
        "get-online-players",
        () => {

            socket.emit(
                "players-online",
                getOnlinePlayers()
            );
        }
    );


    /* =====================================================
       CHALLENGE PLAYER
    ===================================================== */

    socket.on(
        "challenge-player",
        (targetPlayerId) => {

            const sender =
                getPlayerBySocket(socket.id);

            if (!sender) {
                socket.emit(
                    "error-message",
                    "You are not registered."
                );
                return;
            }


            const target =
                players.get(targetPlayerId);


            if (!target || !target.online) {

                socket.emit(
                    "error-message",
                    "That player is offline."
                );

                return;
            }


            if (
                sender.playerId ===
                target.playerId
            ) {

                socket.emit(
                    "error-message",
                    "You cannot play yourself."
                );

                return;
            }


            if (sender.gameId) {

                socket.emit(
                    "error-message",
                    "You are already playing Chess."
                );

                return;
            }


            if (target.gameId) {

                socket.emit(
                    "error-message",
                    "That player is already playing Chess."
                );

                return;
            }


            const challengeId =
                generateChallengeId();


            challenges.set(
                challengeId,
                {
                    challengeId,
                    fromPlayerId:
                        sender.playerId,
                    toPlayerId:
                        target.playerId,
                    status: "pending",
                    createdAt: Date.now()
                }
            );


            const targetSocket =
                io.sockets.sockets.get(
                    target.socketId
                );


            if (!targetSocket) {

                socket.emit(
                    "error-message",
                    "That player disconnected."
                );

                challenges.delete(
                    challengeId
                );

                return;
            }


            /*
             * Send challenge ONLY
             * to selected player.
             */

            targetSocket.emit(
                "chess-challenge",
                {
                    challengeId,
                    fromPlayerId:
                        sender.playerId
                }
            );


            socket.emit(
                "challenge-sent",
                {
                    challengeId,
                    targetPlayerId:
                        target.playerId
                }
            );


            console.log(
                `${sender.playerId} challenged ${target.playerId}`
            );
        }
    );


    /* =====================================================
       ACCEPT CHALLENGE
    ===================================================== */

    socket.on(
        "accept-challenge",
        (challengeId) => {

            const accepter =
                getPlayerBySocket(socket.id);

            if (!accepter) {
                return;
            }


            const challenge =
                challenges.get(
                    challengeId
                );


            if (!challenge) {

                socket.emit(
                    "error-message",
                    "Challenge expired."
                );

                return;
            }


            if (
                challenge.status !==
                "pending"
            ) {

                socket.emit(
                    "error-message",
                    "Challenge already used."
                );

                return;
            }


            if (
                challenge.toPlayerId !==
                accepter.playerId
            ) {

                socket.emit(
                    "error-message",
                    "This challenge is not for you."
                );

                return;
            }


            const challenger =
                players.get(
                    challenge.fromPlayerId
                );


            if (
                !challenger ||
                !challenger.online
            ) {

                socket.emit(
                    "error-message",
                    "The other player is offline."
                );

                challenges.delete(
                    challengeId
                );

                return;
            }


            if (
                challenger.gameId ||
                accepter.gameId
            ) {

                socket.emit(
                    "error-message",
                    "One player is already in a game."
                );

                return;
            }


            const challengerSocket =
                io.sockets.sockets.get(
                    challenger.socketId
                );


            if (!challengerSocket) {

                socket.emit(
                    "error-message",
                    "The other player disconnected."
                );

                return;
            }


            /*
             * Challenge accepted.
             */

            challenge.status =
                "accepted";


            /*
             * Create ONE shared Chess game.
             */

            const gameId =
                generateGameId();


            const game = {
                gameId,

                whitePlayerId:
                    challenger.playerId,

                blackPlayerId:
                    accepter.playerId,

                whiteSocketId:
                    challenger.socketId,

                blackSocketId:
                    accepter.socketId,

                turn: "white",

                moves: [],

                createdAt: Date.now()
            };


            chessGames.set(
                gameId,
                game
            );


            /*
             * Store game ID for both players.
             */

            challenger.gameId =
                gameId;

            accepter.gameId =
                gameId;


            /*
             * Put both sockets in the
             * SAME Socket.IO room.
             */

            challengerSocket.join(
                gameId
            );

            socket.join(
                gameId
            );


            /*
             * Tell Challenger:
             * YOU ARE WHITE.
             */

            challengerSocket.emit(
                "chess-game-start",
                {
                    gameId,
                    playerId:
                        challenger.playerId,
                    opponentId:
                        accepter.playerId,
                    color: "white",
                    turn: "white"
                }
            );


            /*
             * Tell Accepter:
             * YOU ARE BLACK.
             */

            socket.emit(
                "chess-game-start",
                {
                    gameId,
                    playerId:
                        accepter.playerId,
                    opponentId:
                        challenger.playerId,
                    color: "black",
                    turn: "white"
                }
            );


            /*
             * Remove used challenge.
             */

            challenges.delete(
                challengeId
            );


            broadcastPlayers();


            console.log(
                "================================"
            );

            console.log(
                "CHESS GAME CREATED"
            );

            console.log(
                "Game:",
                gameId
            );

            console.log(
                "WHITE:",
                challenger.playerId
            );

            console.log(
                "BLACK:",
                accepter.playerId
            );

            console.log(
                "================================"
            );
        }
    );


    /* =====================================================
       REJECT CHALLENGE
    ===================================================== */

    socket.on(
        "reject-challenge",
        (challengeId) => {

            const player =
                getPlayerBySocket(socket.id);

            const challenge =
                challenges.get(
                    challengeId
                );

            if (
                !player ||
                !challenge
            ) {
                return;
            }


            if (
                challenge.toPlayerId !==
                player.playerId
            ) {
                return;
            }


            const challenger =
                players.get(
                    challenge.fromPlayerId
                );


            challenge.status =
                "rejected";


            if (
                challenger &&
                challenger.online
            ) {

                const challengerSocket =
                    io.sockets.sockets.get(
                        challenger.socketId
                    );

                if (challengerSocket) {

                    challengerSocket.emit(
                        "challenge-rejected",
                        {
                            challengeId
                        }
                    );
                }
            }


            challenges.delete(
                challengeId
            );
        }
    );


    /* =====================================================
       JOIN CHESS GAME
    ===================================================== */

    socket.on(
        "join-chess-game",
        (gameId) => {

            const player =
                getPlayerBySocket(socket.id);

            if (!player) {
                return;
            }


            const game =
                chessGames.get(
                    gameId
                );


            if (!game) {

                socket.emit(
                    "chess-game-error",
                    {
                        message:
                            "Chess game does not exist."
                    }
                );

                return;
            }


            const isWhite =
                game.whitePlayerId ===
                player.playerId;

            const isBlack =
                game.blackPlayerId ===
                player.playerId;


            if (!isWhite && !isBlack) {

                socket.emit(
                    "chess-game-error",
                    {
                        message:
                            "You are not part of this Chess game."
                    }
                );

                return;
            }


            socket.join(
                gameId
            );


            socket.emit(
                "chess-game-joined",
                {
                    gameId,
                    playerId:
                        player.playerId,
                    opponentId:
                        isWhite
                            ? game.blackPlayerId
                            : game.whitePlayerId,
                    color:
                        isWhite
                            ? "white"
                            : "black",
                    turn:
                        game.turn,
                    moves:
                        game.moves
                }
            );
        }
    );


    /* =====================================================
       CHESS MOVE
    ===================================================== */

    socket.on(
        "chess-move",
        (data) => {

            if (
                !data ||
                !data.gameId ||
                !data.move
            ) {
                return;
            }


            const player =
                getPlayerBySocket(socket.id);

            const game =
                chessGames.get(
                    data.gameId
                );


            if (!player || !game) {
                return;
            }


            /*
             * Player must belong to game.
             */

            const isWhite =
                game.whitePlayerId ===
                player.playerId;

            const isBlack =
                game.blackPlayerId ===
                player.playerId;


            if (!isWhite && !isBlack) {
                return;
            }


            /*
             * Check turn.
             */

            const expectedPlayer =
                game.turn === "white"
                    ? game.whitePlayerId
                    : game.blackPlayerId;


            if (
                player.playerId !==
                expectedPlayer
            ) {

                socket.emit(
                    "chess-move-error",
                    {
                        message:
                            "It is not your turn."
                    }
                );

                return;
            }


            /*
             * Store move.

             * The actual chess legality
             * is handled by chess.html.
             */

            game.moves.push(
                data.move
            );


            /*
             * Change turn.
             */

            game.turn =
                game.turn === "white"
                    ? "black"
                    : "white";


            /*
             * Send move to opponent.
             */

            socket.to(
                data.gameId
            ).emit(
                "opponent-move",
                {
                    move:
                        data.move,
                    fromPlayerId:
                        player.playerId
                }
            );


            /*
             * Tell both players whose
             * turn it is.
             */

            io.to(
                data.gameId
            ).emit(
                "chess-turn",
                {
                    turn:
                        game.turn
                }
            );
        }
    );


    /* =====================================================
       FINISH CHESS GAME
    ===================================================== */

    socket.on(
        "chess-game-finished",
        (data) => {

            if (
                !data ||
                !data.gameId
            ) {
                return;
            }


            const game =
                chessGames.get(
                    data.gameId
                );


            if (!game) {
                return;
            }


            io.to(
                data.gameId
            ).emit(
                "chess-game-finished",
                {
                    gameId:
                        data.gameId,

                    winner:
                        data.winner
                }
            );


            const whitePlayer =
                players.get(
                    game.whitePlayerId
                );

            const blackPlayer =
                players.get(
                    game.blackPlayerId
                );


            if (whitePlayer) {
                whitePlayer.gameId =
                    null;
            }

            if (blackPlayer) {
                blackPlayer.gameId =
                    null;
            }


            chessGames.delete(
                data.gameId
            );


            broadcastPlayers();


            console.log(
                "Chess game finished:",
                data.gameId
            );
        }
    );


    /* =====================================================
       LEAVE CHESS GAME
    ===================================================== */

    socket.on(
        "leave-chess-game",
        () => {

            const player =
                getPlayerBySocket(socket.id);

            if (!player || !player.gameId) {
                return;
            }


            const gameId =
                player.gameId;

            const game =
                chessGames.get(
                    gameId
                );


            if (!game) {
                player.gameId =
                    null;

                broadcastPlayers();
                return;
            }


            const opponentId =
                game.whitePlayerId ===
                player.playerId
                    ? game.blackPlayerId
                    : game.whitePlayerId;


            const opponent =
                players.get(
                    opponentId
                );


            if (opponent) {
                opponent.gameId =
                    null;
            }


            player.gameId =
                null;


            io.to(
                gameId
            ).emit(
                "opponent-left",
                {
                    playerId:
                        player.playerId
                }
            );


            chessGames.delete(
                gameId
            );


            broadcastPlayers();
        }
    );


    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        () => {

            const playerId =
                socketToPlayer.get(
                    socket.id
                );


            if (!playerId) {
                return;
            }


            const player =
                players.get(
                    playerId
                );


            if (!player) {
                return;
            }


            /*
             * Mark offline.
             *
             * DO NOT DELETE THE PLAYER ID.
             *
             * This allows the browser to reconnect
             * using the same saved ID.
             */

            player.online =
                false;


            /*
             * If the player was in Chess,
             * close the game.
             */

            if (player.gameId) {

                const gameId =
                    player.gameId;

                const game =
                    chessGames.get(
                        gameId
                    );


                if (game) {

                    const opponentId =
                        game.whitePlayerId ===
                        player.playerId
                            ? game.blackPlayerId
                            : game.whitePlayerId;


                    const opponent =
                        players.get(
                            opponentId
                        );


                    if (opponent) {

                        opponent.gameId =
                            null;

                        if (opponent.online) {

                            const opponentSocket =
                                io.sockets.sockets.get(
                                    opponent.socketId
                                );

                            if (opponentSocket) {

                                opponentSocket.emit(
                                    "opponent-left",
                                    {
                                        playerId
                                    }
                                );
                            }
                        }
                    }


                    chessGames.delete(
                        gameId
                    );

                    player.gameId =
                        null;
                }
            }


            socketToPlayer.delete(
                socket.id
            );


            broadcastPlayers();


            console.log(
                `Player offline: ${playerId}`
            );


            /*
             * Keep the ID for 10 minutes.
             *
             * If the browser reconnects during this
             * period, it gets the SAME ID.
             */

            setTimeout(
                () => {

                    const current =
                        players.get(
                            playerId
                        );

                    if (
                        current &&
                        !current.online
                    ) {

                        players.delete(
                            playerId
                        );

                        console.log(
                            `Removed expired player: ${playerId}`
                        );

                        broadcastPlayers();
                    }

                },
                10 * 60 * 1000
            );
        }
    );

});


/* =========================================================
   CLEAN OLD CHALLENGES
========================================================= */

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                challengeId,
                challenge
            ] of challenges
        ) {

            if (
                now -
                challenge.createdAt >
                5 * 60 * 1000
            ) {

                challenges.delete(
                    challengeId
                );
            }
        }

    },
    60 * 1000
);


/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `DuoPlay server running on port ${PORT}`
        );

    }
);