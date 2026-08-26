import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const envPath = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const bindings = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
const missing = bindings.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`worker:deploy: missing ${missing.join(' and ')}.`);
  console.error('Set both bindings in the environment or in the workspace .env first.');
  process.exit(1);
}

const args = ['deploy', '--config', 'wrangler.jsonc'];
for (const name of bindings) args.push('--var', `${name}:${process.env[name]}`);
args.push(...process.argv.slice(2));

const child = spawn('wrangler', args, {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
});
child.once('error', (error) => {
  console.error(`worker:deploy: ${error.message}`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
