// scripts/global-chat.js
import { supabase } from './supabase-config.js';

class GlobalChatManager {
    constructor() {
        this.currentUser = null;
        this.messageLimit = 100;
        this.chatChannel = null;

        // This is a simplified mock for online users if anon auth isn't fully set up yet.
        // True presence requires a dedicated presence channel in Supabase.
        this.presenceChannel = null;
        this.onlineUsers = new Map();

        // DOM elements - Desktop
        this.chatContainer = document.getElementById('globalChatContainer');
        this.chatMessages = document.getElementById('globalChatMessages');
        this.chatInput = document.getElementById('globalChatInput');
        this.chatSendBtn = document.getElementById('globalChatSendBtn');
        this.chatInputRow = document.getElementById('globalChatInputRow');
        const setupSigninClick = (element) => {
            if (element) {
                element.style.cursor = 'pointer';
                element.onclick = () => {
                    const signInBtn = document.getElementById('googleSignInBtn');
                    if (signInBtn) signInBtn.click();
                };
            }
        };

        this.chatSigninMessage = document.getElementById('globalChatSigninMessage');
        setupSigninClick(this.chatSigninMessage);
        this.onlineUsersCount = document.getElementById('onlineUsersCount');

        // DOM elements - Mobile
        this.mobileDrawerKey = document.getElementById('mobileGlobalChatKey');
        this.mobileDrawer = document.getElementById('mobileGlobalChatDrawer');
        this.mobileMessages = document.getElementById('globalChatMessagesMobile');
        this.mobileInput = document.getElementById('mobileGlobalChatInput');
        this.mobileSendBtn = document.getElementById('mobileGlobalChatSendBtn');
        this.mobileInputRow = document.getElementById('mobileGlobalChatInputRow');
        this.mobileSigninMessage = document.getElementById('mobileGlobalChatSigninMessage');
        setupSigninClick(this.mobileSigninMessage);
        this.mobileOnlineUsersCount = document.getElementById('mobileOnlineUsersCount');
        this.mobileCloseBtn = document.getElementById('closeMobileGlobalChat');

        this.initializeChat();
    }

    async initializeChat() {
        // Listen for auth state changes from the main app
        // For now, assume auth is handled at the app level and updates a global or triggers an event

        // Fallback: Check if we have a user in localStorage from previous Google Sign-in logic
        // Alternatively, wait for main.js to tell us

        this.setupEventListeners();

        // Load initial messages
        const { data: messages } = await supabase
            .from('global_chat')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(this.messageLimit);

        if (messages) {
            // Reverse so oldest is first again for UI
            messages.reverse().forEach(msg => this.addMessageToUI({
                id: msg.id,
                text: msg.text,
                userId: msg.user_id,
                userName: msg.user_name,
                userPhoto: msg.user_photo,
                timestamp: msg.created_at
            }));
        }

        this.initializeMessageListener();
        this.setupUserPresence();

        // Check if app is already initialized and tell it we are ready
        if (window.dotsAndBoxesApp && window.dotsAndBoxesApp.signedInUser) {
            this.handleAuthStateChange(window.dotsAndBoxesApp.signedInUser);
        } else if (window.dotsApp && window.dotsApp.signedInUser) {
            // Keep dotsApp as fallback just in case
            this.handleAuthStateChange(window.dotsApp.signedInUser);
        }
    }

    handleAuthStateChange(user) {
        this.currentUser = user;

        if (user) {
            this.showChatInput();
            this.trackPresence();
        } else {
            this.showSigninMessage();
        }
        this.updateUI();
    }

    showChatInput() {
        if (this.chatInputRow) this.chatInputRow.style.display = 'block';
        if (this.chatSigninMessage) this.chatSigninMessage.style.display = 'none';
        if (this.chatInput) this.chatInput.disabled = false;
        if (this.chatSendBtn) this.chatSendBtn.disabled = false;

        if (this.mobileInputRow) this.mobileInputRow.style.display = 'block';
        if (this.mobileSigninMessage) this.mobileSigninMessage.style.display = 'none';
        if (this.mobileInput) this.mobileInput.disabled = false;
        if (this.mobileSendBtn) this.mobileSendBtn.disabled = false;
    }

    showSigninMessage() {
        if (this.chatInputRow) this.chatInputRow.style.display = 'none';
        if (this.chatSigninMessage) this.chatSigninMessage.style.display = 'block';
        if (this.chatInput) this.chatInput.disabled = true;
        if (this.chatSendBtn) this.chatSendBtn.disabled = true;

        if (this.mobileInputRow) this.mobileInputRow.style.display = 'none';
        if (this.mobileSigninMessage) this.mobileSigninMessage.style.display = 'block';
        if (this.mobileInput) this.mobileInput.disabled = true;
        if (this.mobileSendBtn) this.mobileSendBtn.disabled = true;
    }

    setupEventListeners() {
        if (this.chatSendBtn) this.chatSendBtn.addEventListener('click', () => this.sendMessage());
        if (this.chatInput) {
            this.chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
            });
        }
        if (this.mobileSendBtn) this.mobileSendBtn.addEventListener('click', () => this.sendMessage(true));
        if (this.mobileInput) {
            this.mobileInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(true); }
            });
        }
        if (this.mobileDrawerKey) {
            // Draggable logic
            let isDragging = false;
            let startY = 0;
            let initialTop = 0;
            this.wasDragged = false;

            const onDragStart = (e) => {
                isDragging = true;
                startY = (e.touches ? e.touches[0].clientY : e.clientY);
                initialTop = this.mobileDrawerKey.offsetTop;
                this.mobileDrawerKey.style.transition = 'none';
                this.dragStartTime = Date.now();
                this.wasDragged = false;
            };

            const onDragMove = (e) => {
                if (!isDragging) return;
                const currentY = (e.touches ? e.touches[0].clientY : e.clientY);
                const deltaY = currentY - startY;
                let newTop = initialTop + deltaY;

                // Constrain within vertical bounds
                const maxTop = window.innerHeight - this.mobileDrawerKey.offsetHeight - 20;
                const minTop = 20;
                newTop = Math.max(minTop, Math.min(newTop, maxTop));

                this.mobileDrawerKey.style.top = `${newTop}px`;
                this.mobileDrawerKey.style.bottom = 'auto';

                if (Math.abs(deltaY) > 5) this.wasDragged = true;
            };

            const onDragEnd = () => {
                if (!isDragging) return;
                isDragging = false;
                this.mobileDrawerKey.style.transition = 'all 0.3s ease';
            };

            this.mobileDrawerKey.addEventListener('mousedown', onDragStart);
            window.addEventListener('mousemove', onDragMove);
            window.addEventListener('mouseup', onDragEnd);

            this.mobileDrawerKey.addEventListener('touchstart', onDragStart, { passive: false });
            window.addEventListener('touchmove', onDragMove, { passive: false });
            window.addEventListener('touchend', onDragEnd);

            this.mobileDrawerKey.addEventListener('click', (e) => {
                if (this.wasDragged) {
                    e.stopImmediatePropagation();
                    return;
                }
                this.showMobileDrawer();
            });

            const keyBtn = this.mobileDrawerKey.querySelector('button');
            if (keyBtn) {
                keyBtn.addEventListener('click', (e) => {
                    if (this.wasDragged) {
                        e.stopImmediatePropagation();
                        return;
                    }
                    this.showMobileDrawer();
                });
            }
        }
        if (this.mobileCloseBtn) this.mobileCloseBtn.addEventListener('click', () => this.hideMobileDrawer());
        if (this.mobileDrawer) {
            this.mobileDrawer.addEventListener('click', (e) => {
                if (e.target === this.mobileDrawer) this.hideMobileDrawer();
            });
        }
        this.handleResponsive();
        window.addEventListener('resize', () => this.handleResponsive());
    }

    setupUserPresence() {
        this.presenceChannel = supabase.channel('global_presence');

        this.presenceChannel
            .on('presence', { event: 'sync' }, () => {
                const newState = this.presenceChannel.presenceState();
                let count = 0;
                for (const key in newState) {
                    count += newState[key].length;
                }
                // Add minimum 1 so it doesn't look dead if you are the only one
                this.updateOnlineUsersCount(Math.max(1, count));
            })
            .subscribe();

        this.trackPresence();
    }

    async trackPresence() {
        if (!this.presenceChannel) return;

        await this.presenceChannel.track({
            user: this.currentUser?.uid || 'anonymous',
            online_at: new Date().toISOString()
        });
    }

    updateOnlineUsersCount(count) {
        const text = `${count} online`;
        if (this.onlineUsersCount) this.onlineUsersCount.textContent = text;
        if (this.mobileOnlineUsersCount) this.mobileOnlineUsersCount.textContent = text;
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
            if (this.mobileDrawerKey) this.mobileDrawerKey.style.display = 'block';
            if (this.chatContainer) this.chatContainer.style.display = 'none';
        } else {
            if (this.mobileDrawerKey) this.mobileDrawerKey.style.display = 'none';
            if (this.chatContainer) this.chatContainer.style.display = 'flex';
            this.hideMobileDrawer();
        }
    }

    initializeMessageListener() {
        this.chatChannel = supabase.channel('global_chat_stream')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'global_chat' },
                (payload) => {
                    const msg = payload.new;
                    this.addMessageToUI({
                        id: msg.id,
                        text: msg.text,
                        userId: msg.user_id,
                        userName: msg.user_name,
                        userPhoto: msg.user_photo,
                        timestamp: msg.created_at
                    });
                }
            )
            .subscribe();
    }

    async sendMessage(isMobile = false) {
        if (!this.currentUser) return;
        const input = isMobile ? this.mobileInput : this.chatInput;
        if (!input) return;

        const messageText = input.value.trim();
        if (!messageText) return;

        input.value = '';

        try {
            await supabase.from('global_chat').insert({
                text: messageText,
                user_id: this.currentUser.uid,
                user_name: this.currentUser.displayName || 'Anonymous',
                user_photo: this.currentUser.photoURL || ''
            });
        } catch (error) {
            // console.error('Error sending message:', error);
        }
    }

    addMessageToUI(message) {
        this.addMessageToContainer(message, this.chatMessages, false);
        this.addMessageToContainer(message, this.mobileMessages, true);
    }

    addMessageToContainer(message, container, isMobile) {
        if (!container) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = 'global-chat-message';
        messageDiv.style.position = 'relative';

        const isOwnMessage = this.currentUser && message.userId === this.currentUser.uid;
        if (isOwnMessage) messageDiv.classList.add('own-message');

        const avatar = document.createElement('img');
        avatar.className = 'global-chat-message-avatar';
        avatar.src = message.userPhoto || 'https://www.gravatar.com/avatar?d=mp&s=24';
        avatar.alt = message.userName || 'User';
        avatar.onerror = () => { avatar.src = 'https://www.gravatar.com/avatar?d=mp&s=24'; };

        const contentDiv = document.createElement('div');
        contentDiv.className = 'global-chat-message-content';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'global-chat-message-name';
        nameDiv.textContent = message.userName || 'Anonymous';

        const textDiv = document.createElement('div');
        textDiv.className = 'global-chat-message-text';
        textDiv.textContent = message.text;

        const timeDiv = document.createElement('div');
        timeDiv.className = 'global-chat-message-time';
        timeDiv.textContent = this.formatTimestamp(message.timestamp);

        contentDiv.appendChild(nameDiv);
        contentDiv.appendChild(textDiv);
        contentDiv.appendChild(timeDiv);

        if (!isOwnMessage) messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        if (isOwnMessage) messageDiv.appendChild(avatar);

        container.appendChild(messageDiv);
        container.scrollTop = container.scrollHeight;

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

    formatTimestamp(timestampStr) {
        if (!timestampStr) return '';
        const now = new Date();
        const messageTime = new Date(timestampStr);
        const diffMs = now - messageTime;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return 'Just now';
        else if (diffMins < 60) return `${diffMins}m ago`;
        else if (diffHours < 24) return `${diffHours}h ago`;
        else if (diffDays < 7) return `${diffDays}d ago`;
        else return messageTime.toLocaleDateString();
    }

    updateUI() {
        const body = document.body;
        const isGreenboard = body.classList.contains('theme-greenboard');
        const isWhiteboard = body.classList.contains('theme-whiteboard');

        if (!this.chatContainer) return;
        if (isGreenboard) this.chatContainer.style.fontFamily = 'Schoolbell, cursive';
        else if (isWhiteboard) this.chatContainer.style.fontFamily = 'Patrick Hand, cursive';
    }

    destroy() {
        if (this.chatChannel) this.chatChannel.unsubscribe();
        if (this.presenceChannel) this.presenceChannel.unsubscribe();
    }
}

let globalChatManager;

document.addEventListener('DOMContentLoaded', () => {
    globalChatManager = new GlobalChatManager();
    // Attach to window so we can update auth from main.js
    window.globalChatManager = globalChatManager;
});

document.addEventListener('themeChanged', () => {
    if (globalChatManager) globalChatManager.updateUI();
});

export { GlobalChatManager };
