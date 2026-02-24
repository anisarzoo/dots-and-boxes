// Enhanced orientation change handler for mobile game board
export class OrientationHandler {
    constructor() {
        this.orientationLockout = false;
        this.resizeTimeout = null;
        this.orientationTimeout = null;
        this.debouncedSetupCanvas = this.debounce((gameInstance) => {
            if (gameInstance && typeof gameInstance.setupCanvas === 'function') {
                gameInstance.setupCanvas();
                if (typeof gameInstance.draw === 'function') {
                    gameInstance.draw();
                }
            }
        }, 300);
        
        // Listen for orientation changes and resize events
        window.addEventListener('resize', () => this.handleResize());
        window.addEventListener('orientationchange', () => this.handleOrientationChange());
    }

    // Debounce function to limit frequency of function calls
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

    handleResize() {
        // Trigger debounced canvas setup
        if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
            this.debouncedSetupCanvas(window.dotsAndBoxesApp.gameInstance);
        }
    }

    handleOrientationChange() {
        // Prevent multiple rapid orientation changes
        if (this.orientationLockout) return;
        this.orientationLockout = true;

        // Delay processing to allow the browser to complete the orientation change
        setTimeout(() => {
            this.orientationLockout = false;
            
            // Wait a bit more to ensure the viewport has settled
            setTimeout(() => {
                if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
                    const gameInstance = window.dotsAndBoxesApp.gameInstance;
                    
                    // Force a complete canvas reset after orientation change
                    gameInstance.setupCanvas();
                    if (typeof gameInstance.draw === 'function') {
                        gameInstance.draw();
                    }
                    
                    // Also trigger a manual resize event to catch any remaining layout issues
                    window.dispatchEvent(new Event('resize'));
                }
            }, 300);
        }, 100);
    }

    // Method to force refresh the game board layout
    forceRefresh() {
        if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.gameInstance) {
            const gameInstance = window.dotsAndBoxesApp.gameInstance;
            
            // Small delay to ensure DOM has updated
            setTimeout(() => {
                gameInstance.setupCanvas();
                if (typeof gameInstance.draw === 'function') {
                    gameInstance.draw();
                }
            }, 100);
        }
    }
}

// Initialize the orientation handler when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Create a single instance of the orientation handler
    window.orientationHandler = new OrientationHandler();
    
    // Additional safeguard: listen for viewport changes on mobile devices
    let initialViewportWidth = window.innerWidth;
    let initialViewportHeight = window.innerHeight;
    
    window.addEventListener('resize', () => {
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        
        // Check if there's a significant change in viewport dimensions (possible orientation change)
        const widthChanged = Math.abs(currentWidth - initialViewportWidth) > 50;
        const heightChanged = Math.abs(currentHeight - initialViewportHeight) > 50;
        
        if (widthChanged || heightChanged) {
            // Update stored dimensions
            initialViewportWidth = currentWidth;
            initialViewportHeight = currentHeight;
            
            // Trigger a forced refresh after a brief delay
            setTimeout(() => {
                if (window.orientationHandler) {
                    window.orientationHandler.forceRefresh();
                }
            }, 200);
        }
    });
});

// Also add a special handler for iOS Safari which sometimes doesn't fire orientationchange
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    // For iOS devices, monitor the viewport height which changes on orientation
    let lastOrientation = window.orientation;
    
    setInterval(() => {
        if (window.orientation !== lastOrientation) {
            lastOrientation = window.orientation;
            setTimeout(() => {
                if (window.orientationHandler) {
                    window.orientationHandler.forceRefresh();
                }
            }, 300);
        }
    }, 100);
}