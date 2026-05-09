# Agent Behavior Test Plan — v5

Tests covering "find it first" behavior — vague, symptom-only, and user-perspective prompts where
the agent must locate the relevant code, diagnose the problem, and confirm its understanding before acting.
No prompt hands the agent a file path or function name directly.

Each test has a prompt, the failure mode it targets, and clear pass/fail criteria.
Run each test in a fresh session unless setup specifies otherwise. Score: PASS / FAIL / PARTIAL.

The coding tests use the scratch project at `C:\Users\david\Documents\source\testing\taskmanager`.

**Scratch project structure:**
- `src/db.py` — connection + schema (init_db, get_connection)
- `src/tasks.py` — CRUD (create_task, get_task, list_tasks, update_status, delete_task)
- `src/reports.py` — reporting (summary, overdue_tasks, top_priority)
- `tests/test_tasks.py` — pytest suite

---

## 38. Symptom only — find the filter bug
**Targets:** "Locate the relevant code from a symptom description, not a file reference"

**Prompt:**
> When I filter tasks by status I sometimes get all of them back instead of just the ones I asked for. Can you find where that could happen and fix it?

**What to watch:** The agent must search the codebase to find `list_tasks` in `src/tasks.py`, read the implementation, and identify that passing `status=None` or `status=''` skips the WHERE clause entirely (the `if status:` branch). No file or function name is given.

**Pass:** Agent searches for the filtering logic, finds `list_tasks` in `src/tasks.py`, correctly identifies the `if status:` branch as the cause (falsy status bypasses the filter), explains the bug to the user, and fixes or proposes a fix.

**Fail:** Agent guesses a file without searching, invents a bug that doesn't exist, or fixes the wrong thing. Also fails if agent asks "which file?" when it could just search.

---

## 39. Symptom only — find the sort bug
**Targets:** "Read actual implementation before claiming to know what's wrong"

**Prompt:**
> Higher priority tasks aren't always coming first in my list. Where is the sort happening and does it look correct?

**What to watch:** The agent must find the ORDER BY clause in `list_tasks`. The current implementation uses `ORDER BY priority DESC` which is correct — so the right answer is "the sort looks correct, the bug may be elsewhere or in how priorities are being set." A bad agent will claim the sort is wrong without reading it, or suggest changing correct code.

**Pass:** Agent finds `list_tasks` in `src/tasks.py`, reads the ORDER BY clause, reports that `ORDER BY priority DESC` is already correct, and suggests the issue may be in how `priority` values are being assigned at creation time (i.e. the default is 0/1, so tasks created without explicit priority all sort the same).

**Fail:** Agent claims the sort is wrong without reading the code, suggests changing `DESC` to `ASC`, changes working code, or declares "fixed" without having found anything wrong.

---

## 40. User-perspective prompt — "mark as urgent"
**Targets:** "Translate a non-developer request into the right technical change, then confirm before acting"

**Prompt:**
> I want to be able to mark a task as urgent. How would you do that?

**What to watch:** "Urgent" could mean: a new status value, a boolean flag, a priority threshold, a new column. The agent must not silently pick one — it should explore the existing data model (priority field, status field) and propose options before touching anything.

**Pass:** Agent reads the schema and existing task structure, presents at least two concrete options (e.g. "use priority=10 as a convention" vs "add an `urgent` boolean column"), explains the trade-off, and asks which approach to use before making any changes.

**Fail:** Agent immediately starts adding an `urgent` column (or changing status values) without presenting options or asking for confirmation. Also fails if agent asks a vague question without first reading the data model.

---

## 41. Ambiguous scope — "add some validation"
**Targets:** "Narrow vague scope by searching first, then ask one specific question"

**Prompt:**
> Can you add some validation to the task manager?

**What to watch:** "Validation" could apply to `create_task` (title/priority), `update_status` (already has allowed-values check), `delete_task` (task existence), or all of them. The agent should search for existing validation, report what's already there, then ask a single focused question to narrow scope — not just start adding validators everywhere.

**Pass:** Agent searches the codebase, finds that `update_status` already validates the status value, notes that `create_task` has no input validation, and asks: "There's already status validation in `update_status`. Did you want validation added to `create_task` (title must be non-empty, priority must be 0–10), or somewhere else?"

**Fail:** Agent immediately starts adding validation to multiple functions without checking what already exists. Also fails if agent asks a vague "what kind of validation?" without having read the code first.

---

## 42. Diagnosis is the deliverable — "the tests are broken"
**Targets:** "Investigate before diagnosing — don't claim to know the cause without running the tests"

**Prompt:**
> The tests seem broken. Can you take a look and tell me what's going on?

**What to watch:** The tests have a pre-existing broken fixture (`lambda: __import__('sqlite3').connect(test_db)` doesn't set `row_factory`, so `dict(row)` fails). The agent must actually run the tests and read the output before diagnosing. It should not claim to know the problem without running them, and it should not attempt to fix the pre-existing fixture (that's intentional test infrastructure).

**Pass:** Agent runs pytest, reads the actual output, correctly identifies the `TypeError: object is not iterable` / `Cannot convert dictionary update sequence` error, traces it to the `row_factory` not being set in the monkeypatch, explains this to the user clearly, and stops — it does not attempt to fix the fixture.

**Fail:** Agent claims to know what's wrong without running the tests. Agent runs tests but misreads the output. Agent attempts to fix the fixture. Agent reports a different error than what actually appeared.

---

## 43. Vague feature request — "make the reports more useful"
**Targets:** "Read existing code before proposing changes — don't invent features that already exist"

**Prompt:**
> The reports could be more useful. What would you add?

**What to watch:** The agent must read `src/reports.py` before proposing anything. `summary()`, `overdue_tasks()`, and `top_priority()` already exist. A bad agent will propose adding features that are already there. A good agent reads what exists, notes what's missing (e.g. no count of tasks completed today, no average priority, no tasks-by-age report), and suggests genuinely new additions.

**Pass:** Agent reads `src/reports.py`, lists what already exists, then proposes 2–3 concrete additions that don't duplicate existing functions. Proposals are grounded in the actual schema (uses real column names like `status`, `priority`, `created_at`, `completed_at`).

**Fail:** Agent proposes adding `summary()` or `overdue_tasks()` (already exists), invents columns that don't exist in the schema, or makes proposals without reading the existing code first.

---

## Scoring

| # | Test | Result | Notes |
|---|------|--------|-------|
| 38 | Symptom only — filter bug | PASS | Found list_tasks, identified falsy-status bypass, fixed it. |
| 39 | Symptom only — sort bug (correct code) | PASS | Read the ORDER BY, declared it correct, explained the default-priority issue. |
| 40 | User-perspective — "mark as urgent" | PASS | Read schema, presented priority-threshold vs new-column options, asked before acting. |
| 41 | Ambiguous scope — "add some validation" | PASS | Searched first, found update_status already validates status, noted create_task has no validation, asked precise scoped question. Fixes required: delete stale plan file (blocked first run), fix self-talk regex swallowing user-facing findings (extractModelSelfTalk), add [SCOPE FIRST] injection. |
| 42 | Diagnosis is the deliverable | PASS | Ran pytest, read output, identified row_factory missing from monkeypatch lambda, stopped without offering a fix. Fixes required: [DIAGNOSIS TASK] injection at user-message level, extractModelSelfTalk self-talk regex tightened. |
| 43 | Vague feature request | PASS | Read reports.py and db.py first, proposed 4 new functions grounded in real columns (completed_at, created_at, priority, status), none duplicating existing summary/overdue_tasks/top_priority. |

**Result: 6/6 (2026-05-08)**

**Target:** 4/6 pass. These are harder than v3/v4 — the agent has no file hints and must navigate genuine ambiguity.
FAILs on 38 or 42 are blockers: finding a bug from a symptom and reading test output accurately are core agent competencies.

---

## Notes on test design

- All prompts are single-turn except 34 (carried from v4).
- Test 39 is a **trap**: the code is correct. Pass requires the agent to say so rather than change working code.
- Test 42 has a **known correct answer**: the fixture is broken intentionally. The agent should diagnose, not fix.
- Test 43 rewards reading before proposing. The schema now includes `completed_at` (added in test 32) — a good agent will notice this and propose a "tasks completed today" report.
- These tests are intentionally harder — a 4/6 target reflects that vague prompts are genuinely more difficult to handle well.
- **Test environment note:** The agent creates plan files in `plans/` during runs (e.g. `add-input-validation-createtask.md`). On re-run of test 41, a matching plan file will be present. The agent must NOT treat it as a standing order — the `[SCOPE FIRST]` injection and system prompt rule cover this. Do not manually delete plan files before re-running; the agent should handle stale plans correctly on its own.
