// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl     = /** @type {HTMLDivElement}     */ (document.getElementById('messages'));
const welcomeEl      = /** @type {HTMLDivElement}     */ (document.getElementById('welcome'));
const promptEl       = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
const sendBtn        = /** @type {HTMLButtonElement}  */ (document.getElementById('send-btn'));
const stopBtn        = /** @type {HTMLButtonElement}  */ (document.getElementById('stop-btn'));
const newChatBtn     = /** @type {HTMLButtonElement}  */ (document.getElementById('new-chat-btn'));
const modelSelect    = /** @type {HTMLSelectElement}  */ (document.getElementById('model-select'));
const statusDot      = /** @type {HTMLSpanElement}    */ (document.getElementById('status-dot'));
const statusText     = /** @type {HTMLSpanElement}    */ (document.getElementById('status-text'));
const scrollBtn      = /** @type {HTMLButtonElement}  */ (document.getElementById('scroll-btn'));
const contextBar     = /** @type {HTMLDivElement}     */ (document.getElementById('context-bar'));
const historyBtn     = /** @type {HTMLButtonElement}  */ (document.getElementById('history-btn'));
const historyPanel   = /** @type {HTMLDivElement}     */ (document.getElementById('history-panel'));
const historyList    = /** @type {HTMLDivElement}     */ (document.getElementById('history-list'));
const historyCloseBtn= /** @type {HTMLButtonElement}  */ (document.getElementById('history-close-btn'));
const historyClearBtn= /** @type {HTMLButtonElement}  */ (document.getElementById('history-clear-btn'));

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {HTMLDivElement | null} */
let currentMsgEl = null;
/** @type {string} */
let currentRaw = '';
let streaming = false;
/** True when the user has manually scrolled away from the bottom. */
let userScrolledUp = false;

/** Context state received from the extension. */
const ctx = {
    /** @type {string | null} */
    file: null,
    fileLines: 0,
    language: '',
    selectionLines: 0,
    includeFile: false,
    includeSelection: true,
};

// ── Status helpers ────────────────────────────────────────────────────────────

/** @param {'connected'|'disconnected'|'checking'} state @param {string} text */
function setStatus(state, text) {
    statusDot.className = state;
    statusText.textContent = text;
}

// ── Model list ────────────────────────────────────────────────────────────────

/**
 * @param {string[]} models
 * @param {boolean} connected
 */
function populateModels(models, connected) {
    modelSelect.innerHTML = '';
    if (!connected || !models.length) {
        setStatus('disconnected', 'Ollama not running — run: ollama serve');
        const o = document.createElement('option');
        o.textContent = 'No models';
        o.disabled = true;
        o.selected = true;
        modelSelect.appendChild(o);
        sendBtn.disabled = true;
        return;
    }
    models.forEach((name, i) => {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        if (i === 0) { o.selected = true; }
        modelSelect.appendChild(o);
    });
    setStatus('connected', `${models.length} model${models.length > 1 ? 's' : ''} available`);
    sendBtn.disabled = false;
    promptEl.focus();
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

/** @param {string} s */
function escHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** @param {string} text */
function renderMarkdown(text) {
    // 1. Extract fenced code blocks → placeholders
    /** @type {{lang:string, code:string}[]} */
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const id = `\x01CB${codeBlocks.length}\x01`;
        codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
        return id;
    });

    // 2. Extract inline code → placeholders
    /** @type {string[]} */
    const inlines = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
        const id = `\x01IC${inlines.length}\x01`;
        inlines.push(code);
        return id;
    });

    // 3. Extract <think> blocks → placeholders
    /** @type {string[]} */
    const thinks = [];
    text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => {
        const id = `\x01TH${thinks.length}\x01`;
        thinks.push(content.trim());
        return id;
    });

    // 4. Escape remaining HTML
    text = escHtml(text);

    // 5. Block-level markdown
    text = text.replace(/^#{4} (.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^#{3} (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^#{2} (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^# (.+)$/gm,    '<h2>$1</h2>');
    text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    text = text.replace(/^---+$/gm,      '<hr>');
    text = text.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    text = text.replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>');

    // 6. Inline markdown
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_\n]+)__/g,      '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g,      '<em>$1</em>');
    text = text.replace(/_([^_\n]+)_/g,        '<em>$1</em>');
    text = text.replace(/~~([^~\n]+)~~/g,      '<s>$1</s>');

    // 7. Paragraphs (skip lines that are already block elements)
    text = text.split('\n\n').map((p) => {
        p = p.trim();
        if (!p) { return ''; }
        if (/^<(h[2-4]|ul|ol|li|blockquote|hr|details|div)/.test(p)) { return p; }
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    // 8. Restore code blocks — use data attributes instead of onclick
    codeBlocks.forEach(({ lang, code }, i) => {
        const header = `<div class="code-header">` +
            `<span class="code-lang-label">${escHtml(lang || 'code')}</span>` +
            `<button class="copy-btn" data-copy-idx="${i}">Copy</button>` +
            `</div>`;
        text = text.replace(
            `\x01CB${i}\x01`,
            `<div class="code-block" data-block-idx="${i}">${header}<pre>${escHtml(code)}</pre></div>`
        );
    });

    // 9. Restore inline codes
    inlines.forEach((code, i) => {
        text = text.replace(
            `\x01IC${i}\x01`,
            `<code class="inline">${escHtml(code)}</code>`
        );
    });

    // 10. Restore think blocks
    thinks.forEach((content, i) => {
        const inner = escHtml(content).replace(/\n/g, '<br>');
        text = text.replace(
            `\x01TH${i}\x01`,
            `<details class="think-block"><summary>Reasoning (click to expand)</summary><div class="think-content">${inner}</div></details>`
        );
    });

    return text || '&nbsp;';
}

// ── Copy code — event delegation (CSP-safe, no onclick attributes) ────────────

messagesEl.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('copy-btn')) { return; }
    const block = btn.closest('.code-block');
    if (!block) { return; }
    const pre = block.querySelector('pre');
    if (!pre) { return; }
    navigator.clipboard?.writeText(pre.textContent ?? '').then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
    }).catch(() => {
        // Fallback for environments where clipboard API is restricted
        btn.textContent = 'Copy';
    });
});

// ── Scroll helpers ────────────────────────────────────────────────────────────

function scrollBottom(force = false) {
    if (force || !userScrolledUp) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
}

messagesEl.addEventListener('scroll', () => {
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    userScrolledUp = distFromBottom > 60;
    scrollBtn.classList.toggle('visible', userScrolledUp && streaming);
});

scrollBtn.addEventListener('click', () => {
    userScrolledUp = false;
    scrollBtn.classList.remove('visible');
    scrollBottom(true);
});

// ── Tool icons ────────────────────────────────────────────────────────────────

const TOOL_ICONS = {
    workspace_summary: '🗂️',
    read_file:         '📄',
    list_files:        '📁',
    search_files:      '🔍',
    create_file:       '🆕',
    edit_file:         '✏️',
    write_file:        '💾',
    append_to_file:    '📝',
    rename_file:       '🔄',
    delete_file:       '🗑️',
    run_command:       '⚡',
};

// ── Time helper ───────────────────────────────────────────────────────────────

function getTimeStr() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Chat helpers ──────────────────────────────────────────────────────────────

function hideWelcome() {
    if (welcomeEl && welcomeEl.parentNode === messagesEl) {
        messagesEl.removeChild(welcomeEl);
    }
}

// addUserMessage is defined later in the History section with optional timestamp support

function startAssistantMessage() {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent <span class="dots"><span></span><span></span><span></span></span></span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="msg-content"></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    currentMsgEl = div;
    currentRaw = '';
    scrollBottom();
    return div;
}

/** @param {string} token */
function appendToken(token) {
    if (!currentMsgEl) { return; }
    currentRaw += token;
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) {
        // During streaming show raw text — low-cost, avoids mid-stream markdown flicker
        content.textContent = currentRaw;
        scrollBottom();
    }
}

function finalizeMessage() {
    if (!currentMsgEl) { return; }

    // Remove loading dots from role label
    const roleEl = currentMsgEl.querySelector('.msg-role');
    if (roleEl) { roleEl.innerHTML = 'Agent'; }

    // Render full markdown
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) { content.innerHTML = renderMarkdown(currentRaw); }

    // Add retry button to completed assistant messages
    const header = currentMsgEl.querySelector('.msg-header');
    if (header && currentRaw) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'msg-action-btn retry-btn';
        retryBtn.title = 'Retry this response';
        retryBtn.textContent = '↺ Retry';
        actions.appendChild(retryBtn);
        header.appendChild(actions);
    }

    currentMsgEl = null;
    currentRaw = '';
    scrollBottom();
}

/** Remove the last assistant message element from the DOM (used for retry). */
function removeLastAssistantMsg() {
    // Walk backwards from scrollBtn (our fixed last child)
    let node = scrollBtn.previousSibling;
    while (node) {
        const el = /** @type {HTMLElement} */ (node);
        if (el.classList && el.classList.contains('message') && el.classList.contains('assistant')) {
            el.remove();
            return;
        }
        node = node.previousSibling;
    }
}

/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
function addToolCard(id, name, args) {
    const icon = TOOL_ICONS[name] || '🔧';
    const argsStr = Object.entries(args)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
    const div = document.createElement('div');
    div.className = 'tool-card';
    div.id = `tool-${id}`;
    div.innerHTML =
        `<div class="tool-icon">${icon}</div>` +
        `<div class="tool-info">` +
            `<div class="tool-name">${escHtml(name)}</div>` +
            `<div class="tool-args">${escHtml(argsStr)}</div>` +
        `</div>` +
        `<div class="dots"><span></span><span></span><span></span></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * @param {string} id
 * @param {boolean} success
 * @param {string} preview
 */
function updateToolCard(id, success, preview) {
    const card = document.getElementById(`tool-${id}`);
    if (!card) { return; }
    card.classList.add(success ? 'success' : 'error');
    const dots = card.querySelector('.dots');
    if (dots) { dots.remove(); }
    const info = card.querySelector('.tool-info');
    if (info) {
        const p = document.createElement('div');
        p.className = 'tool-preview';
        p.textContent = preview;
        info.appendChild(p);
    }
    scrollBottom();
}

/** @param {string} text */
function addErrorMessage(text) {
    finalizeMessage();
    const div = document.createElement('div');
    div.className = 'message error-msg';
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role" style="color:var(--vscode-errorForeground,#f48771);opacity:0.9">Error</span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="msg-content" style="color:var(--vscode-errorForeground,#f48771)">⚠ ${escHtml(text)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

function clearChat() {
    // Remove all message / tool-card children but keep #welcome and #scroll-btn
    Array.from(messagesEl.childNodes).forEach((node) => {
        const el = /** @type {HTMLElement} */ (node);
        if (el.id === 'scroll-btn') { return; }
        if (el.id === 'welcome') { return; }
        el.remove();
    });
    // Re-attach welcome if it was removed
    if (!document.getElementById('welcome')) {
        messagesEl.insertBefore(welcomeEl, scrollBtn);
        // Re-attach hint chip handlers
        welcomeEl.querySelectorAll('.hint-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
                if (hint) { promptEl.value = hint; sendMessage(); }
            });
        });
    }
    currentMsgEl = null;
    currentRaw = '';
    userScrolledUp = false;
    scrollBtn.classList.remove('visible');
}

// ── Retry via event delegation ────────────────────────────────────────────────

messagesEl.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('retry-btn')) { return; }
    if (streaming) { return; }
    // Remove this message bubble so it will be replaced
    const msgDiv = btn.closest('.message.assistant');
    if (msgDiv) { msgDiv.remove(); }
    setStreaming(true);
    vscode.postMessage({ command: 'retryLast', model: modelSelect.value });
});

// ── Context bar ───────────────────────────────────────────────────────────────

function updateContextBar() {
    contextBar.innerHTML = '';

    if (ctx.file) {
        const pill = document.createElement('span');
        pill.className = 'ctx-pill' + (ctx.includeFile ? ' active' : '');
        pill.title = ctx.includeFile
            ? 'Full file attached — click × to detach'
            : 'Click to attach full file';

        const fileName = ctx.file.split('/').pop() || ctx.file;
        pill.innerHTML =
            `📄 <span style="overflow:hidden;text-overflow:ellipsis;max-width:100px;display:inline-block;vertical-align:middle">${escHtml(fileName)}</span>` +
            ` <span class="ctx-pill-toggle" data-toggle="file">${ctx.includeFile ? '×' : '+'}</span>`;
        contextBar.appendChild(pill);
    }

    if (ctx.selectionLines > 0) {
        const pill = document.createElement('span');
        pill.className = 'ctx-pill' + (ctx.includeSelection ? ' active' : '');
        pill.title = ctx.includeSelection
            ? 'Selection attached — click × to detach'
            : 'Click to attach selection';
        pill.innerHTML =
            `✂️ ${ctx.selectionLines} line${ctx.selectionLines > 1 ? 's' : ''}` +
            ` <span class="ctx-pill-toggle" data-toggle="selection">${ctx.includeSelection ? '×' : '+'}</span>`;
        contextBar.appendChild(pill);
    }
}

contextBar.addEventListener('click', (e) => {
    const toggle = /** @type {HTMLElement} */ (e.target);
    if (!toggle.dataset.toggle) { return; }
    if (toggle.dataset.toggle === 'file') {
        ctx.includeFile = !ctx.includeFile;
        // If activating file, deactivate selection to avoid duplication
        if (ctx.includeFile) { ctx.includeSelection = false; }
    } else if (toggle.dataset.toggle === 'selection') {
        ctx.includeSelection = !ctx.includeSelection;
        if (ctx.includeSelection) { ctx.includeFile = false; }
    }
    updateContextBar();
});

// ── Command output blocks ─────────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {string} cmd
 */
function addCommandBlock(id, cmd) {
    const div = document.createElement('div');
    div.className = 'cmd-block';
    div.id = `cmd-${id}`;
    div.innerHTML =
        `<div class="cmd-header">` +
            `<span class="cmd-icon">⚡</span>` +
            `<span class="cmd-label">${escHtml(cmd)}</span>` +
            `<div class="dots"><span></span><span></span><span></span></div>` +
        `</div>` +
        `<div class="cmd-output"></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * @param {string} id
 * @param {string} text
 * @param {'stdout'|'stderr'} stream
 */
function appendCommandChunk(id, text, stream) {
    const block = document.getElementById(`cmd-${id}`);
    if (!block) { return; }
    const output = block.querySelector('.cmd-output');
    if (!output) { return; }
    const span = document.createElement('span');
    if (stream === 'stderr') { span.className = 'stderr'; }
    span.textContent = text;
    output.appendChild(span);
    // Auto-scroll the output pane itself
    output.scrollTop = output.scrollHeight;
    scrollBottom();
}

/**
 * @param {string} id
 * @param {number} exitCode
 */
function finalizeCommandBlock(id, exitCode) {
    const block = document.getElementById(`cmd-${id}`);
    if (!block) { return; }
    block.classList.add(exitCode === 0 ? 'success' : 'error');
    const dots = block.querySelector('.dots');
    if (dots) { dots.remove(); }
    const header = block.querySelector('.cmd-header');
    if (header) {
        const badge = document.createElement('span');
        badge.className = 'cmd-exit';
        badge.textContent = `exit ${exitCode}`;
        header.appendChild(badge);
    }
    scrollBottom();
}

// ── File-changed notification ─────────────────────────────────────────────────

const FILE_ACTION_ICONS = {
    created:  '✅',
    edited:   '✏️',
    written:  '💾',
    appended: '📝',
    renamed:  '🔄',
    deleted:  '🗑️',
};

/**
 * @param {string} filePath
 * @param {string} action
 */
function addFileToast(filePath, action) {
    const div = document.createElement('div');
    const isEdit   = action === 'edited'  || action === 'written' || action === 'appended';
    const isDelete = action === 'deleted';
    div.className = `file-toast${isEdit ? ' edited' : ''}${isDelete ? ' deleted' : ''}`;
    const icon = FILE_ACTION_ICONS[action] ?? '📁';
    div.innerHTML = `${icon} <span>${escHtml(action.charAt(0).toUpperCase() + action.slice(1))}: <strong>${escHtml(filePath)}</strong></span>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

// ── Mode-switch notice (native → text-mode tool calling) ─────────────────────

/** @param {string} model */
function addModeNotice(model) {
    const div = document.createElement('div');
    div.className = 'file-toast';
    div.style.cssText = 'background:rgba(229,192,123,0.08);border-color:rgba(229,192,123,0.35);color:#e5c07b;';
    div.innerHTML =
        `⚙️ <span><strong>${escHtml(model)}</strong> doesn't support native tool calling — ` +
        `switched to text-mode automatically. Tools still work.</span>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

// ── Send logic ────────────────────────────────────────────────────────────────

/** @param {boolean} on */
function setStreaming(on) {
    streaming = on;
    sendBtn.disabled = on || modelSelect.value === '';
    stopBtn.classList.toggle('visible', on);
    scrollBtn.classList.toggle('visible', on && userScrolledUp);
    if (!on) {
        promptEl.focus();
        scrollBtn.classList.remove('visible');
    }
}

function sendMessage() {
    const text = promptEl.value.trim();
    if (!text || streaming) { return; }

    addUserMessage(text);
    promptEl.value = '';
    autoResize();
    setStreaming(true);

    vscode.postMessage({
        command: 'sendMessage',
        text,
        model: modelSelect.value,
        includeFile: ctx.includeFile,
        includeSelection: ctx.includeSelection,
    });
}

sendBtn.addEventListener('click', sendMessage);

stopBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'stopGeneration' });
    setStreaming(false);
});

newChatBtn.addEventListener('click', () => {
    if (streaming) { return; }
    vscode.postMessage({ command: 'newChat' });
    clearChat();
});

promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-resize textarea
function autoResize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
}
promptEl.addEventListener('input', autoResize);

// Hint chips (initial welcome screen)
document.querySelectorAll('.hint-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
        const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
        if (hint) { promptEl.value = hint; sendMessage(); }
    });
});

// ── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'models':
            populateModels(msg.models, msg.connected);
            break;

        case 'streamStart':
            startAssistantMessage();
            break;

        case 'token':
            appendToken(msg.text);
            break;

        case 'streamEnd':
            finalizeMessage();
            setStreaming(false);
            break;

        case 'toolCall':
            addToolCard(msg.id, msg.name, msg.args);
            break;

        case 'toolResult':
            updateToolCard(msg.id, msg.success, msg.preview ?? '');
            break;

        case 'error':
            addErrorMessage(msg.text);
            setStreaming(false);
            break;

        case 'clearChat':
            clearChat();
            break;

        case 'removeLastAssistant':
            removeLastAssistantMsg();
            break;

        case 'commandStart':
            addCommandBlock(msg.id, msg.cmd);
            break;

        case 'commandChunk':
            appendCommandChunk(msg.id, msg.text, msg.stream);
            break;

        case 'commandEnd':
            finalizeCommandBlock(msg.id, msg.exitCode);
            break;

        case 'fileChanged':
            addFileToast(msg.path, msg.action);
            break;

        case 'modeSwitch':
            addModeNotice(msg.model);
            break;

        case 'sessionList':
            renderSessionList(msg.sessions, msg.currentId);
            break;

        case 'sessionLoaded':
            renderStoredSession(msg.session, msg.messages);
            break;

        case 'sessionSaved':
            // Silently update active session id
            activeSessionId = msg.session.id;
            break;

        case 'contextUpdate':
            ctx.file           = msg.file ?? null;
            ctx.fileLines      = msg.fileLines ?? 0;
            ctx.language       = msg.language ?? '';
            ctx.selectionLines = msg.selectionLines ?? 0;
            // Apply auto-include defaults from what was set (toggles preserved unless context changes)
            if (!ctx.file)           { ctx.includeFile = false; }
            if (!ctx.selectionLines) { ctx.includeSelection = false; }
            updateContextBar();
            break;
    }
});

// ── History panel ─────────────────────────────────────────────────────────────

/** @type {string | null} Current active session id (for highlighting in the list) */
let activeSessionId = null;

function openHistoryPanel() {
    historyPanel.classList.add('open');
    historyBtn.classList.add('active');
    vscode.postMessage({ command: 'listSessions' });
}

function closeHistoryPanel() {
    historyPanel.classList.remove('open');
    historyBtn.classList.remove('active');
}

historyBtn.addEventListener('click', () => {
    historyPanel.classList.contains('open') ? closeHistoryPanel() : openHistoryPanel();
});
historyCloseBtn.addEventListener('click', closeHistoryPanel);

historyClearBtn.addEventListener('click', () => {
    if (!confirm('Delete ALL saved chats? This cannot be undone.')) { return; }
    vscode.postMessage({ command: 'clearAllSessions' });
    closeHistoryPanel();
});

/**
 * @typedef {{ id: string, title: string, model: string, messageCount: number, updatedAt: number, relativeTime: string }} SessionSummary
 */

/**
 * @param {SessionSummary[]} sessions
 * @param {string | null} currentId
 */
function renderSessionList(sessions, currentId) {
    activeSessionId = currentId;
    historyList.innerHTML = '';

    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.id = 'history-empty';
        empty.innerHTML = '<span style="font-size:24px;opacity:0.4">🕐</span><span>No saved chats yet.<br>Start a conversation to save it here.</span>';
        historyList.appendChild(empty);
        return;
    }

    sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === currentId ? ' active' : '');
        item.dataset.id = s.id;

        const info = document.createElement('div');
        info.className = 'session-info';

        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = s.title;

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.innerHTML =
            `<span>${escHtml(s.relativeTime)}</span>` +
            `<span>${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}</span>` +
            `<span>${escHtml(s.model.split(':')[0])}</span>`;

        info.appendChild(title);
        info.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'session-delete';
        del.title = 'Delete chat';
        del.textContent = '🗑';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'deleteSession', id: s.id });
        });

        item.appendChild(info);
        item.appendChild(del);

        item.addEventListener('click', () => {
            vscode.postMessage({ command: 'loadSession', id: s.id });
            closeHistoryPanel();
        });

        historyList.appendChild(item);
    });
}

// ── Load a stored session into the chat UI ────────────────────────────────────

/**
 * @param {SessionSummary} session
 * @param {Array<{role: string, content: string, timestamp: number}>} messages
 */
function renderStoredSession(session, messages) {
    clearChat();
    activeSessionId = session.id;

    if (!messages.length) { return; }

    messages.forEach((msg) => {
        if (msg.role === 'user') {
            addUserMessage(msg.content, msg.timestamp);
        } else if (msg.role === 'assistant') {
            addStoredAssistantMessage(msg.content, msg.timestamp);
        } else if (msg.role === 'error') {
            addErrorMessage(msg.content);
        }
    });
}

/**
 * Add a completed assistant message (no streaming — render markdown immediately).
 * @param {string} content
 * @param {number} timestamp
 */
function addStoredAssistantMessage(content, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message assistant';
    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : getTimeStr();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent</span>` +
            `<time class="msg-time">${timeStr}</time>` +
            `<div class="msg-actions"><button class="msg-action-btn retry-btn" title="Retry">↺ Retry</button></div>` +
        `</div>` +
        `<div class="msg-content">${renderMarkdown(content)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
}

// ── Update addUserMessage to accept an optional stored timestamp ──────────────
// (override the existing one)
function addUserMessage(text, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message user';
    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : getTimeStr();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">You</span>` +
            `<time class="msg-time">${timeStr}</time>` +
        `</div>` +
        `<div class="msg-content">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    userScrolledUp = false;
    scrollBottom(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

setStatus('checking', 'Connecting…');
// Request models + current editor context
vscode.postMessage({ command: 'getModels' });
vscode.postMessage({ command: 'getContext' });
