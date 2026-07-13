import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { issueRecords, renderRoadmapMarkdown, validateRoadmap } from './roadmap.mjs';

const root = resolve(import.meta.dirname, '../..');
const spec = JSON.parse(await readFile(resolve(root, 'planning/roadmap-spec.json'), 'utf8'));
const project = JSON.parse(await readFile(resolve(root, 'planning/project-spec.json'), 'utf8'));

test('roadmap vigente é válido e reproduzível', () => {
  const result = validateRoadmap(spec, project);
  assert.deepEqual(result.errors, []);
  assert.equal(issueRecords(spec, project).length, 125);
  assert.equal(renderRoadmapMarkdown(spec), renderRoadmapMarkdown(structuredClone(spec)));
});

test('detecta ciclos e dependências inexistentes', () => {
  const clone = structuredClone(spec);
  clone.milestones[0].dependsOn = ['missing'];
  clone.milestones[1].dependsOn = [clone.milestones[0].key];
  clone.milestones[0].dependsOn.push(clone.milestones[1].key);
  const result = validateRoadmap(clone, project);
  assert.ok(result.errors.some((error) => error.includes('inexistente')));
  assert.ok(result.errors.some((error) => error.includes('Ciclo de milestone')));
});

test('Personal v1 não depende de Hosted v2 e P0 não vive no futuro', () => {
  const clone = structuredClone(spec);
  const personal = clone.milestones.find((m) => m.key === 'v1.0');
  personal.dependsOn.push('v0.8');
  const candidate = clone.milestones.find((m) => m.commitment === 'Candidate');
  candidate.tasks[0].labels = candidate.tasks[0].labels
    .filter((l) => !l.startsWith('priority:'))
    .concat('priority:p0');
  const result = validateRoadmap(clone, project);
  assert.ok(result.errors.some((error) => error.includes('Hosted v2')));
  assert.ok(result.errors.some((error) => error.includes('não pode ser P0')));
});
