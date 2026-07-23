import { resolve } from 'node:path';
import { buildCalibrationReport } from '@agent-foundry/model-router';
import { FileMetricsRepository } from '@agent-foundry/persistence';

// Anchor to the repo root (this script lives at <root>/scripts/calibration-report.ts)
// so it resolves the same DATA_DIR the running system reads/writes by default,
// matching the convention in packages/composition/src/config.ts.
const rootDir = resolve(import.meta.dirname, '..');
const dataDir = resolve(rootDir, process.env.DATA_DIR ?? '.data');

const metrics = new FileMetricsRepository(dataDir);
const report = buildCalibrationReport(await metrics.list());
console.log(JSON.stringify(report, null, 2));
