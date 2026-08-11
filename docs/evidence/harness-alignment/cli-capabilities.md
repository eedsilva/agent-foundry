# CLI subagent, parallelism, and prompt-surface capabilities — Claude Code vs. Codex CLI

**Research date:** 2026-08-11
**Ticket:** [#482](https://github.com/eedsilva/agent-foundry/issues/482) (capability spike for [Epic HA-D #472](https://github.com/eedsilva/agent-foundry/issues/472), "CLI prompting & subagent orchestration")
**Installed CLI versions (this machine, recorded via `claude --version` / `codex --version`):**

| CLI | Installed | Latest available at research time |
| --- | --- | --- |
| Claude Code | `2.1.227 (Claude Code)` | — |
| Codex CLI | `codex-cli 0.146.1` | `0.147.0` (per `codex doctor`, not upgraded for this spike) |

**Question that prompted it:** [Epic HA-D](https://github.com/eedsilva/agent-foundry/issues/472) wants the orchestrator to use "parallelism … where it truly exists: Claude CLI native subagents, and — pending the capability spike — orchestrator-side parallel Codex processes." Before any build tickets exist, this spike had to settle, from primary docs plus a real prototype: what Claude Code's subagent mechanism actually looks like, whether Codex CLI has any native equivalent, whether orchestrator-side parallel `codex` processes are safe to build against (shared auth, rate limits, workspace contention, failure surfacing), and how each CLI's prompt surfaces (system prompt, `AGENTS.md`/`CLAUDE.md`, per-task context) actually resolve.

**Bottom line.** Claude Code has a mature, orchestrator-drivable native subagent mechanism (`.claude/agents/*.md`, the `Agent` tool, `--agents` CLI JSON, background/foreground execution, per-subagent model/tools/permissions) — nothing to build there beyond prompt engineering (HA-D's #483). Codex CLI's parallelism story is different in kind, not just maturity: it now ships a *native* multi-agent feature (`multi_agent` — stable, enabled by default in this install; `.codex/agents/*.toml`, `agents.max_concurrent_threads_per_session`) but every primary source describes it as **interactive-session, in-process "agent threads"** (driven via `/agent` or a natural-language request inside a TUI session) — not as something exposed through `codex exec`, the non-interactive entry point an external orchestrator actually calls. For an orchestrator like Agent Foundry, that leaves exactly one parallel-Codex mechanism to evaluate: **spawning multiple independent `codex exec` OS processes**, which is what the prototype below tested directly rather than inferred from docs. It works: two to four concurrent `codex exec` invocations under the same ChatGPT auth ran correctly, a forced process-level failure in one did not affect its sibling, and concurrent shell-level writes to a shared file did not corrupt data. The **go decision is qualified**: build orchestrator-side parallel `codex exec` processes, but budget for the two constraints the docs and the prototype both surface — a single account-level rate-limit pool (5-hour rolling window + weekly quota, shared across every concurrent process) and the fact that `codex exec`'s only machine-readable failure signal is the `--json` stdout stream (`stderr` was uninformative in the forced-failure run), so the orchestrator's failure-detection path must parse JSONL, not stderr. On prompt surfaces specifically: both CLIs have a real always-applied instructions-injection point independent of the project's own instructions file — Claude's first-class `--append-system-prompt` flag and Codex's `-c developer_instructions=...` config override (verified working live in this spike, Section 2c-bis) — so HA-D's per-role prompt work has a concrete mechanism to target on both sides, not just on Claude's.

---

## Source quality and caveats

| Source | Type | Trust | Fetched / commit |
| --- | --- | --- | --- |
| [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents) | Official Claude Code docs, fetched raw (full page read, not summarized) | Highest | 2026-08-11 |
| [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | Official Claude Code docs, fetched raw (full page read) | Highest | 2026-08-11 |
| [code.claude.com/docs/en/cli-reference](https://code.claude.com/docs/en/cli-reference) | Official Claude Code docs, fetched via automated extraction (tool summarized rather than returning raw markdown) | High — flag names cross-checked against the sub-agents page where overlapping (`--append-subagent-system-prompt`, version gate `v2.1.205+` match exactly) | 2026-08-11 |
| [openai/codex](https://github.com/openai/codex) `docs/` directory @ [`279b932`](https://github.com/openai/codex/commit/279b93242cfef379e65da97e87e44b83c5934fd7) | Repo source (raw file listing + raw file contents via `curl`) | Highest | 2026-08-11 |
| [learn.chatgpt.com/docs/agent-configuration/agents-md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | Official Codex docs (the `docs/agents_md.md` stub in the repo redirects here); fetched via automated extraction | High | 2026-08-11 |
| [learn.chatgpt.com/docs/agent-configuration/subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Official Codex docs; fetched via automated extraction | High | 2026-08-11 |
| [learn.chatgpt.com/docs/non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode) | Official Codex docs (`docs/exec.md` stub redirects here); fetched via automated extraction | High | 2026-08-11 |
| [learn.chatgpt.com/docs/config-file/config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced) | Official Codex docs; fetched via automated extraction | High | 2026-08-11 |
| [learn.chatgpt.com/docs/pricing](https://learn.chatgpt.com/docs/pricing) | Official Codex/ChatGPT plan docs; fetched via automated extraction | High | 2026-08-11 |
| [learn.chatgpt.com/docs/config-file/config-reference](https://learn.chatgpt.com/docs/config-file/config-reference) | Official Codex docs; **fetched raw via `curl`** (HTML confirmed byte-for-byte against the automated-extraction summary) | Highest | 2026-08-11 |
| [openai/codex](https://github.com/openai/codex) `codex-rs/config/src/config_toml.rs` @ [`279b932`](https://github.com/openai/codex/blob/279b93242cfef379e65da97e87e44b83c5934fd7/codex-rs/config/src/config_toml.rs) | Repo source (raw file contents via `curl`, exact doc-comment quotes) | Highest | 2026-08-11 |
| Installed `codex features list` and `~/.codex/config.toml` on this machine | Primary — the actual installed binary/config, not a doc | Highest (ground truth for *this* install) | 2026-08-11, codex-cli 0.146.1 |
| `.scratch/482-cli-prototype/` run (this spike) | Prototype-observed, raw JSONL/stderr/exit-code evidence | Highest (directly observed, not inferred) | 2026-08-11 |
| [help.openai.com/en/articles/11369540](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Official OpenAI help-center article | — | **Fetch blocked (HTTP 403)**; not used as a citation, see rate-limit section instead |

Caveats that matter:

1. **Codex's own docs migrated mid-research.** `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`, and the doc *files in the repo itself* (`docs/config.md`, `docs/exec.md`, `docs/agents_md.md`, `docs/sandbox.md`) are now one-line stubs pointing at the hosted site rather than containing the content directly (confirmed by `curl`-ing the raw files at commit `279b932`). Citations below point at the hosted pages the repo stubs redirect to.
2. **Several Codex-doc fetches went through an automated extraction step** (the tool that fetches a URL and has a small model summarize/quote it) rather than returning raw page markdown, unlike the two Claude Code pages read in full. Where a quote below is corroborated by a second independent fetch, by the installed binary's own output (e.g. `multi_agent` feature flag), by repo source (e.g. `config_toml.rs` doc comments), or by a follow-up raw `curl` of the same page (e.g. `config-reference`'s `instructions`/`developer_instructions`/`model_instructions_file` rows), that's noted; nothing in this doc rests on a single unverified automated extraction for a load-bearing claim.
3. **The prototype's timestamp granularity is seconds, not milliseconds** — a `date +%3N` in the throwaway script silently no-oped on this machine's BSD `date` (visible as the literal string `.3N` in the raw log). Second-level precision is still sufficient to show two processes overlapping in time (see Prototype section); it is not precise enough to measure sub-second scheduling.
4. One fact is marked LOW CONFIDENCE / inferred where the docs are genuinely silent (see the "Process isolation model" row in the Codex subagents table); nothing else in this document rests on a secondary source, and no blog/forum material is used for a load-bearing claim (search-engine results are cited only as pointers to the official page, never as the source of a quote).

---

## 1. Claude Code CLI — subagent configuration and prompt surfaces

Read in full from [`code.claude.com/docs/en/sub-agents`](https://code.claude.com/docs/en/sub-agents) (fetched 2026-08-11).

**Where subagents live and how they're scoped**, highest to lowest priority when names collide:

| Location | Scope | Priority |
| --- | --- | --- |
| Managed settings | Organization-wide | 1 (highest) |
| `--agents` CLI flag (JSON) | Current session only | 2 |
| `.claude/agents/` | Current project | 3 |
| `~/.claude/agents/` | All projects | 4 |
| Plugin's `agents/` directory | Where the plugin is enabled | 5 (lowest) |

**File format.** Subagents are Markdown files with YAML frontmatter, e.g.:

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

Only `name` and `description` are required. Other frontmatter fields relevant to an orchestrator: `tools` / `disallowedTools` (allow/deny lists, support `Agent(agent_type)` sub-allowlisting and `mcp__<server>` patterns), `model` (`sonnet`/`opus`/`haiku`/`fable`/full model ID/`inherit`, resolved in order: `CLAUDE_CODE_SUBAGENT_MODEL` env var → per-invocation `model` param → frontmatter → parent model), `permissionMode`, `maxTurns`, `skills` (preload), `mcpServers` (subagent-scoped MCP), `memory` (persistent cross-session memory dir), `background` (foreground vs. background — **subagents run in the background by default as of v2.1.198**), `effort`, `isolation: worktree` (runs the subagent's shell commands inside a temporary git worktree, auto-cleaned if unused), `color`.

**Invocation, from an orchestrator's point of view:**
- Programmatically: `claude --agents '{"reviewer": {"description": "...", "prompt": "...", "tools": [...], "model": "sonnet"}}'` — defines subagents inline as JSON for that session only, using the same field names as frontmatter plus `prompt` for the system-prompt body.
- The `Agent` tool (renamed from `Task` in v2.1.63; `Task(...)` references still work as an alias) is what the running Claude session uses internally to spawn a subagent; an orchestrator does not call it directly, but can shape which subagents exist and what they can spawn (`tools: Agent(worker, researcher), ...` allowlists which sub-subagent types are spawnable).
- `claude --agent <name>` runs the *whole session* as a given subagent (its system prompt replaces the default, `CLAUDE.md` still loads normally).
- Non-interactive mode: `--append-subagent-system-prompt` (requires v2.1.205+) appends text to the end of every subagent's system prompt, including nested ones — the mechanism for injecting orchestrator-specific instructions into every subagent a session spawns.

**Background execution and failure surfacing** (both load-bearing for an orchestrator polling subagent state): a background subagent's tool set is narrowed to `Read, Grep, Glob, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree, Monitor, TaskStop, SendMessage, Artifact` (plus MCP tools); results reach the parent as "a completion notification in a later turn." As of v2.1.199, a subagent whose run ends on an API error (rate limit, overload, server error) reports that failure back to the parent explicitly rather than returning the error text as if it were a normal result — foreground subagents that produced no output fail with a named `Agent terminated early due to an API error`; background subagents are "marked failed" with the API error and last output included in the message the parent receives.

### Prompt surfaces and precedence

From [`code.claude.com/docs/en/memory`](https://code.claude.com/docs/en/memory) (fetched raw, 2026-08-11):

- **`CLAUDE.md` files**, in load order from broadest to most specific scope: **Managed policy** (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS, or the `claudeMd` key in `managed-settings.json`; cannot be overridden or excluded) → **User** (`~/.claude/CLAUDE.md`) → **Project** (`./CLAUDE.md` or `./.claude/CLAUDE.md`) → **Local** (`./CLAUDE.local.md`, gitignored). All discovered files are **concatenated**, not override-replaced; within the directory tree, content is ordered root-to-cwd so instructions closer to the working directory are read last (i.e., most-recently-read wins in practice for an LLM reading a prompt top to bottom). `claudeMdExcludes` (glob patterns, mergeable across settings layers) skips specific files; managed files can never be excluded.
- **Claude Code does not read `AGENTS.md` natively.** The documented interop path is `@AGENTS.md` import inside a `CLAUDE.md` (Claude-specific instructions can follow the import), or a symlink (`ln -s AGENTS.md CLAUDE.md`) where no Claude-specific content is needed. `/init` with `CLAUDE_CODE_NEW_INIT=1` set will also read `AGENTS.md` and other tools' rule files and fold relevant parts in.
- **CLAUDE.md is delivered as a user message after the system prompt, not as part of the system prompt itself** — explicitly documented as the reason instructions aren't followed with the same reliability as a hard-coded rule; the docs' own recommendation for system-prompt-level, always-applied instructions in automation is `--append-system-prompt`, which "must be passed every invocation."
- **CLI flags for system-prompt injection** (from `code.claude.com/docs/en/cli-reference`, fetched via automated extraction, partially cross-checked against the sub-agents page): `--system-prompt` (replace the whole system prompt), `--append-system-prompt` (append to the default system prompt), `--append-subagent-system-prompt` (append to every subagent's system prompt in non-interactive mode, confirmed independently on the sub-agents page).
- **Auto memory** (`~/.claude/projects/<project>/memory/MEMORY.md` + topic files) is a separate, Claude-authored mechanism layered on top of `CLAUDE.md`; it is not inherited by subagents except on a conversation *fork*.

---

## 2. Codex CLI — parallelism: native vs. orchestrator-side

### 2a. A native multi-agent mechanism exists, but it doesn't reach `codex exec`

The installed binary's own feature-flag introspection (`codex features list`, run locally on codex-cli 0.146.1) shows:

```
multi_agent                          stable             true
multi_agent_v2                       stable             false
multi_agent_mode                     removed            false
```

`multi_agent` is a **stable, enabled-by-default** feature in this install (also set in `~/.codex/config.toml`: `[features] multi_agent = true`). Cross-referencing the hosted docs at [`learn.chatgpt.com/docs/agent-configuration/subagents`](https://learn.chatgpt.com/docs/agent-configuration/subagents) (fetched 2026-08-11, via automated extraction) confirms what this flag is:

- Custom agents are TOML files at **`~/.codex/agents/`** (personal) or **`.codex/agents/`** (project). Required fields: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`.
- Invocation is described as: direct natural-language requests inside an interactive session ("ask for subagents or parallel agent work directly"), the `/agent` command to "switch between active agent threads and inspect the ongoing thread," or delegation triggered by `AGENTS.md`/skill instructions.
- A config field, `agents.max_concurrent_threads_per_session`, caps "concurrently open spawned-agent threads."

**Process isolation model — LOW CONFIDENCE / inferred:** the docs consistently call spawned subagents "agent threads" within one interactive session, never mention them as separate OS processes, and every invocation path described (`/agent`, "ask Codex in an interactive CLI session") is interactive-TUI-shaped. No primary source found in this spike documents `multi_agent` / `.codex/agents/*.toml` as reachable from `codex exec` (the non-interactive entry point). Practically: **this native mechanism is not usable by an external orchestrator today** — it's a capability of one live Codex session talking to itself, not a parallel-processing primitive Agent Foundry can drive from the outside. This is the one claim in this doc not settled by a direct primary-source statement; it's inferred from the consistent absence of `codex exec` in every description of how subagents are invoked, cross-checked across three independently fetched pages (subagents, non-interactive-mode, config-advanced) that all fail to mention it.

Given that, the only parallel-Codex mechanism actually available to an orchestrator is **spawning independent `codex exec` processes**, which the prototype below tests directly.

### 2b. `AGENTS.md` — file discovery, precedence, size limit

From [`learn.chatgpt.com/docs/agent-configuration/agents-md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md) (fetched 2026-08-11, via automated extraction; the repo's `docs/agents_md.md` stub at commit [`279b932`](https://github.com/openai/codex/blob/279b93242cfef379e65da97e87e44b83c5934fd7/docs/agents_md.md) points here):

- File names, in precedence order: **`AGENTS.override.md`** (highest) then **`AGENTS.md`**; a fallback filename list is configurable via `project_doc_fallback_filenames`.
- Search order: **global** (`~/.codex/`, or `$CODEX_HOME`) first, stopping at the first non-empty file, then **project scope**, walking from the git root down to the current working directory (at most one file per directory).
- **Merge direction: root-to-cwd, concatenated with blank lines, later (closer-to-cwd) files override earlier guidance** by appearing later in the combined prompt — the same "last-read wins in practice" shape as Claude's `CLAUDE.md` loading.
- Size limit: **32 KiB by default** (`project_doc_max_bytes`); empty files are skipped; the chain rebuilds on every run, no caching.
- Unlike Claude Code, Codex reads `AGENTS.md` natively — no import/symlink interop step needed for a repo that already standardized on it.

### 2c. Non-interactive mode (`codex exec`) — what an orchestrator actually calls

From [`learn.chatgpt.com/docs/non-interactive-mode`](https://learn.chatgpt.com/docs/non-interactive-mode) (fetched 2026-08-11, via automated extraction) plus this spike's own `codex exec --help` (`codex-cli 0.146.1`, run locally 2026-08-11):

- `codex exec [OPTIONS] [PROMPT]` — streams progress to `stderr`, prints only the final agent message to `stdout` by default; `--json` switches `stdout` to a JSON-Lines event stream ("every event Codex emits").
- Relevant flags exercised in the prototype: `-C, --cd <DIR>` (working root), `-s, --sandbox <read-only|workspace-write|danger-full-access>`, `--skip-git-repo-check`, `-c, --config <key=value>` (dotted-path TOML override, e.g. `-c model_reasoning_effort=low`), `-m, --model <MODEL>`, `-o, --output-last-message <FILE>`.
- Documented failure behavior: "If you configure an enabled MCP server with `required = true` and it fails to initialize, `codex exec` exits with an error instead of continuing." The docs do **not** document concurrent-invocation behavior, session isolation across parallel invocations, or a general exit-code reference — this spike's prototype supplies that evidence directly instead (Section 3).

### 2c-bis. System-prompt / instructions-override mechanism for `codex exec`

Claude's `--system-prompt`/`--append-system-prompt` (Section 1) have no direct CLI-flag equivalent in Codex: **`codex --help` and `codex exec --help` (checked directly, this spike, codex-cli 0.146.1) expose no `--instructions`, `--system-prompt`, or similarly-named flag.** The mechanism exists, but one layer down, as `config.toml` fields rather than dedicated flags — reachable non-interactively either via a persisted config file or per-invocation with `-c key=value` (the same override flag already used in this spike's prototype for `model_reasoning_effort`). Three root-level fields, confirmed both in the doc-comments at [`codex-rs/config/src/config_toml.rs` L214-219](https://github.com/openai/codex/blob/279b93242cfef379e65da97e87e44b83c5934fd7/codex-rs/config/src/config_toml.rs#L214-L219) and, word-for-word, in the hosted reference table at [`learn.chatgpt.com/docs/config-file/config-reference`](https://learn.chatgpt.com/docs/config-file/config-reference) (fetched raw via `curl` 2026-08-11, not just the automated-extraction summary):

| Field | Source doc-comment | Reference-page description |
| --- | --- | --- |
| `developer_instructions` | "Developer instructions inserted as a `developer` role message." | "Additional developer instructions injected into the session (optional)." |
| `instructions` | "System instructions." | **"Reserved for future use; prefer `model_instructions_file` or `AGENTS.md`."** |
| `model_instructions_file` | "Optional path to a file containing model instructions that will override the built-in instructions for the selected model. Users are STRONGLY DISCOURAGED from using this field, as deviating from the instructions sanctioned by Codex will likely degrade model performance." | "Replacement for built-in instructions instead of `AGENTS.md`." |

Reading the three together: **`instructions` is dead** — present in the schema but explicitly documented as not wired up. `developer_instructions` is Codex's real, functional analog to Claude's `--append-system-prompt`: an always-applied instructions block injected as a distinct message role, independent of `AGENTS.md`/project files. `model_instructions_file` is the analog to Claude's `--system-prompt` full-replace, but — unlike Claude's flag, which carries no such warning — Codex's own maintainers document it as "STRONGLY DISCOURAGED."

**Prototype-verified, not just documented:** ran `codex exec -C .scratch/482-cli-prototype/ws-a --sandbox workspace-write -c model_reasoning_effort=low -c 'developer_instructions="Before anything else, you must run a shell command that does: echo CONFIRMED_DEV_INSTR >> devcheck.txt. Then reply with the single word OK."' --json "Say hello."` (2026-08-11, real network call, no mocking). The user prompt only said "Say hello"; the model instead executed the injected shell command first — `ws-a/devcheck.txt` contains `CONFIRMED_DEV_INSTR` and the JSONL log shows `{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'echo CONFIRMED_DEV_INSTR >> devcheck.txt'","exit_code":0,...}}` followed by `agent_message: "OK"`. `-c developer_instructions=...` on `codex exec` genuinely works as an always-applied, per-invocation instructions-injection point — the practical equivalent of Claude's `--append-system-prompt` for an orchestrator, just spelled as a config override rather than a first-class flag. (Raw evidence: `.scratch/482-cli-prototype/logs/g.jsonl`, gitignored, not committed — same convention as the Section 3 prototype logs.)

### 2d. Auth and rate-limit sharing across concurrent processes

`codex doctor` (run locally) shows this install authenticates via `auth mode: chatgpt` against `wss://chatgpt.com/backend-api/...` — one account-level credential, not a per-process token. From [`learn.chatgpt.com/docs/pricing`](https://learn.chatgpt.com/docs/pricing) (fetched 2026-08-11, via automated extraction): **"The usage limits for local messages and cloud chats share a five-hour window,"** with "additional weekly limits" layered on top. Nothing in the fetched pricing/config docs distinguishes concurrent-session usage from sequential usage — the framing throughout is a single account-level rolling-window pool. (A more specific OpenAI Help Center article on this, `help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan`, returned HTTP 403 to automated fetch in this spike and is not used as a citation; the `learn.chatgpt.com/docs/pricing` page is the primary source actually used.) **Practical read: N concurrent `codex exec` processes under one account draw from the same 5-hour/weekly pool — parallelism buys wall-clock speed, not additional throughput headroom, and a burst of concurrent processes can exhaust the window faster than the same work run sequentially.** This matches what the prototype observed directly (Section 3): both concurrent runs succeeded with no auth contention error, consistent with one shared credential serving multiple simultaneous requests rather than any kind of per-process lock.

---

## 3. Prototype — orchestrator-side parallel `codex exec`

**Method.** Built under `.scratch/482-cli-prototype/` (gitignored — added `.scratch/` to `.gitignore` in this branch since it wasn't already covered; verified with `git check-ignore -v .scratch/x` after the change). One bash script, `run-parallel.sh`, launches pairs of real `codex exec` invocations in the background with `&`, records start/end wall-clock timestamps and exit codes via `wait`, and captures each invocation's `--json` stdout and stderr to separate log files. All invocations used `-c model_reasoning_effort=low` (except the deliberate-failure case) to keep the spike cheap; every run is a real network call against this machine's live ChatGPT-authenticated Codex account — no mocking.

Three tests, run back to back in one script execution on 2026-08-11 (times UTC, `codex-cli 0.146.1`). PIDs jump from 3-digit in Test 1 (`293`, `299`) to 4-digit in Tests 2-3 (`3027`+): this is the shell's own PID counter climbing as the script's own `codex` invocations and their sandbox/helper child processes accumulate across the run, not a sign of a different or fabricated log — each PID above is the direct `codex exec` process this script's `&`/`wait` launched, confirmed by the 1:1 match between logged PIDs and log-file contents.

**Test 1 — basic concurrency, separate workspaces.** Two `codex exec -C .scratch/482-cli-prototype/ws-{a,b} --sandbox workspace-write` processes, each told to append a line to its own `seed.txt` via a shell command and reply `DONE_A`/`DONE_B`.

```
PID_A=293 start=2026-08-11T15:17:39Z   PID_B=299 start=2026-08-11T15:17:39Z
PID_A=293 end=2026-08-11T15:17:52Z rc=0   PID_B=299 end=2026-08-11T15:17:53Z rc=0
```

Both processes started in the same second and ran with overlapping wall-clock windows (~13s runtime each, ending within a second of each other) — real concurrent execution, not serialized. Both exited 0; each `seed.txt` got exactly its own process's line (`ws-a/seed.txt` → `seed-a` / `processed-by-a`; `ws-b/seed.txt` → `seed-b` / `processed-by-b`), confirmed by reading the files after the run.

**Test 2 — same-account concurrency plus a deliberately forced failure.** One normal process (`ws-a`, appends `processed-by-c`) run alongside one process given `-m this-model-does-not-exist-xyz` (an invalid model ID, forcing a process-level failure rather than a mid-task tool error).

```
PID_C=3027 start=2026-08-11T15:17:53Z   PID_D=3033 start=2026-08-11T15:17:53Z
PID_C=3027 end=2026-08-11T15:18:02Z rc=0   PID_D=3033 end=2026-08-11T15:18:02Z rc=1
```

The good process (C) completed normally and was **not slowed or blocked by the sibling's failure** — both ended within the same second, and C's own `--json` stream shows a normal `turn.completed` with real token usage (`input_tokens: 46290, output_tokens: 121`), so the account-level auth and rate-limit pool tolerated both requests simultaneously with no lock/contention error surfaced to either side.

Failure surfacing, read directly from the raw logs:
- **`stderr` for the failed process (`d.stderr`) contained only:** `Reading additional input from stdin...` — not informative on its own.
- **The actual error is in the `--json` stdout stream (`d.jsonl`)**, as a sequence of events ending in:
  ```json
  {"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'this-model-does-not-exist-xyz' model is not supported when using Codex with a ChatGPT account.\"}}"}
  {"type":"turn.failed","error":{"message":"...same message..."}}
  ```
- **Process exit code was 1** (`RC_D=1`), confirming the failure is also visible without parsing JSON at all — a caller that only checks exit codes gets a correct pass/fail signal; a caller that wants the *reason* must parse `stdout` JSONL, not `stderr`.

**Implication for an orchestrator:** wire failure detection off `codex exec`'s exit code (cheap, reliable pass/fail) and, when a reason is needed, off `--json` stdout's `type: "error"` / `type: "turn.failed"` events — not `stderr`, which in this run carried no diagnostic content.

**Test 3 — workspace contention.** Two processes both `-C`'d into the *same* directory (`ws-shared`), both appending a line to the *same* file (`shared.txt`) via a shell `echo >>` command, run concurrently.

```
PID_E=5391 start=2026-08-11T15:18:02Z   PID_F=5398 start=2026-08-11T15:18:02Z
PID_E=5391 end=2026-08-11T15:18:13Z rc=0   PID_F=5398 end=2026-08-11T15:18:13Z rc=0
```

Both succeeded; `shared.txt` ended up with both lines intact (`shared-seed` / `processed-by-f` / `processed-by-e`, order interleaved by scheduling but not corrupted) — no crash, no lock error, no data loss for this trivial case. **Caveat, not a general "no contention" finding:** this only exercises a single atomic shell append per process. It does not test two processes concurrently running Codex's own file-edit tooling (`apply_patch`) against the *same* file, which is the shape of contention that would actually matter for two orchestrator-spawned Codex tasks working the same repo — that scenario is untested here and should not be assumed safe on the strength of this result alone (see follow-up tickets below).

Raw evidence for all three tests — `--json` JSONL streams, `stderr`, and the `timing.txt` wall-clock/exit-code log — lives in `.scratch/482-cli-prototype/logs/` on this branch's working tree. It is **not committed** (gitignored, throwaway per the ticket's constraints); this doc is the durable record of what was observed.

---

## 4. Go/no-go decision

**Decision: GO**, with named constraints, on **orchestrator-side parallel `codex exec` processes** as the parallel-Codex mechanism for HA-D. Native Codex `multi_agent` is **not** the mechanism — it's real but confined to a single interactive session and not documented as reachable from `codex exec`, so it can't be what an external orchestrator drives (Section 2a).

**Constraints that drove this decision, to carry into any build ticket:**

1. **Shared account-level rate limit.** One ChatGPT auth serves every concurrent process from the same 5-hour rolling + weekly quota pool (Section 2d). Concurrency must be bounded by a concurrency limit the orchestrator enforces itself — Codex CLI does not appear to enforce or coordinate this across independent processes — and should be treated as a throughput multiplier for wall-clock time only, not for total capacity.
2. **Failure detection must use exit code + `--json` stdout, never `stderr`.** Confirmed directly in Test 2: `stderr` carried no diagnostic content for a real process-level failure; the actual error and the `turn.failed` event live in the JSONL stream on `stdout`.
3. **Workspace contention beyond trivial shell writes is unproven.** Test 3 only rules out corruption for a single atomic append; it says nothing about two orchestrator-spawned `codex exec` processes both running `apply_patch`-style edits against the same file or the same git working tree at once. Until that's tested, orchestrator-side parallel Codex tasks should be scoped to **non-overlapping workspaces per task** (e.g. separate git worktrees, mirroring how Claude Code's own `isolation: worktree` subagent field handles the same problem — Section 1), not assumed safe to run against a shared checkout.
4. **No native supervision/failure-propagation primitive from Codex itself.** Unlike Claude Code's background-subagent completion-notification and typed-API-error-failure model (Section 1), an orchestrator spawning raw `codex exec` processes must build its own process supervision, timeout, and result-collection layer — there is nothing in Codex CLI analogous to Claude's `Agent` tool for this. **This is an absence-of-documentation inference, same caveat as Section 2a's LOW CONFIDENCE call:** no primary source describes such a primitive, but none was searched for as exhaustively as the subagent-invocation question in 2a.

---

## 5. Follow-up HA-D tickets — drafted here, not created

Per the ticket's acceptance criteria, these are titles + one-paragraph scope each, to be filed as real GitHub issues just-in-time, after this doc is reviewed, as children of [Epic HA-D #472](https://github.com/eedsilva/agent-foundry/issues/472). Not created in this ticket.

1. **Orchestrator-side parallel Codex process pool.** Build the process-spawning/supervision layer implied by the go decision: bounded concurrency (configurable, defaulting conservatively given the shared rate-limit pool), one git-worktree-isolated workspace per concurrent task, exit-code + `--json` JSONL-stream failure parsing (per Section 3's Test 2 finding), and a result-collection API the orchestrator's existing task graph can consume. Should reuse the worktree-isolation pattern Claude Code's own `isolation: worktree` subagent field already validates as the safe answer to workspace contention.
2. **Concurrent `apply_patch`/file-edit contention test.** This spike deliberately left this untested (Section 3, Test 3 caveat): two `codex exec` processes both editing the same file or same git working tree via Codex's real edit tooling, not a trivial shell append. Needed before enabling parallel Codex tasks against anything less isolated than one worktree per task; should also probe what happens when two processes both attempt `git commit` in the same non-worktree-isolated checkout.
3. **Per-role prompt overhaul using each CLI's real prompt-surface mechanics.** Sibling to [#483](https://github.com/eedsilva/agent-foundry/issues/483): use Claude Code's documented `--append-subagent-system-prompt` / `CLAUDE.md` precedence and Codex's `AGENTS.md` root-to-cwd merge (Sections 1 and 2b) — rather than assuming both CLIs resolve prompt layering the same way — when redesigning planner/developer/reviewer/verifier prompts per role.
4. **Rate-limit-aware concurrency throttling.** Once ticket 1 exists, add live rate-limit-window awareness (backing off concurrency as the 5-hour/weekly pool from Section 2d is consumed) rather than a static concurrency cap, so bursts of parallel Codex tasks don't starve later sequential work in the same account window.
