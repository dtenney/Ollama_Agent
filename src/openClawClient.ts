import * as https from 'https';
import * as http from 'http';
import { logInfo, logError } from './logger';

export interface OpenClawConfig {
    baseUrl: string;
    token: string;
}

export interface OpenClawTask {
    id: string;
    query: string;
    sessionKey: string;
    startedAt: number;
}

export interface OpenClawResult {
    taskId: string;
    content: string;
    durationMs: number;
    error?: string;
}

function generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

/** Convert http(s) base URL to ws(s) URL */
function toWsUrl(baseUrl: string): string {
    return baseUrl.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

/**
 * Open a WebSocket to the OpenCLAW gateway, authenticate via challenge/response,
 * send a chat message, collect the full assistant response, then close.
 */
function runTask(
    query: string,
    config: OpenClawConfig,
    taskId: string,
    sessionKey: string,
    startedAt: number,
    onResult: (result: OpenClawResult) => void
): void {
    const wsUrl = toWsUrl(config.baseUrl);
    logInfo(`[openclaw] Connecting to ${wsUrl}`);

    // Node v21+ global WebSocket — cast to any to use it without @types/node WebSocket type conflicts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WS = (globalThis as any).WebSocket as typeof WebSocket;
    const ws: WebSocket = new WS(wsUrl);

    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let responseContent = '';
    let finished = false;
    let connected = false;
    const TIMEOUT_MS = 300_000;

    const timeout = setTimeout(() => {
        logError(`[openclaw] Task ${taskId} timed out`);
        ws.close();
        finish('Timed out after 5 minutes');
    }, TIMEOUT_MS);

    function finish(error?: string): void {
        if (finished) { return; }
        finished = true;
        clearTimeout(timeout);
        if (error) {
            onResult({ taskId, content: '', durationMs: Date.now() - startedAt, error });
        } else {
            onResult({ taskId, content: responseContent, durationMs: Date.now() - startedAt });
        }
    }

    function sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = generateId();
        const msg = JSON.stringify({ type: 'req', id, method, params });
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(msg);
        });
    }

    ws.addEventListener('open', () => {
        logInfo(`[openclaw] WebSocket open`);
    });

    ws.addEventListener('message', async (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        } catch {
            return;
        }

        const msgType = msg.type as string;

        // ── RPC response ───────────────────────────────────────────────
        if (msgType === 'res') {
            const id = msg.id as string;
            const p = pending.get(id);
            if (p) {
                pending.delete(id);
                if (msg.ok) {
                    p.resolve(msg.payload);
                } else {
                    const err = msg.error as Record<string, unknown> | undefined;
                    p.reject(new Error((err?.message as string) ?? 'RPC error'));
                }
            }

            // chat.send may return the full reply synchronously (non-streaming mode)
            if (msg.ok) {
                const pl = msg.payload as Record<string, unknown> | undefined;
                if (pl && typeof pl.content === 'string' && pl.content.length > 0) {
                    responseContent = pl.content;
                    ws.close();
                    finish();
                }
            }
            return;
        }

        // ── Server-push event ──────────────────────────────────────────
        if (msgType === 'event') {
            const payload = msg.payload as Record<string, unknown> | undefined;
            const evType = payload?.type as string | undefined;

            // Auth challenge
            if (evType === 'connect.challenge' && !connected) {
                logInfo(`[openclaw] Received connect.challenge, authenticating`);
                try {
                    await sendRpc('connect', {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: 'ollamapilot',
                        role: 'user',
                        scopes: ['chat'],
                        caps: ['tool-events'],
                        auth: config.token ? { token: config.token } : undefined,
                    });
                    connected = true;
                    logInfo(`[openclaw] Authenticated, sending chat.send`);
                    await sendRpc('chat.send', {
                        sessionKey,
                        message: query,
                        deliver: false,
                        idempotencyKey: generateId(),
                    });
                    logInfo(`[openclaw] chat.send dispatched, awaiting response`);
                } catch (err) {
                    ws.close();
                    finish(err instanceof Error ? err.message : String(err));
                }
                return;
            }

            // Streaming message chunks
            if (evType === 'chat.message' || evType === 'message') {
                const role = payload?.role as string | undefined;
                const content = payload?.content as string | undefined;
                if (role === 'assistant' && content) {
                    responseContent += content;
                }
            }

            // Response complete
            if (evType === 'chat.done' || evType === 'session.done') {
                ws.close();
                finish();
            }
        }
    });

    ws.addEventListener('close', () => {
        logInfo(`[openclaw] WebSocket closed, content length=${responseContent.length}`);
        if (!finished) {
            finish(responseContent.length === 0 ? 'Connection closed before response received' : undefined);
        }
    });

    ws.addEventListener('error', (ev: Event) => {
        const msg = (ev as ErrorEvent).message ?? 'WebSocket error';
        logError(`[openclaw] WebSocket error: ${msg}`);
        finish(msg);
    });
}

export function dispatchTask(
    query: string,
    config: OpenClawConfig,
    onResult: (result: OpenClawResult) => void
): OpenClawTask {
    const taskId = generateId();
    const sessionKey = `ollamapilot_${taskId.slice(0, 8)}`;
    const startedAt = Date.now();
    const task: OpenClawTask = { id: taskId, query, sessionKey, startedAt };

    runTask(query, config, taskId, sessionKey, startedAt, onResult);

    return task;
}

export function cancelTask(_task: OpenClawTask): void {
    // placeholder — future abort controller
}

export function checkConnection(config: OpenClawConfig): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const url = new URL(config.baseUrl);
            const isHttps = url.protocol === 'https:';
            const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const reqModule: any = isHttps ? https : http;
            const req = reqModule.request({
                hostname: url.hostname,
                port,
                path: '/health',
                method: 'GET',
                timeout: 5_000,
                rejectUnauthorized: false,
            } as https.RequestOptions, (res: http.IncomingMessage) => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
            req.end();
        } catch {
            resolve(false);
        }
    });
}
