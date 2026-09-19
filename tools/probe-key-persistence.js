/**
 * safeStorage の暗号鍵が「プロセスをまたいで」同じかを確かめる。
 *   npx electron tools/probe-key-persistence.js write   … 暗号化してファイルに書く
 *   npx electron tools/probe-key-persistence.js read    … 別プロセスで読んで復号する
 *
 * 使い捨ての userData を使うので、ユーザーの鍵や保存済みID/PWには触れない。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const mode = process.argv[2] || 'write';
const dir = path.join(os.tmpdir(), 'key-persistence-probe');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);
const file = path.join(dir, 'cipher.bin');

app.whenReady().then(() => {
  try {
    if (mode === 'write') {
      const buf = safeStorage.encryptString('persist-check');
      fs.writeFileSync(file, buf);
      console.log(`[probe] write: ${buf.length} bytes / Local State 有無=${fs.existsSync(path.join(dir, 'Local State'))}`);
    } else {
      const buf = fs.readFileSync(file);
      const plain = safeStorage.decryptString(buf);
      console.log(`[probe] read: 復号OK (${plain})`);
    }
  } catch (err) {
    console.log(`[probe] ${mode}: 失敗 ${err.message}`);
  } finally {
    app.quit();
  }
});
