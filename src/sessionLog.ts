import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolCallRecord {
    name: string;
    /** File path argument if the tool operated on a file. */
    path?: string;
}

export interface GuardEvent {
    /** Short identifier for the guard that fired. */
    type: 'logprob' | 'schema-guard' | 'merge-guard' | 'undef-guard' | 'stub-file'
        | 'import-guard' | 'syntax-error' | 'repeat-guard' | 'scope-guard';
    /** Human-readable reason string. */
    reason: string;
    /** File affected, if applicable. */
    file?: string;
}

export interface SessionLogEntry {
    /** ISO timestamp of run start. */
    ts: string;
    /** ChatSession.id — ties the log entry back to the stored session. */
    sessionId: string;
    /** Model name used for this run. */
    model: string;
    /** User task message (first 500 chars). */
    task: string;
    /** Number of model turns completed. */
    turns: number;
    /** Every tool call made during the run, in order. */
    toolCalls: ToolCallRecord[];
    /** Every guardrail event that fired during the run. */
    guardEvents: GuardEvent[];
    /** Relative paths of files successfully written/edited. */
    filesChanged: string[];
    /** Average log-probability of last model response, or null if not available. */
    avgLogprob: number | null;
    /** Wall-clock duration of the run in milliseconds. */
    durationMs: number;
    /** How the run ended. */
    outcome: 'done' | 'error' | 'stopped';
}

// ── Writer ────────────────────────────────────────────────────────────────────

/**
 * Append one JSON line to <workspaceRoot>/.ollamapilot/sessions.jsonl.
 * Creates the directory if it doesn't exist.
 * Silently swallows any I/O errors — logging must never surface to the user.
 *
 * Scoping: each workspace has its own root, so the file is naturally
 * per-project. Opening a second workspace writes to that workspace's own
 * .ollamapilot/ directory. No cross-workspace overlap is possible.
 */
export function appendSessionLog(workspaceRoot: string, entry: SessionLogEntry): void {
    if (!workspaceRoot) { return; }
    try {
        const dir = path.join(workspaceRoot, '.ollamapilot');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const file = path.join(dir, 'sessions.jsonl');
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
        // Intentionally silent — disk errors must not interrupt the agent
    }
}
