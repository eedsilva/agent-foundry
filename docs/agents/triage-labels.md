# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Relationship to the delivery taxonomy

These five are **orthogonal** to the repo's existing `kind:` / `area:` / `priority:` / `track:` / `target:` / `commitment:` labels — a triage label answers _"is this ready to be worked?"_, the delivery labels answer _"what is it and who owns it?"_. Apply both.

`wontfix` predates these skills and already existed in the repo; the other four were created by `/setup-matt-pocock-skills`.
