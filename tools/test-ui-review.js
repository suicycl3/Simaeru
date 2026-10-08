// Actual production renderer with isolated in-memory APIs. No account/network data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

/** 見本の PNG（一色）。外部の画像を持ち込まずに、大きさの分かる画像を作る */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h); // すべて 0（黒）＋各行のフィルタ種別 0
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-ui-regression-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});
const preload = path.join(work, 'preload.js');
buildSync({ entryPoints: [path.join(__dirname, 'ui-regression-preload.ts')], bundle: true, format: 'iife', platform: 'browser', outfile: preload, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
// 画面より大きい見本の画像（倍率の表示を確かめる）。solid なので deflate すれば小さい
const fixtureImage = path.join(work, 'fixture.png');
fs.writeFileSync(fixtureImage, makePng(4000, 3000));
process.env.UI_FIXTURE_IMAGE = pathToFileURL(fixtureImage).href;
process.env.UI_FIXTURE_IMAGE_SIZE = String(fs.statSync(fixtureImage).size);

const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload, contextIsolation: false, sandbox: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) console.error(`renderer: ${message}`); });
  // Mock covers must not contact real hosts.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const js = source => win.webContents.executeJavaScript(source);
  const until = async source => { for (let i = 0; i < 100; i++) { if (await js(source)) return; await wait(50); } throw new Error(`Timeout: ${source}`); };
  const input = async text => {
    await js(`(() => { const el = document.querySelector('.toolbar__search input'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(350);
  };
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html'));
    await until(`document.querySelectorAll('.card').length > 0`);
    await input('UNMATCHED_REVIEW_123');
    await until(`document.querySelector('.toolbar__count')?.textContent.includes('0')`);
    assert(await js(`!!document.querySelector('.sidebar') && !!document.querySelector('.toolbar__search input') && !document.querySelector('.gate')`));
    await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Clear filters').click()`);
    await until(`document.querySelectorAll('.card').length > 0`);
    console.log('PASS UI-01: offline zero results preserve the library and clear filters');
    // The parent must not cancel the native button activation key.
    assert(await js(`(() => { const star = document.querySelector('.fav'); star.focus(); return star.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true })); })()`));
    await js(`document.querySelector('.fav').click()`);
    assert.equal(await js(`window.__review.favorites`), 1);
    assert.equal(await js(`!!document.querySelector('.detail')`), false);
    console.log('PASS UI-02: star activation does not open the card');
    // ♡「使った」も★と同じで、押してもカードは開かない。印は押した直後に出る
    await js(`document.querySelector('.card .used').click()`);
    await until(`!!document.querySelector('.card .used--on')`);
    assert.equal(await js(`!!document.querySelector('.detail')`), false);
    assert.equal(await js(`document.querySelector('.card .used').textContent`), '♥');
    const usedFloor = `Array.from(document.querySelectorAll('.floor')).find(b => b.textContent.includes('Used'))`;
    await until(`(${usedFloor}).querySelector('.floor__count').textContent === '1'`);
    await js(`document.querySelector('.card .used').click()`);
    await until(`!document.querySelector('.card .used--on')`);
    await until(`(${usedFloor}).querySelector('.floor__count').textContent === '0'`);
    console.log('PASS UI-06: the used heart toggles in place, updates the sidebar count and does not open the card');

    // プレイリスト: サイドバーで作り、選んだ作品を小窓から入れる
    await js(`Array.from(document.querySelectorAll('.sidebar__heading--row button')).find(b => b.textContent.includes('New')).click()`);
    await until(`!!document.querySelector('.sidebar__filterRow input[aria-label="New playlist name"]')`);
    await js(`(() => { const el = document.querySelector('.sidebar__filterRow input[aria-label="New playlist name"]'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Later'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await until(`!!document.querySelector('.floor--row')`);
    assert(await js(`document.querySelector('.floor--row').textContent.startsWith('Later')`));
    // Ctrl+クリックで選び、選択バーからプレイリストの小窓を開いて入れる
    await js(`document.querySelector('.card').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
    await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Add to playlist').click()`);
    await until(`!!document.querySelector('.playlistpick')`);
    await js(`document.querySelector('.playlistpick__item').click()`);
    await until(`!document.querySelector('.playlistpick')`);
    await until(`document.querySelector('.floor--row .floor__count').textContent === '1'`);
    console.log('PASS UI-07: a playlist is created from the sidebar and selected items are added through the picker');

    // サムネイルの ＋ からも、入れ先を選んで入れられる
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.card__check')`);
    await js(`document.querySelectorAll('.card')[1].querySelector('.toPlaylist').click()`);
    await until(`!!document.querySelector('.playlistpick')`);
    assert.equal(await js(`!!document.querySelector('.detail')`), false); // カードは開かない
    await js(`document.querySelector('.playlistpick__item').click()`);
    await until(`document.querySelector('.floor--row .floor__count').textContent === '2'`);
    console.log('PASS UI-08: the card thumbnail button adds a single item to a chosen playlist');

    // 消すときは、OS の確認窓ではなくアプリの中で尋ねる（ほかの削除と同じ見た目）
    await js(`document.querySelectorAll('.floor--row .floor__act')[1].click()`);
    await until(`!!document.querySelector('.sidebar .confirm--danger')`);
    await js(`Array.from(document.querySelectorAll('.confirm--danger button')).find(b => b.textContent === 'Cancel').click()`);
    await until(`!document.querySelector('.sidebar .confirm--danger') && !!document.querySelector('.floor--row')`);
    await js(`document.querySelectorAll('.floor--row .floor__act')[1].click()`);
    await until(`!!document.querySelector('.sidebar .confirm--danger')`);
    await js(`Array.from(document.querySelectorAll('.confirm--danger button')).find(b => b.textContent === 'Delete').click()`);
    await until(`!document.querySelector('.floor--row')`);
    console.log('PASS UI-09: deleting a playlist asks inside the app and can be cancelled');

    // 紐付け済みのゲームは、詳細の上部（画像・再生と同じ場所）からも起動できる
    const gameTitle = await js(`window.api.library.query({ limit: 5000 }).then(r => (r.items.find(p => p.installation) || {}).title || '')`);
    assert(gameTitle);
    await input(gameTitle);
    await until(`document.querySelectorAll('.card').length > 0`);
    await js(`document.querySelector('.card').click()`);
    await until(`!!document.querySelector('.detail .install__actions button')`);
    // 差し込む順は中身の読み込み次第なので、見た目の並び（左上から）で確かめる
    const topButtons = await js(`Array.from(document.querySelectorAll('.detail__primary button'))
      .map(b => ({ label: b.textContent.trim(), top: Math.round(b.getBoundingClientRect().top), left: Math.round(b.getBoundingClientRect().left) }))
      .sort((a, b) => a.top - b.top || a.left - b.left).map(b => b.label)`);
    assert.equal(topButtons[0], '▶ Launch'); // 先頭に出す
    assert(await js(`Array.from(document.querySelectorAll('.detail .install__actions button')).some(b => b.textContent.trim() === '▶ Launch')`));
    await js(`Array.from(document.querySelectorAll('.detail__primary button')).find(b => b.textContent.trim() === '▶ Launch').click()`);
    await until(`(window.__launched || []).length === 1`);
    await js(`document.querySelector('.detail__close').click()`);
    await input('');
    await until(`document.querySelectorAll('.card').length > 1`);
    console.log('PASS UI-10: a linked game can be launched from the top of the details');

    // 画像ビューア: 倍率は原寸に対する割合で出す（「全体」でも 100% と出さない）。大きさと容量も出す
    await js(`document.querySelector('.card').click()`);
    await until(`Array.from(document.querySelectorAll('.detail__primary button')).some(b => b.textContent.includes('View images'))`);
    await js(`Array.from(document.querySelectorAll('.detail__primary button')).find(b => b.textContent.includes('View images')).click()`);
    // 読み込めてから大きさが出る
    await until(`document.querySelector('.viewerMeta')?.textContent.includes('4000')`);
    const meta = await js(`document.querySelector('.viewerMeta').textContent`);
    assert(meta.includes('4000×3000'), meta); // 原寸の大きさ
    assert(/\d+(\.\d+)?\s*[KMG]?B/.test(meta), meta); // 容量
    const percent = () => js(`Number(document.querySelector('.zoomCtl__value').textContent.replace('%',''))`);
    const contain = await percent();
    assert(contain > 0 && contain < 100, `全体表示は原寸より小さいはず: ${contain}%`);
    // 「全体 → 幅合わせ → 原寸」と切り替えると 100%
    const fitButton = `Array.from(document.querySelectorAll('button')).find(b => ['Fit page','Fit width','Actual size'].includes(b.textContent.trim()))`;
    await js(`(${fitButton}).click()`);
    await wait(200);
    await js(`(${fitButton}).click()`);
    await until(`document.querySelector('.zoomCtl__value').textContent === '100%'`);
    // 原寸から拡大すると、そのぶん増える
    await js(`document.querySelectorAll('.zoomCtl button')[2].click()`);
    await until(`Number(document.querySelector('.zoomCtl__value').textContent.replace('%','')) > 100`);
    // 表示の設定（⚙）は、いちばん小さい窓（1024×640）でも画面に収まり、はみ出すぶんは中で送る
    const [fullW, fullH] = win.getContentSize();
    win.setContentSize(1024, 640);
    await wait(200);
    await js(`Array.from(document.querySelectorAll('.popoverWrap > button')).find(b => b.textContent.trim() === '⚙').click()`);
    await until(`!!document.querySelector('.viewerPrefs')`);
    const prefsBox = await js(`(() => { const e = document.querySelector('.viewerPrefs'); const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight, scrolls: e.scrollHeight > e.clientHeight }; })()`);
    assert(prefsBox.top >= 0 && prefsBox.bottom <= prefsBox.vh, JSON.stringify(prefsBox));
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.viewerPrefs')`);
    win.setContentSize(fullW, fullH);
    await wait(200);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    console.log('PASS UI-11: the image viewer shows the scale against the original size, with pixel size and bytes');
    // タグ欄もブランドと同じく、件数順・名前順と昇順・降順を切り替えられる
    const tagSection = `Array.from(document.querySelectorAll('.sidebar__section')).find(s => s.querySelector('.sidebar__heading')?.firstChild?.textContent === 'Tags')`;
    await until(`(${tagSection})?.querySelectorAll('.maker').length >= 3`);
    const tagRows = () => js(`Array.from((${tagSection}).querySelectorAll('.maker')).map(b => ({ name: b.querySelector('.maker__name').textContent, count: Number(b.querySelector('.maker__count').textContent) }))`);
    const byCount = await tagRows();
    assert(byCount.every((r, i) => i === 0 || byCount[i - 1].count >= r.count), JSON.stringify(byCount)); // 既定は件数の多い順
    await js(`Array.from((${tagSection}).querySelectorAll('.sidebar__sortRow button')).find(b => b.textContent === 'Name').click()`);
    await wait(100);
    const isSorted = (rows, sign) => rows.every((r, i) => i === 0 || sign * rows[i - 1].name.localeCompare(r.name, 'en-US') <= 0);
    const byNameDesc = await tagRows();
    assert(isSorted(byNameDesc, -1), JSON.stringify(byNameDesc));
    await js(`(${tagSection}).querySelector('.sidebar__sortRow .btn--dir').click()`);
    await wait(100);
    const byNameAsc = await tagRows();
    assert(isSorted(byNameAsc, 1) && byNameAsc.length === byCount.length, JSON.stringify(byNameAsc));
    // 名前順でも件数はそのまま出る
    assert(byNameAsc.every((r) => byCount.some((c) => c.name === r.name && c.count === r.count)));
    console.log('PASS UI-12: the tag list switches between count and name order, ascending or descending');
    // 設定の「統計・書き出し」: 集計・タグを外す操作と戻す操作・ランキング外の表示・動画のプレビュー
    await js(`document.querySelector('.sidebar__brand button').click()`);
    await until(`!!document.querySelector('.settingsNav')`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Statistics & export').click()`);
    await until(`!!document.querySelector('.stats__cards')`);
    const totalShown = await js(`Number(document.querySelector('.stats__value').textContent.replace(/[^0-9]/g, ''))`);
    assert(totalShown > 0, `total ${totalShown}`);
    // 見本は半分の作品が詳細を取っていない: 揃い具合を出し、「残りを取得」で裏の取得を始める
    const coverage = await js(`document.querySelector('.stats__coverage .banner')?.textContent ?? ''`);
    assert(/Tags fetched for [\d,]+ \/ [\d,]+ items/.test(coverage), coverage);
    await js(`Array.from(document.querySelectorAll('.stats__coverage button')).find(b => b.textContent === 'Fetch remaining').click()`);
    await until(`document.querySelector('.stats__coverage').textContent.includes('Fetching in the background')`);
    const tagList = `Array.from(document.querySelectorAll('.stats__listTitle')).find(e => e.textContent === 'Tags (merged)').parentElement`;
    const tagNames = () => js(`Array.from((${tagList}).querySelectorAll('.stats__name')).map(e => e.textContent)`);
    const before = await tagNames();
    const firstTag = before[0];
    await js(`(${tagList}).querySelector('li button').click()`);
    await until(`(${tagList}).querySelector('.stats__name')?.textContent !== ${JSON.stringify(firstTag)}`);
    // 外したタグは「除外したタグ」に出て、押すと戻る
    const restoreChip = `Array.from(document.querySelectorAll('.stats__restore .chip')).find(c => c.textContent.includes(${JSON.stringify(firstTag)}))`;
    await until(`!!(${restoreChip})`);
    await js(`(${restoreChip}).click()`);
    await until(`(${tagList}).querySelector('.stats__name')?.textContent === ${JSON.stringify(firstTag)} && !document.querySelector('.stats__restore')`);
    // 2 つ外して「すべて戻す」
    await js(`(${tagList}).querySelector('li button').click()`);
    await until(`(${tagList}).querySelector('.stats__name')?.textContent !== ${JSON.stringify(firstTag)}`);
    await js(`(${tagList}).querySelector('li button').click()`);
    await until(`document.querySelectorAll('.stats__restore .chip').length === 2`);
    await js(`Array.from(document.querySelectorAll('.stats__restore .link')).find(b => b.textContent === 'Restore all').click()`);
    await until(`!document.querySelector('.stats__restore')`);
    assert.deepEqual(await tagNames(), before);
    // ランキング外の表示（見本のタグは 4 種なので切り替えは出ない。出ないことだけ見る）
    const allTags = await js(`document.querySelectorAll('.stats__tags .check').length`);
    assert.equal(allTags, before.length > 20 ? 1 : 0);
    // 動画のページ: プレビューに何か描かれている（背景一色ではない）。再生すると時刻が進む
    await js(`Array.from(document.querySelectorAll('.stats__pages button')).find(b => b.textContent === 'Video / GIF').click()`);
    await until(`!!document.querySelector('.stats__preview')`);
    await wait(200);
    const painted = await js(`(() => { const c = document.querySelector('.stats__preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return seen.size; })()`);
    assert(painted > 3, `preview colors ${painted}`);
    // 未取得の作品があれば、動画のページでも知らせる
    assert(await js(`Array.from(document.querySelectorAll('.stats .banner')).some(b => b.textContent.includes('recent months will appear lower'))`));
    // 縦長の大きさを選ぶと、プレビューも縦長になる。順位は範囲を指定できる（不正な範囲では書き出せない）
    const setSelect = (label, value) => js(`(() => { const e = document.querySelector('.stats select[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await setSelect('Size', 'v1920');
    await until(`(() => { const c = document.querySelector('.stats__preview'); return c.height > c.width; })()`);
    // 順位の上限は対象の数: 対象の数より多い「上位 N 位まで」は出さず、「すべて（N 位まで）」を出す
    const rankOptions = await js(`Array.from(document.querySelector('.stats select[aria-label="Ranks"]').options).map(o => [o.value, o.textContent])`);
    const allOption = rankOptions.find(([v]) => v === 'all');
    const total = Number(/All \(([\d,]+)\)/.exec(allOption[1])[1].replace(/,/g, ''));
    assert(total > 0 && rankOptions.every(([v]) => v === 'all' || v === 'custom' || Number(v) < total || Number(v) === 10), JSON.stringify(rankOptions));
    // 順位の選択肢は数字だけ
    assert(rankOptions.filter(([v]) => /^\d+$/.test(v)).every(([v, label]) => label === v), JSON.stringify(rankOptions));
    // 「すべて」を選んだら、そのまま「すべて」になり、範囲のエラーも出ない（書き出しを止めない）
    await setSelect('Ranks', 'all');
    await until(`document.querySelector('.stats select[aria-label="Ranks"]').value === 'all'`);
    assert(!(await js(`!!document.querySelector('.stats .stats__error')`)), '「すべて」で範囲のエラーを出さない');
    await setSelect('Ranks', 'custom');
    await until(`!!document.querySelector('.stats input[aria-label="From rank"]')`);
    const setNumber = (label, value) => js(`(() => { const e = document.querySelector('.stats input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(String(value))}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await setNumber('From rank', 3);
    await setNumber('To rank', 2);
    await until(`!!document.querySelector('.stats .stats__error')`);
    await setNumber('To rank', total + 1); // 対象の数を超える範囲は断る
    await until(`!!document.querySelector('.stats .stats__error')`);
    await setNumber('To rank', Math.min(4, total));
    await until(`!document.querySelector('.stats .stats__error')`);
    // 大きさを指定: 奇数は断る
    await setSelect('Size', 'custom');
    await setNumber('Width', 1081);
    await until(`!!document.querySelector('.stats .stats__error')`);
    await setNumber('Width', 1080);
    await until(`!document.querySelector('.stats .stats__error')`);
    await setSelect('Size', 'h720');
    await setSelect('Ranks', '10');
    // 順位の表示・段組み（自動は列の数を添える）
    await js(`Array.from(document.querySelectorAll('.stats label.check')).find(l => l.textContent === 'Show ranks').querySelector('input').click()`);
    assert(/Auto \(\d+ columns\)/.test(await js(`document.querySelector('.stats select[aria-label="Columns"]').options[0].textContent`)));
    await setSelect('Columns', '2');
    await until(`document.querySelector('.stats select[aria-label="Columns"]').value === '2'`);
    await setSelect('Columns', 'auto');
    await js(`Array.from(document.querySelectorAll('.stats button')).find(b => b.textContent === 'Play').click()`);
    await until(`Number(document.querySelector('.stats__seek').value) > 0`);
    await js(`Array.from(document.querySelectorAll('.stats button')).find(b => b.textContent === 'Pause').click()`);
    assert(await js(`Array.from(document.querySelectorAll('.stats button')).find(b => b.textContent === 'Export…').disabled`), 'ffmpeg が無ければ書き出しは押せない');
    assert(await js(`Array.from(document.querySelectorAll('.stats .link')).some(b => b.textContent === 'Open tool settings')`));
    console.log('PASS UI-13: the statistics page summarizes purchases, lets tags be left out and restored, and previews the chart');

    // 名寄せ辞典: 一覧・検索・グループを作ってタグを寄せる・外す・名前を変える・消す・既定に戻す。集計にも効く
    await js(`Array.from(document.querySelectorAll('.stats__pages button')).find(b => b.textContent === 'Tag dictionary').click()`);
    await until(`document.querySelectorAll('.stats__group').length > 30`);
    const setInput = (selector, value) => js(`(() => { const e = ${selector}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await setInput(`document.querySelector('.stats__dictionary .stats__find')`, 'NTR');
    await until(`document.querySelectorAll('.stats__group').length === 1`);
    await setInput(`document.querySelector('.stats__dictionary .stats__find')`, '');
    // 寄せる候補: 見本の DMM「けもの娘」と DLsite「けもの/獣化」。寄せると 1 つのグループになる
    const suggestion = `Array.from(document.querySelectorAll('.stats__suggestList li')).find(li => li.textContent.includes('けもの娘'))`;
    await until(`!!(${suggestion})`);
    await js(`Array.from((${suggestion}).querySelectorAll('button')).find(b => b.textContent === 'Merge').click()`);
    await until(`!(${suggestion}) && Array.from(document.querySelectorAll('.stats__group')).some(g => g.dataset.group === 'けもの娘' || g.dataset.group === 'けもの/獣化')`);
    // 見本のタグ ASMR と 癒し を 1 つにまとめる
    await setInput(`document.querySelectorAll('.stats__dictionary form .stats__find')[0]`, 'ASMR');
    await js(`Array.from(document.querySelectorAll('.stats__dictionary button')).find(b => b.textContent === 'Create group').click()`);
    const group = `Array.from(document.querySelectorAll('.stats__group')).find(g => g.dataset.group === 'ASMR')`;
    await until(`!!(${group})`);
    assert(await js(`(${group}).textContent.includes('Added by you')`));
    await setInput(`(${group}).querySelector('.stats__addMember input')`, '癒し');
    await js(`(${group}).querySelector('.stats__addMember button').click()`);
    await until(`(${group}).querySelectorAll('.chip__remove').length === 1`);
    // 代表名のタグを別のグループに寄せようとすると断る
    await setInput(`(${group}).querySelector('.stats__addMember input')`, '寝取り・寝取られ（NTR）');
    await js(`(${group}).querySelector('.stats__addMember button').click()`);
    await until(`!!document.querySelector('.stats__dictionary .banner--error')`);
    // 集計に効く（癒し が ASMR に寄る）
    await js(`Array.from(document.querySelectorAll('.stats__pages button')).find(b => b.textContent === 'Summary').click()`);
    await until(`!!(${tagList})`);
    const merged = await tagNames();
    assert(merged.includes('ASMR') && !merged.includes('癒し'), JSON.stringify(merged));
    // 外す → 名前を変える → 消す → 既定に戻す
    await js(`Array.from(document.querySelectorAll('.stats__pages button')).find(b => b.textContent === 'Tag dictionary').click()`);
    await until(`!!(${group})`);
    await js(`(${group}).querySelector('.chip__remove').click()`);
    await until(`(${group}).querySelectorAll('.chip__remove').length === 0`);
    await js(`Array.from((${group}).querySelectorAll('button')).find(b => b.textContent === 'Rename').click()`);
    await setInput(`(${group}).querySelector('form.stats__groupHead input')`, 'ASMR・音声');
    await js(`Array.from((${group}).querySelectorAll('form.stats__groupHead button')).find(b => b.textContent === 'Change').click()`);
    const renamed = `Array.from(document.querySelectorAll('.stats__group')).find(g => g.dataset.group === 'ASMR・音声')`;
    await until(`!!(${renamed})`);
    assert(await js(`Array.from((${renamed}).querySelectorAll('.chip')).some(c => c.textContent.startsWith('ASMR'))`), '元の名前は別名として残る');
    await js(`Array.from((${renamed}).querySelectorAll('button')).find(b => b.textContent === 'Delete group').click()`);
    await js(`Array.from((${renamed}).querySelectorAll('button')).find(b => b.textContent === 'Delete').click()`);
    await until(`!(${renamed})`);
    await js(`Array.from(document.querySelectorAll('.stats__dictionary button')).find(b => b.textContent === 'Reset to the default dictionary…').click()`);
    await js(`Array.from(document.querySelectorAll('.stats__dictionary button')).find(b => b.textContent === 'Reset to default').click()`);
    await until(`document.querySelector('.stats__dictionary').textContent.includes('(default dictionary)')`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.modal')`);
    console.log('PASS UI-14: the tag dictionary can be searched, edited and reset, and edits change the counts');
    await js(`document.querySelector('.sidebar__brand button').focus(); document.querySelector('.sidebar__brand button').click()`);
    await until(`!!document.querySelector('.modal')`);
    await wait(150);
    assert(await js(`document.querySelector('.modal').contains(document.activeElement)`));
    for (let i = 0; i < 30; i++) await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true, cancelable:true }))`);
    assert(await js(`document.querySelector('.modal').contains(document.activeElement)`));
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))`);
    await until(`!document.querySelector('.modal')`);
    assert(await js(`document.querySelector('.sidebar__brand').contains(document.activeElement)`));
    console.log('PASS UI-03: modal focus, Tab containment, Escape and focus return');
    await js(`document.querySelector('.sidebar__brand button').click()`);
    await until(`!!document.querySelector('.settingsNav')`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Download').click()`);
    const concurrency = `Array.from(document.querySelectorAll('.settings select')).find(e => Array.from(e.options).map(o=>o.value).join(',') === '1,2,3,4,6,8')`;
    await until(`!!(${concurrency})`);
    await js(`(() => { const e = ${concurrency}; e.value = '4'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await until(`(${concurrency}).value === '4'`);
    // 分割した各セクションが、それぞれの中身を出すこと（親が持つ設定・保存はそのまま）
    const openSection = async (label, marker) => {
      await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => (b.firstChild?.textContent ?? b.textContent) === ${JSON.stringify(label)}).click()`);
      await until(marker);
    };
    await openSection('Accounts', `document.querySelectorAll('.settings .account').length >= 2`);
    await openSection('Games', `document.querySelectorAll('.settings .check input[type=checkbox]').length >= 2`);
    await openSection('Images & CG', `!!Array.from(document.querySelectorAll('.settings select')).find(e => Array.from(e.options).map(o=>o.value).join(',') === 'scroll,page')`);
    await openSection('ASMR & voice', `!!Array.from(document.querySelectorAll('.settings select')).find(e => Array.from(e.options).map(o=>o.value).join(',') === 'flat,voice,whisper,soft')`);
    await openSection('General', `!!Array.from(document.querySelectorAll('.settings select')).find(e => Array.from(e.options).map(o=>o.value).includes('ja'))`);
    // すべての作品のタグ情報を取り直す: 確かめてから始め、件数を出す
    const generalButton = (label) => `Array.from(document.querySelectorAll('.settings button')).find(b => b.textContent === ${JSON.stringify(label)})`;
    await js(`(${generalButton('Re-fetch tag information for all works…')}).click()`);
    await until(`!!(${generalButton('Re-fetch')})`);
    await js(`(${generalButton('Re-fetch')}).click()`);
    await until(`/Re-fetching [\\d,]+ works/.test(document.querySelector('.settings [role=status]')?.textContent ?? '')`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.firstChild?.textContent === 'Tools').click()`);
    await until(`document.querySelectorAll('.tool').length === 3`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'About').click()`);
    await until(`document.querySelector('.settings')?.textContent.includes('C:/fixture')`);
    // 新しい版の確認（押したときだけ）。新しい版があればリリースのページを開ける
    const aboutButton = (label) => `Array.from(document.querySelectorAll('.settings button')).find(b => b.textContent === ${JSON.stringify(label)})`;
    await js(`(${aboutButton('Check for a new version')}).click()`);
    await until(`document.querySelector('.settings').textContent.includes('Version 0.4.0 is available')`);
    assert(await js(`!!(${aboutButton('Open the release page')})`));
    // ユーザーデータを削除して終了: 消すもの・残すもの（ダウンロードの保存先）を見せ、確かめるまで押せない
    await js(`(${aboutButton('Delete user data and quit…')}).click()`);
    await until(`!!document.querySelector('.removeData')`);
    await until(`document.querySelector('.removeData').textContent.includes('Simaeru')`);
    assert(await js(`(${aboutButton('Delete user data and quit')}).disabled`), '確かめるまで押せない');
    await js(`document.querySelector('.removeData input[type=checkbox]').click()`);
    await until(`!(${aboutButton('Delete user data and quit')}).disabled`);
    await js(`(${aboutButton('Delete user data and quit')}).click()`);
    await until(`window.__deletedUserData === true`);
    console.log('PASS UI-15: About checks for a new version on request and deletes user data only after confirmation');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
    await until(`!document.querySelector('.modal')`);
    // 同期履歴が長くても、枠は画面に収まり（× に手が届く）、中身だけが送れる。Esc でも閉じる
    await js(`window.__review.history = Array.from({ length: 60 }, (_, i) => ({ runId: 'r' + i, status: 'done', startedAt: Date.now() - i * 3600000, finishedAt: null, floors: ['dmm:dlsoft', 'dmm:doujin', 'dmm:book', 'dmm:video', 'dlsite:library'].map((floorKey) => ({ floorKey, fetched: 100, added: 0, error: null })) }))`);
    await js(`Array.from(document.querySelectorAll('button.link')).find(b => b.textContent === 'Sync history').click()`);
    await until(`document.querySelectorAll('.syncHistory__entry').length === 60`);
    const historyBox = await js(`(() => { const p = document.querySelector('.modal__panel').getBoundingClientRect(); const x = document.querySelector('.modal__head .detail__close').getBoundingClientRect(); const s = document.querySelector('.modal__scroll'); return { top: p.top, bottom: p.bottom, closeTop: x.top, vh: innerHeight, scrolls: s.scrollHeight > s.clientHeight }; })()`);
    assert(historyBox.top >= 0 && historyBox.bottom <= historyBox.vh && historyBox.closeTop >= 0, JSON.stringify(historyBox));
    assert(historyBox.scrolls, '中身は枠の中で送る');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
    await until(`!document.querySelector('.modal')`);
    await js(`window.__review.history = []`);
    console.log('PASS UI-16: a long sync history stays within the window, scrolls inside, and closes with Escape');
    await js(`document.querySelector('.sidebar__brand button').click()`);
    await until(`!!document.querySelector('.settingsNav')`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Download').click()`);
    await until(`(${concurrency})?.value === '4'`);
    // セクションを往復しても、親が持つ値は変わらない
    await openSection('Accounts', `document.querySelectorAll('.settings .account').length >= 2`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Download').click()`);
    await until(`(${concurrency})?.value === '4'`);
    // フォルダ構成: トークンを意味・例つきで並べ、押すとカーソルの位置に入り、例のパスが変わる。綴りの間違いは知らせる
    // （欄から離れると保存して並べ直しを聞くので、ここではフォーカスを動かさない）
    const tpl = `document.querySelector('#folder-template')`;
    await until(`document.querySelectorAll('.tokenList__item').length === 8`);
    assert(await js(`Array.from(document.querySelectorAll('.tokenList__item')).some(b => b.textContent.includes('{productId}') && b.textContent.includes('Product ID') && b.textContent.includes('RJ00000000'))`));
    await js(`(() => { const e = ${tpl}; e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await js(`Array.from(document.querySelectorAll('.tokenList__item')).find(b => b.querySelector('code').textContent === '{productId}').click()`);
    await until(`${tpl}.value.endsWith('{title}{productId}')`);
    await until(`(document.querySelector('.tokenList__example')?.textContent ?? '').includes('サンプル作品のタイトルRJ00000000\\\\RJ00000000.zip')`);
    await js(`(() => { const e = ${tpl}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '{site}/{titel}'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`(document.querySelector('.settings [role=alert]')?.textContent ?? '').includes('{titel} is not a valid token')`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
    await until(`!document.querySelector('.modal')`);
    console.log('PASS settings: save and reopen, all split sections render and keep values');
    await js(`window.__review.mode='delay'`);
    await input('サンプル作品 1');
    await input('サンプル作品 2');
    await until(`window.__review.pending.length >= 2`);
    await js(`window.__review.pending[1].release()`); await wait(150);
    const titles = await js(`Array.from(document.querySelectorAll('.card__title')).map(e=>e.textContent)`);
    await js(`window.__review.pending[0].release()`); await wait(150);
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('.card__title')).map(e=>e.textContent)`), titles);
    assert(titles.length > 0);
    console.log('PASS R11: reversed search responses do not replace the current result');
    // Compare the production layout at all requested scale factors and supported languages.
    win.setSize(1920, 1080);
    for (const lang of ['ja', 'en', 'zh']) {
      await win.loadFile(path.join(root, 'out/renderer/index.html'), { query: { lang } });
      await until(`document.querySelectorAll('.card').length > 0`);
      await js(`document.querySelector('.card').click()`);
      await until(`!!document.querySelector('.detail__primary button')`);
      assert(await js(`document.querySelector('.detail__primary button').getBoundingClientRect().bottom < innerHeight`));
      await js(`document.querySelector('.detail__primary button').click()`);
      await until(`!!document.querySelector('.player__bar')`);
      for (const factor of [1, 1.25, 1.5, 2]) {
        win.webContents.setZoomFactor(factor);
        await wait(150);
        const overflow = await js(`Array.from(document.querySelectorAll('.player__bar button,.player__bar select,.player__bar input')).filter(e=>{const r=e.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1 || r.bottom > innerHeight+1;}).map(e=>e.textContent||e.className)`);
        assert.deepEqual(overflow, [], `${lang} ${factor}: controls must fit`);
      }
      console.log(`PASS UI-04/05: ${lang}, scale 100/125/150/200%, primary action and all player controls visible`);
      win.webContents.setZoomFactor(1);
    }
    console.log('UI review regressions passed');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
