import {
  CanaryOptInError,
  freezeProviderCanaryReport,
  runProviderCanaries,
} from '../packages/composition/src/provider-canary.js';

const freezeRequested = process.argv.includes('--freeze');

try {
  const outcome = await runProviderCanaries();
  console.log(JSON.stringify(outcome.report, null, 2));
  if (freezeRequested) await freezeProviderCanaryReport(outcome.report, process.cwd());
  process.exitCode = outcome.exitCode;
} catch (error) {
  if (error instanceof CanaryOptInError) console.error(error.message);
  else console.error('Provider canary runner failed before producing a valid report.');
  process.exitCode = 1;
}
