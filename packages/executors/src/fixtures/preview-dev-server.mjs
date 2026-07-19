// packages/executors/src/fixtures/preview-dev-server.mjs
// Minimal stand-in for a dev server: honors PORT, logs a Vite-style ready
// banner, serves "ok" on GET /, and accepts (but does not frame) WebSocket
// upgrades on /ws so proxy tests can prove bytes flow both ways.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 0);
const args = new Map(process.argv.slice(2).map((arg) => arg.split('=', 2)));
const server = createServer((req, res) => {
  if (req.url === '/never-ending') {
    const responseCloseFile = args.get('--response-close-file');
    if (responseCloseFile) res.once('close', () => writeFileSync(responseCloseFile, 'closed'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('ok');
    return;
  }
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
  if (req.url === '/dom-source-map-fixture') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>
<div id="simple" style="width:120px;height:24px;background:#eee">Simple</div>
<div id="wrapper" style="width:120px;height:24px;background:#eee">Wrapper</div>
<div id="generated" style="width:120px;height:24px;background:#eee">Generated</div>
<script>
  document.getElementById('simple').__reactFiber$fixture = {
    type: { name: 'Greeting' },
    return: null,
    _debugSource: { fileName: 'src/Greeting.tsx', lineNumber: 4, columnNumber: 3 },
  };
  document.getElementById('wrapper').__reactFiber$fixture = {
    type: { name: 'Button' },
    return: {
      type: { name: 'Card' },
      return: null,
      _debugSource: { fileName: 'src/Card.tsx', lineNumber: 12, columnNumber: 3 },
    },
    _debugSource: { fileName: 'src/Button.tsx', lineNumber: 8, columnNumber: 5 },
  };
  // 'generated' has no __reactFiber$* property at all — the unsupported/degrade path.
</script>
</body></html>`);
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
const appendPidFile = args.get('--append-grandchild');
if (pidFile || appendPidFile) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  if (pidFile) writeFileSync(pidFile, `${process.pid} ${grandchild.pid}`);
  if (appendPidFile) appendFileSync(appendPidFile, `${process.pid} ${grandchild.pid}\n`);
}
const exitFirstMarker = args.get('--exit-first');
if (exitFirstMarker && !existsSync(exitFirstMarker)) {
  writeFileSync(exitFirstMarker, 'exited');
  setImmediate(() => process.exit(1));
}
if (args.has('--ignore-sigterm')) process.on('SIGTERM', () => {});
else
  process.on('SIGTERM', () => {
    console.error('fixture stopping');
    server.close(() => process.exit(0));
  });
