# ADR 0004: Treat model capabilities as priors, not truth

- Status: Accepted
- Date: 2026-07-11
- Owners: Research

## Context

Choosing a model by brand or intuition hides cost, latency, task fit, and uncertainty. Early data is too sparse for a learned router.

## Decision

Start with editable capability priors and hard constraints. Record selected, attempted, and executed models separately. Adaptive routing remains exploratory until human acceptance and deterministic outcomes provide enough evidence.

## Alternatives considered

A static provider-per-role mapping is simple but unmeasured. Machine learning now would fit noise and produce false confidence.

## Consequences

Routing stays explainable and reversible. Priors must be labeled subjective, and sample size/confidence must accompany future learned scores.

## Validation and rollback

Canary corpus and dogfooding measure time to accepted result. Fixed routing is the rollback policy.
