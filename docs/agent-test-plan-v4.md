# Agent Behavior Test Plan — v4

Tests covering partial reads, stale assumptions, meaningful tests, cascading edits, output accuracy, wrong-file edits, and silent data loss.
Each test has a prompt, the failure mode it targets, and clear pass/fail criteria.
Run each test in a fresh session unless setup specifies otherwise. Score: PASS / FAIL / PARTIAL.

The coding tests use the scratch project at `C:\Users\david\Documents\source\testing\taskmanager`.

**Scratch project structure:**
- `src/db.py` — connection + schema (init_db, get_connection)
- `src/tasks.py` — CRUD (create_task, get_task, list_tasks, update_status, delete_task)
- `src/reports.py` — reporting (summary, overdue_tasks, top_priority)
- `tests/test_tasks.py` — pytest suite

---

## 32. Partial read leading to wrong assumption
**Targets:** "Read the relevant section fully before drawing conclusions — do not assume the rest matches"

**Setup:** No changes needed. `update_status` in `src/tasks.py` currently closes the connection before returning, with no timestamp logic.

**Prompt:**
> In src/tasks.py, update `update_status` so that when status is set to `done`, it also writes the current timestamp to a `completed_at` column.

**What to watch:** Does the agent read the full `update_status` function — including the `conn.close()` at the end — before writing the new version? Or does it read the first few lines of the function and reconstruct the rest from assumption?

**Pass:** Agent reads the complete function body, writes a correct replacement that sets `completed_at` for `done` status only, and the new code includes `conn.close()` (or uses a context manager). Also mentions that `db.py` schema needs a `completed_at` column.

**Fail:** Agent reads partial context, produces code that drops `conn.close()`, or writes `completed_at` for all status values instead of only `done`, or never mentions the schema needs updating.

---

## 33. Wrong file, right change
**Targets:** "When two files have similar structure, edit the right one"

**Prompt:**
> Add a `limit` parameter (default 10) to the `summary` function so callers can cap how many status groups are returned.

**What to watch:** `summary()` exists in `src/reports.py`. `src/tasks.py` has no `summary` function. Does the agent correctly identify and edit `reports.py`?

**Pass:** Agent edits `src/reports.py` and only `src/reports.py`. The `summary` function gets a `limit` parameter and the SQL (or Python-side) respects it.

**Fail:** Agent edits `src/tasks.py` instead, or edits both, or adds `limit` to the wrong function in the right file.

---

## 34. Stale assumption across turns — explicit invalidation
**Targets:** "When the user says a file changed since you last read it, re-read before acting"

**This is a two-turn test. Do NOT start a fresh chat between turns.**

**Turn 1 prompt:**
> Read src/tasks.py and tell me what parameters create_task accepts.

**Expected:** Agent reads the file, reports `(title, priority=0)`.

**Turn 2 prompt (same chat):**
> I just added a `tags` field to the schema and updated create_task to accept a `tags` list parameter. Now add a `filter_by_tag` function to src/tasks.py that queries tasks by a single tag value.

**What to watch:** The agent's last read of `tasks.py` showed no `tags` parameter. The user explicitly says it changed. Does the agent re-read before writing the new function, or does it write `filter_by_tag` based on the stale schema (no `tags` column in the SELECT, wrong assumptions about the data model)?

**Pass:** Agent re-reads `src/tasks.py` (and ideally `src/db.py`) before writing `filter_by_tag`, producing a query that references the `tags` column rather than assuming the old schema.

**Fail:** Agent writes `filter_by_tag` without re-reading, uses the old schema, or produces a query with no `tags` reference because it didn't know the column exists.

---

## 35. Meaningful test — not just "doesn't throw"
**Targets:** "Write tests that validate behavior, not just that the function runs without error"

**Prompt:**
> Write a test for `update_status` in tests/test_tasks.py.

**What to watch:** A weak test calls `update_status(tid, 'done')` and asserts nothing — or only asserts it doesn't raise. A strong test verifies the DB was actually updated.

**Pass:** Agent writes a test that:
1. Creates a task
2. Calls `update_status` to change its status
3. Calls `get_task` to read it back from the DB
4. Asserts the retrieved status equals the new value

**Fail:** Agent writes a test that only checks `update_status` doesn't raise an exception, or doesn't read the task back to verify the DB write actually happened.

---

## 36. Cascading edit correctness — three connected changes
**Targets:** "Complete all parts of a compound change without losing consistency between them"

**Prompt:**
> Make these three changes to the task manager:
> 1. Add a `due_date` TEXT column to the schema in src/db.py
> 2. Add `due_date` as an optional parameter (default None) to `create_task` in src/tasks.py
> 3. Add a `overdue` filter to `list_tasks` — when called as `list_tasks(overdue=True)`, return only tasks where `due_date < date('now')` and status != 'done'

**What to watch:** Each change depends on the previous one. Common failures: #2 adds the parameter but forgets to include it in the INSERT; #3 references `due_date` but the WHERE clause is wrong (e.g. uses `datetime` instead of `date`, or mixes up the `status` condition).

**Pass:** All three changes implemented correctly and consistently. The INSERT in `create_task` passes `due_date`. The `list_tasks` overdue filter correctly uses `due_date < date('now') AND status != 'done'`. Agent verifies with py_compile.

**Fail:** Any of the three changes is missing, or #2 and #3 are inconsistent (e.g. column name mismatch), or the WHERE clause logic is wrong.

---

## 37. Read your own output — use exact values, not paraphrases
**Targets:** "Never paraphrase tool output — use exact values from what you actually received"

**Prompt:**
> Run the pytest suite in the taskmanager directory and tell me exactly how many tests passed and how many failed, then tell me the exact error message from the first failing test.

**What to watch:** The test suite has pre-existing failures (the broken `row_factory` fixture). Does the agent report the exact counts and exact error text from the output, or does it paraphrase/approximate?

**Pass:** Agent reports the exact pass/fail counts from the pytest output (e.g. "4 failed, 1 passed") and quotes the exact first error message verbatim (e.g. `TypeError: object is not iterable`).

**Fail:** Agent approximates ("most tests failed"), misquotes the error, invents an error message it didn't see, or reports counts that don't match the actual output.

---

## Scoring

| # | Test | Result | Notes |
|---|------|--------|-------|
| 32 | Partial read — wrong assumption | PASS | Updated update_status with done branch AND added completed_at to schema. (2026-05-08) |
| 33 | Wrong file, right change | PASS | Searched before editing, found reports.py, also checked for callers. |
| 34 | Stale assumption across turns | PASS | Re-read tasks.py on turn 2 before writing filter_by_tag. Minor scope creep updating create_task unprompted. |
| 35 | Meaningful test — not just "doesn't throw" | PASS | Tested both transitions, verified completed_at. Then incorrectly tried to fix fixture — covered by scope note fix. |
| 36 | Cascading edit correctness | PASS | All 3 changes consistent. Thinking-loop circuit breaker fired and recovered from .priority typo. |
| 37 | Read your own output | PASS | Exact counts and exact error quoted verbatim. Did not attempt fixes. |

**Result: 6/6 (2026-05-08)**

**Target:** 5/6 pass. FAILs on tests 35 or 36 are blockers — weak tests and inconsistent cascading edits are silent quality killers that reach production.

---

## Notes on test design

- Tests 32, 33, 35, 36, 37 are single-turn.
- Test 34 is two-turn — do not reset the chat between turns.
- Test 37 has a known "correct answer" from the pytest output — compare the agent's report against the actual output shown in the tool result.
- Blockers (35, 36): a test that doesn't test anything and a three-part change where part 2 and 3 disagree are both invisible bugs. They look done but aren't.
- Test 33 is a trap — `summary` sounds like it could be in tasks.py. If the agent searches before editing, it will find the right file. If it guesses, it may not.
