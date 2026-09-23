import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioGroup, ContentEntry, ContentIndex, Product } from '@shared/types';
import { extOf, PLAYABLE_AUDIO, trackKey } from '@shared/contentRules';
import { activeCueText, formatTime } from '../../lib/format';
import { useSubtitleCues } from '../../lib/useSubtitles';
import PdfView, { type PdfPosition } from './PdfView';
import { SubtitleView, TextView } from './TextView';
import { coverSrc } from '../LibraryGrid';
import { t } from '@shared/i18n';
import { MAX_VOLUME, useAudioChain, useAudioPrefs } from '../../lib/audioPrefs';
import AudioPrefsFields from './AudioPrefsFields';
import { IN_POPUP } from '../../lib/popup';

interface Props {
  product: Product;
  index: ContentIndex;
  onClose: () => void;
}

type Repeat = 'off' | 'group' | 'one';

/**
 * ボイス・ASMR作品のプレイヤー（DESIGN-download.md §6-5）。
 *
 * - **プレイリストはフォルダ単位**。SEあり/なし・特典を1本に混ぜない。次の曲へ進むのは同じグループの中だけ。
 * - 同じトラックの別版（SEなし等）は「版」として切り替えられ、再生位置を引き継ぐ。
 * - 右側に台本（PDF / テキスト / 台本フォルダの画像）と字幕（lrc / srt / vtt）を並べる。
 * - 聴いた位置は作品ごとに保存し、次に開いたときに続きから。
 */
export default function VoicePlayer({ product, index, onClose }: Props): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const groups = index.audioGroups;
  const [groupIdx, setGroupIdx] = useState(0);
  const [trackIdx, setTrackIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // 音量・ボイス強調などの調整（Web Audio の経路で効かせる。100% を超えて上げられる）
  const [audioPrefs, setAudioPrefs] = useAudioPrefs();
  const tuned = useAudioChain(audioRef, audioPrefs);
  const maxVolume = tuned ? MAX_VOLUME : 1;
  const [soundOpen, setSoundOpen] = useState(false);
  const soundRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!soundOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (soundRef.current && !soundRef.current.contains(e.target as Node)) setSoundOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [soundOpen]);
  const [rate, setRate] = useState(1);
  const [repeat, setRepeat] = useState<Repeat>('group');
  const [docKey, setDocKey] = useState<string | null>(null);
  /** 台本の PDF の読んでいた位置。タブを切り替えて戻ってきたときに戻す（開いている間だけ。保存はしない） */
  const pdfPositions = useRef(new Map<string, PdfPosition>());
  const [error, setError] = useState<string | null>(null);
  /** 読み込みに時間がかかっている（新しいファイルは初回だけ Windows の検査を待つことがある） */
  const [slowLoad, setSlowLoad] = useState(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const pendingSeek = useRef<number | null>(null);
  /** 読み込みに失敗した曲を1回だけ読み直したか（初回の一時ファイル作成と重なって失敗することがあるため） */
  const retried = useRef<string | null>(null);
  const autoplay = useRef(false);

  const group: AudioGroup | undefined = groups[groupIdx];
  const track: ContentEntry | undefined = group?.tracks[trackIdx];

  // ── 前回の続き ──
  useEffect(() => {
    let cancelled = false;
    void window.api.content.getState(product.id).then((state) => {
      if (cancelled || !state?.trackUrl) return;
      for (const [gi, g] of groups.entries()) {
        const ti = g.tracks.findIndex((tItem) => tItem.url === state.trackUrl);
        if (ti >= 0) {
          setGroupIdx(gi);
          setTrackIdx(ti);
          pendingSeek.current = state.time ?? 0;
          return;
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [product.id, groups]);

  const saveState = useCallback(() => {
    const a = audioRef.current;
    if (!track || !a) return;
    void window.api.content.setState(product.id, {
      trackUrl: track.url,
      time: a.currentTime,
      groupFolder: group?.folder,
      updatedAt: Date.now()
    });
  }, [product.id, track, group]);

  useEffect(() => {
    const tItem = setInterval(saveState, 5000);
    return () => {
      clearInterval(tItem);
      saveState();
    };
  }, [saveState]);

  // ── 同じトラックの別版（ほかのグループにある同名トラック） ──
  const versions = useMemo(() => {
    if (!track) return [];
    const key = trackKey(track.name);
    const out: Array<{ gi: number; ti: number; label: string }> = [];
    groups.forEach((g, gi) => {
      const ti = g.tracks.findIndex((tItem) => trackKey(tItem.name) === key);
      if (ti >= 0) {
        out.push({ gi, ti, label: g.tags.length > 0 ? g.tags.map((tag) => t(tag)).join(t('・')) : t(g.label) });
      }
    });
    return out.length > 1 ? out : [];
  }, [groups, track]);

  // ── 台本と字幕 ──
  const docs = useMemo(() => {
    const list: Array<{ key: string; label: string; entry: ContentEntry; kind: 'pdf' | 'text' | 'image' | 'subtitle' }> = [];
    // 今のトラックと同じ名前の字幕を先頭に
    if (track) {
      const key = trackKey(track.name);
      for (const s of index.subtitles) {
        if (trackKey(s.name) === key) list.push({ key: s.url, label: t('字幕: {name}', { name: s.name }), entry: s, kind: 'subtitle' });
      }
    }
    for (const d of index.documents) {
      const ext = extOf(d.name);
      const kind = ext === '.pdf' ? 'pdf' : ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(ext) ? 'image' : 'text';
      list.push({ key: d.url, label: d.relPath, entry: d, kind });
    }
    return list;
  }, [index, track]);

  // この曲でユーザーがタブを選んだか。曲が変わったら解除して、その曲の字幕を優先する
  const manualDoc = useRef(false);
  useEffect(() => {
    manualDoc.current = false;
  }, [track?.url]);

  useEffect(() => {
    const subtitle = docs.find((d) => d.kind === 'subtitle');
    if (!manualDoc.current && subtitle) {
      if (docKey !== subtitle.key) setDocKey(subtitle.key);
      return;
    }
    if (docKey && docs.some((d) => d.key === docKey)) return;
    setDocKey(docs[0]?.key ?? null);
  }, [docs, docKey]);

  const doc = docs.find((d) => d.key === docKey) ?? null;

  // ── 字幕の重ね表示。台本（PDF など）を見ている間も、今のトラックの字幕を下に出す ──
  const trackSubtitle = docs.find((d) => d.kind === 'subtitle') ?? null;
  const cues = useSubtitleCues(trackSubtitle?.entry ?? null);
  const [captionOn, setCaptionOn] = useState(true);
  const caption = captionOn && cues ? activeCueText(cues, time) : '';
  // 字幕の一覧を開いているときは、一覧の方で今の行が光るので重ねない
  const showCaption = !!trackSubtitle && captionOn && doc?.key !== trackSubtitle.key;

  // ── 画像（イラスト・ジャケット・特典画像など）。台本の画像は台本のタブに出ているので除く ──
  const images = useMemo(() => {
    const inDocs = new Set(index.documents.map((d) => d.url));
    return index.images.filter((i) => !inDocs.has(i.url));
  }, [index]);
  /** 右側で画像の一覧を出しているか（null: 台本・字幕を出す） */
  const [gallery, setGallery] = useState<'grid' | number | null>(null);
  // 台本も字幕も無ければ、画像を最初から出す
  useEffect(() => {
    if (docs.length === 0 && images.length > 0) setGallery((g) => g ?? 'grid');
  }, [docs.length, images.length]);

  /**
   * サムネイル。ジャケット・表紙らしい名前の画像があればそれ、無ければ作品の表紙。
   */
  const primaryArt = useMemo(() => {
    const named = images.find((i) => /(jacket|cover|thumb|サムネ|ジャケ|表紙|パッケージ)/i.test(i.name));
    return named?.url ?? coverSrc(product) ?? images[0]?.url ?? null;
  }, [images, product]);
  // 表紙のキャッシュが読めなかったときは、元の URL → 作品の中の最初の画像の順に切り替える
  const [artFailed, setArtFailed] = useState<string[]>([]);
  useEffect(() => setArtFailed([]), [primaryArt]);
  const artwork =
    [primaryArt, product.coverUrl, images[0]?.url].find((u): u is string => !!u && !artFailed.includes(u)) ?? null;
  const onArtError = (): void => {
    if (artwork) setArtFailed((prev) => (prev.includes(artwork) ? prev : [...prev, artwork]));
  };

  // ── 再生 ──
  const playable = track ? PLAYABLE_AUDIO.includes(extOf(track.name)) : false;

  useEffect(() => {
    const a = audioRef.current;
    if (!a || !track) return;
    setError(null);
    setTime(0);
    setDuration(0);
    if (!playable) return;
    a.src = track.url;
    a.load();
    setSlowLoad(false);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => setSlowLoad(true), 2000);
    if (autoplay.current) void a.play().catch(() => undefined);
  }, [track, playable]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, track]);

  const select = (gi: number, ti: number, keepTime = false): void => {
    const a = audioRef.current;
    // すでに選ばれている曲を押したときは、選び直しにならず読み込みも走らないので、ここで再生する
    // （1曲だけの作品では、最初から選ばれている曲を押しても何も起きなかった）
    if (gi === groupIdx && ti === trackIdx && !keepTime) {
      if (a && playable) void a.play().catch(() => setError(t('再生できませんでした')));
      return;
    }
    if (keepTime && a) pendingSeek.current = a.currentTime;
    autoplay.current = keepTime ? !a?.paused : true;
    saveState();
    setGroupIdx(gi);
    setTrackIdx(ti);
  };

  const next = (manual: boolean): void => {
    if (!group) return;
    if (!manual && repeat === 'one') {
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        void a.play();
      }
      return;
    }
    if (trackIdx + 1 < group.tracks.length) select(groupIdx, trackIdx + 1);
    else if (manual || repeat === 'group') select(groupIdx, 0);
    else setPlaying(false);
  };

  const prev = (): void => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) {
      a.currentTime = 0;
      return;
    }
    if (group && trackIdx > 0) select(groupIdx, trackIdx - 1);
  };

  const toggle = (): void => {
    const a = audioRef.current;
    if (!a || !playable) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const seek = (tItem: number): void => {
    const a = audioRef.current;
    if (a) a.currentTime = Math.max(0, Math.min(tItem, a.duration || tItem));
  };

  // キーボード: Space 再生/停止、←→ 5秒、Esc 閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && e.target.closest('input,select,textarea')) return;
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight') seek((audioRef.current?.currentTime ?? 0) + 5);
      else if (e.key === 'ArrowLeft') seek((audioRef.current?.currentTime ?? 0) - 5);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = e.key === 'ArrowUp' ? 0.05 : -0.05;
        setAudioPrefs({ volume: Math.round(Math.min(maxVolume, Math.max(0, audioPrefs.volume + step)) * 100) / 100 });
      } else if (e.key === 'Escape') {
        if (soundOpen) setSoundOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="player" role="dialog" aria-modal="true">
      <header className="player__head">
        <div className="player__title" title={product.title}>
          {product.title}
        </div>
        {!IN_POPUP && (
          <button
            className="btn btn--xs btn--ghost viewer__popout"
            onClick={() =>
              // 閉じるときに聴いていた位置を保存するので、別ウィンドウでは続きから再生される
              void window.api.viewer.popup({ kind: 'voice', productId: product.id, title: product.title }).then(() => onClose())
            }
            title={t('別ウィンドウで開く（続きから再生します）')}
            aria-label={t('別ウィンドウで開く')}
          >
            ⧉
          </button>
        )}
        <button className="detail__close player__close" onClick={onClose} aria-label={t('閉じる')}>
          ×
        </button>
      </header>

      <div className="player__body">
        {/* フォルダ = グループ。版のラベルを付けて並べる */}
        <nav className="player__groups">
          {artwork && (
            <button
              className="player__art"
              onClick={() => images.length > 0 && setGallery(Math.max(0, images.findIndex((i) => i.url === artwork)))}
              title={images.length > 0 ? t('画像を見る') : undefined}
            >
              <img src={artwork} alt="" onError={onArtError} />
            </button>
          )}
          {groups.length === 0 && <p className="muted">{t('再生できる音声がありません。')}</p>}
          {groups.map((g, gi) => {
            const open = !collapsed.has(g.folder);
            return (
              <section key={`${g.folder}:${gi}`} className={`pgroup ${gi === groupIdx ? 'pgroup--current' : ''}`}>
                <button
                  className="pgroup__head"
                  onClick={() =>
                    setCollapsed((prevSet) => {
                      const nextSet = new Set(prevSet);
                      if (nextSet.has(g.folder)) nextSet.delete(g.folder);
                      else nextSet.add(g.folder);
                      return nextSet;
                    })
                  }
                  title={g.folder || t('（ルート）')}
                >
                  <span className="pgroup__caret">{open ? '▾' : '▸'}</span>
                  <span className="pgroup__label">{t(g.label)}</span>
                  {g.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {t(tag)}
                    </span>
                  ))}
                  <span className="muted pgroup__count">{g.tracks.length}</span>
                </button>
                {g.folder.includes('/') && open && <div className="muted pgroup__path">{g.folder}</div>}
                {open && (
                  <ol className="ptracks">
                    {g.tracks.map((tItem, ti) => (
                      <li key={tItem.url}>
                        <button
                          className={`ptrack ${gi === groupIdx && ti === trackIdx ? 'ptrack--current' : ''}`}
                          onClick={() => select(gi, ti)}
                          title={tItem.relPath}
                        >
                          <span className="ptrack__no">{gi === groupIdx && ti === trackIdx && playing ? '♪' : ti + 1}</span>
                          <span className="ptrack__name">{tItem.name}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            );
          })}
        </nav>

        {/* 台本・字幕 */}
        <section className="player__doc">
          {docs.length > 0 || images.length > 0 ? (
            <>
              <div className="doctabs">
                {images.length > 0 && (
                  <button
                    className={`doctab ${gallery !== null ? 'doctab--active' : ''}`}
                    onClick={() => setGallery('grid')}
                    title={t('作品に入っている画像')}
                  >
                    {t('画像')}<span className="doctab__name">{t('{length} 枚', { length: images.length })}</span>
                  </button>
                )}
                {docs.map((d) => (
                  <button
                    key={d.key}
                    className={`doctab ${gallery === null && d.key === docKey ? 'doctab--active' : ''}`}
                    onClick={() => {
                      manualDoc.current = true;
                      setGallery(null);
                      setDocKey(d.key);
                    }}
                    title={d.entry.relPath}
                  >
                    {d.kind === 'subtitle' ? t('字幕') : d.kind === 'pdf' ? 'PDF' : d.kind === 'image' ? t('画像') : t('テキスト')}
                    <span className="doctab__name">{d.entry.name}</span>
                  </button>
                ))}
                {/* 台本を別ウィンドウへ。再生はこのまま続く（字幕の一覧は再生位置と連動するので対象外）。
                    プレイヤーそのものを別ウィンドウにしているときも使える */}
                {gallery === null && doc && doc.kind !== 'subtitle' && (
                  <button
                    className="btn btn--xs btn--ghost doctabs__popout"
                    onClick={() =>
                      void window.api.viewer.popup({
                        kind: doc.kind === 'pdf' ? 'pdf' : doc.kind === 'image' ? 'images' : 'text',
                        productId: product.id,
                        entryUrl: doc.entry.url,
                        title: `${product.title} ・ ${doc.entry.name}`
                      })
                    }
                    title={t('この台本を別ウィンドウで開く（再生は続きます）')}
                    aria-label={t('別ウィンドウで開く')}
                  >
                    ⧉
                  </button>
                )}
              </div>
              <div className="player__docBody">
                {gallery === 'grid' && (
                  <div className="thumbs thumbs--player">
                    {images.map((img, i) => (
                      <button key={img.url} className="thumb" onClick={() => setGallery(i)} title={img.relPath}>
                        <img src={img.url} alt={img.name} loading="lazy" />
                        <span>{img.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {typeof gallery === 'number' && images[gallery] && (
                  <div className="pimage">
                    <div className="pimage__bar">
                      <button className="btn btn--xs" onClick={() => setGallery('grid')}>
                        {t('一覧')}
                      </button>
                      <button className="btn btn--xs" disabled={gallery === 0} onClick={() => setGallery(gallery - 1)}>
                        {t('前へ')}
                      </button>
                      <span className="muted">
                        {gallery + 1} / {images.length}
                      </span>
                      <button className="btn btn--xs" disabled={gallery >= images.length - 1} onClick={() => setGallery(gallery + 1)}>
                        {t('次へ')}
                      </button>
                      <span className="muted pimage__name" title={images[gallery].relPath}>
                        {images[gallery].relPath}
                      </span>
                    </div>
                    <img
                      className="pimage__img"
                      src={images[gallery].url}
                      alt={images[gallery].name}
                      onClick={(e) => {
                        // 画像の左半分で前へ、右半分で次へ
                        const rect = e.currentTarget.getBoundingClientRect();
                        const left = e.clientX - rect.left < rect.width / 2;
                        setGallery(Math.max(0, Math.min(images.length - 1, gallery + (left ? -1 : 1))));
                      }}
                    />
                  </div>
                )}
                {gallery === null && doc?.kind === 'pdf' && (
                  <PdfView
                    key={doc.entry.url}
                    url={doc.entry.url}
                    inArchive={doc.entry.inArchive}
                    position={pdfPositions.current.get(doc.entry.url) ?? null}
                    onPosition={(pos) => pdfPositions.current.set(doc.entry.url, pos)}
                  />
                )}
                {gallery === null && doc?.kind === 'text' && <TextView url={doc.entry.url} name={doc.entry.name} />}
                {gallery === null && doc?.kind === 'image' && <img className="player__docImg" src={doc.entry.url} alt={doc.entry.name} />}
                {gallery === null && doc?.kind === 'subtitle' && (
                  <SubtitleView url={doc.entry.url} name={doc.entry.name} currentTime={time} onSeek={seek} />
                )}
              </div>
            </>
          ) : (
            <div className="player__nodoc muted">{t('台本・字幕・画像は見つかりませんでした。')}</div>
          )}
        </section>
      </div>

      {showCaption && (
        <div className="player__caption" aria-live="polite">
          {caption || '\u00a0'}
        </div>
      )}

      <footer className="player__bar">
        {artwork ? <img className="player__thumb" src={artwork} alt="" onError={onArtError} /> : <span className="player__thumb" />}
        <div className="player__now">
          <div className="player__trackName" title={track?.relPath}>
            {track ? track.name : '—'}
          </div>
          <div className="muted player__trackSub">
            {group ? `${t(group.label)}${group.tags.length ? t('（{0}）', { 0: group.tags.map((tag) => t(tag)).join(t('・')) }) : ''}` : ''}
            {error ? t(' ・ {error}', { error }) : ''}
            {slowLoad && !error ? t(' ・ 読み込み中…（初めて開くファイルは Windows の検査で30秒ほどかかることがあります）') : ''}
            {track && !playable ? t(' ・ この形式はアプリ内で再生できません') : ''}
          </div>
          {versions.length > 0 && (
            <div className="player__versions">
              <span className="muted">{t('版:')}</span>
              {versions.map((v) => (
                <button
                  key={`${v.gi}:${v.ti}`}
                  className={`chip chip--button ${v.gi === groupIdx ? 'chip--active' : ''}`}
                  onClick={() => select(v.gi, v.ti, true)}
                  title={t('再生位置を保ったまま切り替えます')}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="player__controls">
          {/* 絵文字の ⏮⏭⏸ は環境によって色付きの絵文字になり、ボタンから浮いて見えるので図形で描く */}
          <button className="btn player__skip" onClick={prev} title={t('前へ')} aria-label={t('前へ')}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="2" y="3" width="2" height="10" fill="currentColor" />
              <path d="M14 3v10L5 8z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="btn btn--primary player__play"
            onClick={toggle}
            disabled={!playable}
            title={t('再生/一時停止 (Space)')}
            aria-label={playing ? t('一時停止') : t('再生')}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <rect x="3" y="2.5" width="3.5" height="11" fill="currentColor" />
                <rect x="9.5" y="2.5" width="3.5" height="11" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="M4 2.5v11L13.5 8z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button className="btn player__skip" onClick={() => next(true)} title={t('次へ（同じグループの中）')} aria-label={t('次へ')}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M2 3v10l9-5z" fill="currentColor" />
              <rect x="12" y="3" width="2" height="10" fill="currentColor" />
            </svg>
          </button>
          <span className="player__time">{formatTime(time)}</span>
          <input
            className="player__seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span className="player__time">{formatTime(duration)}</span>
        </div>

        <div className="player__opts">
          {trackSubtitle && (
            <button
              className={`btn btn--xs ${captionOn ? 'btn--on' : ''}`}
              onClick={() => setCaptionOn((v) => !v)}
              title={t('字幕を下に重ねて表示する')}
              aria-pressed={captionOn}
            >
              {t('字幕')}
            </button>
          )}
          <select
            className="select select--xs"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as Repeat)}
            title={t('繰り返し')}
          >
            <option value="off">{t('繰り返しなし')}</option>
            <option value="group">{t('グループを繰り返す')}</option>
            <option value="one">{t('1曲を繰り返す')}</option>
          </select>
          <select className="select select--xs" value={rate} onChange={(e) => setRate(Number(e.target.value))} title={t('速さ')}>
            {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
              <option key={r} value={r}>
                ×{r}
              </option>
            ))}
          </select>
          <input
            className="player__volume"
            type="range"
            min={0}
            max={maxVolume}
            step={0.01}
            value={Math.min(maxVolume, audioPrefs.volume)}
            onChange={(e) => setAudioPrefs({ volume: Number(e.target.value) })}
            title={t('音量（↑ ↓ キー）')}
          />
          <span className={`player__volumeValue ${audioPrefs.volume > 1 ? 'audioprefs__value--over' : ''}`}>
            {Math.round(Math.min(maxVolume, audioPrefs.volume) * 100)}%
          </span>
          <div className="popoverWrap" ref={soundRef}>
            <button
              className={`btn btn--xs ${soundOpen ? 'btn--on' : ''}`}
              onClick={() => setSoundOpen((v) => !v)}
              disabled={!tuned}
              title={tuned ? t('音の調整（ボイスを目立たせる・音量を 100% より上げる など）') : t('この環境では音の調整を使えません')}
              aria-expanded={soundOpen}
            >
              {t('音の調整')}
            </button>
            {soundOpen && (
              <div className="menu viewerPrefs settings menu--up">
                <AudioPrefsFields compact />
              </div>
            )}
          </div>
        </div>

        <audio
          ref={audioRef}
          // 音の調整（Web Audio）に通すため。mylib:// は読むだけの CORS を許可している
          crossOrigin="anonymous"
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveState();
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onCanPlay={() => {
            if (loadTimer.current) clearTimeout(loadTimer.current);
            setSlowLoad(false);
          }}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            if (pendingSeek.current !== null) {
              e.currentTarget.currentTime = pendingSeek.current;
              pendingSeek.current = null;
            }
            e.currentTarget.playbackRate = rate;
          }}
          onEnded={() => next(false)}
          onError={(e) => {
            const a = e.currentTarget;
            if (track && retried.current !== track.url) {
              retried.current = track.url;
              const resume = autoplay.current;
              setTimeout(() => {
                a.load();
                if (resume) void a.play().catch(() => undefined);
              }, 600);
              return;
            }
            setError(t('再生できませんでした'));
          }}
        />
      </footer>
    </div>
  );
}
