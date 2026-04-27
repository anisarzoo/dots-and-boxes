// scripts/global-chat-enhanced.js
// Enhanced global chat with online users, message limiting, and theme integration
import { db, auth } from './firebase-config.js';
import { 
    ref, 
    push, 
    onChildAdded, 
    serverTimestamp, 
    query, 
    orderByChild, 
    limitToLast,
    onDisconnect,
    set,
    onValue,
    off,
    remove
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

class GlobalChatManager {
    constructor() {
        this.currentUser = null;
        this.messageLimit = 100;
        this.onlineUsersRef = null;
        this.currentUserPresenceRef = null;
        this.messagesRef = null;
        this.onlineUsersListener = null;
        this.messagesListener = null;
        
        // DOM elements - Desktop
        this.chatContainer = document.getElementById('globalChatContainer');
        this.chatMessages = document.getElementById('globalChatMessages');
        this.chatInput = document.getElementById('globalChatInput');
        this.chatSendBtn = document.getElementById('globalChatSendBtn');
        this.chatInputRow = document.getElementById('globalChatInputRow');
        this.chatSigninMessage = document.getElementById('globalChatSigninMessage');
        this.onlineUsersCount = document.getElementById('onlineUsersCount');
        
        // DOM elements - Mobile
        this.mobileDrawerKey = document.getElementById('mobileGlobalChatKey');
        this.mobileDrawer = document.getElementById('mobileGlobalChatDrawer');
        this.mobileMessages = document.getElementById('globalChatMessagesMobile');
        this.mobileInput = document.getElementById('mobileGlobalChatInput');
        this.mobileSendBtn = document.getElementById('mobileGlobalChatSendBtn');
        this.mobileInputRow = document.getElementById('mobileGlobalChatInputRow');
        this.mobileSigninMessage = document.getElementById('mobileGlobalChatSigninMessage');
        this.mobileOnlineUsersCount = document.getElementById('mobileOnlineUsersCount');
        this.mobileCloseBtn = document.getElementById('closeMobileGlobalChat');

        const setupSigninClick = (element) => {
            if (!element) return;
            element.style.cursor = 'pointer';
            element.addEventListener('click', () => {
                const signInBtn = document.getElementById('googleSignInBtn');
                if (signInBtn) signInBtn.click();
            });
        };
        setupSigninClick(this.chatSigninMessage);
        setupSigninClick(this.mobileSigninMessage);
        
        this.initializeChat();
    }
    
    initializeChat() {
        // Listen for authentication state changes
        onAuthStateChanged(auth, (user) => {
            this.handleAuthStateChange(user);
        });
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Initialize message listening (even for non-authenticated users)
        this.initializeMessageListener();
    }
    
    handleAuthStateChange(user) {
        this.currentUser = user;
        
        if (user) {
            // User is signed in
            this.showChatInput();
            this.setupUserPresence();
        } else {
            // User is signed out
            this.showSigninMessage();
            this.cleanupUserPresence();
        }
        
        this.updateUI();
    }
    
    showChatInput() {
        // Desktop
        if (this.chatInputRow) this.chatInputRow.style.display = 'block';
        if (this.chatSigninMessage) this.chatSigninMessage.style.display = 'none';
        if (this.chatInput) this.chatInput.disabled = false;
        if (this.chatSendBtn) this.chatSendBtn.disabled = false;
        
        // Mobile
        if (this.mobileInputRow) this.mobileInputRow.style.display = 'block';
        if (this.mobileSigninMessage) this.mobileSigninMessage.style.display = 'none';
        if (this.mobileInput) this.mobileInput.disabled = false;
        if (this.mobileSendBtn) this.mobileSendBtn.disabled = false;
    }
    
    showSigninMessage() {
        // Desktop
        if (this.chatInputRow) this.chatInputRow.style.display = 'none';
        if (this.chatSigninMessage) this.chatSigninMessage.style.display = 'block';
        if (this.chatInput) this.chatInput.disabled = true;
        if (this.chatSendBtn) this.chatSendBtn.disabled = true;
        
        // Mobile
        if (this.mobileInputRow) this.mobileInputRow.style.display = 'none';
        if (this.mobileSigninMessage) this.mobileSigninMessage.style.display = 'block';
        if (this.mobileInput) this.mobileInput.disabled = true;
        if (this.mobileSendBtn) this.mobileSendBtn.disabled = true;
    }
    
    setupEventListeners() {
        // Desktop send button click
        if (this.chatSendBtn) {
            this.chatSendBtn.addEventListener('click', () => this.sendMessage());
        }
        
        // Desktop enter key in input
        if (this.chatInput) {
            this.chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
        }
        
        // Mobile send button click
        if (this.mobileSendBtn) {
            this.mobileSendBtn.addEventListener('click', () => this.sendMessage(true));
        }
        
        // Mobile enter key in input
        if (this.mobileInput) {
            this.mobileInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage(true);
                }
            });
        }
        
        // Mobile drawer arrow key
        if (this.mobileDrawerKey) {
            this.mobileDrawerKey.addEventListener('click', () => this.showMobileDrawer());
            var keyBtn = this.mobileDrawerKey.querySelector('button');
            if (keyBtn) {
                keyBtn.addEventListener('click', () => {
                    this.showMobileDrawer();
                });
            }
        }
        
        // Mobile close button
        if (this.mobileCloseBtn) {
            this.mobileCloseBtn.addEventListener('click', () => this.hideMobileDrawer());
        }
        
        // Mobile drawer overlay click
        if (this.mobileDrawer) {
            this.mobileDrawer.addEventListener('click', (e) => {
                if (e.target === this.mobileDrawer) {
                    this.hideMobileDrawer();
                }
            });
        }
        
        // Handle responsive behavior
        this.handleResponsive();
        window.addEventListener('resize', () => this.handleResponsive());
    }
    
    setupUserPresence() {
        if (!this.currentUser || !db) return;
        
        // Create presence reference
        this.onlineUsersRef = ref(db, 'onlineUsers');
        this.currentUserPresenceRef = ref(db, `onlineUsers/${this.currentUser.uid}`);
        
        // Set user as online
        const userPresenceData = {
            uid: this.currentUser.uid,
            displayName: this.currentUser.displayName || this.currentUser.email || 'Anonymous',
            photoURL: this.currentUser.photoURL || '',
            lastSeen: serverTimestamp(),
            isOnline: true
        };
        
        set(this.currentUserPresenceRef, userPresenceData);
        
        // Remove user when they disconnect
        onDisconnect(this.currentUserPresenceRef).remove();
        
        // Listen for online users changes
        this.setupOnlineUsersListener();
    }
    
    setupOnlineUsersListener() {
        if (!this.onlineUsersRef) return;
        
        // Remove existing listener
        if (this.onlineUsersListener) {
            off(this.onlineUsersRef, 'value', this.onlineUsersListener);
        }
        
        this.onlineUsersListener = (snapshot) => {
            const onlineUsers = snapshot.val() || {};
            const userCount = Object.keys(onlineUsers).length;
            this.updateOnlineUsersCount(userCount);
        };
        
        onValue(this.onlineUsersRef, this.onlineUsersListener);
    }
    
    cleanupUserPresence() {
        if (this.currentUserPresenceRef) {
            remove(this.currentUserPresenceRef);
            this.currentUserPresenceRef = null;
        }
        
        if (this.onlineUsersListener && this.onlineUsersRef) {
            off(this.onlineUsersRef, 'value', this.onlineUsersListener);
            this.onlineUsersListener = null;
        }
        
        this.onlineUsersRef = null;
        this.updateOnlineUsersCount(0);
    }
    
    updateOnlineUsersCount(count) {
        const text = `${count} online`;
        if (this.onlineUsersCount) {
            this.onlineUsersCount.textContent = text;
        }
        if (this.mobileOnlineUsersCount) {
            this.mobileOnlineUsersCount.textContent = text;
        }
    }
    
    showMobileDrawer() {
        if (this.mobileDrawer) {
            this.mobileDrawer.classList.remove('hidden');
            this.mobileDrawer.style.display = 'block';
            this.mobileDrawer.style.zIndex = '2000';
            document.body.style.overflow = 'hidden';
        }
    }
    
    hideMobileDrawer() {
        if (this.mobileDrawer) {
            this.mobileDrawer.classList.add('hidden');
            this.mobileDrawer.style.display = 'none';
            document.body.style.overflow = '';
        }
    }
    
    handleResponsive() {
        const isMobile = window.innerWidth < 1250;
        
        if (isMobile) {
            // Show mobile drawer key, hide desktop chat on mobile screens
            if (this.mobileDrawerKey) this.mobileDrawerKey.style.display = 'block';
            if (this.chatContainer) this.chatContainer.style.display = 'none';
        } else {
            // Hide mobile drawer key, show desktop chat on larger screens
            if (this.mobileDrawerKey) this.mobileDrawerKey.style.display = 'none';
            if (this.chatContainer) this.chatContainer.style.display = 'flex';
            this.hideMobileDrawer(); // Close mobile drawer if open
        }
    }
    
    initializeMessageListener() {
        if (!db) return;
        
        // Create messages reference with limit
        this.messagesRef = query(
            ref(db, 'globalChatMessages'),
            orderByChild('timestamp'),
            limitToLast(this.messageLimit)
        );
        
        // Listen for new messages
        this.messagesListener = onChildAdded(this.messagesRef, (snapshot) => {
            const message = { id: snapshot.key, ...snapshot.val() };
            this.addMessageToUI(message);
        });
    }
    
    sendMessage(isMobile = false) {
        if (!this.currentUser) return;
        
        const input = isMobile ? this.mobileInput : this.chatInput;
        if (!input) return;
        
        const messageText = input.value.trim();
        if (!messageText) return;
        
        // Create message object
        const messageData = {
            text: messageText,
            userId: this.currentUser.uid,
            userName: this.currentUser.displayName || this.currentUser.email || 'Anonymous',
            userPhoto: this.currentUser.photoURL || '',
            timestamp: serverTimestamp()
        };
        
        // Send to Firebase
        const messagesRef = ref(db, 'globalChatMessages');
        push(messagesRef, messageData)
            .then(() => {
                input.value = '';
            })
            .catch((error) => {
                console.error('Error sending message:', error);
            });
    }
    
    addMessageToUI(message) {
        // Add to desktop container
        this.addMessageToContainer(message, this.chatMessages, false);
        
        // Add to mobile container
        this.addMessageToContainer(message, this.mobileMessages, true);
    }
    
    addMessageToContainer(message, container, isMobile) {
        if (!container) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'global-chat-message';
        
        // Check if it's the current user's message
        const isOwnMessage = this.currentUser && message.userId === this.currentUser.uid;
        if (isOwnMessage) {
            messageDiv.classList.add('own-message');
        }
        
        // Create avatar
        const avatar = document.createElement('img');
        avatar.className = 'global-chat-message-avatar';
        avatar.src = message.userPhoto || 'https://www.gravatar.com/avatar?d=mp&s=24';
        avatar.alt = message.userName || 'User';
        avatar.onerror = () => {
            avatar.src = 'https://www.gravatar.com/avatar?d=mp&s=24';
        };
        
        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'global-chat-message-content';
        
        // Create name element
        const nameDiv = document.createElement('div');
        nameDiv.className = 'global-chat-message-name';
        nameDiv.textContent = message.userName || 'Anonymous';
        
        // Create text element
        const textDiv = document.createElement('div');
        textDiv.className = 'global-chat-message-text';
        textDiv.textContent = message.text;
        
        // Create timestamp element
        const timeDiv = document.createElement('div');
        timeDiv.className = 'global-chat-message-time';
        timeDiv.textContent = this.formatTimestamp(message.timestamp);
        
        // Assemble message
        contentDiv.appendChild(nameDiv);
        contentDiv.appendChild(textDiv);
        contentDiv.appendChild(timeDiv);
        
        if (!isOwnMessage) {
            messageDiv.appendChild(avatar);
        }
        messageDiv.appendChild(contentDiv);
        if (isOwnMessage) {
            messageDiv.appendChild(avatar);
        }
        
        // Add to messages container
        container.appendChild(messageDiv);
        
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
        
        // Remove old messages if over limit
        this.cleanupOldMessages(container);
    }
    
    cleanupOldMessages(container) {
        if (!container) return;
        
        const messages = container.querySelectorAll('.global-chat-message');
        if (messages.length > this.messageLimit) {
            const messagesToRemove = messages.length - this.messageLimit;
            for (let i = 0; i < messagesToRemove; i++) {
                messages[i].remove();
            }
        }
    }
    
    formatTimestamp(timestamp) {
        if (!timestamp) return '';
        
        const now = new Date();
        const messageTime = new Date(timestamp);
        const diffMs = now - messageTime;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffMins < 1) {
            return 'Just now';
        } else if (diffMins < 60) {
            return `${diffMins}m ago`;
        } else if (diffHours < 24) {
            return `${diffHours}h ago`;
        } else if (diffDays < 7) {
            return `${diffDays}d ago`;
        } else {
            return messageTime.toLocaleDateString();
        }
    }
    
    updateUI() {
        // Update theme-based styling
        this.applyThemeStyles();
    }
    
    applyThemeStyles() {
        // Get current theme from CSS variables or body class
        const body = document.body;
        const isGreenboard = body.classList.contains('theme-greenboard');
        const isWhiteboard = body.classList.contains('theme-whiteboard');
        
        if (!this.chatContainer) return;
        
        // Apply theme-specific font family
        if (isGreenboard) {
            this.chatContainer.style.fontFamily = 'Schoolbell, cursive';
        } else if (isWhiteboard) {
            this.chatContainer.style.fontFamily = 'Patrick Hand, cursive';
        }
    }
    
    // Cleanup method
    destroy() {
        this.cleanupUserPresence();
        
        if (this.messagesListener && this.messagesRef) {
            off(this.messagesRef, 'child_added', this.messagesListener);
        }
    }
}

// Initialize the global chat when DOM is loaded
let globalChatManager;

document.addEventListener('DOMContentLoaded', () => {
    globalChatManager = new GlobalChatManager();
    window.globalChatManager = globalChatManager;
});

// Listen for theme changes
document.addEventListener('themeChanged', () => {
    if (globalChatManager) {
        globalChatManager.updateUI();
    }
});

// Export for potential external use
export { GlobalChatManager };
