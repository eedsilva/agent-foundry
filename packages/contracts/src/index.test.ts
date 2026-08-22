import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function browserEntryNodeBuiltins(
  path: string,
  seen = new Set<string>(),
  offenders: string[] = [],
): string[] {
  if (seen.has(path)) return offenders;
  seen.add(path);
  const source = readFileSync(path, 'utf8');

  for (const match of source.matchAll(/(?:from|import)\s*['"](node:[^'"]+)/g)) {
    offenders.push(`${relative(sourceDirectory, path)} -> ${match[1]}`);
  }
  for (const match of source.matchAll(/(?:from|export\s+\*\s+from)\s*['"](\.[^'"]+)['"]/g)) {
    browserEntryNodeBuiltins(
      resolve(dirname(path), match[1]!.replace(/\.js$/, '.ts')),
      seen,
      offenders,
    );
  }
  return offenders;
}

describe('contracts browser entry point', () => {
  it('does not reach Node built-ins', () => {
    expect(browserEntryNodeBuiltins(resolve(sourceDirectory, 'index.ts'))).toEqual([]);
  });
});
