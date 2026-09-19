/**
 * 起動中のアプリ（--remote-debugging-port 付き）のレンダラを覗く。
 *   npx electron ... --remote-debugging-port=9222 で起動しておいて
 *   node tools/inspect-renderer.mjs "式"
 */
const port = process.env.CDP_PORT || 9222;
const expr = process.argv[2] || '1+1';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.error('ページターゲットが見つかりません:', targets.map((t) => `${t.type} ${t.url}`));
  process.exit(1);
}
console.log('target:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((r) => ws.addEventListener('open', r));
const res = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true
});
console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
ws.close();
