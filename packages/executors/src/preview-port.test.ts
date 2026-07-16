import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { detectPortFromOutput, reservePreviewPort } from './preview-port.js';

describe('reservePreviewPort', () => {
  it('returns a free, listenable port', async () => {
    const port = await reservePreviewPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns distinct ports for concurrent reservations', async () => {
    const [a, b, c] = await Promise.all([
      reservePreviewPort(),
      reservePreviewPort(),
      reservePreviewPort(),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('detectPortFromOutput', () => {
  it('extracts the port from a Vite-style banner', () => {
    const chunk = '  VITE v5.4.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n';
    expect(detectPortFromOutput(chunk)).toBe(5173);
  });

  it('extracts the port from a Next.js-style banner', () => {
    expect(detectPortFromOutput('- Local:        http://127.0.0.1:3001')).toBe(3001);
  });

  it('returns undefined when no URL is present', () => {
    expect(detectPortFromOutput('Compiling...\n')).toBeUndefined();
  });
});
