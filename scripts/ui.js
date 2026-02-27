// UI Manager - Responsive design and interactions
export class UIManager {
    constructor(app) {
        this.app = app;
        this.isMobile = window.innerWidth < 768;
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
        this.isMobile = window.innerWidth < 768;

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

        // Initialize chat input handlers
        this.setupChatInputs();

        // Setup desktop chat expansion
        this.setupDesktopChatExpansion();

        // Ensure proper cursor theme
        this.updateGameCursor();
    }

    setupHomeScreen() {
        this.hideAllDrawers();
    }

    setupChatInputs() {
        // Desktop chat input
        const desktopInput = document.getElementById('desktopChatInput');
        const desktopSend = document.getElementById('desktopSendBtn');

        if (desktopInput && desktopSend) {
            desktopInput.onkeypress = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendChatMessage(desktopInput.value, 'desktop');
                    desktopInput.value = '';
                }
            };

            desktopSend.onclick = () => {
                this.sendChatMessage(desktopInput.value, 'desktop');
                desktopInput.value = '';
            };
        }

        // Mobile chat input
        const mobileInput = document.getElementById('mobileChatInput');
        const mobileSend = document.getElementById('mobileSendBtn');

        if (mobileInput && mobileSend) {
            mobileInput.onkeypress = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendChatMessage(mobileInput.value, 'mobile');
                    mobileInput.value = '';
                }
            };

            mobileSend.onclick = () => {
                this.sendChatMessage(mobileInput.value, 'mobile');
                mobileInput.value = '';
            };
        }
    }

    sendChatMessage(message, source) {
        const trimmedMessage = message.trim();
        if (!trimmedMessage) return;

        if (this.app.chatManager) {
            this.app.chatManager.sendMessage(trimmedMessage);
        }

        this.app.playSound('click');
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

    showDrawer(drawerId) {
        const drawer = document.getElementById(drawerId);
        if (!drawer) return;

        // Hide other drawers first
        this.hideAllDrawers();

        // Show target drawer
        setTimeout(() => {
            drawer.classList.remove('hidden');
            setTimeout(() => drawer.classList.add('show'), 10);
            this.currentDrawer = drawerId;
        }, 300);
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

    // Loading overlay for network operations
    showLoadingOverlay(message = 'Loading...') {
        let overlay = document.getElementById('loadingOverlay');

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loadingOverlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                color: white;
                font-size: 1.2rem;
                flex-direction: column;
                gap: 20px;
            `;

            const spinner = document.createElement('div');
            spinner.className = 'spinner';

            const text = document.createElement('div');
            text.textContent = message;

            overlay.appendChild(spinner);
            overlay.appendChild(text);

            document.body.appendChild(overlay);
        } else {
            overlay.querySelector('div:last-child').textContent = message;
            overlay.style.display = 'flex';
        }
    }

    hideLoadingOverlay() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    // Accessibility helpers
    announceToScreenReader(message) {
        let announcement = document.getElementById('screenReaderAnnounce');
        if (!announcement) {
            announcement = document.createElement('div');
            announcement.id = 'screenReaderAnnounce';
            announcement.setAttribute('aria-live', 'polite');
            announcement.setAttribute('aria-atomic', 'true');
            announcement.style.cssText = `
                position: absolute;
                left: -10000px;
                width: 1px;
                height: 1px;
                overflow: hidden;
            `;
            document.body.appendChild(announcement);
        }
        announcement.textContent = message;
    }

    // High contrast mode detection
    setupAccessibilityFeatures() {
        // Detect high contrast mode
        if (window.matchMedia('(prefers-contrast: high)').matches) {
            document.body.classList.add('high-contrast');
        }

        // Detect reduced motion preference
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            document.body.classList.add('reduced-motion');
        }

        // Color blind friendly mode (optional)
        if (localStorage.getItem('colorBlindMode') === 'true') {
            document.body.classList.add('color-blind-friendly');
        }
    }

    // Focus management for keyboard navigation
    trapFocus(element) {
        const focusableElements = element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        element.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === firstElement) {
                        lastElement.focus();
                        e.preventDefault();
                    }
                } else {
                    if (document.activeElement === lastElement) {
                        firstElement.focus();
                        e.preventDefault();
                    }
                }
            }

            if (e.key === 'Escape') {
                this.app.hideAllModals();
                this.hideAllDrawers();
            }
        });
    }

    // Touch gesture detection for mobile
    setupTouchGestures() {
        if (!this.isMobile) return;

        let startY = 0;
        let startTime = 0;

        document.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            startTime = Date.now();
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            const endY = e.changedTouches[0].clientY;
            const endTime = Date.now();
            const deltaY = endY - startY;
            const deltaTime = endTime - startTime;

            // Swipe up gesture to close drawers
            if (deltaY < -50 && deltaTime < 300 && this.currentDrawer) {
                this.hideAllDrawers();
            }
        }, { passive: true });
    }

    // Performance monitoring
    trackPerformance() {
        if ('performance' in window && 'PerformanceObserver' in window) {
            const observer = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    if (entry.entryType === 'measure' && entry.duration > 16) {
                        // console.warn(`Slow operation detected: ${entry.name} took ${entry.duration}ms`);
                    }
                });
            });

            observer.observe({ entryTypes: ['measure'] });
        }
    }

    // Network status detection
    setupNetworkDetection() {
        if ('navigator' in window && 'onLine' in navigator) {
            const updateNetworkStatus = () => {
                if (!navigator.onLine) {
                    this.showNotification('You are offline. Some features may not work.', 'error', 5000);
                }
            };

            window.addEventListener('online', () => {
                this.showNotification('Connection restored!', 'success');
            });

            window.addEventListener('offline', updateNetworkStatus);

            // Initial check
            if (!navigator.onLine) {
                updateNetworkStatus();
            }
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UIManager;
}