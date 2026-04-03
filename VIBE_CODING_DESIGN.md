# OllamaPilot — Vibe Coding Design
## "How to get reliable code out of a 7B model, locally, every time"

**Date:** March 2026
**Status:** Design proposal — discuss before implementing

---

## The Core Problem

We are asking a 7B parameter model to do something hard: understand a real project it has never seen, find the right files, write code that fits the existing patterns, and not break anything adjacent. Frontier models do this via raw capability. We cannot do that — but we can **compensate architecturally**.

The failures cluster into four categories:

### 1. The model doesn't know enough before it writes
The model is asked to add a field to a form. It doesn't know:
- Which file the form is actually in (it guesses a stub)
- What fields already exist (it may duplicate or conflict)
- What the JS submit handler expects (it adds HTML but not the JS key)
- Whether the column already exists in the model

**Result:** Plausible-looking code that doesn't work.

### 2. The model forgets what it found mid-task
Context fills up. Messages get dropped. The original task disappears. The model re-explores files it already read, draws different conclusions, and starts going in circles. Or worse — auto-compaction silently drops the "I found that the real form is in cashier_dashboard.html" message and the model goes back to editing the stub.

**Result:** Infinite loops. Repeated wrong actions.

### 3. The model doesn't know what "done" looks like
There is no completion check. After writing HTML, did the JS get updated too? After adding a column, was the form field actually added? The model declares success without verifying. The extension doesn't verify either.

**Result:** Half-done features. Silent failures. User discovers bugs later.

### 4. Cross-session amnesia
Every new session starts cold. The model re-discovers the project structure, re-identifies the real template file, re-learns the patterns. Memory exists but is not reliably populated or recalled.

**Result:** The same mistakes get made in every session.

---

## The Design Response

Each failure has a targeted architectural fix. These are ordered by impact.

---

## Fix 1: Pre-Task Briefing — "Know Before You Write"

**What:** Before the model makes a single tool call, the extension programmatically assembles a **task briefing** — a structured block of verified facts injected into the user message.

**What we already have in `preProcessEditTask()`:**
- Target file content (line-numbered)
- Models inventory (real class names from `app/models/`)
- Route/function/field inventory (what's already defined)
- Pattern example (existing route to copy)
- Caller impact (transitive call graph)
- Pre-validation warnings (schema changes need migration, etc.)

**What's missing:**

### 1a. Full-stack breadcrumb for form tasks
When the task involves a form (add field, update field, form submission):
- Find the HTML template **and** the JS submit handler automatically
- Find the backend route that processes the form POST
- Inject all three into the briefing: "HTML is here (line X), JS submits here (line Y), route processes here (line Z)"

Current state: model reads the model file, then has to find the template itself — and keeps finding the stub.

### 1b. Template disambiguation
When the task involves HTML and a stub exists:
- Detect stub at briefing time (not just at edit time)
- Auto-search for the real template
- Inject: "FOUND: The real form is in `cashier_dashboard.html` at line 847. The stub at `cashier/transaction_form.html` is a placeholder — do not edit it."

This moves the stub block from a reactive error to a proactive briefing.

### 1c. Column/field existence check
When the task says "add X field/column":
- Check if the column already exists in the model file before injecting
- If it exists: inject "column `transaction_notes` already exists in Transaction model at line 23 — do NOT add it again. Your task is to add it to the HTML form and JS handler."
- If it doesn't: inject "column does not exist yet — you'll need to add it to the model AND the form AND the JS handler."

This eliminates the most common "agent adds a duplicate column" failure.

---

## Fix 2: Structured Compaction — "What I Know, Preserved"

**What:** When context compaction fires, extract structured facts from the dropped messages and save them to memory — not just a vague 2-sentence summary.

**Current state:** Auto-compact at 99% just slices `history` and injects the task message. Manual compact generates a 2-sentence LLM summary injected as `[Earlier conversation summary]` in history. Neither saves anything to memory.

**What to do instead:**

### 2a. Structured summary extraction
Replace the "summarize in 2-3 sentences" prompt with a structured extraction prompt:

```
Extract the following from this conversation as JSON:
{
  "task": "one sentence — what was being worked on",
  "files_confirmed": ["list of real file paths that were found and confirmed correct"],
  "files_ruled_out": ["stub files, wrong paths, files that don't exist"],
  "decisions": ["key decisions made, e.g. 'column already exists — skip adding it'"],
  "edits_made": ["describe each edit_file that succeeded"],
  "blockers": ["anything that failed or was unclear"],
  "next_step": "what should happen next if the task isn't done"
}
Output only the JSON.
```

### 2b. Save to memory on compaction
After extraction, save the result to **Tier 2 (Operational)** with tags `['compaction', 'session']`. This means:
- The next turn (after compaction) loads the structured facts from memory
- The next session starts with these facts already in context
- The model doesn't re-discover what it already found

### 2c. Session-end save
When a conversation ends (model posts a final response with no tool calls, or user closes panel), trigger the same extraction and save to **Tier 3 (Collaboration)** — more durable than Tier 2.

This turns every completed session into a knowledge deposit.

---

## Fix 3: Completion Verification — "Did It Actually Work?"

**What:** After a file edit, the extension checks whether the task appears complete — not just whether the syntax is valid.

**Current state:** `syntaxCheck()` runs `py_compile` after every Python edit. `get_diagnostics` is available but not called automatically.

**What's missing:**

### 3a. Task-specific post-edit checklist
Based on the task type, verify:

| Task type | Checks |
|---|---|
| Add field to form | HTML has the new input; JS submit object includes the new key; backend route reads the new field |
| Add route | Route is defined in the file; route is registered on the blueprint; no syntax errors |
| Add model column | Column exists in model; migration reminder injected |
| Fix bug | Error pattern no longer present in the file |

These are programmatic checks — regex/grep, not model judgment.

### 3b. Verification result injected as tool result
If verification finds a gap: "edit_file succeeded but JS submit handler at line 234 does not include `transaction_notes`. You still need to update the JS." The model gets a specific nudge to finish.

If verification passes: "Verified: HTML field added, JS handler updated, backend reads the field. Task appears complete."

---

## Fix 4: Session Memory — "Remember What You Found"

**What:** Systematically populate memory from what the agent discovers during a session so the next session starts smarter.

**Current state:** Memory save is mostly model-driven (model calls `memory_tier_write`). The model forgets to save, or saves vague things. Auto-save fires for shell environment but nothing else automatically.

**What to do:**

### 4a. Auto-save discoveries from `preProcessEditTask`
When the pre-processor resolves a target file (especially via stub detection or search), save to Tier 2:
- "The real transaction form is at `app/templates/cashier/cashier_dashboard.html` (271KB). The stub at `cashier/transaction_form.html` is a placeholder."
- "Transaction model has columns: id, customer_id, amount, completed_at, transaction_notes."

These are facts the extension just proved programmatically. Save them immediately, not via the model.

### 4b. Auto-save from successful edits
After a confirmed `edit_file` completes:
- Save: "Added `notes` field to transaction form in `cashier_dashboard.html` at approx line 847 (March 2026)."
- Tier 2 (Operational) — useful for this week's work, will age into archive.

### 4c. Memory-first project briefing
On session start (first message from user), if memory has entries:
- Load Tier 0–2 (already done)
- Add a "Recent work" block to the system prompt: the last 3 Tier 2 entries, sorted by `lastAccessed`
- This gives the model "what we were doing last time" without searching

---

## Fix 5: Task State Machine — "Where Are We In This Task?"

**What:** Track multi-step tasks as explicit state, not implicit history.

**Current state:** The model tracks task state in conversation history. When history is compacted, the state is lost. The model doesn't know if it's on step 1 (find the file) or step 3 (update the JS).

**What to do:**

### 5a. Task object
When a task starts (`run()` is called), create a lightweight task object:
```typescript
interface ActiveTask {
  message: string;           // original user message
  type: 'add_field' | 'fix_bug' | 'add_route' | 'refactor' | 'query' | 'other';
  steps: TaskStep[];         // what needs to happen
  completed: string[];       // steps confirmed done
  blockers: string[];        // what's in the way
  filesConfirmed: string[];  // real file paths proven correct
}
```

### 5b. Task state survives compaction
When `compactHistory()` runs, the task object is NOT in history — it's on the agent instance. It survives compaction. The context note injected after compaction becomes:
```
[TASK STATE] Working on: "Add a note field to the transaction form"
Steps: [find HTML form ✓, find JS handler ✓, add HTML field —, add JS key —, verify —]
Files confirmed: cashier_dashboard.html (real form), cashier.js (submit handler)
```

### 5c. Step completion from verification (Fix 3)
When post-edit verification passes a step, mark it done in the task object. This gives the model a clear "what's left" signal even after context compaction.

---

## Fix 6: Smarter Model Prompting

**What:** Reduce what the model has to decide, infer, or remember.

### 6a. Task-type–specific system prompt suffix
Different tasks need different instructions. Instead of one giant system prompt:
- **Add field to form:** "You have been given the HTML, JS, and backend route. Add the field to all three. Do not stop after one. The task is complete only when all three files have been edited."
- **Fix bug:** "Read the error, find the line, fix it. Do not describe the fix — apply it."
- **Add route:** "Copy the pattern exactly. The pattern is shown above. Do not invent a different structure."

Small, focused instructions outperform long generic ones for 7B models.

### 6b. Explicit "what done looks like"
At the end of every injected task context, append:
```
TASK COMPLETE WHEN:
- [ ] HTML input for `notes` added to cashier_dashboard.html
- [ ] JS submit handler includes `notes: document.getElementById('notes').value`
- [ ] Backend route reads `request.form.get('notes')`
Do not declare the task complete until all three are checked.
```

Generated programmatically from the task type and the specific field/route name. Model fills in the checklist as it works.

### 6c. Shrink the system prompt
The current system prompt is ~200 lines. For a 7B model with 256k context, the system prompt tokens are "always on" — they eat context that could hold file content. Audit what's actually used:
- Memory guidelines: mostly ignored (model calls tools wrong anyway)
- Shell examples: useful — keep
- Long "Explore Before Implementing" block: 80 lines — could be 20
- Error-case rules ("NEVER end a bug-fix with...") — keep, these work

Target: cut system prompt from ~200 lines to ~80. Save ~1500 tokens per turn.

---

## Implementation Order

These fixes are ordered by impact-to-effort ratio:

| Fix | Impact | Effort | Order |
|---|---|---|---|
| 1b. Template disambiguation (proactive, not reactive) | High | Low | 1st |
| 1c. Column existence check | High | Low | 2nd |
| 4a. Auto-save discoveries from pre-processor | High | Low | 3rd |
| 2a+b. Structured compaction → memory save | High | Medium | 4th |
| 6b. Explicit "done" checklist in task context | High | Medium | 5th |
| 6a. Task-type system prompt suffix | Medium | Low | 6th |
| 3a+b. Post-edit verification | High | High | 7th |
| 5a–c. Task state machine | High | High | 8th |
| 1a. Full-stack breadcrumb (HTML + JS + route) | High | High | 9th |
| 6c. System prompt shrink | Medium | Medium | 10th |

**Start with fixes 1b, 1c, and 4a** — they are all in `preProcessEditTask()`, can be done in one session, and directly address the most visible failure (stub editing, duplicate columns, re-discovering known facts).

---

## Memory System Improvements (Standalone Section)

The tiered memory system is well-designed but underused. The problems:

1. **Model-driven saves are unreliable** — model forgets, saves vague content, or saves at wrong tier
2. **No session-end hook** — conversation ends, nothing is saved
3. **Compaction discards facts** — auto-compact at 99% loses everything in dropped messages
4. **Tier 2 is ephemeral but never promoted** — operational entries age but don't automatically become Tier 3/4 knowledge

**Proposed changes:**

### M1. Extension-driven saves (not model-driven)
The pre-processor and tool handlers know facts the model will discover anyway. Save them directly:
- `preProcessEditTask()` → saves file resolution results
- `edit_file` success → saves what was changed
- Stub block → saves "stub at X, real file at Y"

### M2. Structured compaction summary → Tier 2 save
(See Fix 2 above)

### M3. Session-end hook
On `dispose()` or final response (no tool calls, response ends with period/confirmation):
- Scan Tier 2 for entries created this session
- Group them into a session summary
- Save summary to Tier 3 (Collaboration)
- Clear session Tier 2 entries that were included

### M4. Tier promotion
Tier 2 entries older than 7 days with `accessCount > 2` → promote to Tier 3 automatically on next session start. These are facts that have proven useful across multiple tasks.

### M5. Memory briefing on session start
First thing on session start: load the 3 most recently accessed Tier 2+3 entries and inject as:
```
[RECENT WORK]
- 2 days ago: Added `transaction_notes` column to Transaction model. Migration pending.
- 3 days ago: Real customer form is in cashier_dashboard.html (~3000 lines). Stub at cashier/transaction_form.html.
- 5 days ago: JS submit for transactions is in static/js/cashier.js around line 340.
```

This replaces the model having to rediscover all of this via tool calls.
