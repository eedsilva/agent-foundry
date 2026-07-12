#!/usr/bin/env node
import { resolve } from 'node:path';
import { readJson } from './lib/roadmap.mjs';
import { validateGitHubConfiguration } from './lib/github-config.mjs';

const root = resolve(import.meta.dirname, '..');
const roadmap = await readJson(resolve(root, 'planning/roadmap-spec.json'));
const governance = await readJson(resolve(root, 'planning/governance-spec.json'));
const result = await validateGitHubConfiguration(root, roadmap, governance);
for (const warning of result.warnings) console.warn(`warning: ${warning}`);
if (!result.ok) {
  console.error(result.errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `github config ok: ${result.files.templates.length} issue forms, ${result.files.workflows.length} workflows, ${result.checkNames.length} check contexts`,
  );
