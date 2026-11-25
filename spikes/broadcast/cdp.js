// Throwaway: evaluate an expression in a running Drift's page over the DevTools port (Drift started with --remote-debugging-port).
//   node cdp.js <port> list
//   node cdp.js <port> <url-substring|index> <expression-file.js>      (the file's text is evaluated, awaited, and the result printed as JSON)
const fs = require('fs');
const [port, which, file] = process.argv.slice(2);
(async () => {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
  if (which === 'list') { targets.forEach((t, i) => console.log(i, t.title, t.url)); return; }
  const t = /^\d+$/.test(which) ? targets[+which] : targets.find((x) => x.url.includes(which));
  if (!t) throw new Error('no page matching ' + which);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== 1) return;
    const r = m.result || {};
    if (r.exceptionDetails) console.log('ERROR', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    else console.log(JSON.stringify(r.result && r.result.value, null, 1));
    ws.close();
  };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: fs.readFileSync(file, 'utf8'), awaitPromise: true, returnByValue: true } }));
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
