# ADR 0078: Task Agents receive bounded deterministic context

- Status: Accepted
- Date: 2026-08-19
- Owners: Core, Safety, Product

## Context

The Economy Profile depends on small, relevant inputs. Sending the whole repository, Git history, old evidence, or runtime logs to every Task Agent would increase cost, weaken instruction focus, and disclose material unrelated to the assigned task. Silently cutting an oversized prompt would be cheaper but could remove the very contract or source needed to implement safely.

Task Agents may also need current product documentation. Unreviewed blogs, forums, or copied code are not acceptable substitutes for an unavailable official source.

## Decision

Agent Foundry compiles one Task Context deterministically for every Task Agent call. It contains only:

- the requirement IDs and exact text from the approved PRD Revision relevant to the Vertical Task;
- the matching approved Task Graph and Schema Plan slice;
- current shared API contracts and Generated Migration identities affected by the task;
- relevant source files and the diff from the matching Accepted Checkpoint;
- the task's acceptance commands, prior bounded attempt result when repairing, and applicable official documentation.

Full repositories, unrelated source, Git history, prior-run evidence, raw logs, and old prompts are excluded by default. Secrets are always excluded. The compiler reuses already approved artifacts and source rather than asking another model to summarize them.

Before dispatch, each call stores a Context Manifest with included paths, artifact identities, content digests, categories, and omission reasons. Advanced mode shows it before and after the call. Normal calls covered by the approved Task Graph require no separate approval, though the operator may pause before dispatch. The manifest does not duplicate raw source or the rendered prompt into operational logs.

Only official documentation explicitly allowed by the Task Network Policy may be added. If a required official source is unavailable, execution pauses with the missing source; it does not substitute blogs, forums, search snippets, or unapproved copied code.

If the complete required Task Context exceeds the selected model's input limit, Agent Foundry proposes splitting the Vertical Task into a new immutable Task Graph Revision. Execution resumes only after operator approval of that revision. It never silently truncates, drops a requirement, or changes models.

## Alternatives considered

- **Send the entire repository.** Rejected because it is usually irrelevant, expensive, and broader than the Provider Data Boundary requires.
- **Ask a model to summarize context first.** Rejected because it spends another call and may erase normative detail before implementation begins.
- **Truncate to the provider limit.** Rejected because a successful request with missing constraints is harder to detect than an explicit pause.
- **Use general web sources when official docs fail.** Rejected because provenance and correctness would be unknown.

## Consequences

The context compiler and Context Manifest become deterministic, acceptance-tested control-plane components. Task planning must produce sufficiently narrow Vertical Tasks, and oversized tasks may require an approved Task Graph revision before implementation. Advanced inspection can explain what was sent without exposing secrets or hidden reasoning.

This boundary lowers expected token cost and disclosure, but it makes relevance selection part of correctness. Missing a required contract is a compiler defect, not permission to let a Task Agent search the whole machine.

## Validation

Acceptance proves stable manifests for identical inputs, inclusion of changed contracts and task requirements, exclusion of unrelated files/history/logs/secrets, official-document failure behavior, explicit over-limit blocking, and no silent truncation.
