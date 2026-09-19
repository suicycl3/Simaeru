import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';
const build=testBuild();
try {
  const { parseDlsiteWorkPage: parse }=build.load('src/main/sites/dlsite/storeParse.ts');
  const row=(label,value)=>`<tr><th>${label}</th><td>${value}</td></tr>`;
  const meta=parse('<div itemprop="description">本文<br>続き &amp; 説明</div></div></div><table id="work_outline">'+row('販売日','2026年09月17日')+row('声優','<a>テスト声優</a>')+row('ジャンル','<a>音声</a><a>音声</a>')+row('ファイル容量','合計 1.5GB')+'</table>');
  assert.equal(meta.description,'本文\n続き & 説明'); assert.equal(meta.releasedAt,'2026-09-17'); assert.equal(meta.fileSizeText,'1.5GB');
  assert.ok(meta.creators.some(c=>c.role==='声優'&&c.name==='テスト声優')); assert.deepEqual(meta.tags,['音声']);
  const book=parse('<meta name="description" content="書籍の説明"><table id="work_outline">'+row('発売日','2026年1月2日')+'</table>');
  assert.equal(book.description,'書籍の説明'); assert.equal(book.releasedAt,'2026-01-02'); assert.deepEqual(book.creators,[]);
  const empty=parse(''); assert.equal(empty.description,null); assert.equal(empty.releasedAt,null); assert.deepEqual(empty.tags,[]);
  console.log('OK: DLsite description, metadata, deduplication, book, empty page');
} finally { build.close(); }
