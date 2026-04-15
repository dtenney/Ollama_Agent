import * as vscode from 'vscode';

const SECTION = 'ollamaAgent';

// ── Model Presets ─────────────────────────────────────────────────────────────

export interface ModelPreset {
    name: string;
    model: string;
    temperature: number;
    description: string;
}

export const MODEL_PRESETS: Record<string, ModelPreset> = {
    fast: {
        name: 'Fast',
        model: 'qwen2.5-coder:1.5b',
        temperature: 0.5,
        description: 'Quick responses, lower quality'
    },
    balanced: {
        name: 'Balanced',
        model: 'qwen2.5-coder:7b',
        temperature: 0.7,
        description: 'Good balance of speed and quality'
    },
    quality: {
        name: 'Quality',
        model: 'llama3.1:8b',
        temperature: 0.8,
        description: 'Best quality, slower responses'
    }
};

export interface OllamaConfig {
    /** Explicit base URL, e.g. "http://localhost:11434". Overrides host + port when set. */
    baseUrl: string;
    host: string;
    port: number;
    model: string;
    temperature: number;
    systemPrompt: string;
    autoIncludeFile: boolean;
    autoIncludeSelection: boolean;
    /** Maximum number of workspace files to auto-load as context. */
    maxContextFiles: number;
    /** When true, inject a concise git diff into every message for change-aware context. */
    injectGitDiff: boolean;
    /** When true, AI automatically saves important information to memory as it discovers it. */
    autoSaveMemory: boolean;
    /** When true, automatically compact context when it reaches 99% of model's limit. */
    autoCompactContext: boolean;
    /** When true, pass think:true to Ollama for models that support chain-of-thought reasoning (e.g. qwen3). */
    enableThinking: boolean;
    /** Maximum agent turns per session (0 = use built-in defaults per task type). */
    maxTurnsPerSession: number;
    // ── Multi-model routing ────────────────────────────────────────────────────
    /** Model to use for read-only / exploration turns (shell_read, memory_search). Empty = use main model. */
    fastModel: string;
    /** Model to use for the critic review pass after edits. Empty = use main model. */
    criticModel: string;
    /** Enable automatic multi-model routing based on operation type. */
    modelRoutingEnabled: boolean;
    /** Days before AGENTS.md is considered stale and auto-refresh is triggered on workspace open. 0 = disabled. */
    contextFileAutoUpdateDays: number;
}

// ── Model routing helpers ─────────────────────────────────────────────────────

export type OperationType = 'read' | 'write' | 'critic' | 'default';

/**
 * Resolve which model to use for a given operation type.
 * Falls back to the base model when no specialist model is configured.
 */
export function resolveModelForOperation(cfg: OllamaConfig, op: OperationType): string {
    if (!cfg.modelRoutingEnabled) { return cfg.model; }
    switch (op) {
        case 'read':   return cfg.fastModel   || cfg.model;
        case 'critic': return cfg.criticModel || cfg.model;
        default:       return cfg.model;
    }
}

export function getConfig(): OllamaConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    const host = c.get<string>('host', 'localhost');
    const port = c.get<number>('port', 11434);
    // Derive baseUrl: explicit setting wins, otherwise construct from host:port
    const explicitBase = c.get<string>('baseUrl', '').trim().replace(/\/$/, '');
    const baseUrl = explicitBase || `http://${host}:${port}`;

    return {
        baseUrl,
        host,
        port,
        model:                c.get<string> ('model',                'qwen2.5-coder:7b'),
        temperature:          c.get<number> ('temperature',          0.7),
        systemPrompt:         c.get<string> ('systemPrompt',         ''),
        autoIncludeFile:      c.get<boolean>('autoIncludeFile',      false),
        autoIncludeSelection: c.get<boolean>('autoIncludeSelection', true),
        maxContextFiles:      c.get<number> ('maxContextFiles',      5),
        injectGitDiff:        c.get<boolean>('injectGitDiff',        false),
        autoSaveMemory:       c.get<boolean>('memory.autoSave',      false),
        autoCompactContext:   c.get<boolean>('autoCompactContext',   true),
        enableThinking:       c.get<boolean>('enableThinking',       false),
        maxTurnsPerSession:   c.get<number> ('maxTurnsPerSession',   0),
        fastModel:                 c.get<string> ('routing.fastModel',             ''),
        criticModel:               c.get<string> ('routing.criticModel',            ''),
        modelRoutingEnabled:       c.get<boolean>('routing.enabled',                false),
        contextFileAutoUpdateDays: c.get<number> ('contextFile.autoUpdateDays',     7),
    };
}

export interface SearchConfig {
    /** SearXNG base URL, e.g. "http://192.168.1.100:8888". Empty = disabled. */
    url: string;
    /** Max results per query (default 5). */
    resultsLimit: number;
}

export function getSearchConfig(): SearchConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
        url:          c.get<string>('search.url', '').trim().replace(/\/$/, ''),
        resultsLimit: c.get<number>('search.resultsLimit', 5),
    };
}

export interface OpenClawConfig {
    baseUrl: string;
    token: string;
}

export function getOpenClawConfig(): OpenClawConfig {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
        baseUrl: c.get<string>('openClaw.baseUrl', '').trim().replace(/\/$/, ''),
        token:   c.get<string>('openClaw.token',   '').trim(),
    };
}

/** Parse a base URL string into hostname + port for use with http.request. */
export function parseBaseUrl(baseUrl: string): { hostname: string; port: number; protocol: string } {
    try {
        const u = new URL(baseUrl);
        const defaultPort = u.protocol === 'https:' ? 443 : 80;
        return {
            hostname: u.hostname,
            port: u.port ? parseInt(u.port, 10) : defaultPort,
            protocol: u.protocol,
        };
    } catch {
        // Fallback: assume localhost:11434
        return { hostname: 'localhost', port: 11434, protocol: 'http:' };
    }
}
