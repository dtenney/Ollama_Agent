import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getGitDiff } from './gitContext';
import { logInfo, logWarn } from './logger';

const execAsync = promisify(exec);

export interface ReviewRequest {
    prompt: string;
    diffSummary: string;
}

/**
 * Build a code review prompt from the current git diff.
 * Returns null if there are no changes or git is unavailable.
 */
export async function buildReviewRequest(root: string): Promise<ReviewRequest | null> {
    const result = await getGitDiff(root);

    if (!result) {
        logWarn('[codeReview] Git not available');
        return null;
    }

    if (result.clean) {
        return null;
    }

    const prompt =
        `Review my uncommitted changes. First check project memory for relevant conventions, then for each file note:\n` +
        `- Potential bugs or logic errors\n` +
        `- Security concerns\n` +
        `- Style or readability improvements\n` +
        `- Missing error handling\n\n` +
        `Be concise. If everything looks good, say so.\n\n` +
        `**Changes** (${result.summary}):\n` +
        `\`\`\`diff\n${result.diff}\n\`\`\``;

    logInfo(`[codeReview] Built review prompt — ${result.summary}`);
    return { prompt, diffSummary: result.summary };
}

/**
 * Build a review prompt for a specific commit range.
 */
export async function buildCommitReviewRequest(
    root: string,
    commitRange: string
): Promise<ReviewRequest | null> {
    try {
        const opts = { cwd: root, timeout: 10_000 };
        const { stdout: diff } = await execAsync(`git diff ${commitRange}`, opts);
        const { stdout: stat } = await execAsync(`git diff --stat ${commitRange}`, opts);

        if (!diff.trim()) { return null; }

        const statLines = stat.trim().split('\n');
        const summary = statLines[statLines.length - 1]?.trim() ?? '';

        const MAX = 8_000;
        const truncated = diff.length > MAX;
        const clipped = truncated ? diff.slice(0, MAX) + '\n\n… (diff truncated)' : diff;

        const prompt =
            `Review these changes (${commitRange}). First check project memory for relevant conventions, then for each file note:\n` +
            `- Potential bugs or logic errors\n` +
            `- Security concerns\n` +
            `- Style or readability improvements\n` +
            `- Missing error handling\n\n` +
            `Be concise. If everything looks good, say so.\n\n` +
            `**Changes** (${summary}):\n` +
            `\`\`\`diff\n${clipped}\n\`\`\``;

        return { prompt, diffSummary: summary };
    } catch {
        return null;
    }
}
