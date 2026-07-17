// packages/executors/src/fixtures/preview-dev-server.mjs
// Minimal stand-in for a dev server: honors PORT, logs a Vite-style ready
// banner, serves "ok" on GET /, and accepts (but does not frame) WebSocket
// upgrades on /ws so proxy tests can prove bytes flow both ways.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 0);
const args = new Map(process.argv.slice(2).map((arg) => arg.split('=', 2)));
const server = createServer((req, res) => {
  if (req.url === '/not-ready') {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('not ready');
    return;
  }
  if (req.url === '/echo-headers') {
    // Echoes the request headers the upstream actually received, so proxy tests
    // can assert what did (and didn't) get forwarded, e.g. the auth cookie.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
    return;
  }
  if (req.url === '/redirect-external') {
    res.writeHead(302, { location: 'http://evil.example/steal' });
    res.end();
    return;
  }
  if (req.url === '/redirect-relative') {
    res.writeHead(302, { location: '/somewhere' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
});
server.on('upgrade', (req, socket) => {
  const bound = server.address();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      // Deliberately leak the internal address in a non-enumerated header so the
      // proxy's WS response sanitization can be proven to strip it before the
      // 101 reaches the client (see the ws-sanitize proxy test).
      `X-Upstream-Addr: 127.0.0.1:${bound.port}\r\n\r\n`,
  );
  socket.on('data', (chunk) => socket.write(chunk)); // echo, proves bidirectional relay
});
server.listen(port, '127.0.0.1', () => {
  const bound = server.address();
  console.log(`  VITE fixture  ready\n\n  ➜  Local:   http://127.0.0.1:${bound.port}/\n`);
  console.error('fixture stderr');
  if (args.has('--exit-after-ready')) setTimeout(() => process.exit(1), 100);
});
const pidFile = args.get('--spawn-grandchild');
if (pidFile) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  writeFileSync(pidFile, `${process.pid} ${grandchild.pid}`);
}
if (args.has('--ignore-sigterm')) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => server.close(() => process.exit(0)));
