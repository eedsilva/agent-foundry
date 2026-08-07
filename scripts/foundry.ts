// One-command journey (issue #443): `npm run foundry -- "quero um app de receitas"`
// boots the stack if needed, creates the project, streams task progress to the
// terminal, turns approval gates into interactive prompts, and opens the
// preview in the browser when the run completes.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  defaultProjectName,
  formatEvent,
  normalizePrd,
  parseFoundryArgs,
  parseSseChunk,
  pendingApprovals,
  statusKind,
} from './lib/foundry.mjs';

const HELP = `Uso: npm run foundry -- "o que você quer construir" [opções]

Opções:
  --name <nome>   Nome do projeto (default: derivado do prompt)
  --api <url>     URL da API (default: http://localhost:4000)
  --no-open       Não abrir o preview no browser ao terminar
  -h, --help      Esta ajuda`;

const args = parseFoundryArgs(process.argv.slice(2));
if (args.help || !args.prompt) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

let devStack: ChildProcess | undefined;
const cleanups: Array<() => Promise<void> | void> = [];
process.on('SIGINT', () => void shutdown(130));

async function shutdown(code: number): Promise<never> {
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
  if (devStack && devStack.exitCode === null) {
    devStack.kill('SIGTERM');
    await Promise.race([once(devStack, 'exit'), sleep(5_000)]);
  }
  process.exit(code);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${args.apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(`${args.apiUrl}/ready`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureStack(): Promise<void> {
  if (await isReady()) return;
  console.log('· API não está de pé — subindo o stack (API + worker inline)...');
  devStack = spawn('npm', ['run', 'dev', '--workspace', '@agent-foundry/api'], {
    env: { ...process.env, RUN_WORKER_INLINE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devStack.stdout?.on('data', () => undefined);
  devStack.stderr?.on('data', () => undefined);
  devStack.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`O stack terminou com código ${code}. Rode 'npm run dev:inline' para ver o log.`);
      process.exit(1);
    }
  });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(2_000);
    if (await isReady()) {
      console.log('· Stack pronto.');
      return;
    }
  }
  throw new Error('O stack não ficou pronto em 180s. Rode `npm run dev:inline` e olhe o log.');
}

function streamEvents(projectId: string): () => void {
  const controller = new AbortController();
  void (async () => {
    let cursor: string | undefined;
    while (!controller.signal.aborted) {
      try {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const response = await fetch(`${args.apiUrl}/projects/${projectId}/events/stream${query}`, {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!response.ok || !response.body) throw new Error(`stream -> ${response.status}`);
        let buffered = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffered += chunk;
          const idMatches = buffered.match(/^id: (.+)$/gm);
          const lastId = idMatches?.at(-1)?.slice('id: '.length);
          if (lastId) cursor = lastId;
          const { events, rest } = parseSseChunk(buffered);
          buffered = rest;
          for (const event of events) console.log(formatEvent(event));
        }
      } catch {
        if (controller.signal.aborted) return;
        await sleep(2_000).catch(() => undefined);
      }
    }
  })();
  return () => controller.abort();
}

async function promptForDecision(
  projectId: string,
  runId: string,
  approval: { id: string; nodeId: string; artifact: { name: string } },
): Promise<void> {
  const summary = await api<{ artifact?: { content?: { summary?: string } } }>(
    `/projects/${projectId}/artifacts/${approval.artifact.name}`,
  ).then(
    (detail) => detail.artifact?.content?.summary,
    () => undefined,
  );
  console.log(`\n⏸  Aprovação pendente em '${approval.nodeId}' (artefato: ${approval.artifact.name})`);
  if (summary) console.log(`   Resumo: ${summary}`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await readline.question('   [a]provar / [m]udanças / [c]ancelar run? ')).trim();
      const decidedBy = process.env.USER || 'operator';
      if (answer === 'a' || answer === '') {
        await api(`/runs/${runId}/approvals/${approval.id}/decide`, {
          method: 'POST',
          body: JSON.stringify({ action: 'approve', decidedBy }),
        });
        console.log('   ✔ Aprovado.');
        return;
      }
      if (answer === 'm') {
        const note = (await readline.question('   O que mudar? ')).trim();
        if (!note) continue;
        await api(`/runs/${runId}/approvals/${approval.id}/decide`, {
          method: 'POST',
          body: JSON.stringify({ action: 'request-changes', decidedBy, note }),
        });
        console.log('   ↩ Mudanças pedidas; o run continua.');
        return;
      }
      if (answer === 'c') {
        await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
        console.log('   ✖ Cancelamento pedido.');
        return;
      }
    }
  } finally {
    readline.close();
  }
}

async function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  await ensureStack();

  const name = args.name ?? defaultProjectName(args.prompt);
  const { project } = await api<{ project: { id: string; currentRunId?: string } }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, prd: normalizePrd(args.prompt) }),
  });
  const runId = project.currentRunId;
  if (!runId) throw new Error(`Projeto ${project.id} foi criado sem run.`);
  console.log(`· Projeto '${name}' criado (${project.id}); run ${runId}.\n`);

  cleanups.push(streamEvents(project.id));

  const decided = new Set<string>();
  for (;;) {
    const { run } = await api<{ run: { status: string } }>(`/runs/${runId}`);
    const kind = statusKind(run.status);
    if (kind === 'awaiting-approval') {
      const { approvals } = await api<{
        approvals: Array<{ request: { id: string; nodeId: string; artifact: { name: string } }; decision: unknown }>;
      }>(`/runs/${runId}/approvals`);
      for (const approval of pendingApprovals(approvals)) {
        if (decided.has(approval.id)) continue;
        decided.add(approval.id);
        await promptForDecision(project.id, runId, approval);
      }
    }
    if (kind === 'succeeded') break;
    if (kind === 'failed') {
      console.error(`\n✖ Run terminou com status '${run.status}'. Veja o inspector na UI ou /runs/${runId}.`);
      await shutdown(1);
    }
    await sleep(2_000);
  }

  console.log('\n✔ Build concluído. Subindo o preview...');
  const { url } = await api<{ url: string }>(`/projects/${project.id}/preview`, {
    method: 'POST',
    body: '{}',
  });
  console.log(`· Preview: ${url}`);
  if (args.open) await openInBrowser(url);

  if (devStack) {
    console.log('· Stack foi iniciado por este comando; Ctrl+C encerra tudo.');
    await new Promise(() => undefined); // keep serving until Ctrl+C
  } else {
    await shutdown(0);
  }
}

main().catch(async (error) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
});
