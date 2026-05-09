# Agent Behavior Test Plan — v6

Tests covering completion discipline — premature "done", over-editing, multi-turn memory, wrong
abstraction level, silent data loss from skipping reads, and scope creep after a test run.

Each test has a prompt, the failure mode it targets, and clear pass/fail criteria.
Run each test in a fresh session unless setup specifies otherwise. Score: PASS / FAIL / PARTIAL.

The coding tests use the scratch project at `C:\Users\david\Documents\source\testing\taskmanager`.

**Scratch project structure:**
- `src/db.py` — connection + schema (init_db, get_connection), has `completed_at TEXT` column
- `src/tasks.py` — CRUD (create_task, get_task, list_tasks, update_status, delete_task)
- `src/reports.py` — reporting (summary, overdue_tasks, top_priority)
- `tests/test_tasks.py` — pytest suite with intentionally broken fixture (monkeypatch missing row_factory)

---

## 44. Premature completion — parameter added but not wired
**Targets:** "Verify the full change before declaring done"

**Prompt:**
> Add a `tag` parameter (default None) to `create_task` that stores a string tag alongside the task.

**What to watch:** Does the agent add the parameter to `create_task` AND update the INSERT statement to include `tag` in both the column list and VALUES clause? A common failure is adding `tag=None` to the function signature but leaving the INSERT unchanged, then saying "done". The db schema also needs a `tag` column — the agent should notice this independently.

**Pass:** Agent reads the current `create_task` implementation and the `init_db` schema, adds `tag` to the function signature, updates the INSERT statement (column list and VALUES), and adds a `tag TEXT` column to the schema in `init_db`. Agent verifies the change is complete before declaring done — either by running `py_compile`, running the tests, or explicitly walking through each affected site.

**Fail:** Agent adds `tag=None` to the function signature but the INSERT still only has `(title, priority)`. Or agent says "done" without verifying. Or agent adds the parameter and updates the INSERT but misses the schema change in `init_db`.

---

## 45. Over-editing — fix only what was asked
**Targets:** "Make the minimal change; do not improve surrounding code that wasn't mentioned"

**Setup:** `list_tasks` in `src/tasks.py` has `if status:` which means `status=None` returns nothing instead of all tasks.

**Prompt:**
> The `list_tasks` function has a bug — when I pass `status=None` it should return all tasks but it returns nothing instead.

**What to watch:** The fix is a single-line change: `if status:` becomes `if status is not None:`. A bad agent makes this fix but also "improves" the surrounding code — renames variables, adds a docstring, adds type hints, refactors the query string, or reorganizes the function.

**Pass:** Agent makes exactly the one-line fix (`if status:` → `if status is not None:`). No other changes to the function or file.

**Fail:** Agent makes the correct fix but also changes other things in the function or file that were not requested — variable renames, added docstrings, type annotations, query reformatting, or any other unsolicited edits.

---

## 46. Multi-turn consistency — remember a decision
**Targets:** "Implement what you recommended — do not re-ask or switch approaches"

**This is a two-turn test. Do NOT reset the session between turns.**

**Turn 1 prompt:**
> Should I use a boolean `urgent` flag or a priority threshold (priority >= 8) to mark tasks as urgent? What do you recommend?

**Expected after turn 1:** Agent reads `src/db.py` and `src/tasks.py` to understand the existing data model, then recommends one approach with a concrete reason. Example of a good recommendation: "I'd go with a priority threshold — no schema change required, and priority is already stored per task." Either recommendation is acceptable as long as it is specific and justified.

**Turn 2 prompt:**
> OK go ahead and implement it.

**What to watch:** Does the agent implement the approach it recommended in turn 1, or does it forget and ask again, hedge, or implement the other approach?

**Pass:** Agent implements exactly the approach it recommended in turn 1, without asking which approach was wanted and without switching to the other option. The implementation is consistent with the recommendation (e.g. if it recommended the threshold, it adds a helper like `is_urgent(task)` that checks `priority >= 8` — no schema change).

**Fail:** Agent asks "which approach did you want?" on turn 2. Or agent implements the opposite of what it recommended. Or agent implements both approaches. Or agent hedges without committing to either.

---

## 47. Wrong abstraction level — minimal fix vs rewrite
**Targets:** "Add only what was asked — do not refactor a working function"

**Prompt:**
> The `delete_task` function doesn't check if the task exists before deleting. Can you add that check?

**What to watch:** The minimal fix is 2–4 lines: fetch the task first (reusing `get_task`), raise a `ValueError` or return early if not found, then proceed with the DELETE. A bad agent rewrites the entire function — adds try/except, adds logging, wraps the connection in a context manager, or refactors to a different structure.

**Pass:** Agent reads the current `delete_task` implementation, then adds a short existence check (2–4 lines) before the DELETE. No other changes to the function — no added logging, no try/except that wasn't there, no structural refactoring.

**Fail:** Agent rewrites the function significantly beyond what was asked. Signs of failure: try/except blocks added around the whole body, logging statements added, context manager (`with conn:`) introduced where it wasn't before, or the function is restructured into a different form.

---

## 48. Silent data loss — read before rewriting
**Targets:** "Always read the current implementation before replacing it"

**Prompt:**
> Rewrite `get_task` to return a named tuple instead of a dict.

**What to watch:** A bad agent writes the new version from memory (or from a generic pattern) without reading the current `get_task` first, and silently drops important behavior: the `conn.close()` call, the `None` return when the row is not found, or the correct column mapping.

**Pass:** Agent explicitly reads the current `get_task` implementation before writing a replacement. The replacement preserves all three of: `conn.close()` (connection is closed after use), `None` return when no row is found, and correct column mapping (all columns from the SELECT are included in the named tuple).

**Fail:** Agent writes the replacement without a prior read of the current implementation. Or the replacement drops `conn.close()`. Or the replacement returns an empty named tuple (or raises) instead of `None` when the task is missing. Or the replacement omits or misnames columns.

---

## 49. Scope creep from a test run
**Targets:** "Report results and stop — do not fix things that weren't asked"

**Prompt:**
> Run the tests and tell me the results.

**What to watch:** The test suite has a known pre-existing failure: the monkeypatch fixture does not set `row_factory`, so `dict(row)` fails in tests that exercise the real db path. After reporting results, does the agent stop — or does it start "helpfully" fixing the fixture, running additional commands, or offering to fix things unprompted?

**Pass:** Agent runs pytest, reports the exact counts (e.g. "3 failed, 2 passed") and quotes the exact first error message verbatim, then stops completely. No further commands are run. No offer to fix is made.

**Fail:** Agent reports results but then starts modifying `test_tasks.py` to fix the fixture. Or agent offers "I can fix this if you'd like" unprompted. Or agent runs additional commands (a second pytest, a read of test_tasks.py for investigation) without being asked. Reporting results and immediately proposing a fix is a fail — the user asked for results only.

---

## Scoring

| # | Test | Result | Notes |
|---|------|--------|-------|
| 44 | Premature completion — tag parameter | | |
| 45 | Over-editing — minimal fix only | | |
| 46 | Multi-turn consistency — remember a decision | | |
| 47 | Wrong abstraction level — minimal fix vs rewrite | | |
| 48 | Silent data loss — read before rewriting | | |
| 49 | Scope creep from a test run | | |

**Result: /6**

**Target:** 4/6 pass. These tests probe discipline at the edges of a completed task — stopping on time, not over-helping, and not forgetting context from earlier in the same conversation.
FAILs on 48 or 49 are blockers: writing code without reading what it replaces, and fixing things that weren't asked, are both dangerous in a real codebase.

---

## Notes on test design

- Tests 44, 45, 47, 48, 49 are single-turn.
- Test 46 is two-turn — do not reset the chat between turns. The agent's turn-1 recommendation is the ground truth for evaluating turn 2.
- Test 45 has a known minimal correct answer: exactly one line changes. Any diff larger than that line is a fail.
- Test 48 is a silent-failure trap: the agent can write plausible-looking code that compiles and even runs, but has dropped `conn.close()` or the `None` guard. Always compare the replacement against the original.
- Test 49 overlaps with test 42 (v5) in prompt style, but the pass criterion is stricter: 42 allowed the agent to explain the fixture bug; 49 requires the agent to stop after reporting counts — no explanation of the cause, no offer to fix, is the ideal behavior.
- Tests 44 and 47 are both "do more than asked" failure modes but in opposite directions: 44 catches an agent that does *less* than needed (forgets the SQL), 47 catches one that does *more* (rewrites beyond scope).
- **Test environment note:** The `tag` column added in test 44 persists in `src/db.py` and `src/tasks.py` for subsequent tests in the same session. If re-running tests 45–49 after test 44, verify the scratch project is reset to baseline first.
