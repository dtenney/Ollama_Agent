import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn, toErrorMessage } from './logger';

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitDiffResult {
    /** Short one-line summary: "3 files changed, 42 insertions, 7 deletions" */
    summary: string;
    /** Combined staged + unstaged diff, truncated. */
    diff: string;
    /** True if the diff was truncated to MAX_DIFF_CHARS. */
    truncated: boolean;
    /** True if there are no uncommitted changes. */
    clean: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum diff characters to inject into context. */
const MAX_DIFF_CHARS = 8_000;
/** Timeout for git commands (ms). */
const GIT_TIMEOUT_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `root` is inside a git repository. */
export function isGitRepo(root: string): boolean {
    try {
        // Walk up looking for .git
        let dir = root;
        for (let i = 0; i < 8; i++) {
            if (fs.existsSync(path.join(dir, '.git'))) { return true; }
            const parent = path.dirname(dir);
            if (parent === dir) { break; }
            dir = parent;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Get a concise summary of uncommitted changes in the workspace.
 * Returns null if git is not available or the folder is not a repo.
 */
export async function getGitDiff(root: string): Promise<GitDiffResult | null> {
    if (!isGitRepo(root)) {
        logInfo('[gitContext] Not a git repo — skipping diff injection');
        return null;
    }

    const opts = { cwd: root, timeout: GIT_TIMEOUT_MS };

    try {
        // First check if there are any changes at all
        const { stdout: statusOut } = await execAsync('git status --short', opts);
        if (!statusOut.trim()) {
            return { summary: 'Working tree clean', diff: '', truncated: false, clean: true };
        }

        // Get human-readable stat summary
        let summary = '';
        try {
            const { stdout: stat } = await execAsync('git diff --stat HEAD 2>/dev/null || git diff --stat', opts);
            const statLines = stat.trim().split('\n');
            summary = statLines[statLines.length - 1]?.trim() ?? '';
        } catch { /* fallback below */ }

        if (!summary) {
            // Fallback: summarise from git status --short
            const lines = statusOut.trim().split('\n');
            summary = `${lines.length} file${lines.length > 1 ? 's' : ''} modified`;
        }

        // Get the actual diff (staged + unstaged combined)
        let diff = '';
        try {
            const [staged, unstaged] = await Promise.all([
                execAsync('git diff --cached', opts).then((r) => r.stdout).catch(() => ''),
                execAsync('git diff',          opts).then((r) => r.stdout).catch(() => ''),
            ]);
            // Deduplicate: if a file is both staged and has unstaged changes, prefer the full version
            diff = (staged + unstaged).trim();
        } catch { /* best-effort */ }

        if (!diff) {
            // Last resort: just show the status lines
            diff = `git status:\n${statusOut}`;
        }

        const truncated = diff.length > MAX_DIFF_CHARS;
        if (truncated) {
            logWarn(`[gitContext] Diff truncated at ${MAX_DIFF_CHARS} chars`);
            diff = diff.slice(0, MAX_DIFF_CHARS) + '\n\n… (diff truncated)';
        }

        logInfo(`[gitContext] Diff ready — ${diff.length} chars (truncated: ${truncated})`);
        return { summary, diff, truncated, clean: false };

    } catch (err) {
        logWarn(`[gitContext] Failed: ${toErrorMessage(err)}`);
        return null;
    }
}

/**
 * Get a diff for a specific commit range (e.g. "HEAD~1", "main..feature").
 * Returns null if git is unavailable or the range produces no diff.
 */
export async function getGitDiffForRange(root: string, commitRange: string): Promise<GitDiffResult | null> {
    if (!isGitRepo(root)) { return null; }
    const opts = { cwd: root, timeout: GIT_TIMEOUT_MS * 2 };

    try {
        const { stdout: diff } = await execAsync(`git diff ${commitRange}`, opts);
        if (!diff.trim()) { return { summary: 'No changes', diff: '', truncated: false, clean: true }; }

        let summary = '';
        try {
            const { stdout: stat } = await execAsync(`git diff --stat ${commitRange}`, opts);
            const statLines = stat.trim().split('\n');
            summary = statLines[statLines.length - 1]?.trim() ?? '';
        } catch { /* fallback */ }
        if (!summary) { summary = 'changes found'; }

        const truncated = diff.length > MAX_DIFF_CHARS;
        const clipped = truncated ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n… (diff truncated)' : diff;

        return { summary, diff: clipped, truncated, clean: false };
    } catch {
        return null;
    }
}

// ── Smart diff relevance ──────────────────────────────────────────────────────

/** Keywords that suggest the user is asking about recent changes. */
const CHANGE_KEYWORDS = /\b(change[ds]?|diff|commit|uncommitted|staged|unstaged|modified|broke|break|breaking|fail|failing|bug|regress|recent|last\s+edit|what\s+did\s+i|review\s+(my|the|code)|what('s|\s+is)\s+(wrong|different)|undo|revert|working\s+on)\b|\b(fix|fixing|fixed)\s+(this|that|the|my|it|bug|issue|error)|\b(getting|got|seeing|having|hit|throws?)\s+(an?\s+)?error/i;

/** Returns true if the user message appears to be about code changes. */
export function isChangeRelated(message: string): boolean {
    return CHANGE_KEYWORDS.test(message);
}

/**
 * Build the context block to inject into the user message.
 * When `userMessage` is provided, only injects the diff if the message
 * appears to be about recent changes (smart mode). Pass `undefined` to
 * always inject (legacy behaviour).
 * Returns an empty string if there are no changes or git is unavailable.
 */
export async function buildGitDiffContext(root: string, userMessage?: string): Promise<string> {
    // Smart filtering: skip diff when the message isn't change-related
    if (userMessage !== undefined && !isChangeRelated(userMessage)) {
        logInfo('[gitContext] Message not change-related — skipping diff injection');
        return '';
    }

    const result = await getGitDiff(root);
    if (!result || result.clean || !result.diff) { return ''; }

    return (
        `\n\n<git-diff summary="${result.summary}"${result.truncated ? ' truncated="true"' : ''}>\n` +
        `\`\`\`diff\n${result.diff}\n\`\`\`` +
        `\n</git-diff>`
    );
}
