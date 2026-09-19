/**
 * 道具から、アプリのデータの置き場所を引くための共通処理。
 *
 * 本体は起動時に `%APPDATA%\dmm-library` を `%APPDATA%\simaeru` へ引き継ぐ（src/main/userData.ts）。
 * 道具は本体より先に動くこともあるので、**新しい名前が無ければ古い名前を見る**。引き継ぎ自体はしない
 * （道具が勝手にフォルダを動かすと、本体が動いている最中だと壊しかねないため）。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'simaeru';
const LEGACY_APP_ID = 'dmm-library';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} appData %APPDATA%（Electron なら app.getPath('appData')） */
function userDataDir(appData) {
  const current = path.join(appData, APP_ID);
  const legacy = path.join(appData, LEGACY_APP_ID);
  return !isDir(current) && isDir(legacy) ? legacy : current;
}

module.exports = { APP_ID, LEGACY_APP_ID, userDataDir };
