import * as vscode from 'vscode';

const SECTION = 'ollamaAgent';

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
        model:                c.get<string> ('model',                'llama2'),
        temperature:          c.get<number> ('temperature',          0.7),
        systemPrompt:         c.get<string> ('systemPrompt',         ''),
        autoIncludeFile:      c.get<boolean>('autoIncludeFile',      false),
        autoIncludeSelection: c.get<boolean>('autoIncludeSelection', true),
        maxContextFiles:      c.get<number> ('maxContextFiles',      5),
        injectGitDiff:        c.get<boolean>('injectGitDiff',        false),
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
