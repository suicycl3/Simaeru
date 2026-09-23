// Actual production renderer with isolated in-memory APIs. No account/network data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-ui-regression-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});
const preload = path.join(work, 'preload.js');
buildSync({ entryPoints: [path.join(__dirname, 'ui-regression-preload.ts')], bundle: true, format: 'iife', platform: 'browser', outfile: preload, alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
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
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.firstChild?.textContent === 'Tools').click()`);
    await until(`document.querySelectorAll('.tool').length === 3`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'About').click()`);
    await until(`document.querySelector('.settings')?.textContent.includes('C:/fixture')`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
    await until(`!document.querySelector('.modal')`);
    await js(`document.querySelector('.sidebar__brand button').click()`);
    await until(`!!document.querySelector('.settingsNav')`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Download').click()`);
    await until(`(${concurrency})?.value === '4'`);
    // セクションを往復しても、親が持つ値は変わらない
    await openSection('Accounts', `document.querySelectorAll('.settings .account').length >= 2`);
    await js(`Array.from(document.querySelectorAll('.settingsNav__item')).find(b => b.textContent === 'Download').click()`);
    await until(`(${concurrency})?.value === '4'`);
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
