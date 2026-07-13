# Testing standard

- Test behavior, contracts, and failure paths rather than implementation trivia.
- Every bug fix should gain a regression test when feasible.
- Keep tests deterministic. Avoid real network access in unit tests.
- Use integration tests where module boundaries or persistence behavior matter.
- A green test command is evidence only when the command and exit code are recorded.
- Default test surface for a generated app: Playwright end-to-end tests over the golden user flows, plus unit tests for domain logic in `lib/` and `features/`. Exhaustive per-component tests are not required.
