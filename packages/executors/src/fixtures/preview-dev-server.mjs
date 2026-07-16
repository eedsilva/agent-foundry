// packages/executors/src/fixtures/preview-dev-server.mjs
// Minimal stand-in for a dev server: honors PORT, logs a Vite-style ready
// banner, serves "ok" on GET /, and accepts (but does not frame) WebSocket
// upgrades on /ws so proxy tests can prove bytes flow both ways.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 0);
const server = createServer((req, res) => {
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
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
  );
  socket.on('data', (chunk) => socket.write(chunk)); // echo, proves bidirectional relay
});
server.listen(port, '127.0.0.1', () => {
  const bound = server.address();
  console.log(`  VITE fixture  ready\n\n  ➜  Local:   http://127.0.0.1:${bound.port}/\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
