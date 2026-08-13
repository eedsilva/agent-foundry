# Concurrent apply_patch / git-commit contention probe — #521

**Date:** 2026-08-13
**Ticket:** [#521](https://github.com/eedsilva/agent-foundry/issues/521) (part of Epic HA-D [#472](https://github.com/eedsilva/agent-foundry/issues/472), closing the Test 3 caveat in the capability spike [#482](https://github.com/eedsilva/agent-foundry/issues/482) — `docs/evidence/harness-alignment/cli-capabilities.md`)
**Prototype:** `.scratch/521-cli-prototype/` (gitignored, throwaway per this ticket's own scope — not committed)

**Bottom line.** Two real `codex exec` processes running concurrently against files does not corrupt data in either tested shape. But the git-commit case surfaces a real, actionable failure mode that #482's Test 3 didn't have the shape to find: in one observed run, **when two processes shared one non-worktree-isolated checkout, one process's commit was silently blocked — most likely by the other's `.git/index.lock`, see Test B for the caveat on that mechanism — and the blocked process still exited 0 with a normal `turn.completed`.** The failure was legible only in the agent's own prose narration, not in the exit code or in a `turn.failed` event. This is a single (n=1) LLM-driven trial, not a proof the failure is deterministic — but it is a real, concrete instance of exactly the risk #482's constraint 3 flagged as unproven-but-plausible, and it's evidence in favor of that constraint's existing recommendation (one worktree per task): removing the shared `.git` removes the shared resource this failure depended on.

---

## Method

Same approach as #482 §3: real network calls against this machine's live ChatGPT-authenticated Codex account, `-c model_reasoning_effort=low`, `--sandbox workspace-write`, `--json` stdout captured per process, background (`&`)/`wait` pairing with wall-clock start/end timestamps and exit codes logged to `timing.txt`. No mocking. Script: `.scratch/521-cli-prototype/run-parallel.sh`. Two tests, run back to back on 2026-08-13 (times UTC, `codex-cli 0.146.1`).

## Test A — concurrent `apply_patch` against the same file

Two processes, both `-C`'d into the same directory (`ws-patch/`), both told (in prose, not a shell command) to use their file-editing tool to append a distinct line to the same file, `shared.txt` — the exact shape #482 Test 3 explicitly left untested ("two processes concurrently running Codex's own file-edit tooling (`apply_patch`) against the same file").

```
PID_E start=2026-08-13T04:30:07Z   PID_F start=2026-08-13T04:30:07Z
PID_E=33136 end=2026-08-13T04:30:31Z rc=0   PID_F=33163 end=2026-08-13T04:30:31Z rc=0
```

Both started the same second and ended the same second — real concurrent execution. Both exited 0. `shared.txt` ended up with both lines intact:

```
line-seed
processed-by-e
processed-by-f
```

**No corruption, no lost update, no lock error.** Each process's `apply_patch` call operates on its own read-then-write of the file content it sees; since the two edits are non-overlapping appends and Codex serializes each process's own tool calls internally, the OS-level file write from each process lands intact. This result generalizes better than #482 Test 3's trivial shell-append case did, since it exercises Codex's actual patch-application code path (diff computation + apply) rather than a shell redirect — but it is still only one non-overlapping-append shape; two processes editing the *same line range* of the same file concurrently (a true diff conflict) was not tested and would likely surface as one process's `apply_patch` failing to match its expected pre-image after the other's edit landed first, not as silent corruption — Codex's patch tool is inherently context-matching, so a stale pre-image should fail loudly rather than corrupt. Not verified directly; flagged here rather than assumed.

## Test B — concurrent `git commit` in the same non-worktree-isolated checkout

Two processes, both `-C`'d into the same git repo (`ws-commit/`, a throwaway repo seeded with one commit), each told to edit a different file (`a.txt` / `b.txt`) then run `git add <own file> && git commit -m <own message>` — the second half of this ticket's scope (#482's spike never tested git-level contention at all).

```
PID_G start=2026-08-13T04:30:31Z   PID_H start=2026-08-13T04:30:31Z
PID_G=46191 end=2026-08-13T04:31:01Z rc=0   PID_H=46193 end=2026-08-13T04:31:01Z rc=0
```

Both started and ended within the same second — real concurrency. **Both exited 0.** But only one commit landed:

```
$ git log --oneline
b405425 commit-g
e5472da seed

$ git status --short
 M b.txt
```

Process H's file edit to `b.txt` is present in the working tree, but its commit never happened. Reading H's own `--json` transcript directly:

```json
{"type":"agent_message","text":"The file edit succeeded, but the commit is blocked because this workspace exposes `.git` read-only (`index.lock: Operation not permitted`). I'm checking whether the repo uses an alternate writable Git directory before stopping."}
...
{"type":"agent_message","text":"Blocked: `b.txt` was edited, but `.git` is read-only, so Git cannot create `.git/index.lock` and commit."}
{"type":"turn.completed","usage":{...}}
```

`ls -ld .git .git/index` (run by H itself, mid-transcript) shows normal Unix permissions (`drwxr-xr-x`, owner-writable) — this is not a real filesystem permission problem. The most consistent read: G's process created `.git/index.lock` first as part of its own `git commit`, and H's sandboxed shell got a permission-denied-shaped error trying to create the same lock file concurrently (`Operation not permitted` rather than git's usual "File exists" — consistent with Codex's per-process sandbox (macOS Seatbelt) mediating the syscall rather than a plain git-level lock collision). G's `git add a.txt && git commit -m 'commit-g'` transcript shows a clean, uncontended `exit_code: 0` with the expected `[main b405425] commit-g` output — it never observed any contention at all, which is consistent with G winning the lock race outright rather than both racing and one recovering.

**The critical finding is not the lock contention itself — a git-level index lock colliding under concurrent writers is expected, correct git behavior, and this repo already treats one-worktree-per-task as the answer to it. The finding is what a caller watching only exit codes would see:** H's process exited 0, produced a normal `turn.completed` (no `turn.failed`), and Codex's own JSON stream contains no structured error event for this failure — the only signal is a natural-language `agent_message` string ("Blocked: ... commit"), which an orchestrator would have to pattern-match on unreliable prose to detect. This is a sharper version of #482's constraint 2 ("never trust `stderr`, always parse `--json` stdout"): here, *even* the JSONL stdout stream gives a false-positive success signal at the structured-event level. **No data was corrupted — H's edit is sitting safely, uncommitted, in the working tree, and the repo's git objects/index are intact** — but a caller that trusted H's exit code would incorrectly believe both edits were committed.

## Answering the ticket's acceptance criteria

**Does concurrent `apply_patch` against a shared file/worktree corrupt data, deadlock, or fail cleanly?** Neither corrupts nor deadlocks for the non-overlapping-append shape tested (Test A). True overlapping-region conflicts were not tested; expected (not verified) to fail loudly via `apply_patch`'s own context-matching rather than corrupt silently.

**Same for concurrent `git commit` in a shared checkout?** In the one trial run (n=1), it failed cleanly at the git level (no corrupted index or objects) but **not cleanly at the orchestrator-observability level** — the losing process reported success (exit 0, `turn.completed`) while its commit silently didn't happen (Test B).

**Is #520's worktree-per-task isolation sufficient on its own, or does something additional need locking/serializing?** Not directly tested here — both tests deliberately used shared, non-isolated checkouts, so worktree isolation itself was never exercised. By inference, it should be sufficient: worktree-per-task isolation removes the shared `.git` entirely, which removes the shared resource Test B's failure depended on. A run confirming this against an actual `isolation: worktree`-style setup would be needed to call it verified rather than inferred. The added requirement this probe does directly surface for #520, independent of the worktree question: **do not treat a parallel Codex task's exit code 0 as proof its intended git operations (commits specifically) landed** — if #520 ever runs a task against a shared, non-worktree-isolated checkout (which #482's constraint 3 already discourages, and this probe's single trial is consistent with), it must verify resulting git state independently rather than trust the process's own success signal.

## Raw evidence

`--json` JSONL streams, `stderr`, and `timing.txt` for both tests live in `.scratch/521-cli-prototype/logs/` on this branch's working tree. Not committed (gitignored, throwaway per the ticket's own scope); this doc is the durable record.
