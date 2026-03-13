import * as vscode from 'vscode';
import { OllamaMessage } from './ollamaClient';
import { logInfo, logError } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single renderable message stored per session. */
export interface StoredMessage {
    role: 'user' | 'assistant' | 'error';
    content: string;
    timestamp: number;
}

/** One saved chat session. */
export interface ChatSession {
    id: string;
    /** Auto-derived from the first user message. */
    title: string;
    /** Model used in this session. */
    model: string;
    createdAt: number;
    updatedAt: number;
    /** Visual messages — what gets rendered in the chat UI. */
    messages: StoredMessage[];
    /**
     * Full agent conversation history (no system message).
     * Restored when the user re-opens a session so the model has prior context.
     */
    agentHistory: OllamaMessage[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = 'ollamaAgent.sessions.v1';
const MAX_SESSIONS = 50;

// ── Storage service ───────────────────────────────────────────────────────────

export class ChatStorage {
    constructor(private readonly context: vscode.ExtensionContext) {}
    
    /** Get workspace-specific storage key */
    private getStorageKey(): string {
        const workspaceName = vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || 'default';
        return `${STORAGE_KEY_PREFIX}.${workspaceName}`;
    }

    /** All sessions for current workspace, sorted newest-first. */
    list(): ChatSession[] {
        return (this.context.globalState.get<ChatSession[]>(this.getStorageKey()) ?? [])
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** Retrieve one session by ID. */
    get(id: string): ChatSession | undefined {
        return this.list().find((s) => s.id === id);
    }

    /** Create or update a session. Keeps only the most recent MAX_SESSIONS. */
    upsert(session: ChatSession): void {
        try {
            const rest = this.list().filter((s) => s.id !== session.id);
            const toSave = [{ ...session, updatedAt: Date.now() }, ...rest].slice(0, MAX_SESSIONS);
            this.context.globalState.update(this.getStorageKey(), toSave);
            logInfo(`[storage] Saved "${session.title}" — ${session.messages.length} messages`);
        } catch (err) {
            logError(`[storage] Failed to save session: ${(err as Error).message}`);
        }
    }

    /** Remove a single session. */
    delete(id: string): void {
        const rest = this.list().filter((s) => s.id !== id);
        this.context.globalState.update(this.getStorageKey(), rest);
        logInfo(`[storage] Deleted session ${id}`);
    }

    /** Wipe every saved session for current workspace. */
    clearAll(): void {
        this.context.globalState.update(this.getStorageKey(), []);
        logInfo('[storage] All sessions cleared');
    }

    /** Build an empty session with defaults. */
    createNew(model: string): ChatSession {
        return {
            id:           `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title:        'New Chat',
            model,
            createdAt:    Date.now(),
            updatedAt:    Date.now(),
            messages:     [],
            agentHistory: [],
        };
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable title from the first user message.
 * Strips injected <active-file> / <selection> context blocks before truncating.
 */
export function deriveTitle(messages: StoredMessage[]): string {
    const first = messages.find((m) => m.role === 'user');
    if (!first) { return 'New Chat'; }
    const clean = first.content
        .replace(/<active-file[\s\S]*?<\/active-file>/g, '')
        .replace(/<selection[\s\S]*?<\/selection>/g, '')
        .replace(/<mention[\s\S]*?<\/mention>/g, '')
        .replace(/<git-diff[\s\S]*?<\/git-diff>/g, '')
        .trim()
        .replace(/\n+/g, ' ');
    if (!clean) { return 'New Chat'; }
    return clean.length > 50 ? clean.slice(0, 47) + '…' : clean;
}

/** Return a relative time string, e.g. "2 hours ago", "yesterday", "Mar 6". */
export function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins < 1)   { return 'just now'; }
    if (mins < 60)  { return `${mins}m ago`; }
    if (hours < 24) { return `${hours}h ago`; }
    if (days === 1) { return 'yesterday'; }
    if (days < 7)   { return `${days}d ago`; }
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
