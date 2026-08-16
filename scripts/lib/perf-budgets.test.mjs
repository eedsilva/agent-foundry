import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFirstLoadJsBudgets } from './perf-budgets.mjs';

const budgets = { '/': 630, '/project/[id]': 1140, '/router': 1050 };

test('rota dentro do orçamento não é breach e reporta headroom correto', () => {
  const manifest = [{ route: '/router', firstLoadUncompressedJsBytes: 892 * 1024 }]; // 892KB
  const { ok, results } = evaluateFirstLoadJsBudgets(manifest, { '/router': 1050 });
  assert.equal(ok, true);
  assert.deepEqual(results, [
    { route: '/router', budgetKb: 1050, measuredKb: 892, breach: false, note: null },
  ]);
});

test('rota acima do orçamento é breach', () => {
  const manifest = [{ route: '/router', firstLoadUncompressedJsBytes: 1200 * 1024 }];
  const { ok, results } = evaluateFirstLoadJsBudgets(manifest, { '/router': 1050 });
  assert.equal(ok, false);
  assert.equal(results[0].breach, true);
  assert.equal(results[0].measuredKb, 1200);
});

test('um único byte acima do orçamento é breach', () => {
  const manifest = [{ route: '/router', firstLoadUncompressedJsBytes: 1050 * 1024 + 1 }];
  const { ok, results } = evaluateFirstLoadJsBudgets(manifest, { '/router': 1050 });
  assert.equal(ok, false);
  assert.equal(results[0].breach, true);
});

test('rota orçada ausente do manifest é breach, não passa silenciosamente', () => {
  const manifest = [{ route: '/', firstLoadUncompressedJsBytes: 500 * 1024 }];
  const { ok, results } = evaluateFirstLoadJsBudgets(manifest, budgets);
  assert.equal(ok, false);
  const missing = results.find((r) => r.route === '/project/[id]');
  assert.equal(missing.breach, true);
  assert.equal(missing.measuredKb, null);
});

test('manifest vazio é breach para todas as rotas orçadas', () => {
  const { ok, results } = evaluateFirstLoadJsBudgets([], budgets);
  assert.equal(ok, false);
  assert.equal(results.length, Object.keys(budgets).length);
  assert.ok(results.every((r) => r.breach === true && r.measuredKb === null));
});

test('manifest ausente (null/undefined) é tratado como vazio, não lança', () => {
  const { ok, results } = evaluateFirstLoadJsBudgets(undefined, { '/': 630 });
  assert.equal(ok, false);
  assert.equal(results[0].breach, true);
});
