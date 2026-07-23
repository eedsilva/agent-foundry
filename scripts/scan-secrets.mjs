#!/usr/bin/env node
import { join, resolve } from 'node:path';
import {
  assertNoRealEnvFilesTracked,
  scanDirectoryFiles,
  scanTrackedFiles,
} from './lib/secret-scan.mjs';

const root = resolve(import.meta.dirname, '..');

await assertNoRealEnvFilesTracked(root);
const findings = [
  ...(await scanTrackedFiles(root)),
  ...(await scanDirectoryFiles(join(root, 'apps/web/.next'))),
];
if (findings.length > 0) {
  console.error('Possible secret(s) found:');
  for (const finding of findings) {
    console.error(`  ${finding.file} (${finding.kind} match at offset ${finding.index})`);
  }
  process.exit(1);
}
console.log(
  'secrets:check — no .env tracked, no known secret shapes found in source or client bundle.',
);
