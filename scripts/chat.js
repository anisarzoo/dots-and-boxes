/**
 * ChatManager - Premium Classroom Chat System
 * Handles in-game communication with thematic emojis and glassmorphic UI
 */
export class ChatManager {
    constructor(app) {
        this.app = app;
        this.messages = [];
        this.isDesktop = window.innerWidth > 1150 && window.innerHeight >= 500;
        this.clientId = Math.random().toString(36).substring(2, 9);

        // Thematic Emoji Categories
        this.emojiCategories = [
            {
                id: 'reactions',
                name: 'Reactions',
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>',
                emojis: ['😂', '😮', '🤔', '🤫', '🤯', '🥳', '😎', '🤣', '😭', '😤', '😡', '😴', '🙄', '😱', '🤩', '🤡']
            },
            {
                id: 'social',
                name: 'Social',
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6.1H3"></path><path d="M21 12.1H3"></path><path d="M15.1 18.1H3"></path></svg>',
                emojis: ['👋', '👍', '👎', '🙌', '🙏', '👏', '💖', '✨', '🎈', '🎉', '💬', '📢', '💖', '🌈', '🍭', '🍕']
            },
            {
                id: 'strategy',
                name: 'Strategy',
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>',
                emojis: ['🎯', '🏆', '💡', '🛡️', '⚔️', '📍', '🎲', '💯', '🔥', '👀', '🤝', '⚡', '💣', '🧠', '⌛', '🏁']
            },
            {
                id: 'classroom',
                name: 'Classroom',
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
                emojis: ['📏', '📐', '✏️', '🖍️', '📚', '🎒', '🍎', '🎓', '🧑‍🏫', '🔔', '📝', '📓', '🏫', '🧪', '🎨', '🎺']
            }
        ];

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.renderEmojiPickers();
        this.updateLayout();

        window.addEventListener('resize', () => {
            const wasDesktop = this.isDesktop;
            this.isDesktop = window.innerWidth > 1150 && window.innerHeight >= 500;
            if (wasDesktop !== this.isDesktop) {
                this.updateLayout();
            }
        });

        // Register with network manager
        if (this.app.networkManager) {
            this.app.networkManager.on('chat', (data) => {
                this.addMessage(data);
            });
        }
    }

    gameStarted() {
        this.addMessage({
            content: "Class has started! Good luck!",
            isSystem: true,
            type: 'system'
        });
    }

    setupEventListeners() {
        ['desktop', 'mobile'].forEach(platform => {
            const input = document.getElementById(`${platform}ChatInput`);
            const sendBtn = document.getElementById(`${platform}SendBtn`);
            const emojiBtn = document.getElementById(`${platform}EmojiBtn`);

            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.sendMessage(input.value, platform);
                    }
                });
            }

            if (sendBtn) {
                sendBtn.addEventListener('click', () => {
                    this.sendMessage(input.value, platform);
                });
            }

            if (emojiBtn) {
                emojiBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleEmojiPicker(platform);
                });
            }
        });

        // Global click to close picker
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.emoji-picker') && !e.target.closest('.emoji-btn')) {
                this.closeAllPickers();
            }
        });
    }

    renderEmojiPickers() {
        ['desktop', 'mobile'].forEach(platform => {
            const picker = document.getElementById(`${platform}EmojiPicker`);
            if (!picker) return;

            picker.innerHTML = `
                <div class="emoji-picker-container">
                    <div class="emoji-picker-tabs">
                        ${this.emojiCategories.map((cat, idx) => `
                            <button class="emoji-picker-tab ${idx === 0 ? 'active' : ''}" 
                                    data-cat="${cat.id}" title="${cat.name}">
                                ${cat.icon}
                            </button>
                        `).join('')}
                    </div>
                    <div class="emoji-picker-content">
                        ${this.emojiCategories.map((cat, idx) => `
                            <div class="emoji-category-list ${idx === 0 ? 'active' : ''}" id="${platform}-cat-${cat.id}">
                                ${cat.emojis.map(emoji => `
                                    <button class="emoji-item" data-emoji="${emoji}">${emoji}</button>
                                `).join('')}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;

            // Tab logic
            const tabs = picker.querySelectorAll('.emoji-picker-tab');
            const lists = picker.querySelectorAll('.emoji-category-list');

            tabs.forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const catId = tab.dataset.cat;
                    tabs.forEach(t => t.classList.remove('active'));
                    lists.forEach(l => l.classList.remove('active'));
                    tab.classList.add('active');
                    picker.querySelector(`#${platform}-cat-${catId}`).classList.add('active');
                });
            });

            // Emoji click logic
            picker.addEventListener('click', (e) => {
                const btn = e.target.closest('.emoji-item');
                if (btn) {
                    e.stopPropagation();
                    this.insertEmoji(btn.dataset.emoji, platform);
                }
            });
        });
    }

    sendMessage(content, platform) {
        if (!content || !content.trim()) return;

        const displayName = this.app.getPlayerDisplayName ? this.app.getPlayerDisplayName() : 'Player';
        const message = {
            content: content.trim(),
            player: displayName,
            timestamp: Date.now(),
            clientId: this.clientId,
            isOwn: true
        };

        // Network sync
        if (this.app.networkManager && this.app.networkManager.getCurrentRoom()) {
            this.app.networkManager.sendChatMessage(message);
        } else {
            this.addMessage(message);
        }

        this.clearInput(platform);
        this.app.playSound('click');
        this.closeAllPickers();
    }

    addMessage(data) {
        // Validation & Consistency
        const message = {
            id: Date.now() + Math.random(),
            content: data.message || data.content,
            player: data.displayName || data.player || 'Anonymous',
            timestamp: data.timestamp || Date.now(),
            isOwn: data.clientId === this.clientId,
            isSystem: data.isSystem || false,
            type: data.type || 'msg'
        };

        this.messages.push(message);
        if (this.messages.length > 50) this.messages.shift();

        this.renderMessages();
        this.scrollToBottom();

        // Feedbacks
        if (!message.isOwn) {
            this.app.playSound('click');
            if (!this.isChatVisible()) {
                this.notifyNewMessage();
            }
        }
    }

    renderMessages() {
        const containers = ['desktopChatMessages', 'mobileChatMessages'];
        const html = this.messages.map(msg => this.getMessageHTML(msg)).join('');

        containers.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = html;
        });
    }

    getMessageHTML(msg) {
        if (msg.isSystem) {
            return `<div class="system-message ${msg.type}">${msg.content}</div>`;
        }

        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="chat-bubble ${msg.isOwn ? 'own' : 'other'}">
                <div class="bubble-info">
                    <span class="bubble-name">${this.escapeHtml(msg.player)}</span>
                    <span class="bubble-time">${time}</span>
                </div>
                <div class="bubble-content">${this.formatContent(msg.content)}</div>
            </div>
        `;
    }

    formatContent(text) {
        const escaped = this.escapeHtml(text);
        // Smart emoji replace
        return escaped
            .replace(/:\)/g, '😊')
            .replace(/:\D/g, '😃')
            .replace(/<3/g, '❤️')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }

    insertEmoji(emoji, platform) {
        const input = document.getElementById(`${platform}ChatInput`);
        if (input) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
            input.focus();
            input.setSelectionRange(start + emoji.length, start + emoji.length);
        }
    }

    toggleEmojiPicker(platform) {
        const picker = document.getElementById(`${platform}EmojiPicker`);
        if (!picker) return;

        const isHidden = picker.classList.contains('hidden');
        this.closeAllPickers();
        if (isHidden) picker.classList.remove('hidden');
    }

    closeAllPickers() {
        document.querySelectorAll('.emoji-picker').forEach(p => p.classList.add('hidden'));
    }

    clearInput(platform) {
        const input = document.getElementById(`${platform}ChatInput`);
        if (input) input.value = '';
    }

    scrollToBottom() {
        ['desktopChatMessages', 'mobileChatMessages'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.scrollTop = el.scrollHeight;
        });
    }

    notifyNewMessage() {
        const btn = document.getElementById('mobileChatBtn');
        if (btn) btn.classList.add('pulse-notif');
    }

    clearNotification() {
        const btn = document.getElementById('mobileChatBtn');
        if (btn) btn.classList.remove('pulse-notif');
    }

    isChatVisible() {
        if (this.isDesktop) return true;
        const drawer = document.getElementById('mobileChatDrawer');
        return drawer && !drawer.classList.contains('hidden');
    }

    updateLayout() {
        this.clearNotification();
        if (this.isDesktop) {
            this.closeAllPickers();
        }
    }

    escapeHtml(text) {
        const p = document.createElement('p');
        p.textContent = text;
        return p.innerHTML;
    }

    clearMessages() {
        this.messages = [];
        this.renderMessages();
    }

    /**
     * Add a system-generated message (e.g., "Player X has left the match").
     * Called by game.js for disconnect notifications, win-by-default, etc.
     * @param {string} text - The system message content
     * @param {string} type - Message type (info, success, warning, error)
     */
    addSystemMessage(text, type = 'info') {
        this.addMessage({
            message: text,
            player: 'System',
            isSystem: true,
            type: type,
            timestamp: Date.now()
        });
    }
}
