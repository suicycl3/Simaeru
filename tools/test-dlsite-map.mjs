import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';
const build = testBuild();
try {
  const { mapDlsiteWork } = build.load('src/main/sites/dlsite/library.ts');
  const work = { workno:'RJ100001',name:{ja_JP:'作品',en:'Title'},maker:{id:'RG1',name:{ja_JP:'サークル'}},authors:[{id:'A1',name:{ja_JP:'作者'}}],series:{title_id:'S1',name:'シリーズ'},images:{main:'https://example.invalid/cover.jpg'},genre_ids:[1,1,999],work_type:'SOU',site_id:'maniax',pc_file_size:1048576,release_date:'2026-01-01T15:00:00Z',playable:true };
  const purchase = {workno:work.workno,buyDate:'2026-01-03 12:00',priceText:'100円',dlKind:'split',dlUrl:'https://www.dlsite.com/home/download/split/=/product_id/RJ100001.html',downloadUrl:null,serialKey:null,parentWorkno:'RJ100000'};
  const p = mapDlsiteWork(work,'2026-01-02T15:00:00Z',new Map([[1,'音声']]),purchase);
  assert.equal(p.title,'作品'); assert.equal(p.maker,'サークル');
  assert.equal(p.purchasedAt,'2026-01-03 00:00'); assert.equal(p.releasedAt,'2026-01-02 00:00');
  assert.equal(p.fileSizeText,'1.00MB'); assert.equal(p.category,'doujin');
  assert.equal(p.parentProductId,'RJ100000'); assert.equal(p.isDownloadable,true); assert.equal(p.isStreaming,true);
  assert.deepEqual(p.authors,['作者']); assert.equal(p.creators.length,3);
  assert.equal(p.tags.filter(t => t==='音声').length,1);
  assert.deepEqual(p.links,[{label:'分割ダウンロード',url:purchase.dlUrl,kind:'page'}]);
  const serial = mapDlsiteWork(work,null,new Map(),{...purchase,dlKind:'serial',dlUrl:'https://www.dlsite.com/home/serial/=/product_id/RJ100001.html',serialKey:'TEST-KEY',downloadUrl:'https://example.invalid/file.zip'});
  assert.equal(serial.purchasedAt,purchase.buyDate); assert.equal(serial.links.length,1); assert.equal(serial.links[0].kind,'download'); assert.equal(serial.serialKey,'TEST-KEY');
  for (const [site,category] of [['books','book'],['pro','game'],['home','doujin']]) assert.equal(mapDlsiteWork({...work,site_id:site},null,new Map()).category,category);
  const minimal=mapDlsiteWork({workno:'RJ0'},null,new Map());
  assert.equal(minimal.title,'RJ0'); assert.equal(minimal.purchasedAt,null); assert.deepEqual(minimal.links,[]);
  assert.equal(mapDlsiteWork({...work,name:{en:'English'}},null,new Map()).title,'English');
  console.log('OK: DLsite metadata, category, dates, split/serial links, missing fields');
} finally { build.close(); }
