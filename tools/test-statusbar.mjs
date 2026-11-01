import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';

const build = testBuild();
try {
  // 部品と同じ React で描く（別々の React だとフックが使えない）
  const { StatusBar, createElement, renderToStaticMarkup } = build.loadSource(
    "export { default as StatusBar } from './src/renderer/src/components/StatusBar'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';"
  );
  const props = { progress: null, lastSyncAt: null, shown: 0, total: 0, meta: null,
    onMetaEnabled() {}, onMetaSpeed() {}, onMetaRunNow() {}, onOpenDownloads() {}, onOpenImport() {}, onOpenSettings() {} };
  const job = (id, state, source = 'same.zip') => ({ id, kind: 'extract', source, state, progress: 0 });
  const badge = (downloads, jobs) => renderToStaticMarkup(createElement(StatusBar, { ...props, downloads, jobs }))
    .match(/class="badge badge--error">(\d+)<\/span>/)?.[1] ?? '0';
  // 同じ対象の失敗が繰り返されても、パネルにある3行をすべて数える。
  assert.equal(badge([], [job(1,'error'),job(2,'error'),job(3,'error','other.zip')]), '3');
  assert.equal(badge([], [job(1,'error'),job(2,'done')]), '1');
  assert.equal(badge([{state:'error'}], [job(1,'error'),job(2,'queued'),job(3,'running'),job(4,'canceled')]), '2');
  assert.equal(badge([], [job(1,'done')]), '0');
  assert.equal(badge([], []), '0');
  // MCP サーバーの状態: 読み込むまでは出さない。起動中・起動できない・停止中を見分けられる
  const mcp = (status) => renderToStaticMarkup(createElement(StatusBar, { ...props, downloads: [], jobs: [], mcp: status }));
  const base = { enabled: true, running: true, port: 47615, url: 'http://127.0.0.1:47615/mcp', token: 'x', error: null };
  assert.doesNotMatch(mcp(null), /mcpState/);
  assert.match(mcp(base), /mcpState--running[^>]*aria-label="MCP サーバー: 起動中"/);
  assert.match(mcp({ ...base, running: false, error: 'port 47615 is in use' }), /mcpState--error[^>]*aria-label="MCP サーバー: 起動できません"/);
  assert.match(mcp({ ...base, enabled: false, running: false }), /mcpState--off[^>]*aria-label="MCP サーバー: 停止中"/);
  console.log('OK: rendered error badge counts all download/job failures, including history; the MCP state is shown');
} finally { build.close(); }
