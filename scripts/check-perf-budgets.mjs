#!/usr/bin/env node
// Reads apps/web's production-build route-bundle stats and perf-budgets.json,
// prints every budgeted route's measured-vs-budget First Load JS, and exits
// non-zero on any breach. See docs/PERFORMANCE_BUDGETS.md.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateFirstLoadJsBudgets } from './lib/perf-budgets.mjs';

const root = resolve(import.meta.dirname, '..');
const budgetsPath = resolve(root, 'perf-budgets.json');
const manifestPath = resolve(root, 'apps/web/.next/diagnostics/route-bundle-stats.json');

let budgets;
try {
  budgets = JSON.parse(await readFile(budgetsPath, 'utf8'));
} catch (error) {
  console.error(`perf:check: could not read ${budgetsPath}: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(
    `perf:check: build output missing at ${manifestPath} (${error.code ?? error.message}).\n` +
      'Run `npm run build --workspace @agent-foundry/web` (after building contracts/domain) before checking budgets.',
  );
  process.exitCode = 1;
  process.exit();
}

const { ok, results } = evaluateFirstLoadJsBudgets(manifest, budgets.firstLoadJsKb ?? {});

for (const result of results) {
  if (result.measuredKb === null) {
    console.error(`✗ ${result.route}: ${result.note} (budget ${result.budgetKb}KB)`);
    continue;
  }
  const headroomKb = Math.round((result.budgetKb - result.measuredKb) * 10) / 10;
  const mark = result.breach ? '✗' : '✓';
  console.log(
    `${mark} ${result.route}: ${result.measuredKb}KB / ${result.budgetKb}KB budget (headroom ${headroomKb}KB)`,
  );
}

if (!ok) {
  console.error('perf:check: First Load JS budget breached. See docs/PERFORMANCE_BUDGETS.md.');
  process.exitCode = 1;
} else {
  console.log('perf:check: all First Load JS budgets within limit.');
}
