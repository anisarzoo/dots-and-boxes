// Rematch Manager - Handles multiplayer rematch requests and synchronization
import { db } from './firebase-config.js';
import {
    ref,
    get,
    set,
    update,
    remove,
    push,
    onValue,
    off,
    runTransaction,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

export class RematchManager {
    constructor(app, networkManager, gameInstance) {
        this.app = app;
        this.networkManager = networkManager;
        this.gameInstance = gameInstance;
        this.rematchRequests = new Map();
        this.rematchReady = false;
        this.isProcessing = false;
        this.rematchListenerRef = null;
        this.rematchListener = null;
    }

    _getDb() {
        return this.networkManager?.db || db;
    }

    async initializeRematchState(roomCode, currentPlayers) {
        if (!this.networkManager || !this.networkManager.playerData) return false;
        const activeDb = this._getDb();
        const rematchStateRef = ref(activeDb, `rooms/${roomCode}/rematchState`);
        const localPlayerName = this.networkManager.playerData.displayName;
        const localPlayerKey = this.networkManager.sanitizeKey(localPlayerName);

        try {
            const txnResult = await runTransaction(rematchStateRef, (currentState) => {
                // If it already exists and is active, don't overwrite it
                if (currentState && currentState.active === true) {
                    return currentState;
                }

                // Construct initial players list
                const playersMap = {};
                currentPlayers.forEach((p) => {
                    const sName = this.networkManager.sanitizeKey(p.displayName || p.name);
                    playersMap[sName] = {
                        displayName: p.displayName || p.name,
                        identity: p.identity || "",
                        status: sName === localPlayerKey ? 'agreed' : 'pending'
                    };
                });

                return {
                    active: true,
                    startTime: serverTimestamp(),
                    hostId: this.networkManager.playerData.identity || "",
                    players: playersMap
                };
            });

            return txnResult.committed;
        } catch (error) {
            console.error('[Rematch] Error initializing rematch state:', error);
            return false;
        }
    }

    async voteRematch(roomCode, status) {
        if (!this.networkManager || !this.networkManager.playerData) return false;
        const activeDb = this._getDb();
        const playerName = this.networkManager.playerData.displayName;
        const sanitizedName = this.networkManager.sanitizeKey(playerName);
        const playerVoteRef = ref(activeDb, `rooms/${roomCode}/rematchState/players/${sanitizedName}/status`);
        
        try {
            await set(playerVoteRef, status);
            return true;
        } catch (error) {
            console.error('[Rematch] Error voting:', error);
            return false;
        }
    }

    listenToRematchState(roomCode, onUpdate) {
        if (!this.networkManager || !roomCode) return;
        this.cleanup();

        const activeDb = this._getDb();
        this.rematchListenerRef = ref(activeDb, `rooms/${roomCode}/rematchState`);
        this.rematchListener = onValue(this.rematchListenerRef, (snapshot) => {
            const data = snapshot.exists() ? snapshot.val() : null;
            if (typeof onUpdate === 'function') {
                onUpdate(data);
            }
        });
    }

    async resolveRematchState(roomCode, agreedPlayers) {
        if (!this.networkManager) return false;
        const activeDb = this._getDb();
        const roomRef = ref(activeDb, `rooms/${roomCode}`);

        try {
            const roomSnap = await get(roomRef);
            if (!roomSnap.exists()) return false;
            const roomData = roomSnap.val();

            const gridSize = roomData.gridSize || 5;

            // Reconstruct the players list for both the room players node and the game state list
            const finalPlayersObj = {};
            const finalPlayersArr = [];

            // We iterate over the agreed players, re-indexing their IDs starting from 1
            agreedPlayers.forEach((p, idx) => {
                const sName = this.networkManager.sanitizeKey(p.displayName);
                const originalRoomPlayer = roomData.players?.[sName] || {};
                
                finalPlayersObj[sName] = {
                    ...originalRoomPlayer,
                    connected: true // Ensure they are marked connected
                };

                finalPlayersArr.push({
                    id: idx + 1,
                    displayName: p.displayName,
                    identity: p.identity || `player_${idx}`,
                    photoURL: originalRoomPlayer.photoURL || null,
                    isHost: originalRoomPlayer.isHost || false,
                    score: 0,
                    color: originalRoomPlayer.color || this._getPlayerColor(idx + 1)
                });
            });

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: finalPlayersArr,
                currentPlayer: 0,
                gridSize,
                gameState: 'playing',
                isRematch: true,
                rematchReady: false,
                rematchRequests: {}
            };

            // Atomic update to reset the room state
            const updates = {
                status: 'playing',
                players: finalPlayersObj,
                gameState: freshGameState,
                gameStartedAt: serverTimestamp(),
                rematchState: null,
                rematchRequests: null,
                rematchReady: null
            };

            await update(roomRef, updates);

            // Clean up room chat and send start message
            const chatRef = ref(activeDb, `rooms/${roomCode}/chat`);
            await remove(chatRef);
            const msgRef = push(chatRef);
            await set(msgRef, {
                player: 'System',
                identity: 'system',
                message: 'Rematch started! Good luck everyone!',
                timestamp: serverTimestamp()
            });

            return true;
        } catch (error) {
            console.error('[Rematch] Error resolving rematch:', error);
            return false;
        }
    }

    async cancelRematchState(roomCode) {
        const activeDb = this._getDb();
        const roomRef = ref(activeDb, `rooms/${roomCode}`);
        try {
            await update(roomRef, {
                status: 'finished',
                rematchState: null,
                rematchRequests: null,
                rematchReady: null
            });
            return true;
        } catch (error) {
            console.error('[Rematch] Error cancelling rematch:', error);
            return false;
        }
    }

    resetGameState() {
        if (!this.gameInstance) return false;
        try {
            this.gameInstance.lines = new Set();
            this.gameInstance.lineOwners = new Map();
            this.gameInstance.boxes = [];
            this.gameInstance.currentPlayerIndex = 0;
            this.gameInstance.gameState = 'playing';
            this.gameInstance.animationQueue = [];
            this.gameInstance.isAnimating = false;

            this.gameInstance.players = this.gameInstance.players.map(p => ({ ...p, score: 0 }));

            this.gameInstance.grid = this.gameInstance.initializeGrid();
            this.gameInstance.dotOffsets.clear();
            this.gameInstance.lineSegments.clear();

            this._rebindCanvasEvents();

            this.gameInstance.updateUI();
            this.gameInstance.draw();

            return true;
        } catch (error) {
            return false;
        }
    }

    _rebindCanvasEvents() {
        if (!this.gameInstance || !this.gameInstance.canvas) return;

        const oldCanvas = this.gameInstance.canvas;
        const newCanvas = oldCanvas.cloneNode(true);
        oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);

        this.gameInstance.canvas = newCanvas;
        this.gameInstance.ctx = newCanvas.getContext('2d');
        this.gameInstance._boundPointerDown = null;
        this.gameInstance._boundPointerMove = null;

        if (typeof this.gameInstance.bindCanvasEvents === 'function') {
            this.gameInstance.bindCanvasEvents();
        }
    }

    _getPlayerColor(playerIndex) {
        const colors = ['#e74c3c', '#3498db', '#27ae60', '#2c3e50'];
        return colors[playerIndex - 1] || '#333333';
    }

    cleanup() {
        if (this.rematchListener && this.rematchListenerRef) {
            off(this.rematchListenerRef, 'value', this.rematchListener);
            this.rematchListener = null;
        }
        this.rematchListenerRef = null;
        this.rematchRequests.clear();
        this.rematchReady = false;
        this.isProcessing = false;
    }

    isLocalPlayerHost() {
        if (!this.networkManager || !this.networkManager.playerData) return false;
        return this.networkManager.playerData.isHost === true;
    }

    getRematchStatus() {
        return {
            rematchReady: this.rematchReady,
            isProcessing: this.isProcessing,
            requestCount: this.rematchRequests.size
        };
    }
}
