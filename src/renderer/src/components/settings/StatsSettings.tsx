import { locale, t } from '@shared/i18n';
import type { DictionaryView, PurchaseStats, RaceData, RaceDimension, RaceMode, RankItem, StatsFilter } from '@shared/purchaseStats';
import { EXPORT_FORMATS, type ExportFormat } from '@shared/statsExport';
import { TAG_KIND_LABELS, type DictionaryEdit, type TagKind } from '@shared/tagRules';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTimeline, drawRace, raceFrameAt, type RacePacing, type RaceStyle } from '../../lib/raceChart';
import { formatTime } from '../../lib/format';

const DIMENSIONS: Array<{ value: RaceDimension; label: string }> = [
  { value: 'tag', label: 'タグ' },
  { value: 'maker', label: 'ブランド・サークル' },
  { value: 'voice', label: '声優' },
  { value: 'author', label: '作者・イラスト・シナリオ' },
  { value: 'workType', label: '種別' }
];

const SIZES = [640, 960, 1280, 1920];
const SECONDS_PER_MONTH = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1];
/** プレビューの大きさ（書き出しとは別。表示は幅に合わせて縮める） */
const PREVIEW = { width: 960, height: 540 };

const formatMonth = (month: string): string => {
  const [y, m] = month.split('-');
  return t('{0}年{1}月', { 0: y, 1: Number(m) });
};
const num = (n: number): string => n.toLocaleString(locale());

/**
 * 設定の「統計・書き出し」。購入履歴の統計を見て、件数の移り変わりを動画・GIF に書き出す。
 * タグは成人向け・セール関連などの属性ではないものを外し、DMM と DLsite で表記の違うものを名寄せして数える。
 */
export default function StatsSettings({
  siteLabels,
  onOpenTools
}: {
  siteLabels: Record<string, string>;
  onOpenTools: () => void;
}): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sites, setSites] = useState<string[]>([]);
  const [stats, setStats] = useState<PurchaseStats | null>(null);
  const [page, setPage] = useState<'summary' | 'dictionary' | 'race'>('summary');
  /** タグの上書き・名寄せの辞典を変えたら集計し直す */
  const [rulesVersion, setRulesVersion] = useState(0);
  const filter: StatsFilter = useMemo(() => ({ from: from || null, to: to || null, siteIds: sites }), [from, to, sites]);

  /** 裏の詳細の取得が進んだら、集計を取り直す（数秒まとめる） */
  const [metaVersion, setMetaVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.api.on.metaProgress(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setMetaVersion((v) => v + 1);
      }, 3000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.stats.summary(filter).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, rulesVersion, metaVersion]);

  const setTagRule = (key: string, action: 'exclude' | 'include' | 'reset'): void => {
    void window.api.stats.setTagRule(key, action).then(() => setRulesVersion((v) => v + 1));
  };
  const clearExcluded = (): void => {
    void window.api.stats.clearExcluded().then(() => setRulesVersion((v) => v + 1));
  };

  const allSites = Object.keys(siteLabels);
  return (
    <section className="settings stats">
      <p className="muted detail__note">
        {t('購入履歴を、期間・サイトごとに集計します。タグは成人向け・男性向け・セール・クーポンなど作品の属性ではないものを外し、DMM と DLsite で表記の違うもの（寝取り・寝取られ など）は 1 つにまとめて数えます。')}
      </p>
      <div className="segmented segmented--sm stats__pages" role="tablist">
        {([
          ['summary', t('集計')],
          ['dictionary', t('名寄せ辞典')],
          ['race', t('動画・GIF')]
        ] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={page === key} className={page === key ? 'on' : ''} onClick={() => setPage(key)}>
            {label}
          </button>
        ))}
      </div>
      {page === 'dictionary' ? (
        <DictionaryEditor onChanged={() => setRulesVersion((v) => v + 1)} />
      ) : (
        <>
      <div className="settings__row">
        <span className="settings__label">{t('期間')}</span>
        <input className="input input--sm stats__month" type="month" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={t('期間の始め')} />
        <span>〜</span>
        <input className="input input--sm stats__month" type="month" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={t('期間の終わり')} />
        {(from || to) && (
          <button className="btn btn--xs btn--ghost" onClick={() => { setFrom(''); setTo(''); }}>
            {t('すべての期間')}
          </button>
        )}
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('サイト')}</span>
        {allSites.map((id) => (
          <label key={id} className="check">
            <input
              type="checkbox"
              checked={sites.length === 0 || sites.includes(id)}
              onChange={(e) => {
                const current = sites.length === 0 ? allSites : sites;
                const next = e.target.checked ? [...current, id] : current.filter((s) => s !== id);
                // 全部選んだ・全部外したときは「すべて」に戻す
                setSites(next.length === allSites.length || next.length === 0 ? [] : next);
              }}
            />
            <span>{siteLabels[id]}</span>
          </label>
        ))}
      </div>

      {page === 'summary' && stats && (
        <StatsSummary stats={stats} siteLabels={siteLabels} onTagRule={setTagRule} onClearExcluded={clearExcluded} />
      )}
      {page === 'race' && (
        <>
          <div className="detail__heading">{t('件数の移り変わり（動画・GIF）')}</div>
          <RacePanel filter={filter} rulesVersion={rulesVersion} onOpenTools={onOpenTools} />
        </>
      )}
        </>
      )}
    </section>
  );
}

function StatsSummary({
  stats,
  siteLabels,
  onTagRule,
  onClearExcluded
}: {
  stats: PurchaseStats;
  siteLabels: Record<string, string>;
  onTagRule: (key: string, action: 'exclude' | 'include' | 'reset') => void;
  onClearExcluded: () => void;
}): JSX.Element {
  if (stats.total === 0) return <p className="muted">{t('この期間に購入した作品はありません。')}</p>;
  return (
    <>
      <CoverageNote stats={stats} />
      <div className="detail__heading">{t('概要')}</div>
      <div className="stats__cards">
        <div className="stats__card">
          <div className="stats__value">{num(stats.total)}</div>
          <div className="muted">
            {t('{0}〜{1} に購入', { 0: formatMonth(stats.firstMonth!), 1: formatMonth(stats.lastMonth!) })}
          </div>
        </div>
        {stats.bySite.map((s) => (
          <div key={s.siteId} className="stats__card">
            <div className="stats__value">{num(s.count)}</div>
            <div className="muted">{siteLabels[s.siteId] ?? s.siteId}</div>
          </div>
        ))}
      </div>
      <div className="stats__chips">
        {stats.byWorkType.map((w) => (
          <span key={w.workType} className="chip">
            {t(w.label)} {num(w.count)}
          </span>
        ))}
      </div>

      <div className="detail__heading">{t('月ごとの購入数')}</div>
      <MonthlyChart stats={stats} siteLabels={siteLabels} />

      <div className="stats__grid">
        <TagRanking stats={stats} onTagRule={onTagRule} onClearExcluded={onClearExcluded} />
        <div>
          <div className="stats__listTitle">{t('割合が増えたタグ')}</div>
          <p className="muted detail__note">{t('期間の終わりまでの 12 か月と、その前の 12 か月の比較')}</p>
          {stats.risingTags.length === 0 && <p className="muted">{t('該当なし')}</p>}
          <ol className="stats__list">
            {stats.risingTags.map((r) => (
              <li key={r.key}>
                <span className="stats__name">{r.label}</span>
                <span className="stats__count">
                  {(r.previousShare * 100).toFixed(1)}% → {(r.share * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ol>
        </div>
        <RankList title={t('ブランド・サークル')} items={stats.makers.slice(0, 10)} total={stats.total} />
        <RankList title={t('声優')} items={stats.voices.slice(0, 10)} total={stats.total - stats.coverage.peopleMissing} />
        <RankList title={t('作者・イラスト・シナリオ')} items={stats.authors.slice(0, 10)} total={stats.total - stats.coverage.peopleMissing} />
        <WeekHour stats={stats} />
      </div>

      <ExcludedTags stats={stats} onTagRule={onTagRule} />
    </>
  );
}

/** 上位に入るタグの数。切り替えでランキング外も出す */
const TAG_RANKING = 20;

/** 名寄せ後のタグの一覧。ランキング外の表示の切り替えと、自分で外したタグを戻す欄つき */
function TagRanking({
  stats,
  onTagRule,
  onClearExcluded
}: {
  stats: PurchaseStats;
  onTagRule: (key: string, action: 'exclude' | 'include' | 'reset') => void;
  onClearExcluded: () => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const byUser = stats.excludedTags.filter((tag) => tag.byUser);
  const q = query.trim().toLowerCase();
  const items = showAll ? stats.tags.filter((tag) => !q || tag.label.toLowerCase().includes(q)) : stats.tags.slice(0, TAG_RANKING);
  return (
    <div className="stats__tags">
      <RankList
        title={t('タグ（名寄せ後）')}
        items={items}
        total={stats.coverage.tagged}
        scroll={showAll}
        action={(item) => (
          <button className="btn btn--xs btn--ghost" title={t('このタグを数えない')} onClick={() => onTagRule(item.key, 'exclude')}>
            ×
          </button>
        )}
      />
      {stats.tags.length > TAG_RANKING && (
        <div className="settings__row">
          <label className="check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <span>{t('ランキング外のタグも表示（全 {0} 種）', { 0: num(stats.tags.length) })}</span>
          </label>
          {showAll && (
            <input
              className="input input--sm stats__find"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('タグを検索')}
              aria-label={t('タグを検索')}
            />
          )}
        </div>
      )}
      {byUser.length > 0 && (
        <div className="stats__restore">
          <div className="stats__listTitle">
            {t('除外したタグ（{0} 種）', { 0: num(byUser.length) })}
            <button className="link" onClick={onClearExcluded}>
              {t('すべて戻す')}
            </button>
          </div>
          <div className="stats__chips">
            {byUser.map((tag) => (
              <button key={tag.key} className="chip chip--button" title={t('数えるに戻す')} onClick={() => onTagRule(tag.key, 'reset')}>
                ↺ {tag.label} {num(tag.count)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * タグ情報の揃い具合。詳細を取っていない作品はタグ・人の集計に入らないので、その数と「残りを取得」を出す。
 * 裏の取得が進むと、集計を取り直してこの表示も減っていく
 */
function CoverageNote({ stats }: { stats: PurchaseStats }): JSX.Element | null {
  const [started, setStarted] = useState(false);
  const { tagged, unfetched, givenUp, peopleMissing, noAttributeTags } = stats.coverage;
  const fetchable = unfetched - givenUp;
  if (unfetched === 0 && peopleMissing === 0 && noAttributeTags === 0) return null;
  return (
    <div className="stats__coverage">
      {unfetched > 0 && (
        <div className="banner">
          {t('タグ取得済み {0} / {1} 件。詳細を取っていない {2} 件は、タグの集計に入っていません（割合はタグ取得済みの作品で計算します）。', {
            0: num(tagged),
            1: num(stats.total),
            2: num(unfetched)
          })}
          {givenUp > 0 && ` ${t('うち {0} 件は取得を試しきって取れませんでした。', { 0: num(givenUp) })}`}
          {fetchable > 0 &&
            (started ? (
              <span className="muted"> {t('裏で取得しています。進むと集計に反映されます。')}</span>
            ) : (
              <button
                className="btn btn--xs"
                onClick={() => {
                  setStarted(true);
                  void window.api.meta.runNow();
                }}
              >
                {t('残りを取得')}
              </button>
            ))}
        </div>
      )}
      {peopleMissing > unfetched && (
        <p className="muted detail__note">
          {t('声優・作者は、詳細を取った作品だけで数えています（未取得 {0} 件）。', { 0: num(peopleMissing) })}
        </p>
      )}
      {noAttributeTags > 0 && (
        <p className="muted detail__note">
          {t('タグ情報はあるが、数える属性タグが 1 つも無い作品: {0} 件（店舗ページが無くなった作品や、販促のタグしか付いていない作品など）', { 0: num(noAttributeTags) })}
        </p>
      )}
    </div>
  );
}

function RankList({
  title,
  items,
  total,
  action,
  scroll
}: {
  title: string;
  items: RankItem[];
  total: number;
  action?: (item: RankItem) => JSX.Element;
  /** 長い一覧はこの中だけでスクロールさせる */
  scroll?: boolean;
}): JSX.Element {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div>
      <div className="stats__listTitle">{title}</div>
      {items.length === 0 && <p className="muted">{t('該当なし')}</p>}
      <ol className={`stats__list ${scroll ? 'stats__list--scroll' : ''}`}>
        {items.map((item) => (
          <li key={item.key} title={t('{0} 件（{1}%）', { 0: num(item.count), 1: ((item.count / total) * 100).toFixed(1) })}>
            <span className="stats__bar" style={{ width: `${(item.count / max) * 100}%` }} />
            <span className="stats__name">{item.label}</span>
            <span className="stats__count">{num(item.count)}</span>
            {action?.(item)}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 月ごとの購入数（サイト別に積み上げ） */
function MonthlyChart({ stats, siteLabels }: { stats: PurchaseStats; siteLabels: Record<string, string> }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const siteIds = stats.bySite.map((s) => s.siteId);
  const colors = ['#66c0f4', '#e3a35b', '#9bd36b', '#c78ae6'];
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 140;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, ...stats.monthly.map((m) => m.total));
    const bw = w / stats.monthly.length;
    stats.monthly.forEach((m, i) => {
      let y = h - 16;
      siteIds.forEach((id, k) => {
        const v = m.bySite[id] ?? 0;
        const bh = (v / max) * (h - 24);
        ctx.fillStyle = colors[k % colors.length];
        ctx.fillRect(i * bw, y - bh, Math.max(1, bw - 1), bh);
        y -= bh;
      });
    });
    // 年の区切り（1 月だけ。年の幅が狭いときは間引く）
    ctx.fillStyle = '#8f98a0';
    ctx.font = '11px sans-serif';
    const every = Math.max(1, Math.ceil(36 / (bw * 12)));
    stats.monthly.forEach((m, i) => {
      if (m.month.endsWith('-01') && Number(m.month.slice(0, 4)) % every === 0) ctx.fillText(m.month.slice(0, 4), i * bw + 2, h - 3);
    });
  }, [stats, siteIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const peak = stats.monthly.reduce((a, b) => (b.total > a.total ? b : a), stats.monthly[0]);
  return (
    <div>
      <canvas ref={ref} className="stats__monthly" style={{ height: 140 }} />
      <div className="stats__legend muted">
        {siteIds.map((id, k) => (
          <span key={id}>
            <i style={{ background: colors[k % colors.length] }} />
            {siteLabels[id] ?? id}
          </span>
        ))}
        {peak && <span>{t('最も多い月: {0}（{1} 件）', { 0: formatMonth(peak.month), 1: num(peak.total) })}</span>}
      </div>
    </div>
  );
}

/** 曜日 × 時間帯（時刻の分かる作品だけ） */
function WeekHour({ stats }: { stats: PurchaseStats }): JSX.Element {
  const days = [t('日'), t('月'), t('火'), t('水'), t('木'), t('金'), t('土')];
  const max = Math.max(1, ...stats.weekHour.cells.flat());
  return (
    <div>
      <div className="stats__listTitle">{t('曜日・時間帯')}</div>
      <p className="muted detail__note">{t('購入時刻の分かる {0} 件（DMM の同人は日付だけなので含みません）', { 0: num(stats.weekHour.count) })}</p>
      <div className="stats__heat" role="img" aria-label={t('曜日・時間帯')}>
        {stats.weekHour.cells.map((row, d) => (
          <div key={d} className="stats__heatRow">
            <span className="stats__heatDay">{days[d]}</span>
            {row.map((v, h) => (
              <span key={h} className="stats__heatCell" style={{ opacity: v ? 0.15 + (0.85 * v) / max : 0.05 }} title={`${days[d]} ${h}:00 ${v}`} />
            ))}
          </div>
        ))}
        <div className="stats__heatRow muted">
          <span className="stats__heatDay" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="stats__heatHour">{h % 6 === 0 ? h : ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 数えていないタグ。種類ごとに並べ、数えるに戻せる */
function ExcludedTags({
  stats,
  onTagRule
}: {
  stats: PurchaseStats;
  onTagRule: (key: string, action: 'exclude' | 'include' | 'reset') => void;
}): JSX.Element {
  const byKind = new Map<string, typeof stats.excludedTags>();
  const automatic = stats.excludedTags.filter((tag) => !tag.byUser);
  for (const tag of automatic) byKind.set(tag.kind, [...(byKind.get(tag.kind) ?? []), tag]);
  const kindLabel = (k: string): string => t(TAG_KIND_LABELS[k as TagKind]);
  return (
    <details className="stats__excluded">
      <summary>{t('属性ではないとして数えていないタグ（{0} 種）', { 0: num(automatic.length) })}</summary>
      {stats.includedTags.length > 0 && (
        <div className="stats__kind">
          <div className="stats__listTitle">{t('自分で数えることにしたもの')}</div>
          <div className="stats__chips">
            {stats.includedTags.map((tag) => (
              <button key={tag.key} className="chip chip--button" title={t('既定に戻す')} onClick={() => onTagRule(tag.key, 'reset')}>
                {tag.label} {num(tag.count)} ×
              </button>
            ))}
          </div>
        </div>
      )}
      {[...byKind].map(([kind, tags]) => (
        <div key={kind} className="stats__kind">
          <div className="stats__listTitle">
            {kindLabel(kind)}（{num(tags.length)}）
          </div>
          <div className="stats__chips">
            {tags.slice(0, 120).map((tag) => (
              <button key={tag.key} className="chip chip--button" title={t('このタグも数える')} onClick={() => onTagRule(tag.key, 'include')}>
                {tag.label} {num(tag.count)}
              </button>
            ))}
            {tags.length > 120 && <span className="muted">{t('ほか {0} 種', { 0: num(tags.length - 120) })}</span>}
          </div>
        </div>
      ))}
    </details>
  );
}

/** 件数の移り変わり（バーチャートレース）のプレビューと書き出し */
function RacePanel({ filter, rulesVersion, onOpenTools }: { filter: StatsFilter; rulesVersion: number; onOpenTools: () => void }): JSX.Element {
  const [dimension, setDimension] = useState<RaceDimension>('tag');
  const [mode, setMode] = useState<RaceMode>('cumulative');
  const [windowMonths, setWindowMonths] = useState(12);
  const [topN, setTopN] = useState(10);
  const [secondsPerMonth, setSecondsPerMonth] = useState(0.15);
  const [pacing, setPacing] = useState<RacePacing>('volume');
  const [data, setData] = useState<RaceData | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [width, setWidth] = useState(EXPORT_FORMATS.mp4.defaultWidth);
  const [ffmpeg, setFfmpeg] = useState<boolean | null>(null);
  const [exporting, setExporting] = useState<{ progress: number; finishing: boolean } | null>(null);
  const [result, setResult] = useState<{ path: string } | { error: string } | null>(null);
  /** 未取得の作品があるときの「このまま書き出す」の確認 */
  const [confirmMissing, setConfirmMissing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 書き出し中の id と、取り消しの印（画面を閉じたら取り消す） */
  const job = useRef<{ id: string; cancelled: boolean } | null>(null);

  useEffect(() => {
    void window.api.tools.status().then((s) => setFfmpeg(!!s.status.ffmpeg));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.stats.race({ ...filter, dimension, mode, windowMonths, topN }).then((d) => {
      if (cancelled) return;
      setData(d);
      setTime(0);
      setConfirmMissing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, dimension, mode, windowMonths, topN, rulesVersion]);

  // 画面を閉じたら、途中の書き出しを取り消す
  useEffect(
    () => () => {
      if (job.current) {
        job.current.cancelled = true;
        void window.api.stats.exportCancel(job.current.id);
      }
    },
    []
  );

  const timeline = useMemo(
    () => (data ? buildTimeline(data.monthTotals, secondsPerMonth, pacing) : null),
    [data, secondsPerMonth, pacing]
  );
  const dimLabel = t(DIMENSIONS.find((d) => d.value === dimension)!.label);
  const style: RaceStyle | null = useMemo(() => {
    if (!data || data.months.length === 0) return null;
    const range = `${formatMonth(data.months[0])}〜${formatMonth(data.months.at(-1)!)}`;
    return {
      title:
        mode === 'cumulative'
          ? t('{0}の累計件数（{1}）', { 0: dimLabel, 1: range })
          : t('{0}の直近 {1} か月の件数（{2}）', { 0: dimLabel, 1: windowMonths, 2: range }),
      formatMonth,
      formatPurchased: (n) => t('購入 {0} 件', { 0: num(n) }),
      topN
    };
  }, [data, mode, dimLabel, windowMonths, topN]);

  // プレビューを描く
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !data || !timeline || !style) return;
    const frame = raceFrameAt(data, timeline, time, topN);
    drawRace(ctx, PREVIEW.width, PREVIEW.height, frame, style);
  }, [data, timeline, style, time, topN]);

  // 再生
  useEffect(() => {
    if (!playing || !timeline) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((prev) => {
        const next = prev + dt;
        if (next >= timeline.duration) {
          setPlaying(false);
          return timeline.duration;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline]);

  const height = Math.round((width * 9) / 16 / 2) * 2;
  const fps = EXPORT_FORMATS[format].defaultFps;

  const runExport = async (): Promise<void> => {
    if (!data || !timeline || !style) return;
    setResult(null);
    const name = `${t('購入履歴')}_${dimLabel}_${data.months[0]}_${data.months.at(-1)}`;
    let begun: { id: string; path: string } | null = null;
    try {
      begun = await window.api.stats.exportBegin({ format, width, height, fps }, name);
      if (!begun) return;
      job.current = { id: begun.id, cancelled: false };
      setExporting({ progress: 0, finishing: false });
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error(t('描画の準備ができませんでした。'));
      const frames = Math.max(1, Math.ceil(timeline.duration * fps));
      for (let f = 0; f < frames; f++) {
        if (job.current.cancelled) return;
        drawRace(ctx, width, height, raceFrameAt(data, timeline, f / fps, topN), style);
        const image = ctx.getImageData(0, 0, width, height);
        await window.api.stats.exportFrame(begun.id, new Uint8Array(image.data.buffer));
        if (f % 10 === 0) setExporting({ progress: f / frames, finishing: false });
      }
      setExporting({ progress: 1, finishing: true });
      const saved = await window.api.stats.exportEnd(begun.id);
      setResult({ path: saved });
    } catch (err) {
      if (begun && !job.current?.cancelled) void window.api.stats.exportCancel(begun.id);
      setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      job.current = null;
      setExporting(null);
    }
  };

  const cancelExport = (): void => {
    if (!job.current) return;
    job.current.cancelled = true;
    void window.api.stats.exportCancel(job.current.id);
    setExporting(null);
    setResult({ error: t('書き出しを取り消しました。') });
  };

  return (
    <>
      <div className="settings__row">
        <span className="settings__label">{t('対象')}</span>
        <select className="select select--xs" value={dimension} onChange={(e) => setDimension(e.target.value as RaceDimension)}>
          {DIMENSIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {t(d.label)}
            </option>
          ))}
        </select>
        <span className="muted">{t('期間とサイトは上の指定に従います')}</span>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('数え方')}</span>
        <div className="segmented segmented--sm">
          <button className={mode === 'cumulative' ? 'on' : ''} onClick={() => setMode('cumulative')}>
            {t('累計')}
          </button>
          <button className={mode === 'window' ? 'on' : ''} onClick={() => setMode('window')}>
            {t('直近の件数')}
          </button>
        </div>
        {mode === 'window' && (
          <label className="check">
            <input
              className="input input--sm stats__num"
              type="number"
              min={1}
              max={60}
              value={windowMonths}
              onChange={(e) => setWindowMonths(Math.min(60, Math.max(1, Number(e.target.value) || 1)))}
            />
            <span>{t('か月')}</span>
          </label>
        )}
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('上位')}</span>
        <select className="select select--xs" value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
          {[5, 8, 10, 12, 15, 20].map((n) => (
            <option key={n} value={n}>
              {t('{0} 本', { 0: n })}
            </option>
          ))}
        </select>
        <span className="settings__label stats__inlineLabel">{t('1 か月の長さ')}</span>
        <select className="select select--xs" value={secondsPerMonth} onChange={(e) => setSecondsPerMonth(Number(e.target.value))}>
          {SECONDS_PER_MONTH.map((s) => (
            <option key={s} value={s}>
              {t('{0} 秒', { 0: s })}
            </option>
          ))}
        </select>
        <select className="select select--xs" value={pacing} onChange={(e) => setPacing(e.target.value as RacePacing)}>
          <option value="volume">{t('購入の多い月ほど長く')}</option>
          <option value="even">{t('どの月も同じ長さ')}</option>
        </select>
      </div>

      {data && data.months.length === 0 && <p className="muted">{t('この期間に購入した作品はありません。')}</p>}
      {data && data.months.length > 0 && timeline && (
        <>
          <canvas ref={canvasRef} className="stats__preview" width={PREVIEW.width} height={PREVIEW.height} />
          <div className="settings__row">
            <button
              className="btn btn--xs"
              onClick={() => {
                if (!playing && time >= timeline.duration) setTime(0);
                setPlaying(!playing);
              }}
            >
              {playing ? t('一時停止') : t('再生')}
            </button>
            <input
              className="stats__seek"
              type="range"
              min={0}
              max={timeline.duration}
              step={0.01}
              value={time}
              onChange={(e) => {
                setPlaying(false);
                setTime(Number(e.target.value));
              }}
              aria-label={t('再生位置')}
            />
            <span className="muted">
              {formatTime(time)} / {formatTime(timeline.duration)}
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">{t('書き出し')}</span>
            <select
              className="select select--xs"
              value={format}
              onChange={(e) => {
                const next = e.target.value as ExportFormat;
                setFormat(next);
                setWidth(EXPORT_FORMATS[next].defaultWidth);
              }}
            >
              {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
                <option key={f} value={f}>
                  {t(EXPORT_FORMATS[f].label)}
                </option>
              ))}
            </select>
            <select className="select select--xs" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              {SIZES.map((w) => (
                <option key={w} value={w}>
                  {w}×{Math.round((w * 9) / 16 / 2) * 2}
                </option>
              ))}
            </select>
            <span className="muted">{t('{0} コマ/秒', { 0: fps })}</span>
            {exporting ? (
              <>
                <div className="progress">
                  <div className="progress__bar" style={{ width: `${Math.round(exporting.progress * 100)}%` }} />
                </div>
                <span className="muted">{exporting.finishing ? t('仕上げています…') : `${Math.round(exporting.progress * 100)}%`}</span>
                {!exporting.finishing && (
                  <button className="btn btn--xs btn--ghost" onClick={cancelExport}>
                    {t('取り消す')}
                  </button>
                )}
              </>
            ) : (
              <button
                className="btn btn--xs btn--primary"
                disabled={!ffmpeg}
                onClick={() => {
                  if (data.missing.total > 0 && !confirmMissing) setConfirmMissing(true);
                  else {
                    setConfirmMissing(false);
                    void runExport();
                  }
                }}
              >
                {confirmMissing ? t('このまま書き出す…') : t('書き出す…')}
              </button>
            )}
            {confirmMissing && !exporting && (
              <button className="btn btn--xs btn--ghost" onClick={() => setConfirmMissing(false)}>
                {t('やめる')}
              </button>
            )}
          </div>
          {data.missing.total > 0 && (
            <div className={`banner ${confirmMissing ? 'banner--warn' : ''}`}>
              {t('この期間に、{0}の情報がまだ無い作品が {1} 件あります（うち期間の終わりの 3 か月に {2} 件）。その作品は数えていないので、直近の月ほど少なく出ます。', {
                0: dimLabel,
                1: num(data.missing.total),
                2: num(data.missing.recent)
              })}{' '}
              <button className="link" onClick={() => void window.api.meta.runNow()}>
                {t('残りを取得')}
              </button>
            </div>
          )}
          {ffmpeg === false && (
            <p className="muted detail__note">
              {t('書き出しには ffmpeg が要ります。')}{' '}
              <button className="link" onClick={onOpenTools}>
                {t('ツールの設定を開く')}
              </button>
            </p>
          )}
          {format === 'gif' && <p className="muted detail__note">{t('GIF は大きくなりやすいので、長い期間は MP4 か WebP がおすすめです。')}</p>}
          <p className="muted detail__note">
            {t('書き出すのはタイトル・件数・年月とグラフだけで、作品名や画像は入りません。数えたくないタグは、上の一覧の × で外せます。')}
          </p>
          {result && 'path' in result && (
            <div className="banner">
              {t('書き出しました: {0}', { 0: result.path })}{' '}
              <button className="link" onClick={() => void window.api.showInFolder(result.path)}>
                {t('フォルダを開く')}
              </button>
            </div>
          )}
          {result && 'error' in result && <div className="banner banner--error">{result.error}</div>}
        </>
      )}
    </>
  );
}

/** 名寄せ辞典の確認と編集。グループ（代表名と別名）ごとに、台帳での件数を添えて並べる */
function DictionaryEditor({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [view, setView] = useState<DictionaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    void window.api.stats.dictionary().then(setView);
  }, []);

  const edit = async (change: DictionaryEdit | { type: 'reset' }): Promise<boolean> => {
    setError(null);
    try {
      setView(await window.api.stats.editDictionary(change));
      onChanged();
      return true;
    } catch (err) {
      // IPC 越しのエラーは「Error invoking remote method …: Error: 本文」の形で来る
      setError((err instanceof Error ? err.message : String(err)).replace(/^.*?Error: /, ''));
      return false;
    }
  };

  if (!view) return <p className="muted">{t('読み込み中…')}</p>;
  const q = query.trim().toLowerCase();
  const groups = view.groups.filter(
    (g) => !q || g.label.toLowerCase().includes(q) || g.members.some((m) => m.tag.toLowerCase().includes(q))
  );
  return (
    <div className="stats__dictionary">
      <p className="muted detail__note">
        {t('DMM と DLsite で同じ意味のタグを 1 つにまとめる辞典です。グループの名前（代表名）で数え、別名のタグも同じものとして数えます。区切り（・ と /）やカタカナ・ひらがなの違いは、辞典に無くても自動でまとめます。')}
      </p>
      <div className="settings__row">
        <input className="input input--sm stats__find" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('タグを検索')} aria-label={t('タグを検索')} />
        <span className="muted">{t('{0} グループ', { 0: num(view.groups.length) })}</span>
        <span className="muted">{view.edited ? t('（編集済み）') : t('（既定の辞典）')}</span>
        {view.edited &&
          (confirmReset ? (
            <>
              <span>{t('編集をすべて捨てて、既定の辞典に戻しますか？')}</span>
              <button className="btn btn--xs btn--primary" onClick={() => void edit({ type: 'reset' }).then(() => setConfirmReset(false))}>
                {t('既定に戻す')}
              </button>
              <button className="btn btn--xs btn--ghost" onClick={() => setConfirmReset(false)}>
                {t('やめる')}
              </button>
            </>
          ) : (
            <button className="btn btn--xs btn--ghost" onClick={() => setConfirmReset(true)}>
              {t('既定の辞典に戻す…')}
            </button>
          ))}
      </div>
      <form
        className="settings__row"
        onSubmit={(e) => {
          e.preventDefault();
          void edit({ type: 'addGroup', label: newGroup }).then((ok) => ok && setNewGroup(''));
        }}
      >
        <input className="input input--sm stats__find" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder={t('新しいグループの名前')} aria-label={t('新しいグループの名前')} />
        <button className="btn btn--xs" type="submit" disabled={!newGroup.trim()}>
          {t('グループを作る')}
        </button>
      </form>
      {error && <div className="banner banner--error">{error}</div>}
      <MergeSuggestions view={view} onEdit={edit} onDismiss={(id) => void window.api.stats.dismissSuggestion(id).then(setView)} />
      <datalist id="stats-dictionary-tags">
        {view.tags.slice(0, 1500).map((tag) => (
          <option key={tag.tag} value={tag.tag}>
            {tag.group ? `${num(tag.count)} → ${tag.group}` : num(tag.count)}
          </option>
        ))}
      </datalist>
      <div className="stats__groups">
        {groups.map((g) => (
          <DictionaryGroup key={g.label} group={g} onEdit={edit} />
        ))}
        {groups.length === 0 && <p className="muted">{t('該当なし')}</p>}
      </div>
    </div>
  );
}

function DictionaryGroup({
  group,
  onEdit
}: {
  group: DictionaryView['groups'][number];
  onEdit: (change: DictionaryEdit) => Promise<boolean>;
}): JSX.Element {
  const [adding, setAdding] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [label, ...aliases] = group.members;
  return (
    <div className="stats__group" data-group={group.label}>
      <div className="stats__groupHead">
        {renaming === null ? (
          <>
            <span className="stats__groupName" title={label.seen.join(' / ')}>
              {group.label}
            </span>
            <span className="muted">{t('{0} 件', { 0: num(group.count) })}</span>
            {!group.builtin && <span className="chip">{t('追加したもの')}</span>}
            <button className="btn btn--xs btn--ghost" onClick={() => setRenaming(group.label)}>
              {t('名前を変える')}
            </button>
            {confirmDelete ? (
              <>
                <button className="btn btn--xs btn--primary" onClick={() => void onEdit({ type: 'deleteGroup', label: group.label })}>
                  {t('消す')}
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => setConfirmDelete(false)}>
                  {t('やめる')}
                </button>
              </>
            ) : (
              <button className="btn btn--xs btn--ghost" title={t('グループを消す（タグは別々に数えるようになります）')} onClick={() => setConfirmDelete(true)}>
                {t('グループを消す')}
              </button>
            )}
          </>
        ) : (
          <form
            className="stats__groupHead"
            onSubmit={(e) => {
              e.preventDefault();
              void onEdit({ type: 'renameGroup', from: group.label, to: renaming }).then((ok) => ok && setRenaming(null));
            }}
          >
            <input className="input input--sm stats__find" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} aria-label={t('グループの名前')} />
            <button className="btn btn--xs btn--primary" type="submit">
              {t('変える')}
            </button>
            <button className="btn btn--xs btn--ghost" type="button" onClick={() => setRenaming(null)}>
              {t('やめる')}
            </button>
          </form>
        )}
      </div>
      <div className="stats__chips">
        {aliases.map((m) => (
          <span key={m.tag} className={`chip ${m.count === 0 ? 'chip--dim' : ''}`} title={m.seen.length ? m.seen.join(' / ') : t('台帳にはまだ無い表記')}>
            {m.tag} {m.count > 0 ? num(m.count) : ''}
            <button className="chip__remove" title={t('このグループから外す')} aria-label={t('このグループから外す')} onClick={() => void onEdit({ type: 'removeMember', label: group.label, tag: m.tag })}>
              ×
            </button>
          </span>
        ))}
        <form
          className="stats__addMember"
          onSubmit={(e) => {
            e.preventDefault();
            void onEdit({ type: 'addMember', label: group.label, tag: adding }).then((ok) => ok && setAdding(''));
          }}
        >
          <input
            className="input input--sm"
            list="stats-dictionary-tags"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder={t('タグを寄せる')}
            aria-label={t('{0} に寄せるタグ', { 0: group.label })}
          />
          <button className="btn btn--xs" type="submit" disabled={!adding.trim()}>
            {t('追加')}
          </button>
        </form>
      </div>
    </div>
  );
}

const REASONS: Record<DictionaryView['suggestions'][number]['reason'], string> = {
  contains: '片方がもう片方を含む',
  shares: '区切った語が重なる',
  masked: '伏せ字を埋めると同じ'
};

/**
 * 寄せる候補。辞典はこの開発者の台帳を元に作ったので、ほかの利用者の台帳にしか無いタグはここで寄せられるようにする。
 * 寄せると、グループに入っているほうへもう片方を足す（どちらも入っていなければ、件数の多いほうの名前でグループを作る）
 */
function MergeSuggestions({
  view,
  onEdit,
  onDismiss
}: {
  view: DictionaryView;
  onEdit: (change: DictionaryEdit) => Promise<boolean>;
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  if (view.suggestions.length === 0) return null;
  const merge = async (s: DictionaryView['suggestions'][number]): Promise<void> => {
    const [keep, add] = s.dmm.group ? [s.dmm, s.dlsite] : s.dlsite.group ? [s.dlsite, s.dmm] : s.dmm.count >= s.dlsite.count ? [s.dmm, s.dlsite] : [s.dlsite, s.dmm];
    const label = keep.group ?? keep.tag;
    if (!keep.group && !(await onEdit({ type: 'addGroup', label }))) return;
    await onEdit({ type: 'addMember', label, tag: add.tag });
  };
  return (
    <details className="stats__suggestions" open>
      <summary>{t('寄せる候補（{0}）', { 0: num(view.suggestions.length) })}</summary>
      <p className="muted detail__note">
        {t('DMM と DLsite で書き方が近いのに、まだ別々に数えているタグの組です。同じ意味なら「寄せる」、違う意味なら「候補から外す」を押してください。')}
      </p>
      <ul className="stats__suggestList">
        {view.suggestions.map((s) => (
          <li key={s.id}>
            <span className="stats__suggestPair">
              <span className="chip">DMM: {s.dmm.group ?? s.dmm.tag} {num(s.dmm.count)}</span>
              <span>⇔</span>
              <span className="chip">DLsite: {s.dlsite.group ?? s.dlsite.tag} {num(s.dlsite.count)}</span>
            </span>
            <span className="muted">{t(REASONS[s.reason])}</span>
            <button className="btn btn--xs" onClick={() => void merge(s)}>
              {t('寄せる')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => onDismiss(s.id)}>
              {t('候補から外す')}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
