import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './styles-media.css';

// ブラウザ単体で開いたときだけ、UI確認用のダミーAPIを入れる（Electron上では何もしない）
if (import.meta.env.DEV) {
  const { installDevMock } = await import('./devMock');
  installDevMock();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
