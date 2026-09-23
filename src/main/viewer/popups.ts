import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { APP_NAME } from '@shared/appInfo';

/**
 * ビューアを別のウィンドウ（ポップアップ）で開く。
 *
 * 画面側は同じ index.html を開き、URL の `#popup=` に書いた内容でビューアだけを描く（main.tsx）。
 * 本体のウィンドウとは独立していて、いくつでも同時に開ける（音声を再生しながら台本の PDF を横に並べる、など）。
 * 本体を閉じたら、ポップアップもまとめて閉じる（本体の無いまま残らないように）。
 */

export type PopupKind = 'images' | 'pdf' | 'video' | 'voice' | 'text';
const KINDS: readonly PopupKind[] = ['images', 'pdf', 'video', 'voice', 'text'];

export interface PopupSpec {
  kind: PopupKind;
  /** 作品（products.id） */
  productId: number;
  /** 最初に出すファイル（無ければ先頭） */
  entryUrl?: string | null;
  /** ウィンドウの題名 */
  title?: string | null;
}

const popups = new Set<BrowserWindow>();

/** 画面から来た内容を確かめる（知らない種類・数でない作品IDは受け付けない） */
export function validatePopupSpec(raw: unknown): PopupSpec {
  const spec = raw as Partial<PopupSpec> | null;
  if (!spec || typeof spec !== 'object') throw new Error('invalid popup spec');
  if (!KINDS.includes(spec.kind as PopupKind)) throw new Error(`unknown popup kind: ${String(spec.kind)}`);
  if (!Number.isInteger(spec.productId)) throw new Error('invalid productId');
  return {
    kind: spec.kind as PopupKind,
    productId: spec.productId as number,
    entryUrl: typeof spec.entryUrl === 'string' ? spec.entryUrl : null,
    title: typeof spec.title === 'string' ? spec.title.slice(0, 200) : null
  };
}

export function openViewerPopup(raw: unknown): number {
  const spec = validatePopupSpec(raw);
  const win = new BrowserWindow({
    width: spec.kind === 'voice' ? 1100 : 1000,
    height: spec.kind === 'voice' ? 760 : 820,
    minWidth: 420,
    minHeight: 320,
    show: false,
    backgroundColor: '#1b2838',
    autoHideMenuBar: true,
    title: spec.title ? `${spec.title} - ${APP_NAME}` : APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  popups.add(win);
  win.on('closed', () => popups.delete(win));
  win.once('ready-to-show', () => win.show());
  // 外部リンクは既定のブラウザで開く（本体と同じ）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const hash = `popup=${encodeURIComponent(JSON.stringify(spec))}`;
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }
  return win.id;
}

/** 開いているポップアップの数 */
export function popupCount(): number {
  return popups.size;
}

/** 本体を閉じたときに、ポップアップもまとめて閉じる */
export function closeAllPopups(): void {
  for (const win of [...popups]) {
    if (!win.isDestroyed()) win.close();
  }
}
