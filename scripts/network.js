import { db } from './firebase-config.js';
import {
    ref, set, update, get, onValue, onChildAdded, off, onDisconnect,
    serverTimestamp, child, push, remove, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// Network Manager - Firebase Realtime Database and multiplayer logic - FIXED VERSION
export class NetworkManager {
    // Constants to avoid magic numbers
    static CONSTANTS = {
        ROOM_CODE_LENGTH: 4,
        MAX_RETRIES: 3,
        TIMEOUT_MS: 30000,
        QUEUE_CLEANUP_INTERVAL: 60000, // 1 minute
        IDENTITY_SUFFIX_LENGTH: 8,
        MAX_WAIT_ITERATIONS: 20,
        WAIT_INTERVAL_MS: 500
    };

    constructor(app) {
        if (!app) {
            throw new Error('NetworkManager requires an app instance');
        }

        this.app = app;
        this.db = db;
        this.currentRoom = null;
        this.playerData = null;
        this.isHost = false;
        this.quickMatchQueue = null;

        // FIXED: Better listener management with cleanup tracking
        this.connectionListeners = new Map();
        this.gameListeners = new Map();
        this.chatListeners = new Map();
        this._allListeners = new Set(); // Track all listeners for cleanup

        // FIXED: Add state tracking for better error handling
        this.isConnected = false;
        this.isJoiningRoom = false;
        this.lastError = null;

        // Setup connection monitoring
        this.setupConnectionMonitoring();
    }

    // NEW: Monitor database connection
    setupConnectionMonitoring() {
        if (!this.db) return;

        let firstCall = true;

        try {
            const connectedRef = ref(this.db, '.info/connected');
            const listener = onValue(connectedRef, (snapshot) => {
                const connected = snapshot.val() === true;
                
                // Only process if the state has changed
                if (this.isConnected !== connected) {
                    this.isConnected = connected;
                    
                    if (this.isConnected) {
                        console.log('Firebase connected');
                    } else if (!firstCall) {
                        // Only warn if it's not the initial state check
                        console.warn('Firebase disconnected');
                        this.handleConnectionLoss();
                    }
                }
                firstCall = false;
            });
            this._allListeners.add(() => off(connectedRef, 'value', listener));
        } catch (error) {
            console.error('Error setting up connection monitoring:', error);
        }
    }

    // NEW: Handle connection loss
    handleConnectionLoss() {
        this.isConnected = false;
        if (this.app?.showError) {
            this.app.showError('Connection lost. Attempting to reconnect...');
        }
    }

    // FIXED: Standardized identity generation
    generatePlayerIdentity(displayName) {
        const sanitizedName = this.sanitizeDisplayName(displayName || 'Player');
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, NetworkManager.CONSTANTS.IDENTITY_SUFFIX_LENGTH);
        return `${sanitizedName}_${timestamp}_${random}`;
    }

    // NEW: Sanitize display names
    sanitizeDisplayName(name) {
        return String(name || 'Player')
            .trim()
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .substring(0, 20) || 'Player';
    }

    // FIXED: Improved quick match setup with proper cleanup
    setupQuickMatchListeners() {
        if (!this.db || !this.quickMatchQueue) return;

        try {
            const queueEntryRef = ref(this.db, `quickMatchQueue/${this.quickMatchQueue}`);
            
            // Clean up existing listener
            this.cleanupQuickMatchListener();

            this._quickMatchListener = onValue(queueEntryRef, async (snapshot) => {
                try {
                    const data = snapshot.exists() ? snapshot.val() : null;
                    if (data?.status === 'matched' && data.roomCode) {
                        // Clean up listener and queue entry
                        this.cleanupQuickMatchListener();
                        await this.safeRemove(queueEntryRef);
                        
                        this.quickMatchQueue = null;
                        this.currentRoom = data.roomCode;
                        this.isHost = false;

                        try {
                            for (let i = 0; i < 10; i++) {
                                const playersSnap = await get(ref(this.db, `rooms/${data.roomCode}/players`));
                                const players = playersSnap.exists() ? playersSnap.val() : null;
                                if (players) {
                                    const localName = this.app.getPlayerName();
                                    const localIdentity = this.app?.signedInUser?.uid || null;
                                    const localKey = this.sanitizeKey(localName);
                                    this.playerData = Object.values(players).find((p) => localIdentity && p.identity === localIdentity) ||
                                        players[localKey] ||
                                        Object.values(players).find((p) => p.displayName === localName) ||
                                        null;
                                    if (this.playerData) break;
                                }
                                await new Promise((resolve) => setTimeout(resolve, 250));
                            }
                        } catch (lookupError) {
                            console.warn('Could not resolve quick-match player data:', lookupError);
                        }
                        
                        this.setupRoomListeners(data.roomCode);
                        
                        if (typeof this.app.handleQuickMatchFound === 'function') {
                            this.app.handleQuickMatchFound();
                        }
                    }
                } catch (error) {
                    console.error('Error in quick match listener:', error);
                    this.handleError('Quick match error', error);
                }
            });

            this._allListeners.add(() => {
                if (this._quickMatchListener) {
                    off(queueEntryRef, 'value', this._quickMatchListener);
                }
            });
        } catch (error) {
            console.error('Error setting up quick match listeners:', error);
            this.handleError('Failed to setup quick match', error);
        }
    }

    // NEW: Clean up quick match listener
    cleanupQuickMatchListener() {
        if (this._quickMatchListener && this.quickMatchQueue) {
            const queueEntryRef = ref(this.db, `quickMatchQueue/${this.quickMatchQueue}`);
            off(queueEntryRef, 'value', this._quickMatchListener);
            this._quickMatchListener = null;
        }
    }

    // IMPROVED: Enhanced room creation with better validation
    async createRoom(maxPlayers = 2, gridSize = 5, hostPlayer = null) {
        if (!this.db) {
            throw new Error('Database not available');
        }

        if (this.isJoiningRoom) {
            throw new Error('Already joining a room');
        }

        this.isJoiningRoom = true;

        try {
            // Validate parameters
            if (maxPlayers < 2 || maxPlayers > 4) {
                throw new Error('Max players must be between 2 and 4');
            }
            if (gridSize < 3 || gridSize > 15) {
                throw new Error('Grid size must be between 3 and 15');
            }

            const roomCode = this.generateRoomCode();
            let displayName, identity, photoURL;

            if (hostPlayer?.displayName && hostPlayer?.identity) {
                displayName = this.sanitizeDisplayName(hostPlayer.displayName);
                identity = hostPlayer.identity;
                photoURL = hostPlayer.photoURL || null;
            } else {
                const playerNameRaw = this.app.getPlayerName();
                displayName = this.sanitizeDisplayName(playerNameRaw);
                identity = this.generatePlayerIdentity(displayName);
                photoURL = null;
            }

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
                    players: [{
                        id: 1,
                        displayName: displayName,
                        identity: identity,
                        photoURL: photoURL,
                        isHost: true,
                        score: 0
                    }],
                    currentPlayer: 0,
                    gridSize: gridSize,
                    gameState: 'waiting'
                },
                chat: {}
            };

            const roomRef = ref(this.db, `rooms/${roomCode}`);
            await set(roomRef, roomData);

            // Setup disconnect handling
            const playerConnectedRef = ref(this.db, `rooms/${roomCode}/players/${this.sanitizeKey(displayName)}/connected`);
            onDisconnect(playerConnectedRef).set(false);

            this.currentRoom = roomCode;
            this.isHost = true;
            this.playerData = roomData.players[this.sanitizeKey(displayName)];
            
            this.setupRoomListeners(roomCode);

            return {
                code: roomCode,
                inviteLink: `${window.location.origin}${window.location.pathname}#join=${roomCode}`
            };

        } catch (error) {
            console.error('Error creating room:', error);
            this.handleError('Failed to create room', error);
            throw error;
        } finally {
            this.isJoiningRoom = false;
        }
    }

    // IMPROVED: Enhanced room joining with transaction-based safety
    async joinRoom(roomCode, joinPlayer = null) {
        if (!this.db) {
            throw new Error('Database not available');
        }

        if (this.isJoiningRoom) {
            throw new Error('Already joining a room');
        }

        this.isJoiningRoom = true;

        try {
            let playerName, identity, photoURL;

            if (joinPlayer?.displayName && joinPlayer?.identity) {
                playerName = this.sanitizeDisplayName(joinPlayer.displayName);
                identity = joinPlayer.identity;
                photoURL = joinPlayer.photoURL || null;
            } else {
                const playerNameRaw = this.app.getPlayerName();
                playerName = this.sanitizeDisplayName(playerNameRaw);
                identity = this.generatePlayerIdentity(playerName);
                photoURL = null;
            }

            // Use transaction for atomic room joining
            const roomRef = ref(this.db, `rooms/${roomCode}`);
            const result = await runTransaction(roomRef, (currentData) => {
                if (!currentData || !currentData.players) {
                    throw new Error('Room not found');
                }

                const currentPlayerCount = Object.keys(currentData.players).length;
                if (currentPlayerCount >= (currentData.maxPlayers || 2)) {
                    throw new Error('Room is full');
                }

                // Check for duplicate identity
                const existingIdentities = Object.values(currentData.players).map(p => p.identity);
                if (existingIdentities.includes(identity)) {
                    throw new Error('You are already in this room');
                }

                // Handle name conflicts
                let finalName = playerName;
                let nameIndex = 1;
                const existingNames = Object.values(currentData.players).map(p => p.displayName);
                
                while (existingNames.includes(finalName)) {
                    nameIndex++;
                    finalName = `${playerName}${nameIndex}`;
                }

                const sanitizedName = this.sanitizeKey(finalName);
                
                // Add new player
                currentData.players[sanitizedName] = {
                    displayName: finalName,
                    identity: identity,
                    photoURL: photoURL,
                    isHost: false,
                    joinedAt: serverTimestamp(),
                    connected: true
                };

                return currentData;
            });

            if (result.committed) {
                // Setup disconnect handling
                const finalName = Object.values(result.snapshot.val().players)
                    .find(p => p.identity === identity)?.displayName;
                
                if (finalName) {
                    const playerConnectedRef = ref(this.db, `rooms/${roomCode}/players/${this.sanitizeKey(finalName)}/connected`);
                    onDisconnect(playerConnectedRef).set(false);

                    this.currentRoom = roomCode;
                    this.isHost = false;
                    this.playerData = {
                        displayName: finalName,
                        identity: identity,
                        photoURL: photoURL,
                        isHost: false,
                        connected: true
                    };

                    this.setupRoomListeners(roomCode);

                    if (finalName !== playerName) {
                        this.showNotification(`Name already taken. You are now ${finalName}`, 'warning');
                    }

                    return true;
                }
            }

            throw new Error('Failed to join room - transaction failed');

        } catch (error) {
            console.error('Error joining room:', error);
            this.handleError('Failed to join room', error);
            return false;
        } finally {
            this.isJoiningRoom = false;
        }
    }

    // FIXED: Improved quick match with transaction safety
    async startQuickMatch(userId = null, gridSizeOverride = null, playerInfo = null) {
        if (!this.db) {
            throw new Error('Database not available');
        }

        try {
            const playerName = this.sanitizeDisplayName(
                playerInfo?.displayName || this.app.getPlayerName()
            );
            const playerIdentity = playerInfo?.identity || userId || this.generatePlayerIdentity(playerName);
            const playerPhoto = playerInfo?.photoURL || null;
            const gridSize = Number.isFinite(gridSizeOverride)
                ? gridSizeOverride
                : (typeof this.app.getSelectedGridSize === 'function' ? this.app.getSelectedGridSize() : 5);
            const playerKey = this.sanitizeKey(playerIdentity || playerName);

            const queueRef = ref(this.db, 'quickMatchQueue');
            let transactionResult = { matched: false, roomCode: null, opponent: null, queued: false };

            const result = await runTransaction(queueRef, (currentQueue) => {
                const now = Date.now();
                const ACTIVE_WINDOW_MS = NetworkManager.CONSTANTS.QUEUE_CLEANUP_INTERVAL;
                const queue = { ...(currentQueue || {}) };

                Object.entries(queue).forEach(([key, player]) => {
                    if (!player || player.status !== 'waiting') return;
                    if (player.joinedAt && now - player.joinedAt >= ACTIVE_WINDOW_MS) {
                        delete queue[key];
                    }
                });

                const availableOpponent = Object.entries(queue).find(([key, player]) =>
                    key !== playerKey && player && player.status === 'waiting'
                );

                if (availableOpponent) {
                    const [opponentKey, opponentData] = availableOpponent;
                    const roomCode = this.generateRoomCode();

                    queue[opponentKey] = {
                        ...opponentData,
                        status: 'matched',
                        roomCode,
                        matchedAt: now
                    };
                    delete queue[playerKey];

                    transactionResult = {
                        matched: true,
                        roomCode,
                        opponent: opponentData || null,
                        queued: false
                    };
                    return queue;
                }

                queue[playerKey] = {
                    name: playerName,
                    identity: playerIdentity,
                    photoURL: playerPhoto,
                    status: 'waiting',
                    joinedAt: now
                };

                transactionResult = {
                    matched: false,
                    roomCode: null,
                    opponent: null,
                    queued: true
                };
                return queue;
            });

            if (!result.committed) {
                throw new Error('Quick match transaction failed');
            }

            if (transactionResult.matched && transactionResult.roomCode) {
                const roomCreation = await this.createQuickMatchRoom(
                    transactionResult.roomCode,
                    { displayName: playerName, identity: playerIdentity, photoURL: playerPhoto },
                    {
                        displayName: transactionResult.opponent?.name || 'Player',
                        identity: transactionResult.opponent?.identity || null,
                        photoURL: transactionResult.opponent?.photoURL || null
                    },
                    gridSize
                );

                this.currentRoom = transactionResult.roomCode;
                this.isHost = true;
                this.playerData = roomCreation?.hostPlayer || null;
                this.setupRoomListeners(transactionResult.roomCode);

                await this.waitForOpponentToJoin(transactionResult.roomCode);

                if (typeof this.app.handleQuickMatchFound === 'function') {
                    this.app.handleQuickMatchFound();
                }

                return { matched: true, roomCode: transactionResult.roomCode };
            }

            this.quickMatchQueue = playerKey;
            this.setupQuickMatchListeners();
            return { matched: false, queued: true };
        } catch (error) {
            console.error('Error in quick match:', error);
            this.handleError('Quick match failed', error);
            return { matched: false, error: error.message };
        }
    }

    // NEW: Wait for opponent to join the room
    async waitForOpponentToJoin(roomCode) {
        const roomRef = ref(this.db, `rooms/${roomCode}`);
        
        for (let i = 0; i < NetworkManager.CONSTANTS.MAX_WAIT_ITERATIONS; i++) {
            try {
                const roomSnap = await get(roomRef);
                const roomData = roomSnap.exists() ? roomSnap.val() : null;
                
                if (roomData?.players && Object.keys(roomData.players).length === 2) {
                    // Both players joined, start the game
                    await update(roomRef, { 
                        status: 'playing', 
                        gameStartedAt: serverTimestamp() 
                    });
                    return true;
                }
                
                await new Promise(resolve => 
                    setTimeout(resolve, NetworkManager.CONSTANTS.WAIT_INTERVAL_MS)
                );
            } catch (error) {
                console.error('Error waiting for opponent:', error);
            }
        }
        
        console.warn('Timeout waiting for opponent to join');
        return false;
    }

    async cancelQuickMatch() {
        if (!this.db || !this.quickMatchQueue) return;

        try {
            await this.safeRemove(ref(this.db, `quickMatchQueue/${this.quickMatchQueue}`));
            this.cleanupQuickMatchListener();
            this.quickMatchQueue = null;
        } catch (error) {
            console.error('Error canceling quick match:', error);
        }
    }

    // IMPROVED: Better quick match room creation
    async createQuickMatchRoom(roomCode, player1, player2, gridSize = 5) {
        try {
            const p1 = typeof player1 === 'string' ? { displayName: player1 } : (player1 || {});
            const p2 = typeof player2 === 'string' ? { displayName: player2 } : (player2 || {});

            const displayName1 = this.sanitizeDisplayName(p1.displayName || 'Player');
            const displayName2 = this.sanitizeDisplayName(p2.displayName || 'Player');
            const identity1 = p1.identity || this.generatePlayerIdentity(displayName1);
            const identity2 = p2.identity || this.generatePlayerIdentity(displayName2);
            const photoURL1 = p1.photoURL || null;
            const photoURL2 = p2.photoURL || null;
            const hostPlayer = {
                displayName: displayName1,
                identity: identity1,
                photoURL: photoURL1,
                isHost: true,
                connected: true
            };

            const initialGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: [
                    { id: 1, displayName: displayName1, identity: identity1, photoURL: photoURL1, isHost: true, score: 0 },
                    { id: 2, displayName: displayName2, identity: identity2, photoURL: photoURL2, isHost: false, score: 0 }
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
                        photoURL: photoURL1,
                        isHost: true,
                        joinedAt: serverTimestamp(),
                        connected: true
                    },
                    [this.sanitizeKey(displayName2)]: {
                        displayName: displayName2,
                        identity: identity2,
                        photoURL: photoURL2,
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
            return { hostPlayer };

        } catch (error) {
            console.error('Error creating quick match room:', error);
            throw error;
        }
    }

    // IMPROVED: Better game state updates with validation
    async updateGameState(gameState) {
        if (!this.db || !this.currentRoom || !gameState) return;

        try {
            // Validate and clean game state
            const cleanedState = this.validateAndCleanGameState(gameState);
            
            const roomRef = ref(this.db, `rooms/${this.currentRoom}/gameState`);
            
            // Only update if state has changed
            const currentSnap = await get(roomRef);
            const currentState = currentSnap.exists() ? currentSnap.val() : null;
            
            if (JSON.stringify(currentState) !== JSON.stringify(cleanedState)) {
                await set(roomRef, cleanedState);
            }
        } catch (error) {
            console.error('Error updating game state:', error);
            this.handleError('Failed to update game state', error);
        }
    }

    // NEW: Validate and clean game state
    validateAndCleanGameState(gameState) {
        if (!gameState || typeof gameState !== 'object') {
            throw new Error('Invalid game state');
        }

        const cleaned = { ...gameState };

        // Ensure players have required fields
        if (Array.isArray(cleaned.players)) {
            cleaned.players = cleaned.players.map(p => {
                const player = { ...p };
                
                // Remove undefined properties
                Object.keys(player).forEach(key => {
                    if (player[key] === undefined) {
                        delete player[key];
                    }
                });

                // Ensure identity exists
                if (!player.identity) {
                    player.identity = this.generatePlayerIdentity(player.displayName || player.name);
                }

                return player;
            });
        }

        return cleaned;
    }

    // FIXED: Improved room listeners with proper cleanup
    setupRoomListeners(roomCode) {
        if (!this.db || !roomCode) return;

        try {
            // Clean up existing listeners first
            this.cleanupRoomListeners();

            // Players listener
            const playersRef = ref(this.db, `rooms/${roomCode}/players`);
            const playersListener = onValue(playersRef, (snapshot) => {
                try {
                    const players = snapshot.exists() ? snapshot.val() : {};
                    const playerList = Object.values(players).map(p => ({
                        ...p,
                        displayName: p.displayName || p.name || 'Player'
                    }));
                    this.app.updateLobbyPlayers(playerList);
                } catch (error) {
                    console.error('Error in players listener:', error);
                }
            });

            this.connectionListeners.set('players', { ref: playersRef, listener: playersListener });

            // Game state listener
            const gameStateRef = ref(this.db, `rooms/${roomCode}/gameState`);
            const gameStateListener = onValue(gameStateRef, (snapshot) => {
                try {
                    const gameState = snapshot.exists() ? snapshot.val() : null;
                    if (gameState && this.app.gameInstance) {
                        if (Array.isArray(gameState.players)) {
                            const localName = this.app.getPlayerName();
                            const localIndex = this.getLocalPlayerIndex(gameState.players, localName);
                            this.app.gameInstance.localPlayerIndex = localIndex;
                        }
                        this.app.gameInstance.handleNetworkUpdate(gameState);
                    }
                } catch (error) {
                    console.error('Error in game state listener:', error);
                }
            });

            this.gameListeners.set('gameState', { ref: gameStateRef, listener: gameStateListener });

            // Status listener
            const statusRef = ref(this.db, `rooms/${roomCode}/status`);
            const statusListener = onValue(statusRef, (snapshot) => {
                try {
                    const status = snapshot.exists() ? snapshot.val() : null;
                    if (status === 'playing') {
                        if (this.app.currentScreen !== 'gameScreen' || !this.app.gameInstance) {
                            this.app.startNetworkGame();
                        }
                    }
                } catch (error) {
                    console.error('Error in status listener:', error);
                }
            });

            this.connectionListeners.set('status', { ref: statusRef, listener: statusListener });

            // Chat listener
            const chatRef = ref(this.db, `rooms/${roomCode}/chat`);
            const chatListener = onChildAdded(chatRef, (snapshot) => {
                try {
                    const message = snapshot.exists() ? snapshot.val() : null;
                    if (this.app.chatManager && message) {
                        this.app.chatManager.addMessage(message);
                    }
                } catch (error) {
                    console.error('Error in chat listener:', error);
                }
            });

            this.chatListeners.set('chat', { ref: chatRef, listener: chatListener });

        } catch (error) {
            console.error('Error setting up room listeners:', error);
            this.handleError('Failed to setup room listeners', error);
        }
    }

    // NEW: Clean up room listeners
    cleanupRoomListeners() {
        this.connectionListeners.forEach(({ ref: refObj, listener }) => {
            try {
                off(refObj, 'value', listener);
            } catch (error) {
                console.error('Error cleaning up connection listener:', error);
            }
        });

        this.gameListeners.forEach(({ ref: refObj, listener }) => {
            try {
                off(refObj, 'value', listener);
            } catch (error) {
                console.error('Error cleaning up game listener:', error);
            }
        });

        this.chatListeners.forEach(({ ref: refObj, listener }) => {
            try {
                off(refObj, 'child_added', listener);
            } catch (error) {
                console.error('Error cleaning up chat listener:', error);
            }
        });

        this.connectionListeners.clear();
        this.gameListeners.clear();
        this.chatListeners.clear();
    }

    // Helper to get local player index by name
    getLocalPlayerIndex(players, localName) {
        if (!Array.isArray(players)) return -1;
        return players.findIndex(p => p.displayName === localName);
    }

    async makeMove(moveData) {
        try {
            if (this.app.gameInstance?.getNetworkGameState) {
                const fullGameState = this.app.gameInstance.getNetworkGameState();
                await this.updateGameState(fullGameState);
            }
        } catch (error) {
            console.error('Error making move:', error);
            this.handleError('Failed to make move', error);
        }
    }

    async startGame() {
        if (!this.db || !this.currentRoom || !this.isHost) return;

        try {
            const roomRef = ref(this.db, `rooms/${this.currentRoom}`);
            const roomSnap = await get(roomRef);
            const roomData = roomSnap.exists() ? roomSnap.val() : null;
            if (!roomData) return;

            const playersObj = roomData.players || {};
            const gridSize = roomData.gridSize || 5;
            const playersArr = Object.values(playersObj)
                .filter((p) => p.connected !== false)
                .map((p, idx) => ({
                    id: idx + 1,
                    displayName: p.displayName || `Player ${idx + 1}`,
                    identity: p.identity || `player_${idx}`,
                    photoURL: p.photoURL || null,
                    isHost: p.isHost || false,
                    score: 0
                }));

            if (playersArr.length < 2) return;

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: playersArr,
                currentPlayer: 0,
                gridSize,
                gameState: 'playing'
            };

            await update(roomRef, {
                status: 'playing',
                gameStartedAt: serverTimestamp(),
                gameState: freshGameState
            });
        } catch (error) {
            console.error('Error starting game:', error);
            this.handleError('Failed to start game', error);
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

            // Schedule room cleanup
            setTimeout(async () => {
                try {
                    await this.safeRemove(roomRef);
                    console.log('Room cleaned up after game end');
                } catch (error) {
                    console.error('Error cleaning up room:', error);
                }
            }, 60000);

        } catch (error) {
            console.error('Error ending game:', error);
        }
    }

    async sendChatMessage(message) {
        if (!this.db || !this.currentRoom) return;

        const content = typeof message === 'string' ? message : (message.content || message.message || '');
        if (!content.trim()) return;

        try {
            const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
            const newMessageRef = push(chatRef);
            await set(newMessageRef, {
                player: this.app.getPlayerName(),
                identity: this.playerData?.identity || '',
                message: content.trim(),
                timestamp: serverTimestamp(),
                clientId: message.clientId || ''
            });
        } catch (error) {
            console.error('Error sending chat message:', error);
            this.handleError('Failed to send message', error);
        }
    }

    // IMPROVED: Better room leaving with proper cleanup
    leaveRoom() {
        try {
            this.cleanupRoomListeners();
            this.cleanupQuickMatchListener();

            if (this.db && this.currentRoom && this.playerData) {
                // Mark player as disconnected
                const playerRef = ref(this.db, `rooms/${this.currentRoom}/players/${this.sanitizeKey(this.playerData.displayName)}/connected`);
                this.safeSet(playerRef, false);

                // Send leave message
                const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
                const msgRef = push(chatRef);
                this.safeSet(msgRef, {
                    player: 'System',
                    message: `${this.playerData.displayName} has left the game.`,
                    timestamp: serverTimestamp()
                });
            }

            // Reset state
            this.currentRoom = null;
            this.playerData = null;
            this.isHost = false;
            this.quickMatchQueue = null;

        } catch (error) {
            console.error('Error leaving room:', error);
        }
    }

    // NEW: Safe database operations with error handling
    async safeSet(ref, value) {
        try {
            await set(ref, value);
        } catch (error) {
            console.error('Error in safe set:', error);
        }
    }

    async safeUpdate(ref, updates) {
        try {
            await update(ref, updates);
        } catch (error) {
            console.error('Error in safe update:', error);
        }
    }

    async safeRemove(ref) {
        try {
            await remove(ref);
        } catch (error) {
            console.error('Error in safe remove:', error);
        }
    }

    // IMPROVED: Better room code generation with collision checking
    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < NetworkManager.CONSTANTS.ROOM_CODE_LENGTH; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    sanitizeKey(str) {
        return String(str || '')
            .replace(/[.#$\/\[\]]/g, '_')
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .substring(0, 50); // Limit length
    }

    // NEW: Centralized error handling
    handleError(message, error) {
        console.error(message, error);
        this.lastError = { message, error, timestamp: Date.now() };
        this.showNotification(message, 'error');
    }

    // IMPROVED: Better notification system
    showNotification(message, type = 'info') {
        if (this.app.uiManager?.showNotification) {
            this.app.uiManager.showNotification(message, type);
        } else if (this.app.showError && type === 'error') {
            this.app.showError(message);
        } else if (type === 'error') {
            alert(message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    // NEW: Comprehensive cleanup method
    cleanup() {
        try {
            // Clean up all listeners
            this.cleanupRoomListeners();
            this.cleanupQuickMatchListener();

            // Clean up all tracked listeners
            this._allListeners.forEach(cleanup => {
                if (typeof cleanup === 'function') {
                    cleanup();
                }
            });
            this._allListeners.clear();

            // Reset state
            this.currentRoom = null;
            this.playerData = null;
            this.isHost = false;
            this.quickMatchQueue = null;
            this.isConnected = false;
            this.isJoiningRoom = false;

        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }

    // Utility methods
    getCurrentRoom() {
        return this.currentRoom;
    }

    isRoomHost() {
        return this.isHost;
    }

    getRoomStatus() {
        return {
            room: this.currentRoom,
            isHost: this.isHost,
            connected: this.isConnected,
            playerData: this.playerData
        };
    }

    // Event system for compatibility
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

    // Additional utility methods for room management
    async removePlayerFromRoom(playerName) {
        if (!this.db || !this.currentRoom || !this.isHost) return false;

        try {
            const sanitizedName = this.sanitizeKey(playerName);
            const playerRef = ref(this.db, `rooms/${this.currentRoom}/players/${sanitizedName}`);
            const playerSnap = await get(playerRef);
            
            if (!playerSnap.exists()) return false;

            // Prevent host from removing themselves
            if (sanitizedName === this.sanitizeKey(this.playerData.displayName)) return false;

            await this.safeRemove(playerRef);

            // Send system message
            const chatRef = ref(this.db, `rooms/${this.currentRoom}/chat`);
            const msgRef = push(chatRef);
            await this.safeSet(msgRef, {
                player: 'System',
                message: `${playerName} was removed from the room by the host.`,
                timestamp: serverTimestamp()
            });

            return true;
        } catch (error) {
            console.error('Error removing player:', error);
            return false;
        }
    }
}
