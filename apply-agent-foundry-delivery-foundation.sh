#!/usr/bin/env bash
set -euo pipefail

PATCH_BASE="92b071ceb3365cb74d954cc67c496e3e5ecc9e6a"
BRANCH="chore/delivery-foundation"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="${1:-$SCRIPT_DIR/agent-foundry-delivery-foundation-patch.patch}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Execute este script dentro do clone de eedsilva/agent-foundry." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "A árvore de trabalho não está limpa. Commit, stash ou descarte as alterações antes de continuar." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$PATCH_BASE" HEAD; then
  cat >&2 <<MSG
HEAD não contém o commit base do patch.
Esperado como ancestral: $PATCH_BASE
HEAD atual:              $(git rev-parse HEAD)

Verifique que você está no branch correto e que o commit base existe no histórico.
MSG
  exit 1
fi

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "Patch não encontrado: $PATCH_FILE" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "A branch $BRANCH já existe. Remova-a ou aplique o patch manualmente." >&2
  exit 1
fi

git switch -c "$BRANCH"
git apply --check "$PATCH_FILE"
git apply "$PATCH_FILE"

npm ci
npm run check

cat <<'MSG'

Patch aplicado e validado localmente.

Revise o diff, execute os dry-runs e só então permita mutações no GitHub:

  git diff --stat
  npm run github:roadmap:dry-run
  npm run github:governance:dry-run

Depois, com GH_TOKEN/GITHUB_TOKEN adequado:

  npm run github:roadmap:apply
  npm run github:governance:apply

O reconciliador do roadmap atualiza planning/github-state.json. Inclua esse arquivo no commit.
MSG
