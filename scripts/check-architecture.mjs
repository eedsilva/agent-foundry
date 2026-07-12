#!/usr/bin/env node
import { resolve } from 'node:path';
import { inspectArchitecture } from './lib/architecture.mjs';

const root = resolve(import.meta.dirname, '..');
const result = await inspectArchitecture(root);
if (!result.ok) {
  console.error(result.errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `architecture ok: ${result.packages.length} workspaces, no forbidden edges or cycles`,
  );
