import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { testBuild } from './test-support.mjs';

const build = testBuild();
try {
  const StatusBar = build.load('src/renderer/src/components/StatusBar.tsx').default;
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
  console.log('OK: rendered error badge counts all download/job failures, including history');
} finally { build.close(); }
