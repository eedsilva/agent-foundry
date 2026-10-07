#!/usr/bin/env node
import { join, resolve } from 'node:path';
import {
  assertNoRealEnvFilesTracked,
  scanDirectoryFiles,
  scanTrackedFiles,
} from './lib/secret-scan.mjs';

const root = resolve(import.meta.dirname, '..');

await assertNoRealEnvFilesTracked(root);
const [trackedFindings, bundleFindings] = await Promise.all([
  scanTrackedFiles(root),
  scanDirectoryFiles(join(root, 'apps/web/.next')),
]);
// .next/cache is Turbopack's local build cache (binary .sst blobs since Next
// 16.3): never shipped, and random bytes trip the pattern matchers.
const findings = [
  ...trackedFindings,
  ...bundleFindings.filter((finding) => !finding.file.includes('/.next/cache/')),
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
