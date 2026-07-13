import { resolve } from 'node:path';
import {
  CanaryOptInError,
  freezeProviderCanaryReport,
  runProviderCanaries,
} from '../packages/composition/src/provider-canary.js';

const freezeIndex = process.argv.indexOf('--freeze');
const freezeTarget = freezeIndex >= 0 ? process.argv[freezeIndex + 1] : undefined;

if (freezeIndex >= 0 && !freezeTarget) {
  console.error('--freeze requires a report destination path.');
  process.exitCode = 1;
} else {
  try {
    const outcome = await runProviderCanaries();
    console.log(JSON.stringify(outcome.report, null, 2));
    if (freezeTarget) await freezeProviderCanaryReport(outcome.report, resolve(freezeTarget));
    process.exitCode = outcome.exitCode;
  } catch (error) {
    if (error instanceof CanaryOptInError) console.error(error.message);
    else console.error('Provider canary runner failed before producing a valid report.');
    process.exitCode = 1;
  }
}
