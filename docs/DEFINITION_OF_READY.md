# Definition of Ready

An issue may move to `Ready` only when:

- the user or system outcome is explicit;
- acceptance criteria are observable and falsifiable;
- likely touchpoints and dependencies are identified;
- the issue is small enough to finish without becoming an untracked mini-program;
- security, data, migration, provider, and compatibility risks are called out;
- required evidence is named: test, log, screenshot, trace, benchmark, or manual approval;
- non-goals prevent accidental scope expansion;
- blocking relationships represent real technical constraints;
- the target and commitment are correct;
- P0 is used only for an active release blocker or critical safety/data risk.

An `XL` item is not ready. Decompose it first.
