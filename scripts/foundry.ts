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
// One shared interface for every gate: a fresh createInterface per prompt would
// let the first one swallow all buffered stdin and starve later prompts. Lines
// are buffered from the start so piped answers (`printf 'a\na\n' | ...`) reach
// gates that open after stdin already ended.
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const bufferedAnswers: string[] = [];
const answerWaiters: Array<(line: string | null) => void> = [];
let stdinClosed = false;
terminal.on('line', (line) => {
  const waiter = answerWaiters.shift();
  if (waiter) waiter(line);
  else bufferedAnswers.push(line);
});
terminal.on('close', () => {
  stdinClosed = true;
  while (answerWaiters.length > 0) answerWaiters.shift()!(null);
});

/** Resolves null when stdin is closed and no piped answer remains. */
async function ask(prompt: string): Promise<string | null> {
  const buffered = bufferedAnswers.shift();
  if (buffered !== undefined) {
    process.stdout.write(`${prompt}${buffered}\n`);
    return buffered;
  }
  if (stdinClosed) return null;
  process.stdout.write(prompt);
  return new Promise((resolve) => answerWaiters.push(resolve));
}

const cleanups: Array<() => Promise<void> | void> = [() => terminal.close()];
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
    throw new Error(
      `${init?.method ?? 'GET'} ${path} -> ${response.status}: ${await response.text()}`,
    );
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
  if (args.apiUrl !== 'http://localhost:4000') {
    throw new Error(
      `A API em ${args.apiUrl} não respondeu e o boot automático só cobre o stack local padrão. Suba essa API e reexecute.`,
    );
  }
  console.log('· API não está de pé — subindo o stack (API + worker inline)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  devStack = spawn(npm, ['run', 'dev', '--workspace', '@agent-foundry/api'], {
    env: { ...process.env, RUN_WORKER_INLINE: 'true' },
    stdio: 'ignore',
  });
  devStack.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(
        `O stack terminou com código ${code}. Rode 'npm run dev:inline' para ver o log.`,
      );
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
  throw new Error(
    'O stack não ficou pronto em 180s — /ready também exige o banco de pé (Supabase/Postgres do seu .env). ' +
      'Rode `npm run doctor`, suba o banco, ou rode `npm run dev:inline` para ver o log.',
  );
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
          const { events, rest, lastId } = parseSseChunk(buffered);
          buffered = rest;
          if (lastId) cursor = lastId;
          for (const event of events) console.log(formatEvent(event));
        }
      } catch {
        if (controller.signal.aborted) return;
        await sleep(2_000);
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
  console.log(
    `\n⏸  Aprovação pendente em '${approval.nodeId}' (artefato: ${approval.artifact.name})`,
  );
  if (summary) console.log(`   Resumo: ${summary}`);
  for (;;) {
    const raw = await ask('   [a]provar / [m]udanças / [r]ejeitar / [c]ancelar run? ');
    if (raw === null) {
      // Without stdin this session can never decide the gate, and a
      // self-booted stack has no UI to fall back to — waiting would hang the
      // one-command journey forever. Fail loudly instead.
      console.error(
        '✖ Aprovação pendente sem stdin interativo. Rode o comando num terminal ou decida pela UI (npm run dev:inline) e reexecute.',
      );
      await shutdown(1);
      return;
    }
    const answer = raw.trim();
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
      const note = ((await ask('   O que mudar? ')) ?? '').trim();
      if (!note) continue;
      await api(`/runs/${runId}/approvals/${approval.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action: 'request-changes', decidedBy, note }),
      });
      console.log('   ↩ Mudanças pedidas; o run continua.');
      return;
    }
    if (answer === 'r') {
      await api(`/runs/${runId}/approvals/${approval.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', decidedBy }),
      });
      console.log('   ✖ Rejeitado; o run termina como rejected.');
      return;
    }
    if (answer === 'c') {
      await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
      console.log('   ✖ Cancelamento pedido.');
      return;
    }
  }
}

function openInBrowser(url: string): void {
  // `start` is a cmd builtin, not an executable; the empty string is its
  // window-title slot so the URL is not mistaken for a title.
  const [command, prefix] =
    process.platform === 'darwin'
      ? ['open', []]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '']]
        : ['xdg-open', []];
  spawn(command, [...prefix, url], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  await ensureStack();

  const name = args.name ?? defaultProjectName(args.prompt);
  const prd = normalizePrd(args.prompt);
  if (prd !== args.prompt.trim()) {
    console.log(
      '· Prompt curto: complementado até o mínimo de PRD (detalhes ficam com o builder).',
    );
  }
  const { project } = await api<{ project: { id: string; currentRunId?: string } }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, prd }),
  });
  const runId = project.currentRunId;
  if (!runId) throw new Error(`Projeto ${project.id} foi criado sem run.`);
  console.log(`· Projeto '${name}' criado (${project.id}); run ${runId}.\n`);

  cleanups.push(streamEvents(project.id));

  const decided = new Set<string>();
  let lastStatus = '';
  for (;;) {
    const { run } = await api<{ run: { status: string } }>(`/runs/${runId}`);
    const kind = statusKind(run.status);
    // Statuses without their own event line (paused, cancel_requested, …)
    // would otherwise poll invisibly forever.
    if (run.status !== lastStatus && kind === 'active' && lastStatus !== '') {
      console.log(`· Run está '${run.status}'.`);
    }
    lastStatus = run.status;
    if (kind === 'awaiting-approval') {
      const { approvals } = await api<{
        approvals: Array<{
          request: { id: string; nodeId: string; artifact: { name: string } };
          decision: unknown;
        }>;
      }>(`/runs/${runId}/approvals`);
      for (const approval of pendingApprovals(approvals)) {
        if (decided.has(approval.id)) continue;
        decided.add(approval.id);
        await promptForDecision(project.id, runId, approval);
      }
    }
    if (kind === 'succeeded') break;
    if (kind === 'cancelled') {
      console.log('\n· Run cancelado.');
      await shutdown(0);
    }
    if (kind === 'failed') {
      console.error(
        `\n✖ Run terminou com status '${run.status}'. Veja o inspector na UI ou /runs/${runId}.`,
      );
      await shutdown(1);
    }
    await sleep(2_000);
  }

  console.log('\n✔ Build concluído. Subindo o preview...');
  const { url, session } = await api<{
    url: string;
    session: { id: string; error?: { message?: string } };
  }>(`/projects/${project.id}/preview`, { method: 'POST', body: '{}' });
  if (!url) {
    console.error(`✖ Preview falhou: ${session.error?.message ?? 'sem detalhe'}`);
    console.error(`  Logs: ${args.apiUrl}/projects/${project.id}/preview/${session.id}/logs`);
    await shutdown(1);
  }
  console.log(`· Preview: ${url}`);
  if (args.open) openInBrowser(url);

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
