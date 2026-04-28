import * as vscode from 'vscode';

export const channel = vscode.window.createOutputChannel('Ollama Agent');

const ts = () => new Date().toISOString();

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

export const logInfo  = (m: string): void => channel.appendLine(`[INFO]  ${ts()}  ${redactSecrets(m)}`);
export const logWarn  = (m: string): void => channel.appendLine(`[WARN]  ${ts()}  ${redactSecrets(m)}`);
export const logError = (m: string): void => channel.appendLine(`[ERROR] ${ts()}  ${redactSecrets(m)}`);

/** Extract a human-readable message from any caught value. */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) { return err.message; }
    return String(err);
}
