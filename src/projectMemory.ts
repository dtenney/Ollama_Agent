import * as vscode from 'vscode';
import { logInfo, logError } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryNote {
    id: string;
    content: string;
    /** ISO timestamp of when the note was written. */
    createdAt: string;
    /** Optional free-form tag for filtering (e.g. "architecture", "bug", "todo"). */
    tag?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY  = 'ollamaAgent.projectMemory';
const MAX_NOTES    = 200;
const MAX_NOTE_LEN = 4_000;

// ── ProjectMemory ─────────────────────────────────────────────────────────────

/**
 * Workspace-scoped persistent memory for the AI agent.
 * Uses vscode.ExtensionContext.workspaceState so notes are automatically
 * segregated per workspace folder with no additional key namespacing needed.
 */
export class ProjectMemory {
    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Return all notes, most recent first. */
    list(): MemoryNote[] {
        return this.context.workspaceState.get<MemoryNote[]>(STORAGE_KEY, []);
    }

    /** Add a new note. Returns the created note. */
    async add(content: string, tag?: string): Promise<MemoryNote> {
        if (!content.trim()) { throw new Error('Note content cannot be empty'); }
        const trimmed = content.slice(0, MAX_NOTE_LEN);
        const note: MemoryNote = {
            id:        `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            content:   trimmed,
            createdAt: new Date().toISOString(),
            ...(tag ? { tag: tag.trim().slice(0, 40) } : {}),
        };
        const notes = [note, ...this.list()].slice(0, MAX_NOTES);
        await this.context.workspaceState.update(STORAGE_KEY, notes);
        logInfo(`[memory] Note added (${note.id}): "${trimmed.slice(0, 60)}…"`);
        return note;
    }

    /** Update the content of an existing note by id. */
    async update(id: string, content: string): Promise<boolean> {
        const notes = this.list();
        const idx = notes.findIndex((n) => n.id === id);
        if (idx === -1) { return false; }
        notes[idx] = { ...notes[idx], content: content.slice(0, MAX_NOTE_LEN) };
        await this.context.workspaceState.update(STORAGE_KEY, notes);
        logInfo(`[memory] Note updated (${id})`);
        return true;
    }

    /** Delete a note by id. */
    async delete(id: string): Promise<boolean> {
        const before = this.list();
        const after  = before.filter((n) => n.id !== id);
        if (after.length === before.length) { return false; }
        await this.context.workspaceState.update(STORAGE_KEY, after);
        logInfo(`[memory] Note deleted (${id})`);
        return true;
    }

    /** Clear all notes for this workspace. */
    async clearAll(): Promise<void> {
        await this.context.workspaceState.update(STORAGE_KEY, []);
        logInfo('[memory] All notes cleared');
    }

    /**
     * Format all notes as a readable string for the agent tool response.
     */
    formatAll(): string {
        const notes = this.list();
        if (!notes.length) { return '(no notes saved yet)'; }
        return notes
            .map((n, i) =>
                `[${i + 1}] id=${n.id}${n.tag ? ` tag=${n.tag}` : ''} (${n.createdAt.slice(0, 10)})\n${n.content}`
            )
            .join('\n\n');
    }
}
