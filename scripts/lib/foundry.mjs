// Pure core of `npm run foundry` (issue #443): everything here is I/O-free so
// scripts/lib/foundry.test.mjs can cover it with node:test. The CLI wrapper in
// scripts/foundry.ts owns HTTP, SSE, readline and process spawning.

const PRD_MIN_CHARS = 50;

export function parseFoundryArgs(argv) {
  const words = [];
  let name;
  let apiUrl = 'http://localhost:4000';
  let open = true;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--no-open') open = false;
    else if (arg === '--name') name = argv[(index += 1)];
    else if (arg === '--api') apiUrl = argv[(index += 1)] ?? apiUrl;
    else words.push(arg);
  }
  return { prompt: words.join(' ').trim(), name, apiUrl, open, help };
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
 * `data:` payloads of complete frames and the unconsumed remainder to prepend
 * to the next chunk. Comment frames (`: connected`, `: ping`) are dropped.
 */
export function parseSseChunk(buffered) {
  const frames = buffered.split('\n\n');
  const rest = frames.pop() ?? '';
  const events = [];
  for (const frame of frames) {
    const data = frame
      .split('\n')
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
  return { events, rest };
}

export function pendingApprovals(approvals) {
  return approvals.filter((entry) => !entry.decision).map((entry) => entry.request);
}

export function statusKind(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return 'failed';
  if (status === 'awaiting_approval') return 'awaiting-approval';
  return 'active';
}
