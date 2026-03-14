// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl       = /** @type {HTMLDivElement}     */ (document.getElementById('messages'));
const welcomeEl        = /** @type {HTMLDivElement}     */ (document.getElementById('welcome'));
const promptEl         = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
const sendBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('send-btn'));
const stopBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('stop-btn'));
const newChatBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('new-chat-btn'));
const presetSelect     = /** @type {HTMLSelectElement}  */ (document.getElementById('preset-select'));
const modelSelect      = /** @type {HTMLSelectElement}  */ (document.getElementById('model-select'));
const statusDot        = /** @type {HTMLSpanElement}    */ (document.getElementById('status-dot'));
const statusText       = /** @type {HTMLSpanElement}    */ (document.getElementById('status-text'));
const scrollBtn        = /** @type {HTMLButtonElement}  */ (document.getElementById('scroll-btn'));
const contextBar       = /** @type {HTMLDivElement}     */ (document.getElementById('context-bar'));
const historyBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('history-btn'));
const historyPanel     = /** @type {HTMLDivElement}     */ (document.getElementById('history-panel'));
const historyList      = /** @type {HTMLDivElement}     */ (document.getElementById('history-list'));
const historyCloseBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-close-btn'));
const historyClearBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-clear-btn'));
const mentionDropdown  = /** @type {HTMLDivElement}     */ (document.getElementById('mention-dropdown'));
const tokenIndicator   = /** @type {HTMLSpanElement}    */ (document.getElementById('token-indicator'));
const templateBar      = /** @type {HTMLDivElement}     */ (document.getElementById('template-bar'));
const templateSelect   = /** @type {HTMLSelectElement}  */ (document.getElementById('template-select'));
const templateToggleBtn = /** @type {HTMLButtonElement} */ (document.getElementById('template-toggle-btn'));
const smartContextToggle = /** @type {HTMLInputElement} */ (document.getElementById('smart-context-toggle'));
const searchBtn        = /** @type {HTMLButtonElement} */ (document.getElementById('search-btn'));
const searchPanel      = /** @type {HTMLDivElement}    */ (document.getElementById('search-panel'));
const searchInput      = /** @type {HTMLInputElement}  */ (document.getElementById('search-input'));
const searchResults    = /** @type {HTMLSpanElement}   */ (document.getElementById('search-results'));
const searchPrevBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('search-prev'));
const searchNextBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('search-next'));
const searchClearBtn   = /** @type {HTMLButtonElement} */ (document.getElementById('search-clear'));
const contextUsageEl   = /** @type {HTMLSpanElement}   */ (document.getElementById('context-usage'));

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {HTMLDivElement | null} */
let currentMsgEl = null;
/** @type {string} */
let currentRaw = '';
let streaming = false;
/** True when the user has manually scrolled away from the bottom. */
let userScrolledUp = false;

/** Model presets configuration */
const MODEL_PRESETS = {
    fast: { model: 'qwen2.5-coder:1.5b', temperature: 0.5 },
    balanced: { model: 'qwen2.5-coder:7b', temperature: 0.7 },
    quality: { model: 'llama3.1:8b', temperature: 0.8 }
};

/** Current preset selection ('' = custom) */
let currentPreset = 'balanced';

/** Flags to prevent circular preset/model updates */
let updatingFromPreset = false;
let updatingFromModel = false;

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

// ── @mention state ────────────────────────────────────────────────────────────

/** Files the user has explicitly mentioned via @. [{rel, display, ext}] */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionedFiles = [];
let mentionedSymbols = [];
/** Position in textarea where the current @ query started (-1 = not active). */
let mentionAtStart = -1;
/** Current autocomplete query (text after @). */
let mentionQuery = '';
/** Currently highlighted dropdown item index. */
let mentionSelectedIdx = 0;
/** File results from the last searchFiles response. */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionResults = [];

// ── Template state ────────────────────────────────────────────────────────────

/** Available templates (built-in + custom). */
/** @type {Array<{name: string, prompt: string, variables: string[], builtin?: boolean}>} */
let templates = [];
/** Whether template bar is visible. */
let templateBarVisible = false;

// ── Smart context state ────────────────────────────────────────────────────────────

/** Smart context files included in last message. */
/** @type {string[]} */
let smartContextFiles = [];

// ── Search state ──────────────────────────────────────────────────────────────

/** Current search query. */
let searchQuery = '';
/** Array of message elements that match search. */
/** @type {HTMLElement[]} */
let searchMatches = [];
/** Current match index. */
let searchCurrentIndex = -1;

// ── Pin state ─────────────────────────────────────────────────────────────────
let pinnedIds = new Set();
let msgIdCounter = 0;
const pinnedSection = document.getElementById('pinned-section');
const pinnedList = document.getElementById('pinned-list');

// ── Token estimation state ────────────────────────────────────────────────────

/** Approximate context window sizes (tokens) for known model families. */
const MODEL_CONTEXT_WINDOWS = {
    'llama2':           4096,
    'llama3':           8192,
    'llama3.1':         8192,
    'llama3.2':         8192,
    'llama3.3':         8192,
    'qwen2.5':          8192,
    'qwen2.5-coder':   32768,
    'qwen3':           32768,
    'phi3':             4096,
    'phi3.5':           8192,
    'phi4':            16384,
    'codellama':       16384,
    'mistral':          8192,
    'mixtral':         32768,
    'gemma2':           8192,
    'deepseek-coder':  16384,
    'deepseek-r1':     32768,
    'starcoder2':      16384,
    'granite-code':     8192,
};

/** Estimate token count using the 4-chars-per-token heuristic. */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/** Find the approximate context window for the selected model. */
function getContextWindow() {
    const model = modelSelect.value.toLowerCase();
    for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (model.startsWith(prefix)) { return size; }
    }
    return 8192; // safe default
}

/** Update the token indicator in the footer. */
function updateTokenIndicator() {
    if (!tokenIndicator) { return; }
    const promptText = promptEl.value;
    if (!promptText.trim()) {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
        return;
    }

    // Estimate: prompt + any mentioned file content (rough chars / 4)
    let totalChars = promptText.length;
    // Add rough estimate for each mentioned file (we don't have content here,
    // use a conservative 500 tokens per mention as placeholder)
    totalChars += mentionedFiles.length * 2000;
    if (ctx.includeFile && ctx.fileLines) { totalChars += ctx.fileLines * 40; }

    const estimated = estimateTokens(totalChars);
    const window = getContextWindow();
    const pct = estimated / window;

    if (pct >= 0.95) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} / ${window.toLocaleString()} tokens ⚠`;
        tokenIndicator.className = 'over';
    } else if (pct >= 0.75) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = 'warn';
    } else if (estimated > 50) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = '';
    } else {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
    }
}

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
    
    // Apply current preset if it exists and model is available
    if (currentPreset && MODEL_PRESETS[currentPreset]) {
        const config = MODEL_PRESETS[currentPreset];
        if (models.includes(config.model)) {
            modelSelect.value = config.model;
        }
    }
    
    setStatus('connected', `${models.length} model${models.length > 1 ? 's' : ''} available`);
    sendBtn.disabled = false;
    promptEl.focus();
    updateTokenIndicator();
}

// Update token indicator when model changes (context window changes)
modelSelect.addEventListener('change', () => {
    updateTokenIndicator();
    // Skip if this change was triggered by a preset selection
    if (updatingFromPreset) { return; }
    // If user manually changes model, detect matching preset or set Custom
    updatingFromModel = true;
    const preset = findPresetForModel(modelSelect.value);
    if (preset) {
        currentPreset = preset;
        presetSelect.value = preset;
    } else {
        currentPreset = '';
        presetSelect.value = '';
    }
    vscode.postMessage({ command: 'setPreset', preset: currentPreset });
    updatingFromModel = false;
});

// Handle preset selection
presetSelect.addEventListener('change', () => {
    // Skip if this change was triggered by model selection
    if (updatingFromModel) { return; }
    
    const preset = presetSelect.value;
    currentPreset = preset;
    
    if (preset && MODEL_PRESETS[preset]) {
        const config = MODEL_PRESETS[preset];
        // Set flag to prevent modelSelect change handler from firing
        updatingFromPreset = true;
        modelSelect.value = config.model;
        updatingFromPreset = false;
        vscode.postMessage({ 
            command: 'setPreset', 
            preset,
            model: config.model,
            temperature: config.temperature
        });
    } else {
        vscode.postMessage({ command: 'setPreset', preset: '' });
    }
    
    updateTokenIndicator();
});

/** Find preset name for a given model, or null if custom */
function findPresetForModel(model) {
    for (const [name, config] of Object.entries(MODEL_PRESETS)) {
        if (config.model === model) { return name; }
    }
    return null;
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

    // 8. Restore code blocks with optional syntax highlighting
    codeBlocks.forEach(({ lang, code }, i) => {
        let highlighted = escHtml(code);

        // Use highlight.js if available and the language is known
        if (typeof window.hljs !== 'undefined' && lang) {
            try {
                const validLang = window.hljs.getLanguage(lang);
                if (validLang) {
                    highlighted = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                } else {
                    // Try auto-detection as fallback for unknown language tags
                    const auto = window.hljs.highlightAuto(code, ['javascript','typescript','python','rust','go','java','bash','json']);
                    if (auto.relevance > 5) { highlighted = auto.value; }
                }
            } catch { highlighted = escHtml(code); }
        }

        const header = `<div class="code-header">` +
            `<span class="code-lang-label">${escHtml(lang || 'code')}</span>` +
            `<button class="copy-btn" data-copy-idx="${i}">Copy</button>` +
            `</div>`;
        text = text.replace(
            `\x01CB${i}\x01`,
            `<div class="code-block" data-block-idx="${i}">${header}<pre class="hljs">${highlighted}</pre></div>`
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
    memory_list:       '🧠',
    memory_write:      '💡',
    memory_delete:     '🗑️',
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

// ── Pin helpers ──────────────────────────────────────────────────────────────
function assignMsgId(el) {
    const id = 'msg-' + (++msgIdCounter);
    el.dataset.msgId = id;
    return id;
}

function createPinBtn(msgEl) {
    const btn = document.createElement('button');
    btn.className = 'pin-btn';
    btn.title = 'Pin message';
    btn.textContent = '\u{1F4CC}';
    btn.addEventListener('click', () => togglePin(msgEl));
    return btn;
}

function togglePin(msgEl) {
    const id = msgEl.dataset.msgId;
    if (!id) return;
    if (pinnedIds.has(id)) {
        pinnedIds.delete(id);
        msgEl.querySelector('.pin-btn')?.classList.remove('pinned');
    } else {
        pinnedIds.add(id);
        msgEl.querySelector('.pin-btn')?.classList.add('pinned');
    }
    renderPinnedSection();
    vscode.postMessage({ command: 'updatePins', pins: [...pinnedIds] });
}

function renderPinnedSection() {
    pinnedList.innerHTML = '';
    const msgs = messagesEl.querySelectorAll('.message[data-msg-id]');
    let count = 0;
    msgs.forEach(m => {
        if (!pinnedIds.has(m.dataset.msgId)) return;
        count++;
        const clone = m.cloneNode(true);
        clone.querySelectorAll('.pin-btn').forEach(b => b.remove());
        clone.querySelectorAll('.retry-btn').forEach(b => b.remove());
        const unpin = document.createElement('button');
        unpin.className = 'pin-btn pinned';
        unpin.textContent = '\u{1F4CC}';
        unpin.title = 'Unpin';
        const origId = m.dataset.msgId;
        unpin.addEventListener('click', () => {
            pinnedIds.delete(origId);
            m.querySelector('.pin-btn')?.classList.remove('pinned');
            renderPinnedSection();
            vscode.postMessage({ command: 'updatePins', pins: [...pinnedIds] });
        });
        clone.querySelector('.msg-header')?.appendChild(unpin);
        pinnedList.appendChild(clone);
    });
    pinnedSection.classList.toggle('has-pins', count > 0);
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
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
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
    // Remove all message / tool-card children but keep #welcome, #scroll-btn, #pinned-section
    Array.from(messagesEl.childNodes).forEach((node) => {
        const el = /** @type {HTMLElement} */ (node);
        if (el.id === 'scroll-btn') { return; }
        if (el.id === 'welcome') { return; }
        if (el.id === 'pinned-section') { return; }
        el.remove();
    });
    pinnedIds.clear();
    renderPinnedSection();
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

    // @mention pills
    mentionedFiles.forEach((f) => {
        const pill = document.createElement('span');
        pill.className = 'mention-pill';
        pill.title = f.rel;
        pill.innerHTML =
            `${fileIcon(f.ext)} ${escHtml(f.display)}` +
            ` <span class="mention-pill-remove" data-remove-rel="${escHtml(f.rel)}">×</span>`;
        contextBar.appendChild(pill);
    });
}

contextBar.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);

    // Handle @mention pill removal
    if (el.dataset.removeRel) {
        mentionedFiles = mentionedFiles.filter((f) => f.rel !== el.dataset.removeRel);
        updateContextBar();
        updateTokenIndicator();
        return;
    }

    // Handle file/selection toggle
    if (!el.dataset.toggle) { return; }
    if (el.dataset.toggle === 'file') {
        ctx.includeFile = !ctx.includeFile;
        if (ctx.includeFile) { ctx.includeSelection = false; }
    } else if (el.dataset.toggle === 'selection') {
        ctx.includeSelection = !ctx.includeSelection;
        if (ctx.includeSelection) { ctx.includeFile = false; }
    }
    updateContextBar();
    updateTokenIndicator();
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
    const isCreate = action === 'created';
    div.className = `file-toast${isEdit ? ' edited' : ''}${isDelete ? ' deleted' : ''}`;
    const icon = FILE_ACTION_ICONS[action] ?? '📁';
    div.innerHTML = `${icon} <span>${escHtml(action.charAt(0).toUpperCase() + action.slice(1))}: <strong>${escHtml(filePath)}</strong></span>`;
    if (isEdit || isDelete || isCreate) {
        const btn = document.createElement('button');
        btn.className = 'compact-btn';
        btn.textContent = '↩ Undo';
        btn.addEventListener('click', () => {
            vscode.postMessage({ command: 'undoLastTool' });
            btn.disabled = true;
            btn.textContent = 'Undoing…';
        });
        div.appendChild(btn);
    }
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

// ── Context toast notifications ─────────────────────────────────────────────

function addFileToastSimple(icon, text) {
    const div = document.createElement('div');
    div.className = 'file-toast';
    div.innerHTML = `${icon} <span>${escHtml(text)}</span>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}──

/**
 * Show a context warning/compacted/overflow toast in the chat.
 * @param {'warning'|'compacted'|'overflow'} kind
 * @param {string} text
 * @param {boolean} showCompactBtn
 */
function addContextToast(kind, text, showCompactBtn) {
    const icons = { warning: '⚠️', compacted: '📦', overflow: '🔴' };
    const div = document.createElement('div');
    div.className = `context-toast ${kind}`;
    div.innerHTML = `${icons[kind] || '⚠️'} <span>${escHtml(text)}</span>`;
    if (showCompactBtn) {
        const btn = document.createElement('button');
        btn.className = 'compact-btn';
        btn.textContent = 'Compact Now';
        btn.addEventListener('click', () => {
            vscode.postMessage({ command: 'compactContext' });
            btn.disabled = true;
            btn.textContent = 'Compacting…';
        });
        div.appendChild(btn);
    }
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * Update the running context usage indicator in the footer.
 * @param {number} percentage
 */
function updateContextUsage(percentage) {
    if (!contextUsageEl) return;
    if (percentage <= 0) {
        contextUsageEl.textContent = '';
        contextUsageEl.className = '';
        return;
    }
    const pct = Math.round(percentage);
    contextUsageEl.textContent = `${pct}% context`;
    if (percentage >= 99) {
        contextUsageEl.className = 'over';
    } else if (percentage >= 70) {
        contextUsageEl.className = 'critical';
    } else if (percentage >= 50) {
        contextUsageEl.className = 'warn';
    } else {
        contextUsageEl.className = '';
    }
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
    hideMentionDropdown();
    setStreaming(true);

    const filesToSend = mentionedFiles.map((f) => f.rel);
    const symbolsToSend = mentionedSymbols.map((s) => ({ name: s.name, filePath: s.filePath }));
    // Clear mention state after send
    mentionedFiles = [];
    mentionedSymbols = [];
    updateContextBar();
    updateTokenIndicator();

    vscode.postMessage({
        command: 'sendMessage',
        text,
        model: modelSelect.value,
        includeFile: ctx.includeFile,
        includeSelection: ctx.includeSelection,
        mentionedFiles: filesToSend,
        mentionedSymbols: symbolsToSend,
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
promptEl.addEventListener('input', () => { autoResize(); updateTokenIndicator(); });

// ── @mention autocomplete ─────────────────────────────────────────────────────

const EXT_ICONS = {
    ts:'🟦', tsx:'🟦', js:'🟨', jsx:'🟨', py:'🐍', rs:'🦀', go:'🐹',
    java:'☕', kt:'🟪', cs:'🔷', cpp:'⚙️', c:'⚙️', rb:'💎', php:'🐘',
    swift:'🍎', sh:'🖥️', bash:'🖥️', css:'🎨', scss:'🎨', html:'🌐',
    json:'📋', yaml:'📋', yml:'📋', md:'📝', sql:'🗄️', xml:'📄',
    toml:'📄', dockerfile:'🐳', lock:'🔒',
};
function fileIcon(ext) { return EXT_ICONS[ext] || '📄'; }

function showMentionDropdown(results) {
    mentionResults = results;
    mentionSelectedIdx = 0;
    mentionDropdown.innerHTML = '';

    if (!results.length) {
        mentionDropdown.style.display = 'none';
        return;
    }

    results.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'mention-item' + (i === 0 ? ' selected' : '');
        item.dataset.idx = String(i);
        item.innerHTML =
            `<span class="mention-item-icon">${fileIcon(f.ext)}</span>` +
            `<span class="mention-item-base">${escHtml(f.display)}</span>` +
            `<span class="mention-item-rel">${escHtml(f.rel)}</span>`;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // keep textarea focused
            selectMentionItem(i);
        });
        mentionDropdown.appendChild(item);
    });

    mentionDropdown.style.display = 'block';
}

function hideMentionDropdown() {
    mentionDropdown.style.display = 'none';
    mentionAtStart = -1;
    mentionQuery = '';
    mentionResults = [];
}

function selectMentionItem(idx) {
    const file = mentionResults[idx];
    if (!file) { return; }

    // Replace @query in textarea with empty string (the pill takes its place)
    const val = promptEl.value;
    const before = val.slice(0, mentionAtStart);
    const after  = val.slice(mentionAtStart + 1 + mentionQuery.length); // +1 for '@'
    promptEl.value = before + after;
    autoResize();

    // Add to mentioned files (avoid duplicates)
    if (!mentionedFiles.some((f) => f.rel === file.rel)) {
        mentionedFiles.push(file);
        updateContextBar();
    }

    hideMentionDropdown();
    promptEl.focus();
    updateTokenIndicator();
}

function navigateMentionDropdown(direction) {
    if (!mentionResults.length) { return; }
    const items = mentionDropdown.querySelectorAll('.mention-item');
    items[mentionSelectedIdx]?.classList.remove('selected');
    mentionSelectedIdx = (mentionSelectedIdx + direction + mentionResults.length) % mentionResults.length;
    items[mentionSelectedIdx]?.classList.add('selected');
    items[mentionSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

promptEl.addEventListener('input', () => {
    const val = promptEl.value;
    const pos = promptEl.selectionStart ?? val.length;

    // Check if there's an active @ mention being typed
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');

    if (atIdx >= 0) {
        const fragment = before.slice(atIdx + 1);
        // Only trigger if no space in the query (space = @mention ended)
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
            mentionAtStart = atIdx;
            mentionQuery = fragment;
            vscode.postMessage({ command: 'searchFiles', query: fragment });
            return;
        }
    }

    // No active mention
    hideMentionDropdown();
    updateTokenIndicator();
});

promptEl.addEventListener('keydown', (e) => {
    if (mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown')  { e.preventDefault(); navigateMentionDropdown(+1); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); navigateMentionDropdown(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
        if (e.key === 'Escape')     { hideMentionDropdown(); return; }
        if (e.key === 'Tab')        { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
    }
});

// Hint chips (initial welcome screen)
document.querySelectorAll('.hint-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
        const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
        if (hint) { promptEl.value = hint; sendMessage(); }
    });
});

// ── Template handling ────────────────────────────────────────────────────────────

templateToggleBtn.addEventListener('click', () => {
    templateBarVisible = !templateBarVisible;
    templateBar.style.display = templateBarVisible ? 'block' : 'none';
    if (templateBarVisible) {
        vscode.postMessage({ command: 'getTemplates' });
    }
});

templateSelect.addEventListener('change', () => {
    const name = templateSelect.value;
    if (!name) return;
    
    const template = templates.find(t => t.name === name);
    if (!template) return;
    
    // Substitute variables with proper escaping to prevent corruption
    const values = {
        language: ctx.language || 'code',
        filename: ctx.file ? ctx.file.split('/').pop() : 'file',
        selection: ctx.selectionLines > 0 ? '(selected code)' : '(no selection)',
        error: '(error details)'
    };
    
    let prompt = template.prompt;
    // Sort keys by length (longest first) to prevent partial replacements
    // e.g., replace {languageId} before {language}
    const sortedKeys = Object.keys(values).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        const value = values[key];
        prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    
    promptEl.value = prompt;
    autoResize();
    updateTokenIndicator();
    templateSelect.value = ''; // Reset dropdown
    promptEl.focus();
});

function populateTemplates(templateList) {
    templates = templateList;
    templateSelect.innerHTML = '<option value="">Select a template...</option>';
    
    templateList.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.builtin ? `⭐ ${t.name}` : t.name;
        templateSelect.appendChild(opt);
    });
}

// ── Smart context handling ────────────────────────────────────────────────────────────

smartContextToggle.addEventListener('change', () => {
    vscode.postMessage({ 
        command: 'toggleSmartContext', 
        enabled: smartContextToggle.checked 
    });
});

// ── Search handling ──────────────────────────────────────────────────────────────

searchBtn.addEventListener('click', () => {
    const isVisible = searchPanel.style.display !== 'none';
    searchPanel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        searchInput.focus();
    } else {
        clearSearch();
    }
});

searchInput.addEventListener('input', () => {
    performSearch(searchInput.value);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
            navigateSearch(-1);
        } else {
            navigateSearch(1);
        }
    } else if (e.key === 'Escape') {
        clearSearch();
        searchPanel.style.display = 'none';
    }
});

searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
searchNextBtn.addEventListener('click', () => navigateSearch(1));
searchClearBtn.addEventListener('click', () => {
    clearSearch();
    searchPanel.style.display = 'none';
});

function performSearch(query) {
    searchQuery = query.trim().toLowerCase();
    
    // Clear previous highlights efficiently
    const highlights = document.querySelectorAll('.search-highlight');
    highlights.forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent || ''), el);
        }
    });
    // Normalize all text nodes after clearing highlights
    document.querySelectorAll('.msg-content').forEach(content => {
        content.normalize();
    });
    
    searchMatches = [];
    searchCurrentIndex = -1;
    
    if (!searchQuery) {
        // Show all messages
        document.querySelectorAll('.message').forEach(msg => {
            msg.classList.remove('search-hidden');
        });
        searchResults.textContent = '';
        return;
    }
    
    // Search through messages
    const messages = document.querySelectorAll('.message');
    messages.forEach(msg => {
        const content = msg.querySelector('.msg-content');
        if (!content) return;
        
        const text = content.textContent.toLowerCase();
        if (text.includes(searchQuery)) {
            searchMatches.push(msg);
            msg.classList.remove('search-hidden');
            highlightInElement(content, searchQuery);
        } else {
            msg.classList.add('search-hidden');
        }
    });
    
    // Update results counter
    if (searchMatches.length > 0) {
        searchCurrentIndex = 0;
        updateSearchResults();
        scrollToCurrentMatch();
    } else {
        searchResults.textContent = 'No results';
    }
}

function highlightInElement(element, query) {
    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
    );
    
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
        const text = node.textContent.toLowerCase();
        if (text.includes(query)) {
            nodesToReplace.push(node);
        }
    }
    
    nodesToReplace.forEach(node => {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        const fragments = [];
        let lastIndex = 0;
        let index = lowerText.indexOf(query);
        
        while (index !== -1) {
            // Add text before match
            if (index > lastIndex) {
                fragments.push(document.createTextNode(text.substring(lastIndex, index)));
            }
            
            // Add highlighted match
            const span = document.createElement('span');
            span.className = 'search-highlight';
            span.textContent = text.substring(index, index + query.length);
            fragments.push(span);
            
            lastIndex = index + query.length;
            index = lowerText.indexOf(query, lastIndex);
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
            fragments.push(document.createTextNode(text.substring(lastIndex)));
        }
        
        // Replace node with fragments
        const parent = node.parentNode;
        fragments.forEach(frag => parent.insertBefore(frag, node));
        parent.removeChild(node);
    });
}

function navigateSearch(direction) {
    if (searchMatches.length === 0) return;
    
    searchCurrentIndex = (searchCurrentIndex + direction + searchMatches.length) % searchMatches.length;
    updateSearchResults();
    scrollToCurrentMatch();
}

function updateSearchResults() {
    if (searchMatches.length === 0) {
        searchResults.textContent = 'No results';
        return;
    }
    
    searchResults.textContent = `${searchCurrentIndex + 1} of ${searchMatches.length}`;
    
    // Update current highlight
    document.querySelectorAll('.search-highlight.current').forEach(el => {
        el.classList.remove('current');
    });
    
    const currentMsg = searchMatches[searchCurrentIndex];
    const firstHighlight = currentMsg.querySelector('.search-highlight');
    if (firstHighlight) {
        firstHighlight.classList.add('current');
    }
}

function scrollToCurrentMatch() {
    if (searchCurrentIndex < 0 || searchCurrentIndex >= searchMatches.length) return;
    
    const currentMsg = searchMatches[searchCurrentIndex];
    currentMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearSearch() {
    searchInput.value = '';
    searchQuery = '';
    searchMatches = [];
    searchCurrentIndex = -1;
    searchResults.textContent = '';
    
    // Remove all highlights efficiently
    const highlights = document.querySelectorAll('.search-highlight');
    highlights.forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent || ''), el);
        }
    });
    // Normalize all text nodes after clearing highlights
    document.querySelectorAll('.msg-content').forEach(content => {
        content.normalize();
    });
    
    // Show all messages
    document.querySelectorAll('.message').forEach(msg => {
        msg.classList.remove('search-hidden');
    });
}

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
            renderStoredSession(msg.session, msg.messages, msg.pinnedMsgIds);
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
            if (!ctx.file)           { ctx.includeFile = false; }
            if (!ctx.selectionLines) { ctx.includeSelection = false; }
            updateContextBar();
            updateTokenIndicator();
            break;

        case 'fileSearchResults':
            // Only apply if the query matches the current active mention
            if (msg.query === mentionQuery) {
                showMentionDropdown(msg.files ?? []);
            }
            break;

        case 'presetRestored':
            // Restore preset selection from workspace state
            if (msg.preset && MODEL_PRESETS[msg.preset]) {
                currentPreset = msg.preset;
                presetSelect.value = msg.preset;
                const config = MODEL_PRESETS[msg.preset];
                // Update model dropdown if it matches (only if models are loaded)
                const modelExists = Array.from(modelSelect.options).some(opt => opt.value === config.model);
                if (modelExists && (modelSelect.value === config.model || modelSelect.value === '')) {
                    modelSelect.value = config.model;
                } else if (!modelExists) {
                    // Model not available yet - will be set when models load
                    console.log(`[preset] Model ${config.model} not loaded yet, will apply when available`);
                }
            }
            break;

        case 'sendFromCommand':
            // Handle programmatic message send (e.g., from Explain Selection)
            promptEl.value = msg.text;
            ctx.includeFile = msg.includeFile ?? false;
            ctx.includeSelection = msg.includeSelection ?? false;
            updateContextBar();
            sendMessage();
            break;

        case 'templates':
            populateTemplates(msg.templates ?? []);
            break;

        case 'smartContextRestored':
            smartContextToggle.checked = msg.enabled ?? false;
            break;

        case 'smartContextFiles':
            smartContextFiles = msg.files ?? [];
            // Show notification about included files
            if (smartContextFiles.length > 0) {
                const fileList = smartContextFiles.join(', ');
                console.log(`[smart-context] Auto-included: ${fileList}`);
            }
            break;

        case 'contextWarning':
            addContextToast('warning',
                `Context at ${Math.round(msg.percentage)}% — consider starting a new chat or compacting`,
                true);
            updateContextUsage(msg.percentage);
            break;

        case 'contextCompacted':
            addContextToast('compacted',
                `Context auto-compacted: removed ${msg.messagesRemoved} old message${msg.messagesRemoved !== 1 ? 's' : ''}`,
                false);
            updateContextUsage(msg.newPercentage);
            break;

        case 'contextOverflow':
            addContextToast('overflow',
                `Context at ${Math.round(msg.percentage)}% — responses may be truncated`,
                true);
            updateContextUsage(msg.percentage);
            break;

        case 'contextStats':
            updateContextUsage(msg.percentage);
            break;

        case 'undoResult':
            addFileToastSimple(msg.success ? '↩️' : '⚠️', msg.message);
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
function renderStoredSession(session, messages, savedPins) {
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

    // Restore pinned messages
    if (savedPins && savedPins.length) {
        pinnedIds = new Set(savedPins);
        messagesEl.querySelectorAll('.message[data-msg-id]').forEach(m => {
            if (pinnedIds.has(m.dataset.msgId)) {
                m.querySelector('.pin-btn')?.classList.add('pinned');
            }
        });
        renderPinnedSection();
    }
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
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
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
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
    userScrolledUp = false;
    scrollBottom(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

setStatus('checking', 'Connecting…');
// Request models + current editor context
vscode.postMessage({ command: 'getModels' });
vscode.postMessage({ command: 'getContext' });
