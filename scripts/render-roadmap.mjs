#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson, renderRoadmapMarkdown, validateRoadmap } from './lib/roadmap.mjs';

const check = process.argv.includes('--check');
const root = resolve(import.meta.dirname, '..');
const spec = await readJson(resolve(root, 'planning/roadmap-spec.json'));
const project = await readJson(resolve(root, 'planning/project-spec.json'));
const validation = validateRoadmap(spec, project);
if (!validation.ok) throw new Error(validation.errors.join('\n'));
const outputPath = resolve(root, 'planning/ROADMAP.md');
const expected = renderRoadmapMarkdown(spec);
if (check) {
  const actual = await readFile(outputPath, 'utf8').catch(() => '');
  if (actual !== expected) {
    console.error('planning/ROADMAP.md está fora de sincronia. Execute npm run roadmap:render.');
    process.exitCode = 1;
  } else console.log('planning/ROADMAP.md está sincronizado.');
} else {
  await writeFile(outputPath, expected);
  console.log('planning/ROADMAP.md gerado.');
}
