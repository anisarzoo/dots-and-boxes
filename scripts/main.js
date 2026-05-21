import { UIManager } from './ui.js';
import { ChatManager } from './chat.js';
import { NetworkManager } from './network.js';
import { DotsAndBoxesGame } from './game.js';
import { RematchManager } from './rematch.js';
import { OrientationHandler } from './orientation-handler.js';
// Main JavaScript - App initialization and screen management
import { auth, db } from './firebase-config.js';
import {
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { ref, get, onValue, off } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

class DotsAndBoxesApp {
    _isGoingHome = false;
    // Prevent unwanted quick match after goHome
    _justWentHome = false;
    // Store Google user info
    signedInUser = null;
    constructor() {
        this.currentScreen = 'homeScreen';
        this.gameInstance = null;
        this.networkManager = null;
        this.uiManager = null;
        this.chatManager = null;
        this.sounds = {};
        this.settings = {
            soundEnabled: true,
            theme: 'greenboard'
        };

        this.signedInUser = null;
        this.matchHistory = this.loadMatchHistory();
        this.serverTimeOffset = 0;
        this.init();
    }

    loadMatchHistory() {
        const history = localStorage.getItem('dotsAndBoxesHistory');
        return history ? JSON.parse(history) : [];
    }

    saveToMatchHistory(result) {
        const matchData = {
            date: new Date().toISOString(),
            isDraw: result.isDraw,
            winner: result.winner ? result.winner.displayName : null,
            finalScores: result.finalScores.map(p => ({ name: p.displayName, score: p.score })),
            isLocal: this.isLocal
        };
        this.matchHistory.unshift(matchData);
        this.matchHistory = this.matchHistory.slice(0, 50); // Keep last 50 matches
        localStorage.setItem('dotsAndBoxesHistory', JSON.stringify(this.matchHistory));
    }
    // Firebase Auth logic
    setupGoogleAuth() {
        const signInBtn = document.getElementById('googleSignInBtn');
        const signOutBtn = document.getElementById('signOutBtn');
        const userInfoDiv = document.getElementById('signedInUserInfo');
        const userPhoto = document.getElementById('userPhoto');
        const userNameDisplay = document.getElementById('userNameDisplay');

        const updateUI = (user) => {
            const localGameBtn = document.getElementById('localGameBtn');
            if (localGameBtn) localGameBtn.disabled = false;

            if (user) {
                if (signInBtn) signInBtn.style.display = 'none';
                if (userInfoDiv) userInfoDiv.style.display = '';

                const dName = user.displayName || user.email || 'Signed in';
                if (userNameDisplay) userNameDisplay.textContent = dName;

                if (userPhoto) {
                    if (user.photoURL) {
                        userPhoto.src = user.photoURL;
                        userPhoto.style.display = '';
                    } else {
                        userPhoto.style.display = 'none';
                    }
                }
            } else {
                if (signInBtn) signInBtn.style.display = '';
                if (userInfoDiv) userInfoDiv.style.display = 'none';
            }
        };

        onAuthStateChanged(auth, (user) => {
            if (user) {
                this.setSignedInUser(user);
                updateUI(user);
                if (window.globalChatManager) window.globalChatManager.handleAuthStateChange(this.signedInUser);
            } else {
                this.setSignedInUser(null);
                updateUI(null);
                if (window.globalChatManager) window.globalChatManager.handleAuthStateChange(null);
            }
        });

        // Event Delegation for Sign In
        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('#googleSignInBtn');
            if (btn) {
                e.preventDefault();
                try {
                    const provider = new GoogleAuthProvider();
                    await signInWithPopup(auth, provider);
                } catch (error) {
                    // console.error('Google sign-in failed:', error);
                    alert('Google sign-in failed: ' + error.message);
                }
            }

            const signOutTarget = e.target.closest('#signOutBtn');
            if (signOutTarget) {
                e.preventDefault();
                await signOut(auth);
            }
        });
    }

    // Call this after Google sign-in or sign-out
    setSignedInUser(user) {
        if (!user) {
            this.signedInUser = null;
            return;
        }
        this.signedInUser = {
            displayName: user.displayName || user.email || 'Player',
            uid: user.uid,
            photoURL: user.photoURL || null
        };
    }

    init() {
        this.loadSettings();
        this.applyTheme();
        this.initializeAudio();
        this.bindEvents();
        this.initializeManagers();
        this.checkUrlHash();
        // Setup Google Auth UI/logic
        setTimeout(() => this.setupGoogleAuth(), 0);

        // Listen for Firebase server time offset
        const offsetRef = ref(db, '.info/serverTimeOffset');
        onValue(offsetRef, (snapshot) => {
            this.serverTimeOffset = snapshot.val() || 0;
        });
    }

    loadSettings() {
        const savedSettings = localStorage.getItem('dotsAndBoxesSettings');
        if (savedSettings) {
            this.settings = { ...this.settings, ...JSON.parse(savedSettings) };
        }
    }

    saveSettings() {
        localStorage.setItem('dotsAndBoxesSettings', JSON.stringify(this.settings));
    }

    applyTheme() {
        document.body.className = `theme-${this.settings.theme}`;
        const themeButtons = document.querySelectorAll('#modalThemeToggle');
        themeButtons.forEach(btn => {
            if (btn) {
                btn.setAttribute('data-theme', this.settings.theme);
            }
        });
    }

    toggleTheme() {
        this.settings.theme = this.settings.theme === 'greenboard' ? 'whiteboard' : 'greenboard';
        this.applyTheme();
        this.saveSettings();
        this.playSound('click');

        // Dispatch theme change event for global chat
        document.dispatchEvent(new CustomEvent('themeChanged', {
            detail: { theme: this.settings.theme }
        }));

        // Instantly redraw game board and update cursor theme
        if (this.gameInstance && typeof this.gameInstance.draw === 'function') {
            this.gameInstance.draw();
        }
        if (this.uiManager && typeof this.uiManager.updateGameCursor === 'function') {
            this.uiManager.updateGameCursor();
        }
    }

    initializeAudio() {
        this.sounds = {
            click: document.getElementById('clickSound'),
            chalk: document.getElementById('chalkSound'),
            marker: document.getElementById('markerSound'),
            win: document.getElementById('winSound'),
            draw: document.getElementById('drawSound')
        };
        Object.values(this.sounds).forEach(sound => {
            if (sound) {
                sound.volume = 0.5;
            }
        });
        this.updateSoundButton();
    }

    playSound(soundName) {
        if (!this.settings.soundEnabled) return;
        const sound = this.sounds[soundName];
        if (sound) {
            sound.currentTime = 0;
            sound.play().catch(e => console.log('Audio play failed:', e));
        }
    }

    toggleSound() {
        this.settings.soundEnabled = !this.settings.soundEnabled;
        this.updateSoundButton();
        this.saveSettings();
        this.playSound('click');
    }

    updateSoundButton() {
        const soundButtons = document.querySelectorAll('#modalSoundToggle');
        soundButtons.forEach(btn => {
            if (btn) {
                // If button contains .sound-icon and .sound-label, only update the icon
                const icon = btn.querySelector('.sound-icon');
                const label = btn.querySelector('.sound-label');
                if (icon) {
                    icon.innerHTML = this.settings.soundEnabled
                        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>'
                        : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
                }
                if (label) {
                    label.textContent = this.settings.soundEnabled ? 'Sound On' : 'Sound Off';
                }
                btn.setAttribute('title', this.settings.soundEnabled ? 'Mute Sound' : 'Enable Sound');
            }
        });
    }

    bindEvents() {
        this.bindHomeEvents();
        this.bindNavigationEvents();
        this.bindToggleEvents();
        this.bindModalEvents();
        this.bindSetupEvents();
        this.bindMobileEvents();
        this.bindHistoryEvents();
        this.renderHistorySummary();
    }

    bindHistoryEvents() {
        document.getElementById('viewFullHistory')?.addEventListener('click', () => {
            this.renderFullHistory();
            this.showModal('historyModal');
        });

        document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
            this.toggleFullscreen();
        });
    }

    renderHistorySummary() {
        const list = document.getElementById('latestMatchesList');
        if (!list) return;

        const latest = this.matchHistory.slice(0, 3);
        if (latest.length === 0) {
            list.innerHTML = '<p style="color: #7f8c8d; font-size: 0.85rem;">No matches yet. Start playing!</p>';
            return;
        }

        list.innerHTML = latest.map(m => `
            <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #eee; font-size: 0.8rem;">
                <span style="color: #2c3e50;">${m.winner || 'Draw'}</span>
                <span style="color: #7f8c8d;">${new Date(m.date).toLocaleDateString()}</span>
            </div>
        `).join('');
    }

    renderFullHistory() {
        const list = document.getElementById('fullHistoryList');
        if (!list) return;

        if (this.matchHistory.length === 0) {
            list.innerHTML = '<p style="text-align: center; color: #7f8c8d; padding: 20px;">No matches found.</p>';
            return;
        }

        list.innerHTML = this.matchHistory.map(m => `
            <div style="margin-bottom: 12px; padding: 12px; background: #f8f9fa; border-radius: 12px; border-left: 4px solid ${m.isDraw ? '#ccc' : '#27ae60'};">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <strong style="color: #2c3e50;">${m.isDraw ? '🤝 Draw' : '🏆 Winner: ' + m.winner}</strong>
                    <span style="color: #7f8c8d; font-size: 0.85rem;">${new Date(m.date).toLocaleDateString()}</span>
                </div>
                <div style="font-size: 0.9rem; color: #34495e;">
                    ${m.finalScores.map(s => `${s.name}: ${s.score}`).join(' | ')}
                </div>
            </div>
        `).join('');
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                // console.error(`Error attempting to enable full-screen mode: ${err.message}`);
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }

    bindHomeEvents() {
        // Enable Local Game button always, online modes only if signed in
        const localGameBtn = document.getElementById('localGameBtn');
        if (localGameBtn) localGameBtn.disabled = false;
        const createRoomBtn = document.getElementById('createRoomBtn');
        const joinRoomBtn = document.getElementById('joinRoomBtn');
        const quickMatchBtn = document.getElementById('quickMatchBtn');
        // Helper to show login-required modal
        const showLoginRequiredModal = () => {
            const modal = document.getElementById('loginRequiredModal');
            if (modal) modal.classList.remove('hidden');
        };
        // Multiplayer flow
        const multiplayerBtn = document.getElementById('multiplayerBtn');
        if (multiplayerBtn) {
            multiplayerBtn.addEventListener('click', () => {
                this.playSound('click');
                this.showScreen('multiplayerChoiceScreen');
            });
        }
        // Create Room
        if (createRoomBtn) {
            createRoomBtn.disabled = false;
            createRoomBtn.addEventListener('click', (e) => {
                if (!this.signedInUser) {
                    e.preventDefault();
                    showLoginRequiredModal();
                    return;
                }
                this.playSound('click');
                this.showScreen('createRoomScreen');
            });
        }
        // Join Room
        if (joinRoomBtn) {
            joinRoomBtn.disabled = false;
            joinRoomBtn.addEventListener('click', (e) => {
                if (!this.signedInUser) {
                    e.preventDefault();
                    showLoginRequiredModal();
                    return;
                }
                this.playSound('click');
                this.showScreen('joinRoomScreen');
            });
        }
        // Quick Match
        if (quickMatchBtn) {
            quickMatchBtn.disabled = false;
            quickMatchBtn.addEventListener('click', (e) => {
                if (!this.signedInUser) {
                    e.preventDefault();
                    showLoginRequiredModal();
                    return;
                }
                this.playSound('click');
                this.showScreen('quickMatchScreen');
                this.startQuickMatch();
            });
        }
        // Local Game
        document.getElementById('localGameBtn')?.addEventListener('click', () => {
            this.playSound('click');
            this.showScreen('localSetupScreen');
        });
        // Modal button logic
        const loginModal = document.getElementById('loginRequiredModal');
        if (loginModal) {
            const googleBtn = document.getElementById('loginRequiredGoogleBtn');
            const cancelBtn = document.getElementById('loginRequiredCancelBtn');
            if (googleBtn) {
                googleBtn.onclick = () => {
                    loginModal.classList.add('hidden');
                    const signInBtn = document.getElementById('googleSignInBtn');
                    if (signInBtn) signInBtn.click();
                };
            }
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    loginModal.classList.add('hidden');
                };
            }
        }

        // Cancel Quick Match — bind once here so it always works
        const cancelMatchBtn = document.getElementById('cancelMatch');
        if (cancelMatchBtn) {
            cancelMatchBtn.onclick = () => {
                this.playSound('click');
                if (this.networkManager) {
                    this.networkManager.cancelQuickMatch();
                }
                this.goHome();
            };
        }
    }

    bindNavigationEvents() {
        document.querySelectorAll('.home-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.playSound('click');
                if (this.gameInstance && this.gameInstance.gameState === 'playing') {
                    this.showConfirmModal(
                        'Are you sure you want to leave class? Your game progress will be erased.',
                        () => this.goHome()
                    );
                } else {
                    this.goHome();
                }
            });
        });
        document.getElementById('mobileHomeBtn')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.playSound('click');
            if (this.gameInstance && this.gameInstance.gameState === 'playing') {
                this.showConfirmModal(
                    'Are you sure you want to leave class? Your game progress will be erased.',
                    () => this.goHome()
                );
            } else {
                this.goHome();
            }
        });
    }

    bindToggleEvents() {
        document.querySelectorAll('#modalThemeToggle').forEach(btn => {
            btn?.addEventListener('click', () => this.toggleTheme());
        });
        document.querySelectorAll('#modalSoundToggle').forEach(btn => {
            btn?.addEventListener('click', () => this.toggleSound());
        });

        // Open Settings Modal
        document.querySelectorAll('#inGameSettingsBtn, #homeSettingsBtn, #mobileSettingsBtn').forEach(btn => {
            btn?.addEventListener('click', () => {
                this.showModal('settingsModal');
            });
        });

        document.getElementById('modalQuitBtn')?.addEventListener('click', () => {
            this.hideAllModals();
            this.showConfirmModal('Are you sure you want to quit to home?', () => {
                this.hideAllModals();
                this.goHome();
            });
        });
    }

    bindModalEvents() {
        document.getElementById('rulesBtn')?.addEventListener('click', () => {
            this.playSound('click');
            this.showModal('rulesModal');
        });
        document.getElementById('mobileRulesBtn')?.addEventListener('click', () => {
            this.playSound('click');
            this.showModal('rulesModal');
        });
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playSound('click');
                this.hideAllModals();
            });
        });
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.playSound('click');
                    this.hideAllModals();
                }
            });
        });
        document.getElementById('confirmYes')?.addEventListener('click', () => {
            this.playSound('click');
            this.hideAllModals();
            if (this.pendingConfirmAction) {
                this.pendingConfirmAction();
                this.pendingConfirmAction = null;
            }
        });
        document.getElementById('confirmNo')?.addEventListener('click', () => {
            this.playSound('click');
            this.hideAllModals();
            this.pendingConfirmAction = null;
        });
    }

    bindSetupEvents() {
        this.bindLocalSetupEvents();
        this.bindRoomEvents();
        this.bindJoinEvents();
    }

    bindLocalSetupEvents() {
        document.querySelectorAll('.count-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playSound('click');
                document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const count = parseInt(btn.dataset.count);
                this.updatePlayerInputs(count);
            });
        });
        document.querySelectorAll('.size-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playSound('click');
                // Only remove 'active' from visible size-btns in the same parent .size-buttons
                const parent = btn.closest('.size-buttons');
                if (parent) {
                    parent.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
                }
                btn.classList.add('active');
            });
        });
        document.getElementById('startLocalGame')?.addEventListener('click', () => {
            this.playSound('click');
            this.startLocalGame();
        });
    }

    bindRoomEvents() {
        document.getElementById('createRoom')?.addEventListener('click', () => {
            this.playSound('click');
            this.createRoom();
        });
        document.getElementById('roomCodeContainer')?.addEventListener('click', () => {
            const code = document.getElementById('roomCodeDisplay')?.textContent || '';
            this.copyToClipboard(code, document.getElementById('roomCodeContainer'));
        });
        document.getElementById('inviteLinkContainer')?.addEventListener('click', () => {
            const link = document.getElementById('inviteLink')?.textContent || '';
            this.copyToClipboard(link, document.getElementById('inviteLinkContainer'));
        });
        document.getElementById('startRoomGame')?.addEventListener('click', () => {
            this.playSound('click');
            this.startRoomGame();
        });
    }

    bindJoinEvents() {
        const joinCodeInput = document.getElementById('joinRoomCode');
        if (joinCodeInput) {
            joinCodeInput.addEventListener('input', (e) => {
                e.target.value = e.target.value.toUpperCase().slice(0, 4);
            });
        }
        document.getElementById('joinRoom')?.addEventListener('click', () => {
            this.playSound('click');
            this.joinRoom();
        });
    }

    bindMobileEvents() {
        this.bindChatDrawer();
        document.getElementById('mobileScoreBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.playSound('click');
            this.toggleMobileDrawer('mobileScoreDrawer');
        });
        document.getElementById('mobileSupportBtn')?.addEventListener('click', () => {
            this.playSound('click');
            window.open('https://buymeacoffee.com/anisarzoo', '_blank');
        });
        document.querySelectorAll('.drawer-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playSound('click');
                this.hideAllDrawers();
            });
        });

        // Click outside drawer to close on mobile
        document.addEventListener('click', (e) => {
            const drawers = document.querySelectorAll('.mobile-drawer.show');
            if (drawers.length > 0) {
                drawers.forEach(drawer => {
                    if (!drawer.contains(e.target)) {
                        this.hideAllDrawers();
                    }
                });
            }
        });
    }

    initializeManagers() {
        this.networkManager = new NetworkManager(this);
        this.uiManager = new UIManager(this);
        this.chatManager = new ChatManager(this);
    }

    checkUrlHash() {
        const hash = window.location.hash.substring(1);
        if (hash && hash.startsWith('join=') && hash.length === 9) {
            const roomCode = hash.substring(5).toUpperCase();
            const joinCodeInput = document.getElementById('joinRoomCode');
            if (joinCodeInput) {
                joinCodeInput.value = roomCode;
            }
            this.showScreen('joinRoomScreen');
        } else if (hash && hash.length === 4) {
            const joinCodeInput = document.getElementById('joinRoomCode');
            if (joinCodeInput) {
                joinCodeInput.value = hash.toUpperCase();
            }
            this.showScreen('joinRoomScreen');
        }
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
            screen.classList.add('transition-out');
        });

        const targetScreen = document.getElementById(screenId);
        if (targetScreen) {
            setTimeout(() => {
                document.querySelectorAll('.screen').forEach(s => s.classList.remove('transition-out'));
                targetScreen.classList.add('active');
                this.currentScreen = screenId;
                this.uiManager?.onScreenChange(screenId);
            }, 150);
        }
    }

    goHome() {
        if (this._isGoingHome) return;
        this._isGoingHome = true;
        // Show winner/loser/draw pop-up for the local player on every client
        if (this.gameInstance && this.gameInstance.gameResult) {
            const result = this.gameInstance.gameResult;
            // Save results to match history (soundManager is the app instance)
            if (typeof this.saveToMatchHistory === 'function') {
                this.saveToMatchHistory(result);
                this.renderHistorySummary(); // Update home summary
            }
            // Robust local identity detection
            const localPlayerId = this.networkManager?.localPlayer?.id || 1; // Default to player 1 for local games
            const localPlayerResult = result.players.find(p => p.id === localPlayerId);

            if (localPlayerResult) {
                if (result.type === 'draw') {
                    this.showModal('drawModal');
                } else if (localPlayerResult.isWinner) {
                    this.showModal('winnerModal');
                } else {
                    this.showModal('loserModal');
                }
            }
        }
        this._justWentHome = true;
        if (this.networkManager) {
            // Always cancel quick match if queued
            if (typeof this.networkManager.cancelQuickMatch === 'function') {
                this.networkManager.cancelQuickMatch();
            }
            this.networkManager.leaveRoom();
        }
        if (this.rematchInterval) {
            clearInterval(this.rematchInterval);
            this.rematchInterval = null;
        }
        // Clear any pending rematch-triggered goHome timeout and reset the active flag
        if (this._rematchGoHomeTimeout) {
            clearTimeout(this._rematchGoHomeTimeout);
            this._rematchGoHomeTimeout = null;
        }
        this._rematchWasActive = false;

        if (this.gameInstance) {
            // Cleanup rematch manager listeners if present
            if (this.gameInstance.rematchManager) {
                this.gameInstance.rematchManager.cleanup();
                this.gameInstance.rematchManager = null;
            }
            this.gameInstance.cleanup();
            this.gameInstance = null;
        }
        if (this.chatManager) {
            this.chatManager.clearMessages();
        }

        // Reset listener guard flags
        this._appListeners = [];
        this._playersListenerAdded = false;
        this._gameStateListenerAdded = false;
        this._playerDisconnectSkipFirst = true;
        this._roomMaxPlayers = null;

        window.location.hash = '';
        this.showScreen('homeScreen');
        this.resetForms();
        // Reset the flag after a short delay to allow UI to update
        setTimeout(() => {
            this._justWentHome = false;
            this._isGoingHome = false;
        }, 1000);
    }

    resetForms() {
        document.querySelectorAll('.error-message').forEach(el => {
            el.classList.add('hidden');
        });
        document.querySelectorAll('.room-info').forEach(el => {
            el.classList.add('hidden');
        });
        const inputs = ['joinRoomCode'];
        inputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) input.value = '';
        });
        document.querySelectorAll('.count-btn, .size-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector('.count-btn[data-count="2"]')?.classList.add('active');
        document.querySelector('.size-btn[data-size="5"]')?.classList.add('active');
        this.updatePlayerInputs(2);

        // Restore the create room bar (the fixed-action-bar in createRoomScreen)
        const createRoomScreen = document.getElementById('createRoomScreen');
        if (createRoomScreen) {
            const title = createRoomScreen.querySelector('#createRoomTitle');
            if (title) title.classList.remove('hidden');

            const settings = createRoomScreen.querySelector('.room-settings');
            if (settings) {
                settings.classList.remove('hidden');
                settings.style.display = '';
            }
            const actionBars = createRoomScreen.querySelectorAll('.fixed-action-bar');
            actionBars.forEach(bar => {
                if (bar.querySelector('#createRoom')) {
                    bar.style.display = '';
                    bar.classList.remove('hidden');
                }
            });
        }
    }

    updatePlayerInputs(count) {
        const playerInputs = ['player3Input', 'player4Input'];
        playerInputs.forEach((id, index) => {
            const input = document.getElementById(id);
            if (input) {
                if (index < count - 2) {
                    input.classList.remove('hidden');
                } else {
                    input.classList.add('hidden');
                }
            }
        });
    }

    startLocalGame() {
        const playerCount = parseInt(document.querySelector('#localSetupScreen .count-btn.active')?.dataset.count) || 2;
        const gridSize = parseInt(document.querySelector('#localSetupScreen .size-btn.active')?.dataset.size);
        // fallback to 5 only if no button is selected
        const finalGridSize = gridSize ? gridSize : 5;
        const players = [];
        // Get player names from input fields
        const nameInputs = [
            document.getElementById('localPlayer1'),
            document.getElementById('localPlayer2'),
            document.getElementById('localPlayer3'),
            document.getElementById('localPlayer4')
        ];
        const defaultNames = ["Red", "Blue", "Green", "Black"];
        for (let i = 1; i <= playerCount; i++) {
            let name = nameInputs[i - 1]?.value?.trim();
            if (!name) name = defaultNames[i - 1];
            players.push({
                id: i,
                name: name,
                displayName: name,
                color: this.getPlayerColor(i),
                score: 0
            });
        }
        this.gameInstance = new DotsAndBoxesGame({
            players: players,
            gridSize: finalGridSize,
            isLocal: true,
            soundManager: this
        });
        this.showScreen('gameScreen');
        this.gameInstance.initialize();
    }

    async createRoom() {
        // Only allow online play if signed in
        if (!this.signedInUser) {
            this.showError('You must sign in with Google to play online.');
            return;
        }
        // console.log('createRoom method called');
        const playerCount = parseInt(document.querySelector('#createRoomScreen .count-btn.active')?.dataset.count) || 2;
        const gridSize = parseInt(document.querySelector('#createRoomScreen .size-btn.active')?.dataset.size);
        const finalGridSize = gridSize ? gridSize : 5;
        // console.log('Creating room with:', { playerCount, gridSize });
        if (!this.networkManager) {
            // console.error('NetworkManager not initialized');
            return;
        }
        // Store maxPlayers for waiting text
        this._roomMaxPlayers = playerCount;
        // Use Google user info for host player
        let hostPlayer = {
            id: 1,
            displayName: this.signedInUser.displayName,
            identity: this.signedInUser.uid,
            photoURL: this.signedInUser.photoURL,
            color: this.getPlayerColor(1),
            isHost: true,
            score: 0
        };
        try {
            // Pass hostPlayer to createRoom if needed (update your networkManager if required)
            const roomData = await this.networkManager.createRoom(playerCount, finalGridSize, hostPlayer);
            // console.log('Room creation result:', roomData);
            if (roomData) {
                // After room is created, if host, write initial game state to database
                if (this.gameInstance && this.networkManager.isRoomHost()) {
                    this.gameInstance.sendGameStateUpdate();
                }
                const roomCreated = document.getElementById('roomCreated');
                if (roomCreated) {
                    roomCreated.classList.remove('hidden');
                    document.getElementById('roomCodeDisplay').textContent = roomData.code;
                    document.getElementById('inviteLink').textContent = roomData.inviteLink;
                    this.updateWaitingText();

                    // Collapse/Hide the "Create Room" settings and bar
                    const createRoomScreen = document.getElementById('createRoomScreen');
                    if (createRoomScreen) {
                        const settings = createRoomScreen.querySelector('.room-settings');
                        if (settings) {
                            settings.classList.add('hidden');
                        }
                        const title = createRoomScreen.querySelector('#createRoomTitle');
                        if (title) {
                            title.classList.add('hidden');
                        }
                        const actionBars = createRoomScreen.querySelectorAll('.fixed-action-bar');
                        actionBars.forEach(bar => {
                            if (bar.querySelector('#createRoom')) {
                                bar.style.display = 'none';
                                bar.classList.add('hidden');
                            }
                        });
                    }
                    // Show the "Start Game" button if needed
                    const startRoomGameBtn = document.getElementById('startRoomGame');
                    if (startRoomGameBtn) {
                        startRoomGameBtn.classList.remove('hidden');
                    }
                } else {
                    // console.error('roomCreated element not found');
                }
            } else {
                // console.error('Room creation failed');
            }
        } catch (error) {
            // console.error('Error creating room:', error);
        }
    }

    async joinRoom() {
        // Only allow online play if signed in
        if (!this.signedInUser) {
            this.showError('You must sign in with Google to join an online game.');
            return;
        }
        // Always clear local game/chat state before joining
        if (this.gameInstance) {
            this.gameInstance.cleanup();
            this.gameInstance = null;
        }
        if (this.chatManager) {
            this.chatManager.clearMessages();
        }
        const roomCode = document.getElementById('joinRoomCode')?.value?.trim();
        if (!roomCode || roomCode.length !== 4) {
            this.showError('Please enter a valid 4-letter room code.');
            return;
        }
        // Use Google user info for joining player
        let joinPlayer = {
            displayName: this.signedInUser.displayName,
            identity: this.signedInUser.uid,
            photoURL: this.signedInUser.photoURL
        };
        const success = await this.networkManager.joinRoom(roomCode, joinPlayer);
        if (success) {
            let roomData = null;
            try {
                const roomSnap = await get(ref(db, `rooms/${roomCode}`));
                roomData = roomSnap.exists() ? roomSnap.val() : null;
                if (roomData && roomData.maxPlayers) {
                    this._roomMaxPlayers = roomData.maxPlayers;
                }
            } catch (e) { }

            // Show joined room info
            const joinedRoom = document.getElementById('joinedRoom');
            if (joinedRoom) {
                joinedRoom.classList.remove('hidden');
            }
            // Fill in room code and grid size
            const joinedRoomCode = document.getElementById('joinedRoomCode');
            if (joinedRoomCode) {
                joinedRoomCode.textContent = roomCode;
            }
            let gridSize = roomData && roomData.gridSize ? roomData.gridSize : 5;
            const joinedGridSize = document.getElementById('joinedGridSize');
            if (joinedGridSize) {
                joinedGridSize.textContent = gridSize + ' × ' + gridSize;
            }
        }
    }

    async startQuickMatch() {
        if (this._justWentHome) return;

        // Only allow online play if signed in
        if (!this.signedInUser) {
            this.showError('You must sign in with Google to play online.');
            return;
        }

        const userId = this.signedInUser.uid;
        const userName = this.signedInUser.displayName;

        // Cleanup previous quick match queue entry if present
        if (this.networkManager) {
            await this.networkManager.cancelQuickMatch();
        }

        // Reset UI state
        this.gameInstance = null;
        this.currentScreen = 'quickMatchScreen';
        this.updateMatchingText();
        if (this.chatManager) this.chatManager.clearMessages();

        if (this.networkManager) this.networkManager.currentRoom = null;

        // Get grid size
        const gridSizeBtn = document.querySelector('#quickMatchScreen .size-btn.active');
        const gridSize = gridSizeBtn ? parseInt(gridSizeBtn.dataset.size) : 5;

        // Start matchmaking
        const result = await this.networkManager.startQuickMatch(userId, gridSize, {
            displayName: userName,
            identity: userId,
            photoURL: this.signedInUser.photoURL
        });

        if (result) {
            if (result.matched) {
                // The host wrote status:'playing' inside waitForOpponentToJoin
                // which triggers startNetworkGame via the status listener AND directly.
                // Don't call startNetworkGame() here again — it will be called by waitForOpponentToJoin.
            } else if (result.error) {
                this.showError('Quick match failed. Please try again.');
            }
            // If result.queued: we're waiting; cancel button is bound in bindHomeButtons
        }
    }

    startRoomGame() {
        if (this.networkManager && this.networkManager.isRoomHost()) {
            // Count occupied seats in the lobby grid (the actual DOM element)
            const lobbyGrid = document.getElementById('lobbySeatingGrid');
            let playerCount = lobbyGrid ? lobbyGrid.querySelectorAll('.student-seat.occupied').length : 0;
            // console.log('[main.js] startRoomGame — playerCount from lobby:', playerCount);
            if (playerCount < 2) {
                this.showError('At least 2 players are required to start the game. Invite a friend to join your room!');
                return;
            }
            this.networkManager.startGame();
        } else {
            // console.warn('[main.js] startRoomGame called but not host or no networkManager');
        }
    }

    updateMatchingText() {
        // Prevent matching text if just went home
        if (this._justWentHome) return;
        const messages = [
            '🔍 Looking for an opponent...',
            '📚 Checking classrooms...',
            '✏️ Sharpening pencils...',
            '🎒 Preparing game materials...',
            '📐 Setting up the board...'
        ];
        let index = 0;
        const textElement = document.getElementById('matchingText');
        const interval = setInterval(() => {
            if (textElement && this.currentScreen === 'quickMatchScreen' && !this._justWentHome) {
                textElement.textContent = messages[index % messages.length];
                index++;
            } else {
                clearInterval(interval);
            }
        }, 2000);
    }

    getPlayerColor(playerIndex) {
        const colors = ['#e74c3c', '#3498db', '#27ae60', '#2c3e50'];
        return colors[playerIndex - 1] || '#333333';
    }

    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('hidden');
            // Hide "Quit to Home" if we are already on the home screen
            if (modalId === 'settingsModal') {
                const quitSection = document.getElementById('modalQuitSection');
                if (quitSection) {
                    if (this.currentScreen === 'homeScreen') {
                        quitSection.style.display = 'none';
                    } else {
                        quitSection.style.display = 'block';
                    }
                }
            }
        }
    }

    hideAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.add('hidden');
        });
    }

    showConfirmModal(message, confirmAction) {
        const modal = document.getElementById('confirmModal');
        const messageEl = document.getElementById('confirmMessage');
        if (modal && messageEl) {
            messageEl.textContent = message;
            this.pendingConfirmAction = confirmAction;
            this.showModal('confirmModal');
        }
    }

    toggleMobileDrawer(drawerId) {
        const drawer = document.getElementById(drawerId);
        if (!drawer) return;
        document.querySelectorAll('.mobile-drawer').forEach(d => {
            if (d.id !== drawerId) {
                d.classList.remove('show');
                d.classList.add('hidden');
            }
        });
        if (drawer.classList.contains('show')) {
            drawer.classList.remove('show');
            setTimeout(() => drawer.classList.add('hidden'), 300);
        } else {
            drawer.classList.remove('hidden');
            setTimeout(() => drawer.classList.add('show'), 10);
        }
    }

    hideAllDrawers() {
        document.querySelectorAll('.mobile-drawer').forEach(drawer => {
            drawer.classList.remove('show');
            setTimeout(() => drawer.classList.add('hidden'), 300);
        });
    }

    showError(message) {
        const errorEl = document.getElementById('joinError');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
            setTimeout(() => {
                errorEl.classList.add('hidden');
            }, 5000);
        }
    }

    copyToClipboard(text, element = null) {
        const performCopy = () => {
            this.playSound('click');
            if (element) {
                this.showCopyFeedback(element);
            }
        };

        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(performCopy);
        } else {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            performCopy();
        }
    }

    showCopyFeedback(element) {
        // Remove any existing feedback first
        element.querySelectorAll('.copy-feedback').forEach(el => el.remove());

        const feedback = document.createElement('div');
        feedback.className = 'copy-feedback';
        feedback.textContent = 'copied!';
        element.appendChild(feedback);

        // Remove the feedback element after the animation completes
        setTimeout(() => {
            if (feedback.parentNode) {
                feedback.remove();
            }
        }, 1500);
    }

    onGameStart(gameData) {
        this.showScreen('gameScreen');
        if (!this.gameInstance) {
            // If gameData.isLocal is true, do not pass networkManager
            const gameConfig = {
                ...gameData,
                soundManager: this
            };
            if (gameData.isLocal) {
                gameConfig.isLocal = true;
                // Remove networkManager if present
                if ('networkManager' in gameConfig) {
                    delete gameConfig.networkManager;
                }
            }
            this.gameInstance = new DotsAndBoxesGame(gameConfig);
            this.gameInstance.initialize();
        }
    }

    onGameEnd(result) {
        this.showEndGameModal(result);
    }

    showEndGameModal(result) {
        const modal = document.getElementById('endGameModal');
        const title = document.getElementById('endGameTitle');
        const message = document.getElementById('endGameMessage');
        const finalScores = document.getElementById('finalScores');
        const rematchBtn = document.getElementById('rematchBtn');
        const quitBtn = document.getElementById('quitBtn');

        if (!modal || !title || !message || !finalScores) return;

        if (result.isDraw) {
            title.textContent = '🤝 It\'s a Draw!';
            message.textContent = 'Great game everyone!';
            this.playSound('draw');
        } else if (result.winner) {
            if (result.isLocalPlayer) {
                title.textContent = '🎉 Congratulations!';
                message.textContent = `🎉 Congrats ${result.winner.displayName || result.winner.name || `Player ${result.winner.id || ''}`}!`;
            } else {
                title.textContent = '😔 Better luck next time!';
                message.textContent = `Better luck next time, ${result.winner.displayName || result.winner.name || `Player ${result.winner.id || ''}`} won!`;
            }
            this.playSound('win');
            this.createConfetti();
        }

        finalScores.innerHTML = '';
        if (result.finalScores) {
            result.finalScores.forEach(player => {
                const scoreItem = document.createElement('div');
                scoreItem.className = 'final-score-item';
                scoreItem.innerHTML = `
                    <div class="final-score-player">
                        <div class="score-color player-${player.id}" style="background-color: ${player.color}"></div>
                        <span>${player.displayName || player.name || `Player ${player.id || ''}`}</span>
                    </div>
                    <div class="final-score-points">${player.score}</div>
                `;
                finalScores.appendChild(scoreItem);
            });
        }

        // Setup rematch button - only show for networked games
        if (rematchBtn) {
            if (this.gameInstance && !this.gameInstance.isLocal) {
                rematchBtn.style.display = '';
                rematchBtn.disabled = false;
                rematchBtn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                        <path d="M21 2v6h-6"></path>
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                        <path d="M3 22v-6h6"></path>
                        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
                    </svg>
                    Rematch
                `;
                rematchBtn.onclick = () => {
                    this.playSound('click');
                    this.requestRematch();
                };

                // Initialize RematchManager and listen to rematch state
                if (!this.gameInstance.rematchManager) {
                    this.gameInstance.rematchManager = new RematchManager(
                        this,
                        this.networkManager,
                        this.gameInstance
                    );
                }
                const roomCode = this.networkManager?.currentRoom;
                if (roomCode) {
                    this.gameInstance.rematchManager.listenToRematchState(roomCode, (rematchState) => {
                        this.handleRematchStateUpdate(rematchState);
                    });
                }
            } else if (this.gameInstance && this.gameInstance.isLocal) {
                // Local games: always enable rematch
                rematchBtn.style.display = '';
                rematchBtn.disabled = false;
                rematchBtn.onclick = () => {
                    this.playSound('click');
                    this.hideAllModals();
                    this.requestRematch();
                };
            }
        }

        // Setup quit button
        if (quitBtn) {
            quitBtn.onclick = () => {
                this.playSound('click');
                this.showConfirmModal(
                    'Are you sure you want to quit to home?',
                    async () => {
                        this.hideAllModals();
                        if (this.gameInstance && !this.gameInstance.isLocal && this.gameInstance.rematchManager) {
                            const roomCode = this.networkManager?.currentRoom;
                            if (roomCode) {
                                await this.gameInstance.rematchManager.voteRematch(roomCode, 'declined');
                            }
                        }
                        this.goHome();
                    }
                );
            };
        }

        this.showModal('endGameModal');
    }

    createConfetti() {
        const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#eb4d4b', '#6c5ce7'];
        for (let i = 0; i < 50; i++) {
            setTimeout(() => {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + 'vw';
                confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
                confetti.style.animationDelay = Math.random() * 3 + 's';
                document.body.appendChild(confetti);
                setTimeout(() => {
                    confetti.remove();
                }, 3000);
            }, i * 100);
        }
    }

    async requestRematch() {
        if (!this.gameInstance) {
            // console.error('[App] No game instance for rematch');
            return;
        }

        // Clean up any lingering confetti
        document.querySelectorAll('.confetti').forEach(el => el.remove());

        try {
            if (this.gameInstance.isLocal) {
                // Hide the end game modal immediately for local games
                this.hideAllModals();

                // For local games, reset directly
                this.gameInstance.rematch();
                this.showScreen('gameScreen');
                // Force redraw
                setTimeout(() => {
                    if (this.gameInstance && typeof this.gameInstance.draw === 'function') {
                        this.gameInstance.draw();
                    }
                }, 50);
            } else {
                // For network games, use RematchManager
                if (!this.gameInstance.rematchManager) {
                    this.gameInstance.rematchManager = new RematchManager(
                        this,
                        this.networkManager,
                        this.gameInstance
                    );
                }

                const rematchMgr = this.gameInstance.rematchManager;
                const roomCode = this.networkManager?.currentRoom;

                if (rematchMgr && roomCode) {
                    // Disable rematch button
                    const rematchBtn = document.getElementById('rematchBtn');
                    if (rematchBtn) {
                        rematchBtn.disabled = true;
                        rematchBtn.innerHTML = `⏳ Waiting...`;
                    }

                    // Get current players roster
                    const currentPlayers = this.gameInstance.players;
                    
                    // Initialize rematch state under /rematchState
                    await rematchMgr.initializeRematchState(roomCode, currentPlayers);

                    // Vote agreed
                    await rematchMgr.voteRematch(roomCode, 'agreed');
                }
            }
        } catch (error) {
            // console.error('[App] Error during rematch:', error);
            this.showError('Rematch failed. Please try again.');
            const rematchBtn = document.getElementById('rematchBtn');
            if (rematchBtn) {
                rematchBtn.disabled = false;
                rematchBtn.innerHTML = `Rematch`;
            }
        }
    }

    handleRematchStateUpdate(rematchState) {
        if (this.rematchInterval) {
            clearInterval(this.rematchInterval);
            this.rematchInterval = null;
        }

        const container = document.getElementById('rematchStatusContainer');

        // If we now have an active rematch state, cancel any pending goHome timeout
        if (rematchState && rematchState.active === true) {
            if (this._rematchGoHomeTimeout) {
                clearTimeout(this._rematchGoHomeTimeout);
                this._rematchGoHomeTimeout = null;
            }
            // Mark that rematch was at some point active (so we know when it clears it was intentional)
            this._rematchWasActive = true;
        }

        if (!rematchState || rematchState.active !== true) {
            if (container) {
                container.classList.add('hidden');
            }

            // Only go home if the rematch state was previously active (i.e., it was cancelled/declined).
            // Do NOT go home on the initial null fire when the listener first attaches.
            const wasActive = this._rematchWasActive === true;

            if (wasActive && this.gameInstance && !this.gameInstance.isLocal && this.gameInstance.gameState === 'finished') {
                // If the game has already transitioned to playing, do nothing
                if (this.gameInstance.gameState === 'playing') {
                    return;
                }

                // If the rematch is starting (we are about to transition), do nothing
                if (this.gameInstance.rematchManager && this.gameInstance.rematchManager.rematchReady) {
                    return;
                }

                // Wait a tiny bit (200ms) to allow any atomic network updates to propagate first
                this._rematchGoHomeTimeout = setTimeout(() => {
                    if (!this.gameInstance || this.gameInstance.gameState === 'playing') {
                        return;
                    }

                    if (this.uiManager) {
                        this.uiManager.showNotification('📚 Class dismissed! Not enough players agreed to rematch.', 'error', 3000);
                    }

                    this._rematchGoHomeTimeout = setTimeout(() => {
                        this.hideAllModals();
                        this.goHome();
                    }, 3000);
                }, 200);
            }
            return;
        }

        if (container) {
            container.classList.remove('hidden');
        }

        const listEl = document.getElementById('rematchPlayersList');
        if (listEl) {
            listEl.innerHTML = '';
            Object.values(rematchState.players).forEach(p => {
                const row = document.createElement('div');
                row.className = 'rematch-player-row';
                
                let badgeText = 'Thinking...';
                let badgeClass = 'badge-thinking';
                if (p.status === 'agreed') {
                     badgeText = 'Ready!';
                     badgeClass = 'badge-ready';
                } else if (p.status === 'declined') {
                     badgeText = 'Left';
                     badgeClass = 'badge-left';
                }
                
                row.innerHTML = `
                    <div class="rematch-player-info">
                        <span class="rematch-player-name">${p.displayName}</span>
                    </div>
                    <span class="rematch-badge ${badgeClass}">${badgeText}</span>
                `;
                listEl.appendChild(row);
            });
        }

        const totalPlayersCount = Object.keys(rematchState.players).length;
        const agreedPlayers = Object.values(rematchState.players).filter(p => p.status === 'agreed');
        const declinedPlayers = Object.values(rematchState.players).filter(p => p.status === 'declined');

        const localName = this.getPlayerName();
        const localSanitizedKey = this.networkManager ? this.networkManager.sanitizeKey(localName) : '';
        const localVote = rematchState.players[localSanitizedKey]?.status;
        const rematchBtn = document.getElementById('rematchBtn');

        if (rematchBtn) {
            if (localVote === 'agreed') {
                rematchBtn.disabled = true;
                rematchBtn.innerHTML = `🎓 Ready!`;
            } else if (localVote === 'declined') {
                rematchBtn.disabled = true;
                rematchBtn.innerHTML = `❌ Left`;
            }
        }

        const getCoordinatorKey = () => {
            const agreedKeys = Object.entries(rematchState.players)
                .filter(([_, p]) => p.status === 'agreed')
                .map(([key]) => key)
                .sort();
            return agreedKeys[0] || null;
        };
        const isCoordinator = (localSanitizedKey === getCoordinatorKey());

        if (totalPlayersCount === 2) {
            const countdownEl = document.getElementById('rematchCountdown');
            if (countdownEl) {
                countdownEl.textContent = `⏳ Waiting for all players to agree...`;
            }

            if (agreedPlayers.length === 2) {
                if (isCoordinator && this.gameInstance?.rematchManager) {
                    const roomCode = this.networkManager?.currentRoom;
                    if (roomCode) {
                        this.gameInstance.rematchManager.resolveRematchState(roomCode, agreedPlayers);
                    }
                }
            } else if (declinedPlayers.length > 0) {
                if (this.uiManager) {
                    this.uiManager.showNotification('📚 Class dismissed! Rematch was declined.', 'error', 3000);
                }
                if (isCoordinator && this.gameInstance?.rematchManager) {
                    const roomCode = this.networkManager?.currentRoom;
                    if (roomCode) {
                        this.gameInstance.rematchManager.cancelRematchState(roomCode);
                    }
                }
                setTimeout(() => {
                    this.hideAllModals();
                    this.goHome();
                }, 3000);
            }
        } else {
            if (agreedPlayers.length === totalPlayersCount) {
                if (isCoordinator && this.gameInstance?.rematchManager) {
                    const roomCode = this.networkManager?.currentRoom;
                    if (roomCode) {
                        this.gameInstance.rematchManager.resolveRematchState(roomCode, agreedPlayers);
                    }
                }
                return;
            }

            const updateTimer = () => {
                const startTime = typeof rematchState.startTime === 'number' ? rematchState.startTime : Date.now();
                const estServerTime = Date.now() + (this.serverTimeOffset || 0);
                const elapsed = estServerTime - startTime;
                const secs = Math.max(0, Math.ceil((10000 - elapsed) / 1000));

                const countdownEl = document.getElementById('rematchCountdown');
                if (countdownEl) {
                    countdownEl.textContent = `⏳ Rematch proposal: ${secs}s remaining...`;
                }

                if (secs <= 0) {
                    if (this.rematchInterval) {
                        clearInterval(this.rematchInterval);
                        this.rematchInterval = null;
                    }
                    if (isCoordinator) {
                        this.resolveRematchTimeout(rematchState);
                    }
                }
            };

            updateTimer();
            this.rematchInterval = setInterval(updateTimer, 1000);
        }
    }

    resolveRematchTimeout(rematchState) {
        const agreedPlayers = Object.values(rematchState.players).filter(p => p.status === 'agreed');
        const roomCode = this.networkManager?.currentRoom;
        if (!roomCode || !this.gameInstance?.rematchManager) return;

        if (agreedPlayers.length >= 2) {
            this.gameInstance.rematchManager.resolveRematchState(roomCode, agreedPlayers);
        } else {
            this.gameInstance.rematchManager.cancelRematchState(roomCode);
        }
    }

    onNetworkError(error) {
        this.showError(error.message || 'Network error occurred');
    }

    // Network integration methods
    getPlayerName() {
        // Always use Google displayName for online, 'Player' for local
        if (this.signedInUser) {
            return this.signedInUser.displayName || 'Player';
        }
        return 'Player';
    }

    updateLobbyPlayers(players) {
        // Update both seating grids
        this.updateSeatingGrid(players, 'lobbySeatingGrid');
        this.updateSeatingGrid(players, 'joinedSeatingGrid');
        // Update waiting text and start button
        this.updateWaitingText(players);
        this.updateStartButton(players);

        // Disconnect logic during active game
        if (this.gameInstance && this.gameInstance.gameState === 'playing') {
            const connectedPlayers = players.filter(p => p.connected !== false);
            if (connectedPlayers.length < 2 && players.length >= 2) {
                const disconnected = players.filter(p => p.connected === false);
                const disconnectedNames = disconnected.map(p => p.displayName || 'A classmate').join(', ');
                // console.log('[main.js] Player disconnected during game:', disconnectedNames);
                if (this.uiManager) {
                    this.uiManager.showNotification(
                        `📚 ${disconnectedNames} has left the classroom. Class dismissed!`,
                        'error', 4000
                    );
                }
                setTimeout(() => {
                    this.goHome();
                }, 3000);
            }
        }
    }

    updateSeatingGrid(players, gridId) {
        const grid = document.getElementById(gridId);
        if (!grid) return;
        grid.innerHTML = '';

        // Always show 4 seats (max players)
        for (let i = 0; i < 4; i++) {
            const player = players[i];
            const seat = document.createElement('div');
            seat.className = `student-seat ${player ? 'occupied' : 'empty'}`;

            if (player) {
                const color = this.getPlayerColor(i + 1);
                seat.innerHTML = `
                    <div class="student-avatar" style="background-color: ${color}">
                        ${player.photoURL ? `<img src="${player.photoURL}" alt="${player.displayName}">` : '🎓'}
                    </div>
                    <div class="student-name">${player.displayName || 'Student'}</div>
                    ${player.isHost ? '<div class="host-badge">Monitor</div>' : ''}
                    ${!player.connected ? '<div class="away-badge">Absent</div>' : ''}
                `;
            } else {
                seat.innerHTML = `<div class="student-avatar empty">🪑</div><div class="student-name">...</div>`;
            }
            grid.appendChild(seat);
        }
    }

    updateWaitingText(players = null) {
        const waitingText = document.getElementById('waitingText');
        if (!waitingText) return;
        if (!players) {
            waitingText.textContent = '🚌 Waiting for classmates...';
            return;
        }
        // Use stored maxPlayers (set during createRoom/joinRoom)
        const maxPlayers = this._roomMaxPlayers || 2;
        const remaining = maxPlayers - players.length;
        if (remaining > 0) {
            waitingText.textContent = `🚌 Waiting for ${remaining} more classmate${remaining !== 1 ? 's' : ''}...`;
        } else {
            waitingText.textContent = '✅ Room is full! Ready to start.';
        }
    }

    updateStartButton(players) {
        const startBtn = document.getElementById('startRoomGame');
        if (startBtn && this.networkManager && typeof this.networkManager.isRoomHost === 'function' && this.networkManager.isRoomHost() && players.length >= 2) {
            startBtn.classList.remove('hidden');
        }
    }

    async startNetworkGame() {
        // console.log('[main.js] startNetworkGame called');
        const roomCode = this.networkManager.currentRoom;
        if (!roomCode || !this.networkManager || !this.networkManager.db) {
            // console.error('[main.js] No active room');
            return;
        }

        this.showScreen('gameScreen');

        try {
            const roomSnap = await get(ref(this.networkManager.db, `rooms/${roomCode}`));
            if (!roomSnap.exists()) throw new Error("Room not found");

            const roomData = roomSnap.val();
            const gridSize = roomData.gridSize || 5;
            if (roomData.maxPlayers) {
                this._roomMaxPlayers = roomData.maxPlayers;
            }
            if (this.chatManager) this.chatManager.clearMessages();

            const playersObj = roomData.players || {};
            const playersArr = Object.values(playersObj).map((p, idx) => ({
                id: idx + 1,
                displayName: p.displayName || p.name || `Player ${idx + 1}`,
                identity: p.identity,
                isHost: p.isHost,
                score: p.score || 0,
                color: this.getPlayerColor(idx + 1),
                connected: p.connected !== false
            }));

            const gameState = roomData.gameState || {};
            if (roomData.status === 'playing') {
                this.initializeGameInstance({ room: roomCode }, gameState, playersArr, gridSize);
            }
        } catch (e) {
            // console.error('[main.js] Error starting network game:', e);
            this.showError('Failed to load game data. Please try again.');
        }
    }

    initializeGameInstance(roomStatus, gameState = null, playersArr = [], gridSize = 5) {
        // Only initialize if not already initialized
        if (this.gameInstance) return;
        this.gameInstance = new DotsAndBoxesGame({
            isLocal: false,
            networkManager: this.networkManager,
            soundManager: this,
            roomCode: roomStatus.room,
            gridSize: gridSize,
            players: playersArr,
            initialState: gameState
        });

        this.gameInstance.initialize();

        if (this.chatManager) {
            this.chatManager.gameStarted();
        }
    }

    handleQuickMatchFound() {
        // Guest player: a match was found and the room is set up.
        // Show the game screen immediately; startNetworkGame will be called
        // by the status listener when status:'playing' is written by the host.
        this.showScreen('gameScreen');
        // Also attempt to start the network game now in case status is already 'playing'
        this.startNetworkGame();
    }

    // Chat integration methods
    updateChatDrawer() {
        if (this.chatManager) {
            this.chatManager.clearNotification();
        }
    }

    bindChatDrawer() {
        document.getElementById('mobileChatBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.playSound('click');
            this.toggleMobileDrawer('mobileChatDrawer');
            this.updateChatDrawer();
        });
    }

    getPlayerDisplayName() {
        if (this.signedInUser && this.signedInUser.displayName) {
            return this.signedInUser.displayName;
        }
        return localStorage.getItem('dotsAndBoxesName') || 'Student';
    }

    getPlayerPhoto() {
        return this.signedInUser?.photoURL || null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dotsAndBoxesApp = new DotsAndBoxesApp();

    // Initialize orientation handler to manage game board during orientation changes
    if (typeof OrientationHandler !== 'undefined') {
        window.orientationHandler = new OrientationHandler();
    }
});
