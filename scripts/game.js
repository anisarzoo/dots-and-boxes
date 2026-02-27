// Game Logic - Dots and Boxes core gameplay
export class DotsAndBoxesGame {
    // Legacy rematch function for local games
    // For networked games, use RematchManager instead
    rematch() {
        // console.log('[Game] Rematch called - delegating to RematchManager for network games');

        // For local games, reset directly
        if (this.isLocal) {
            this.lines = new Set();
            this.lineOwners = new Map();
            this.boxes = [];
            this.currentPlayerIndex = 0;
            this.gameState = 'playing';
            this.animationQueue = [];
            this.isAnimating = false;

            this.players = this.players.map(p => ({ ...p, score: 0 }));
            this.grid = this.initializeGrid();
            this.dotOffsets.clear();
            this.lineSegments.clear();

            this.updateUI();
            this.draw();
            return;
        }

        // For network games, use RematchManager (if available)
        if (this.rematchManager && typeof this.rematchManager.resetGameState === 'function') {
            this.rematchManager.resetGameState();
        }
    }
    constructor(config) {
        // ...existing code...
        this.players = (config.players || []).map((p, idx) => ({
            ...p,
            displayName: p.displayName || p.name,
            id: p.id !== undefined ? p.id : idx + 1
        }));
        this.gridSize = config.gridSize;
        this.isLocal = config.isLocal || false;
        this.soundManager = config.soundManager;
        this.networkManager = config.networkManager;
        this.rematchManager = null; // Will be set by app
        this.roomId = config.roomId || (this.isLocal ? null : this.generateRoomId());
        // Game state
        this.currentPlayerIndex = 0;
        this.gameState = 'waiting';
        this.grid = this.initializeGrid();
        this.lines = new Set();
        this.lineOwners = new Map();
        this.boxes = [];
        this.canvas = null;
        this.ctx = null;
        // Visual settings
        this.dotSize = 6;
        this.lineWidth = 4;
        this.gridSpacing = 40;
        this.canvasSize = this.calculateCanvasSize();
        // Hand-drawn effect storage
        this.dotOffsets = new Map();
        this.lineSegments = new Map();
        // Animation settings
        this.animationQueue = [];
        this.isAnimating = false;
        // Internal optimization flags
        this._drawPending = false;
        this._networkPending = false;
        this._markerEffect = null;
        this._markerTimeout = null;
        this._orientationLockout = false; // Prevent orientation spam
        this.hoveredLine = null;

        // Responsive: Redraw board on resize/orientation change with debounce
        this._resizeTimeout = null;
        this._orientationTimeout = null;

        window.addEventListener('resize', () => this._handleResize());
        window.addEventListener('orientationchange', () => this._handleOrientationChange());
    }

    _handleResize() {
        clearTimeout(this._resizeTimeout);
        this._resizeTimeout = setTimeout(() => {
            if (this.gameState === 'playing') {
                this.setupCanvas();
                this.draw();
            }
        }, 150);
    }

    _handleOrientationChange() {
        // Debounce orientation changes to prevent rapid redraws
        if (this._orientationLockout) return;
        this._orientationLockout = true;

        clearTimeout(this._orientationTimeout);
        this._orientationTimeout = setTimeout(() => {
            this._orientationLockout = false;
            if (this.gameState === 'playing') {
                // Give device time to finish rotation
                setTimeout(() => {
                    this.setupCanvas();
                    this.draw();
                }, 300);
            }
        }, 100);
    }

    generateRoomId() {
        // Simple unique ID: timestamp + random
        return 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 8);
    }

    initialize() {
        this.setupCanvas();
        this.bindCanvasEvents();
        this.updateUI();
        this.gameState = 'playing';
        this.draw();
    }

    calculateCanvasSize() {
        const baseSize = this.gridSpacing * (this.gridSize - 1) + 100;
        const maxSize = Math.min(window.innerWidth - 40, window.innerHeight - 200);
        return Math.min(baseSize, maxSize);
    }

    setupCanvas() {
        // Select correct canvas based on screen size
        const isMobileView = window.innerWidth < 768;
        const canvasId = isMobileView ? 'mobileGameBoard' : 'gameBoard';
        this.canvas = document.getElementById(canvasId);

        // Debug log to check if canvas is found and its ID
        if (!this.canvas) {
            // console.error(`[DotsAndBoxesGame] Canvas not found! Expected ID: ${canvasId}`);
            return;
        }

        // Ensure parent container is visible
        const parentContainer = this.canvas.parentElement;
        if (parentContainer) {
            parentContainer.style.display = '';
            parentContainer.style.visibility = 'visible';
        }

        // Calculate container size
        const containerSize = this.calculateCanvasSize();

        // Set canvas display size (CSS pixels)
        this.canvas.style.width = containerSize + 'px';
        this.canvas.style.height = containerSize + 'px';
        this.canvas.style.margin = '0 auto';
        this.canvas.style.display = 'block';

        // Set canvas internal resolution (device pixels)
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = containerSize * dpr;
        this.canvas.height = containerSize * dpr;

        // Get and configure context
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
            // console.error('[DotsAndBoxesGame] Failed to get canvas context');
            return;
        }

        // Reset transform and scale
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);

        // Recalculate grid spacing based on new canvas size
        this.gridSpacing = (containerSize - 100) / (this.gridSize - 1);

        // Reinitialize grid with new spacing
        this.grid = this.initializeGrid();

        // Clear hand-drawn effect caches
        this.dotOffsets.clear();
        this.lineSegments.clear();

        // Configure rendering quality
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        // console.log(`[DotsAndBoxesGame] Canvas setup: ${containerSize}px, DPR: ${dpr}, Spacing: ${this.gridSpacing}px`);
    }

    initializeGrid() {
        // gridSize is the number of dots per row/column (e.g., 7 for 7x7, 9 for 9x9)
        const grid = [];
        for (let row = 0; row < this.gridSize; row++) {
            grid[row] = [];
            for (let col = 0; col < this.gridSize; col++) {
                grid[row][col] = {
                    x: 50 + col * this.gridSpacing,
                    y: 50 + row * this.gridSpacing,
                    row: row,
                    col: col
                };
            }
        }
        return grid;
    }

    bindCanvasEvents() {
        if (!this.canvas) return;
        // Use named bound functions to allow proper removal
        if (!this._boundPointerDown) {
            this._boundPointerDown = this.handlePointerDown.bind(this);
        }
        if (!this._boundPointerMove) {
            this._boundPointerMove = this.handleCanvasHover.bind(this);
        }
        this.canvas.addEventListener('pointerdown', this._boundPointerDown);
        this.canvas.addEventListener('pointermove', this._boundPointerMove);
    }


    handlePointerDown(e) {
        if (!this.canMakeMove()) return;
        // Only respond to primary button (touch or left mouse)
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const dpr = window.devicePixelRatio || 1;
        const x = (e.clientX - rect.left) * (scaleX / dpr);
        const y = (e.clientY - rect.top) * (scaleY / dpr);
        this.handleInput(x, y);
        e.preventDefault();
    }



    // Remove touch handlers; pointer events handle all input

    handleCanvasHover(e) {
        if (this.gameState !== 'playing' || this.isAnimating) {
            this.hoveredLine = null;
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const dpr = window.devicePixelRatio || 1;
        const x = (e.clientX - rect.left) * (scaleX / dpr);
        const y = (e.clientY - rect.top) * (scaleY / dpr);

        const lastHovered = this.hoveredLine;
        this.hoveredLine = this.findNearestLine(x, y);

        if (this.hoveredLine && this.isLineDrawn(this.hoveredLine)) {
            this.hoveredLine = null;
        }

        if (this.hoveredLine) {
            this.canvas.style.cursor = 'pointer';
        } else {
            this.canvas.style.cursor = 'default';
        }

        // Only redraw if hover state changed
        if (JSON.stringify(lastHovered) !== JSON.stringify(this.hoveredLine)) {
            this.draw();
        }
    }

    handleInput(x, y) {
        // Prevent input if animating (fixes double line bug)
        if (this.isAnimating) return;
        const line = this.findNearestLine(x, y);
        if (line && !this.isLineDrawn(line)) {
            this.hoveredLine = null; // Clear hover on click
            this.drawLine(line);
        }
    }

    findNearestLine(x, y) {
        // Increase threshold for better touch sensitivity (44px is standard touch target size)
        const threshold = Math.max(44, this.gridSpacing * 0.7);
        let nearestLine = null;
        let minDistance = threshold;

        for (let row = 0; row < this.gridSize; row++) {
            for (let col = 0; col < this.gridSize - 1; col++) {
                const start = this.grid[row][col];
                const end = this.grid[row][col + 1];
                const distance = this.pointToLineDistance(x, y, start.x, start.y, end.x, end.y);

                // Use only distance to segment for a uniform capsule-shaped hitbox
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestLine = {
                        type: 'horizontal',
                        row: row,
                        col: col,
                        start: start,
                        end: end
                    };
                }
            }
        }

        for (let row = 0; row < this.gridSize - 1; row++) {
            for (let col = 0; col < this.gridSize; col++) {
                const start = this.grid[row][col];
                const end = this.grid[row + 1][col];
                const distance = this.pointToLineDistance(x, y, start.x, start.y, end.x, end.y);

                if (distance < minDistance) {
                    minDistance = distance;
                    nearestLine = {
                        type: 'vertical',
                        row: row,
                        col: col,
                        start: start,
                        end: end
                    };
                }
            }
        }

        return nearestLine;
    }

    pointToLineDistance(px, py, x1, y1, x2, y2) {
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;

        if (lenSq === 0) return Math.sqrt(A * A + B * B);

        let param = dot / lenSq;
        param = Math.max(0, Math.min(1, param));

        const xx = x1 + param * C;
        const yy = y1 + param * D;

        const dx = px - xx;
        const dy = py - yy;

        return Math.sqrt(dx * dx + dy * dy);
    }

    isPointInLineSegment(px, py, x1, y1, x2, y2) {
        const buffer = Math.max(25, this.gridSpacing * 0.4);
        const minX = Math.min(x1, x2) - buffer;
        const maxX = Math.max(x1, x2) + buffer;
        const minY = Math.min(y1, y2) - buffer;
        const maxY = Math.max(y1, y2) + buffer;

        return px >= minX && px <= maxX && py >= minY && py <= maxY;
    }

    drawLine(line) {
        const lineKey = this.getLineKey(line);
        if (this.lines.has(lineKey)) return;

        this.lines.add(lineKey);
        this.lineOwners.set(lineKey, this.currentPlayerIndex);

        const currentPlayer = this.players[this.currentPlayerIndex];
        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';
        const soundName = theme === 'greenboard' ? 'chalk' : 'marker';
        this.soundManager?.playSound(soundName);

        this.createDrawEffect(line);

        const completedBoxes = this.checkCompletedBoxes(line);
        let boxesCompleted = 0;

        // Block input while animating
        if (completedBoxes.length > 0) {
            this.isAnimating = true;
        }

        completedBoxes.forEach(box => {
            const existingBox = this.boxes.find(b => b.row === box.row && b.col === box.col);
            if (!existingBox) {
                this.boxes.push({
                    row: box.row,
                    col: box.col,
                    owner: currentPlayer.identity || this.currentPlayerIndex
                });
                currentPlayer.score++;
                boxesCompleted++;
            }
        });

        if (boxesCompleted > 0) {
            this.animateBoxCompletion(completedBoxes);
        } else {
            this.nextTurn();
            // For local games, always clear isAnimating and force UI update/redraw after move
            if (this.isLocal) {
                setTimeout(() => {
                    this.isAnimating = false;
                    this.updateUI();
                    this.draw();
                }, 100);
            }
        }

        this.updateUI();

        if (this.isGameFinished()) {
            this.endGame();
        }

        this.draw();

        if (!this.isLocal && this.networkManager) {
            this.sendGameStateUpdate();
        }
    }

    createDrawEffect(line) {
        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';

        if (theme === 'greenboard') {
            this.createChalkDust(line.start.x + (line.end.x - line.start.x) / 2,
                line.start.y + (line.end.y - line.start.y) / 2);
        } else {
            this.createMarkerEffect(line);
        }
    }

    createChalkDust(x, y) {
        const dust = document.createElement('div');
        dust.className = 'chalk-dust';
        dust.style.position = 'absolute';
        dust.style.left = x + 'px';
        dust.style.top = y + 'px';
        dust.style.pointerEvents = 'none';

        this.canvas.parentElement.appendChild(dust);

        setTimeout(() => {
            dust.remove();
        }, 500);
    }

    createMarkerEffect(line) {
        let effect = this._markerEffect;
        if (!effect) {
            effect = document.createElement('div');
            effect.className = 'marker-effect';
            effect.style.position = 'absolute';
            effect.style.pointerEvents = 'none';
            this._markerEffect = effect;
            this.canvas.parentElement.appendChild(effect);
        }
        effect.style.left = (line.start.x + (line.end.x - line.start.x) / 2) + 'px';
        effect.style.top = (line.start.y + (line.end.y - line.start.y) / 2) + 'px';
        const currentPlayer = this.players[this.currentPlayerIndex];
        effect.style.setProperty('--player-color', currentPlayer.color);
        effect.style.display = 'block';
        clearTimeout(this._markerTimeout);
        this._markerTimeout = setTimeout(() => {
            effect.style.display = 'none';
        }, 300);
    }

    getLineKey(line) {
        return `${line.type}-${line.row}-${line.col}`;
    }

    isLineDrawn(line) {
        return this.lines.has(this.getLineKey(line));
    }

    checkCompletedBoxes(line) {
        const completedBoxes = [];

        if (line.type === 'horizontal') {
            if (line.row > 0) {
                const box = this.getBox(line.row - 1, line.col);
                if (this.isBoxComplete(box)) {
                    completedBoxes.push(box);
                }
            }
            if (line.row < this.gridSize - 1) {
                const box = this.getBox(line.row, line.col);
                if (this.isBoxComplete(box)) {
                    completedBoxes.push(box);
                }
            }
        } else {
            if (line.col > 0) {
                const box = this.getBox(line.row, line.col - 1);
                if (this.isBoxComplete(box)) {
                    completedBoxes.push(box);
                }
            }
            if (line.col < this.gridSize - 1) {
                const box = this.getBox(line.row, line.col);
                if (this.isBoxComplete(box)) {
                    completedBoxes.push(box);
                }
            }
        }

        completedBoxes.forEach(box => {
            // Always set owner as player identity for consistency (for network and local)
            box.owner = this.players[this.currentPlayerIndex]?.identity;
        });

        return completedBoxes;
    }

    getBox(row, col) {
        if (row < 0 || row >= this.gridSize - 1 || col < 0 || col >= this.gridSize - 1) {
            return null;
        }

        return {
            row: row,
            col: col,
            top: `horizontal-${row}-${col}`,
            bottom: `horizontal-${row + 1}-${col}`,
            left: `vertical-${row}-${col}`,
            right: `vertical-${row}-${col + 1}`
        };
    }

    isBoxComplete(box) {
        if (!box) return false;

        return this.lines.has(box.top) &&
            this.lines.has(box.bottom) &&
            this.lines.has(box.left) &&
            this.lines.has(box.right);
    }

    animateBoxCompletion(completedBoxes) {
        const wasQueueEmpty = this.animationQueue.length === 0;
        this.animationQueue.push(...completedBoxes);

        // Always ensure isAnimating is true if we have boxes to animate
        this.isAnimating = true;

        if (wasQueueEmpty) {
            this.processAnimationQueue();
        }

        // Safety fallback: if animations get stuck, release lock after 3 seconds
        if (this._animationSafetyTimeout) clearTimeout(this._animationSafetyTimeout);
        this._animationSafetyTimeout = setTimeout(() => {
            if (this.isAnimating) {
                // console.warn('[Game] Animation safety timeout triggered — releasing lock');
                this.boxAnimationState = null;
                this.animationQueue = [];
                this.isAnimating = false;
                this.updateUI();
                this.draw();
            }
        }, 3000);
    }

    processAnimationQueue() {
        if (this.animationQueue.length === 0) {
            this.isAnimating = false;
            this.updateUI();
            this.draw();
            return;
        }

        const box = this.animationQueue.shift();

        this.animateBoxFill(box, () => {
            if (this.animationQueue.length === 0) {
                this.isAnimating = false;
                this.updateUI();
                this.draw();
            }
            this.processAnimationQueue();
        });
    }

    animateBoxFill(box, callback) {
        let opacity = 0;
        let scale = 0.5;
        const animate = () => {
            opacity += 0.25;
            scale += 0.125;
            if (opacity >= 1) {
                opacity = 1;
                scale = 1;
                this.boxAnimationState = null;
                callback();
                return;
            }
            this.boxAnimationState = { box, opacity, scale };
            this.draw();
            window.requestAnimationFrame(animate);
        };
        animate();
    }

    nextTurn() {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    }

    isGameFinished() {
        const totalBoxes = (this.gridSize - 1) * (this.gridSize - 1);
        return this.boxes.length === totalBoxes;
    }

    getAllCompletedBoxes() {
        const completedBoxes = [];

        for (let row = 0; row < this.gridSize - 1; row++) {
            for (let col = 0; col < this.gridSize - 1; col++) {
                const box = this.getBox(row, col);
                if (this.isBoxComplete(box)) {
                    const existingBox = this.boxes.find(b => b.row === row && b.col === col);
                    const owner = existingBox ? existingBox.owner : this.currentPlayerIndex;

                    completedBoxes.push({
                        row: row,
                        col: col,
                        owner: owner
                    });
                }
            }
        }

        return completedBoxes;
    }

    endGame() {
        this.gameState = 'finished';
        this.players.forEach((player, index) => {
            // Score by identity
            player.score = this.boxes.filter(box =>
                box.owner === player.identity || box.owner === index
            ).length;
        });
        const maxScore = Math.max(...this.players.map(p => p.score));
        const winners = Array.isArray(this.players) ? this.players.filter(player => player && player.score === maxScore) : [];
        const safeDisplayName = (p, idx) => {
            if (!p) return `Player ${idx !== undefined ? idx + 1 : ''}`;
            if (typeof p.displayName === 'string' && p.displayName.trim() !== '') return p.displayName.trim();
            if (typeof p.name === 'string' && p.name.trim() !== '') return p.name.trim();
            return `Player ${p.id !== undefined ? p.id : (idx !== undefined ? idx + 1 : '')}`;
        };
        const result = {
            isDraw: Array.isArray(winners) && winners.length > 1,
            winner: Array.isArray(winners) && winners.length === 1 ? winners[0] : null,
            finalScores: this.players.slice().sort((a, b) => b.score - a.score).map((p, idx) => ({
                ...p,
                displayName: safeDisplayName(p, idx)
            })),
            isLocalPlayer: this.isLocal || this.isLocalPlayerTurn()
        };
        // Store sorted scores for scoreboard
        this._lastFinalScores = result.finalScores;

        // Show winner/loser/draw pop-up for the local player on every client
        if (this.soundManager && this.soundManager.onGameEnd) {
            // Save results to match history (soundManager is the app instance)
            if (typeof this.soundManager.saveToMatchHistory === 'function') {
                this.soundManager.saveToMatchHistory(result);
            }
            let localIdentity = null;
            // Use the identity assigned during room join (most reliable)
            if (this.networkManager && this.networkManager.playerData) {
                localIdentity = this.networkManager.playerData.identity;
            }
            if (!localIdentity && typeof this.soundManager.getPlayerName === 'function') {
                const localName = this.soundManager.getPlayerName();
                const localPlayer = this.players.find(p => p.displayName === localName);
                if (localPlayer) localIdentity = localPlayer.identity;
            }
            const localPlayer = this.players.find(p => p.identity === localIdentity);
            // Always use displayName from network state for pop-up and scoreboard
            const finalScores = result.finalScores.map((p, idx) => ({
                displayName: safeDisplayName(p, idx),
                score: p.score,
                color: p.color,
                id: p.id
            }));
            if (localPlayer) {
                if (result.isDraw) {
                    this.soundManager.onGameEnd({
                        ...result,
                        winnerName: '',
                        loserName: safeDisplayName(localPlayer),
                        message: `It's a draw, ${safeDisplayName(localPlayer)}! Great effort, you really made it exciting!`,
                        isDraw: true,
                        finalScores
                    });
                } else if (result.winner && result.winner.identity === localPlayer.identity) {
                    this.soundManager.onGameEnd({
                        ...result,
                        winnerName: safeDisplayName(localPlayer),
                        message: `Congratulations ${safeDisplayName(localPlayer)}! You won the game!`,
                        isDraw: false,
                        finalScores
                    });
                } else {
                    this.soundManager.onGameEnd({
                        ...result,
                        winnerName: safeDisplayName(result.winner),
                        loserName: safeDisplayName(localPlayer),
                        message: `Great effort, ${safeDisplayName(localPlayer)}! You really made it exciting!`,
                        isDraw: false,
                        finalScores
                    });
                }
            }
        }
        if (!this.isLocal && this.soundManager && this.soundManager.chatManager) {
            if (result.isDraw) {
                this.soundManager.chatManager.addSystemMessage("It's a draw! Well played everyone!", 'info');
            } else if (result.winner) {
                const winnerName = safeDisplayName(result.winner);
                this.soundManager.chatManager.addSystemMessage(
                    `Congratulations ${winnerName}! You won the game!`, 'success'
                );
                // Find losers
                this.players.forEach((player, idx) => {
                    if (player !== result.winner) {
                        const loserName = safeDisplayName(player, idx);
                        this.soundManager.chatManager.addSystemMessage(
                            `Great effort, ${loserName}! You really made it exciting!`, 'info'
                        );
                    }
                });
            }
            const winnerName = result.winner ? safeDisplayName(result.winner) : '';
            // gameEnded is a no-op signal; system messages above handle the display
        }
    }

    updateUI() {
        this.updateScoreboard();
        this.updateCurrentTurn();
        this.updateCursor();
    }

    updateCursor() {
        document.body.classList.remove('player-1-turn', 'player-2-turn', 'player-3-turn', 'player-4-turn');
        // Always use currentPlayerIndex from network state for turn display
        const currentPlayer = this.players[this.currentPlayerIndex];
        if (currentPlayer) {
            document.body.classList.add(`player-${currentPlayer.id}-turn`);
        }
    }

    updateScoreboard() {
        if (!this.players || !Array.isArray(this.players)) {
            // console.warn("updateScoreboard: players is not defined or not an array", this.players);
            return;
        }

        const desktopScores = document.getElementById('scoresList');
        const mobileScores = document.getElementById('mobileScoresList');

        // If game is finished, use sorted finalScores for display
        let displayPlayers = this.players;
        if (this.gameState === 'finished' && this._lastFinalScores && Array.isArray(this._lastFinalScores)) {
            displayPlayers = this._lastFinalScores;
        }

        const safeDisplayName = (p, idx) => {
            if (!p) return `Player ${idx !== undefined ? idx + 1 : ''}`;
            if (typeof p.displayName === 'string' && p.displayName.trim() !== '') return p.displayName.trim();
            if (typeof p.name === 'string' && p.name.trim() !== '') return p.name.trim();
            return `Player ${p.id !== undefined ? p.id : (idx !== undefined ? idx + 1 : '')}`;
        };
        [desktopScores, mobileScores].forEach(scoresList => {
            if (scoresList) {
                scoresList.innerHTML = '';
                displayPlayers.forEach((player, index) => {
                    const scoreItem = document.createElement('div');
                    scoreItem.className = `score-item ${index === this.currentPlayerIndex ? 'current-player' : ''}`;
                    const displayName = safeDisplayName(player, index);
                    scoreItem.innerHTML = `
                        <div class="score-player">
                            <div class="score-color player-${player.id}" style="background-color: ${player.color}"></div>
        <span class="score-name">${displayName}</span>
                        </div>
                        <div class="score-points">${player.score}</div>
                    `;
                    scoresList.appendChild(scoreItem);
                });
            }
        });
    }

    updateCurrentTurn() {
        // Always use currentPlayerIndex from network state for turn display
        const safeDisplayName = (p) => {
            if (!p) return '';
            if (typeof p.displayName === 'string' && p.displayName.trim() !== '') return p.displayName.trim();
            if (typeof p.name === 'string' && p.name.trim() !== '') return p.name.trim();
            return `Player ${p.id !== undefined ? p.id : ''}`;
        };
        const currentPlayer = this.players[this.currentPlayerIndex];
        const turnText = currentPlayer ? `${safeDisplayName(currentPlayer)}'s turn` : "";

        const desktopTurn = document.getElementById('currentTurnDisplay');
        const mobileTurn = document.getElementById('currentTurnMobile');
        const mobileDrawerTurn = document.getElementById('mobileCurrentTurnDisplay');

        [desktopTurn, mobileTurn, mobileDrawerTurn].forEach(turnEl => {
            if (turnEl) {
                turnEl.textContent = turnText;
                if (currentPlayer) {
                    turnEl.style.color = currentPlayer.color;
                    // Set CSS variable for the pulse glow matching player color
                    document.documentElement.style.setProperty('--player-turn-color', currentPlayer.color);
                }
            }
        });
    }

    draw() {
        if (!this.ctx || this._drawPending) return;
        this._drawPending = true;
        window.requestAnimationFrame(() => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.drawGhostLine();
            this.drawHandDrawnDots();
            this.drawHandDrawnLines();
            this.drawCompletedBoxes();
            this._drawPending = false;
        });
    }

    drawGhostLine() {
        if (!this.hoveredLine || this.isAnimating) return;

        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';
        const currentPlayer = this.players[this.currentPlayerIndex];

        this.ctx.save();
        if (theme === 'greenboard') {
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            this.ctx.lineWidth = this.lineWidth;
        } else {
            this.ctx.strokeStyle = this.hexToRgba(currentPlayer.color, 0.3);
            this.ctx.lineWidth = this.lineWidth - 1;
        }

        this.ctx.setLineDash([5, 5]);
        this.ctx.beginPath();
        this.ctx.moveTo(this.hoveredLine.start.x, this.hoveredLine.start.y);
        this.ctx.lineTo(this.hoveredLine.end.x, this.hoveredLine.end.y);
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawHandDrawnDots() {
        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';

        for (let row = 0; row < this.gridSize; row++) {
            for (let col = 0; col < this.gridSize; col++) {
                const dot = this.grid[row][col];
                this.drawImperfectDot(dot.x, dot.y, theme);
            }
        }
    }

    drawImperfectDot(x, y, theme) {
        const dotKey = `${x}-${y}`;

        if (!this.dotOffsets.has(dotKey)) {
            const offsets = [];
            const jitter = 1.5;
            for (let i = 0; i < 3; i++) {
                offsets.push({
                    x: (Math.random() - 0.5) * jitter,
                    y: (Math.random() - 0.5) * jitter,
                    size: this.dotSize + (Math.random() - 0.5) * 1.5
                });
            }

            const specks = [];
            if (theme === 'greenboard') {
                for (let i = 0; i < 4; i++) {
                    specks.push({
                        x: (Math.random() - 0.5) * this.dotSize,
                        y: (Math.random() - 0.5) * this.dotSize
                    });
                }
            }

            this.dotOffsets.set(dotKey, { offsets, specks });
        }

        const { offsets, specks } = this.dotOffsets.get(dotKey);

        if (theme === 'greenboard') {
            this.ctx.fillStyle = '#ffffff';
        } else {
            this.ctx.fillStyle = '#333333';
        }

        offsets.forEach(offset => {
            this.ctx.beginPath();
            this.ctx.arc(x + offset.x, y + offset.y, offset.size / 2, 0, 2 * Math.PI);
            this.ctx.fill();
        });

        if (theme === 'greenboard' && specks.length > 0) {
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            specks.forEach(speck => {
                this.ctx.beginPath();
                this.ctx.arc(x + speck.x, y + speck.y, 0.5, 0, 2 * Math.PI);
                this.ctx.fill();
            });
        }
    }

    drawHandDrawnLines() {
        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';

        this.ctx.lineWidth = this.lineWidth;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.lines.forEach(lineKey => {
            const line = this.parseLineKey(lineKey);
            if (!line) return;
            const playerIndex = this.lineOwners.get(lineKey) || 0;
            this.drawImperfectLine(line, theme, playerIndex);
        });
    }

    drawImperfectLine(line, theme, playerIndex = 0) {
        const lineKey = this.getLineKey(line);

        if (!this.lineSegments.has(lineKey)) {
            const segments = 8;
            const jitter = 2.5;

            const points = [];
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const x = line.start.x + (line.end.x - line.start.x) * t;
                const y = line.start.y + (line.end.y - line.start.y) * t;

                let jitterX = 0, jitterY = 0;
                if (i > 0 && i < segments) {
                    jitterX = (Math.random() - 0.5) * jitter;
                    jitterY = (Math.random() - 0.5) * jitter;
                }

                points.push({ x: x + jitterX, y: y + jitterY });
            }

            this.lineSegments.set(lineKey, points);
        }

        const points = this.lineSegments.get(lineKey);

        if (theme === 'greenboard') {
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
            this.ctx.shadowBlur = 2;
        } else {
            const player = this.players[playerIndex] || this.players[0];
            this.ctx.strokeStyle = player.color;
            this.ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
            this.ctx.shadowBlur = 1;
        }

        this.ctx.lineWidth = this.lineWidth;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);

        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }

        this.ctx.stroke();

        if (theme === 'greenboard') {
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            this.ctx.lineWidth = this.lineWidth * 0.7;
            this.ctx.setLineDash([2, 3]);
            this.ctx.beginPath();
            this.ctx.moveTo(line.start.x, line.start.y);
            this.ctx.lineTo(line.end.x, line.end.y);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            this.ctx.lineWidth = this.lineWidth;
        }

        this.ctx.shadowBlur = 0;
    }

    drawCompletedBoxes() {
        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';

        this.boxes.forEach(box => {
            // If the box is currently being animated, we draw it via the animation state instead
            if (this.boxAnimationState && this.boxAnimationState.box.row === box.row && this.boxAnimationState.box.col === box.col) {
                return;
            }
            this.drawCompletedBox(box.row, box.col, box.owner, theme, 1, 1);
        });

        // Draw the animating box on top
        if (this.boxAnimationState) {
            const { box, opacity, scale } = this.boxAnimationState;
            this.drawCompletedBox(box.row, box.col, this.currentPlayerIndex, theme, opacity, scale);
        }
    }

    drawCompletedBox(row, col, owner, theme, opacity = 1, scale = 1) {
        const topLeft = this.grid[row][col];
        const bottomRight = this.grid[row + 1][col + 1];

        // Robust player lookup by identity
        let player = null;
        if (typeof owner === 'string') {
            player = this.players.find(p => p.identity === owner);
        } else if (typeof owner === 'number') {
            player = this.players[owner];
        }

        let fillColor, initial, textColor;
        if (player) {
            if (theme === 'greenboard') {
                fillColor = `rgba(255, 255, 255, ${0.08 * opacity})`;
                textColor = `rgba(255, 255, 255, ${opacity})`;
            } else {
                fillColor = this.hexToRgba(player.color, 0.2 * opacity);
                textColor = this.hexToRgba(player.color, opacity);
            }
            initial = player.displayName.charAt(0).toUpperCase();
        } else {
            // Fallback: use first char of owner string, default color
            fillColor = theme === 'greenboard' ? `rgba(255,255,255,${0.08 * opacity})` : `rgba(0,0,0,${0.08 * opacity})`;
            textColor = theme === 'greenboard' ? `rgba(255, 255, 255, ${opacity})` : `rgba(0,0,0,${opacity})`;
            initial = (typeof owner === 'string' && owner.length > 0) ? owner.charAt(0).toUpperCase() : '?';
        }

        this.ctx.fillStyle = fillColor;
        this.ctx.fillRect(
            topLeft.x + 2, topLeft.y + 2,
            bottomRight.x - topLeft.x - 4,
            bottomRight.y - topLeft.y - 4
        );

        const centerX = (topLeft.x + bottomRight.x) / 2;
        const centerY = (topLeft.y + bottomRight.y) / 2;

        this.ctx.fillStyle = textColor;
        this.ctx.font = `bold ${this.gridSpacing * 0.4 * scale}px ${theme === 'greenboard' ? 'Schoolbell' : 'Patrick Hand'}, cursive`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(initial, centerX, centerY);
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    parseLineKey(lineKey) {
        if (typeof lineKey !== 'string') return null;
        const parts = lineKey.split('-');
        if (parts.length !== 3) return null;
        const [type, row, col] = parts;
        const r = parseInt(row);
        const c = parseInt(col);
        if (isNaN(r) || isNaN(c) || !this.grid || !this.grid[r] || !this.grid[r][c]) return null;

        if (type === 'horizontal') {
            if (!this.grid[r][c + 1]) return null;
            return {
                type: 'horizontal',
                row: r,
                col: c,
                start: this.grid[r][c],
                end: this.grid[r][c + 1]
            };
        } else if (type === 'vertical') {
            if (!this.grid[r + 1]) return null;
            return {
                type: 'vertical',
                row: r,
                col: c,
                start: this.grid[r][c],
                end: this.grid[r + 1][c]
            };
        }
        return null;
    }

    // Network multiplayer methods
    receiveMove(moveData) {
        // console.log('Move received from network:', moveData);
        if (this.isLocal) return;

        this.lines.add(moveData.lineKey);

        if (moveData.completedBoxes && moveData.completedBoxes.length > 0) {
            this.players[moveData.currentPlayer].score += moveData.completedBoxes.length;
        } else {
            this.nextTurn();
        }

        this.updateUI();
        // Force redraw after rematch for all clients
        setTimeout(() => {
            this.draw();
        }, 50);

        if (this.isGameFinished()) {
            this.endGame();
        }
    }

    handleNetworkUpdate(gameState) {
        if (!gameState || this.isLocal) return;

        // Detect rematch/reset BEFORE updating state
        const incomingLines = Array.isArray(gameState.lines) ? gameState.lines : [];
        const prevLineCount = this.lines ? this.lines.size : 0;
        const isFreshBoard = incomingLines.length === 0 && (!gameState.boxes || gameState.boxes.length === 0);
        const isRematch = gameState.isRematch === true || (isFreshBoard && (gameState.gameState === 'playing') && prevLineCount > 0);

        // Show end game pop-up for all players when game ends (only once)
        if (gameState.gameState === 'finished' && this.gameState !== 'finished') {
            this.endGame();
            return; // endGame handles modal; don't overwrite state further
        }

        // Determine which lines are actually new (network added them, not us)
        const prevLines = this.lines ? new Set(this.lines) : new Set();

        // ---- Merge network state into local state ----
        // Preserve player colors that were assigned locally (network doesn't store colors)
        const existingColorMap = new Map();
        if (Array.isArray(this.players)) {
            this.players.forEach(p => {
                if (p.identity && p.color) existingColorMap.set(p.identity, p.color);
            });
        }

        this.lines = new Set(incomingLines);
        this.lineOwners = new Map(Object.entries(gameState.lineOwners || {}));
        this.currentPlayerIndex = gameState.currentPlayer !== undefined ? gameState.currentPlayer : 0;

        // Merge players — preserve colors assigned locally
        const getPlayerColor = (idx) => {
            const colors = ['#e74c3c', '#3498db', '#27ae60', '#2c3e50'];
            return colors[idx] || '#333333';
        };
        this.players = Array.isArray(gameState.players) ? gameState.players.map((p, idx) => ({
            ...p,
            displayName: p.displayName || p.name || `Player ${idx + 1}`,
            id: p.id !== undefined ? p.id : idx + 1,
            // Restore color: prefer existing map, then fall back to computed color
            color: existingColorMap.get(p.identity) || p.color || getPlayerColor(idx)
        })) : this.players;

        // Normalize box owners
        this.boxes = Array.isArray(gameState.boxes) ? gameState.boxes.map(b => {
            let ownerIdentity = b.owner;
            if (typeof ownerIdentity === 'number' && this.players[ownerIdentity]) {
                ownerIdentity = this.players[ownerIdentity].identity;
            }
            return { ...b, owner: ownerIdentity };
        }) : [];

        // Handle rematch: clear visuals and reinit canvas
        if (isRematch) {
            // console.log('[Game] Rematch detected — clearing board');
            this.dotOffsets.clear();
            this.lineSegments.clear();
            this.animationQueue = [];
            this.isAnimating = false;
            this.gameState = 'playing';
            this.setupCanvas();
        }

        // Handle grid size change
        if (gameState.gridSize && gameState.gridSize !== this.gridSize) {
            this.gridSize = gameState.gridSize;
            this.grid = this.initializeGrid();
            this.dotOffsets.clear();
            this.lineSegments.clear();
            this.canvasSize = this.calculateCanvasSize();
            this.setupCanvas();
        }

        if (gameState.gameState === 'playing' && this.gameState !== 'playing') {
            this.gameState = 'playing';
        }

        // Clear animation state from network updates
        this.animationQueue = [];
        this.isAnimating = false;

        // Play chalk/marker sound ONLY for lines added by the OTHER player
        // Use the identity assigned during room join
        let localIdentity = null;
        if (this.networkManager && this.networkManager.playerData) {
            localIdentity = this.networkManager.playerData.identity;
        }
        if (!localIdentity) {
            const localName = this.soundManager?.getPlayerName?.() || '';
            const localPlayer = this.players.find(p => p.displayName === localName);
            if (localPlayer) localIdentity = localPlayer.identity;
        }
        const newLines = incomingLines.filter(l => !prevLines.has(l));
        if (newLines.length > 0 && localIdentity) {
            newLines.forEach(lineKey => {
                const ownerIdx = this.lineOwners.get(lineKey);
                const ownerPlayer = ownerIdx !== undefined ? this.players[ownerIdx] : null;
                const isOwnMove = ownerPlayer && ownerPlayer.identity === localIdentity;
                if (!isOwnMove && this.soundManager) {
                    const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';
                    this.soundManager.playSound(theme === 'greenboard' ? 'chalk' : 'marker');
                }
            });
        }

        this.updateUI();
        this.draw();
    }

    handleNetworkMove(moveData) {
        if (!moveData || this.isLocal) return;

        const { line, lineKey, currentPlayer, completedBoxes } = moveData;

        if (this.lines.has(lineKey)) {
            // console.log('Duplicate move ignored:', lineKey);
            return;
        }

        this.lines.add(lineKey);

        const theme = document.body.classList.contains('theme-whiteboard') ? 'whiteboard' : 'greenboard';
        const soundName = theme === 'greenboard' ? 'chalk' : 'marker';
        this.soundManager?.playSound(soundName);

        if (completedBoxes && completedBoxes.length > 0) {
            this.players[currentPlayer].score += completedBoxes.length;

            completedBoxes.forEach(box => {
                // Always set owner as player identity for consistency
                box.owner = this.players[currentPlayer]?.identity;
                // Ensure box is added to the boxes array if not already present
                const existingBox = this.boxes.find(b => b.row === box.row && b.col === box.col);
                if (!existingBox) {
                    this.boxes.push({
                        row: box.row,
                        col: box.col,
                        owner: this.players[currentPlayer]?.identity
                    });
                }
            });

            this.animateBoxCompletion(completedBoxes);
        }

        this.currentPlayerIndex = currentPlayer;

        if (line) {
            this.createDrawEffect(line);
        }

        this.updateUI();
        this.draw();
    }

    getLocalPlayerIndex() {
        if (this.isLocal) return this.currentPlayerIndex;

        // Get local player identity (with date/time suffix)
        const localPlayerName = this.soundManager?.getPlayerName?.() || 'Player';
        // Try to match with displayName
        const match = this.players.findIndex(p => p.displayName === localPlayerName);
        return match;
    }

    isLocalPlayerTurn() {
        if (this.isLocal) return true;
        // Use the identity assigned during room join (most reliable)
        let localIdentity = null;
        if (this.networkManager && this.networkManager.playerData) {
            localIdentity = this.networkManager.playerData.identity;
        }
        if (!localIdentity) {
            // Fallback to display name match
            const localName = this.soundManager?.getPlayerName?.() || '';
            const localPlayer = this.players.find(p => p.displayName === localName);
            if (!localPlayer) return false;
            return this.players[this.currentPlayerIndex]?.identity === localPlayer.identity;
        }
        const localPlayer = this.players.find(p => p.identity === localIdentity);
        if (!localPlayer) return false;
        return this.players[this.currentPlayerIndex]?.identity === localPlayer.identity;
    }

    canMakeMove() {
        if (this.gameState !== 'playing' || this.isAnimating) return false;
        if (this.isLocal) return true;
        return this.isLocalPlayerTurn();
    }

    sendGameStateUpdate() {
        if (this.isLocal || !this.networkManager) return;
        if (this._networkPending) return;
        this._networkPending = true;
        setTimeout(() => {
            const lineOwnersObj = {};
            this.lineOwners.forEach((owner, lineKey) => {
                lineOwnersObj[lineKey] = owner;
            });
            const normalizedBoxes = this.boxes.map(b => {
                let ownerIdentity = b.owner;
                if (typeof ownerIdentity === 'number' && this.players[ownerIdentity]) {
                    ownerIdentity = this.players[ownerIdentity].identity;
                }
                if (typeof ownerIdentity === 'string') {
                    const match = this.players.find(p => p.identity === ownerIdentity);
                    if (match) ownerIdentity = match.identity;
                }
                return { ...b, owner: ownerIdentity };
            });
            // Always sync displayName from network state
            const gameState = {
                lines: Array.from(this.lines),
                lineOwners: lineOwnersObj,
                currentPlayer: this.currentPlayerIndex,
                players: this.players.map(p => ({
                    id: p.id !== undefined ? p.id : null,
                    displayName: p.displayName,
                    identity: p.identity,
                    isHost: p.isHost,
                    score: p.score,
                    color: p.color
                })),
                boxes: normalizedBoxes,
                gameState: this.gameState
            };
            this.networkManager.updateGameState(gameState);
            this._networkPending = false;
        }, 50); // batch updates within 50ms
    }


    cleanup() {
        // Cancel any pending timeouts
        clearTimeout(this._resizeTimeout);
        clearTimeout(this._orientationTimeout);
        clearTimeout(this._markerTimeout);

        // Remove event listeners from canvas
        if (this.canvas) {
            if (this._boundPointerDown) {
                this.canvas.removeEventListener('pointerdown', this._boundPointerDown);
            }
            if (this._boundPointerMove) {
                this.canvas.removeEventListener('pointermove', this._boundPointerMove);
            }
        }

        // Clear canvas
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }

        // Clean up rematch manager if exists
        if (this.rematchManager && typeof this.rematchManager.cleanup === 'function') {
            this.rematchManager.cleanup();
        }

        // Mark game as finished
        this.gameState = 'finished';

        // console.log('[DotsAndBoxesGame] Cleanup completed');
    }

    handleResize() {
        this.setupCanvas();
        this.grid = this.initializeGrid();
        this.draw();
    }

    initializeQuickMatch() {
        // console.log('Initializing Quick Match...');
        this.networkManager.requestQuickMatch();

        this.networkManager.on('gameStart', (gameState) => {
            // console.log('Game started:', gameState);
            this.handleNetworkUpdate(gameState);
        });
    }

    updatePlayers(newPlayers) {
        // Use player objects as provided by network state; do not generate identity here
        this.players = newPlayers.map((p, idx) => ({
            ...p,
            displayName: p.displayName || p.name,
            id: p.id !== undefined ? p.id : idx + 1
        }));
        this.updateUI();
        this.draw();
    }

    getNetworkGameState() {
        return {
            lines: Array.from(this.lines),
            lineOwners: Object.fromEntries(this.lineOwners),
            currentPlayer: this.currentPlayerIndex,
            players: this.players.map(p => ({
                id: p.id,
                displayName: p.displayName,
                identity: p.identity,
                isHost: p.isHost,
                score: p.score,
                color: p.color
            })),
            boxes: this.boxes.map(b => ({ ...b })),
            roomId: this.roomId
        };
    }

    // Helper to check if a player is connected
    isPlayerConnected(player) {
        return player && (player.connected !== false);
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
        window.dotsAndBoxesApp.gameInstance.handleResize();
    }
});

// Do NOT declare NetworkManager here again!
// Import or require it from your network.js file if needed

// Example usage (assuming you import NetworkManager from network.js):
// const networkManagerInstance = new NetworkManager();
// const gameInstance = new DotsAndBoxesGame({
//     players: [],
//     gridSize: 5,
//     isLocal: false,
//     soundManager: soundManagerInstance,
//     networkManager: networkManagerInstance
// });