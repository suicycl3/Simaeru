import { useEffect, useState } from 'react';
import { decodeText, parseSubtitles, type Cue } from './format';

/** 字幕ファイルを読んで、開始秒つきの並びにする（文字コードは自動で判定）。読めなければ空 */
export function useSubtitleCues(entry: { url: string; name: string } | null): Cue[] | null {
  const [cues, setCues] = useState<Cue[] | null>(null);
  const url = entry?.url ?? null;
  const name = entry?.name ?? '';
  useEffect(() => {
    if (!url) {
      setCues(null);
      return;
    }
    let cancelled = false;
    setCues(null);
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!cancelled) setCues(parseSubtitles(name, decodeText(buf)));
      })
      .catch(() => {
        if (!cancelled) setCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [url, name]);
  return cues;
}

/**
 * 動画・音声に対応する字幕か。拡張子を除いた名前が同じもの
 * （`01_本編.mp4` と `01_本編.srt`、`01_本編.ja.ass` のような言語つきも含む）。
 */
export function matchesMedia(mediaName: string, subtitleName: string): boolean {
  const base = (n: string): string => n.replace(/\.[^.\\/]+$/, '').toLowerCase();
  const media = base(mediaName);
  const sub = base(subtitleName);
  return sub === media || sub.startsWith(`${media}.`);
}
