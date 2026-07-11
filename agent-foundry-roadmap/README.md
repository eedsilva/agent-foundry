# Bootstrap do roadmap do Agent Foundry

Este pacote contém:

- `roadmap-spec.json`: fonte de verdade com labels, milestones, epics e 88 sub-issues.
- `bootstrap-github-roadmap.mjs`: importador idempotente para GitHub.
- `ROADMAP.md`: visão humana do backlog.

## Contagem

- 20 labels
- 12 milestones
- 1 issue raiz
- 12 epics
- 88 sub-issues
- 101 issues no total

## Segurança

Não cole tokens no chat, no spec ou em issues. Use `GH_TOKEN`, `GITHUB_TOKEN` ou `gh auth login`.

## Execução

```bash
node bootstrap-github-roadmap.mjs
node bootstrap-github-roadmap.mjs --apply
```

Use `--reconcile` apenas para substituir os campos gerenciados de itens já existentes.
