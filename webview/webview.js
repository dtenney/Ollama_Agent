// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── Debug: catch and report any JS errors back to the extension ───────────────
window.onerror = function(msg, src, line, col, err) {
    const detail = `[webview error] ${msg} at line ${line}:${col}\n${err?.stack || ''}`;
    try { vscode.postMessage({ command: 'webviewError', text: detail }); } catch(_) {}
    const el = document.getElementById('status-text');
    if (el) { el.textContent = 'JS Error — check Output panel'; el.style.color = '#f44747'; }
    console.error(detail);
};
window.onunhandledrejection = function(event) {
    const reason = event.reason;
    const detail = `[webview unhandled rejection] ${reason?.message || reason}\n${reason?.stack || ''}`;
    try { vscode.postMessage({ command: 'webviewError', text: detail }); } catch(_) {}
    console.error(detail);
};

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
const compactBtnFooter = /** @type {HTMLButtonElement}  */ (document.getElementById('compact-btn-footer'));
const settingsBtn      = /** @type {HTMLButtonElement}  */ (document.getElementById('settings-btn'));

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {HTMLDivElement | null} */
let currentMsgEl = null;
/** @type {string} */
let currentRaw = '';
let streaming = false;
/** True when the user has manually scrolled away from the bottom. */
let userScrolledUp = false;
/** Tracks whether we're currently inside a thinking block while streaming. */
let inThinkingBlock = false;
let thinkingBuf = '';

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

/** When true, next mention selection pins the file instead of @mentioning it */
let pinModeActive = false;

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

/** @type {Array<{rel: string, display: string, ext: string}>} Pinned files (always-in-context) */
let pinnedFiles = [];

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
    totalChars += pinnedFiles.length * 2000;
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
/** @type {string} Configured default model from settings */
let defaultModel = '';

function populateModels(models, connected, configuredModel) {
    modelSelect.innerHTML = '';
    if (configuredModel) { defaultModel = configuredModel; }
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
    
    // Apply default model from settings if available
    if (defaultModel && models.includes(defaultModel)) {
        modelSelect.value = defaultModel;
        // If settings model doesn't match the active preset, switch to custom
        if (currentPreset && MODEL_PRESETS[currentPreset] && MODEL_PRESETS[currentPreset].model !== defaultModel) {
            currentPreset = '';
            presetSelect.value = '';
        }
    } else if (currentPreset && MODEL_PRESETS[currentPreset]) {
        // Only apply preset when settings didn't specify a different model
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
    // 0. Collapse double-newlines between short lines (list items, file names, etc.)
    //    Keeps \n\n between prose paragraphs (lines > 80 chars) intact.
    const parts = text.split('\n\n');
    if (parts.length > 1) {
        let collapsed = parts[0];
        for (let i = 1; i < parts.length; i++) {
            const prev = (i === 1 ? parts[0] : parts[i - 1]);
            const prevLastLine = prev.split('\n').pop() || '';
            const nextFirstLine = parts[i].split('\n')[0] || '';
            // If both surrounding lines are short, collapse to single newline
            if (prevLastLine.length < 80 && nextFirstLine.length < 80
                && prevLastLine.trim() && nextFirstLine.trim()) {
                collapsed += '\n' + parts[i];
            } else {
                collapsed += '\n\n' + parts[i];
            }
        }
        text = collapsed;
    }

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

    // 4b. Collapse blank lines between consecutive list items
    text = text.replace(/^(\s*[-*\d].*)\n\n(?=\s*[-*\d])/gm, '$1\n');

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
            `<div style="display:flex;gap:6px;">` +
            `<button class="apply-btn" data-apply-idx="${i}">Apply</button>` +
            `<button class="copy-btn" data-copy-idx="${i}">Copy</button>` +
            `</div>` +
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

    // Copy button
    if (btn.classList.contains('copy-btn')) {
        const block = btn.closest('.code-block');
        if (!block) { return; }
        const pre = block.querySelector('pre');
        if (!pre) { return; }
        navigator.clipboard?.writeText(pre.textContent ?? '').then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => (btn.textContent = 'Copy'), 1500);
        }).catch(() => {
            btn.textContent = 'Copy';
        });
        return;
    }

    // Apply button
    if (btn.classList.contains('apply-btn')) {
        const block = btn.closest('.code-block');
        if (!block) { return; }
        const pre = block.querySelector('pre');
        if (!pre) { return; }
        const lang = block.querySelector('.code-lang-label')?.textContent ?? '';
        vscode.postMessage({ command: 'applyCodeBlock', code: pre.textContent ?? '', lang });
        btn.textContent = 'Applying…';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = 'Apply'; btn.disabled = false; }, 2000);
        return;
    }
});

// ── Scroll helpers ────────────────────────────────────────────────────────────

/** Whether the agent loop is actively running (broader than streaming — covers tool execution gaps) */
let agentActive = false;

function scrollBottom(force = false) {
    if (force || (!userScrolledUp && (streaming || agentActive))) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
}

messagesEl.addEventListener('scroll', () => {
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    userScrolledUp = distFromBottom > 60;
    scrollBtn.classList.toggle('visible', userScrolledUp && (streaming || agentActive));
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
    find_files:        '🔎',
    search_files:      '🔍',
    create_file:       '🆕',
    edit_file:         '✏️',
    write_file:        '💾',
    append_to_file:    '📝',
    rename_file:       '🔄',
    delete_file:       '🗑️',
    shell_read:        '🐚',
    run_command:       '⚡',
    memory_search:     '🧠',
    memory_list:       '🧠',
    memory_write:      '💾',
    memory_tier_write: '💾',
    memory_delete:     '🗑️',
    get_diagnostics:   '💡',
    read_terminal:     '🖥️',
    web_search:        '🌐',
    web_fetch:         '🌍',
};

// ── Time helper ───────────────────────────────────────────────────────────────

function getTimeStr() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Format a timestamp as relative time ("just now", "2m ago", "1h ago", "yesterday"). */
function relativeTimeStr(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 172_800_000) return 'yesterday';
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Update relative timestamps every 60s
setInterval(() => {
    document.querySelectorAll('time.msg-time[data-ts]').forEach(el => {
        el.textContent = relativeTimeStr(Number(el.dataset.ts));
    });
}, 60_000);

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
    const now = Date.now();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent <span class="dots"><span></span><span></span><span></span></span></span>` +
            `<time class="msg-time" data-ts="${now}" title="${new Date(now).toLocaleString()}">${relativeTimeStr(now)}</time>` +
        `</div>` +
        `<div class="msg-content"></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
    currentMsgEl = div;
    currentRaw = '';
    inThinkingBlock = false;
    thinkingBuf = '';
    scrollBottom();
    return div;
}

/** @param {string} token */
function appendToken(token) {
    if (!currentMsgEl) { return; }

    // Handle thinking sentinels
    if (token === '\x01THINK_START\x01') {
        inThinkingBlock = true;
        thinkingBuf = '';
        // Create collapsible thinking block in the message
        const content = currentMsgEl.querySelector('.msg-content');
        if (content && !currentMsgEl.querySelector('.thinking-block')) {
            const details = document.createElement('details');
            details.className = 'thinking-block';
            const summary = document.createElement('summary');
            summary.textContent = '💭 Thinking…';
            const pre = document.createElement('pre');
            pre.className = 'thinking-content';
            pre.style.cssText = 'font-size:0.78em;opacity:0.6;white-space:pre-wrap;margin:4px 0 0;';
            details.appendChild(summary);
            details.appendChild(pre);
            content.before(details);
        }
        return;
    }
    if (token === '\x01THINK_END\x01') {
        inThinkingBlock = false;
        // Update summary to show it's done
        const details = currentMsgEl?.querySelector('.thinking-block');
        if (details) {
            const summary = details.querySelector('summary');
            if (summary) { summary.textContent = '💭 Thought process'; }
        }
        scrollBottom();
        return;
    }
    if (inThinkingBlock) {
        thinkingBuf += token;
        const pre = currentMsgEl?.querySelector('.thinking-content');
        if (pre) { pre.textContent = thinkingBuf; scrollBottom(); }
        return;
    }

    currentRaw += token;
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) {
        // During streaming: strip complete <tool>...</tool> blocks, then hide any
        // in-progress (unclosed) tool block at the tail so partial JSON doesn't show.
        let display = stripToolBlocksClient(currentRaw);
        // If an unclosed <tool> is still open at the end, hide everything from it onward
        const openIdx = display.toLowerCase().lastIndexOf('<tool>');
        if (openIdx !== -1) {
            display = display.slice(0, openIdx);
        }
        content.textContent = display.trim();
        scrollBottom();
    }
}

/** Strip <tool>...</tool> blocks and raw JSON tool calls from text (client-side).
 *  Uses brace-counting to handle nested JSON (e.g. {"arguments":{}}).
 */
function stripToolBlocksClient(text) {
    let result = text;

    // Remove <tool>{...}</tool> using brace counting for nested JSON
    let pos = 0;
    while (pos < result.length) {
        const idx = result.toLowerCase().indexOf('<tool>', pos);
        if (idx === -1) break;
        // Find the balanced closing brace
        let depth = 0, jsonStart = -1, jsonEnd = -1;
        for (let i = idx + 6; i < result.length; i++) {
            if (result[i] === '{') { if (depth === 0) jsonStart = i; depth++; }
            else if (result[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd === -1) { // unclosed — strip from <tool> to end
            result = result.slice(0, idx);
            break;
        }
        // Find optional </tool> after the JSON
        let endPos = jsonEnd;
        const afterJson = result.slice(jsonEnd).match(/^\s*<\/tool>/i);
        if (afterJson) endPos = jsonEnd + afterJson[0].length;
        result = result.slice(0, idx) + result.slice(endPos);
        pos = idx; // re-scan from same position
    }

    // Remove orphaned </tool> tags
    result = result.replace(/<\/tool>/gi, '');
    // Remove markdown code blocks containing tool calls
    result = result.replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\n?```/gi, '');
    // Remove [TOOL RESULT: ...] blocks injected as context
    result = result.replace(/\[TOOL RESULT:.*?\][\s\S]*?\[END TOOL RESULT\]/g, '');
    // Remove [wait for result] hints
    result = result.replace(/\[wait for result[^\]]*\]/gi, '');
    // Collapse excessive newlines — double newlines become single
    return result.replace(/\n{2,}/g, '\n').trim();
}

function finalizeMessage() {
    if (!currentMsgEl) { return; }

    // Remove loading dots from role label
    const roleEl = currentMsgEl.querySelector('.msg-role');
    if (roleEl) { roleEl.innerHTML = 'Agent'; }

    // Strip tool blocks before rendering (text-mode tool calls leak into streamed content)
    const cleanRaw = stripToolBlocksClient(currentRaw);

    // Render full markdown
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) { content.innerHTML = renderMarkdown(cleanRaw); }

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
    let argsStr;
    if (name === 'memory_search') {
        argsStr = `query="${args.query ?? ''}"`;
    } else if (name === 'memory_tier_write' || name === 'memory_write') {
        const tier = args.tier !== undefined ? `Tier ${args.tier} — ` : '';
        const content = String(args.content ?? '').slice(0, 60);
        argsStr = `${tier}"${content}${content.length >= 60 ? '…' : ''}"`;
    } else if (name === 'web_search') {
        argsStr = `"${String(args.query ?? '').slice(0, 80)}"`;
    } else if (name === 'web_fetch') {
        argsStr = String(args.url ?? '').slice(0, 80);
    } else {
        argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(' ');
    }
    const div = document.createElement('div');
    div.className = 'tool-card';
    div.id = `tool-${id}`;
    div.innerHTML =
        `<div class="tool-header" title="Click to expand/collapse">` +
            `<div class="tool-icon">${icon}</div>` +
            `<div class="tool-info">` +
                `<div class="tool-name">${escHtml(name)}</div>` +
                `<div class="tool-args">${escHtml(argsStr)}</div>` +
            `</div>` +
            `<div class="dots"><span></span><span></span><span></span></div>` +
        `</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * @param {string} id
 * @param {boolean} success
 * @param {string} preview
 */
function updateToolCard(id, success, preview, fullResult) {
    const card = document.getElementById(`tool-${id}`);
    if (!card) { return; }
    card.classList.add(success ? 'success' : 'error');
    const dots = card.querySelector('.dots');
    if (dots) { dots.remove(); }

    // Build summary line for collapsed view
    const toolName = card.querySelector('.tool-name')?.textContent || '';
    const output = fullResult || preview;
    let summary = success ? '✓' : '✗';
    if (output) {
        const lines = output.split('\n').filter(l => l.trim());
        if (toolName === 'read_file') {
            summary += ` ${lines.length} lines`;
        } else if (toolName === 'search_files') {
            const m = output.match(/(\d+)\)/);
            summary += m ? ` ${m[1]} matches` : ` ${lines.length} lines`;
        } else if (toolName === 'list_files') {
            summary += ` ${lines.length} entries`;
        } else if (toolName === 'memory_search') {
            const foundM = output.match(/\((\d+) found\)/);
            const queryM = output.match(/for "([^"]{1,40})"/);
            if (!success || output.includes('No relevant memories')) {
                summary += ` no memories found`;
            } else if (foundM && queryM) {
                summary += ` ${foundM[1]} memories — "${queryM[1]}"`;
            } else {
                summary += ` ${lines.length} results`;
            }
        } else if (toolName === 'memory_tier_write' || toolName === 'memory_write') {
            const tierM = output.match(/Tier (\d+)/);
            const snip = output.replace(/Note saved.*?\./i, '').trim().slice(0, 50);
            summary += tierM ? ` saved to Tier ${tierM[1]}` : ` saved`;
            if (snip) { summary += ` — ${snip}`; }
        } else if (toolName === 'web_search') {
            const countM = output.match(/(\d+) results?/i);
            if (!success || output.startsWith('(web_search unavailable')) {
                summary += ` unavailable`;
            } else if (countM) {
                summary += ` ${countM[1]} results`;
            } else {
                summary += ` ${lines.length} lines`;
            }
        } else if (toolName === 'web_fetch') {
            if (!success) {
                summary += ` failed`;
            } else {
                const chars = output.length;
                summary += ` ${chars > 1000 ? Math.round(chars / 1000) + 'k' : chars} chars`;
            }
        } else {
            summary += ` ${lines.length} lines`;
        }
    }

    // Add summary badge
    const header = card.querySelector('.tool-header');
    if (header) {
        const badge = document.createElement('span');
        badge.className = 'tool-summary';
        badge.textContent = summary;
        header.appendChild(badge);
    }

    // Add collapsible output body (collapsed by default)
    if (output) {
        const body = document.createElement('div');
        body.className = 'tool-body collapsed';
        const outputDiv = document.createElement('div');
        outputDiv.className = 'tool-output';
        outputDiv.textContent = output;
        body.appendChild(outputDiv);
        card.appendChild(body);

        // Toggle collapse on header click
        if (header) {
            header.style.cursor = 'pointer';
            header.addEventListener('click', () => {
                body.classList.toggle('collapsed');
                card.classList.toggle('expanded');
            });
        }
    }
    scrollBottom();
}

/** @param {string} text */
/** Map raw error strings to user-friendly messages with actions. */
function friendlyErrorMsg(raw) {
    if (/ECONNREFUSED|connect ECONNREFUSED/i.test(raw))
        return '🔌 Ollama isn\'t running. Start it with: <code class="inline">ollama serve</code>';
    if (/timed out/i.test(raw))
        return '⏱ Request timed out. The model may still be loading — try again in a moment.';
    if (/model.*not found|404/i.test(raw))
        return '📦 Model not found. Install it with: <code class="inline">ollama pull &lt;model-name&gt;</code>';
    if (/context length|too long/i.test(raw))
        return '📏 Message exceeds the model\'s context window. Try compacting the conversation or starting a new chat.';
    if (/does not support tools/i.test(raw))
        return '⚙️ This model doesn\'t support native tool calling — text-mode will be used automatically.';
    return `⚠ ${escHtml(raw)}`;
}

function addOpenClawPending(taskId, query) {
    finalizeMessage();
    const div = document.createElement('div');
    div.className = 'message openclaw-card';
    div.dataset.taskId = taskId;
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role" style="color:var(--vscode-terminal-ansiCyan,#5af)">⚙ OpenCLAW</span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="openclaw-query">${escHtml(query)}</div>` +
        `<div class="openclaw-status">` +
            `<span class="openclaw-spinner">◌</span> Working — you can keep coding…` +
        `</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    // Spin the spinner
    const spinner = div.querySelector('.openclaw-spinner');
    const frames = ['◌','◎','●','◎'];
    let fi = 0;
    const interval = setInterval(() => {
        if (!div.isConnected) { clearInterval(interval); return; }
        if (!div.querySelector('.openclaw-spinner')) { clearInterval(interval); return; }
        spinner.textContent = frames[fi++ % frames.length];
    }, 300);
    div._spinnerInterval = interval;
    scrollBottom(true);
}

function resolveOpenClawCard(taskId, content, error, durationMs) {
    const div = messagesEl.querySelector(`.openclaw-card[data-task-id="${CSS.escape(taskId)}"]`);
    if (!div) { return; }
    if (div._spinnerInterval) { clearInterval(div._spinnerInterval); }
    const secs = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
    const statusEl = div.querySelector('.openclaw-status');
    if (error) {
        if (statusEl) { statusEl.innerHTML = `<span style="color:var(--vscode-errorForeground,#f48771)">✗ Failed: ${escHtml(error)}</span>`; }
    } else {
        if (statusEl) { statusEl.innerHTML = `<span style="opacity:0.6">✓ Done${secs ? ` in ${secs}` : ''}</span>`; }
        const resultEl = document.createElement('div');
        resultEl.className = 'msg-content openclaw-result';
        resultEl.innerHTML = renderMarkdown(content ?? '');
        div.appendChild(resultEl);
        if (typeof hljs !== 'undefined') {
            resultEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        }
    }
    scrollBottom(true);
}

function addErrorMessage(text) {
    finalizeMessage();
    const div = document.createElement('div');
    div.className = 'message error-msg';
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role" style="color:var(--vscode-errorForeground,#f48771);opacity:0.9">Error</span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="msg-content" style="color:var(--vscode-errorForeground,#f48771)">${friendlyErrorMsg(text)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

function addReasoningCard(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const card = document.createElement('div');
    card.className = 'reasoning-card';
    const warnings = msg.warnings && msg.warnings.length > 0
        ? `<div class="rc-warnings">${msg.warnings.map(w => `<span class="rc-warn">⚠ ${escHtml(w)}</span>`).join('')}</div>`
        : '';
    card.innerHTML = `
        <div class="rc-header" onclick="this.parentElement.classList.toggle('rc-open')">
            <span class="rc-icon">🔍</span>
            <span class="rc-title">Research: <code>${escHtml(msg.targetFile)}</code></span>
            <span class="rc-toggle">▸</span>
        </div>
        <div class="rc-body">
            <div class="rc-row"><span class="rc-label">Routes found</span><span class="rc-value">${msg.routes ? msg.routes.length : 0}</span></div>
            <div class="rc-row"><span class="rc-label">Functions found</span><span class="rc-value">${msg.functions ? msg.functions.length : 0}</span></div>
            <div class="rc-row"><span class="rc-label">Models available</span><span class="rc-value">${msg.modelCount || 0}</span></div>
            <div class="rc-row"><span class="rc-label">Pattern found</span><span class="rc-value">${msg.hasPattern ? '✓' : '—'}</span></div>
            <div class="rc-row"><span class="rc-label">Task type</span><span class="rc-value">${msg.isSweep ? 'sweep' : 'single edit'}</span></div>
            ${warnings}
        </div>`;
    container.appendChild(card);
    scrollBottom();
}

function addPlanCard(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const card = document.createElement('div');
    card.className = 'plan-card';
    const rows = (msg.plan || []).map(p =>
        `<div class="pc-row">
            <span class="pc-action ${p.action}">${p.action === 'create' ? '✚' : '~'}</span>
            <code class="pc-path">${escHtml(p.relPath)}</code>
            <span class="pc-desc">${escHtml(p.description)}</span>
        </div>`
    ).join('');
    card.innerHTML = `
        <div class="pc-header"><span class="pc-icon">📋</span><span class="pc-title">Multi-file plan</span></div>
        <div class="pc-body">${rows}</div>`;
    container.appendChild(card);
    scrollBottom();
}

function addPlanProgress(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const step = msg.step || {};
    const remaining = msg.remaining ?? 0;
    const el = document.createElement('div');
    el.className = 'plan-progress';
    el.innerHTML = `<span class="pp-icon">${step.action === 'create' ? '✚' : '~'}</span>` +
        `<code class="pp-path">${escHtml(step.relPath || '')}</code>` +
        `<span class="pp-desc">${escHtml(step.description || '')}</span>` +
        (remaining > 0 ? `<span class="pp-remaining">(${remaining} more)</span>` : '');
    container.appendChild(el);
    scrollBottom();
}

function addPlanComplete() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'plan-complete';
    el.textContent = '✓ Multi-file plan complete';
    container.appendChild(el);
    scrollBottom();
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
    updateContextUsage(0, 0, 0);
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

    // Pinned file pills
    pinnedFiles.forEach((f) => {
        const pill = document.createElement('span');
        pill.className = 'pinned-file-pill';
        pill.title = `📌 ${f.rel} (always included)`;
        pill.innerHTML =
            `📌 ${escHtml(f.display)}` +
            ` <span class="pinned-file-remove" data-unpin-rel="${escHtml(f.rel)}">×</span>`;
        contextBar.appendChild(pill);
    });

    // Pin file button
    const pinBtn = document.createElement('button');
    pinBtn.id = 'pin-file-btn';
    pinBtn.title = 'Pin a file (always include in context)';
    pinBtn.textContent = '📌+';
    contextBar.appendChild(pinBtn);
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

    // Handle pinned file removal
    if (el.dataset.unpinRel) {
        pinnedFiles = pinnedFiles.filter((f) => f.rel !== el.dataset.unpinRel);
        vscode.postMessage({ command: 'updatePinnedFiles', files: pinnedFiles.map(f => f.rel) });
        updateContextBar();
        updateTokenIndicator();
        return;
    }

    // Handle pin-file button — trigger file search in pin mode
    if (el.id === 'pin-file-btn') {
        pinModeActive = true;
        // Preserve existing input text; append @ at cursor position
        const cursorPos = promptEl.selectionStart ?? promptEl.value.length;
        const before = promptEl.value.slice(0, cursorPos);
        const after = promptEl.value.slice(cursorPos);
        promptEl.value = before + '@' + after;
        promptEl.focus();
        promptEl.selectionStart = promptEl.selectionEnd = cursorPos + 1;
        mentionAtStart = cursorPos;
        mentionQuery = '';
        vscode.postMessage({ command: 'searchFiles', query: '' });
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
}

/**
 * Show an inline confirmation card with Accept/Reject buttons.
 * @param {string} id   Unique confirmation ID
 * @param {string} action  Action type: 'run', 'write', 'rename', 'delete'
 * @param {string} detail  Human-readable description
 */
function addConfirmCard(id, action, detail, toolName) {
    const icons = { run: '⚡', write: '💾', rename: '🔄', delete: '🗑️', edit: '✏️' };
    const icon = icons[action] || '❓';
    const pendingBar = document.getElementById('pending-confirm-bar');

    function makeCard(forBar) {
        const div = document.createElement('div');
        div.className = 'confirm-card';
        if (!forBar) div.id = `confirm-${id}`;
        div.innerHTML =
            `<div class="confirm-header">` +
                `<span class="confirm-icon">${icon}</span>` +
                `<span class="confirm-detail">${escHtml(detail)}</span>` +
            `</div>` +
            `<div class="confirm-actions">` +
                `<button class="confirm-btn accept">Accept</button>` +
                `<button class="confirm-btn accept-all" title="Accept this and all future ${escHtml(toolName || action)} calls">Accept All</button>` +
                `<button class="confirm-btn reject">Reject</button>` +
            `</div>`;
        return div;
    }

    // Card in chat history (scrolls with messages)
    const historyCard = makeCard(false);
    // Card pinned in sticky bar (always visible above input)
    const stickyCard = makeCard(true);

    let resolved = false;
    let cardObserver = null;

    function resolveAll(accepted, label) {
        if (resolved) return;
        resolved = true;
        if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
        // Update history card
        historyCard.classList.add(accepted ? 'accepted' : 'rejected');
        historyCard.querySelector('.confirm-actions').innerHTML = `<span class="confirm-resolved">${label}</span>`;
        // Clear sticky bar
        if (pendingBar) {
            pendingBar.style.display = 'none';
            pendingBar.innerHTML = '';
        }
    }

    function wireButtons(card) {
        card.querySelector('.confirm-btn.accept').addEventListener('click', () => {
            if (resolved) return;
            vscode.postMessage({ command: 'confirmResponse', id, accepted: true });
            resolveAll(true, '✅ Accepted');
        });
        card.querySelector('.confirm-btn.accept-all').addEventListener('click', () => {
            if (resolved) return;
            vscode.postMessage({ command: 'confirmResponseAll', id, toolName: toolName || action });
            resolveAll(true, '✅ Accepted All ' + escHtml(toolName || action));
        });
        card.querySelector('.confirm-btn.reject').addEventListener('click', () => {
            if (resolved) return;
            vscode.postMessage({ command: 'confirmResponse', id, accepted: false });
            resolveAll(false, '❌ Rejected');
        });
    }

    wireButtons(historyCard);
    wireButtons(stickyCard);

    messagesEl.insertBefore(historyCard, scrollBtn);

    // Show sticky bar only when history card is scrolled out of view
    if (pendingBar) {
        pendingBar.innerHTML = '';
        pendingBar.appendChild(stickyCard);
        // Start hidden — IntersectionObserver will show it if card scrolls out of view
        pendingBar.style.display = 'none';

        cardObserver = new IntersectionObserver((entries) => {
            if (resolved) { cardObserver.disconnect(); cardObserver = null; return; }
            const visible = entries[0].isIntersecting;
            pendingBar.style.display = visible ? 'none' : 'block';
        }, { threshold: 0.1 });
        cardObserver.observe(historyCard);
    }

    scrollBottom();
}

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

/** @type {HTMLDivElement | null} */
const ctxProgressBar = /** @type {HTMLDivElement | null} */ (document.getElementById('ctx-progress-bar'));
const ctxProgressWrap = /** @type {HTMLDivElement | null} */ (document.getElementById('ctx-progress-wrap'));

/**
 * Update the running context usage indicator in the footer and progress bar.
 * @param {number} percentage
 * @param {number} [usedTokens]
 * @param {number} [totalTokens]
 */
function updateContextUsage(percentage, usedTokens, totalTokens) {
    if (!contextUsageEl) return;

    // Update slim progress bar
    if (ctxProgressBar) {
        const clamped = Math.min(100, Math.max(0, percentage));
        ctxProgressBar.style.width = `${clamped}%`;
        ctxProgressBar.className = percentage >= 99 ? 'over'
            : percentage >= 85 ? 'critical'
            : percentage >= 60 ? 'warn'
            : '';
    }
    if (ctxProgressWrap) {
        ctxProgressWrap.title = totalTokens
            ? `Context: ${Math.round(percentage)}% used (~${(usedTokens || 0).toLocaleString()} / ${totalTokens.toLocaleString()} tokens)`
            : `Context: ${Math.round(percentage)}% used`;
    }

    if (percentage <= 0) {
        contextUsageEl.textContent = '';
        contextUsageEl.className = '';
        if (compactBtnFooter) compactBtnFooter.classList.remove('visible');
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
    // Show compact button whenever context usage is visible
    if (compactBtnFooter) compactBtnFooter.classList.toggle('visible', pct > 0);
}

// ── Footer compact button ─────────────────────────────────────────────────────
if (compactBtnFooter) {
    compactBtnFooter.addEventListener('click', () => {
        vscode.postMessage({ command: 'compactContext' });
        compactBtnFooter.textContent = 'Compacting…';
        compactBtnFooter.disabled = true;
    });
}

// ── Settings button ───────────────────────────────────────────────────────────
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'openSettings' });
    });
}

// ── Mode-switch notice (native → text-mode tool calling) ─────────────────────

/** @param {string} model */
function addModeNotice(model) {
    const div = document.createElement('div');
    div.className = 'file-toast';
    div.style.cssText = 'background:rgba(229,192,123,0.08);border-color:rgba(229,192,123,0.35);color:#e5c07b;';
    div.innerHTML =
        `⚙️ <span><strong>${escHtml(model)}</strong> uses text-mode tool calling — ` +
        `remembered for future sessions.</span>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

// ── Send logic ────────────────────────────────────────────────────────────────

/** @param {boolean} on */
function setStreaming(on) {
    streaming = on;
    if (on) { agentActive = true; }
    sendBtn.disabled = on || modelSelect.value === '';
    stopBtn.classList.toggle('visible', on || agentActive);
    scrollBtn.classList.toggle('visible', (on || agentActive) && userScrolledUp);
    if (!on && !agentActive) {
        promptEl.focus();
        scrollBtn.classList.remove('visible');
    }
}

function sendMessage() {
    const text = promptEl.value.trim();
    if (!text || streaming) { return; }

    pushInputHistory(text);
    addUserMessage(text);
    promptEl.value = '';
    autoResize();
    hideMentionDropdown();
    setStreaming(true);
    // Show a waiting bubble immediately so there's no silent gap before streamStart
    startAssistantMessage();

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
        pinnedFiles: pinnedFiles.map(f => f.rel),
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

// ── Global keyboard shortcuts ─────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Ctrl+/ — focus the input textarea from anywhere in the panel
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        promptEl.focus();
        promptEl.select();
        return;
    }
    // Escape — stop generation when streaming
    if (e.key === 'Escape' && (streaming || agentActive) && document.activeElement !== promptEl) {
        e.preventDefault();
        vscode.postMessage({ command: 'stopGeneration' });
        setStreaming(false);
        return;
    }
    // Ctrl+K — clear chat (only when not streaming)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !streaming && !agentActive) {
        e.preventDefault();
        vscode.postMessage({ command: 'newChat' });
        clearChat();
        return;
    }
});

// Auto-resize textarea
function autoResize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
}
promptEl.addEventListener('input', () => { autoResize(); updateTokenIndicator(); });

// ── Chat input history (↑/↓ arrow) ───────────────────────────────────────────

/** @type {string[]} */
const inputHistory = [];
let inputHistoryIdx = -1;
let inputHistoryDraft = '';
const MAX_INPUT_HISTORY = 50;

function pushInputHistory(text) {
    if (!text.trim()) { return; }
    // Deduplicate last entry
    if (inputHistory.length && inputHistory[inputHistory.length - 1] === text) { return; }
    inputHistory.push(text);
    if (inputHistory.length > MAX_INPUT_HISTORY) { inputHistory.shift(); }
    inputHistoryIdx = -1;
}

promptEl.addEventListener('keydown', (e) => {
    // Only activate when mention dropdown is hidden
    if (mentionDropdown.style.display !== 'none') { return; }
    if (e.key === 'ArrowUp' && inputHistory.length && inputHistoryIdx !== 0) {
        // Only hijack ArrowUp when navigating history (idx >= 0) or input is empty
        if (inputHistoryIdx === -1 && promptEl.value !== '') { return; }
        e.preventDefault();
        if (inputHistoryIdx === -1) { inputHistoryDraft = promptEl.value; inputHistoryIdx = inputHistory.length; }
        if (inputHistoryIdx > 0) {
            inputHistoryIdx--;
            promptEl.value = inputHistory[inputHistoryIdx];
            autoResize();
        }
        return;
    }
    if (e.key === 'ArrowDown' && inputHistoryIdx >= 0) {
        e.preventDefault();
        inputHistoryIdx++;
        if (inputHistoryIdx >= inputHistory.length) {
            inputHistoryIdx = -1;
            promptEl.value = inputHistoryDraft;
        } else {
            promptEl.value = inputHistory[inputHistoryIdx];
        }
        autoResize();
        return;
    }
});

// ── Slash commands ─────────────────────────────────────────────────────────

const SLASH_COMMANDS = {
    '/test':     { label: '/test',     desc: 'Generate tests for selection or file',   prompt: 'Write comprehensive tests for the following code. Use the project\'s existing test framework.\n\n' },
    '/fix':      { label: '/fix',      desc: 'Fix errors in selection or file',         prompt: 'Find and fix all bugs and errors in the following code. Explain each fix.\n\n' },
    '/review':   { label: '/review',   desc: 'Code review with suggestions',            prompt: 'Review the following code for bugs, security issues, performance problems, and style. Provide specific suggestions.\n\n' },
    '/doc':      { label: '/doc',      desc: 'Add documentation / comments',            prompt: 'Add clear, concise documentation comments to the following code. Use the language\'s standard doc format.\n\n' },
    '/explain':  { label: '/explain',  desc: 'Explain how this code works',             prompt: 'Explain the following code step by step in plain language.\n\n' },
    '/refactor': { label: '/refactor', desc: 'Refactor for clarity and maintainability', prompt: 'Refactor the following code to improve readability, maintainability, and performance. Show the changes.\n\n' },
    '/optimize': { label: '/optimize', desc: 'Optimize for performance',                prompt: 'Optimize the following code for performance. Explain the improvements.\n\n' },
    '/openclaw': { label: '/openclaw', desc: 'Dispatch a background task to OpenCLAW',  prompt: null },
    '/context':  { label: '/context',  desc: 'Generate or update AGENTS.md project context file', prompt: 'Scan this project and generate (or update) an AGENTS.md file in the workspace root. The file should include:\n1. One-paragraph project description (what it does, tech stack)\n2. Directory structure overview (key folders and their purpose)\n3. Coding conventions you can infer from reading the code (naming, error handling, return formats, DB patterns, etc.)\n4. Key domains/modules — one line each explaining what each major file or group of files does\n5. Any constraints or rules the agent should follow when making changes\n\nSteps:\n- Read the root directory listing\n- Read package.json or requirements.txt to identify the stack\n- Sample 3-5 representative source files to infer conventions\n- If AGENTS.md already exists, read it first and update rather than replace\n- Write the final file to AGENTS.md in the project root\n\nBe specific and factual — only write what you can confirm from the code, not guesses.' },
};

const slashDropdown = document.createElement('div');
slashDropdown.id = 'slash-dropdown';
slashDropdown.style.cssText = mentionDropdown.style.cssText;
slashDropdown.style.display = 'none';
document.getElementById('input-container').appendChild(slashDropdown);

let slashResults = [];
let slashSelectedIdx = 0;

function showSlashDropdown(filter) {
    const q = filter.toLowerCase();
    slashResults = Object.values(SLASH_COMMANDS).filter(c => c.label.includes(q) || c.desc.toLowerCase().includes(q));
    slashSelectedIdx = 0;
    slashDropdown.innerHTML = '';
    if (!slashResults.length) { slashDropdown.style.display = 'none'; return; }
    slashResults.forEach((c, i) => {
        const item = document.createElement('div');
        item.className = 'mention-item' + (i === 0 ? ' selected' : '');
        item.innerHTML = `<span class="mention-item-base">${escHtml(c.label)}</span><span class="mention-item-rel">${escHtml(c.desc)}</span>`;
        item.addEventListener('mousedown', (e) => { e.preventDefault(); selectSlashItem(i); });
        slashDropdown.appendChild(item);
    });
    slashDropdown.style.display = 'block';
}

function hideSlashDropdown() { slashDropdown.style.display = 'none'; slashResults = []; }

function updateSlashHighlight() {
    const items = slashDropdown.querySelectorAll('.mention-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === slashSelectedIdx));
    items[slashSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function selectSlashItem(idx) {
    const cmd = slashResults[idx];
    if (!cmd) { return; }
    // Replace the /command text with the expanded prompt (or just the command label if no prompt)
    promptEl.value = cmd.prompt ?? (cmd.label + ' ');
    autoResize();
    hideSlashDropdown();
    promptEl.focus();
    // Move cursor to end
    promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
}

// ── Commands panel (/  button) ────────────────────────────────────────────────

const commandsBtn  = /** @type {HTMLButtonElement} */ (document.getElementById('commands-btn'));
const commandsPanel = /** @type {HTMLDivElement}   */ (document.getElementById('commands-panel'));

/** Build and show the commands panel. */
function openCommandsPanel() {
    commandsPanel.innerHTML = '';
    const header = document.createElement('div');
    header.id = 'commands-panel-header';
    header.textContent = 'Commands';
    commandsPanel.appendChild(header);

    Object.values(SLASH_COMMANDS).forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'cmd-item';
        item.innerHTML =
            `<span class="cmd-item-label">${escHtml(cmd.label)}</span>` +
            `<span class="cmd-item-desc">${escHtml(cmd.desc)}</span>`;
        item.addEventListener('click', () => {
            promptEl.value = cmd.prompt ?? (cmd.label + ' ');
            autoResize();
            updateTokenIndicator();
            closeCommandsPanel();
            promptEl.focus();
            promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
        });
        commandsPanel.appendChild(item);
    });

    commandsPanel.style.display = 'block';
    commandsBtn.classList.add('active');
}

function closeCommandsPanel() {
    commandsPanel.style.display = 'none';
    commandsBtn.classList.remove('active');
}

function toggleCommandsPanel() {
    if (commandsPanel.style.display === 'none') {
        openCommandsPanel();
    } else {
        closeCommandsPanel();
    }
}

commandsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCommandsPanel();
});

// Close panel when clicking outside it
document.addEventListener('click', (e) => {
    if (commandsPanel.style.display !== 'none' &&
        !commandsPanel.contains(/** @type {Node} */ (e.target)) &&
        e.target !== commandsBtn) {
        closeCommandsPanel();
    }
});

// Typing '/' at the start of an empty input also opens the panel
promptEl.addEventListener('keydown', (e) => {
    if (e.key === '/' && promptEl.value === '' && !e.ctrlKey && !e.metaKey) {
        // Let the character land, then open panel and clear the '/'
        setTimeout(() => {
            if (promptEl.value === '/') {
                promptEl.value = '';
                autoResize();
                openCommandsPanel();
            }
        }, 0);
    } else if (e.key === 'Escape' && commandsPanel.style.display !== 'none') {
        e.stopPropagation();
        closeCommandsPanel();
        promptEl.focus();
    }
});

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
    pinModeActive = false;
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

    // If pin mode, add to pinned files instead of mentioned files
    if (pinModeActive) {
        pinModeActive = false;
        if (!pinnedFiles.some((f) => f.rel === file.rel)) {
            pinnedFiles.push(file);
            vscode.postMessage({ command: 'updatePinnedFiles', files: pinnedFiles.map(f => f.rel) });
        }
        hideMentionDropdown();
        // Restore input to what it was before the @ was injected
        const val2 = promptEl.value;
        const before2 = val2.slice(0, mentionAtStart);
        const after2 = val2.slice(mentionAtStart + 1 + mentionQuery.length);
        promptEl.value = before2 + after2;
        autoResize();
        updateContextBar();
        updateTokenIndicator();
        return;
    }

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

    // Check for slash command at start of input
    if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
        showSlashDropdown(val);
        return;
    }
    hideSlashDropdown();

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
    pinModeActive = false;
    updateTokenIndicator();
});

promptEl.addEventListener('keydown', (e) => {
    // Slash command dropdown navigation
    if (slashDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown')  { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx + 1) % slashResults.length; updateSlashHighlight(); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx - 1 + slashResults.length) % slashResults.length; updateSlashHighlight(); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSlashItem(slashSelectedIdx); return; }
        if (e.key === 'Tab')        { e.preventDefault(); selectSlashItem(slashSelectedIdx); return; }
        if (e.key === 'Escape')     { hideSlashDropdown(); return; }
    }
    // @mention dropdown navigation
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
            populateModels(msg.models, msg.connected, msg.defaultModel);
            break;

        case 'streamStart':
            // Only create a new bubble if sendMessage() hasn't already created one
            if (!currentMsgEl) { startAssistantMessage(); }
            break;

        case 'token':
            appendToken(msg.text);
            break;

        case 'streamEnd':
            finalizeMessage();
            setStreaming(false);
            break;

        case 'agentDone':
            agentActive = false;
            stopBtn.classList.remove('visible');
            scrollBtn.classList.remove('visible');
            sendBtn.disabled = modelSelect.value === '';
            promptEl.focus();
            break;

        case 'toolCall':
            // If a waiting bubble exists with no content yet, remove it — tool cards replace it
            if (currentMsgEl && !currentRaw) { currentMsgEl.remove(); currentMsgEl = null; }
            addToolCard(msg.id, msg.name, msg.args);
            break;

        case 'toolResult':
            updateToolCard(msg.id, msg.success, msg.preview ?? '', msg.fullResult ?? '');
            break;

        case 'openClawDispatched':
            addOpenClawPending(msg.taskId, msg.query);
            break;

        case 'openClawResult':
            resolveOpenClawCard(msg.taskId, msg.content, msg.error, msg.durationMs);
            break;

        case 'error':
            addErrorMessage(msg.text);
            agentActive = false;
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

        case 'reasoningCard':
            addReasoningCard(msg);
            break;

        case 'planCard':
            addPlanCard(msg);
            break;

        case 'planProgress':
            addPlanProgress(msg);
            break;

        case 'planComplete':
            addPlanComplete();
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
            // Update active session id and refresh title in history panel if open
            activeSessionId = msg.session.id;
            if (msg.session.title && historyPanel.classList.contains('open')) {
                const titleEl = historyList.querySelector(`.session-item[data-id="${CSS.escape(msg.session.id)}"] .session-title`);
                if (titleEl) { titleEl.textContent = msg.session.title; }
            }
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
            // Restore preset selection from workspace state, but settings model takes priority
            if (msg.preset && MODEL_PRESETS[msg.preset]) {
                const config = MODEL_PRESETS[msg.preset];
                // Only restore preset if it doesn't conflict with the settings-configured model
                if (!defaultModel || defaultModel === config.model) {
                    currentPreset = msg.preset;
                    presetSelect.value = msg.preset;
                    const modelExists = Array.from(modelSelect.options).some(opt => opt.value === config.model);
                    if (modelExists && (modelSelect.value === config.model || modelSelect.value === '')) {
                        modelSelect.value = config.model;
                    }
                } else {
                    // Settings model differs from preset — stay on custom
                    currentPreset = '';
                    presetSelect.value = '';
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

        case 'pinnedFilesRestored':
            pinnedFiles = (msg.files ?? []).map(f => ({
                rel: f.rel,
                display: f.rel.split('/').pop() || f.rel,
                ext: (f.rel.split('.').pop() || '').toLowerCase()
            }));
            updateContextBar();
            break;

        case 'smartContextFiles':
            smartContextFiles = msg.files ?? [];
            // Show notification about included files
            if (smartContextFiles.length > 0) {
                const fileList = smartContextFiles.join(', ');
                console.log(`[smart-context] Auto-included: ${fileList}`);
            }
            break;

        case 'compactingStarted': {
            // Create a placeholder that summary tokens will stream into
            const el = document.createElement('div');
            el.id = 'compaction-in-progress';
            el.className = 'msg system-msg compaction-summary';
            const lbl = document.createElement('span');
            lbl.className = 'system-label';
            lbl.textContent = '📦 Compacting — generating summary…';
            const body = document.createElement('div');
            body.className = 'summary-body';
            body.style.fontStyle = 'italic';
            body.style.opacity = '0.7';
            el.appendChild(lbl);
            el.appendChild(body);
            messagesEl.appendChild(el);
            scrollBottom();
            if (compactBtnFooter) { compactBtnFooter.textContent = 'Compacting…'; compactBtnFooter.disabled = true; }
            break;
        }

        case 'compactSummaryToken': {
            const el = document.getElementById('compaction-in-progress');
            if (el) {
                const body = el.querySelector('.summary-body');
                if (body) { body.textContent += msg.token; scrollBottom(); }
            }
            break;
        }

        case 'contextWarning':
            addContextToast('warning',
                `Context at ${Math.round(msg.percentage)}% — consider starting a new chat or compacting`,
                true);
            updateContextUsage(msg.percentage);
            break;

        case 'contextCompacted': {
            addContextToast('compacted',
                `Context compacted: removed ${msg.messagesRemoved} old message${msg.messagesRemoved !== 1 ? 's' : ''}`,
                false);
            updateContextUsage(msg.newPercentage);
            if (compactBtnFooter) { compactBtnFooter.textContent = '🗜️ Compact'; compactBtnFooter.disabled = false; }
            // Finalize the streaming placeholder if present, otherwise create fresh
            const existing = document.getElementById('compaction-in-progress');
            if (existing) {
                existing.removeAttribute('id');
                const lbl = existing.querySelector('.system-label');
                if (lbl) lbl.textContent = '📦 Context compacted — summary of earlier conversation:';
                const body = existing.querySelector('.summary-body');
                if (body) { body.style.fontStyle = ''; body.style.opacity = ''; }
            } else if (msg.summary) {
                const summaryEl = document.createElement('div');
                summaryEl.className = 'msg system-msg compaction-summary';
                const summaryLabel = document.createElement('span');
                summaryLabel.className = 'system-label';
                summaryLabel.textContent = '📦 Context compacted — summary of earlier conversation:';
                const summaryBody = document.createElement('div');
                summaryBody.className = 'summary-body';
                summaryBody.textContent = msg.summary;
                summaryEl.appendChild(summaryLabel);
                summaryEl.appendChild(summaryBody);
                messagesEl.appendChild(summaryEl);
                scrollBottom();
            }
            break;
        }

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

        case 'confirmAction':
            addConfirmCard(msg.id, msg.action, msg.detail, msg.toolName);
            break;

        case 'autoApproved': {
            // Show a small toast for batch-approved actions (no buttons needed)
            const autoIcons = { run: '⚡', write: '💾', rename: '🔄', delete: '🗑️', edit: '✏️' };
            const autoIcon = autoIcons[msg.action] || '✅';
            addFileToastSimple(autoIcon, `Auto-approved: ${msg.detail}`);
            break;
        }

        case 'dismissConfirmation': {
            // Agent was stopped or a new turn started — dismiss any open confirmation cards
            const openCards = messagesEl.querySelectorAll('.confirm-card:not(.accepted):not(.rejected)');
            openCards.forEach(card => {
                card.classList.add('rejected');
                const actions = card.querySelector('.confirm-actions');
                if (actions) { actions.innerHTML = '<span class="confirm-resolved">⏹ Dismissed</span>'; }
            });
            // Clear sticky bar
            const pendingBarDismiss = document.getElementById('pending-confirm-bar');
            if (pendingBarDismiss) { pendingBarDismiss.style.display = 'none'; pendingBarDismiss.innerHTML = ''; }
            break;
        }
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

historyClearBtn.addEventListener('click', async () => {
    // VS Code webviews don't support confirm(), so we use a simple approach
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
    const ts = timestamp || Date.now();
    const absTime = new Date(ts).toLocaleString();
    const timeStr = relativeTimeStr(ts);
    const cleanContent = stripToolBlocksClient(content);
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent</span>` +
            `<time class="msg-time" data-ts="${ts}" title="${absTime}">${timeStr}</time>` +
            `<div class="msg-actions"><button class="msg-action-btn retry-btn" title="Retry">↺ Retry</button></div>` +
        `</div>` +
        `<div class="msg-content">${renderMarkdown(cleanContent)}</div>`;
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
    const ts = timestamp || Date.now();
    const absTime = new Date(ts).toLocaleString();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">You</span>` +
            `<time class="msg-time" data-ts="${ts}" title="${absTime}">${relativeTimeStr(ts)}</time>` +
        `</div>` +
        `<div class="msg-content">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    assignMsgId(div);
    div.querySelector('.msg-header').appendChild(createPinBtn(div));
    userScrolledUp = false;
    scrollBottom(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

try {
    setStatus('checking', 'Connecting…');
    // Request models + current editor context
    vscode.postMessage({ command: 'getModels' });
    vscode.postMessage({ command: 'getContext' });
} catch (initErr) {
    const el = document.getElementById('status-text');
    if (el) { el.textContent = 'Init error: ' + initErr.message; el.style.color = '#f44747'; }
    try { vscode.postMessage({ command: 'webviewError', text: '[webview init] ' + initErr.stack }); } catch(_) {}
}
