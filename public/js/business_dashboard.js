// Ensure socket is only created once
if (!window._dashboardSocket) {
    window._dashboardSocket = io();
}
let socket = window._dashboardSocket;

let currentConversationId = null;
let conversationsPage = 1;
let searchTerm = '';
let currentBusinessId = document.getElementById('businessSelector') ? document.getElementById('businessSelector').value : null;
let previousConversationId = null;

// DOM elements
const conversationsList = document.getElementById('conversationsList');
const chatMessages = document.getElementById('chatMessages');
const conversationTitle = document.getElementById('conversationTitle');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const takeOverBtn = document.getElementById('takeOverBtn');
const letBotHandleBtn = document.getElementById('letBotHandleBtn');
const deleteConversationBtn = document.getElementById('deleteConversationBtn');
const activeNotice = document.getElementById('activeNotice');
const searchInput = document.getElementById('searchInput');
const refreshBtn = document.getElementById('refreshBtn');
const loadMoreBtn = document.getElementById('loadMoreBtn');

// Widget Settings logic
const widgetForm = document.getElementById('widgetSettingsForm');
const widgetHeaderName = document.getElementById('widget_header_name');
const widgetHeaderColor = document.getElementById('widget_header_color');
const widgetQuickReplies = document.getElementById('widget_quick_replies');
const widgetH1Color = document.getElementById('widget_h1_color');
const widgetButtonColor = document.getElementById('widget_button_color');
const widgetVisitorMessageColor = document.getElementById('widget_visitor_message_color');
const widgetPreviewIframe = document.getElementById('widgetPreviewIframe');

// AI Settings logic
const aiSettingsForm = document.getElementById('aiSettingsForm');
const chatbaseApiKey = document.getElementById('chatbase_api_key');
const chatbaseAgentId = document.getElementById('chatbase_agent_id');
const n8nWebhookUrl = document.getElementById('n8n_webhook_url');
const n8nSystemPrompt = document.getElementById('n8n_system_prompt');

// Listen for business selector changes
const businessSelector = document.getElementById('businessSelector');
if (businessSelector) {
    businessSelector.addEventListener('change', function() {
        currentBusinessId = this.value;
        loadAllDashboardData();
        // Leave previous business room and join new one
        socket.emit('leave business', { businessId: currentBusinessId });
        socket.emit('join business', { businessId: currentBusinessId });
    });
}

// Load all dashboard data for the selected business
async function loadAllDashboardData() {
    // Load conversations
    conversationsPage = 1;
    searchTerm = '';
    loadConversations(1, '');
    // Load team members
    loadTeamMembers();
    // Load widget settings
    loadWidgetSettings();
    // Load AI settings
    loadAISettings();
    // Reset chat UI
    chatMessages.innerHTML = '';
    conversationTitle.textContent = 'Select a conversation';
    takeOverBtn.classList.add('d-none');
    letBotHandleBtn.classList.add('d-none');
    deleteConversationBtn.classList.add('d-none');
    activeNotice.classList.add('d-none');
}

// Load conversations
async function loadConversations(page = 1, search = '') {
    if (!currentBusinessId) return;
    const res = await fetch(`/api/business/${currentBusinessId}/conversations?page=${page}&search=${encodeURIComponent(search)}`);
    const data = await res.json();
    if (page === 1) conversationsList.innerHTML = '';
    data.conversations.forEach(conv => {
        const div = document.createElement('div');
        div.className = 'chat-preview px-3 py-3 d-flex align-items-start gap-3' + (conv.unread_count > 0 ? ' unread-preview' : '');
        div.dataset.id = conv.id;
        // Manual highlight for active conversation
        if (conv.id == currentConversationId) {
            div.style.background = '#e6f0ff';
            div.style.borderLeft = '4px solid #007bff';
            div.style.boxShadow = '0 2px 8px rgba(0,123,255,0.08)';
        } else {
            div.style.background = '';
            div.style.borderLeft = '';
            div.style.boxShadow = '';
        }
        div.innerHTML = `
            <span class="status-badge status-${conv.status}">${conv.status.charAt(0).toUpperCase() + conv.status.slice(1)}</span>
            <div class="flex-grow-1 min-w-0">
                <div class="text-sm text-truncate ${conv.unread_count > 0 ? 'unread-message' : ''}">${conv.last_bot_message || '<span class=\'text-muted\'>No response yet</span>'}</div>
                <div class="text-sm text-muted text-truncate ${conv.unread_count > 0 ? 'unread-message' : ''}">${conv.last_user_message || '<span class=\'text-muted\'>No messages yet</span>'}</div>
            </div>
            <span class="text-xs text-muted mt-1">${conv.last_message_time ? timeAgo(new Date(conv.last_message_time)) : ''}</span>
        `;
        div.onclick = () => selectConversation(conv.id);
        conversationsList.appendChild(div);
    });
    loadMoreBtn.style.display = data.hasMore ? '' : 'none';
}

// Format message (markdown, images, links)
function formatMessage(text) {
    if (typeof text !== 'string') return text;
    let escapedText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    escapedText = escapedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    escapedText = escapedText.replace(/_([^_]+)_/g, '<em>$1</em>');
    escapedText = escapedText.replace(/^\*\s+/gm, '&bull; ').replace(/^\-\s+/gm, '&bull; ');
    escapedText = escapedText.replace(/^(\d+)\.\s+/gm, '$1. ');
    // Markdown Images ![alt](url) - ensure line breaks before and after
    escapedText = escapedText.replace(/!\[([^\]]*)\]\((.*?)\)/g, '<br><div class="chat-image"><img src="$2" alt="$1" style="max-width:250px;max-height:250px;border-radius:10px;margin:10px 0;"></div><br>');
    // Markdown Links [text](url)
    escapedText = escapedText.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: #007bff; text-decoration: underline;">$1</a>');
    // Plain image URLs - ensure line breaks before and after
    escapedText = escapedText.replace(/(https?:\/\/[^\s<>"]+\.(?:jpg|jpeg|png|gif|webp))/gi, url =>
        `<br><div class="chat-image"><img src="${url}" alt="Image" style="max-width:250px;max-height:250px;border-radius:10px;margin:10px 0;"></div><br>`
    );
    // Plain non-image URLs
    escapedText = escapedText.replace(/(https?:\/\/[^\s<>"]+)/gi, url => {
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(url)) return url;
        if (escapedText.includes(`href=\"${url}\"`)) return url;
        return `<a href="${url}" target="_blank" style="color: #007bff; text-decoration: underline;">${url}</a>`;
    });
    // Newlines to <br>
    escapedText = escapedText.replace(/\n/g, '<br>');
    // Remove duplicate <br> before/after images for cleaner output
    escapedText = escapedText.replace(/(<br>\s*){2,}/g, '<br>');
    escapedText = escapedText.replace(/(<br>\s*)+(<div class=\"chat-image\")/g, '<br>$2');
    escapedText = escapedText.replace(/(<\/div>\s*)+(<br>)/g, '</div><br>');
    return escapedText;
}

// Add chat-image CSS for spacing and centering
(function() {
    const style = document.createElement('style');
    style.innerHTML = `.chat-image { text-align: center; margin: 10px 0; }`;
    document.head.appendChild(style);
})();

// Render a single message in the chat area
function renderMessage(msg) {
    const div = document.createElement('div');
    if (msg.sender_type === 'user') {
        div.className = 'message user';
        div.style.background = '#f0f0f0';
        div.style.color = '#222';
        div.style.marginRight = 'auto';
        div.style.alignSelf = 'flex-start';
    } else if (msg.sender_type === 'agent') {
        div.className = 'message agent';
        div.style.background = '#22c55e';
        div.style.color = '#fff';
        div.style.marginLeft = 'auto';
        div.style.alignSelf = 'flex-end';
    } else if (msg.sender_type === 'bot') {
        div.className = 'message bot';
        div.style.background = '#2563eb';
        div.style.color = '#fff';
        div.style.marginLeft = 'auto';
        div.style.alignSelf = 'flex-end';
    }
    div.innerHTML = formatMessage(msg.content || msg.message || '');
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Load messages for a conversation
async function loadMessages(conversationId) {
    const res = await fetch(`/api/business/${currentBusinessId}/conversations/${conversationId}/messages`);
    const data = await res.json();
    chatMessages.innerHTML = '';
    data.messages.forEach(msg => renderMessage(msg));
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Select a conversation
async function selectConversation(conversationId) {
    // Leave previous conversation room (only if different)
    if (previousConversationId && previousConversationId !== conversationId) {
        socket.emit('leave conversation', { conversationId: previousConversationId });
        console.log('Left conversation room:', previousConversationId);
    }
    // Join new conversation room (use correct event for admin)
    socket.emit('admin join', { businessId: currentBusinessId, conversationId });
    console.log('Joined conversation room:', conversationId);
    previousConversationId = conversationId;
    currentConversationId = conversationId;
    // Fetch conversation metadata (status)
    let status = 'active';
    try {
        const res = await fetch(`/api/business/${currentBusinessId}/conversations/${conversationId}`);
        const data = await res.json();
        if (data.conversation && data.conversation.status) {
            status = data.conversation.status;
        }
    } catch (e) {}
    // Manually update highlight (no reload)
    document.querySelectorAll('.chat-preview').forEach(div => {
        if (div.dataset.id == conversationId.toString()) {
            div.style.background = '#e6f0ff';
            div.style.borderLeft = '4px solid #007bff';
            div.style.boxShadow = '0 2px 8px rgba(0,123,255,0.08)';
        } else {
            div.style.background = '';
            div.style.borderLeft = '';
            div.style.boxShadow = '';
        }
    });
    // Start mark-read and loadMessages in parallel
    const markReadPromise = fetch(`/api/business/${currentBusinessId}/conversations/${conversationId}/mark-read`, { method: 'POST' });
    const loadMessagesPromise = loadMessages(conversationId);
    await Promise.all([markReadPromise, loadMessagesPromise]);
    // After both complete, refresh conversations list to update unread status
    await loadConversations(1, searchTerm);
    // UI logic for status
    if (status === 'active') {
        messageInput.disabled = true;
        messageForm.querySelector('button[type="submit"]').disabled = true;
        takeOverBtn.classList.remove('d-none');
        letBotHandleBtn.classList.add('d-none');
        activeNotice.classList.remove('d-none');
    } else {
        messageInput.disabled = false;
        messageForm.querySelector('button[type="submit"]').disabled = false;
        takeOverBtn.classList.add('d-none');
        letBotHandleBtn.classList.remove('d-none');
        activeNotice.classList.add('d-none');
    }
    deleteConversationBtn.classList.remove('d-none');
}

// Send message
messageForm.onsubmit = async e => {
    if (messageInput.disabled) return;
    e.preventDefault();
    const msg = messageInput.value.trim();
    if (!msg || !currentConversationId) return;
    socket.emit('admin message', { businessId: currentBusinessId, conversationId: currentConversationId, content: msg });
    messageInput.value = '';
};

// Listen for real-time chat messages in the current conversation
socket.on('chat message', data => {
    console.log('Received chat message event:', data);
    if (data.conversationId == currentConversationId) {
        renderMessage(data);
    }
    if (data.conversationId != currentConversationId) {
        loadConversations();
    }
});

// Take over
takeOverBtn.onclick = async () => {
    if (!currentConversationId) return;
    await fetch(`/api/business/${currentBusinessId}/conversations/${currentConversationId}/takeover`, { method: 'POST' });
    await selectConversation(currentConversationId);
};
// Let bot handle
letBotHandleBtn.onclick = async () => {
    if (!currentConversationId) return;
    await fetch(`/api/business/${currentBusinessId}/conversations/${currentConversationId}/let-bot-handle`, { method: 'POST' });
    await selectConversation(currentConversationId);
};
// Delete conversation
deleteConversationBtn.onclick = async () => {
    if (!currentConversationId) return;
    if (!confirm('Are you sure you want to delete this conversation and all its messages? This cannot be undone.')) return;
    await fetch(`/api/business/${currentBusinessId}/conversations/${currentConversationId}`, { method: 'DELETE' });
    currentConversationId = null;
    conversationTitle.textContent = 'Select a conversation';
    chatMessages.innerHTML = '';
    takeOverBtn.classList.add('d-none');
    letBotHandleBtn.classList.add('d-none');
    deleteConversationBtn.classList.add('d-none');
    activeNotice.classList.add('d-none');
    await loadConversations();
};

// Search
searchInput.oninput = () => {
    searchTerm = searchInput.value;
    loadConversations(1, searchTerm);
};
// Refresh
refreshBtn.onclick = () => loadConversations(1, searchTerm);
// Load more
loadMoreBtn.onclick = () => {
    conversationsPage++;
    loadConversations(conversationsPage, searchTerm);
};

// Time ago helper
function timeAgo(date) {
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return date.toLocaleDateString();
}

async function loadTeamMembers() {
    if (!currentBusinessId) return;
    // TODO: Implement AJAX call to fetch team members for currentBusinessId
    // Example: fetch(`/api/business/${currentBusinessId}/team`)
    // For now, clear the list
    document.getElementById('teamMembersList').innerHTML = '<div class="alert alert-info">Team management coming soon!</div>';
}

async function loadWidgetSettings() {
    if (!currentBusinessId) return;
    const res = await fetch(`/api/business/${currentBusinessId}/widget-settings`);
    const data = await res.json();
    if (data.settings) {
        widgetHeaderName.value = data.settings.widget_header_name || data.settings.name + ' Live Chat';
        widgetHeaderColor.value = data.settings.widget_header_color || '#eee';
        widgetQuickReplies.value = data.settings.widget_quick_replies || '';
        widgetH1Color.value = data.settings.widget_h1_color || '#000000';
        widgetButtonColor.value = data.settings.widget_button_color || '#B31111';
        widgetVisitorMessageColor.value = data.settings.widget_visitor_message_color || '#007bff';
        updateWidgetPreview();
    }
}

function updateWidgetPreview() {
    if (!currentBusinessId) return;
    const params = new URLSearchParams();
    params.set('preview', '1');
    params.set('headerName', widgetHeaderName.value);
    params.set('headerColor', widgetHeaderColor.value);
    params.set('quickReplies', widgetQuickReplies.value);
    params.set('h1Color', widgetH1Color.value);
    params.set('buttonColor', widgetButtonColor.value);
    params.set('visitorMessageColor', widgetVisitorMessageColor.value);
    widgetPreviewIframe.src = `/widget/${currentBusinessId}?${params.toString()}`;
}

[widgetHeaderName, widgetHeaderColor, widgetQuickReplies, widgetH1Color, widgetButtonColor, widgetVisitorMessageColor].forEach(input => {
    input.addEventListener('input', updateWidgetPreview);
});

widgetForm.onsubmit = async function(e) {
    e.preventDefault();
    if (!currentBusinessId) return;
    const formData = new FormData(widgetForm);
    const body = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
        body.append(key, value);
    }
    const res = await fetch(`/api/business/${currentBusinessId}/widget-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const data = await res.json();
    if (data.success) {
        widgetForm.querySelector('button[type="submit"]').textContent = 'Saved!';
        setTimeout(() => {
            widgetForm.querySelector('button[type="submit"]').textContent = 'Save Settings';
        }, 1500);
    }
};

async function loadAISettings() {
    if (!currentBusinessId) return;
    const res = await fetch(`/api/business/${currentBusinessId}/ai-settings`);
    const data = await res.json();
    if (data.settings) {
        chatbaseApiKey.value = data.settings.chatbase_api_key || '';
        chatbaseAgentId.value = data.settings.chatbase_agent_id || '';
        if (n8nWebhookUrl) n8nWebhookUrl.value = data.settings.n8n_webhook_url || '';
        if (n8nSystemPrompt) n8nSystemPrompt.value = data.settings.n8n_system_prompt || '';
    }
}

// Handle AI settings form submission
if (aiSettingsForm) {
    aiSettingsForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!currentBusinessId) return;
        const formData = {
            chatbase_api_key: chatbaseApiKey.value,
            chatbase_agent_id: chatbaseAgentId.value,
            n8n_webhook_url: n8nWebhookUrl ? n8nWebhookUrl.value : '',
            n8n_system_prompt: n8nSystemPrompt ? n8nSystemPrompt.value : ''
        };
        try {
            const response = await fetch(`/api/business/${currentBusinessId}/ai-settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });
            const data = await response.json();
            if (data.success) {
                showAlert('AI settings saved successfully!', 'success');
            } else {
                showAlert('Failed to save AI settings. Please try again.', 'danger');
            }
        } catch (error) {
            console.error('Error saving AI settings:', error);
            showAlert('An error occurred while saving AI settings.', 'danger');
        }
    });
}

// On initial load
loadConversations();

// Join business room for real-time updates
if (currentBusinessId) {
    socket.emit('join business', { businessId: currentBusinessId });
}

// Listen for new conversation
socket.on('new conversation', data => {
    if (data.businessId == currentBusinessId) {
        loadConversations();
    }
});

// Listen for conversation update (e.g., new message, status change)
socket.on('update conversation', data => {
    if (data.businessId == currentBusinessId) {
        loadConversations();
    }
});

// Listen for conversation delete
socket.on('delete conversation', data => {
    if (data.businessId !== currentBusinessId) return;
    loadConversations();
});

function showAlert(message, type = 'info') {
    let oldAlert = document.getElementById('dashboard-alert');
    if (oldAlert) oldAlert.remove();
    const alert = document.createElement('div');
    alert.id = 'dashboard-alert';
    alert.className = `alert alert-${type}`;
    alert.style.position = 'fixed';
    alert.style.top = '20px';
    alert.style.right = '20px';
    alert.style.zIndex = 9999;
    alert.innerText = message;
    document.body.appendChild(alert);
    setTimeout(() => {
        alert.remove();
    }, 3000);
} 