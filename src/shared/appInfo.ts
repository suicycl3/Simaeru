/**
 * 表示名はここだけを書き換えれば全体に反映される（package.json の productName も併せて変更）。
 *
 * データの置き場所（userData）は APP_ID で決まる。APP_ID を変えるときは
 * `src/main/userData.ts` の引き継ぎ（古いフォルダを起動時に改名する）も併せて見直すこと。
 */
export const APP_ID = 'simaeru';
export const APP_NAME = 'Simaeru';
/** 以前の置き場所。起動時に見つけたら、中身ごと APP_ID の名前へ引き継ぐ */
export const LEGACY_APP_ID = 'dmm-library';
/** 以前の表示名。既定の保存先・一時フォルダをそのまま引き継ぐために覚えておく */
export const LEGACY_APP_NAME = 'MyLibrary';
