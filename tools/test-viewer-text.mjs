/**
 * ビューア内の検索と字幕の読み取りの検証。
 *   node tools/test-viewer-text.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const build = (entry, name) => {
  const outfile = path.join(os.tmpdir(), name);
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    alias: { '@shared': path.join(root, 'src', 'shared') },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'error'
  });
  return require(outfile);
};
const { buildSearchIndex, findAll } = build('src/renderer/src/lib/textSearch.ts', 'textSearch.test.cjs');
const { parseSubtitles, activeCueText } = build('src/renderer/src/lib/format.ts', 'format.test.cjs');
const { matchesMedia } = build('src/renderer/src/lib/useSubtitles.ts', 'useSubtitles.test.cjs');

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};

console.log('== ビューア内の検索 ==');
{
  const idx = buildSearchIndex(['おはようございます。', 'こんにちは、先輩。']);
  check('行の中の語が見つかる', findAll(idx, '先輩').map((h) => [h.start, h.end]), [[{ chunk: 1, offset: 6 }, { chunk: 1, offset: 8 }]]);
  check('見つからなければ空', findAll(idx, '後輩'), []);
  check('空の検索語は何も返さない', findAll(idx, '  '), []);
}
{
  const idx = buildSearchIndex(['Ｐａｇｅ　１２', 'HELLO world']);
  check('全角・半角をそろえて当てる', findAll(idx, 'page12').length, 1);
  check('大文字・小文字を区別しない', findAll(idx, 'hello').length, 1);
}
{
  // PDF は文字ごとに区切られていたり、行の途中で改行されていたりする
  const idx = buildSearchIndex(['ジト', ' 目の', '後輩']);
  const hits = findAll(idx, '目の後輩');
  check('空白と塊の区切りをまたいで当てる', hits.length, 1);
  check('またいだ塊の番号', hits[0]?.chunks, [1, 2]);
  check('最初の塊の中の開始位置（空白の次）', hits[0]?.start, { chunk: 1, offset: 1 });
  check('最後の塊の中の終了位置', hits[0]?.end, { chunk: 2, offset: 2 });
}
{
  const idx = buildSearchIndex(['ああああ']);
  check('重ならないように先頭から数える', findAll(idx, 'ああ').length, 2);
}
{
  // サロゲートペアの文字（𠮷）の後ろでも、位置がずれない
  const idx = buildSearchIndex(['𠮷野家の牛丼']);
  const hits = findAll(idx, '牛丼');
  check('サロゲートペアの後ろの位置', [hits[0]?.start.offset, hits[0]?.end.offset], [5, 7]);
  check('サロゲートペアそのものも当たる', findAll(idx, '𠮷野').map((h) => [h.start.offset, h.end.offset]), [[0, 3]]);
}

console.log('\n== 字幕（.ass / .ssa） ==');
{
  const ass = [
    '[Script Info]',
    'Title: sample',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,20',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}おはよう{\\i0}ございます',
    'Dialogue: 0,0:00:04.00,0:00:06.25,Default,,0,0,0,,一行目\\N二行目',
    'Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,本文に、カンマが、入る',
    'Comment: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,出さない'
  ].join('\r\n');
  const cues = parseSubtitles('01.ass', ass);
  check('Dialogue だけを読む（Comment は読まない）', cues.length, 3);
  check('開始と終了（百分の一秒）', [cues[0].start, cues[0].end], [1.5, 3]);
  check('装飾の指定を落とす', cues[0].text, 'おはようございます');
  check('\\N は改行', cues[1].text, '一行目\n二行目');
  check('本文のカンマは残す', cues[2].text, '本文に、カンマが、入る');
  check('.ssa も同じ形式として読む', parseSubtitles('01.SSA', ass).length, 3);
  check('重なった字幕は両方出す', activeCueText(cues, 5.5), '一行目\n二行目\n本文に、カンマが、入る');
  check('何も出ていない時間は空', activeCueText(cues, 3.5), '');
}
{
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n\n2\n00:00:03,000 --> 00:00:04,500\n<i>さようなら</i>\n';
  const cues = parseSubtitles('a.srt', srt);
  check('.srt は従来どおり読める', cues.map((c) => [c.start, c.end, c.text]), [[1, 2, 'こんにちは'], [3, 4.5, 'さようなら']]);
}

console.log('\n== 動画・音声と字幕の組み合わせ ==');
check('同じ名前', matchesMedia('01_本編.mp4', '01_本編.srt'), true);
check('言語つき', matchesMedia('01_本編.mp4', '01_本編.ja.ass'), true);
check('大文字小文字は問わない', matchesMedia('Track01.MP3', 'track01.lrc'), true);
check('名前の一部だけ同じものは別', matchesMedia('01_本編.mp4', '01_本編_おまけ.srt'), false);

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
