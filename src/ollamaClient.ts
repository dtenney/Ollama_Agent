import * as http from 'http';
import * as https from 'https';
import { getConfig, parseBaseUrl } from './config';
import { logInfo, logError } from './logger';

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
    stopRef: { stop: boolean }
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
        // Only include options if temperature is non-default
        if (cfg.temperature !== 0.7) {
            payload.options = { temperature: cfg.temperature };
        }

        const body = JSON.stringify(payload);
        logInfo(`POST /api/chat  model=${model}  msgs=${messages.length}`);

        const req = makeRequest(
            {
                hostname, port, path: '/api/chat', method: 'POST',
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
                let toolCalls: OllamaToolCall[] = [];
                let buf = '';

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) { req.destroy(); return; }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.trim()) { continue; }
                        try {
                            const p = JSON.parse(line);
                            if (p.message?.content) {
                                fullContent += p.message.content;
                                onToken(p.message.content);
                            }
                            if (p.message?.tool_calls?.length) {
                                toolCalls = p.message.tool_calls;
                            }
                            if (p.done) {
                                logInfo(`Stream done — ${fullContent.length} chars, ${toolCalls.length} tool calls`);
                                resolve({ content: fullContent, toolCalls });
                            }
                        } catch { /* skip malformed line */ }
                    }
                });

                res.on('end', () => resolve({ content: fullContent, toolCalls }));
                res.on('error', reject);
            }
        );
        req.on('error', (err) => {
            logError(`streamChatRequest: ${err.message}`);
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

export async function fetchModels(): Promise<string[]> {
    try {
        const { status, body } = await rawGet('/api/tags');
        if (status !== 200) { logError(`/api/tags HTTP ${status}`); return []; }
        const parsed = JSON.parse(body) as { models?: { name: string }[] };
        const names = parsed.models?.map((m) => m.name) ?? [];
        logInfo(`Models: ${names.join(', ') || '(none)'}`);
        return names;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        logError(`fetchModels: ${e.code ?? ''} ${e.message}`);
        return [];
    }
}
