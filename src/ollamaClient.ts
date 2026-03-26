import * as http from 'http';
import * as https from 'https';
import { getConfig, parseBaseUrl } from './config';
import { logInfo, logError, toErrorMessage } from './logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
    function: { name: string; arguments: Record<string, unknown> };
}

export interface StreamResult {
    content: string;
    toolCalls: OllamaToolCall[];
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────

function getEndpoint(): { hostname: string; port: number; isHttps: boolean } {
    const { baseUrl } = getConfig();
    const { hostname, port, protocol } = parseBaseUrl(baseUrl);
    return { hostname, port, isHttps: protocol === 'https:' };
}

function makeRequest(
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void
): http.ClientRequest {
    const { isHttps } = getEndpoint();
    return isHttps
        ? https.request(options, callback)
        : http.request(options, callback);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function rawGet(
    urlPath: string,
    timeoutMs = 5000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const req = makeRequest(
            { hostname, port, path: urlPath, method: 'GET', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.on('data', (c: Buffer) => (body += c.toString()));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/** Sentinel thrown when the model doesn't support Ollama native tool calling. */
export class ToolsNotSupportedError extends Error {
    constructor(model: string) {
        super(`Model "${model}" does not support native tool calling. Switched to text-mode.`);
        this.name = 'ToolsNotSupportedError';
    }
}

export function streamChatRequest(
    model: string,
    messages: OllamaMessage[],
    tools: unknown[],
    onToken: (t: string) => void,
    stopRef: { stop: boolean; destroy?: () => void }
): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const cfg = getConfig();
        const payload: Record<string, unknown> = {
            model,
            messages,
            stream: true,
        };
        // Only include tools if non-empty (some models reject the field when empty)
        if (tools.length) { payload.tools = tools; }
        // Build options — temperature (if non-default) and thinking mode
        const opts: Record<string, unknown> = {};
        if (cfg.temperature !== 0.7) { opts.temperature = cfg.temperature; }
        if (cfg.enableThinking) { opts.think = true; }
        if (Object.keys(opts).length > 0) { payload.options = opts; }

        const body = JSON.stringify(payload);
        logInfo(`POST /api/chat  model=${model}  msgs=${messages.length}  think=${cfg.enableThinking}`);

        const req = makeRequest(
            {
                hostname, port, path: '/api/chat', method: 'POST',
                timeout: 120_000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => {
                        // Detect the "model does not support tools" 400 specifically
                        if (res.statusCode === 400 && e.toLowerCase().includes('does not support tools')) {
                            reject(new ToolsNotSupportedError(model));
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${e}`));
                        }
                    });
                    return;
                }

                let fullContent = '';
                let fullThinking = '';
                let toolCalls: OllamaToolCall[] = [];
                let buf = '';
                let resolved = false;
                let thinkingStarted = false;

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) { req.destroy(); return; }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) { continue; }
                        try {
                            const p = JSON.parse(line);
                            if (p.message?.thinking) {
                                if (!thinkingStarted) {
                                    thinkingStarted = true;
                                    onToken('\x01THINK_START\x01');
                                }
                                fullThinking += p.message.thinking;
                                onToken(p.message.thinking);
                            }
                            if (p.message?.content) {
                                if (thinkingStarted && !fullContent) {
                                    // thinking finished, content starting
                                    onToken('\x01THINK_END\x01');
                                    thinkingStarted = false;
                                }
                                fullContent += p.message.content;
                                onToken(p.message.content);
                            }
                            if (p.message?.tool_calls?.length) {
                                toolCalls = p.message.tool_calls;
                            }
                            if (p.done && !resolved) {
                                if (thinkingStarted) { onToken('\x01THINK_END\x01'); }
                                resolved = true;
                                if (fullThinking) { logInfo(`[think] ${fullThinking.length} thinking chars`); }
                                logInfo(`Stream done — ${fullContent.length} chars, ${toolCalls.length} tool calls`);
                                resolve({ content: fullContent, toolCalls });
                            }
                        } catch { /* skip malformed line */ }
                    }
                });

                res.on('end', () => { if (!resolved) { resolved = true; resolve({ content: fullContent, toolCalls }); } });
                res.on('error', reject);
            }
        );
        // Expose immediate destroy so callers can abort without waiting for next chunk
        stopRef.destroy = () => req.destroy();
        req.on('timeout', () => { req.destroy(); reject(new Error('Chat request timed out (120s)')); });
        req.on('error', (err) => {
            // Ignore ECONNRESET caused by our own destroy() on stop
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' && stopRef.stop) { return; }
            logError(`streamChatRequest: ${err.message}`);
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

// ── FIM (Fill-in-the-Middle) via /api/generate ───────────────────────────────

export function streamGenerateRequest(
    model: string,
    prompt: string,
    suffix: string,
    onToken: (t: string) => void,
    stopRef: { stop: boolean }
): Promise<string> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const payload: Record<string, unknown> = {
            model,
            prompt,
            suffix,
            stream: true,
            raw: true,
            options: { temperature: 0, num_predict: 256, stop: ['\n\n\n'] },
        };

        const body = JSON.stringify(payload);
        logInfo(`POST /api/generate (FIM)  model=${model}  prefix=${prompt.length}c  suffix=${suffix.length}c`);

        let settled = false;
        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 15_000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => { if (!settled) { settled = true; reject(new Error(`HTTP ${res.statusCode}: ${e}`)); } });
                    return;
                }

                let fullContent = '';
                let buf = '';

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) { req.destroy(); return; }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const p = JSON.parse(line);
                            if (p.response) {
                                fullContent += p.response;
                                onToken(p.response);
                            }
                            if (p.done && !settled) {
                                settled = true;
                                resolve(fullContent);
                            }
                        } catch { /* skip malformed line */ }
                    }
                });

                res.on('end', () => { if (!settled) { settled = true; resolve(fullContent); } });
                res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
            }
        );
        req.on('timeout', () => { req.destroy(); if (!settled) { settled = true; reject(new Error('FIM request timed out')); } });
        req.on('error', (err) => {
            logError(`streamGenerateRequest: ${err.message}`);
            if (!settled) { settled = true; reject(err); }
        });
        req.write(body);
        req.end();
    });
}

/**
 * Generate a short chat title from the first exchange.
 * Fires a non-streaming /api/generate call with a tight token budget.
 * Returns null on any error so callers can fall back to deriveTitle().
 */
export async function generateChatTitle(
    model: string,
    userMessage: string,
    assistantSnippet: string
): Promise<string | null> {
    return new Promise((resolve) => {
        const { hostname, port } = getEndpoint();
        const prompt =
            `Summarize this conversation in 5 words or fewer as a chat title. ` +
            `Reply with only the title, no punctuation.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantSnippet.slice(0, 300)}`;
        const payload = JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: 0.3, num_predict: 16 },
        });

        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 10_000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            },
            (res) => {
                let raw = '';
                res.on('data', (c: Buffer) => (raw += c.toString()));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(raw);
                        const title = (parsed.response as string | undefined)?.trim().replace(/[.!?]+$/, '');
                        resolve(title && title.length > 0 && title.length < 80 ? title : null);
                    } catch { resolve(null); }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
}

/**
 * Send a keep-alive (empty generate) to Ollama to pre-load the model into GPU memory.
 * Fires-and-forgets — any error is silently ignored.
 */
export function keepAliveModel(model: string): void {
    const { hostname, port } = getEndpoint();
    const body = JSON.stringify({ model, keep_alive: '10m', prompt: '', stream: false });
    try {
        const req = makeRequest(
            {
                hostname, port, path: '/api/generate', method: 'POST',
                timeout: 30_000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                res.resume(); // discard response body
                logInfo(`[keep-alive] model=${model} status=${res.statusCode}`);
            }
        );
        req.on('error', () => { /* ignore — Ollama may not be running yet */ });
        req.write(body);
        req.end();
    } catch { /* ignore */ }
}

/** Cached model list with TTL */
let _cachedModels: { names: string[]; timestamp: number } | null = null;
const MODELS_TTL_MS = 60_000; // 60 seconds

export async function fetchModels(): Promise<string[]> {
    // Return cached list if still fresh
    if (_cachedModels && (Date.now() - _cachedModels.timestamp) < MODELS_TTL_MS) {
        return _cachedModels.names;
    }
    try {
        const { status, body } = await rawGet('/api/tags');
        if (status !== 200) { logError(`/api/tags HTTP ${status}`); return []; }
        const parsed = JSON.parse(body) as { models?: { name: string }[] };
        const names = parsed.models?.map((m) => m.name) ?? [];
        logInfo(`Models: ${names.join(', ') || '(none)'}`);
        _cachedModels = { names, timestamp: Date.now() };
        return names;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        logError(`fetchModels: ${e.code ?? ''} ${e.message}`);
        return [];
    }
}

// ── Model info via /api/show ─────────────────────────────────────────────────

export interface OllamaModelInfo {
    contextLength: number | null;
    parameterSize: string | null;
    quantization: string | null;
    family: string | null;
}

/**
 * Fetch model metadata from Ollama's /api/show endpoint.
 * Returns the actual context window (num_ctx) and other model details.
 * Returns null if the request fails.
 */
export function fetchModelInfo(model: string): Promise<OllamaModelInfo | null> {
    return new Promise((resolve) => {
        const { hostname, port } = getEndpoint();
        const body = JSON.stringify({ name: model });

        const req = makeRequest(
            {
                hostname, port, path: '/api/show', method: 'POST',
                timeout: 5000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => {
                        logError(`/api/show HTTP ${res.statusCode}: ${e.slice(0, 200)}`);
                        resolve(null);
                    });
                    return;
                }

                let raw = '';
                res.on('data', (c: Buffer) => (raw += c.toString()));
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw);
                        // Extract context length from model_info or parameters
                        let contextLength: number | null = null;

                        // Method 1: model_info object (most reliable)
                        const modelInfo = data.model_info;
                        if (modelInfo) {
                            // Keys vary by architecture, look for common patterns
                            for (const key of Object.keys(modelInfo)) {
                                if (key.endsWith('.context_length')) {
                                    contextLength = Number(modelInfo[key]);
                                    break;
                                }
                            }
                        }

                        // Method 2: parameters string (fallback)
                        if (!contextLength && data.parameters) {
                            const match = String(data.parameters).match(/num_ctx\s+(\d+)/);
                            if (match) { contextLength = Number(match[1]); }
                        }

                        // Extract other useful details
                        const details = data.details || {};

                        const info: OllamaModelInfo = {
                            contextLength,
                            parameterSize: details.parameter_size || null,
                            quantization: details.quantization_level || null,
                            family: details.family || null,
                        };

                        logInfo(`[model-info] ${model}: ctx=${info.contextLength ?? 'unknown'}, params=${info.parameterSize ?? '?'}, quant=${info.quantization ?? '?'}`);
                        resolve(info);
                    } catch (err) {
                        logError(`[model-info] Failed to parse /api/show response: ${toErrorMessage(err)}`);
                        resolve(null);
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

