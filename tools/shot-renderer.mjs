/**
 * 起動中のアプリ（--remote-debugging-port=9222）の画面を撮る。
 *   node tools/shot-renderer.mjs 出力先.png
 */
import fs from 'node:fs';
const port = process.env.CDP_PORT || 9222;
const out = process.argv[2] || 'shot.png';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.error('ページターゲットなし');
  process.exit(1);
}
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
const res = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(res.result.data, 'base64'));
console.log('保存:', out, fs.statSync(out).size, 'bytes');
ws.close();
