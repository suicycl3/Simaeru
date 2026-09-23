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

// 別ウィンドウで開いたビューアは、ライブラリを出さずにビューアだけを描く（main の viewer/popups.ts）
const popup = readPopupSpec(window.location.hash);
if (popup) document.body.classList.add('is-popup');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{popup ? <PopupViewer spec={popup} /> : <App />}</React.StrictMode>
);
