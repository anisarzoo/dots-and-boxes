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

    async requestRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom || !this.networkManager.playerData) {
            return false;
        }

        if (this.isProcessing) return false;
        this.isProcessing = true;

        try {
            const roomCode = this.networkManager.currentRoom;
            const playerName = this.networkManager.playerData.displayName;
            const sanitizedName = this.networkManager.sanitizeKey(playerName);
            const activeDb = this._getDb();
            const gameStateRef = ref(activeDb, `rooms/${roomCode}/gameState`);

            const txn = await runTransaction(gameStateRef, (currentState) => {
                const nextState = (currentState && typeof currentState === 'object') ? { ...currentState } : {};

                if (!nextState.rematchRequests || typeof nextState.rematchRequests !== 'object') {
                    nextState.rematchRequests = {};
                }

                nextState.rematchRequests[sanitizedName] = {
                    requested: true,
                    timestamp: Date.now()
                };

                const players = Array.isArray(nextState.players) ? nextState.players : [];
                const allRequested = players.length > 0 && players.every((p) => {
                    const sName = this.networkManager.sanitizeKey(p.displayName);
                    return nextState.rematchRequests[sName]?.requested === true;
                });

                if (allRequested) {
                    nextState.rematchReady = true;
                }

                return nextState;
            });

            if (!txn.committed) return false;

            const finalState = txn.snapshot.val() || {};
            const players = Array.isArray(finalState.players) ? finalState.players : [];
            const allRequested = players.length > 0 && players.every((p) => {
                const sName = this.networkManager.sanitizeKey(p.displayName);
                return finalState.rematchRequests?.[sName]?.requested === true;
            });

            this.rematchReady = finalState.rematchReady === true;
            return allRequested || this.rematchReady;
        } catch (error) {
            return false;
        } finally {
            this.isProcessing = false;
        }
    }

    async confirmRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom) return false;

        try {
            const roomCode = this.networkManager.currentRoom;
            const activeDb = this._getDb();
            const roomRef = ref(activeDb, `rooms/${roomCode}`);
            const roomSnap = await get(roomRef);

            if (!roomSnap.exists()) throw new Error('Room data not found');
            const roomData = roomSnap.val();

            const gridSize = roomData.gridSize || 5;
            const connectedPlayers = Object.values(roomData.players || {})
                .filter((p) => p.connected !== false)
                .map((p, idx) => ({
                    id: idx + 1,
                    displayName: p.displayName || p.name || `Player ${idx + 1}`,
                    identity: p.identity || `player_${idx}`,
                    photoURL: p.photoURL || null,
                    isHost: p.isHost || false,
                    score: 0,
                    color: p.color || this._getPlayerColor(idx + 1)
                }));

            if (connectedPlayers.length < 2) return false;

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: connectedPlayers,
                currentPlayer: 0,
                gridSize,
                gameState: 'playing',
                isRematch: true,
                rematchReady: false,
                rematchRequests: {}
            };

            await update(roomRef, {
                status: 'playing',
                gameState: freshGameState,
                gameStartedAt: serverTimestamp()
            });

            const chatRef = ref(activeDb, `rooms/${roomCode}/chat`);
            await remove(chatRef);
            const msgRef = push(chatRef);
            await set(msgRef, {
                player: 'System',
                identity: 'system',
                message: 'Rematch started! Good luck everyone!',
                timestamp: serverTimestamp()
            });

            this.rematchReady = false;
            return true;
        } catch (error) {
            return false;
        }
    }

    setupRematchListener(onRematchReady) {
        if (!this.networkManager || !this.networkManager.currentRoom) return;
        this.cleanup();

        const roomCode = this.networkManager.currentRoom;
        const activeDb = this._getDb();

        this.rematchListenerRef = ref(activeDb, `rooms/${roomCode}/gameState`);
        this.rematchListener = onValue(this.rematchListenerRef, (snapshot) => {
            const gameState = snapshot.exists() ? snapshot.val() : {};
            if (gameState.rematchReady === true) {
                this.rematchReady = true;
                if (typeof onRematchReady === 'function') {
                    onRematchReady();
                }
            }
        });
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
