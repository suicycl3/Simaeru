import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ContentIndex,
  FlacEstimate,
  FlacOriginal,
  JobRow,
  LocalFile,
  PostProcessSettings,
  Product,
  ToolStatus
} from '@shared/types';
import { extOf } from '@shared/contentRules';
import { archiveWorkType, pdfStripType } from '@shared/storagePolicy';
import { formatBytes } from '../lib/format';
import type { ViewerMode } from './viewer/MediaViewer';
import { JOB_LABELS } from '../lib/labels';
import { t } from '@shared/i18n';

interface Props {
  actionHost?: HTMLElement | null;
  product: Product;
  neeview: string | null;
  /** プレイヤー・ビューアを開く（全画面の重ね表示は親が持つ） */
  onOpenPlayer: (index: ContentIndex) => void;
  onOpenViewer: (mode: ViewerMode, index: ContentIndex, start?: number) => void;
}

const ARCHIVE = /\.(zip|7z|rar|lzh|lha|tar|cab)$|\.part0*1\.(exe|rar)$|\.(7z|zip)\.0*1$/i;
/** DMM の DRM 付きファイル（電子書籍・動画） */
const DRM = /\.(dmmb|dmme|dcv|wsdcf|dmmmp4)$/i;
/** DMM Player で開く動画 */
const DMM_PLAYER_FILE = /\.(dcv|dmmmp4)$/i;
const SECONDARY_PART = /\.part0*([2-9]|\d{2,})\.(exe|rar)$|\.(7z|zip)\.0*([2-9]|\d{2,})$/i;

const ORIGINAL_LABELS: Record<FlacOriginal, string> = {
  trash: t('変換前のファイルはごみ箱へ'),
  delete: t('変換前のファイルを削除'),
  keep: t('変換前のファイルも残す')
};

/** アーカイブを作り直すときの、元のアーカイブの扱い */
const ARCHIVE_ORIGINAL_LABELS: Record<FlacOriginal, string> = {
  trash: t('元のアーカイブはごみ箱へ'),
  delete: t('元のアーカイブを削除'),
  keep: t('元のアーカイブも残す')
};

/**
 * 作品詳細の「手元のファイル」。展開・FLAC変換・再生・閲覧の入口をここに集める。
 */
export default function LocalFilesSection({ product, neeview, onOpenPlayer, onOpenViewer, actionHost }: Props): JSX.Element | null {
  /** DMM Player が入っているか（動画の DRM 付きファイルがあるときだけ調べる。未確認は null） */
  const [dmmPlayer, setDmmPlayer] = useState<boolean | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const hasDmmVideo = files.some((f) => !f.missingAt && DMM_PLAYER_FILE.test(f.path));
  useEffect(() => {
    if (!hasDmmVideo) return;
    let cancelled = false;
    void window.api.install.dmmPlayerStatus().then((s) => {
      if (!cancelled) setDmmPlayer(s.installed);
    });
    return () => {
      cancelled = true;
    };
  }, [hasDmmVideo]);
  const [index, setIndex] = useState<ContentIndex | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [post, setPost] = useState<PostProcessSettings | null>(null);
  const [flacAsk, setFlacAsk] = useState<{ target: string; estimate: FlacEstimate; original: FlacOriginal } | null>(null);
  /** MP3 だけ残す前の確認 */
  const [lossyAsk, setLossyAsk] = useState<{ target: string; count: number; bytes: number; kept: number; inArchive: boolean; original: FlacOriginal } | null>(null);
  /** 画像と同じ内容の PDF を消す前の確認 */
  const [pdfAsk, setPdfAsk] = useState<{ target: string; count: number; bytes: number; names: string[]; inArchive: boolean; original: FlacOriginal } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** ごみ箱へ入れる前の確認。paths が null ならこの作品のファイルをすべて */
  const [trashAsk, setTrashAsk] = useState<{ paths: string[] | null; label: string; count: number; bytes: number } | null>(null);
  const [trashing, setTrashing] = useState(false);

  // いま表示している作品。切り替えたあとに、前の作品の読み込み結果で上書きしないための目印
  const current = useRef(product.id);

  // 作品を切り替えたら、前の作品の中身をすぐ消す（読み込みが終わるまで前の作品が見えていた）
  useEffect(() => {
    current.current = product.id;
    setFiles([]);
    setIndex(null);
    setJobs([]);
    setFlacAsk(null);
    setLossyAsk(null);
    setPdfAsk(null);
    setTrashAsk(null);
    setMessage(null);
  }, [product.id]);

  const reload = useCallback(async () => {
    const id = product.id;
    const res = await window.api.files(id);
    if (current.current !== id) return;
    setFiles(res.files);
    const rows = await window.api.jobs.forProduct(id);
    if (current.current !== id) return;
    setJobs(rows);
    if (res.files.length > 0) {
      setIndexing(true);
      try {
        // 作り置きをすぐ返す（台帳が変わっていれば裏で作り直され、content:updated で知らされる）
        const idx = await window.api.content.index(id);
        if (current.current === id) setIndex(idx);
      } finally {
        if (current.current === id) setIndexing(false);
      }
    } else {
      setIndex(null);
    }
  }, [product.id]);

  useEffect(() => {
    void reload();
    // ファイルの有無だけは開いたときに確かめる（開かずに見るので速い。変わっていれば作り直しの知らせが来る）
    void window.api.content.verify(product.id);
    void window.api.jobs.settings().then((s) => {
      setTools(s.tools);
      setPost(s.settings);
    });
  }, [reload, product.id]);

  // 展開やダウンロードで手元のファイルが変わったら読み直す
  useEffect(() => {
    const off = window.api.on.filesChanged((p) => {
      if (p.productRef === product.id || p.productRef === null) void reload();
    });
    const offContent = window.api.on.contentUpdated((p) => {
      if (p.productRef === product.id) void reload();
    });
    const offJobs = window.api.on.jobsProgress((rows) => {
      const mine = rows.filter((r) => r.productRef === product.id);
      setJobs(mine);
    });
    return () => {
      off();
      offContent();
      offJobs();
    };
  }, [product.id, reload]);

  if (files.length === 0) return null;

  const extractedSources = new Set(files.filter((f) => f.derivedFrom && !f.missingAt).map((f) => f.derivedFrom!));
  const activeJob = (source: string): JobRow | undefined =>
    jobs.find((j) => j.source === source && (j.state === 'running' || j.state === 'queued'));
  const folders = files.filter((f) => f.kind === 'folder' && !f.missingAt);

  const audioCount = index?.audioGroups.reduce((n, g) => n + g.tracks.length, 0) ?? 0;
  const pdfs = index?.documents.filter((d) => extOf(d.name) === '.pdf') ?? [];

  const present = files.filter((f) => !f.missingAt);
  const busy = jobs.some((j) => j.state === 'running' || j.state === 'queued');
  /** インストール先として紐付けているフォルダが、消す対象に含まれるか */
  const touchesInstall = (paths: string[] | null): boolean => {
    const target = product.installation?.installPath?.toLowerCase();
    if (!target) return false;
    return (paths ?? present.map((f) => f.path)).some((p) => {
      const base = p.toLowerCase().replace(/\\+$/, '');
      return target === base || target.startsWith(`${base}\\`);
    });
  };
  const trash = async (paths: string[] | null): Promise<void> => {
    setTrashing(true);
    try {
      const res = await window.api.trashFiles(product.id, paths ?? undefined);
      setMessage(
        res.failed.length > 0
          ? t('{count} 件を削除できませんでした（使用中の可能性があります）: {0}', { count: res.failed.length, 0: res.failed.map((f) => f.path.split('\\').pop()).join('、') })
          : t('ごみ箱へ入れました（{0}）', { 0: formatBytes(res.bytes) })
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
    } finally {
      setTrashing(false);
      setTrashAsk(null);
      void reload();
    }
  };

  const askFlac = async (target: string): Promise<void> => {
    const [estimate, s] = await Promise.all([
      window.api.jobs.flacEstimate(product.id, target),
      window.api.jobs.settings()
    ]);
    if (estimate.files === 0) {
      setMessage(t('WAV ファイルが見つかりませんでした。'));
      return;
    }
    setFlacAsk({ target, estimate, original: s.settings.flacOriginal });
  };

  return (
    <div className="detail__files">
      <div className="detail__headingRow">
        <div className="detail__heading">{t('手元のファイル')}</div>
        {present.length > 0 && (
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy || trashing}
            title={busy ? t('展開・変換の処理中は削除できません') : t('この作品の手元のファイルをすべてごみ箱へ入れます')}
            onClick={() =>
              setTrashAsk({
                paths: null,
                label: t('この作品の手元のファイル {count} 件', { count: present.length }),
                count: present.length,
                bytes: present.reduce((n, f) => n + (f.sizeBytes ?? 0), 0)
              })
            }
          >
            {t('すべて削除')}
          </button>
        )}
      </div>

      {trashAsk && (
        <div className="confirm confirm--danger">
          <div>
            {t('{label}（{0}）をごみ箱へ入れます。', { label: trashAsk.label, 0: formatBytes(trashAsk.bytes) })}
          </div>
          <div className="muted">
            {[
              touchesInstall(trashAsk.paths) && t('インストール先として紐付けているフォルダも消えるため、紐付けを外します。'),
              (trashAsk.paths === null || trashAsk.count >= present.length) && t('あとで「アプリでダウンロード」から、もう一度ダウンロードできます。')
            ]
              .filter(Boolean)
              .join(' ')}
          </div>
          <div className="confirm__row">
            <button className="btn btn--danger btn--xs" disabled={trashing} onClick={() => void trash(trashAsk.paths)}>
              {trashing ? t('削除しています…') : t('ごみ箱へ入れる')}
            </button>
            <button className="btn btn--xs btn--ghost" disabled={trashing} onClick={() => setTrashAsk(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      {/* 中身に応じた入口 */}
      {index && actionHost && (audioCount > 0 || index.images.length > 0 || pdfs.length > 0 || index.videos.length > 0 || index.books.length > 0) && createPortal(
        <div className="openers">
          {audioCount > 0 && (
            <button
              className="btn btn--primary btn--sm"
              onClick={() => onOpenPlayer(index)}
              title={
                index.audioOnlyInArchive
                  ? t('アーカイブから直接再生します（圧縮されたファイルは初回だけ書き出しに少し時間がかかります）')
                  : t('台本を見ながら再生します')
              }
            >
              {t('▶ 再生（{length} グループ・{audioCount} 曲）', { length: index.audioGroups.length, audioCount })}
            </button>
          )}
          {index.images.length > 0 && (
            <button className="btn btn--sm" onClick={() => onOpenViewer('images', index)}>
              {t('画像を見る（{length}）', { length: index.images.length })}
            </button>
          )}
          {pdfs.length > 0 && (
            <button className="btn btn--sm" onClick={() => onOpenViewer('pdf', index)}>
              {t('PDF（{length}）', { length: pdfs.length })}
            </button>
          )}
          {/* EPUB などは内蔵では開かず、既定のアプリ（電子書籍リーダー）に渡す */}
          {index.books
            .filter((b) => !b.inArchive)
            .slice(0, 3)
            .map((b) => (
              <button
                key={b.url}
                className="btn btn--sm"
                title={b.relPath}
                onClick={() => {
                  void window.api.markViewed(product.id);
                  void window.api.openPath(`${b.container}\\${b.relPath.replace(/\//g, '\\')}`);
                }}
              >
                {t('{name} を開く', { name: b.name })}
              </button>
            ))}
          {index.videos.length > 0 && (
            <button className="btn btn--sm" onClick={() => onOpenViewer('video', index)}>
              {t('動画（{length}）', { length: index.videos.length })}
            </button>
          )}
        </div>, actionHost
      )}
      {indexing && !index && <div className="muted">{t('中身を確認しています…（新しく落としたファイルは、初回だけ Windows の検査で時間がかかることがあります）')}</div>}
      {files.some((f) => !f.missingAt && DRM.test(f.path)) && (
        <p className="muted detail__note">
          {t('DRM 付きのファイルです。アプリでは復号せず保管だけ行います。「開く」で公式ビューア（DMMブックス / DMM プレイヤー）に渡します。')}
          {files.some((f) => !f.missingAt && DMM_PLAYER_FILE.test(f.path)) && dmmPlayer === false &&
            ` ${t('DMM Player が入っていないので、動画は開けません。DMM の公式サイトから DMM Player を入れてください。')}`}
        </p>
      )}
      {index?.storage && (
        <p className="muted detail__note">
          {index.storage.mode === 'extract'
            ? t('この作品は展開して使います{0}。', { 0: post?.deleteArchiveAfterExtract ? t('（展開が済んだらアーカイブは削除）') : '' })
            : extractedSources.size > 0
              ? t('展開したフォルダで閲覧・再生します。')
              : t('この作品は圧縮したまま保管し、展開せずに閲覧・再生します。')}
        </p>
      )}
      {index?.sources.filter((s) => s.error).map((s) => (
        <p key={s.path} className="muted detail__note">
          {s.error}
        </p>
      ))}
      {index && index.wavCount > 0 && tools?.ffmpeg && (
        <p className="muted detail__note">
          {t('WAV {wavCount} 件（{1}）が含まれています。FLAC にすると約半分になります。', { wavCount: index.wavCount, 1: formatBytes(index.wavBytes) })}
        </p>
      )}

      {files.map((f) => {
        const name = f.path.split('\\').pop() ?? f.path;
        // 解凍するだけの exe（自己解凍書庫）は、台帳で kind='sfx' と印が付いている
        const isArchive = !f.missingAt && (ARCHIVE.test(name) || f.kind === 'sfx') && !SECONDARY_PART.test(name);
        const isFolder = f.kind === 'folder';
        const summary = index?.archives.find((a) => a.path === f.path);
        const extractMode = index?.storage?.mode === 'extract';
        // 圧縮のまま持つ作品で、元のアーカイブが残っている展開フォルダは要らない
        const redundantFolder =
          isFolder && !!f.derivedFrom && !extractMode && files.some((x) => x.path === f.derivedFrom && !x.missingAt);
        const job = activeJob(f.path);
        const extracted = extractedSources.has(f.path);
        const lossy = index?.lossyOnly.find((l) => l.container === f.path);
        // PDF を消せるのは同人の CG・マンガだけ
        const pdf = pdfStripType(product) ? index?.pdfStrip?.find((l) => l.container === f.path) : undefined;
        return (
          <div className={`file ${f.missingAt ? 'file--missing' : ''}`} key={f.id}>
            <span className="file__name" title={f.path}>
              {isFolder ? '📁 ' : ''}
              {name}
              {extracted && <span className="tag tag--ok">{t('展開済み')}</span>}
              {f.derivedFrom && <span className="tag">{t('展開')}</span>}
            </span>
            <span className="file__size">{f.missingAt ? t('見つかりません') : formatBytes(f.sizeBytes)}</span>
            {f.missingAt && (
              <span className="file__actions">
                <button
                  className="btn btn--xs btn--ghost"
                  title={t('台帳から外します（ファイルは消しません）')}
                  onClick={() => void window.api.removeFile(product.id, f.path).then(reload)}
                >
                  {t('一覧から外す')}
                </button>
              </span>
            )}
            {!f.missingAt && (
              <span className="file__actions">
                {isArchive && !extracted && !job && extractMode && (
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={!tools?.sevenZip}
                    title={
                      tools?.sevenZip
                        ? t('同じフォルダに展開します{0}', { 0: post?.deleteArchiveAfterExtract ? t('。済んだらアーカイブを削除します') : '' })
                        : t('7-Zip が見つかりません（設定画面の「ツール」から入れられます）')
                    }
                    onClick={() => void window.api.jobs.extract(product.id, f.path).then(reload)}
                  >
                    {t('展開する')}
                  </button>
                )}
                {isArchive && !job && summary && summary.wavCount > 0 && tools?.ffmpeg && tools?.sevenZip && (
                  <button
                    className="btn btn--xs"
                    title={t('中の WAV を FLAC に差し替えて、zip を作り直します')}
                    onClick={() => void askFlac(f.path)}
                  >
                    {t('FLAC化（zipを作り直す）')}
                  </button>
                )}
                {!job && lossy && (isArchive ? !!tools?.sevenZip : true) && (
                  <button
                    className="btn btn--xs"
                    title={t('MP3 などが同梱されている WAV / FLAC {count} 件（{1}）を消して軽くします', { count: lossy.count, 1: formatBytes(lossy.bytes) })}
                    onClick={() =>
                      setLossyAsk({ target: f.path, count: lossy.count, bytes: lossy.bytes, kept: lossy.kept, inArchive: lossy.inArchive, original: post?.flacOriginal ?? 'trash' })
                    }
                  >
                    {t('MP3だけ残す')}
                  </button>
                )}
                {!job && pdf && (isArchive ? !!tools?.sevenZip : true) && (
                  <button
                    className="btn btn--xs"
                    title={t('画像と同じ内容の PDF {count} 件（{1}）を消して軽くします', { count: pdf.count, 1: formatBytes(pdf.bytes) })}
                    onClick={() =>
                      setPdfAsk({ target: f.path, count: pdf.count, bytes: pdf.bytes, names: pdf.names, inArchive: pdf.inArchive, original: post?.flacOriginal ?? 'trash' })
                    }
                  >
                    {t('PDFを消す')}
                  </button>
                )}
                {isArchive && !extracted && !job && !extractMode && index?.storage && (
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={!tools?.sevenZip}
                    title={
                      tools?.sevenZip
                        ? t('同じフォルダに展開し、展開したフォルダで閲覧・再生します{0}', { 0: post?.archiveHandling[archiveWorkType(product)] === 'extractDelete' ? t('。済んだら zip を削除します') : t('（zip は残します）') })
                        : t('7-Zip が見つかりません（設定画面の「ツール」から入れられます）')
                    }
                    onClick={() => void window.api.jobs.extract(product.id, f.path, true).then(reload)}
                  >
                    {t('展開して使う')}
                  </button>
                )}
                {isFolder && !job && tools?.ffmpeg && index && index.wavCount > 0 && (
                  <button className="btn btn--xs" onClick={() => void askFlac(f.path)}>
                    {t('FLAC化')}
                  </button>
                )}
                {redundantFolder && !job && (
                  <button
                    className="btn btn--xs btn--ghost"
                    title={t('圧縮したままでも閲覧できる作品です。展開したフォルダが要らなければ、ごみ箱へ入れて zip で閲覧します')}
                    onClick={() =>
                      void window.api.jobs
                        .removeExtracted(product.id, f.path)
                        .then(reload)
                        .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)))
                    }
                  >
                    {t('展開フォルダを削除')}
                  </button>
                )}
                {DMM_PLAYER_FILE.test(f.path) ? (
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={dmmPlayer === false}
                    title={dmmPlayer === false ? t('DMM Player が入っていません。DMM の公式サイトから DMM Player を入れてください。') : t('DMM Player で開きます')}
                    onClick={() =>
                      void window.api.viewer
                        .openDmmPlayer(product.id, f.path)
                        .catch((err: unknown) => setMessage(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)))
                    }
                  >
                    {t('DMM Player で開く')}
                  </button>
                ) : (
                  <button
                    className="btn btn--xs"
                    title={neeview && !DRM.test(f.path) ? t('NeeView で開く') : t('既定のアプリで開く')}
                    onClick={() => {
                      void window.api.markViewed(product.id);
                      void window.api.viewer.open(f.path, neeview && !DRM.test(f.path) ? 'neeview' : 'default');
                    }}
                  >
                    {neeview && !DRM.test(f.path) ? 'NeeView' : t('開く')}
                  </button>
                )}
                <button className="btn btn--xs btn--ghost" onClick={() => void window.api.showInFolder(f.path)}>
                  {t('場所')}
                </button>
                {!job && (
                  <button
                    className="btn btn--xs btn--ghost file__trash"
                    disabled={trashing}
                    title={t('ごみ箱へ入れて、一覧から外します')}
                    onClick={() => setTrashAsk({ paths: [f.path], label: name, count: 1, bytes: f.sizeBytes ?? 0 })}
                  >
                    {t('削除')}
                  </button>
                )}
              </span>
            )}
            {job && (
              <div className="file__job">
                <div className="bar">
                  <i className="bar__fill bar__fill--running" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
                <span className="muted">
                  {JOB_LABELS[job.kind]} {Math.round(job.progress * 100)}% {job.message ?? ''}
                </span>
                <button className="btn btn--xs btn--ghost" onClick={() => void window.api.jobs.cancel(job.id)}>
                  {t('中止')}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {jobs
        // 同じ対象をあとでやり直して済んでいるなら、古い失敗は出さない
        .filter((j) => !(j.state === 'error' && jobs.some((k) => k.id > j.id && k.kind === j.kind && k.source === j.source)))
        .filter((j) => j.state === 'error' || (j.state === 'done' && Date.now() - j.updatedAt < 10 * 60 * 1000))
        .slice(0, 3)
        .map((j) => (
          <p key={j.id} className={`detail__note ${j.state === 'error' ? 'dlrow__error' : 'muted'}`}>
            {JOB_LABELS[j.kind]}: {j.state === 'error' ? j.error : j.message}
            {j.state === 'error' && (
              <button className="link" onClick={() => void window.api.jobs.retry(j.id)}>
                {t('やり直す')}
              </button>
            )}
          </p>
        ))}

      {message && <p className="muted detail__note">{message}</p>}

      {lossyAsk && (
        <div className="confirm">
          <div>
            {t('MP3 などが同梱されている WAV / FLAC {count} 件・', { count: lossyAsk.count })}<b>{formatBytes(lossyAsk.bytes)}</b> {t('を消して、MP3 などだけを残します。')}
          </div>
          <div className="muted">
            {t('同じ版（SEあり・なしなど）の同じトラックに MP3 などがあるものだけを消します。{0}{1}', { 0: lossyAsk.kept > 0 && t(' 組になる MP3 などが見つからない {kept} 件は残します。', { kept: lossyAsk.kept }), 1: lossyAsk.inArchive && t(' アーカイブは作業フォルダで作り直し、検査が済んでから入れ替えます。') })}
          </div>
          <div className="confirm__row">
            <select
              className="select select--xs"
              value={lossyAsk.original}
              onChange={(e) => setLossyAsk({ ...lossyAsk, original: e.target.value as FlacOriginal })}
            >
              {(Object.keys(ORIGINAL_LABELS) as FlacOriginal[])
                .filter((k) => lossyAsk.inArchive || k !== 'keep')
                .map((k) => (
                  <option key={k} value={k}>
                    {lossyAsk.inArchive ? ARCHIVE_ORIGINAL_LABELS[k] : ORIGINAL_LABELS[k]}
                  </option>
                ))}
            </select>
            <button
              className="btn btn--primary btn--xs"
              onClick={() => {
                void window.api.jobs.lossyOnly(product.id, lossyAsk.target, lossyAsk.original).then(reload);
                setLossyAsk(null);
              }}
            >
              {t('消して軽くする')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setLossyAsk(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      {pdfAsk && (
        <div className="confirm">
          <div>
            {t('画像と同じ内容の PDF {count} 件・', { count: pdfAsk.count })}<b>{formatBytes(pdfAsk.bytes)}</b> {t('を消して、画像だけを残します。')}
          </div>
          <ul className="confirm__list muted">
            {pdfAsk.names.slice(0, 6).map((n) => (
              <li key={n} title={n}>
                {n}
              </li>
            ))}
            {pdfAsk.names.length > 6 && <li>{t('ほか {length} 件', { length: pdfAsk.names.length - 6 })}</li>}
          </ul>
          <div className="muted">
            {t('消す PDF の名前を確かめてください。{0}', { 0: pdfAsk.inArchive && t('アーカイブは作業フォルダで作り直し、検査が済んでから入れ替えます。') })}
          </div>
          <div className="confirm__row">
            <select
              className="select select--xs"
              value={pdfAsk.original}
              onChange={(e) => setPdfAsk({ ...pdfAsk, original: e.target.value as FlacOriginal })}
            >
              {(Object.keys(ORIGINAL_LABELS) as FlacOriginal[])
                .filter((k) => pdfAsk.inArchive || k !== 'keep')
                .map((k) => (
                  <option key={k} value={k}>
                    {pdfAsk.inArchive ? ARCHIVE_ORIGINAL_LABELS[k] : ORIGINAL_LABELS[k]}
                  </option>
                ))}
            </select>
            <button
              className="btn btn--primary btn--xs"
              onClick={() => {
                void window.api.jobs.stripPdf(product.id, pdfAsk.target, pdfAsk.original).then(reload);
                setPdfAsk(null);
              }}
            >
              {t('消して軽くする')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setPdfAsk(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      {flacAsk && (
        <div className="confirm">
          <div>
            {t('WAV {files} 件・{1} を FLAC にします。', { files: flacAsk.estimate.files, 1: formatBytes(flacAsk.estimate.bytes) })}
            <br />
            {t('変換後はおよそ')} <b>{formatBytes(flacAsk.estimate.estimatedBytes)}</b>{t('（約{0}% 削減）の見込みです。', { 0: Math.round((1 - flacAsk.estimate.estimatedBytes / flacAsk.estimate.bytes) * 100) })}
          </div>
          <div className="muted">
            {t('変換結果が元と同じ音か（サンプル数と音声データのハッシュ）を確かめてから元を処理します。{0}', { 0: /\.(zip|7z|rar|lzh|exe)$/i.test(flacAsk.target) &&
              t(' アーカイブは作業フォルダで作り直し、検査が済んでから入れ替えます。') })}
          </div>
          <div className="confirm__row">
            <select
              className="select select--xs"
              value={flacAsk.original}
              onChange={(e) => setFlacAsk({ ...flacAsk, original: e.target.value as FlacOriginal })}
            >
              {(Object.keys(ORIGINAL_LABELS) as FlacOriginal[]).map((k) => (
                <option key={k} value={k}>
                  {ORIGINAL_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              className="btn btn--primary btn--xs"
              onClick={() => {
                void window.api.jobs.flac(product.id, flacAsk.target, flacAsk.original).then(reload);
                setFlacAsk(null);
              }}
            >
              {t('変換する')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setFlacAsk(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
