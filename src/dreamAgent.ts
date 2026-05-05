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
const MAX_LOG_CHARS            = 12_000;
const MAX_TASK_LOGS            = 10;
const MAX_SESSION_LINES        = 30;
const IN_FLIGHT_GUARD_MINUTES  = 10;

// ── Dream state ────────────────────────────────────────────────────────────────

interface DreamState {
    last_run_ts: number;
    last_feedback_count: number;
}

function readDreamState(workspaceRoot: string): DreamState {
    const p = path.join(workspaceRoot, '.ollamapilot', 'dream_state.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return { last_run_ts: 0, last_feedback_count: 0 };
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
    currentCount: number;
    newFeedbackCount: number;
}

function shouldRunDream(workspaceRoot: string): GateResult {
    // Guard against concurrent in-flight runs: if proposed_rules.md was written
    // within the last IN_FLIGHT_GUARD_MINUTES, another cycle is probably in progress.
    const proposedPath = path.join(workspaceRoot, '.ollamapilot', 'proposed_rules.md');
    try {
        const stat = fs.statSync(proposedPath);
        if ((Date.now() - stat.mtimeMs) < IN_FLIGHT_GUARD_MINUTES * 60 * 1000) {
            return { run: false, reason: 'proposed_rules.md written recently — another cycle may be in flight', currentCount: 0, newFeedbackCount: 0 };
        }
    } catch { /* file doesn't exist — fine */ }

    const state = readDreamState(workspaceRoot);
    const hoursSinceLast = (Date.now() - state.last_run_ts) / 3_600_000;

    // Count feedback entries
    let currentCount = 0;
    const feedbackPath = path.join(workspaceRoot, '.ollamapilot', 'feedback.md');
    try {
        const content = fs.readFileSync(feedbackPath, 'utf8');
        currentCount = (content.match(/^## \[/gm) || []).length;
    } catch { /* no feedback yet */ }

    const newFeedbackCount = currentCount - state.last_feedback_count;

    if (newFeedbackCount < MIN_NEW_FEEDBACK_ENTRIES) {
        return { run: false, reason: `only ${newFeedbackCount} new feedback entries (need ${MIN_NEW_FEEDBACK_ENTRIES})`, currentCount, newFeedbackCount };
    }
    if (hoursSinceLast < MIN_HOURS_BETWEEN_RUNS) {
        return { run: false, reason: `last run was ${hoursSinceLast.toFixed(1)}h ago (need ${MIN_HOURS_BETWEEN_RUNS}h)`, currentCount, newFeedbackCount };
    }

    return { run: true, reason: 'conditions met', currentCount, newFeedbackCount };
}

// ── Log harvesting ─────────────────────────────────────────────────────────────

function harvestLogs(workspaceRoot: string): string {
    const parts: string[] = [];
    const ollamaDir = path.join(workspaceRoot, '.ollamapilot');

    // 1. Feedback entries
    try {
        const content = fs.readFileSync(path.join(ollamaDir, 'feedback.md'), 'utf8');
        parts.push(`## Feedback entries (behaviors the user flagged as problems)\n${content.trim()}`);
    } catch { /* no feedback file */ }

    // 2. Recent session logs (last N lines of sessions.jsonl)
    try {
        const raw = fs.readFileSync(path.join(ollamaDir, 'sessions.jsonl'), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean).slice(-MAX_SESSION_LINES);
        const summaries = lines.map(line => {
            try {
                const e: SessionLogEntry = JSON.parse(line);
                const guards = e.guardEvents?.map(g => g.type).join(', ') || 'none';
                const tools  = e.toolCalls?.map(t => t.name).join(', ') || 'none';
                return `[${e.ts?.slice(0, 10) ?? '?'}] ${e.outcome} | ${e.turns} turns | model:${e.model} | task:${e.task?.slice(0, 120)} | tools:${tools} | guards:${guards} | files:${(e.filesChanged || []).join(', ')}`;
            } catch { return null; }
        }).filter(Boolean);
        if (summaries.length) {
            parts.push(`## Recent session logs (last ${summaries.length} runs)\n${summaries.join('\n')}`);
        }
    } catch { /* no sessions file */ }

    // 3. Recent task logs (most recently modified, capped)
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

    return parts.join('\n\n').slice(0, MAX_LOG_CHARS);
}

// ── Dream agent prompt ─────────────────────────────────────────────────────────

const DREAM_SYSTEM_PROMPT = `\
You are a meta-learning agent for OllamaPilot. Your ONLY job is to read interaction \
history and extract durable behavioral rules. Do NOT write code. Do NOT use tools.

You will receive:
- feedback.md entries: behaviors the user flagged as problems (second-guessed, verbose, extra loops, etc.)
- Session logs: tasks run, tools called, turns taken, guard events that fired
- Task logs: step traces from multi-step agent tasks

From this evidence, produce a concise list of proposed behavioral rules for the main agent to follow \
in future sessions. Rules must be:
- Grounded in observed evidence (cite the pattern you saw)
- Actionable (specific enough that an agent can comply without ambiguity)
- Non-redundant (do not restate obvious things like "be concise")
- Scoped to this user's actual usage patterns

Output format — output ONLY rule blocks, nothing else:

## Rule: <short imperative title>
<One to three sentences. Describe what to do differently and cite the evidence. Should read \
naturally as a rule in a context.md "Learned Rules" section.>

## Rule: <next title>
...

If you find no actionable patterns worth proposing, output exactly:
NO_NEW_RULES

Do NOT output any preamble, explanation, commentary, or text outside the ## Rule: blocks.`;

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

function parseAndWriteRules(workspaceRoot: string, rawOutput: string): number {
    const trimmed = rawOutput.trim();
    if (!trimmed || trimmed === 'NO_NEW_RULES' || !trimmed.includes('## Rule:')) {
        return 0;
    }

    // Split on ## Rule: boundaries
    const blocks = trimmed.split(/(?=^## Rule:)/m).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) { return 0; }

    const now = new Date().toISOString();
    const header = `<!-- dream-agent: proposed rules generated ${now} -->\n<!-- Accept with command: OllamaPilot: Accept Proposed Rules -->\n\n`;
    const content = header + blocks.join('\n\n') + '\n';

    const ollamaDir = path.join(workspaceRoot, '.ollamapilot');
    if (!fs.existsSync(ollamaDir)) { fs.mkdirSync(ollamaDir, { recursive: true }); }
    fs.writeFileSync(path.join(ollamaDir, 'proposed_rules.md'), content, 'utf8');

    return blocks.length;
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

    logInfo(`[dream] Starting cycle (${gate.newFeedbackCount} new feedback entries, ${gate.currentCount} total)`);

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

    const ruleCount = parseAndWriteRules(workspaceRoot, rawOutput);

    // Always update state so we don't re-run on every reload if conditions remain met
    writeDreamState(workspaceRoot, { last_run_ts: Date.now(), last_feedback_count: gate.currentCount });

    if (ruleCount === 0) {
        logInfo('[dream] No actionable rules extracted');
        return;
    }

    logInfo(`[dream] Proposed ${ruleCount} rule(s) — notifying user`);

    const choice = await vscode.window.showInformationMessage(
        `OllamaPilot: Agent proposed ${ruleCount} new rule${ruleCount === 1 ? '' : 's'} from your feedback. Review and accept to apply.`,
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
