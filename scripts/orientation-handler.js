// Enhanced orientation and viewport handler for mobile game board
export class OrientationHandler {
    constructor() {
        this.orientationLockout = false;
        this.debouncedSetupCanvas = this.debounce((gameInstance) => {
            if (gameInstance && typeof gameInstance.setupCanvas === 'function') {
                gameInstance.setupCanvas();
                if (typeof gameInstance.draw === 'function') {
                    gameInstance.draw();
                }
            }
        }, 300);

        this.handleResize = this.handleResize.bind(this);
        this.handleOrientationChange = this.handleOrientationChange.bind(this);
        this.tryLockPortrait = this.tryLockPortrait.bind(this);

        // Listen for viewport changes
        window.addEventListener('resize', this.handleResize);
        window.addEventListener('orientationchange', this.handleOrientationChange);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', this.handleResize);
        }

        // Initialize viewport CSS var and attempt portrait lock
        this.updateViewportHeight();
        this.tryLockPortrait();

        // Retry orientation lock after first user gesture for stricter browsers
        document.addEventListener('pointerdown', this.tryLockPortrait, { passive: true, once: true });
        document.addEventListener('touchstart', this.tryLockPortrait, { passive: true, once: true });
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    isSmallTouchDevice() {
        const isTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
        const smallestSide = Math.min(window.innerWidth, window.innerHeight);
        return isTouch && smallestSide <= 900;
    }

    updateViewportHeight() {
        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--app-viewport-height', `${Math.round(viewportHeight)}px`);
    }

    async tryLockPortrait() {
        if (!this.isSmallTouchDevice()) return;
        if (!window.screen || !window.screen.orientation || typeof window.screen.orientation.lock !== 'function') {
            return;
        }
        if (document.visibilityState === 'hidden') return;

        try {
            await window.screen.orientation.lock('portrait');
        } catch {
            // Ignore: some browsers require fullscreen or do not support lock().
        }
    }

    handleResize() {
        this.updateViewportHeight();
        this.tryLockPortrait();

        if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
            this.debouncedSetupCanvas(window.dotsAndBoxesApp.gameInstance);
        }
    }

    handleOrientationChange() {
        this.updateViewportHeight();
        this.tryLockPortrait();

        if (this.orientationLockout) return;
        this.orientationLockout = true;

        // Delay processing to allow orientation + viewport to settle
        setTimeout(() => {
            this.orientationLockout = false;

            setTimeout(() => {
                this.forceRefresh();
                window.dispatchEvent(new Event('resize'));
            }, 300);
        }, 100);
    }

    forceRefresh() {
        this.updateViewportHeight();

        if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
            const gameInstance = window.dotsAndBoxesApp.gameInstance;

            setTimeout(() => {
                gameInstance.setupCanvas();
                if (typeof gameInstance.draw === 'function') {
                    gameInstance.draw();
                }
            }, 100);
        }
    }
}
