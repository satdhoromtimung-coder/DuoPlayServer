const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --------------------------------------------------
// BASIC SERVER
// --------------------------------------------------

app.get("/", (req, res) => {
    res.send("DuoPlay multiplayer server is running.");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "DuoPlay",
        players: players.size,
        games: chessGames.size
    });
});

// --------------------------------------------------
// PLAYER DATA
// --------------------------------------------------

/*
    players:

    playerId -> {
        playerId,
        socketId,
        connected
    }

    The PLAYER ID belongs to the user.

    The client should save this ID in localStorage.
    Therefore refreshing the page does not create
    another ID.
*/

const players = new Map();

// socketId -> playerId
const socketPlayers = new Map();

// --------------------------------------------------
// CHALLENGES
// --------------------------------------------------

/*
    challengeId -> {
        from,
        to,
        status
    }
*/

const challenges = new Map();

// --------------------------------------------------
// CHESS GAMES
// --------------------------------------------------

/*
    gameId -> {
        gameId,
        white,
        black,
        whiteSocket,
        blackSocket,
        turn
    }
*/

const chessGames = new Map();


// --------------------------------------------------
// CREATE PLAYER ID
// --------------------------------------------------

function createPlayerId() {
    let id;

    do {
        id = Math.floor(100000 + Math.random() * 900000).toString();
    } while (players.has(id));

    return id;
}


// --------------------------------------------------
// FIND PLAYER BY SOCKET
// --------------------------------------------------

function getPlayerId(socket) {
    return socketPlayers.get(socket.id);
}


// --------------------------------------------------
// GET ONLINE PLAYERS
// --------------------------------------------------

function getOnlinePlayers() {
    const result = [];

    for (const player of players.values()) {
        if (player.connected) {
            result.push({
                playerId: player.playerId
            });
        }
    }

    return result;
}


// --------------------------------------------------
// SEND ONLINE PLAYER LIST
// --------------------------------------------------

function updateOnlinePlayers() {
    io.emit("players-online", getOnlinePlayers());
}


// --------------------------------------------------
// SOCKET CONNECTION
// --------------------------------------------------

io.on("connection", (socket) => {

    console.log("Socket connected:", socket.id);


    // --------------------------------------------------
    // REGISTER PLAYER
    // --------------------------------------------------

    socket.on("register-player", (requestedId) => {

        let playerId = null;

        if (
            typeof requestedId === "string" &&
            /^\d{6}$/.test(requestedId) &&
            players.has(requestedId)
        ) {
            playerId = requestedId;
        }

        if (!playerId) {
            playerId = createPlayerId();

            players.set(playerId, {
                playerId,
                socketId: socket.id,
                connected: true
            });
        } else {

            const player = players.get(playerId);

            player.socketId = socket.id;
            player.connected = true;
        }

        socketPlayers.set(socket.id, playerId);

        socket.emit("player-registered", {
            playerId
        });

        updateOnlinePlayers();

        console.log(
            `Player ${playerId} registered with socket ${socket.id}`
        );
    });


    // --------------------------------------------------
    // REQUEST ONLINE PLAYERS
    // --------------------------------------------------

    socket.on("get-online-players", () => {
        socket.emit("players-online", getOnlinePlayers());
    });


    // --------------------------------------------------
    // SEND CHALLENGE
    // --------------------------------------------------

    socket.on("challenge-player", (targetPlayerId) => {

        const fromPlayerId = getPlayerId(socket);

        if (!fromPlayerId) {
            socket.emit("error-message", "Player is not registered.");
            return;
        }

        if (!players.has(targetPlayerId)) {
            socket.emit("error-message", "Player not found.");
            return;
        }

        if (fromPlayerId === targetPlayerId) {
            socket.emit("error-message", "You cannot challenge yourself.");
            return;
        }

        const targetPlayer = players.get(targetPlayerId);

        if (!targetPlayer.connected) {
            socket.emit("error-message", "Player is offline.");
            return;
        }

        const challengeId =
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        challenges.set(challengeId, {
            challengeId,
            from: fromPlayerId,
            to: targetPlayerId,
            status: "pending"
        });

        io.to(targetPlayer.socketId).emit("chess-challenge", {
            challengeId,
            fromPlayerId
        });

        socket.emit("challenge-sent", {
            challengeId,
            targetPlayerId
        });

        console.log(
            `Challenge: ${fromPlayerId} -> ${targetPlayerId}`
        );
    });


    // --------------------------------------------------
    // ACCEPT CHALLENGE
    // --------------------------------------------------

    socket.on("accept-challenge", (challengeId) => {

        const playerId = getPlayerId(socket);

        if (!playerId) {
            socket.emit("error-message", "Player is not registered.");
            return;
        }

        const challenge = challenges.get(challengeId);

        if (!challenge) {
            socket.emit("error-message", "Challenge no longer exists.");
            return;
        }

        if (challenge.to !== playerId) {
            socket.emit("error-message", "This challenge is not for you.");
            return;
        }

        if (challenge.status !== "pending") {
            socket.emit("error-message", "Challenge already used.");
            return;
        }

        const challenger = players.get(challenge.from);
        const accepter = players.get(challenge.to);

        if (!challenger || !accepter) {
            socket.emit("error-message", "Player connection lost.");
            return;
        }

        if (!challenger.connected || !accepter.connected) {
            socket.emit("error-message", "Both players must be online.");
            return;
        }

        challenge.status = "accepted";


        // --------------------------------------------------
        // CREATE CHESS ROOM
        // --------------------------------------------------

        const gameId =
            `chess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const whitePlayer = challenge.from;
        const blackPlayer = challenge.to;

        const game = {
            gameId,
            white: whitePlayer,
            black: blackPlayer,

            whiteSocket: challenger.socketId,
            blackSocket: accepter.socketId,

            turn: "white"
        };

        chessGames.set(gameId, game);


        // --------------------------------------------------
        // SOCKET.IO ROOM
        // --------------------------------------------------

        const whiteSocket = io.sockets.sockets.get(
            challenger.socketId
        );

        const blackSocket = io.sockets.sockets.get(
            accepter.socketId
        );

        if (!whiteSocket || !blackSocket) {
            chessGames.delete(gameId);
            socket.emit("error-message", "Could not create chess room.");
            return;
        }

        whiteSocket.join(gameId);
        blackSocket.join(gameId);


        // --------------------------------------------------
        // TELL BOTH PLAYERS GAME HAS STARTED
        // --------------------------------------------------

        io.to(challenger.socketId).emit("chess-game-start", {
            gameId,
            playerId: whitePlayer,
            opponentId: blackPlayer,
            color: "white"
        });

        io.to(accepter.socketId).emit("chess-game-start", {
            gameId,
            playerId: blackPlayer,
            opponentId: whitePlayer,
            color: "black"
        });


        console.log(
            `CHESS GAME CREATED: ${gameId}`
        );

        console.log(
            `WHITE: ${whitePlayer}`
        );

        console.log(
            `BLACK: ${blackPlayer}`
        );

        challenges.delete(challengeId);
    });


    // --------------------------------------------------
    // REJECT CHALLENGE
    // --------------------------------------------------

    socket.on("reject-challenge", (challengeId) => {

        const playerId = getPlayerId(socket);

        const challenge = challenges.get(challengeId);

        if (!challenge) {
            return;
        }

        if (challenge.to !== playerId) {
            return;
        }

        challenge.status = "rejected";

        const challenger = players.get(challenge.from);

        if (challenger && challenger.connected) {
            io.to(challenger.socketId).emit("challenge-rejected", {
                challengeId,
                playerId
            });
        }

        challenges.delete(challengeId);

        console.log(
            `Challenge rejected: ${challengeId}`
        );
    });


    // --------------------------------------------------
    // JOIN EXISTING CHESS GAME
    // --------------------------------------------------

    socket.on("join-chess-game", (gameId) => {

        const playerId = getPlayerId(socket);

        const game = chessGames.get(gameId);

        if (!playerId || !game) {
            socket.emit("chess-game-error", {
                message: "Chess game does not exist."
            });

            return;
        }

        if (
            playerId !== game.white &&
            playerId !== game.black
        ) {
            socket.emit("chess-game-error", {
                message: "You are not a player in this chess game."
            });

            return;
        }

        socket.join(gameId);

        const color =
            playerId === game.white
                ? "white"
                : "black";

        const opponentId =
            playerId === game.white
                ? game.black
                : game.white;

        socket.emit("chess-game-joined", {
            gameId,
            playerId,
            opponentId,
            color,
            turn: game.turn
        });

        console.log(
            `${playerId} joined chess game ${gameId}`
        );
    });


    // --------------------------------------------------
    // CHESS MOVE
    // --------------------------------------------------

    socket.on("chess-move", (data) => {

        if (!data || !data.gameId) {
            return;
        }

        const playerId = getPlayerId(socket);
        const game = chessGames.get(data.gameId);

        if (!playerId || !game) {
            return;
        }

        if (
            playerId !== game.white &&
            playerId !== game.black
        ) {
            return;
        }

        // Make sure the move came from the correct player.
        const expectedColor =
            game.turn === "white"
                ? game.white
                : game.black;

        if (playerId !== expectedColor) {
            socket.emit("chess-move-error", {
                message: "It is not your turn."
            });

            return;
        }

        // Send the move to the opponent.
        socket.to(data.gameId).emit("opponent-move", {
            move: data.move,
            from: playerId
        });

        // Switch turn.
        game.turn =
            game.turn === "white"
                ? "black"
                : "white";

        io.to(data.gameId).emit("chess-turn", {
            turn: game.turn
        });
    });


    // --------------------------------------------------
    // CHESS GAME FINISHED
    // --------------------------------------------------

    socket.on("chess-game-finished", (data) => {

        if (!data || !data.gameId) {
            return;
        }

        const game = chessGames.get(data.gameId);

        if (!game) {
            return;
        }

        io.to(data.gameId).emit("chess-game-finished", {
            winner: data.winner,
            gameId: data.gameId
        });

        chessGames.delete(data.gameId);

        console.log(
            `Chess game finished: ${data.gameId}`
        );
    });


    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------

    socket.on("disconnect", () => {

        const playerId = socketPlayers.get(socket.id);

        if (!playerId) {
            return;
        }

        const player = players.get(playerId);

        if (player) {
            player.connected = false;
        }

        socketPlayers.delete(socket.id);

        console.log(
            `Player ${playerId} disconnected`
        );

        updateOnlinePlayers();

        /*
            IMPORTANT:

            We DO NOT delete the player.

            This means if the same browser refreshes and
            sends its saved player ID again, the same ID
            can be reused.
        */

        // Give the player 5 minutes to reconnect.
        setTimeout(() => {

            const currentPlayer = players.get(playerId);

            if (
                currentPlayer &&
                !currentPlayer.connected
            ) {
                players.delete(playerId);

                console.log(
                    `Removed inactive player ${playerId}`
                );

                updateOnlinePlayers();
            }

        }, 5 * 60 * 1000);
    });

});


// --------------------------------------------------
// CLEAN OLD CHALLENGES
// --------------------------------------------------

setInterval(() => {

    for (const [challengeId, challenge] of challenges) {

        if (
            challenge.createdAt &&
            Date.now() - challenge.createdAt > 5 * 60 * 1000
        ) {
            challenges.delete(challengeId);
        }
    }

}, 60 * 1000);


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `DuoPlay server running on port ${PORT}`
    );

});