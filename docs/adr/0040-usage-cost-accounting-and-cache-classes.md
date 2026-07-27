# ADR 0040: Separate provider usage classes from cost estimates

- Status: Accepted
- Date: 2026-07-27
- Owners: model-router

## Context

The Claude executor flattened `cache_read_input_tokens` into one generic cache
count and stored the CLI's `total_cost_usd` as `estimatedCostUsd` while marking
it `provider-reported`. The Router UI then rendered that value as provider
currency even when the selected model used subscription billing. The observed
issue-328 request reconciles with Anthropic's published rates when its cache
count is treated as cache reads, not as a billed provider total.

## Decision

Keep cache reads and writes as separate usage fields. Preserve a provider's raw
cost as `providerReportedCostUsd`, but display it as a CLI estimate. Compute a
separate `estimatedCostUsd` from the model catalog's versioned, source-linked
rate table. Cache writes are only priced when usage identifies the TTL (`5m` or
`1h`); otherwise their cost is unknown rather than falsely reconciled.

## Alternatives considered

- Keep the provider total as billed currency — rejected because subscription
  quota estimates are not provider invoices.
- Infer cache-write TTL from token counts — rejected because the same count can
  use either published write rate.
- Collapse reads and writes for one cache rate — rejected because it produces
  materially different totals.

## Consequences

Known read-cache requests can be compared with published rates, and the UI no
longer claims that a subscription estimate is provider-reported currency. Some
cache-write requests intentionally show no computed dollar total until the
provider exposes a TTL. The additive fields remain backward compatible with
persisted records.

## Validation and rollback

The domain regression tests pin the three issue-328 counts and the catalog rate
table metadata; executor tests pin read/write parsing. Revert this ADR and the
implementation together to restore the previous labels and calculation.
