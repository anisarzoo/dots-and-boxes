// UI Manager - Responsive design and interactions
export class UIManager {
    constructor(app) {
        this.app = app;
        this.isMobile = window.innerWidth < 1150 || window.innerHeight < 500;
        this.currentDrawer = null;

        this.init();
    }

    init() {
        this.bindEvents();
        this.setupResponsiveDesign();
        // Removed: this.initializeEmojiPickers();
    }

    bindEvents() {
        window.addEventListener('resize', () => this.handleResize());
        window.addEventListener('orientationchange', () => {
            setTimeout(() => this.handleResize(), 100);
        });
    }

    handleResize() {
        const wasMobile = this.isMobile;
        this.isMobile = window.innerWidth < 1150 || window.innerHeight < 500;

        if (wasMobile !== this.isMobile) {
            this.setupResponsiveDesign();

            // Trigger game canvas resize if in game
            if (this.app.gameInstance) {
                this.app.gameInstance.handleResize();
            }
        }
    }

    setupResponsiveDesign() {
        const gameScreen = document.getElementById('gameScreen');
        if (!gameScreen) return;

        if (this.isMobile) {
            gameScreen.classList.add('mobile-view');
            gameScreen.classList.remove('desktop-view');
        } else {
            gameScreen.classList.add('desktop-view');
            gameScreen.classList.remove('mobile-view');

            // Hide any open mobile drawers
            this.hideAllDrawers();
        }
    }

    onScreenChange(screenId) {
        // Handle screen-specific UI updates
        switch (screenId) {
            case 'gameScreen':
                this.setupGameScreen();
                break;
            case 'homeScreen':
                this.setupHomeScreen();
                break;
            default:
                this.hideAllDrawers();
                break;
        }
    }

    setupGameScreen() {
        this.setupResponsiveDesign();

        // Setup desktop chat expansion
        this.setupDesktopChatExpansion();

        // Ensure proper cursor theme
        this.updateGameCursor();
    }

    setupHomeScreen() {
        this.hideAllDrawers();
    }

    setupDesktopChatExpansion() {
        const expandBtn = document.querySelector('.expand-chat');
        const chatContainer = document.querySelector('.desktop-chat');

        if (expandBtn && chatContainer) {
            expandBtn.addEventListener('click', () => {
                chatContainer.classList.toggle('expanded');
                expandBtn.textContent = chatContainer.classList.contains('expanded') ? '←→' : '↔️';
                this.app.playSound('click');
            });
        }
    }

    updateGameCursor() {
        const canvas = this.app.gameInstance?.canvas;
        if (!canvas) return;

        const theme = this.app.settings.theme;
        const currentPlayer = this.app.gameInstance?.players[this.app.gameInstance?.currentPlayerIndex];

        if (currentPlayer) {
            canvas.className = `cursor-player-${currentPlayer.id} theme-${theme}`;
        }
    }

    // --- All emoji picker logic removed from here ---

    hideAllDrawers() {
        document.querySelectorAll('.mobile-drawer').forEach(drawer => {
            drawer.classList.remove('show');
            setTimeout(() => drawer.classList.add('hidden'), 300);
        });
        this.currentDrawer = null;
    }

    // Notification system for mobile
    showNotification(message, type = 'info', duration = 3000) {
        if (!this.isMobile) return;

        const notification = document.createElement('div');
        notification.className = `mobile-notification ${type}`;
        notification.textContent = message;

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${type === 'error' ? '#e74c3c' : type === 'success' ? '#27ae60' : '#3498db'};
            color: white;
            padding: 12px 20px;
            border-radius: 25px;
            z-index: 1001;
            font-size: 0.9rem;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            opacity: 0;
            transition: opacity 0.3s ease;
        `;

        document.body.appendChild(notification);

        // Animate in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);

        // Auto-hide
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, duration);
    }
}