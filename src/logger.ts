import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export const channel = vscode.window.createOutputChannel('Ollama Agent');

const ts = () => new Date().toISOString();

// ── File sink ─────────────────────────────────────────────────────────────────

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB rolling cap
let _logFilePath: string | null = null;
let _logLines: string[] = [];         // in-memory buffer, flushed on each write

export function initFileLogger(workspaceRoot: string): void {
    const dir = path.join(workspaceRoot, '.ollamapilot');
    try {
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        _logFilePath = path.join(dir, 'agent.log');
        // Write session start marker
        fs.appendFileSync(_logFilePath, `\n\n===== SESSION START ${new Date().toISOString()} =====\n`, 'utf8');
        // Roll if over cap
        try {
            if (fs.statSync(_logFilePath).size > MAX_LOG_BYTES) {
                const existing = fs.readFileSync(_logFilePath, 'utf8');
                fs.writeFileSync(_logFilePath, existing.slice(-MAX_LOG_BYTES / 2), 'utf8');
            }
        } catch { /* ignore stat errors */ }
    } catch { _logFilePath = null; }
}

function writeToFile(line: string): void {
    if (!_logFilePath) { return; }
    try { fs.appendFileSync(_logFilePath, line + '\n', 'utf8'); } catch { /* ignore */ }
}

export function exportLog(workspaceRoot: string): string | null {
    if (!_logFilePath || !fs.existsSync(_logFilePath)) { return null; }
    const content = fs.readFileSync(_logFilePath, 'utf8');
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportPath = path.join(workspaceRoot, '.ollamapilot', `agent-export-${date}.md`);
    const header = `# OllamaPilot Agent Log Export\n\nExported: ${new Date().toISOString()}\nWorkspace: ${workspaceRoot}\n\nPaste this file into another AI agent for review. Ask it to look for:\n- Guard fires (think-stalls, intent retries, repeated nudges)\n- Inefficient tool call sequences (same file read multiple times, repeated failed edits)\n- Confirmation-heavy sessions (same tool approved repeatedly)\n- Errors and what triggered them\n- Sessions where the user had to nudge the agent multiple times to continue\n\n---\n\n\`\`\`\n${content}\n\`\`\`\n`;
    fs.writeFileSync(exportPath, header, 'utf8');
    return exportPath;
}

/**
 * Redact common credential patterns from log output.
 * Covers passwords, API keys, tokens, secrets, and connection strings.
 */
function redactSecrets(m: string): string {
    return m
        // key=value patterns: password=..., api_key=..., token=..., secret=...
        .replace(/\b(password|passwd|pwd|api[_-]?key|apikey|token|secret|credential|auth[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
        // Bearer / Basic auth headers
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._\-]{8,}/g, '$1 [REDACTED]')
        // Connection strings with embedded credentials: user:pass@host
        .replace(/\/\/[^:@\s]+:[^@\s]+@/g, '//[REDACTED]@')
        // Long high-entropy strings that look like tokens (40+ chars with mixed case + digits).
        // Requires at least one digit and one letter to avoid redacting long all-alpha words or paths.
        .replace(/\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[^=]*[0-9])(?=[^=]*[A-Za-z])[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}

export const logInfo  = (m: string): void => { const line = `[INFO]  ${ts()}  ${redactSecrets(m)}`; channel.appendLine(line); writeToFile(line); };
export const logWarn  = (m: string): void => { const line = `[WARN]  ${ts()}  ${redactSecrets(m)}`; channel.appendLine(line); writeToFile(line); };
export const logError = (m: string): void => { const line = `[ERROR] ${ts()}  ${redactSecrets(m)}`; channel.appendLine(line); writeToFile(line); };

/** Extract a human-readable message from any caught value. */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) { return err.message; }
    return String(err);
}
