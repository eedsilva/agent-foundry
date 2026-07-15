import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BaselinePublishOptions {
  rename?: typeof rename;
  rm?: typeof rm;
  restoreFailureMessage: string;
  cleanupFailureMessage: string;
}

/**
 * Atomically publish a JSON + Markdown baseline pair: write both to temp files,
 * back up any existing pair, rename into place, and roll back to the backups if
 * a rename fails. Shared verbatim by the provider-canary and dogfood freezers so
 * both get identical crash-safe semantics.
 */
export async function publishBaselinePair(
  jsonPath: string,
  markdownPath: string,
  json: string,
  markdown: string,
  options: BaselinePublishOptions,
): Promise<void> {
  const suffix = `.${process.pid}-${Date.now()}.tmp`;
  const tmpJson = `${jsonPath}${suffix}`;
  const tmpMarkdown = `${markdownPath}${suffix}`;
  const backupJson = `${jsonPath}${suffix}.backup`;
  const backupMarkdown = `${markdownPath}${suffix}.backup`;
  const renameFile = options.rename ?? rename;
  const removeFile = options.rm ?? rm;
  let jsonBackedUp = false;
  let markdownBackedUp = false;
  let jsonPublished = false;
  let markdownPublished = false;

  await mkdir(dirname(jsonPath), { recursive: true });
  try {
    await Promise.all([
      writeFile(tmpJson, json, { flag: 'wx' }),
      writeFile(tmpMarkdown, markdown, { flag: 'wx' }),
    ]);
    jsonBackedUp = await renameIfPresent(jsonPath, backupJson, renameFile);
    markdownBackedUp = await renameIfPresent(markdownPath, backupMarkdown, renameFile);
    await renameFile(tmpJson, jsonPath);
    jsonPublished = true;
    await renameFile(tmpMarkdown, markdownPath);
    markdownPublished = true;
  } catch (error) {
    try {
      if (jsonPublished) await removeFile(jsonPath, { force: true, recursive: true });
      if (markdownPublished) await removeFile(markdownPath, { force: true, recursive: true });
      if (jsonBackedUp) await renameFile(backupJson, jsonPath);
      if (markdownBackedUp) await renameFile(backupMarkdown, markdownPath);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], options.restoreFailureMessage);
    }
    throw error;
  } finally {
    await Promise.all([
      removeFile(tmpJson, { force: true }),
      removeFile(tmpMarkdown, { force: true }),
    ]);
  }
  const cleanup = await Promise.allSettled([
    removeFile(backupJson, { force: true, recursive: true }),
    removeFile(backupMarkdown, { force: true, recursive: true }),
  ]);
  const cleanupFailures = cleanup.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures.map((result) => result.reason),
      options.cleanupFailureMessage,
    );
  }
}

async function renameIfPresent(
  source: string,
  destination: string,
  renameFile: typeof rename,
): Promise<boolean> {
  try {
    await renameFile(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Escape a value for a single Markdown table cell. */
export function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}
