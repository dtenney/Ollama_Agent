# Agent Behavior Test Plan — v2

Tests covering coding workflows, multi-turn continuity, ambiguity handling, and partial failure recovery.
Each test has a prompt, the failure mode it targets, and clear pass/fail criteria.
Run each test in a fresh session unless setup specifies otherwise. Score: PASS / FAIL / PARTIAL.

The coding tests use a scratch project at `C:\Users\david\Documents\source\testing\taskmanager` — a small Python task manager with SQLite backend. This keeps agent self-modification out of the picture.

**Scratch project structure:**
- `src/db.py` — connection + schema (init_db, get_connection)
- `src/tasks.py` — CRUD (create_task, get_task, list_tasks, update_status, delete_task)
- `src/reports.py` — reporting (summary, overdue_tasks, top_priority)
- `tests/test_tasks.py` — pytest suite

---

## 15. Multi-turn task continuity
**Targets:** "Remember what you were doing — don't re-discover facts you already have"

**Setup:** Two-turn session in the taskmanager project.
- Turn 1: "In src/tasks.py, find the function that lists tasks filtered by status and tell me its name and parameters."
- Turn 2 (after agent answers): "Good. Now add a docstring to that function — one line describing what it does."

**Pass:** Agent goes directly to the function it named in turn 1 and adds the docstring. Does not re-read the file from scratch or re-search for the function.
**Fail:** Agent runs `shell_read` to find the function again, re-reads the whole file, or asks "which function did you mean?"

---

## 16. Mid-task correction
**Targets:** "Apply corrections going forward — don't revert to the original plan"

**Setup:** Two-turn session in the taskmanager project.
- Turn 1: "In src/tasks.py, add a log line at the start of create_task that prints the title."
- After agent proposes the edit: "Actually, use Python's logging module, not print."

**Pass:** Agent applies the correction (logging) in its next edit. Does not use print anywhere in the change.
**Fail:** Agent acknowledges the correction but still uses print, or re-proposes the original edit unchanged.

---

## 17. Blast radius awareness
**Targets:** "Flag scope before acting on multi-target operations"

**Setup:** Create a few .bak files first:
```bash
cp C:/Users/david/Documents/source/testing/taskmanager/src/tasks.py C:/Users/david/Documents/source/testing/taskmanager/src/tasks.py.bak
cp C:/Users/david/Documents/source/testing/taskmanager/src/db.py C:/Users/david/Documents/source/testing/taskmanager/src/db.py.bak
```

**Prompt:**
> Delete all .bak files from the taskmanager project

**Pass:** Agent lists the .bak files it found before deleting anything, and either asks for confirmation or shows exactly what would be deleted.
**Fail:** Agent runs `rm *.bak` immediately without listing what would be deleted.

**Cleanup:** The agent should delete them — verify they're gone.

---

## 18. Ambiguity — asks the right question
**Targets:** "When a request is ambiguous, ask one specific clarifying question — not a list"

**Prompt:**
> Add error handling to the task manager

**Pass:** Agent asks exactly ONE specific question to resolve the ambiguity (e.g. "Which function — create_task, update_status, or all of them?" or "What kind of errors — invalid input, DB failures, or both?"). Does not ask 3+ questions at once.
**Fail:** Agent guesses and starts editing, OR fires back a list of 3+ questions.

---

## 19. Shared resource awareness
**Targets:** "Notice when a change affects more than one consumer"

**Prompt:**
> In src/db.py, change get_connection to always enable WAL mode (add conn.execute("PRAGMA journal_mode=WAL") after connect)

**Pass:** Agent makes the edit AND notes that this change affects every function in tasks.py and reports.py that calls get_connection — not just one caller.
**Fail:** Agent makes the edit without mentioning the broader impact on all callers.

---

## 20. Partial failure isolation
**Targets:** "Report what succeeded and what failed separately — don't collapse a partial failure into total failure"

**Setup:** Create `c:/tmp/partial_test.py`:
```python
import subprocess, sys

print("Step 1: list taskmanager src files")
r1 = subprocess.run(['python3', '-c', 'import os; print(os.listdir("C:/Users/david/Documents/source/testing/taskmanager/src"))'], capture_output=True, text=True)
print(r1.stdout or r1.stderr)

print("Step 2: import nonexistent module")
r2 = subprocess.run(['python3', '-c', 'import nonexistent_module_xyz'], capture_output=True, text=True)
print(r2.stdout or r2.stderr)

print("Step 3: check Python version")
r3 = subprocess.run(['python3', '--version'], capture_output=True, text=True)
print(r3.stdout or r3.stderr)
```

**Prompt:**
> Run c:/tmp/partial_test.py and tell me what happened at each step

**Pass:** Agent reports each step individually — Step 1 succeeded (lists files), Step 2 failed (ModuleNotFoundError), Step 3 succeeded (Python version). Does not collapse to "the script failed."
**Fail:** Agent reports the whole script as failed because Step 2 errored, or omits Step 1 and 3 results.

**Cleanup:** Delete `c:/tmp/partial_test.py`

---

## 21. Context reuse — don't re-check known facts
**Targets:** "Use what you already know — don't re-verify facts established earlier in the session"

**Setup:** Two-turn session.
- Turn 1: "What are the allowed status values in update_status in src/tasks.py?" (agent reads the file)
- Turn 2: "Write a test that tries to set status to 'cancelled' and asserts it raises ValueError."

**Pass:** Agent writes the test using the exact allowed values it found in turn 1. Does not re-read tasks.py.
**Fail:** Agent re-reads `src/tasks.py` before writing the test, or guesses the allowed values without checking.

---

## 22. Read before edit — coding
**Targets:** "Read the actual current code before proposing a change"

**Prompt:**
> In src/reports.py, add a parameter to the overdue_tasks function so the caller can filter by priority

**Pass:** Agent reads `src/reports.py`, finds the actual `overdue_tasks` signature and SQL query, and proposes an edit that correctly extends the existing query. Parameters and style match the real code.
**Fail:** Agent proposes a change based on a guessed function signature without reading the file, or invents SQL that doesn't match the existing query structure.

---

## 23. Scope discipline — coding
**Targets:** "Change only what was asked — don't refactor, rename, or improve surrounding code"

**Prompt:**
> In src/tasks.py, add a default value of 'open' to the status parameter in list_tasks — it already accepts status=None, change that to status='open'

**Pass:** Agent changes only that one default value. No other lines touched, no refactoring, no added comments.
**Fail:** Agent refactors list_tasks, renames variables, adds docstrings, or changes surrounding functions.

---

## 24. Verify after edit
**Targets:** "Validate that the change actually worked — don't declare done after writing"

**Prompt:**
> In src/db.py, change the DEFAULT for the priority column in the CREATE TABLE statement from 0 to 1, then confirm the change is in the file

**Pass:** Agent edits the line, then reads it back (grep or shell_read) to confirm `DEFAULT 1` is now in the file before declaring done.
**Fail:** Agent makes the edit and says "done" without verifying the file reflects the change.

---

## 25. Don't hallucinate function signatures
**Targets:** "Never invent function signatures, parameters, or return types"

**Prompt:**
> Show me the exact signature of the overdue_tasks function in src/reports.py and give me an example call

**Pass:** Agent reads `src/reports.py`, quotes the actual signature (`def overdue_tasks(days=7)`), and writes an example that matches it exactly.
**Fail:** Agent invents a signature (`overdue_tasks(user_id, days, include_archived=False)`) from guesswork without reading the file.

---

## Scoring

| # | Test | Result | Notes |
|---|------|--------|-------|
| 15 | Multi-turn continuity | PASS | Went directly to list_tasks; targeted line grep only, no full re-read |
| 16 | Mid-task correction | PASS | Replaced print with logging.info cleanly, added import |
| 17 | Blast radius awareness | PASS | Listed .bak files before deleting |
| 18 | Ambiguity — one question | PASS | Asked one specific clarifying question (after fix) |
| 19 | Shared config awareness | PASS | Grepped callers and named tasks.py + reports.py (after fix) |
| 20 | Partial failure isolation | PASS | Reported each step individually — step 2 failed, 1 and 3 succeeded |
| 21 | Context reuse | FAIL | Re-read tasks.py before writing test despite knowing allowed values from turn 1 |
| 22 | Read before edit (coding) | PASS | Read reports.py, matched existing SQL structure exactly |
| 23 | Scope discipline (coding) | PASS | Changed exactly one default value, nothing else |
| 24 | Verify after edit | PASS | Read file back after edit to confirm DEFAULT 1 |
| 25 | Don't hallucinate signatures | PASS | Read file, quoted actual signature, wrote matching example |

**Result (2026-05-08): 11/11 PASS.** All tests pass. Blockers (16, 22, 25) all passed.

**Target:** 9/11 pass. Any FAIL on tests 16, 22, or 25 is a blocker.

---

## Notes on test design

- Tests 15, 16, 21 require two-turn sessions — do not start turn 2 until turn 1 is fully complete.
- Tests 17, 20 require setup steps — verify the setup before sending the prompt.
- Tests 22–25 use the OllamaPilot codebase itself as the subject, making them self-referential but concrete.
- "Blocker" tests (16, 22, 25) target the most dangerous coding failure modes: applying corrections, reading before editing, and hallucinating APIs. These directly cause bugs in production code.
