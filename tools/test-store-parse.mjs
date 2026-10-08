import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';
const build=testBuild();
try {
 const {parseDlsoftStoreHtml:pc,parseDoujinStoreHtml:doujin,parseBookStoreHtml:book}=build.load('src/main/sites/dmm/storeMetaParse.ts');
 const json='<script type="application/ld+json">{"@type":"Product","description":"商品説明"}</script>';
 const row=(label,value)=>`<div class="contentsDetailBottom__tableDataLeft"><p>${label}</p></div><div class="contentsDetailBottom__tableDataRight">${value}</div></div>`;
 const p=pc(json+row('ゲームジャンル','<a>ADV</a>')+row('原画','<a>テスト作家</a>'));
 assert.equal(p.description,'商品説明'); assert.deepEqual(p.tags,['ADV']); assert.ok(p.creators.some(c=>c.name==='テスト作家')); assert.equal(p.ok,true);
 // 「ゲームジャンル」はブランドが自由に書く欄。タグには入れたうえで、宣伝文句として分けて返す（「ジャンル」は公式なので分けない）
 const free=pc(json+row('ゲームジャンル','<a>近未来学園活劇ADV</a>')+row('ジャンル','<a>夏が舞台のゲーム</a><a>巨乳</a>'));
 assert.deepEqual(free.tags,['近未来学園活劇ADV','夏が舞台のゲーム','巨乳']); assert.deepEqual(free.freeTags,['近未来学園活劇ADV']);
 const d=doujin('<p class="summary__txt">全文<br>続き &amp; 説明</p><dt class="informationList__ttl">ジャンル</dt><dd class="informationList__item"><a>音声</a></dd><dt class="informationList__ttl">作者</dt><dd class="informationList__txt"><a>作者A</a></dd>');
 assert.equal(d.description,'全文\n続き & 説明'); assert.deepEqual(d.tags,['音声']); assert.ok(d.creators.some(c=>c.name==='作者A'));
 const b=book(json+'<dl><dt>作者</dt><dd>著者A</dd><dt>配信開始日</dt><dd>2026/09/17 10:00</dd><dt>ファイル容量</dt><dd>10MB</dd></dl>');
 assert.equal(b.description,'商品説明'); assert.equal(b.releasedAt,'2026-09-17 10:00'); assert.equal(b.fileSizeText,'10MB'); assert.ok(b.creators.some(c=>c.name==='著者A'));
 for(const parse of [pc,doujin,book]) {assert.equal(parse('').ok,false);assert.equal(parse('<meta property="og:description" content="予備 &amp; 説明">').description,'予備 & 説明');}
 assert.equal(pc('<script type="application/ld+json">broken</script>').ok,false);
 // 項目表を読めたか（structured）。説明文だけのページは ok でも structured ではない＝取得済みにしない
 assert.equal(p.structured,true); assert.equal(d.structured,true);
 const descOnly=pc(json); assert.equal(descOnly.ok,true); assert.equal(descOnly.structured,false);
 assert.equal(doujin('<p class="summary__txt">説明だけ</p>').structured,false);
 // ラベルの <p> に属性が付いていても読む
 const withClass=pc(json+'<div class="contentsDetailBottom__tableDataLeft"><p class="x">ジャンル</p></div><div class="contentsDetailBottom__tableDataRight"><ul><li><a>学園もの</a></li><li><a>恋愛</a></li></ul></div></div>');
 assert.deepEqual(withClass.tags,['学園もの','恋愛']); assert.equal(withClass.structured,true);
 console.log('OK: DMM PC/doujin/book metadata, fallbacks, invalid HTML, structured flag');
} finally {build.close();}
