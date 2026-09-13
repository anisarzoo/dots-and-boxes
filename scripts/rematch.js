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

                // Preserve any votes cast before initialization (e.g. someone clicked Quit first)
                const existingPlayers = (currentState && currentState.players) ? currentState.players : {};

                // Construct initial players list
                const playersMap = {};
                currentPlayers.forEach((p) => {
                    const sName = this.networkManager.sanitizeKey(p.displayName || p.name);
                    const existingVote = existingPlayers[sName]?.status;
                    let initialStatus = 'pending';
                    if (sName === localPlayerKey) {
                        initialStatus = 'agreed';
                    } else if (existingVote === 'declined') {
                        initialStatus = 'declined';
                    }

                    playersMap[sName] = {
                        displayName: p.displayName || p.name,
                        identity: p.identity || "",
                        status: initialStatus
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
        if (!this.networkManager || this.isProcessing) return false;
        this.isProcessing = true;
        const activeDb = this._getDb();
        const roomRef = ref(activeDb, `rooms/${roomCode}`);

        try {
            const roomSnap = await get(roomRef);
            if (!roomSnap.exists()) {
                this.isProcessing = false;
                return false;
            }
            const roomData = roomSnap.val();

            const gridSize = roomData.gridSize || 5;

            // Reconstruct the players list for both the room players node and the game state list
            const finalPlayersObj = {};
            const finalPlayersArr = [];

            // Determine host: preserve original host if still in agreedPlayers, else coordinator (first agreed) is new host
            const originalHostIdentity = roomData.host;
            const originalHostStillPresent = agreedPlayers.some(p => p.identity === originalHostIdentity);
            const newHostIdentity = originalHostStillPresent ? originalHostIdentity : (agreedPlayers[0]?.identity || null);

            // Iterate over agreed players, re-indexing their IDs starting from 1
            agreedPlayers.forEach((p, idx) => {
                const sName = this.networkManager.sanitizeKey(p.displayName);
                const originalRoomPlayer = roomData.players?.[sName] || {};
                const isHostPlayer = p.identity === newHostIdentity || (!newHostIdentity && idx === 0);
                
                finalPlayersObj[sName] = {
                    ...originalRoomPlayer,
                    isHost: isHostPlayer,
                    connected: true // Ensure they are marked connected
                };

                finalPlayersArr.push({
                    id: idx + 1,
                    displayName: p.displayName,
                    identity: p.identity || `player_${idx}`,
                    photoURL: originalRoomPlayer.photoURL || null,
                    isHost: isHostPlayer,
                    score: 0,
                    color: originalRoomPlayer.color || this._getPlayerColor(idx + 1)
                });
            });

            // Update local host flag if this client is the new host
            if (this.networkManager && this.networkManager.playerData) {
                this.networkManager.isHost = (this.networkManager.playerData.identity === newHostIdentity);
            }

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: finalPlayersArr,
                currentPlayer: 0,
                gridSize,
                gameState: 'playing',
                isRematch: true
            };

            // Atomic update to reset the room state
            const updates = {
                status: 'playing',
                players: finalPlayersObj,
                gameState: freshGameState,
                gameStartedAt: serverTimestamp(),
                rematchState: null
            };

            if (newHostIdentity) {
                updates.host = newHostIdentity;
            }

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
        } finally {
            this.isProcessing = false;
        }
    }

    async cancelRematchState(roomCode) {
        const activeDb = this._getDb();
        const roomRef = ref(activeDb, `rooms/${roomCode}`);
        try {
            await update(roomRef, {
                status: 'finished',
                rematchState: {
                    active: false,
                    cancelled: true
                }
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
            this.gameInstance.animatingLines?.clear();
            this.gameInstance.hoveredLine = null;
            this.gameInstance.boxAnimationState = null;
            this.gameInstance._lastFinalScores = null;

            this.gameInstance.players = this.gameInstance.players.map(p => ({ ...p, score: 0 }));

            this.gameInstance.grid = this.gameInstance.initializeGrid();
            this.gameInstance.dotOffsets.clear();
            this.gameInstance.lineSegments.clear();

            if (typeof this.gameInstance.bindCanvasEvents === 'function') {
                this.gameInstance.bindCanvasEvents();
            }

            this.gameInstance.updateUI();
            this.gameInstance.draw();

            return true;
        } catch (error) {
            return false;
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
        this.isProcessing = false;
    }
}
