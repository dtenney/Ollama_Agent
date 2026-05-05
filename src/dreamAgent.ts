/**
 * Dream agent: offline, asynchronous consolidation of interaction logs into
 * proposed behavioral rules.
 *
 * Runs as a background Agent instance (no UI) during low-load times. Reads
 * session logs, feedback entries, and task logs, then produces candidate rules
 * written to .ollamapilot/proposed_rules.md. A VS Code notification prompts
 * the user to review and accept them via the "OllamaPilot: Accept Proposed Rules"
 * command, which merges accepted rules into .ollamapilot/context.md.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent, PostFn } from './agent';
import { getConfig } from './config';
import { logInfo, logError, toErrorMessage } from './logger';
import { TieredMemoryManager } from './memoryCore';
import { CodeIndexer } from './codeIndex';
import type { SessionLogEntry } from './sessionLog';

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_NEW_FEEDBACK_ENTRIES = 3;
const MIN_HOURS_BETWEEN_RUNS   = 6;
const MAX_LOG_CHARS            = 16_000;
const MAX_TASK_LOGS            = 10;
const MAX_SESSION_LINES        = 40;
const IN_FLIGHT_GUARD_MINUTES  = 10;

/** Sessions with ≤ this many turns and no guard events are considered efficient */
const EFFICIENT_TURN_THRESHOLD = 3;
/** Sessions with ≥ this many turns or any guard events are considered slow */
const SLOW_TURN_THRESHOLD      = 6;

// ── Dream state ────────────────────────────────────────────────────────────────

interface DreamState {
    last_run_ts: number;
    last_feedback_count: number;
    last_positive_count: number;
}

function readDreamState(workspaceRoot: string): DreamState {
    const p = path.join(workspaceRoot, '.ollamapilot', 'dream_state.json');
    try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { last_run_ts: s.last_run_ts ?? 0, last_feedback_count: s.last_feedback_count ?? 0, last_positive_count: s.last_positive_count ?? 0 };
    } catch {
        return { last_run_ts: 0, last_feedback_count: 0, last_positive_count: 0 };
    }
}

function writeDreamState(workspaceRoot: string, state: DreamState): void {
    const p = path.join(workspaceRoot, '.ollamapilot', 'dream_state.json');
    try { fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8'); }
    catch { /* non-fatal */ }
}

// ── Rate gate ──────────────────────────────────────────────────────────────────

interface GateResult {
    run: boolean;
    reason: string;
    currentFeedbackCount: number;
    newFeedbackCount: number;
    currentPositiveCount: number;
}

function shouldRunDream(workspaceRoot: string): GateResult {
    // Guard against concurrent in-flight runs: if proposed_rules.md was written
    // within the last IN_FLIGHT_GUARD_MINUTES, another cycle is probably in progress.
    const proposedPath = path.join(workspaceRoot, '.ollamapilot', 'proposed_rules.md');
    try {
        const stat = fs.statSync(proposedPath);
        if ((Date.now() - stat.mtimeMs) < IN_FLIGHT_GUARD_MINUTES * 60 * 1000) {
            return { run: false, reason: 'proposed_rules.md written recently — another cycle may be in flight', currentFeedbackCount: 0, newFeedbackCount: 0, currentPositiveCount: 0 };
        }
    } catch { /* file doesn't exist — fine */ }

    const state = readDreamState(workspaceRoot);
    const hoursSinceLast = (Date.now() - state.last_run_ts) / 3_600_000;

    // Count negative feedback entries
    let currentFeedbackCount = 0;
    const feedbackPath = path.join(workspaceRoot, '.ollamapilot', 'feedback.md');
    try {
        const content = fs.readFileSync(feedbackPath, 'utf8');
        currentFeedbackCount = (content.match(/^## \[/gm) || []).length;
    } catch { /* no feedback yet */ }

    // Count positive feedback entries (used as signal, not as gate condition)
    let currentPositiveCount = 0;
    const positivePath = path.join(workspaceRoot, '.ollamapilot', 'positive_feedback.md');
    try {
        const content = fs.readFileSync(positivePath, 'utf8');
        currentPositiveCount = (content.match(/^## \[/gm) || []).length;
    } catch { /* no positive feedback yet */ }

    const newFeedbackCount = currentFeedbackCount - state.last_feedback_count;

    if (newFeedbackCount < MIN_NEW_FEEDBACK_ENTRIES) {
        return { run: false, reason: `only ${newFeedbackCount} new feedback entries (need ${MIN_NEW_FEEDBACK_ENTRIES})`, currentFeedbackCount, newFeedbackCount, currentPositiveCount };
    }
    if (hoursSinceLast < MIN_HOURS_BETWEEN_RUNS) {
        return { run: false, reason: `last run was ${hoursSinceLast.toFixed(1)}h ago (need ${MIN_HOURS_BETWEEN_RUNS}h)`, currentFeedbackCount, newFeedbackCount, currentPositiveCount };
    }

    return { run: true, reason: 'conditions met', currentFeedbackCount, newFeedbackCount, currentPositiveCount };
}

// ── Log harvesting ─────────────────────────────────────────────────────────────

function harvestLogs(workspaceRoot: string): string {
    const parts: string[] = [];
    const ollamaDir = path.join(workspaceRoot, '.ollamapilot');

    // 1. Negative feedback entries (problems the user flagged)
    try {
        const content = fs.readFileSync(path.join(ollamaDir, 'feedback.md'), 'utf8');
        parts.push(`## Negative feedback (behaviors the user flagged as problems)\n${content.trim()}`);
    } catch { /* no feedback file */ }

    // 2. Positive feedback entries (responses the user marked helpful)
    try {
        const content = fs.readFileSync(path.join(ollamaDir, 'positive_feedback.md'), 'utf8');
        parts.push(`## Positive feedback (responses the user found helpful — reinforce these patterns)\n${content.trim()}`);
    } catch { /* no positive feedback yet */ }

    // 3. Session quality analysis — bucket into efficient vs slow for contrast
    try {
        const raw = fs.readFileSync(path.join(ollamaDir, 'sessions.jsonl'), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean).slice(-MAX_SESSION_LINES);

        const efficient: string[] = [];
        const slow: string[] = [];
        const other: string[] = [];

        for (const line of lines) {
            try {
                const e: SessionLogEntry = JSON.parse(line);
                const guards = e.guardEvents?.map(g => g.type).join(', ') || 'none';
                const tools  = e.toolCalls?.map(t => t.name).join(', ') || 'none';
                const summary = `[${e.ts?.slice(0, 10) ?? '?'}] ${e.outcome} | ${e.turns} turns | task:${e.task?.slice(0, 100)} | tools:${tools} | guards:${guards}`;
                const hasGuards = guards !== 'none';
                const turns = e.turns ?? 0;
                if (!hasGuards && turns <= EFFICIENT_TURN_THRESHOLD) {
                    efficient.push(summary);
                } else if (hasGuards || turns >= SLOW_TURN_THRESHOLD) {
                    slow.push(summary);
                } else {
                    other.push(summary);
                }
            } catch { /* skip malformed line */ }
        }

        if (efficient.length) {
            parts.push(`## Efficient sessions (≤${EFFICIENT_TURN_THRESHOLD} turns, no guards — what is working well)\n${efficient.join('\n')}`);
        }
        if (slow.length) {
            parts.push(`## Slow/problematic sessions (≥${SLOW_TURN_THRESHOLD} turns or guards fired — what needs improvement)\n${slow.join('\n')}`);
        }
        if (other.length) {
            parts.push(`## Other sessions\n${other.join('\n')}`);
        }
    } catch { /* no sessions file */ }

    // 4. Recent task logs (most recently modified, capped)
    try {
        const tasksDir = path.join(ollamaDir, 'tasks');
        const subdirs = fs.readdirSync(tasksDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => {
                const logPath = path.join(tasksDir, e.name, 'log.md');
                try { return { logPath, mtime: fs.statSync(logPath).mtimeMs }; }
                catch { return null; }
            })
            .filter((x): x is { logPath: string; mtime: number } => x !== null)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, MAX_TASK_LOGS);

        const taskParts: string[] = [];
        for (const { logPath } of subdirs) {
            try {
                const content = fs.readFileSync(logPath, 'utf8').slice(0, 800);
                taskParts.push(content.trim());
            } catch { /* unreadable */ }
        }
        if (taskParts.length) {
            parts.push(`## Recent task logs\n${taskParts.join('\n\n---\n\n')}`);
        }
    } catch { /* no tasks dir */ }

    // 5. Existing learned rules (so the dream agent can identify stale/contradictory ones)
    try {
        const contextPath = path.join(ollamaDir, 'context.md');
        const content = fs.readFileSync(contextPath, 'utf8');
        const rulesIdx = content.indexOf('## Learned Rules');
        if (rulesIdx !== -1) {
            const rulesSection = content.slice(rulesIdx).slice(0, 2000).trim();
            parts.push(`## Currently active learned rules (identify any that are stale, contradicted by new evidence, or should be removed)\n${rulesSection}`);
        }
    } catch { /* no context.md */ }

    // 6. Existing skills (so the dream agent knows what reusable helpers exist)
    try {
        const skillsDir = path.join(ollamaDir, 'skills');
        const skills = fs.readdirSync(skillsDir).filter(f => f.endsWith('.py') || f.endsWith('.sh') || f.endsWith('.js'));
        if (skills.length) {
            const skillList = skills.map(f => {
                try {
                    const header = fs.readFileSync(path.join(skillsDir, f), 'utf8').split('\n').slice(0, 3).join(' | ');
                    return `  - ${f}: ${header.slice(0, 120)}`;
                } catch { return `  - ${f}`; }
            }).join('\n');
            parts.push(`## Available skills (.ollamapilot/skills/)\n${skillList}`);
        }
    } catch { /* no skills dir */ }

    return parts.join('\n\n').slice(0, MAX_LOG_CHARS);
}

// ── Dream agent prompt ─────────────────────────────────────────────────────────

const DREAM_SYSTEM_PROMPT = `\
You are a meta-learning agent for OllamaPilot. Your job is to analyze interaction history \
and produce a set of proposed changes to the agent's behavioral rules. Do NOT write code. Do NOT use tools.

You will receive:
- Negative feedback: responses the user flagged as problematic (second-guessing, verbosity, wrong tools, etc.)
- Positive feedback: responses the user marked as helpful — these patterns should be reinforced
- Session quality analysis: efficient sessions (≤3 turns, no guards) vs slow/problematic ones (≥6 turns or guards fired)
- Recent task logs: step traces from multi-step agent tasks
- Currently active learned rules: the rules already in context.md — review for staleness or contradictions
- Available skills: reusable helper scripts already in .ollamapilot/skills/

From this evidence, produce proposed rule changes. Each output block must be one of:

## Rule: <short imperative title>
<One to three sentences. Describe what the agent should do and cite the evidence. Must be \
grounded in observed patterns — positive OR negative. Should read naturally as a rule in \
a context.md "Learned Rules" section.>

## Remove Rule: <exact title of existing rule to remove>
<One sentence explaining why this rule is now stale, contradicted, or no longer needed.>

Rules you ADD must be:
- Grounded in observed evidence (cite the pattern — both good and bad sessions)
- Actionable (specific enough that an agent can comply without ambiguity)
- Non-redundant (do not restate rules already in the active learned rules section)
- Covering both things to STOP doing (from negative feedback) and things to KEEP doing (from positive feedback)

Rules you REMOVE must match the exact title of an existing rule in the "Currently active learned rules" section.

If you find no actionable changes, output exactly:
NO_NEW_RULES

Do NOT output any preamble, explanation, commentary, or text outside the ## Rule: and ## Remove Rule: blocks.`;

// ── Dream execution ────────────────────────────────────────────────────────────

async function executeDream(
    workspaceRoot: string,
    logContent: string,
    memory: TieredMemoryManager | null,
    codeIndexer: CodeIndexer | null,
    model: string,
): Promise<string> {
    const agent = new Agent(workspaceRoot, memory, codeIndexer);

    let output = '';
    const silentPost: PostFn = (m) => {
        const msg = m as { type: string; text?: string };
        if (msg.type === 'token' && msg.text) { output += msg.text; }
    };

    const userMessage = `${DREAM_SYSTEM_PROMPT}\n\n---\n\nAnalyze the following interaction history and propose behavioral rules:\n\n${logContent}`;
    await agent.run(userMessage, model, silentPost);
    return output;
}

// ── Rule parsing and writing ───────────────────────────────────────────────────

interface ParsedProposals {
    addBlocks: string[];
    removeBlocks: string[];  // each is "## Remove Rule: <title>\n<reason>"
}

function parseProposals(rawOutput: string): ParsedProposals {
    const trimmed = rawOutput.trim();
    if (!trimmed || trimmed === 'NO_NEW_RULES') {
        return { addBlocks: [], removeBlocks: [] };
    }

    // Split on ## Rule: or ## Remove Rule: boundaries
    const blocks = trimmed.split(/(?=^## (?:Remove )?Rule:)/m).map(b => b.trim()).filter(Boolean);
    const addBlocks = blocks.filter(b => b.startsWith('## Rule:'));
    const removeBlocks = blocks.filter(b => b.startsWith('## Remove Rule:'));
    return { addBlocks, removeBlocks };
}

function parseAndWriteRules(workspaceRoot: string, rawOutput: string): { added: number; removed: number } {
    const { addBlocks, removeBlocks } = parseProposals(rawOutput);
    if (addBlocks.length === 0 && removeBlocks.length === 0) {
        return { added: 0, removed: 0 };
    }

    const now = new Date().toISOString();
    const parts: string[] = [
        `<!-- dream-agent: proposed changes generated ${now} -->`,
        `<!-- Accept with command: OllamaPilot: Accept Proposed Rules -->`,
        '',
    ];

    if (addBlocks.length) {
        parts.push('<!-- NEW RULES TO ADD -->', ...addBlocks.map(b => b + '\n'));
    }
    if (removeBlocks.length) {
        parts.push('<!-- EXISTING RULES TO REMOVE -->', ...removeBlocks.map(b => b + '\n'));
    }

    const ollamaDir = path.join(workspaceRoot, '.ollamapilot');
    if (!fs.existsSync(ollamaDir)) { fs.mkdirSync(ollamaDir, { recursive: true }); }
    fs.writeFileSync(path.join(ollamaDir, 'proposed_rules.md'), parts.join('\n'), 'utf8');

    return { added: addBlocks.length, removed: removeBlocks.length };
}

// ── Public entry point ─────────────────────────────────────────────────────────

export async function runDreamCycle(
    workspaceRoot: string,
    memory: TieredMemoryManager | null,
    codeIndexer: CodeIndexer | null,
): Promise<void> {
    const gate = shouldRunDream(workspaceRoot);
    if (!gate.run) {
        logInfo(`[dream] Skipped — ${gate.reason}`);
        return;
    }

    logInfo(`[dream] Starting cycle (${gate.newFeedbackCount} new negative feedback entries, ${gate.currentPositiveCount} positive total)`);

    const logContent = harvestLogs(workspaceRoot);
    if (!logContent.trim()) {
        logInfo('[dream] No log content to analyze — skipping');
        return;
    }

    const model = getConfig().model;
    let rawOutput: string;
    try {
        rawOutput = await executeDream(workspaceRoot, logContent, memory, codeIndexer, model);
    } catch (err) {
        logError(`[dream] Agent run failed: ${toErrorMessage(err)}`);
        return;
    }

    const { added, removed } = parseAndWriteRules(workspaceRoot, rawOutput);

    // Always update state so we don't re-run on every reload if conditions remain met
    writeDreamState(workspaceRoot, {
        last_run_ts: Date.now(),
        last_feedback_count: gate.currentFeedbackCount,
        last_positive_count: gate.currentPositiveCount,
    });

    if (added === 0 && removed === 0) {
        logInfo('[dream] No actionable rule changes proposed');
        return;
    }

    logInfo(`[dream] Proposed ${added} new rule(s), ${removed} removal(s) — notifying user`);

    const summary = [
        added   ? `${added} new rule${added === 1 ? '' : 's'}` : '',
        removed ? `${removed} rule${removed === 1 ? '' : 's'} to remove` : '',
    ].filter(Boolean).join(' and ');

    const choice = await vscode.window.showInformationMessage(
        `OllamaPilot: Agent proposed ${summary} based on your feedback. Review and accept to apply.`,
        'Review', 'Dismiss'
    );
    if (choice === 'Review') {
        const rulesPath = path.join(workspaceRoot, '.ollamapilot', 'proposed_rules.md');
        try {
            const doc = await vscode.workspace.openTextDocument(rulesPath);
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            logError(`[dream] Could not open proposed_rules.md: ${toErrorMessage(err)}`);
        }
    }
}
