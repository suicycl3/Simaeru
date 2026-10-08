/** 件数の移り変わりの書き出し形式（メインの書き出しと、設定画面の選択肢で共有） */
export type ExportFormat = 'mp4' | 'gif' | 'webm' | 'webp';

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; defaultFps: number; defaultWidth: number }> = {
  mp4: { label: 'MP4（H.264）', ext: 'mp4', defaultFps: 30, defaultWidth: 1280 },
  gif: { label: 'GIF', ext: 'gif', defaultFps: 15, defaultWidth: 640 },
  webm: { label: 'WebM（VP9）', ext: 'webm', defaultFps: 30, defaultWidth: 1280 },
  webp: { label: 'アニメーション WebP', ext: 'webp', defaultFps: 15, defaultWidth: 640 }
};

export interface ExportOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
}
