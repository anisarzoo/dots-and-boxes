// Rematch Manager - Handles multiplayer rematch requests and synchronization
export class RematchManager {
    constructor(app, networkManager, gameInstance) {
        this.app = app;
        this.networkManager = networkManager;
        this.gameInstance = gameInstance;
        this.rematchRequests = new Map(); // Track who requested rematch
        this.rematchListeners = []; // Store listeners for cleanup
        this.rematchReady = false;
        this.isProcessing = false;
    }

    /**
     * Request rematch from current player
     * Returns: true if rematch can proceed, false otherwise
     */
    async requestRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom || !this.networkManager.playerData) {
            console.warn('[RematchManager] Cannot request rematch: missing network data');
            return false;
        }

        if (this.isProcessing) {
            console.warn('[RematchManager] Rematch already processing');
            return false;
        }

        this.isProcessing = true;

        try {
            const roomCode = this.networkManager.currentRoom;
            const playerName = this.networkManager.playerData.displayName;
            const sanitizedName = this.networkManager.sanitizeKey(playerName);
            const db = this.networkManager.db;

            // 1. Mark this player as requesting rematch
            const rematchRef = ref(db, `rooms/${roomCode}/rematchRequests/${sanitizedName}`);
            await set(rematchRef, {
                requested: true,
                timestamp: serverTimestamp()
            });

            console.log(`[RematchManager] ${playerName} requested rematch`);

            // 2. Check if all connected players have requested rematch
            const allRequested = await this._checkAllRequested(roomCode, playerName);

            if (allRequested) {
                // 3. Mark rematch as ready in database
                await update(ref(db, `rooms/${roomCode}`), {
                    rematchReady: true,
                    rematchReadyAt: serverTimestamp()
                });
                console.log('[RematchManager] All players requested rematch - marking as ready');
                return true;
            } else {
                console.log('[RematchManager] Waiting for other players to request rematch');
                return false;
            }
        } catch (error) {
            console.error('[RematchManager] Error requesting rematch:', error);
            this.isProcessing = false;
            return false;
        }
    }

    /**
     * Confirm and start rematch (called when last player clicks rematch button)
     */
    async confirmRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom) {
            console.error('[RematchManager] Cannot confirm rematch: missing room data');
            return false;
        }

        if (this.isProcessing) {
            console.warn('[RematchManager] Rematch already processing');
            return false;
        }

        this.isProcessing = true;

        try {
            const roomCode = this.networkManager.currentRoom;
            const db = this.networkManager.db;

            // Get current room data
            const roomSnap = await get(ref(db, `rooms/${roomCode}`));
            const roomData = roomSnap.val();

            if (!roomData || !roomData.players) {
                throw new Error('Room data not found');
            }

            // Get grid size from room config
            const gridSize = roomData.gridSize || 5;

            // Build player list from connected players
            const connectedPlayers = Object.values(roomData.players || {})
                .filter(p => p.connected !== false)
                .map((p, idx) => ({
                    id: idx + 1,
                    displayName: p.displayName || p.name || `Player ${idx + 1}`,
                    identity: p.identity || `player_${idx}`,
                    photoURL: p.photoURL || null,
                    isHost: p.isHost || false,
                    score: 0,
                    color: p.color || this._getPlayerColor(idx + 1)
                }));

            if (connectedPlayers.length < 2) {
                console.error('[RematchManager] Not enough connected players for rematch');
                return false;
            }

            // Create fresh game state
            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: connectedPlayers,
                currentPlayer: 0,
                gridSize: gridSize,
                gameState: 'playing'
            };

            // Update database with new game state
            await update(ref(db, `rooms/${roomCode}`), {
                status: 'playing',
                gameState: freshGameState,
                rematchRequests: null,
                rematchReady: null,
                rematchStartedAt: serverTimestamp()
            });

            // Clear chat from previous game
            await remove(ref(db, `rooms/${roomCode}/chat`));

            // Send system message
            const chatRef = ref(db, `rooms/${roomCode}/chat`);
            const msgRef = push(chatRef);
            await set(msgRef, {
                player: 'System',
                message: '🎮 Rematch started! Good luck everyone!',
                timestamp: serverTimestamp()
            });

            console.log('[RematchManager] Rematch confirmed and started - game state updated');
            
            // Reset local game state immediately to prepare for new game state from server
            this.resetGameState();
            this.isProcessing = false;
            return true;
        } catch (error) {
            console.error('[RematchManager] Error confirming rematch:', error);
            this.isProcessing = false;
            return false;
        }
    }

    /**
     * Setup listener for rematch ready status
     */
    setupRematchListener(onRematchReady) {
        if (!this.networkManager || !this.networkManager.currentRoom) {
            console.warn('[RematchManager] Cannot setup rematch listener: missing room');
            return;
        }

        const roomCode = this.networkManager.currentRoom;
        const db = this.networkManager.db;
        const rematchRef = ref(db, `rooms/${roomCode}/rematchReady`);

        const listener = onValue(rematchRef, (snapshot) => {
            const rematchReady = snapshot.exists() ? snapshot.val() : null;
            if (rematchReady === true && typeof onRematchReady === 'function') {
                onRematchReady();
            }
        });

        this.rematchListeners.push({ ref: rematchRef, listener });
    }

    /**
     * Reset local game state for rematch
     */
    resetGameState() {
        if (!this.gameInstance) {
            console.warn('[RematchManager] No game instance to reset');
            return false;
        }

        try {
            // Reset game state
            this.gameInstance.lines = new Set();
            this.gameInstance.lineOwners = new Map();
            this.gameInstance.boxes = [];
            this.gameInstance.currentPlayerIndex = 0;
            this.gameInstance.gameState = 'playing';
            this.gameInstance.animationQueue = [];
            this.gameInstance.isAnimating = false;

            // Reset player scores
            this.gameInstance.players = this.gameInstance.players.map(p => ({
                ...p,
                score: 0
            }));

            // Clear canvas
            this.gameInstance.grid = this.gameInstance.initializeGrid();
            this.gameInstance.dotOffsets.clear();
            this.gameInstance.lineSegments.clear();

            // Rebind canvas events
            this._rebindCanvasEvents();

            // Update UI
            this.gameInstance.updateUI();
            this.gameInstance.draw();

            console.log('[RematchManager] Game state reset successfully');
            return true;
        } catch (error) {
            console.error('[RematchManager] Error resetting game state:', error);
            return false;
        }
    }

    /**
     * Check if all connected players have requested rematch
     */
    async _checkAllRequested(roomCode, currentPlayerName) {
        try {
            const db = this.networkManager.db;

            // Get players
            const playersSnap = await get(ref(db, `rooms/${roomCode}/players`));
            const players = playersSnap.val() || {};

            // Get rematch requests
            const rematchSnap = await get(ref(db, `rooms/${roomCode}/rematchRequests`));
            const rematchRequests = rematchSnap.val() || {};

            // Get connected players
            const connectedNames = Object.keys(players)
                .filter(k => players[k].connected !== false);

            // Check if all connected players have requested
            const allRequested = connectedNames.every(name => rematchRequests[name]?.requested === true);

            return allRequested && connectedNames.length >= 2;
        } catch (error) {
            console.error('[RematchManager] Error checking rematch requests:', error);
            return false;
        }
    }

    /**
     * Rebind canvas events after rematch
     */
    _rebindCanvasEvents() {
        if (!this.gameInstance || !this.gameInstance.canvas) {
            console.warn('[RematchManager] Cannot rebind: no canvas');
            return;
        }

        // Remove old event listeners by cloning and replacing canvas
        const oldCanvas = this.gameInstance.canvas;
        const newCanvas = oldCanvas.cloneNode(true);
        oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);

        // Update game instance reference
        this.gameInstance.canvas = newCanvas;
        this.gameInstance.ctx = newCanvas.getContext('2d');

        // Rebind events
        if (typeof this.gameInstance.bindCanvasEvents === 'function') {
            this.gameInstance.bindCanvasEvents();
        }
    }

    /**
     * Get player color (copied from app)
     */
    _getPlayerColor(playerIndex) {
        const colors = ['#e74c3c', '#3498db', '#27ae60', '#2c3e50'];
        return colors[playerIndex - 1] || '#333333';
    }

    /**
     * Cleanup rematch listeners and state
     */
    cleanup() {
        // Remove all listeners
        this.rematchListeners.forEach(({ ref: refObj, listener }) => {
            off(refObj, 'value', listener);
        });
        this.rematchListeners = [];
        this.rematchRequests.clear();
        this.rematchReady = false;
        this.isProcessing = false;
    }

    /**
     * Check if local player is host
     */
    isLocalPlayerHost() {
        if (!this.networkManager || !this.networkManager.playerData) {
            return false;
        }
        return this.networkManager.playerData.isHost === true;
    }

    /**
     * Get rematch status
     */
    getRematchStatus() {
        return {
            rematchReady: this.rematchReady,
            isProcessing: this.isProcessing,
            requestCount: this.rematchRequests.size
        };
    }
}

// Import Firebase functions at the top of the file
import {
    ref,
    set,
    get,
    update,
    remove,
    onValue,
    off,
    push,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
