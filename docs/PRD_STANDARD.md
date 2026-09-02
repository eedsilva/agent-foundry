# PRD Standard v1

This standard defines the only PRD shape Agent Foundry accepts for a new Generated Application. The document is human-authored and human-approved Markdown; deterministic validation runs before the first Task Agent call.

## Contract

- Maximum length: 50,000 characters per milestone.
- Content may be Portuguese or English.
- `Interface language` is required and defines the Generated Application's only interface language for this revision. Runtime language switching and translation catalogs are unsupported.
- Section headings and requirement identifiers are stable so validation and evidence can reference them.
- `FR-NNN`, `BR-NNN`, `NFR-NNN`, and `AC-NNN` identifiers are unique and never renumbered inside a PRD Revision.
- Every acceptance criterion names the requirements it verifies and describes an observable result.
- All required sections must exist. Use `Not applicable` or `Não aplicável` with a reason instead of deleting a section.
- Approval is blocked while `Open decisions` contains an item or the document contains `TBD` or `TODO`. Both markers are matched in uppercase only, so the Portuguese word `todo` and the English word `todo` in product text are not markers.
- Fixed tokens are accepted in both content languages, ignoring case: `None`, `Nenhuma`, and `Nenhum` mean no item; `Not applicable` and `Não aplicável` mean a section does not apply and require a reason.
- The PRD describes product behavior, not framework choices, SQL tables, columns, migrations, or implementation tasks.
- Every `FR`/`BR`/`NFR` item must declare at least one [Supported Application Envelope](SUPPORTED_APPLICATION_ENVELOPE.md) capability with a backticked `` `capability:<slug>` `` marker inside that item. Classification is deterministic and never inferred from prose: a known exclusion blocks intake and names the alternative, an unknown slug becomes a Blocking Question tied to the requirement identifier, missing classification becomes a Blocking Question, and markers outside an identified requirement are Blocking Questions as well.
- Approval creates an immutable PRD Revision. A requirement change creates a new revision and planning lineage; a repair that restores the existing contract does not.
- The approved document is stored as `PRD.md` at the Standalone Repository root and as a hash-addressed Agent Foundry artifact.

## Required template

```md
# PRD — <Application name>

PRD Standard: 1
Interface language: <BCP 47 tag, for example pt-BR or en-US>

## 1. Problem and objective / Problema e objetivo

<What problem exists, for whom, and which measurable outcome this milestone should produce.>

## 2. Users and roles / Usuários e papéis

- <Role>: <responsibilities and access boundary>

## 3. Scope and non-goals / Escopo e não objetivos

### In scope

- <Capability included in this milestone>

### Non-goals

- <Explicitly excluded capability>

## 4. Primary journeys / Jornadas principais

1. <Starting state → user actions → accepted outcome>

## 5. Screens and states / Telas e estados

### Visual direction / Direção visual

- Tone and audience:
- Information density:
- Palette constraints:
- Typography constraints:
- Textual style references:

### <Screen name>

- Purpose:
- Entry points:
- Visible information and actions:
- Loading, empty, error, forbidden, and success states:
- Navigation outcome:

## 6. Functional requirements / Requisitos funcionais

- **FR-001**: <Required observable behavior>

## 7. Conceptual data and ownership / Dados conceituais e propriedade

### <Entity>

- Meaning:
- Owner:
- Relationships:
- Lifecycle and invariants:
- Who may create, read, update, and delete it:

## 8. Business rules / Regras de negócio

- **BR-001**: <Domain rule or invariant>

## 9. Authentication and permissions / Autenticação e permissões

- Email/password authentication behavior:
- Protected-route behavior:
- Session behavior:
- Role and ownership rules:
- Cross-user denial behavior:

## 10. Non-functional requirements / Requisitos não funcionais

- **NFR-001**: <Observable accessibility, responsiveness, performance, reliability, or security condition>

## 11. Acceptance criteria / Critérios de aceite

- **AC-001** — Verifies: FR-001, BR-001
  - Given <starting state>
  - When <user or system action>
  - Then <observable UI, API, persistence, or authorization result>

## 12. Assumptions / Premissas

- <Explicit non-blocking assumption accepted by the operator, or `None` / `Nenhuma`>

## 13. Open decisions / Decisões em aberto

None
```

## Product boundary

PRD Standard v1 covers responsive web applications inside [Supported Application Envelope v1](SUPPORTED_APPLICATION_ENVELOPE.md). Authentication, protected routes, sessions, and RLS are mandatory. Textual visual direction is required; image or file references are unsupported. The first milestone generates a light theme only. The platform fixes Next.js, Hono, Zod, Supabase, and the Local and Cloudflare Targets outside the PRD. Reference attachments and third-party integrations are not part of the first acceptance milestone.

## Examples of invalid acceptance language

- `The interface should be modern.` — no observable condition.
- `The page should be fast.` — no measurable threshold or journey.
- `Users should have a good experience.` — no state or behavior to verify.
- `Use React and create a users table.` — implementation choices belong to the generated stack and Schema Plan.

Replace subjective language with the exact screen, state, interaction, reference, or measurable result that will prove acceptance.
