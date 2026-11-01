import { useEffect, useRef, useState } from 'react';
import type { ContentEntry } from '@shared/types';
import { thumbnailUrl } from '../../lib/thumbnails';

/**
 * 画像の一覧の 1 枚。画面に近づいてから縮めた画像を用意して出す（原寸の画像は読まない）。
 * 縮められなかったときは元の画像を出す。
 */
export default function ThumbImage({ entry }: { entry: ContentEntry }): JSX.Element {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSrc(null);
    const abort = new AbortController();
    let started = false;
    const observer = new IntersectionObserver(
      (records) => {
        if (started || !records.some((r) => r.isIntersecting)) return;
        started = true;
        observer.disconnect();
        void thumbnailUrl(entry.url, entry.size, abort.signal).then((url) => {
          if (!abort.signal.aborted) setSrc(url);
        });
      },
      { rootMargin: '400px' }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      abort.abort();
    };
  }, [entry.url, entry.size]);
  return <img ref={ref} src={src ?? undefined} alt={src ? entry.name : ''} data-thumb={src ? (src.startsWith('blob:') ? 'small' : 'original') : 'waiting'} />;
}
