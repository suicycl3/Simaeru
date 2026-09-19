/**
 * 起動中のアプリのメインプロセスで式を評価する（調査用）。
 *   electron . --inspect=9229 で起動しておいて
 *   node tools/inspect-main.mjs "式"
 * 式の中では `req('electron')` で require できる。Promise は待つ。
 */
const port = process.env.INSPECT_PORT || 9229;
const expr = process.argv[2] || '1+1';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
const wrapped = `(async () => { const req = require; return (${expr}); })()`;
const res = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
const value = res.result?.result?.value;
console.log(typeof value === "string" ? value : JSON.stringify(value ?? res, null, 1));
ws.close();
