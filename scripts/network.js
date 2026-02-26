import { supabase } from './supabase-config.js';

export class NetworkManager {
    constructor(app) {
        this.app = app;
        this.supabase = supabase;
        this.currentRoom = null;
        this.playerData = null;
        this.isHost = false;
        this.quickMatchQueueId = null;

        // Store subscription channels
        this.roomChannel = null;
        this.chatChannel = null;
        this.quickMatchChannel = null;
    }

    // Helper to get local player index by name
    getLocalPlayerIndex(players, localName) {
        if (!Array.isArray(players)) return -1;
        for (let i = 0; i < players.length; i++) {
            if (players[i].displayName === localName) return i;
        }
        return -1;
    }

    // Presence / Disconnect handling
    // Supabase Realtime Presence requires a channel. We'll handle this in setupRoomListeners
    async setupPresence(roomCode, displayName) {
        // Handled via roomChannel.track() in setupRoomListeners
    }

    async leaveRoom() {
        if (this.roomChannel) {
            await this.roomChannel.unsubscribe();
            this.roomChannel = null;
        }
        if (this.chatChannel) {
            await this.chatChannel.unsubscribe();
            this.chatChannel = null;
        }

        if (this.currentRoom && this.playerData) {
            try {
                // Remove player from the JSONB array in the room
                const { data: roomData } = await this.supabase
                    .from('rooms')
                    .select('players')
                    .eq('code', this.currentRoom)
                    .single();

                if (roomData && roomData.players) {
                    const players = roomData.players;
                    const sanitizedName = this.sanitizeKey(this.playerData.displayName);
                    if (players[sanitizedName]) {
                        players[sanitizedName].connected = false;
                        await this.supabase
                            .from('rooms')
                            .update({ players: players })
                            .eq('code', this.currentRoom);
                    }
                }

                // Send system disconnect message
                await this.supabase.from('room_chat').insert({
                    room_code: this.currentRoom,
                    player: 'System',
                    identity: 'system',
                    message: `${this.playerData.displayName} has left the game.`
                });

            } catch (e) {
                console.error("Error leaving room", e);
            }
        }

        this.currentRoom = null;
        this.playerData = null;
        this.isHost = false;
    }

    async createRoom(maxPlayers = 2, gridSize = 5, hostPlayer = null) {
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
                identity = this.generateIdentity(displayName);
                photoURL = null;
            }

            const initialPlayers = {
                [this.sanitizeKey(displayName)]: {
                    displayName: displayName,
                    identity: identity,
                    photoURL: photoURL,
                    isHost: true,
                    joinedAt: new Date().toISOString(),
                    connected: true
                }
            };

            const initialGameState = {
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
            };

            const { error } = await this.supabase.from('rooms').insert({
                code: roomCode,
                host: displayName,
                max_players: maxPlayers,
                grid_size: gridSize,
                players: initialPlayers,
                status: 'waiting',
                game_state: initialGameState
            });

            if (error) throw error;

            this.currentRoom = roomCode;
            this.isHost = true;
            this.playerData = initialPlayers[this.sanitizeKey(displayName)];

            this.setupRoomListeners(roomCode);

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
        try {
            let playerName, identity, photoURL;
            if (joinPlayer && joinPlayer.displayName && joinPlayer.identity) {
                playerName = joinPlayer.displayName;
                identity = joinPlayer.identity;
                photoURL = joinPlayer.photoURL || null;
            } else {
                const playerNameRaw = this.app.getPlayerName();
                playerName = (typeof playerNameRaw === 'string' && playerNameRaw.trim() !== '') ? playerNameRaw.trim() : 'Player';
                identity = this.generateIdentity(playerName);
                photoURL = null;
            }

            // Get room data
            const { data: roomData, error } = await this.supabase
                .from('rooms')
                .select('*')
                .eq('code', roomCode)
                .single();

            if (error || !roomData) {
                this.showError('Room not found or invalid.');
                return false;
            }

            const players = roomData.players || {};

            if (Object.keys(players).length >= (roomData.max_players || 2)) {
                this.showError('Room is full. Please try another code.');
                return false;
            }

            const existingIdentities = Object.values(players).map(p => p.identity);
            if (existingIdentities.includes(identity)) {
                this.showError('You are already in this room.');
                return false;
            }

            let baseName = playerName;
            let nameIndex = 1;
            const existingNames = Object.values(players).map(p => p.displayName);
            while (existingNames.includes(baseName)) {
                nameIndex++;
                baseName = playerName + nameIndex;
            }

            if (baseName !== playerName) {
                this.showError(`Name already taken. You have been renamed to ${baseName}`);
                identity = this.generateIdentity(baseName); // regenerate
            }

            const sanitizedName = this.sanitizeKey(baseName);

            players[sanitizedName] = {
                displayName: baseName,
                identity: identity,
                photoURL: photoURL,
                isHost: false,
                joinedAt: new Date().toISOString(),
                connected: true
            };

            // Update room
            const { error: updateError } = await this.supabase
                .from('rooms')
                .update({ players: players })
                .eq('code', roomCode);

            if (updateError) throw updateError;

            this.currentRoom = roomCode;
            this.isHost = false;
            this.playerData = players[sanitizedName];

            this.setupRoomListeners(roomCode);
            return true;
        } catch (error) {
            console.error('Error joining room:', error);
            this.showError('Failed to join room. Please try again.');
            return false;
        }
    }

    async startGame() {
        if (!this.currentRoom || !this.isHost) return;

        try {
            const { data: roomData } = await this.supabase
                .from('rooms')
                .select('*')
                .eq('code', this.currentRoom)
                .single();

            const playersObj = roomData.players || {};
            const gridSize = roomData.grid_size || 5;

            const playersArr = Object.values(playersObj)
                .filter(p => p.connected !== false)
                .map((p, idx) => ({
                    id: idx + 1,
                    displayName: p.displayName || `Player ${idx + 1}`,
                    identity: p.identity || `player_${idx}`,
                    photoURL: p.photoURL || null,
                    isHost: p.isHost || false,
                    score: 0
                }));

            if (playersArr.length < 2) {
                console.warn('[network.js] Not enough players to start game');
                return;
            }

            const freshGameState = {
                lines: [],
                lineOwners: {},
                boxes: [],
                players: playersArr,
                currentPlayer: 0,
                gridSize: gridSize,
                gameState: 'playing'
            };

            await this.supabase
                .from('rooms')
                .update({
                    status: 'playing',
                    game_started_at: new Date().toISOString(),
                    game_state: freshGameState
                })
                .eq('code', this.currentRoom);

        } catch (error) {
            console.error('Error starting game:', error);
        }
    }

    async updateGameState(gameState) {
        if (!this.currentRoom) return;
        try {
            if (Array.isArray(gameState.players)) {
                gameState.players = gameState.players.map(p => {
                    const player = { ...p };
                    Object.keys(player).forEach(key => {
                        if (player[key] === undefined) delete player[key];
                    });
                    if (!player.identity) player.identity = this.generateIdentity(player.displayName);
                    return player;
                });
            }

            await this.supabase
                .from('rooms')
                .update({ game_state: gameState })
                .eq('code', this.currentRoom);
        } catch (error) {
            console.error('Error updating game state:', error);
        }
    }

    async makeMove(moveData) {
        if (this.app.gameInstance && typeof this.app.gameInstance.getNetworkGameState === 'function') {
            const fullGameState = this.app.gameInstance.getNetworkGameState();
            await this.updateGameState(fullGameState);
        }
    }

    async endGame(gameResult) {
        if (!this.currentRoom) return;
        try {
            await this.supabase
                .from('rooms')
                .update({
                    status: 'finished',
                    game_result: gameResult,
                    game_ended_at: new Date().toISOString()
                })
                .eq('code', this.currentRoom);
        } catch (error) {
            console.error('Error ending game:', error);
        }
    }

    async sendChatMessage(message) {
        if (!this.currentRoom) return;
        let content = typeof message === 'string' ? message : (message.content || message.message || '');
        if (!content.trim()) return;

        try {
            await this.supabase.from('room_chat').insert({
                room_code: this.currentRoom,
                player: this.app.getPlayerName(),
                identity: this.playerData?.identity || '',
                message: content.trim()
            });
        } catch (error) {
            console.error('Error sending chat message:', error);
        }
    }

    setupRoomListeners(roomCode) {
        if (this.roomChannel) this.roomChannel.unsubscribe();
        if (this.chatChannel) this.chatChannel.unsubscribe();

        // 1. Listen to Room Updates (Players, GameState, Status)
        this.roomChannel = this.supabase.channel(`room:${roomCode}`)
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` },
                (payload) => {
                    const roomData = payload.new;

                    // Players Update
                    if (roomData.players) {
                        const playerList = Object.values(roomData.players).map(p => ({
                            ...p,
                            displayName: p.displayName || p.name || 'Player'
                        }));
                        this.app.updateLobbyPlayers(playerList);
                    }

                    // Game State Update
                    if (roomData.game_state && this.app.gameInstance) {
                        const gameState = roomData.game_state;
                        // Avoid applying our own state if it matches exactly? Handled by handleNetworkUpdate logic usually
                        if (Array.isArray(gameState.players)) {
                            const localName = this.app.getPlayerName();
                            const localIndex = this.getLocalPlayerIndex(gameState.players, localName);
                            this.app.gameInstance.localPlayerIndex = localIndex;
                        }
                        this.app.gameInstance.handleNetworkUpdate(gameState);
                    }

                    // Status Update
                    if (roomData.status === 'playing') {
                        // Start if we haven't yet or if game was destroyed (rematch)
                        if (this.app.currentScreen !== 'gameScreen' || !this.app.gameInstance) {
                            this.app.startNetworkGame();
                        }
                    }
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    // Fetch initial state
                    this.supabase.from('rooms').select('*').eq('code', roomCode).single().then(({ data }) => {
                        if (data && data.players) {
                            const playerList = Object.values(data.players).map(p => ({
                                ...p, displayName: p.displayName || p.name || 'Player'
                            }));
                            this.app.updateLobbyPlayers(playerList);
                        }
                    });
                }
            });

        // 2. Listen to Room Chat
        this.chatChannel = this.supabase.channel(`chat:${roomCode}`)
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'room_chat', filter: `room_code=eq.${roomCode}` },
                (payload) => {
                    if (this.app.chatManager) {
                        const msg = payload.new;
                        this.app.chatManager.addMessage({
                            player: msg.player,
                            identity: msg.identity,
                            message: msg.message,
                            timestamp: new Date(msg.created_at).getTime()
                        });
                    }
                }
            )
            .subscribe();
    }

    // Quick Match Logic 
    async startQuickMatch() {
        try {
            const playerName = this.app.getPlayerName();
            const identity = this.generateIdentity(playerName);
            const gridSize = (typeof this.app.getSelectedGridSize === 'function') ? this.app.getSelectedGridSize() : 5;

            // Look for waiting players
            const { data: waitingQueue } = await this.supabase
                .from('quick_match_queue')
                .select('*')
                .eq('status', 'waiting')
                .neq('id', identity)
                .limit(1);

            if (waitingQueue && waitingQueue.length > 0) {
                // Match found!
                const opponent = waitingQueue[0];
                const roomCode = this.generateRoomCode();

                // Generate identities ONCE and pass them through
                const hostIdentity = this.generateIdentity(playerName);
                const opponentIdentity = this.generateIdentity(opponent.name);

                // Create room with consistent identities
                await this.createQuickMatchRoom(roomCode, playerName, opponent.name, gridSize, hostIdentity, opponentIdentity);

                // Update opponent queue entry
                await this.supabase
                    .from('quick_match_queue')
                    .update({ status: 'matched', room_code: roomCode })
                    .eq('id', opponent.id);

                this.currentRoom = roomCode;
                this.isHost = true;
                // Set playerData with the SAME identity used in room creation
                this.playerData = {
                    displayName: playerName,
                    identity: hostIdentity,
                    isHost: true,
                    connected: true
                };
                this.setupRoomListeners(roomCode);

                // Set game status to playing
                await this.supabase.from('rooms').update({ status: 'playing', game_started_at: new Date().toISOString() }).eq('code', roomCode);

                this.app.handleQuickMatchFound();
                if (this.isHost && typeof this.startGame === 'function') {
                    this.startGame();
                }

                return { matched: true, roomCode };
            } else {
                // Add self to queue
                this.quickMatchQueueId = identity;
                await this.supabase.from('quick_match_queue').upsert({
                    id: identity,
                    name: playerName,
                    status: 'waiting'
                });

                this.setupQuickMatchListeners();
                return { matched: false, queued: true };
            }

        } catch (error) {
            console.error('Quick match error:', error);
            this.showError('Quick match failed.');
            return false;
        }
    }

    setupQuickMatchListeners() {
        if (!this.quickMatchQueueId) return;

        this.quickMatchChannel = this.supabase.channel('quickmatch')
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'quick_match_queue', filter: `id=eq.${this.quickMatchQueueId}` },
                async (payload) => {
                    const data = payload.new;
                    if (data.status === 'matched' && data.room_code) {
                        // Cleanup
                        if (this.quickMatchChannel) this.quickMatchChannel.unsubscribe();
                        await this.supabase.from('quick_match_queue').delete().eq('id', this.quickMatchQueueId);
                        this.quickMatchQueueId = null;

                        // Join
                        this.currentRoom = data.room_code;
                        this.isHost = false;

                        // Fetch room data to get our playerData identity
                        try {
                            const { data: roomData } = await this.supabase
                                .from('rooms')
                                .select('players')
                                .eq('code', data.room_code)
                                .single();
                            if (roomData && roomData.players) {
                                const playerName = this.app.getPlayerName();
                                const sanitizedName = this.sanitizeKey(playerName);
                                if (roomData.players[sanitizedName]) {
                                    this.playerData = roomData.players[sanitizedName];
                                }
                            }
                        } catch (e) { console.warn('[network] Could not fetch playerData for QM', e); }

                        this.setupRoomListeners(data.room_code);
                        this.app.handleQuickMatchFound();
                    }
                }
            )
            .subscribe();
    }

    async cancelQuickMatch() {
        if (!this.quickMatchQueueId) return;
        if (this.quickMatchChannel) this.quickMatchChannel.unsubscribe();
        await this.supabase.from('quick_match_queue').delete().eq('id', this.quickMatchQueueId);
        this.quickMatchQueueId = null;
    }

    async createQuickMatchRoom(roomCode, player1, player2, gridSize = 5, identity1 = null, identity2 = null) {
        if (!identity1) identity1 = this.generateIdentity(player1);
        if (!identity2) identity2 = this.generateIdentity(player2);

        const players = {
            [this.sanitizeKey(player1)]: { displayName: player1, identity: identity1, isHost: true, joinedAt: new Date().toISOString(), connected: true },
            [this.sanitizeKey(player2)]: { displayName: player2, identity: identity2, isHost: false, joinedAt: new Date().toISOString(), connected: true }
        };

        const initialGameState = {
            lines: [], lineOwners: {}, boxes: [],
            players: [
                { id: 1, displayName: player1, identity: identity1, isHost: true, score: 0 },
                { id: 2, displayName: player2, identity: identity2, isHost: false, score: 0 }
            ],
            currentPlayer: 0, gridSize: gridSize, gameState: 'playing'
        };

        await this.supabase.from('rooms').insert({
            code: roomCode,
            host: player1,
            max_players: 2,
            grid_size: gridSize,
            players: players,
            status: 'waiting',
            is_quick_match: true,
            game_state: initialGameState
        });
    }

    async removePlayerFromRoom(playerName) {
        if (!this.currentRoom || !this.isHost) return false;
        try {
            const { data: roomData } = await this.supabase.from('rooms').select('players').eq('code', this.currentRoom).single();
            if (!roomData || !roomData.players) return false;

            const players = roomData.players;
            const sanitizedName = this.sanitizeKey(playerName);

            if (sanitizedName === this.sanitizeKey(this.playerData.displayName)) return false;

            if (players[sanitizedName]) {
                delete players[sanitizedName];
                await this.supabase.from('rooms').update({ players: players }).eq('code', this.currentRoom);

                await this.supabase.from('room_chat').insert({
                    room_code: this.currentRoom,
                    player: 'System',
                    identity: 'system',
                    message: `${playerName} was removed by the host.`
                });
                return true;
            }
            return false;
        } catch (e) { return false; }
    }

    // Utilities
    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        return Array.from({ length: 4 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
    }

    sanitizeKey(str) {
        return String(str || '').replace(/[.#$\/\[\]]/g, '_');
    }

    generateIdentity(name) {
        return `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
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

    getCurrentRoom() { return this.currentRoom; }
    isRoomHost() { return this.isHost; }
    getRoomStatus() {
        if (!this.currentRoom) return null;
        return { room: this.currentRoom, isHost: this.isHost, connected: true };
    }

    // Legacy event stub
    on(event, callback) { }
    trigger(event, data) { }
}
