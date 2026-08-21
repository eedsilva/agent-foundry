# ADR 0074: An approved Standard PRD is the only build input

- Status: Accepted
- Date: 2026-08-18
- Owners: Product, Core
- Specified by: [PRD Standard v1](../PRD_STANDARD.md)

## Context

Project creation currently accepts any trimmed string between 50 and 500,000 characters and immediately queues planning. Existing validation PRDs use similar ideas but no enforceable content contract. The initial product instead begins from a user-supplied PRD and must prevent Task Agents from inventing product decisions that were never approved.

## Decision

Every PRD is structured Markdown conforming to the PRD Standard. At minimum it states the product objective, users, journeys, functional scope, conceptual data and ownership, screens, business rules, acceptance criteria, and explicit non-goals.

Agent Foundry validates and normalizes the document without a model call, presents the exact candidate PRD, and requires explicit operator approval before Haiku planning. Missing required content blocks approval. If Haiku later discovers a semantic ambiguity, execution pauses with only the Blocking Questions; it does not infer the missing product decision.

Approval creates an immutable PRD Revision. Planning, the Schema Plan, implementation, verification, and evidence all retain that revision's identity. Editing requirements creates and approves a new revision and starts a new planning lineage; it never mutates an active run's input.

The first acceptance milestone supports responsive web applications only, always with email/password authentication, protected routes, sessions, and RLS. Reference images and document attachments are deferred until after Issue Radar Lite passes both Local and Cloudflare Targets. Third-party API integrations, mobile, desktop, extensions, and interface-less API products are outside this milestone.

## Consequences

The current length-only creation contract and immediate queueing behavior must change. Future idea-to-PRD chat may produce a draft, but it must satisfy and pass the same approval contract before planning. Existing validation PRDs need migration to the PRD Standard rather than becoming special cases.
