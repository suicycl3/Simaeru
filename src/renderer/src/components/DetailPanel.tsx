import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ContentIndex, PostProcessSettings, Product } from '@shared/types';
import { Cover } from './LibraryGrid';
import LocalFilesSection from './LocalFilesSection';
import InstallSection from './InstallSection';
import CompilationSection from './CompilationSection';
import { formatBytes } from '../lib/format';
import { htmlToText } from '@shared/htmlText';
import { pickVideoQuality, videoQualityOptions } from '@shared/videoQuality';
import VoicePlayer from './viewer/VoicePlayer';
import MediaViewer, { type ViewerMode } from './viewer/MediaViewer';

import { locale, t } from '@shared/i18n';
import { storedLabel } from '../lib/labels';
interface DoujinDetail {
  fileSize: string | null;
  deliveryDate: string | null;
  downloadLinks: Record<string, string>;
  drm: { dmmBooks: boolean; softDenchi: boolean } | null;
  detailLink: string | null;
}

interface DlsoftDownload {
  canDownload: boolean;
  fileType: string | null;
  volume: string | null;
  osList: Record<string, string | null> | null;
  singleFileUrl: string | null;
  combinedFileUrl: string | null;
  splitFileUrlArray: string[];
  requirementToolArray: Array<{ text: string; url: string }>;
}

interface DlsoftDetail {
  orderDate: string | null;
  orderItemNo: string | null;
  download: DlsoftDownload | null;
  browser: { canPlay: boolean; playPageUrl: string | null; description: string | null } | null;
  children: Array<{ productId: string; title: string; download: DlsoftDownload | null }>;
}

interface StoreMeta {
  description: string | null;
  tags: string[];
  creators: Array<{ role: string; name: string; id: string | null }>;
  ok: boolean;
}

interface DlsiteStore {
  description: string | null;
  creators: Array<{ role: string; name: string; id: string | null }>;
  tags: string[];
  fileSizeText: string | null;
  spec: Array<{ label: string; value: string }>;
  releasedAt: string | null;
  seriesName: string | null;
}

interface VideoDetail {
  description: string | null;
  releasedAt: string | null;
  durationMinutes: number | null;
  tags: string[];
  creators: Array<{ role: string; name: string; id: string | null }>;
  content: unknown;
}

type DetailResult =
  | { supported: true; kind: 'doujin'; detail: DoujinDetail; store?: StoreMeta }
  | { supported: true; kind: 'dlsoft'; detail: DlsoftDetail | null; detailError?: string | null; store?: StoreMeta }
  | { supported: true; kind: 'video'; detail: VideoDetail; detailError?: string | null }
  | {
      supported: true;
      kind: 'book';
      detail: unknown;
      detailError?: string | null;
      store?: StoreMeta | null;
    }
  | {
      supported: true;
      kind: 'dlsite';
      serial: { licenseKey: string | null; downloadUrl: string | null } | null;
      store?: DlsiteStore | null;
      detailError?: string | null;
    }
  | { supported: true; kind: 'cached'; floorId: string; detailError?: string | null }
  | { supported: false };

interface Props {
  product: Product;
  onClose: () => void;
  /** タグを押したときに一覧側の絞り込みへ渡す */
  onToggleTag: (tag: string) => void;
  /** いま絞り込みに使われているタグ */
  activeTags: string[];
  /** 人・シリーズを押したときに一覧側の絞り込みへ渡す */
  onToggleCreator: (name: string) => void;
  /** いま絞り込みに使われている人・シリーズ */
  activeCreators: string[];
  /** お気に入りの切り替え */
  onToggleFavorite: () => void;
  /** この作品をダウンロードのキューに入れる */
  onDownload: () => void;
  /** 動画を、選んだ画質でダウンロードのキューに入れる */
  onDownloadVideo: (qualityKey: string) => void;
  /** ダウンロード済みの作品を、もう一度落として手元のファイルと置き換える */
  onRedownload: () => void;
  /** 別の作品の詳細へ移る（総集編の収録作品など） */
  onOpenProduct: (id: number) => void;
}

const DL_BASE = 'https://dlsoft.dmm.co.jp';

/**
 * 詳細を開いたときだけ取りに行くフロア。
 * 'library' は DLsite（説明文・スタッフ・動作環境が作品ページにしか無い）。
 */
const LAZY_DETAIL_FLOORS = ['doujin', 'dlsoft', 'video', 'book', 'library'];

export default function DetailPanel({
  product: listed,
  onClose,
  onToggleTag,
  activeTags,
  onToggleCreator,
  activeCreators,
  onToggleFavorite,
  onDownload,
  onDownloadVideo,
  onRedownload,
  onOpenProduct
}: Props): JSX.Element {
  // 一覧から渡ってくる product は同期時点の値。詳細取得でDBを更新した結果が返るので、
  // 取得後はそちらを表示に使う（そうしないと発売日や説明文が「未取得」のまま見える）。
  const [product, setProduct] = useState<Product>(listed);
  const [result, setResult] = useState<DetailResult | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [neeview, setNeeview] = useState<string | null>(null);
  // 全画面で重ねるプレイヤー・ビューア
  const [player, setPlayer] = useState<ContentIndex | null>(null);
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [viewer, setViewer] = useState<{ mode: ViewerMode; index: ContentIndex; start: number } | null>(null);
  /** ダウンロード済みの作品で「アプリでダウンロード」を押したときの確認 */
  const [redownloadAsk, setRedownloadAsk] = useState(false);
  /** 動画の「アプリでダウンロード」で画質を選んでいる途中なら、選んでいる画質の印 */
  const [videoPick, setVideoPick] = useState<string | null>(null);
  const [videoDefault, setVideoDefault] = useState<string>('best');
  const [post, setPost] = useState<PostProcessSettings | null>(null);
  useEffect(() => {
    setRedownloadAsk(false);
    setVideoPick(null);
  }, [listed.id]);
  useEffect(() => {
    if (redownloadAsk) void window.api.jobs.settings().then((s) => setPost(s.settings));
  }, [redownloadAsk]);

  /**
   * 作品メタの取得。取得済みならメイン側が通信せずDBの値を返す。
   * force を付けたときだけ取り直す。
   */
  const load = useCallback(
    (target: Product, force: boolean): (() => void) => {
      if (!LAZY_DETAIL_FLOORS.includes(target.floorId)) return () => undefined;
      let cancelled = false;
      setLoading(true);
      setDetailError(null);
      window.api.library
        .detail(target.id, force ? { force: true } : undefined)
        .then((res) => {
          if (cancelled) return;
          setResult(res as DetailResult);
          const updated = (res as { product?: Product }).product;
          if (updated) setProduct(updated);
        })
        .catch((err: unknown) => {
          if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.viewer.neeview().then((exe) => {
      if (!cancelled) setNeeview(exe);
    });
    return () => {
      cancelled = true;
    };
  }, [listed.id]);

  useEffect(() => {
    // 別の作品に切り替えたら、前の作品のプレイヤー・ビューアは閉じる
    setPlayer(null);
    setViewer(null);
  }, [listed.id]);

  useEffect(() => {
    setProduct(listed);
    setResult(null);
    setDetailError(null);
    return load(listed, false);
  }, [listed, load]);

  const open = (url: string | null): void => {
    if (url) void window.api.openExternal(url);
  };

  const dlsoft = result?.supported && result.kind === 'dlsoft' ? result.detail : null;
  const doujin = result?.supported && result.kind === 'doujin' ? result.detail : null;
  const video = result?.supported && result.kind === 'video' ? result.detail : null;
  const dlsiteSpec =
    result?.supported && result.kind === 'dlsite' ? (result.store?.spec ?? []) : [];
  const dl = dlsoft?.download ?? null;
  const videoOptions = product.floorId === 'video' ? videoQualityOptions(product.links) : [];
  const parts = dl ? [dl.combinedFileUrl, ...dl.splitFileUrlArray].filter(Boolean) : [];
  const osText = dl?.osList
    ? Object.entries(dl.osList)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' / ')
    : null;

  return (
    <aside className="detail">
      <div className="detail__top">
        <div className="detail__primary" ref={setActionHost} />
        <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>×</button>
      </div>

      <div className="detail__hero">
        <Cover product={product} />
      </div>

      <div className="detail__titleRow">
        <button
          className={`fav fav--lg ${product.favoriteAt ? 'fav--on' : ''}`}
          title={product.favoriteAt ? t('お気に入りから外す') : t('お気に入りに入れる')}
          onClick={onToggleFavorite}
        >
          {product.favoriteAt ? '★' : '☆'}
        </button>
        <h2 className="detail__title">{product.title}</h2>
      </div>

      <dl className="detail__meta">
        <dt>{t('ブランド')}</dt>
        <dd>{product.maker ?? '—'}</dd>
        {product.authors.length > 0 && (
          <>
            <dt>{t('作者')}</dt>
            <dd>{product.authors.join(' / ')}</dd>
          </>
        )}
        <dt>{t('購入日')}</dt>
        <dd>
          {product.purchasedAt ?? '—'}
          {product.purchasedAtSource === 'delivery' && (
            <span className="detail__note">
              {t('※これは作品の配信開始日です。実際の注文日は詳細取得後に入ります。')}
            </span>
          )}
        </dd>
        {product.priceText && (
          <>
            <dt>{t('価格')}</dt>
            <dd>{product.priceText}</dd>
          </>
        )}
        {product.serialKey && (
          <>
            <dt>{t('ライセンスキー')}</dt>
            <dd className="detail__serial">
              <code>{product.serialKey}</code>
              <button
                className="detail__copy"
                onClick={() => {
                  if (product.serialKey) void navigator.clipboard.writeText(product.serialKey);
                }}
              >
                {t('コピー')}
              </button>
            </dd>
          </>
        )}
        {dlsoft?.orderItemNo && (
          <>
            <dt>{t('注文番号')}</dt>
            <dd>{dlsoft.orderItemNo}</dd>
          </>
        )}
        <dt>{t('発売日')}</dt>
        <dd>{product.releasedAt ?? '—'}</dd>
        <dt>{t('種別')}</dt>
        <dd>{product.genre ?? '—'}</dd>
        <dt>{t('作品ID')}</dt>
        <dd>{product.productId}</dd>
        {(doujin?.fileSize ?? product.fileSizeText) && (
          <>
            <dt>{t('サイズ')}</dt>
            <dd>{doujin?.fileSize ?? product.fileSizeText}</dd>
          </>
        )}
        {dl?.fileType && (
          <>
            <dt>{t('形式')}</dt>
            <dd>
              {dl.fileType}
              {parts.length > 1 ? t('（分割 {length} ファイル）', { length: parts.length }) : ''}
            </dd>
          </>
        )}
        {osText && (
          <>
            <dt>{t('対応OS')}</dt>
            <dd>{osText}</dd>
          </>
        )}
        {/* DLsiteのPCゲームは動作環境が作品ページの「作品情報/動作環境」にある */}
        {dlsiteSpec.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>

      {product.creators.length > 0 && (
        <dl className="detail__meta">
          {/* 役割ごとに並べる。名前を押すと、その人・シリーズで一覧を絞り込む */}
          {product.creators.map((c) => (
            <Fragment key={`${c.role}:${c.name}:${c.id ?? ''}`}>
              <dt>{storedLabel(c.role)}</dt>
              <dd>
                <button
                  className={`chip chip--button ${activeCreators.includes(c.name) ? 'chip--active' : ''}`}
                  onClick={() => onToggleCreator(c.name)}
                  title={
                    activeCreators.includes(c.name)
                      ? t('「{name}」の絞り込みを外す', { name: c.name })
                      : t('「{name}」で絞り込む', { name: c.name })
                  }
                >
                  {c.name}
                </button>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}

      {product.description && (
        <div className="detail__section">
          <div className="detail__heading">{t('説明')}</div>
          <p className="detail__description">{htmlToText(product.description)}</p>
        </div>
      )}

      <CompilationSection product={product} onOpenProduct={onOpenProduct} />

      {product.tags.length > 0 && (
        <div className="detail__tags">
          {/* 押すと一覧をそのタグで絞り込む。もう一度押すと外れる */}
          {product.tags.map((tItem) => (
            <button
              key={tItem}
              className={`chip chip--button ${activeTags.includes(tItem) ? 'chip--active' : ''}`}
              onClick={() => onToggleTag(tItem)}
              title={activeTags.includes(tItem) ? t('「{tag}」の絞り込みを外す', { tag: tItem }) : t('「{tag}」で絞り込む', { tag: tItem })}
            >
              {t(tItem)}
            </button>
          ))}
        </div>
      )}

      {/* 電子書籍はシリーズ単位で持っているので、所持している巻をここに出す */}
      {product.volumes && product.volumes.owned.length > 0 && (
        <div className="detail__volumes">
          <div className="detail__heading">
            {t('所持巻 {length}{1}', { length: product.volumes.owned.length, 1: product.volumes.totalCount ? t(' / 全 {totalCount} 巻', { totalCount: product.volumes.totalCount }) : '' })}
          </div>
          <ol className="volumes">
            {product.volumes.owned.map((v) => (
              <li key={v.contentId} className="volume">
                <span className="volume__no">{v.volumeNumber ?? '—'}</span>
                <span className="volume__title" title={v.title}>
                  {v.title}
                </span>
                <span className="volume__actions">
                  {v.streamingUrl && (
                    <button className="btn btn--xs" onClick={() => open(v.streamingUrl)}>
                      {t('読む')}
                    </button>
                  )}
                  {v.downloadUrl && (
                    <button className="btn btn--xs" onClick={() => open(v.downloadUrl)}>
                      DL
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {loading && <div className="muted">{t('詳細を取得中…')}</div>}
      {detailError && <div className="banner banner--error">{detailError}</div>}
      {result?.supported && 'detailError' in result && result.detailError && (
        <p className="muted detail__note">
          {t('ダウンロード情報は取得できませんでした（{0}）。販売終了などで詳細APIが応答しない場合があります。', { 0: result.detailError.slice(0, 240) })}
        </p>
      )}

      {/* 手元にあるファイル。展開・変換・再生・閲覧の入口はここに集める */}
      <LocalFilesSection
        actionHost={actionHost}
        product={product}
        neeview={neeview}
        onOpenPlayer={(index) => {
          void window.api.markViewed(product.id);
          setPlayer(index);
        }}
        onOpenViewer={(mode, index, start = 0) => {
          void window.api.markViewed(product.id);
          setViewer({ mode, index, start });
        }}
      />

      <InstallSection product={product} onChanged={setProduct} />

      {videoPick !== null && (
        <div className="confirm">
          <div>{t('ダウンロードする画質を選んでください')}</div>
          <div className="videoq">
            {videoOptions.map((o) => (
              <label key={o.key} className="videoq__row">
                <input type="radio" name="videoq" checked={videoPick === o.key} onChange={() => setVideoPick(o.key)} />
                <span className="videoq__name">{o.name ?? `${o.key}k`}</span>
                <span className="muted">
                  {o.sizeMb !== null ? formatBytes(o.sizeMb * 1024 * 1024) : t('容量不明')}
                  {o.parts > 1 ? ` · ${t('{n} パート', { n: o.parts })}` : ''}
                  {pickVideoQuality(videoOptions, videoDefault)?.key === o.key ? ` · ${t('既定')}` : ''}
                </span>
              </label>
            ))}
          </div>
          <div className="muted">{t('既定の画質は設定の「ダウンロード」で変えられます。選んだ画質はこの作品で覚えます。')}</div>
          <div className="confirm__row">
            <button
              className="btn btn--xs btn--primary"
              onClick={() => {
                const key = videoPick;
                setVideoPick(null);
                onDownloadVideo(key);
              }}
            >
              {t('この画質でダウンロード')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setVideoPick(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      {redownloadAsk && (
        <div className="confirm">
          <div>{t('ダウンロード済みです。もう一度ダウンロードして、手元のファイルと置き換えますか？')}</div>
          <div className="muted">
            {t('「MP3だけ残す」や FLAC 化で中身を変えたファイルも、配布されたままの形に戻ります（元のファイルはごみ箱へ入れます）。ダウンロードのあとの処理は、いまの設定で行われます。')}
            {post?.lossyOnly && ` ${t('いまは「MP3 版だけ残す」が入になっているので、WAV / FLAC を残したいときは先に設定の「ASMR・ボイス」で切にしてください。')}`}
          </div>
          <div className="confirm__row">
            <button
              className="btn btn--xs btn--primary"
              onClick={() => {
                setRedownloadAsk(false);
                onRedownload();
              }}
            >
              {t('ダウンロードし直す')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setRedownloadAsk(false)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      <div className="detail__actions">
        {/* アプリで落とす。外部ブラウザの導線は逃げ道として下に残す */}
        <button
          className="btn btn--primary"
          onClick={() => {
            if (product.hasLocalFile) return setRedownloadAsk(true);
            // 動画は画質を選んでから積む（画質の一覧が無ければ既定の画質で）
            if (videoOptions.length > 1) {
              void window.api.download.settings().then((s) => {
                setVideoDefault(s.videoQuality);
                setVideoPick(pickVideoQuality(videoOptions, s.videoQuality)?.key ?? videoOptions[0].key);
              });
              return;
            }
            onDownload();
          }}
        >
          {t('アプリでダウンロード')}
        </button>
        {product.detailUrl && (
          <button className="btn btn--primary" onClick={() => open(product.detailUrl)}>
            {t('サイトで開く')}
          </button>
        )}
        {/* 起動・視聴系はリンク種別で優先して並べる */}
        {product.links
          .filter((l) => l.kind === 'play' || l.kind === 'stream')
          .map((l, _i, list) => {
            // DMM 動画の公式プレイヤーは、アプリ内の窓では DRM のエラー（V6007）になるので、外部ブラウザで開く
            const video = product.floorId === 'video' && l.kind === 'stream';
            if (video) {
              const parts = list.filter((x) => !x.codec);
              const label = l.codec === 'h264' || /H\.264/.test(l.label)
                ? t('再生（H.264）')
                : parts.length > 1
                  ? t('再生（パート {n}）', { n: parts.indexOf(l) + 1 })
                  : storedLabel(l.label);
              return (
                <button
                  key={l.url}
                  className="btn"
                  title={
                    l.codec === 'h264'
                      ? t('4K 作品の H.264 版のプレイヤーを外部ブラウザで開きます（4K 画質で再生が安定しないとき用）')
                      : t('公式のプレイヤーを外部ブラウザで開きます（アプリ内の窓では DRM のエラーで再生できません）')
                  }
                  onClick={() => void window.api.browser.open(product.id, l.url, true)}
                >
                  {label} ↗
                </button>
              );
            }
            const label = storedLabel(l.label);
            return (
              <span key={l.url} className="splitBtn">
                <button
                  className="btn splitBtn__main"
                  title={t('ログインしたまま、アプリ内の窓で開きます')}
                  onClick={() => void window.api.browser.open(product.id, l.url)}
                >
                  {label}
                </button>
                <button
                  className="btn splitBtn__caret"
                  title={t('外部ブラウザで開く')}
                  aria-label={t('外部ブラウザで開く')}
                  onClick={() => void window.api.browser.open(product.id, l.url, true)}
                >
                  ↗
                </button>
              </span>
            );
          })}
      </div>


      {product.floorId !== 'video' && product.links.some((l) => l.kind === 'download' || l.kind === 'page') && (
        <div className="detail__section">
          <div className="detail__heading">{t('ダウンロード')}</div>
          <div className="detail__files">
            {product.links
              .filter((l) => l.kind === 'download' || l.kind === 'page')
              .map((l) => (
                <button key={l.url} className="btn btn--sm" onClick={() => open(l.url)}>
                  {storedLabel(l.label)}
                </button>
              ))}
          </div>
          {dl && dl.requirementToolArray.length > 0 && (
            <p className="muted detail__note">
              {t('必要ツール:{0}', { 0: ' ' })}
              {dl.requirementToolArray.map((tItem, i) => (
                <span key={tItem.url}>
                  {i > 0 && ' / '}
                  <button className="link" onClick={() => open(tItem.url)}>
                    {tItem.text}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* 収録作品は CompilationSection に出るので、読み取れた作品では重ねて出さない */}
      {dlsoft && dlsoft.children.length > 0 && !product.isCompilation && (
        <div className="detail__section">
          <div className="detail__heading">{t('収録作品 {length} 本', { length: dlsoft.children.length })}</div>
          <ul className="detail__children">
            {dlsoft.children.map((child) => (
              <li key={child.productId}>
                <span>{child.title}</span>
                <span className="muted">
                  {child.download?.volume ? `${child.download.volume} MB` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 各要素がちゃんと取れているかを目視確認するための欄。
          タグ検索などを作り込む前に、どのフロアで何が取れるかをここで確かめる。 */}
      <details className="detail__section detail__debug">
        <summary className="detail__heading">{t('取得したメタ情報')}</summary>
        <div className="detail__metaHead">
          <span className="muted">
            {product.metaFetchedAt
              ? t('取得済み: {0}', { 0: new Date(product.metaFetchedAt).toLocaleString(locale()) })
              : t('未取得')}
          </span>
          <button className="link" onClick={() => load(product, true)} disabled={loading}>
            {t('再取得')}
          </button>
        </div>
        <dl className="detail__meta">
          {(
            [
              [t('発売日'), product.releasedAt],
              [t('購入日'), t('{0}（{1}）', { 0: product.purchasedAt ?? '—', 1: product.purchasedAtSource ?? t('不明') })],
              [t('説明文'), product.description ? t('{length} 文字', { length: product.description.length }) : null],
              [t('タグ'), product.tags.length ? t('{length} 件', { length: product.tags.length }) : null],
              [t('クリエイター'), product.creators.length ? t('{length} 件', { length: product.creators.length }) : null],
              [t('サイズ'), product.fileSizeText],
              [t('収録時間'), video?.durationMinutes ? t('{durationMinutes} 分', { durationMinutes: video.durationMinutes }) : null],
              [t('作品ID'), product.contentId],
              [t('親セット'), product.parentProductId],
              [
                t('取得方法'),
                result?.supported && result.kind === 'cached' ? t('保存済みを表示（通信なし）') : null
              ],
              [
                t('店舗ページ解析'),
                result?.supported && 'store' in result && result.store
                  ? 'ok' in result.store && !result.store.ok
                    ? t('失敗（HTML構造が変わった可能性）')
                    : t('成功（説明{0} / タグ{length} / スタッフ{length2}）', { 0: result.store.description ? t('有') : t('無'), length: result.store.tags.length, length2: result.store.creators.length })
                  : result?.supported && result.kind === 'dlsite'
                    ? t('作品ページなし（販売終了など）')
                    : null
              ]
            ] as Array<[string, string | null]>
          ).map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd className={value ? '' : 'muted'}>{value ?? t('未取得')}</dd>
            </Fragment>
          ))}
        </dl>
        {result?.supported && result.kind !== 'cached' && (
          <pre className="detail__raw">
            {JSON.stringify('detail' in result ? result.detail : result, null, 1)}
          </pre>
        )}
        {result?.supported && result.kind === 'cached' && (
          <p className="muted">
            {t('保存済みを表示しているため通信していません。生レスポンスを見るには「再取得」を押してください。')}
          </p>
        )}
        {result && !result.supported && (
          <p className="muted">{t('このフロアには詳細取得APIがありません（一覧の情報のみ）。')}</p>
        )}
      </details>

      {player && <VoicePlayer product={product} index={player} onClose={() => setPlayer(null)} />}
      {viewer && (
        <MediaViewer
          product={product}
          mode={viewer.mode}
          entries={
            viewer.mode === 'images'
              ? viewer.index.images
              : viewer.mode === 'video'
                ? viewer.index.videos
                : viewer.index.documents.filter((d) => d.name.toLowerCase().endsWith('.pdf'))
          }
          startIndex={viewer.start}
          onClose={() => setViewer(null)}
        />
      )}
    </aside>
  );
}
