#!/usr/bin/env node
import { resolve } from 'node:path';
import { readJson, validateRoadmap, issueRecords } from './lib/roadmap.mjs';

const root = resolve(import.meta.dirname, '..');
const spec = await readJson(resolve(root, 'planning/roadmap-spec.json'));
const project = await readJson(resolve(root, 'planning/project-spec.json'));
const result = validateRoadmap(spec, project);
if (!result.ok) {
  console.error(result.errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  const records = issueRecords(spec, project);
  console.log(
    `roadmap ok: ${spec.milestones.length} milestones, ${records.filter((r) => r.kind === 'task').length} tasks, ${records.length} managed issues`,
  );
}
