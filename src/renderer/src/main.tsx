import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PopupViewer from './PopupViewer';
import { readPopupSpec } from './lib/popup';
import './styles.css';
import './styles-media.css';

// ブラウザ単体で開いたときだけ、UI確認用のダミーAPIを入れる（Electron上では何もしない）
if (import.meta.env.DEV) {
  const { installDevMock } = await import('./devMock');
  installDevMock();
}

// 窓にファイルをドロップしても、そのファイルのページへ移らないようにする（移ると preload の API が渡る。
// メイン側でも移動を止めている: security/appPages.ts）。ドロップを受け付ける画面は今は無い
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault());
}

// 別ウィンドウで開いたビューアは、ライブラリを出さずにビューアだけを描く（main の viewer/popups.ts）
const popup = readPopupSpec(window.location.hash);
if (popup) document.body.classList.add('is-popup');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{popup ? <PopupViewer spec={popup} /> : <App />}</React.StrictMode>
);
