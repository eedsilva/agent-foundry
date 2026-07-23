import { resolve } from 'node:path';
import { buildCalibrationReport } from '@agent-foundry/model-router';
import { FileMetricsRepository } from '@agent-foundry/persistence';
import { argValue as sharedArgValue } from './lib/cli-shared.js';

// Anchor to the repo root (this script lives at <root>/scripts/calibration-report.ts)
// so it resolves the same DATA_DIR the running system reads/writes by default,
// matching the convention in packages/composition/src/config.ts.
const rootDir = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dataDir = resolve(
  rootDir,
  sharedArgValue(args, '--data-dir') ?? process.env.DATA_DIR ?? '.data',
);

const metrics = new FileMetricsRepository(dataDir);
const report = buildCalibrationReport(await metrics.list());
console.log(JSON.stringify(report, null, 2));
