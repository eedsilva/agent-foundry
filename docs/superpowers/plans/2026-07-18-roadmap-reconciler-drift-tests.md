# Roadmap Reconciler Drift-Protection Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #108's last uncovered acceptance criterion — the GitHub roadmap reconciler's dry-run/apply/reconcile CLI parsing and its unexpected-manual-edit drift guard have zero unit test coverage anywhere in the repo, even though the behavior they implement already exists and already runs in CI.

**Architecture:** `scripts/bootstrap-github-roadmap.mjs` is a thin CLI wrapper today, but three of its behaviors are defined as ordinary functions _inside_ the script file, which also runs top-level `await` network calls the moment it's imported — so nothing in it can be unit tested without hitting the network. This plan moves those three functions (`parseArgs`, `assertNoUnexpectedDrift`, `reconcileIssue`) into the existing `scripts/lib/github-roadmap.mjs` module (which already holds the reconciler's other pure/testable logic — `reconcileIssueHierarchy`, `reconcileIssueBlockers` — and already has a `fakeClient` test harness in `scripts/lib/github-roadmap.test.mjs`), re-exports them from the script unchanged, and adds unit tests using the same `fakeClient` pattern already in that test file. No behavior changes.

**Tech Stack:** Node.js 22 built-in test runner (`node:test`, `node:assert/strict`), plain ESM `.mjs` modules — matches every existing file in `scripts/lib/`.

## Global Constraints

- Node version: `v22.22.3` per `.nvmrc` — use only Node 22-compatible syntax (already the case everywhere in `scripts/`).
- No new npm dependencies. `scripts/lib/*.test.mjs` files are picked up automatically by the existing glob in `package.json`'s `test:scripts` script (`node --test scripts/lib/*.test.mjs`) and by CI's `test` job (`npm test`) — no wiring changes needed.
- Zero behavior change: `bootstrap-github-roadmap.mjs`'s CLI flags, help text, dry-run default, and drift-check error message must be byte-for-byte identical before and after this plan. This is a pure extract-for-testability refactor.
- Follow the existing file split convention: `scripts/<name>.mjs` = thin CLI entrypoint with top-level `await`; `scripts/lib/<name>.mjs` = pure/testable exported functions; `scripts/lib/<name>.test.mjs` = its tests. (See `scripts/validate-roadmap.mjs` + `scripts/lib/roadmap.mjs` for the reference pattern.)
- Do not touch `printHelp()` or the `--help`/`-h` branch's `process.exit(0)` call — out of scope, not part of issue #108's acceptance criteria, and `process.exit` inside a pure function is untestable without extra scaffolding this issue doesn't need.

---

### Task 1: Extract and test `parseArgs`

**Files:**

- Modify: `scripts/lib/github-roadmap.mjs`
- Modify: `scripts/bootstrap-github-roadmap.mjs`
- Test: `scripts/lib/github-roadmap.test.mjs`

**Interfaces:**

- Consumes: nothing new.
- Produces: `parseArgs(argv, { onHelp } = {})` exported from `scripts/lib/github-roadmap.mjs`, returning `{ apply: boolean, reconcile: boolean, forceDrift: boolean, adoptExisting: boolean, delayMs: number, repo: string | null }`. Throws `Error` on an unknown flag or an invalid `--delay-ms`. Later tasks do not depend on this function's output shape.

The current `parseArgs` in `scripts/bootstrap-github-roadmap.mjs` (lines 20-45) calls `printHelp()` and `process.exit(0)` directly on `--help`/`-h`. To keep it pure and testable, thread the help action through an injectable callback instead of hardcoding `process.exit`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/lib/github-roadmap.test.mjs` (add this import to the existing top import block, keeping the rest of the file untouched):

```javascript
import { parseArgs } from './github-roadmap.mjs';
```

Then append these test blocks at the end of the file:

```javascript
test('parseArgs: dry-run é o padrão', () => {
  const options = parseArgs([]);
  assert.deepEqual(options, {
    apply: false,
    reconcile: false,
    forceDrift: false,
    adoptExisting: false,
    delayMs: 500,
    repo: null,
  });
});

test('parseArgs: liga apply, reconcile, force-drift e adopt-existing', () => {
  const options = parseArgs(['--apply', '--reconcile', '--force-drift', '--adopt-existing']);
  assert.equal(options.apply, true);
  assert.equal(options.reconcile, true);
  assert.equal(options.forceDrift, true);
  assert.equal(options.adoptExisting, true);
});

test('parseArgs: aceita --repo e --delay-ms com valor customizado', () => {
  const options = parseArgs(['--repo', 'o/r', '--delay-ms', '10']);
  assert.equal(options.repo, 'o/r');
  assert.equal(options.delayMs, 10);
});

test('parseArgs: rejeita --delay-ms inválido', () => {
  assert.throws(() => parseArgs(['--delay-ms', 'nope']), /--delay-ms inválido/);
  assert.throws(() => parseArgs(['--delay-ms', '-1']), /--delay-ms inválido/);
});

test('parseArgs: rejeita flag desconhecida', () => {
  assert.throws(() => parseArgs(['--bogus']), /Argumento desconhecido: --bogus/);
});

test('parseArgs: --help invoca o callback ao invés de encerrar o processo', () => {
  let called = false;
  parseArgs(['--help'], {
    onHelp: () => {
      called = true;
    },
  });
  assert.equal(called, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: FAIL — `parseArgs` is not exported from `./github-roadmap.mjs` (import error / undefined is not a function).

- [ ] **Step 3: Move `parseArgs` into `scripts/lib/github-roadmap.mjs` with an injectable help callback**

Add this export to `scripts/lib/github-roadmap.mjs` (place it near the top, after the existing imports if any — the file currently has no imports, so this becomes the first export):

```javascript
export function parseArgs(argv, { onHelp } = {}) {
  const options = {
    apply: false,
    reconcile: false,
    forceDrift: false,
    adoptExisting: false,
    delayMs: 500,
    repo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--reconcile') options.reconcile = true;
    else if (arg === '--force-drift') options.forceDrift = true;
    else if (arg === '--adopt-existing') options.adoptExisting = true;
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      onHelp?.();
      return options;
    } else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0)
    throw new Error('--delay-ms inválido.');
  return options;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS — all 6 new tests green.

- [ ] **Step 5: Update `scripts/bootstrap-github-roadmap.mjs` to use the shared `parseArgs`**

Remove the inline `function parseArgs(argv) { ... }` definition (current lines 20-45) from `scripts/bootstrap-github-roadmap.mjs`. Add `parseArgs` to the existing named import from `./lib/github-roadmap.mjs` at the top of the file:

```javascript
import {
  createRoadmapIssue,
  parseArgs,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './lib/github-roadmap.mjs';
```

Update the call site (currently `const options = parseArgs(process.argv.slice(2));`) to pass the help callback so `--help` still prints help and exits exactly as before:

```javascript
const options = parseArgs(process.argv.slice(2), {
  onHelp: () => {
    printHelp();
    process.exit(0);
  },
});
```

Leave `printHelp()` where it is in the script (it stays script-local, unexported — out of scope per Global Constraints).

- [ ] **Step 6: Verify the CLI still behaves identically**

Run: `node scripts/bootstrap-github-roadmap.mjs --help`
Expected: prints the same usage text as before this change, exits 0.

Run: `node scripts/bootstrap-github-roadmap.mjs --bogus-flag; echo "exit=$?"`
Expected: throws `Argumento desconhecido: --bogus-flag`, non-zero exit.

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS — all tests still green, including the pre-existing ones.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/github-roadmap.mjs scripts/lib/github-roadmap.test.mjs scripts/bootstrap-github-roadmap.mjs
git commit -m "test(roadmap): extract and cover bootstrap CLI arg parsing"
```

---

### Task 2: Extract and test `assertNoUnexpectedDrift`

**Files:**

- Modify: `scripts/lib/github-roadmap.mjs`
- Modify: `scripts/bootstrap-github-roadmap.mjs`
- Test: `scripts/lib/github-roadmap.test.mjs`

**Interfaces:**

- Consumes: `sha256` from `scripts/lib/roadmap.mjs` (already imported by `scripts/bootstrap-github-roadmap.mjs`; the lib file needs its own import added).
- Produces: `assertNoUnexpectedDrift(liveBody, saved, force, key)` exported from `scripts/lib/github-roadmap.mjs`. `saved` is `{ number: number, lastAppliedBodySha256?: string, legacyBodySha256?: string } | undefined`. Throws `Error` when the live GitHub issue body was edited outside the reconciler and `force` is falsy. Task 3's `reconcileIssue` calls this function directly.

- [ ] **Step 1: Write the failing tests**

Add this import to `scripts/lib/github-roadmap.test.mjs`'s import block:

```javascript
import { sha256 } from './roadmap.mjs';
```

And add `assertNoUnexpectedDrift` to the existing `github-roadmap.mjs` import:

```javascript
import {
  assertNoUnexpectedDrift,
  createRoadmapIssue,
  getIssueParent,
  parseArgs,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './github-roadmap.mjs';
```

Append these test blocks:

```javascript
test('assertNoUnexpectedDrift: sem estado salvo, primeira aplicação passa', () => {
  assert.doesNotThrow(() => assertNoUnexpectedDrift('qualquer corpo', undefined, false, 'k'));
});

test('assertNoUnexpectedDrift: hash do corpo ao vivo bate com o último aplicado', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo gerenciado', saved, false, 'k'));
});

test('assertNoUnexpectedDrift: hash do corpo ao vivo bate com o legado', () => {
  const saved = {
    number: 7,
    lastAppliedBodySha256: sha256('corpo novo formato'),
    legacyBodySha256: sha256('corpo formato antigo'),
  };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo formato antigo', saved, false, 'k'));
});

test('assertNoUnexpectedDrift: edição manual inesperada lança erro', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.throws(
    () => assertNoUnexpectedDrift('corpo editado à mão', saved, false, 'minha-task'),
    /Drift manual detectado em minha-task \(#7\)/,
  );
});

test('assertNoUnexpectedDrift: --force-drift ignora a divergência', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo editado à mão', saved, true, 'k'));
});

test('assertNoUnexpectedDrift: estado salvo sem hash nenhum ainda não bloqueia', () => {
  const saved = { number: 7 };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('qualquer corpo', saved, false, 'k'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: FAIL — `assertNoUnexpectedDrift` is not exported from `./github-roadmap.mjs`.

- [ ] **Step 3: Move `assertNoUnexpectedDrift` into `scripts/lib/github-roadmap.mjs`**

Add this import at the top of `scripts/lib/github-roadmap.mjs`:

```javascript
import { sha256 } from './roadmap.mjs';
```

Add this export (function body is an exact copy of the current script-local version):

```javascript
export function assertNoUnexpectedDrift(liveBody, saved, force, key) {
  if (!saved || force) return;
  const liveHash = sha256(liveBody);
  const accepted = new Set([saved.lastAppliedBodySha256, saved.legacyBodySha256].filter(Boolean));
  if (accepted.size && !accepted.has(liveHash))
    throw new Error(
      `Drift manual detectado em ${key} (#${saved.number}). Revise a edição ou use --force-drift conscientemente.`,
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS — all 6 new tests green, plus everything from Task 1.

- [ ] **Step 5: Update `scripts/bootstrap-github-roadmap.mjs` to use the shared `assertNoUnexpectedDrift`**

Remove the inline `function assertNoUnexpectedDrift(liveBody, saved, force, key) { ... }` definition from `scripts/bootstrap-github-roadmap.mjs`. Add `assertNoUnexpectedDrift` to the existing import from `./lib/github-roadmap.mjs`:

```javascript
import {
  assertNoUnexpectedDrift,
  createRoadmapIssue,
  parseArgs,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './lib/github-roadmap.mjs';
```

The two existing call sites (the root-roadmap-issue drift check, and inside `reconcileIssue`) are unchanged — they already call `assertNoUnexpectedDrift(...)` by name, which now resolves to the imported function.

- [ ] **Step 6: Run the full script's dry-run smoke check**

Run: `node scripts/bootstrap-github-roadmap.mjs`
Expected: same dry-run summary output as before this change (no network calls are made in dry-run mode, so this runs without a `GITHUB_TOKEN`).

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/github-roadmap.mjs scripts/lib/github-roadmap.test.mjs scripts/bootstrap-github-roadmap.mjs
git commit -m "test(roadmap): extract and cover manual-edit drift guard"
```

---

### Task 3: Extract and test `reconcileIssue`

**Files:**

- Modify: `scripts/lib/github-roadmap.mjs`
- Modify: `scripts/bootstrap-github-roadmap.mjs`
- Test: `scripts/lib/github-roadmap.test.mjs`

**Interfaces:**

- Consumes: `assertNoUnexpectedDrift` (Task 2, same module — call directly, no import needed since it's in the same file). Uses the `fakeClient` test helper already defined at the top of `scripts/lib/github-roadmap.test.mjs` (the same one Task 1/2 do not need but this task's tests do).
- Produces: `reconcileIssue(client, ownerName, repoName, record, issue, milestone, saved, force)` exported from `scripts/lib/github-roadmap.mjs`. No later task depends on this.

- [ ] **Step 1: Write the failing tests**

Add `reconcileIssue` to the existing `github-roadmap.mjs` import in `scripts/lib/github-roadmap.test.mjs`:

```javascript
import {
  assertNoUnexpectedDrift,
  createRoadmapIssue,
  getIssueParent,
  parseArgs,
  reconcileIssue,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './github-roadmap.mjs';
```

Append these test blocks:

```javascript
test('reconcileIssue: corpo sem divergência é atualizado normalmente', async () => {
  const record = {
    key: 'task-a',
    title: 'Título',
    body: 'corpo gerenciado',
    labels: ['kind:task'],
  };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo gerenciado') };
  const client = fakeClient({
    responses: new Map([
      ['/repos/o/r/issues/9', { body: 'corpo gerenciado' }],
      ['PATCH /repos/o/r/issues/9', { number: 9 }],
    ]),
  });
  await reconcileIssue(client, 'o', 'r', record, { number: 9 }, { number: 3 }, saved, false);
  const patch = client.calls.find((call) => call.options?.method === 'PATCH');
  assert.deepEqual(patch, {
    endpoint: '/repos/o/r/issues/9',
    options: {
      method: 'PATCH',
      body: { title: 'Título', body: 'corpo gerenciado', labels: ['kind:task'], milestone: 3 },
    },
  });
});

test('reconcileIssue: divergência manual bloqueia o PATCH', async () => {
  const record = { key: 'task-a', title: 'Título', body: 'corpo novo', labels: [] };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo antigo gerenciado') };
  const client = fakeClient({
    responses: new Map([['/repos/o/r/issues/9', { body: 'corpo editado à mão' }]]),
  });
  await assert.rejects(
    () => reconcileIssue(client, 'o', 'r', record, { number: 9 }, null, saved, false),
    /Drift manual detectado em task-a \(#9\)/,
  );
  assert.equal(
    client.calls.some((call) => call.options?.method === 'PATCH'),
    false,
  );
});

test('reconcileIssue: --force-drift aplica o PATCH mesmo com divergência', async () => {
  const record = { key: 'task-a', title: 'Título', body: 'corpo novo', labels: [] };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo antigo gerenciado') };
  const client = fakeClient({
    responses: new Map([
      ['/repos/o/r/issues/9', { body: 'corpo editado à mão' }],
      ['PATCH /repos/o/r/issues/9', { number: 9 }],
    ]),
  });
  await reconcileIssue(client, 'o', 'r', record, { number: 9 }, null, saved, true);
  assert.equal(
    client.calls.some((call) => call.options?.method === 'PATCH'),
    true,
  );
});
```

Also add the `sha256` import if Task 2 did not already add it (it did — no change needed here beyond what's listed above).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: FAIL — `reconcileIssue` is not exported from `./github-roadmap.mjs`.

- [ ] **Step 3: Move `reconcileIssue` into `scripts/lib/github-roadmap.mjs`**

Add this export (exact copy of the current script-local version, now calling the local `assertNoUnexpectedDrift` defined earlier in the same file):

```javascript
export async function reconcileIssue(
  client,
  ownerName,
  repoName,
  record,
  issue,
  milestone,
  saved,
  force,
) {
  const live = await client.request(`/repos/${ownerName}/${repoName}/issues/${issue.number}`);
  if ((live.body ?? '') !== record.body)
    assertNoUnexpectedDrift(live.body ?? '', saved, force, record.key);
  await client.request(`/repos/${ownerName}/${repoName}/issues/${issue.number}`, {
    method: 'PATCH',
    body: {
      title: record.title,
      body: record.body,
      labels: record.labels,
      milestone: milestone?.number ?? null,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS — all 3 new tests green, plus everything from Tasks 1-2 (12 tests added so far by this plan, plus the pre-existing 5).

- [ ] **Step 5: Update `scripts/bootstrap-github-roadmap.mjs` to use the shared `reconcileIssue`**

Remove the inline `async function reconcileIssue(...) { ... }` definition from `scripts/bootstrap-github-roadmap.mjs`. Add `reconcileIssue` to the existing import from `./lib/github-roadmap.mjs`:

```javascript
import {
  assertNoUnexpectedDrift,
  createRoadmapIssue,
  parseArgs,
  reconcileIssue,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './lib/github-roadmap.mjs';
```

The existing call site (`if (options.reconcile) await reconcileIssue(client, owner, repo, record, issue, milestone, state.issues?.[record.key], options.forceDrift);`) is unchanged.

- [ ] **Step 6: Full verification**

Run: `node --test scripts/lib/github-roadmap.test.mjs`
Expected: PASS, 20 total tests (5 pre-existing + 15 added across this plan: 6 in Task 1, 6 in Task 2, 3 in Task 3).

Run: `npm run roadmap:check`
Expected: `roadmap ok: ...`, roadmap tests pass, `github-config:check` passes, `planning/ROADMAP.md está sincronizado.` — unchanged from before this plan (no spec or render logic touched).

Run: `node scripts/bootstrap-github-roadmap.mjs`
Expected: identical dry-run output to before this plan started.

Run: `npm test`
Expected: full suite passes (`test:unit` + `test:scripts`), confirming `scripts/lib/github-roadmap.test.mjs` runs under the existing `test:scripts` glob with no config changes needed.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/github-roadmap.mjs scripts/lib/github-roadmap.test.mjs scripts/bootstrap-github-roadmap.mjs
git commit -m "test(roadmap): extract and cover reconciler drift-gated PATCH"
```

---

## Evidence for issue closure

After Task 3, capture for the PR description (per `docs/DEFINITION_OF_DONE.md` and issue #108's "Evidência para encerramento"):

- `node --test scripts/lib/*.test.mjs` full output (all green, showing the new drift/CLI tests by name).
- `npm run roadmap:check` output (spec validation + deterministic-render CI gate, unchanged and still green).
- A one-line note in the PR body that acceptance criteria 1-2-4 (spec validation, deterministic ROADMAP.md + CI drift check, managed-scope-only hierarchy/blocker reconciliation) were already implemented and tested on `main` prior to this issue being picked up, verified by reading `scripts/lib/roadmap.mjs`, `scripts/lib/github-roadmap.mjs`, `scripts/lib/roadmap.test.mjs`, `scripts/lib/github-roadmap.test.mjs`, and `.github/workflows/ci.yml`'s `roadmap` and `test` jobs — this plan closes the one remaining gap: unit coverage for the reconciler's CLI parsing and manual-edit drift guard (criterion 3).
