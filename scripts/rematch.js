// Rematch Manager - Handles multiplayer rematch requests and synchronization
import { supabase } from './supabase-config.js';

export class RematchManager {
    constructor(app, networkManager, gameInstance) {
        this.app = app;
        this.networkManager = networkManager;
        this.gameInstance = gameInstance;
        this.rematchRequests = new Map(); // Track who requested rematch
        this.rematchReady = false;
        this.isProcessing = false;
        this.rematchChannel = null;
    }

    async requestRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom || !this.networkManager.playerData) {
            console.warn('[RematchManager] Cannot request rematch: missing network data');
            return false;
        }

        if (this.isProcessing) return false;
        this.isProcessing = true;

        try {
            const roomCode = this.networkManager.currentRoom;
            const playerName = this.networkManager.playerData.displayName;
            const sanitizedName = this.networkManager.sanitizeKey(playerName);

            // Get current room configuration
            const { data: roomData, error } = await supabase
                .from('rooms')
                .select('game_state')
                .eq('code', roomCode)
                .single();

            if (error || !roomData) throw new Error('Could not fetch room');

            let gameState = roomData.game_state || {};
            // Initialize rematch property if missing
            if (!gameState.rematchRequests) gameState.rematchRequests = {};

            gameState.rematchRequests[sanitizedName] = { requested: true, timestamp: new Date().toISOString() };

            // Check if all requested
            const players = gameState.players || [];
            // Assuming active players
            const allRequested = players.every(p => {
                const sName = this.networkManager.sanitizeKey(p.displayName);
                return gameState.rematchRequests[sName]?.requested === true;
            });

            if (allRequested) {
                gameState.rematchReady = true;
            }

            await supabase
                .from('rooms')
                .update({ game_state: gameState })
                .eq('code', roomCode);

            this.isProcessing = false;
            return allRequested;

        } catch (error) {
            console.error('[RematchManager] Error requesting rematch:', error);
            this.isProcessing = false;
            return false;
        }
    }

    async confirmRematch() {
        if (!this.networkManager || !this.networkManager.currentRoom) return false;

        try {
            const roomCode = this.networkManager.currentRoom;

            const { data: roomData } = await supabase
                .from('rooms')
                .select('*')
                .eq('code', roomCode)
                .single();

            if (!roomData || !roomData.players) throw new Error('Room data not found');

            const gridSize = roomData.grid_size || 5;

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

            if (connectedPlayers.length < 2) return false;

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: connectedPlayers,
                currentPlayer: 0,
                gridSize: gridSize,
                gameState: 'playing',
                isRematch: true
            };

            await supabase
                .from('rooms')
                .update({
                    status: 'playing',
                    game_state: freshGameState,
                    game_started_at: new Date().toISOString()
                })
                .eq('code', roomCode);

            // Send system message
            await supabase
                .from('room_chat')
                .delete()
                .eq('room_code', roomCode);

            await supabase.from('room_chat').insert({
                room_code: roomCode,
                player: 'System',
                identity: 'system',
                message: '🎮 Rematch started! Good luck everyone!'
            });

            return true;
        } catch (error) {
            console.error('[RematchManager] Error confirming rematch:', error);
            return false;
        }
    }

    setupRematchListener(onRematchReady) {
        if (!this.networkManager || !this.networkManager.currentRoom) return;
        this.cleanup();

        const roomCode = this.networkManager.currentRoom;

        this.rematchChannel = supabase.channel(`rematch:${roomCode}`)
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` },
                (payload) => {
                    const gameState = payload.new.game_state || {};
                    if (gameState.rematchReady === true) {
                        if (typeof onRematchReady === 'function') {
                            onRematchReady();
                        }
                    }
                }
            )
            .subscribe();
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
            console.error('[RematchManager] Error resetting game state:', error);
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
        if (this.rematchChannel) {
            this.rematchChannel.unsubscribe();
            this.rematchChannel = null;
        }
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
