import { createServer } from 'node:net';

/**
 * Binds an ephemeral port, reads what the OS assigned, then releases it so the
 * dev-server child process can bind it itself.
 * ponytail: the release→spawn gap is a real TOCTOU race; a rare bind conflict
 * is handled by NodePreviewRunner's single respawn-on-conflict retry rather
 * than fd-passing/SO_REUSEPORT, which is overkill for a personal single-host tool.
 */
export async function reservePreviewPort(host = '127.0.0.1'): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine reserved preview port.'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const URL_PORT_PATTERN = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/;

/** Scans a dev-server stdout/stderr chunk for the port it actually bound to. */
export function detectPortFromOutput(chunk: string): number | undefined {
  const match = URL_PORT_PATTERN.exec(chunk);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port > 0 && port < 65_536 ? port : undefined;
}
