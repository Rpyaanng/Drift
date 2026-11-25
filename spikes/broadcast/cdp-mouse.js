// Throwaway: real mouse input into a running Drift page over the DevTools port (goes through Chromium's hit-testing, like a real mouse).
//   node cdp-mouse.js <port> <url-substring> click <x> <y>
//   node cdp-mouse.js <port> <url-substring> circle <seconds>          (circles round the middle of the window)
const [port, which, what, a, b] = process.argv.slice(2);
(async () => {
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes(which));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params) => new Promise((r) => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  if (what === 'click') {
    await mouse('mouseMoved', +a, +b);
    await mouse('mousePressed', +a, +b, { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', +a, +b, { button: 'left', clickCount: 1 });
  } else {
    const size = (await send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true })).result.result.value;
    const t0 = Date.now(); let n = 0;
    while (Date.now() - t0 < +a * 1000) {
      const ang = ((Date.now() - t0) / 3000) * 2 * Math.PI;
      await mouse('mouseMoved', size[0] * (0.5 + 0.2 * Math.cos(ang)), size[1] * (0.5 + 0.2 * Math.sin(ang)));
      n++; await new Promise((r) => setTimeout(r, 40));
    }
    console.log('moves', n);
  }
  ws.close();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
