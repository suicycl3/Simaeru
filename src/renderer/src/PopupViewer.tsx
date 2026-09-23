import { useEffect, useState } from 'react';
import type { ContentEntry, ContentIndex, Product } from '@shared/types';
import { t } from '@shared/i18n';
import MediaViewer from './components/viewer/MediaViewer';
import VoicePlayer from './components/viewer/VoicePlayer';
import { TextView } from './components/viewer/TextView';

import type { PopupSpec } from './lib/popup';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const isPdf = (e: ContentEntry): boolean => /\.pdf$/i.test(e.name);
const isImage = (e: ContentEntry): boolean => IMAGE_EXT.test(e.name);

/**
 * 種類ごとに、並べるファイルを選ぶ（詳細パネルの開き方と同じ）。
 * 台本フォルダの画像は「台本」の方に入っているので、指定のファイルがそちらにあれば台本の画像を並べる。
 */
function entriesFor(kind: PopupSpec['kind'], index: ContentIndex, entryUrl?: string | null): ContentEntry[] {
  if (kind === 'images') {
    const docImages = index.documents.filter(isImage);
    return entryUrl && docImages.some((d) => d.url === entryUrl) ? docImages : index.images;
  }
  if (kind === 'video') return index.videos;
  if (kind === 'pdf') return index.documents.filter(isPdf);
  if (kind === 'text') return index.documents.filter((d) => !isPdf(d) && !isImage(d));
  return [];
}

/**
 * ポップアップのウィンドウの中身。ビューアだけを描き、閉じたらウィンドウごと閉じる。
 * 作品と中身の一覧は本体と同じ窓口（IPC）から取り直す。
 */
export default function PopupViewer({ spec }: { spec: PopupSpec }): JSX.Element {
  const [product, setProduct] = useState<Product | null>(null);
  const [index, setIndex] = useState<ContentIndex | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.api.library.product(spec.productId), window.api.content.index(spec.productId)])
      .then(([p, idx]) => {
        if (cancelled) return;
        if (!p) throw new Error(t('作品が見つかりません'));
        setProduct(p);
        setIndex(idx);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [spec.productId]);

  useEffect(() => {
    if (spec.title) document.title = spec.title;
  }, [spec.title]);

  const close = (): void => window.close();

  if (error) return <div className="popup__message banner banner--error">{error}</div>;
  if (!product || !index) return <div className="popup__message muted">{t('読み込み中…')}</div>;

  if (spec.kind === 'voice') return <VoicePlayer product={product} index={index} onClose={close} />;

  const entries = entriesFor(spec.kind, index, spec.entryUrl);
  const start = Math.max(0, entries.findIndex((e) => e.url === spec.entryUrl));

  if (spec.kind === 'text') {
    const entry = entries[start];
    if (!entry) return <div className="popup__message muted">{t('ファイルが見つかりませんでした。')}</div>;
    return (
      <div className="viewer popup__text" role="dialog">
        <header className="viewer__head">
          <div className="viewer__title" title={entry.relPath}>
            {t('{title} ・ {1}', { title: product.title, 1: entry.name })}
          </div>
          <button className="detail__close viewer__close" onClick={close} aria-label={t('閉じる')}>
            ×
          </button>
        </header>
        <TextView url={entry.url} name={entry.name} />
      </div>
    );
  }

  return (
    <MediaViewer
      product={product}
      mode={spec.kind}
      entries={entries}
      startIndex={start}
      subtitles={spec.kind === 'video' ? index.subtitles : undefined}
      onClose={close}
    />
  );
}
