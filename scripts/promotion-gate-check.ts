import { shouldRunRegressionGate } from '../packages/composition/src/regression-gate.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const changedFiles = (await readStdin())
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

console.log(shouldRunRegressionGate(changedFiles) ? 'true' : 'false');
