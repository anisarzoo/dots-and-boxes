import { db } from './firebase-config.js';
import {
    ref,
    set,
    update,
    get,
    onValue,
    onChildAdded,
    off,
    onDisconnect,
    serverTimestamp,
    child,
    push,
    remove,
    runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
// Network Manager - Firebase Realtime Database and multiplayer logic
export class NetworkManager {
    // Helper to get local player index by name
    getLocalPlayerIndex(players, localName) {
        if (!Array.isArray(players)) return -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i].displayName === localName) return i;
        }
        return -1;
    }
    constructor(app) {
        this.app = app;
        this.db = db;
        this.currentRoom = null;
        this.playerData = null;
        this.isHost = false;
        this.quickMatchQueue = null;
        this.connectionListeners = new Map();
        this.gameListeners = new Map();
        this.chatListeners = new Map();
    }

    setupQuickMatchListeners() {
        // Listen for changes to this player's quickMatchQueue entry
        if (!this.db || !this.quickMatchQueue) return;
        const queueEntryRef = ref(this.db, `quickMatchQueue/${this.quickMatchQueue}`);
        // Remove any previous listener
        if (this._quickMatchListener) {
            off(queueEntryRef, 'value', this._quickMatchListener);
        }
        this._quickMatchListener = onValue(queueEntryRef, async (snapshot) => {
            const data = snapshot.exists() ? snapshot.val() : null;
            if (data && data.status === 'matched' && data.roomCode) {
                // Clean up listener and queue entry
                off(queueEntryRef, 'value', this._quickMatchListener);
                await remove(queueEntryRef);
                this.quickMatchQueue = null;
                // Auto-join the matched room
                this.currentRoom = data.roomCode;
                this.isHost = false;
                this.setupRoomListeners(data.roomCode);
                // Notify app to start the game
                if (typeof this.app.handleQuickMatchFound === 'function') {
                    this.app.handleQuickMatchFound();
                }
            }
        });
    }

    // Stub for player presence management (expand as needed)
    setupPresence(roomCode, displayName) {
        // Presence logic can be added here if needed
    }

    // Clean up listeners and mark player as disconnected when leaving a room
    leaveRoom() {
        this.connectionListeners.forEach(({ ref: refObj, listener }) => {
            off(refObj, 'value', listener);
        });
        this.gameListeners.forEach(({ ref: refObj, listener }) => {
            off(refObj, 'value', listener);
        });
        this.chatListeners.forEach(({ ref: refObj, listener }) => {
            off(refObj, 'child_added', listener);
        });
        this.connectionListeners.clear();
        this.gameListeners.clear();
        this.chatListeners.clear();
        if (this.db && this.currentRoom && this.playerData) {
            const playerRef = ref(this.db, `rooms/${this.currentRoom}/players/${this.sanitizeKey(this.playerData.displayName)}/connected`);
            set(playerRef, false);
            // Optionally send system chat message for abandonment
            const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
            const msgRef = push(chatRef);
            set(msgRef, {
                player: 'System',
                message: `${this.playerData.displayName} has left the game.`,
                timestamp: serverTimestamp()
            });
        }
    }

    async createRoom(maxPlayers = 2, gridSize = 5, hostPlayer = null) {
        if (!this.db) {
            this.showError('Network unavailable');
            return null;
        }
        try {
            const roomCode = this.generateRoomCode();
            let displayName, identity, photoURL;
            if (hostPlayer && hostPlayer.displayName && hostPlayer.identity) {
                displayName = hostPlayer.displayName;
                identity = hostPlayer.identity;
                photoURL = hostPlayer.photoURL || null;
            } else {
                const playerNameRaw = this.app.getPlayerName();
                displayName = (typeof playerNameRaw === 'string' && playerNameRaw.trim() !== '') ? playerNameRaw.trim() : 'Player';
                // Generate unique identity for backend
                const now = new Date();
                const dateStr = `${now.getDate().toString().padStart(2, '0')}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getFullYear().toString().slice(-2)}`;
                const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
                identity = `${displayName}${dateStr}${timeStr}`;
                photoURL = null;
            }
            // Always set connected: true for host
            const roomData = {
                code: roomCode,
                host: displayName,
                maxPlayers,
                gridSize,
                players: {
                    [this.sanitizeKey(displayName)]: {
                        displayName: displayName,
                        identity: identity,
                        photoURL: photoURL,
                        isHost: true,
                        joinedAt: serverTimestamp(),
                        connected: true
                    }
                },
                status: 'waiting',
                createdAt: serverTimestamp(),
                gameState: {
                    lines: [],
                    lineOwners: {},
                    boxes: [],
                    players: [
                        {
                            id: 1,
                            displayName: displayName,
                            identity: identity,
                            photoURL: photoURL,
                            isHost: true,
                            score: 0
                        }
                    ],
                    currentPlayer: 0,
                    gridSize: gridSize,
                    gameState: 'waiting'
                },
                chat: {}
            };
            const roomRef = ref(this.db, `rooms/${roomCode}`);
            await set(roomRef, roomData);
            this.currentRoom = roomCode;
            this.isHost = true;
            this.playerData = roomData.players[this.sanitizeKey(displayName)];
            this.setupRoomListeners(roomCode);
            this.setupPresence(roomCode, displayName);
            // Defensive: Patch missing 'connected' for host
            await set(ref(this.db, `rooms/${roomCode}/players/${this.sanitizeKey(displayName)}/connected`), true);
            return {
                code: roomCode,
                inviteLink: `${window.location.origin}${window.location.pathname}#join=${roomCode}`
            };
        } catch (error) {
            console.error('Error creating room:', error);
            this.showError('Failed to create room. Please try again.');
            return null;
        }
    }

    async joinRoom(roomCode, joinPlayer = null) {
        if (!this.db) {
            this.showError('Network unavailable');
            return false;
        }
        try {
            let playerName, identity, photoURL;
            if (joinPlayer && joinPlayer.displayName && joinPlayer.identity) {
                playerName = joinPlayer.displayName;
                identity = joinPlayer.identity;
                photoURL = joinPlayer.photoURL || null;
            } else {
                const playerNameRaw = this.app.getPlayerName();
                playerName = (typeof playerNameRaw === 'string' && playerNameRaw.trim() !== '') ? playerNameRaw.trim() : 'Player';
                // Generate unique identity for backend
                const now = new Date();
                const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
                const timeStr = now.getTime().toString().slice(-6);
                identity = `${playerName}${dateStr}${timeStr}`;
                photoURL = null;
            }
            // Get room data
            const roomRef = ref(this.db, `rooms/${roomCode}`);
            const roomSnap = await get(roomRef);
            const roomData = roomSnap.exists() ? roomSnap.val() : null;
            if (!roomData || !roomData.players) {
                this.showError('Room not found or invalid.');
                return false;
            }
            if (Object.keys(roomData.players).length >= (roomData.maxPlayers || 2)) {
                this.showError('Room is full. Please try another code or create a new room.');
                return false;
            }
            // Prevent duplicate identity (account) joining
            const existingIdentities = Object.values(roomData.players || {}).map(p => p.identity);
            if (existingIdentities.includes(identity)) {
                this.showError('You are already in this room. One account can only join once.');
                return false;
            }
            // Duplicate name handling
            let baseName = playerName;
            let nameIndex = 1;
            const existingNames = Object.values(roomData.players || {}).map(p => (typeof p.displayName === 'string' && p.displayName.trim() !== '') ? p.displayName.trim() : 'Player');
            while (existingNames.includes(baseName)) {
                nameIndex++;
                baseName = playerName + nameIndex;
            }
            if (baseName !== playerName) {
                this.showError(`Name already taken. You have been renamed to ${baseName}`);
            }
            const sanitizedName = this.sanitizeKey(baseName);
            if (roomData.players && roomData.players[sanitizedName]) {
                this.showError('A player with this name is already in the room.');
                return false;
            }
            // Generate unique identity for backend if not provided
            if (!identity) {
                const now2 = new Date();
                const dateStr2 = `${now2.getDate().toString().padStart(2, '0')}${(now2.getMonth() + 1).toString().padStart(2, '0')}${now2.getFullYear().toString().slice(-2)}`;
                const timeStr2 = `${now2.getHours().toString().padStart(2, '0')}${now2.getMinutes().toString().padStart(2, '0')}`;
                identity = `${baseName}${dateStr2}${timeStr2}`;
            }
            const playerRef = ref(this.db, `rooms/${roomCode}/players/${sanitizedName}`);
            await set(playerRef, {
                displayName: (typeof baseName === 'string' && baseName.trim() !== '') ? baseName.trim() : 'Player',
                identity: identity,
                photoURL: photoURL,
                isHost: false,
                joinedAt: serverTimestamp(),
                connected: true
            });
            // Defensive: Patch missing 'connected' for joining player
            await set(ref(this.db, `rooms/${roomCode}/players/${sanitizedName}/connected`), true);
            this.currentRoom = roomCode;
            this.isHost = false;
            this.playerData = {
                displayName: baseName,
                identity: identity,
                photoURL: photoURL,
                isHost: false,
                connected: true
            };
            // Do not auto-start game on join; host must start manually
            this.setupRoomListeners(roomCode);
            this.setupPresence(roomCode, baseName);
            return true;
        } catch (error) {
            console.error('Error joining room:', error);
            this.showError('Failed to join room. Please try again.');
            return false;
        }
    }

    async startQuickMatch() {
        if (!this.db) {
            this.showError('Network unavailable');
            return false;
        }
        try {
            const playerName = this.app.getPlayerName();
            const gridSize = (typeof this.app.getSelectedGridSize === 'function') ? this.app.getSelectedGridSize() : 5;
            const queueRef = ref(this.db, 'quickMatchQueue');
            const queueKey = this.sanitizeKey(playerName);
            const now = Date.now();
            const ACTIVE_WINDOW_MS = 60000;

            // Clean up stale entries
            const snapshot = await get(queueRef);
            const queue = snapshot.exists() ? snapshot.val() : {};
            for (const [key, player] of Object.entries(queue)) {
                if (player.status !== 'waiting' || player.roomCode || (player.joinedAt && (now - player.joinedAt >= ACTIVE_WINDOW_MS))) {
                    await remove(ref(this.db, `quickMatchQueue/${key}`));
                }
            }

            // Try to find another waiting player
            const updatedSnapshot = await get(queueRef);
            const updatedQueue = updatedSnapshot.exists() ? updatedSnapshot.val() : {};
            let opponentKey = null;
            let opponentName = null;
            for (const [key, player] of Object.entries(updatedQueue)) {
                if (key !== queueKey && player.status === 'waiting' && !player.roomCode) {
                    opponentKey = key;
                    opponentName = player.name;
                    break;
                }
            }

            if (opponentKey && opponentName) {
                // Pair found, create room and assign both
                const roomCode = this.generateRoomCode();
                await this.createQuickMatchRoom(roomCode, playerName, opponentName, gridSize);
                await update(ref(this.db, `quickMatchQueue/${opponentKey}`), { roomCode, status: 'matched' });
                await remove(ref(this.db, `quickMatchQueue/${queueKey}`));
                this.currentRoom = roomCode;
                this.isHost = true;
                this.setupRoomListeners(roomCode);
                // Wait for both players to join before starting
                const roomRef = ref(this.db, `rooms/${roomCode}`);
                let joined = false;
                for (let i = 0; i < 20; i++) { // Wait up to 10 seconds
                    const roomSnap = await get(roomRef);
                    const roomData = roomSnap.exists() ? roomSnap.val() : null;
                    if (roomData && roomData.players && Object.keys(roomData.players).length === 2) {
                        joined = true;
                        break;
                    }
                    await new Promise(res => setTimeout(res, 500));
                }
                if (joined) {
                    await update(roomRef, { status: 'playing', gameStartedAt: serverTimestamp() });
                }
                this.app.handleQuickMatchFound();
                if (this.isHost && typeof this.startGame === 'function') {
                    this.startGame();
                }
                return { matched: true, roomCode };
            } else {
                // No opponent, add self to queue and listen
                await set(ref(this.db, `quickMatchQueue/${queueKey}`), {
                    name: playerName,
                    status: 'waiting',
                    joinedAt: serverTimestamp()
                });
                this.quickMatchQueue = queueKey;
                this.setupQuickMatchListeners();
                return { matched: false, queued: true };
            }
        } catch (error) {
            console.error('Error in quick match:', error);
            this.showError('Quick match failed. Please try again.');
            return false;
        }
    }

    async cancelQuickMatch() {
        if (!this.db || !this.quickMatchQueue) return;
        try {
            await remove(ref(this.db, `quickMatchQueue/${this.quickMatchQueue}`));
            this.quickMatchQueue = null;
        } catch (error) {
            console.error('Error canceling quick match:', error);
        }
    }

    async createQuickMatchRoom(roomCode, player1, player2, gridSize = 5) {
        // Generate unique identities for backend
        const now = new Date();
        const dateStr = `${now.getDate().toString().padStart(2, '0')}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getFullYear().toString().slice(-2)}`;
        const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
        const displayName1 = (typeof player1 === 'string' && player1.trim() !== '') ? player1.trim() : 'Player 1';
        const displayName2 = (typeof player2 === 'string' && player2.trim() !== '') ? player2.trim() : 'Player 2';
        const identity1 = `${displayName1}${dateStr}${timeStr}`;
        const identity2 = `${displayName2}${dateStr}${timeStr}`;
        const initialGameState = {
            lines: [],
            lineOwners: {},
            boxes: [],
            players: [
                { id: 1, displayName: displayName1, identity: identity1, isHost: true, score: 0 },
                { id: 2, displayName: displayName2, identity: identity2, isHost: false, score: 0 }
            ],
            currentPlayer: 0,
            gridSize: gridSize,
            gameState: 'playing'
        };
        const roomData = {
            code: roomCode,
            host: displayName1,
            maxPlayers: 2,
            gridSize: gridSize,
            players: {
                [this.sanitizeKey(displayName1)]: {
                    displayName: displayName1,
                    identity: identity1,
                    isHost: true,
                    joinedAt: serverTimestamp(),
                    connected: true
                },
                [this.sanitizeKey(displayName2)]: {
                    displayName: displayName2,
                    identity: identity2,
                    isHost: false,
                    joinedAt: serverTimestamp(),
                    connected: true
                }
            },
            status: 'waiting',
            isQuickMatch: true,
            createdAt: serverTimestamp(),
            gameState: initialGameState,
            chat: {}
        };
        const roomRef = ref(this.db, `rooms/${roomCode}`);
        await set(roomRef, roomData);
    }

    async updateGameState(gameState) {
        if (!this.db || !this.currentRoom) return;
        try {
            // Ensure all players have identity field before sending
            if (Array.isArray(gameState.players)) {
                const now = new Date();
                const dateStr = `${now.getDate().toString().padStart(2, '0')}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getFullYear().toString().slice(-2)}`;
                const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
                gameState.players = gameState.players.map(p => {
                    // Remove undefined properties (like color)
                    const player = { ...p };
                    Object.keys(player).forEach(key => {
                        if (player[key] === undefined) {
                            delete player[key];
                        }
                    });
                    player.identity = (typeof player.identity === 'string' && player.identity.length > 0)
                        ? player.identity
                        : `${(player.displayName || player.name || 'Player')}${dateStr}${timeStr}`;
                    return player;
                });
            }
            const roomRef = ref(this.db, `rooms/${this.currentRoom}/gameState`);
            // Only update if the state is different to avoid unnecessary writes
            const currentSnap = await get(roomRef);
            const currentState = currentSnap.exists() ? currentSnap.val() : null;
            if (JSON.stringify(currentState) !== JSON.stringify(gameState)) {
                await set(roomRef, gameState);
            }
        } catch (error) {
            console.error('Error updating game state:', error);
        }
    }

    async makeMove(moveData) {
        try {
            // Allow any client to send game state update (not just host)
            if (this.app.gameInstance && typeof this.app.gameInstance.getNetworkGameState === 'function') {
                const fullGameState = this.app.gameInstance.getNetworkGameState();
                await this.updateGameState(fullGameState);
            } else {
                console.log('Game instance not available for makeMove.');
            }
        } catch (error) {
            console.error('Error making move:', error);
        }
    }

    async startGame() {
        if (!this.db || !this.currentRoom || !this.isHost) return;
        try {
            const roomRef = ref(this.db, `rooms/${this.currentRoom}`);
            await update(roomRef, {
                status: 'playing',
                gameStartedAt: serverTimestamp()
            });
        } catch (error) {
            console.error('Error starting game:', error);
        }
    }

    async endGame(gameResult) {
        if (!this.db || !this.currentRoom) return;
        try {
            const roomRef = ref(this.db, `rooms/${this.currentRoom}`);
            await update(roomRef, {
                status: 'finished',
                gameResult,
                gameEndedAt: serverTimestamp()
            });
            // Schedule room deletion after 1 minute
            setTimeout(async () => {
                try {
                    await remove(roomRef);
                    console.log('Room deleted from Firebase after game over.');
                } catch (err) {
                    console.error('Error deleting room after game over:', err);
                }
            }, 60000); // 1 minute
        } catch (error) {
            console.error('Error ending game:', error);
        }
    }

    async sendChatMessage(message) {
        if (!this.db || !this.currentRoom) return;
        let content = typeof message === 'string' ? message : (message.content || message.message || '');
        if (!content.trim()) return;
        try {
            // Always use currentRoom for chat sync
            const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
            const newMessageRef = push(chatRef);
            await set(newMessageRef, {
                player: this.app.getPlayerName(),
                identity: this.playerData?.identity || '',
                message: content.trim(),
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error('Error sending chat message:', error);
        }
    }

    setupRoomListeners(roomCode) {
        if (!this.db) return;
        // Always use roomCode for listeners to avoid desync
        const roomRef = ref(this.db, `rooms/${roomCode}`);
        const playersRef = ref(this.db, `rooms/${roomCode}/players`);
        const playersListener = onValue(playersRef, (snapshot) => {
            const players = snapshot.exists() ? snapshot.val() : {};
            // Always provide displayName fallback for lobby
            const playerList = Object.values(players).map(p => ({
                ...p,
                displayName: p.displayName || p.name || 'Player'
            }));
            this.app.updateLobbyPlayers(playerList);
        });
        this.connectionListeners.set('players', { ref: playersRef, listener: playersListener });
        const gameStateRef = ref(this.db, `rooms/${roomCode}/gameState`);
        const gameStateListener = onValue(gameStateRef, (snapshot) => {
            const gameState = snapshot.exists() ? snapshot.val() : null;
            if (gameState && this.app.gameInstance) {
                // Fix turn display: always use networked player array as-is
                // and calculate local player index by name
                if (Array.isArray(gameState.players)) {
                    const localName = this.app.getPlayerName();
                    const localIndex = this.getLocalPlayerIndex(gameState.players, localName);
                    this.app.gameInstance.localPlayerIndex = localIndex;
                }
                this.app.gameInstance.handleNetworkUpdate(gameState);
            }
        });
        this.gameListeners.set('gameState', { ref: gameStateRef, listener: gameStateListener });
        const statusRef = ref(this.db, `rooms/${roomCode}/status`);
        const statusListener = onValue(statusRef, async (snapshot) => {
            const status = snapshot.exists() ? snapshot.val() : null;
            if (typeof status === 'string' && status.trim().toLowerCase() === 'playing') {
                this.app.startNetworkGame();
            } else {
                // Room is waiting for host to start the game
                console.warn('[network.js] Room status not playing:', status);
            }
        });
        this.connectionListeners.set('status', { ref: statusRef, listener: statusListener });
        const chatRef = ref(this.db, `rooms/${roomCode}/chat`);
        const chatListener = onChildAdded(chatRef, (snapshot) => {
            const message = snapshot.exists() ? snapshot.val() : null;
            if (this.app.chatManager && message) {
                this.app.chatManager.addMessage(message);
            }
        });
        this.chatListeners.set('chat', { ref: chatRef, listener: chatListener });
    }

    // Rematch logic: call this when a player requests a rematch
    async requestRematch() {
        if (!this.db || !this.currentRoom || !this.playerData) return;
        const rematchRef = ref(this.db, `rooms/${this.currentRoom}/rematchRequests/${this.sanitizeKey(this.playerData.displayName)}`);
        await set(rematchRef, true);
        // Check if all connected players have requested rematch
        const playersSnap = await get(ref(this.db, `rooms/${this.currentRoom}/players`));
        const players = playersSnap.val() || {};
        const connectedNames = Object.keys(players).filter(k => players[k].connected);
        const rematchSnap = await get(ref(this.db, `rooms/${this.currentRoom}/rematchRequests`));
        const rematchRequests = rematchSnap.val() || {};
        const allRequested = connectedNames.every(name => rematchRequests[name]);
        // If all requested, only the last requester sees the 'Rematch' button
        if (allRequested && connectedNames.length > 1) {
            // Mark that rematch is ready, but do not start yet
            await update(ref(this.db, `rooms/${this.currentRoom}`), { rematchReady: true });
        }
    }

    // Call this when the last player clicks 'Rematch' to actually start the new game
    async confirmRematch() {
        if (!this.db || !this.currentRoom) return;
        const playersSnap = await get(ref(this.db, `rooms/${this.currentRoom}/players`));
        const players = playersSnap.val() || {};
        const connectedNames = Object.keys(players).filter(k => players[k].connected);
        if (connectedNames.length > 1) {
            const gridSize = players[connectedNames[0]].gridSize || 5;
            const playerList = connectedNames.map((name, idx) => ({
                id: idx + 1,
                displayName: players[name].displayName || players[name].name || 'Player',
                identity: players[name].identity,
                isHost: players[name].isHost,
                score: 0
            }));
            const initialGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: playerList,
                currentPlayer: 0,
                gridSize: gridSize,
                gameState: 'playing'
            };
            await update(ref(this.db, `rooms/${this.currentRoom}`), {
                status: 'playing',
                gameState: initialGameState,
                rematchRequests: null,
                rematchReady: null
            });
            // Notify via chat
            const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
            const msgRef = push(chatRef);
            set(msgRef, {
                player: 'System',
                message: 'Rematch started!',
                timestamp: serverTimestamp()
            });
        }
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';
        for (let i = 0; i < 4; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    sanitizeKey(str) {
        return String(str || '').replace(/[.#$\/\[\]]/g, '_');
    }

    showError(message) {
        if (this.app.uiManager && this.app.uiManager.isMobile) {
            this.app.uiManager.showNotification(message, 'error');
        } else if (typeof this.app.showError === 'function') {
            this.app.showError(message);
        } else {
            alert(message);
        }
    }

    getCurrentRoom() {
        return this.currentRoom;
    }
    isRoomHost() {
        return this.isHost;
    }
    getRoomStatus() {
        if (!this.currentRoom) return null;
        return {
            room: this.currentRoom,
            isHost: this.isHost,
            connected: this.db ? true : false
        };
    }
    // Note: Game state updates are handled by DotsAndBoxesGame.sendGameStateUpdate()
    // which calls this.networkManager.updateGameState().
    on(event, callback) {
        if (event === 'gameStart') {
            this.gameStartCallback = callback;
        }
    }
    trigger(event, data) {
        if (event === 'gameStart' && this.gameStartCallback) {
            this.gameStartCallback(data);
        }
    }
    initializeQuickMatch() {
        this.off('gameStart', this.handleNetworkUpdate);
        this.on('gameStart', (gameState) => {
            console.log('Quick Match started:', gameState);
            this.handleNetworkUpdate(gameState);
        });
        this.requestQuickMatch();
        console.log('Quick Match requested');
    }

    // Host can remove a player from the room
    async removePlayerFromRoom(playerName) {
        if (!this.db || !this.currentRoom || !this.isHost) return false;
        const sanitizedName = this.sanitizeKey(playerName);
        const playerRef = ref(this.db, `rooms/${this.currentRoom}/players/${sanitizedName}`);
        const playerSnap = await get(playerRef);
        if (!playerSnap.exists()) return false;
        // Prevent host from removing themselves
        if (sanitizedName === this.sanitizeKey(this.playerData.displayName)) return false;
        await remove(playerRef);
        // Optionally send system chat message
        const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
        const msgRef = push(chatRef);
        set(msgRef, {
            player: 'System',
            message: `${playerName} was removed from the room by the host.`,
            timestamp: serverTimestamp()
        });
        return true;
    }
}
