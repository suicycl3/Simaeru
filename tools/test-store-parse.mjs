import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';
const build=testBuild();
try {
 const {parseDlsoftStoreHtml:pc,parseDoujinStoreHtml:doujin,parseBookStoreHtml:book}=build.load('src/main/sites/dmm/storeMetaParse.ts');
 const json='<script type="application/ld+json">{"@type":"Product","description":"商品説明"}</script>';
 const row=(label,value)=>`<div class="contentsDetailBottom__tableDataLeft"><p>${label}</p></div><div class="contentsDetailBottom__tableDataRight">${value}</div></div>`;
 const p=pc(json+row('ゲームジャンル','<a>ADV</a>')+row('原画','<a>テスト作家</a>'));
 assert.equal(p.description,'商品説明'); assert.deepEqual(p.tags,['ADV']); assert.ok(p.creators.some(c=>c.name==='テスト作家')); assert.equal(p.ok,true);
 const d=doujin('<p class="summary__txt">全文<br>続き &amp; 説明</p><dt class="informationList__ttl">ジャンル</dt><dd class="informationList__item"><a>音声</a></dd><dt class="informationList__ttl">作者</dt><dd class="informationList__txt"><a>作者A</a></dd>');
 assert.equal(d.description,'全文\n続き & 説明'); assert.deepEqual(d.tags,['音声']); assert.ok(d.creators.some(c=>c.name==='作者A'));
 const b=book(json+'<dl><dt>作者</dt><dd>著者A</dd><dt>配信開始日</dt><dd>2026/09/17 10:00</dd><dt>ファイル容量</dt><dd>10MB</dd></dl>');
 assert.equal(b.description,'商品説明'); assert.equal(b.releasedAt,'2026-09-17 10:00'); assert.equal(b.fileSizeText,'10MB'); assert.ok(b.creators.some(c=>c.name==='著者A'));
 for(const parse of [pc,doujin,book]) {assert.equal(parse('').ok,false);assert.equal(parse('<meta property="og:description" content="予備 &amp; 説明">').description,'予備 & 説明');}
 assert.equal(pc('<script type="application/ld+json">broken</script>').ok,false);
 console.log('OK: DMM PC/doujin/book metadata, fallbacks, invalid HTML');
} finally {build.close();}
