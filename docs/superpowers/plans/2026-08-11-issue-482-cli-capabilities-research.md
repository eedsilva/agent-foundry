# Plan: Issue #482 — CLI subagent/parallelism/prompt-surface research spike

Source ticket: https://github.com/eedsilva/agent-foundry/issues/482 (parent epic #472, "[Epic HA-D] CLI prompting & subagent orchestration").

## Global Constraints

- **No production code changes.** This ticket is research-only. The only committed artifact is the doc below.
- **Deliverable location:** `docs/evidence/harness-alignment/cli-capabilities.md`.
- **Primary sources only:** official Claude Code docs (code.claude.com/docs) and official Codex CLI docs/repo. Record the installed CLI versions (`claude --version`, `codex --version`) in the doc. No secondary sources (blogs, forums, listicles) unless a primary source is silent — and if used, mark it explicitly as lower-confidence, same convention as `docs/evidence/ai-app-builder-loop-architecture.md`.
- **Prototype is throwaway:** build it under a scratch dir (e.g. `.scratch/482-cli-prototype/`, already gitignored), keep raw transcripts as evidence attached to the doc or summarized inline, merge no prototype code into the tree.
- **Doc quality bar:** match the structure and rigor of `docs/evidence/ai-app-builder-loop-architecture.md` — dated citations, a source-quality table, a "Bottom line" summary up top, explicit confidence markers on anything inferred rather than sourced.
- **Must end with an explicit go/no-go decision** on orchestrator-side parallel Codex processes, with the constraints that drove it named.

## Task 1: Research, prototype, and write the decision doc

**Outcome:** A cited, in-repo research doc settling, from primary docs plus a minimal throwaway prototype:
1. Claude CLI subagent configuration the orchestrator can drive (`.claude/agents`, the Task tool, relevant flags).
2. Codex CLI parallelism options — native (if any) vs. orchestrator-side parallel processes, including auth/rate-limit/workspace-contention constraints.
3. Prompt surfaces per CLI (system prompt injection, `AGENTS.md`, per-task context) and their precedence.
4. An explicit go/no-go decision on orchestrator-side parallel Codex processes.

**Acceptance criteria (from the ticket):**
- Doc committed under `docs/evidence/` with citations to primary docs and prototype transcripts.
- Explicit decision recorded: parallel-Codex mechanism chosen or rejected, with constraints named.
- Follow-up build tickets for HA-D drafted **inside the doc** (as a section — titles + one-paragraph scope each), not created as actual GitHub issues (that happens just-in-time, later, outside this ticket).

**Steps:**
1. Record installed CLI versions: `claude --version`, `codex --version`.
2. Research Claude Code CLI: subagent configuration (`.claude/agents/*.md` frontmatter, the `Task`/`Agent` tool, relevant CLI flags), and prompt surfaces (system prompt injection points, `CLAUDE.md`/`AGENTS.md` precedence, per-task context passing). Cite official docs with URLs and fetch dates.
3. Research Codex CLI: any native parallelism/subagent mechanism vs. running multiple orchestrator-side `codex` processes; auth/session and rate-limit sharing; workspace contention when two processes touch one repo; how a failure in a spawned process surfaces back to a caller. Cite official docs/repo with URLs, commit SHAs, and fetch dates.
4. Build a minimal throwaway prototype under `.scratch/482-cli-prototype/` that actually exercises the parallel-Codex question: launch two `codex` CLI invocations concurrently (same auth) against non-conflicting scratch workspaces, observe what happens with shared auth/rate limits and how a deliberately-forced failure in one surfaces. Keep the raw transcript/output as evidence. This is exploratory, not a suite — one runnable script is enough; it does not need its own test framework, but capture the actual command(s) run and output in the doc/evidence so the finding is reproducible, not asserted.
5. Write `docs/evidence/harness-alignment/cli-capabilities.md`: bottom-line summary, source-quality table, the three research areas with citations, the prototype method + raw findings, the explicit go/no-go decision with named constraints, and the drafted-but-not-created HA-D follow-up ticket list.
6. Self-review: confirm every claim has a citation or is explicitly marked as prototype-observed or inferred; confirm no production code was touched (`git status` clean outside the new doc + gitignored scratch dir); confirm the doc ends with an unambiguous decision.

**Out of scope:** any production code change; creating the follow-up GitHub issues themselves; blocking-gate design (that's #477/HA-A.3, unrelated track).
