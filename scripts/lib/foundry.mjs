// Pure core of `npm run foundry` (issue #443): everything here is I/O-free so
// scripts/lib/foundry.test.mjs can cover it with node:test. The CLI wrapper in
// scripts/foundry.ts owns HTTP, SSE, readline and process spawning.
import { parseArgs } from 'node:util';

// Mirrors the PRD minimum in packages/contracts/src/api.ts
// (CreateProjectRequestSchema `prd.min(50)`); not importable from plain .mjs.
const PRD_MIN_CHARS = 50;

export function parseFoundryArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      api: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    prompt: positionals.join(' ').trim(),
    name: typeof values.name === 'string' ? values.name : undefined,
    apiUrl: typeof values.api === 'string' ? values.api : 'http://localhost:4000',
    open: values['no-open'] !== true,
    help: values.help === true,
  };
}

export function normalizePrd(prompt) {
  const trimmed = prompt.trim();
  if (trimmed.length >= PRD_MIN_CHARS) return trimmed;
  return (
    `${trimmed}\n\n` +
    'Decida os detalhes de produto que faltam de forma simples e óbvia; ' +
    'prefira o menor app que entrega esse pedido.'
  );
}

export function defaultProjectName(prompt) {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'Foundry app';
  return words.slice(0, 6).join(' ').slice(0, 120);
}

export function formatEvent(event) {
  const time = new Date(event.createdAt).toLocaleTimeString('en-GB', { hour12: false });
  return `${time}  ${event.type.padEnd(24)} ${event.message}`.trimEnd();
}

/**
 * Incremental SSE parser: feed it the buffered text, get back the parsed
 * `data:` payloads of complete frames, the last `id:` of a complete frame (the
 * resume cursor — an incomplete tail frame must never advance it), and the
 * unconsumed remainder to prepend to the next chunk. Comment frames
 * (`: connected`, `: ping`) are dropped.
 */
export function parseSseChunk(buffered) {
  const frames = buffered.split('\n\n');
  const rest = frames.pop() ?? '';
  const events = [];
  let lastId;
  for (const frame of frames) {
    const lines = frame.split('\n');
    const id = lines.find((line) => line.startsWith('id: '))?.slice('id: '.length);
    if (id) lastId = id;
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A malformed frame is dropped rather than wedging the stream.
    }
  }
  return { events, rest, lastId };
}

export function pendingApprovals(approvals) {
  return approvals.filter((entry) => !entry.decision).map((entry) => entry.request);
}

// Mirrors WorkflowRunStatusSchema in packages/contracts/src/run.ts (the source
// of truth for terminality); not importable from plain .mjs — keep in sync.
export function statusKind(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'rejected') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'awaiting_approval') return 'awaiting-approval';
  return 'active';
}
