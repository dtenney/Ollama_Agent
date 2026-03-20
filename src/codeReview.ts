import { getGitDiff, getGitDiffForRange } from './gitContext';
import { logInfo, logWarn } from './logger';

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
    const result = await getGitDiffForRange(root, commitRange);
    if (!result || result.clean) { return null; }

    const prompt =
        `Review these changes (${commitRange}). First check project memory for relevant conventions, then for each file note:\n` +
        `- Potential bugs or logic errors\n` +
        `- Security concerns\n` +
        `- Style or readability improvements\n` +
        `- Missing error handling\n\n` +
        `Be concise. If everything looks good, say so.\n\n` +
        `**Changes** (${result.summary}):\n` +
        `\`\`\`diff\n${result.diff}\n\`\`\``;

    return { prompt, diffSummary: result.summary };
}
