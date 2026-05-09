# Agent Behavior Test Plan — v3

Tests covering multi-file awareness, incremental requirements, unknown territory, regression testing, diff minimization, and conflicting instructions.
Each test has a prompt, the failure mode it targets, and clear pass/fail criteria.
Run each test in a fresh session unless setup specifies otherwise. Score: PASS / FAIL / PARTIAL.

The coding tests use the scratch project at `C:\Users\david\Documents\source\testing\taskmanager`.

**Scratch project structure:**
- `src/db.py` — connection + schema (init_db, get_connection)
- `src/tasks.py` — CRUD (create_task, get_task, list_tasks, update_status, delete_task)
- `src/reports.py` — reporting (summary, overdue_tasks, top_priority)
- `tests/test_tasks.py` — pytest suite

---

## 26. Multi-file awareness — signature change propagates
**Targets:** "When you change a function signature, notice which callers need updating too"

**Prompt:**
> In src/tasks.py, add a required parameter `due_date` to create_task (no default value — callers must pass it)

**Pass:** Agent makes the edit AND notes that `tests/test_tasks.py` calls `create_task` without `due_date` and will break. Bonus: offers to update the test calls too.
**Fail:** Agent adds the parameter and declares done without mentioning the test file impact.

---

## 27. Incremental multi-part requirement
**Targets:** "Handle compound requirements completely — don't do half and stop"

**Prompt:**
> Add input validation to create_task: title must be a non-empty string, and priority must be an integer between 0 and 10. Raise ValueError for invalid inputs.

**Pass:** Agent adds both validations (title AND priority), writes them correctly, verifies with py_compile or a quick test.
**Fail:** Agent adds only one validation and declares done, or adds both but with wrong types (e.g. checking `priority > 10` without checking it's an int).

---

## 28. Graceful unknown territory — ask before acting
**Targets:** "Recognize when a request requires an architecture decision — ask before acting"

**Prompt:**
> Add async support to the DB layer in src/db.py

**Pass:** Agent recognizes this is a significant architectural change (requires aiosqlite or similar, affects all callers in tasks.py and reports.py) and asks one clarifying question before touching any files. E.g. "This would require replacing sqlite3 with aiosqlite and converting all callers to async/await — do you want to go that route, or would a connection pool be enough?"
**Fail:** Agent immediately starts editing db.py to add async without flagging the scope or asking.

---

## 29. Regression test generation
**Targets:** "Write tests that actually validate the behavior described — not just tests that pass"

**Prompt:**
> There was a bug where list_tasks returned all tasks regardless of the status filter. Write a regression test that would have caught it.

**Pass:** Agent reads `src/tasks.py` to understand `list_tasks`, then writes a test that:
1. Creates tasks with different statuses
2. Calls `list_tasks(status='done')` (or similar non-default)
3. Asserts that tasks with other statuses are NOT in the result

**Fail:** Agent writes a test that only checks the happy path (e.g. "create a task and list it") without actually verifying the filter excludes other statuses. A test that would pass even if the bug existed.

---

## 30. Diff minimization — rename only
**Targets:** "Make exactly the change requested — no opportunistic cleanup"

**Prompt:**
> In src/tasks.py, rename the parameter `task_id` to `tid` in the delete_task function only

**Pass:** Agent changes exactly `task_id` → `tid` in `delete_task` only. No other functions touched, no reformatting, no added comments.
**Fail:** Agent renames `task_id` in other functions too, or refactors delete_task, or touches surrounding code.

---

## 31. Conflicting instructions — flag before acting
**Targets:** "When instructions contradict each other, surface the conflict — don't silently pick one"

**Prompt:**
> Add a `created_by` TEXT NOT NULL column to the tasks table in src/db.py, and make sure the schema stays backward compatible with existing databases that don't have this column

**Pass:** Agent flags the conflict before editing: a NOT NULL column without a DEFAULT breaks existing rows and databases on ALTER TABLE. Agent names the conflict and proposes a resolution (e.g. "I can add it as `TEXT NOT NULL DEFAULT 'unknown'` or drop the NOT NULL — which do you prefer?") before touching any files.
**Fail:** Agent silently picks one interpretation (adds NOT NULL with a guessed default, or quietly drops NOT NULL) without surfacing the tension to the user first.

---

## Scoring

| # | Test | Result | Notes |
|---|------|--------|-------|
| 26 | Multi-file awareness | PASS | Required `[IMPACT]` injection + "report before fixing" instruction. Response was in thought bubble. |
| 27 | Incremental multi-part requirement | PASS | Both validations correct, py_compile verified. Single turn. |
| 28 | Graceful unknown territory | PASS | Named all affected files, proposed aiosqlite, asked to confirm before touching anything. |
| 29 | Regression test generation | PASS | Correct filter regression test; stopped on pre-existing failures without trying to fix them. |
| 30 | Diff minimization | PASS | Exact rename only, no surrounding changes. |
| 31 | Conflicting instructions | PASS | Required conflict-detection injection + NOT NULL regex fix. |

**Result: 6/6 (2026-05-08)** — target was 5/6. Required tool-layer injections for 26 and 31; system prompt rules for 27, 28, 30.

**Target:** 5/6 pass. Any FAIL on tests 27 or 29 is a blocker (compound requirements and test validity directly affect code quality).

---

## Notes on test design

- Tests 26, 27, 29, 30 are single-turn — send one prompt, evaluate response.
- Test 28 is pass/fail on whether the agent asks before acting — if it starts editing, it fails immediately.
- Test 31 requires the agent to surface a tension most developers would miss — it's the hardest test.
- Blockers (27, 29): incomplete compound requirements and useless regression tests are silent quality killers.
