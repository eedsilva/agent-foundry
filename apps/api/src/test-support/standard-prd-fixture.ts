/** A PRD Standard 1 document that passes `validateStandardPrd` (#643). Content is arbitrary; only conformance matters for tests that create a project as setup. */
export const VALID_STANDARD_PRD = `# PRD — Task list
PRD Standard: 1
Interface language: pt-BR

## 1. Problem and objective / Problema e objetivo

Organize personal tasks with a measurable weekly completion view.

## 2. Users and roles / Usuários e papéis

- Application Owner: owns all task records.

## 3. Scope and non-goals / Escopo e não objetivos

### In scope

## 4. Primary journeys / Jornadas principais

1. Owner creates a task and sees it in the list.

## 5. Screens and states / Telas e estados

### Visual direction / Direção visual

## 6. Functional requirements / Requisitos funcionais

- **FR-001**: The owner can create a task.

## 7. Conceptual data and ownership / Dados conceituais e propriedade

### Task

## 8. Business rules / Regras de negócio

- **BR-001**: A task belongs to exactly one owner.

## 9. Authentication and permissions / Autenticação e permissões

- Owners must authenticate before accessing tasks.

## 10. Non-functional requirements / Requisitos não funcionais

- **NFR-001**: The task list is keyboard accessible.

## 11. Acceptance criteria / Critérios de aceite

- **AC-001** — Verifies: FR-001, BR-001, NFR-001
  - Given an authenticated owner
  - When the owner creates a task
  - Then the task appears in the owner task list.

## 12. Assumptions / Premissas

None

## 13. Open decisions / Decisões em aberto

None`;
