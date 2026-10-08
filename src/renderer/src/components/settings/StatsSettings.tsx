import { locale, t } from '@shared/i18n';
import type { DictionaryView, PurchaseStats, RaceData, RaceDimension, RaceMode, RankItem, StatsFilter } from '@shared/purchaseStats';
import { EXPORT_FORMATS, type ExportFormat } from '@shared/statsExport';
import { TAG_KIND_LABELS, type DictionaryEdit, type TagKind } from '@shared/tagRules';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTimeline, drawRace, raceColumns, raceFrameAt, type RacePacing, type RaceStyle } from '../../lib/raceChart';
import { formatTime } from '../../lib/format';

const DIMENSIONS: Array<{ value: RaceDimension; label: string }> = [
  { value: 'tag', label: 'タグ' },
  { value: 'maker', label: 'ブランド・サークル' },
  { value: 'voice', label: '声優' },
  { value: 'author', label: '作者・イラスト・シナリオ' },
  { value: 'workType', label: '種別' }
];

/** 書き出しの大きさの選択肢。縦は SNS の縦長の動画向け */
type Orientation = 'landscape' | 'portrait' | 'square';
const SIZE_PRESETS: Array<{ key: string; orientation: Orientation; w: number; h: number; small?: boolean }> = [
  { key: 'h720', orientation: 'landscape', w: 1280, h: 720 },
  { key: 'h1080', orientation: 'landscape', w: 1920, h: 1080 },
  { key: 'h360', orientation: 'landscape', w: 640, h: 360, small: true },
  { key: 'v1280', orientation: 'portrait', w: 720, h: 1280 },
  { key: 'v1920', orientation: 'portrait', w: 1080, h: 1920 },
  { key: 'v640', orientation: 'portrait', w: 360, h: 640, small: true },
  { key: 's720', orientation: 'square', w: 720, h: 720 },
  { key: 's1080', orientation: 'square', w: 1080, h: 1080 },
  { key: 's480', orientation: 'square', w: 480, h: 480, small: true }
];
const ORIENTATION_LABELS: Record<Orientation, string> = { landscape: '横', portrait: '縦', square: '正方形' };
/** 大きさの上限（4K の画素数）。これを超える大きさは H.264 などで作れないことがある */
const MAX_PIXELS = 3840 * 2160;
const MAX_SIDE = 3840;
const MIN_SIDE = 90;
/** 順位の選択肢（上位何位まで）。対象の数より多いものは出さない。上限は対象の数（「すべて」） */
const RANK_PRESETS = [5, 8, 10, 12, 15, 20, 30, 50, 100];
/** 「すべて」のとき、対象の数が分かる前に問い合わせる上限（実質なし） */
const ALL_RANKS = 1_000_000;
const SECONDS_PER_MONTH = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1];
/** プレビューの表示の大きさの上限。絵は書き出しと同じ大きさで描き、表示だけこの中に縮める（見たまま書き出す） */
const PREVIEW_MAX = { width: 960, height: 640 };

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
  /** 出す順位（rankFrom 位〜rankTo 位）。'custom' のときは両方を入力で決める */
  const [rankPreset, setRankPreset] = useState<number | 'custom' | 'all'>(10);
  const [customRank, setCustomRank] = useState({ from: 1, to: 10 });
  /** 棒の左に順位の数字を出すか */
  const [showRank, setShowRank] = useState(false);
  /** 段組み（列の数）。自動は横長・正方形で行が細くなりすぎるときに増やす */
  const [columns, setColumns] = useState<number | 'auto'>('auto');
  /** 期間の中にある対象の数（順位の上限）。最初の問い合わせが返るまでは分からない */
  const [totalKeys, setTotalKeys] = useState<number | null>(null);
  const rankFrom = rankPreset === 'custom' ? customRank.from : 1;
  /** 問い合わせる順位の上限（「すべて」は対象の数が分かる前でも全部返るように） */
  const requestTo = rankPreset === 'custom' ? customRank.to : rankPreset === 'all' ? ALL_RANKS : rankPreset;
  /** 描く順位の上限（対象の数を超えない） */
  const rankTo = Math.max(1, totalKeys === null ? Math.min(requestTo, ALL_RANKS) : Math.min(requestTo, totalKeys));
  /** 問い合わせられる範囲か（整数で、始めが終わり以下） */
  const rankWellFormed = Number.isInteger(rankFrom) && Number.isInteger(requestTo) && rankFrom >= 1 && rankFrom <= requestTo;
  /** 書き出せる範囲か（指定した範囲の終わりが、対象の数を超えない） */
  const rankValid = rankWellFormed && (rankPreset !== 'custom' || totalKeys === null || requestTo <= totalKeys);
  const [secondsPerMonth, setSecondsPerMonth] = useState(0.15);
  const [pacing, setPacing] = useState<RacePacing>('volume');
  const [data, setData] = useState<RaceData | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  /** 書き出しの大きさ。'custom' のときは幅と高さを入力で決める */
  const [sizeKey, setSizeKey] = useState('h720');
  const [customSize, setCustomSize] = useState({ w: 1080, h: 1920 });
  const preset = SIZE_PRESETS.find((p) => p.key === sizeKey);
  const width = preset ? preset.w : customSize.w;
  const height = preset ? preset.h : customSize.h;
  const sizeError =
    !Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE
      ? t('幅と高さは {0}〜{1} の間で指定してください。', { 0: MIN_SIDE, 1: MAX_SIDE })
      : width % 2 || height % 2
        ? t('幅と高さは偶数にしてください（動画の都合）。')
        : width * height > MAX_PIXELS
          ? t('大きすぎます（幅×高さは 3840×2160 の画素数まで）。')
          : null;
  const preview = useMemo(() => {
    const scale = Math.min(PREVIEW_MAX.width / width, PREVIEW_MAX.height / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }, [width, height]);
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
    if (!rankWellFormed) return;
    void window.api.stats.race({ ...filter, dimension, mode, windowMonths, topN: requestTo }).then((d) => {
      if (cancelled) return;
      setData(d);
      setTotalKeys(d.totalKeys);
      setTime(0);
      setConfirmMissing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, dimension, mode, windowMonths, requestTo, rankWellFormed, rulesVersion]);

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
    const base =
      mode === 'cumulative'
        ? t('{0}の累計件数（{1}）', { 0: dimLabel, 1: range })
        : t('{0}の直近 {1} か月の件数（{2}）', { 0: dimLabel, 1: windowMonths, 2: range });
    return {
      // 途中の順位から出すときは、範囲もタイトルに入れる
      title: rankFrom > 1 ? `${base} ${t('{0}〜{1}位', { 0: rankFrom, 1: rankTo })}` : base,
      formatMonth,
      formatPurchased: (n) => t('購入 {0} 件', { 0: num(n) }),
      rankFrom,
      rankTo,
      showRank,
      columns
    };
  }, [data, mode, dimLabel, windowMonths, rankFrom, rankTo, showRank, columns]);

  // プレビューを描く
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !data || !timeline || !style) return;
    const frame = raceFrameAt(data, timeline, time, rankTo, rankFrom);
    drawRace(ctx, width, height, frame, style);
  }, [data, timeline, style, time, rankTo, rankFrom, width, height]);

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
        drawRace(ctx, width, height, raceFrameAt(data, timeline, f / fps, rankTo, rankFrom), style);
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
        <span className="settings__label">{t('順位')}</span>
        <select
          className="select select--xs"
          value={String(rankPreset)}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'custom') {
              setCustomRank({ from: rankFrom, to: rankTo });
              setRankPreset('custom');
            } else if (value === 'all') setRankPreset('all');
            else setRankPreset(Number(value));
          }}
          aria-label={t('順位')}
        >
          {RANK_PRESETS.filter((n) => totalKeys === null || n < totalKeys || n === rankPreset).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="all">{totalKeys === null ? t('すべて') : t('すべて（{0}）', { 0: num(totalKeys) })}</option>
          <option value="custom">{t('範囲を指定…')}</option>
        </select>
        {rankPreset === 'custom' && (
          <span className="stats__range">
            <input
              className="input input--sm stats__num"
              type="number"
              min={1}
              max={totalKeys ?? undefined}
              value={customRank.from}
              onChange={(e) => setCustomRank((r) => ({ ...r, from: Math.trunc(Number(e.target.value)) }))}
              aria-label={t('何位から')}
            />
            <span>{t('位〜')}</span>
            <input
              className="input input--sm stats__num"
              type="number"
              min={1}
              max={totalKeys ?? undefined}
              value={customRank.to}
              onChange={(e) => setCustomRank((r) => ({ ...r, to: Math.trunc(Number(e.target.value)) }))}
              aria-label={t('何位まで')}
            />
            <span>{t('位')}</span>
          </span>
        )}
        <label className="check">
          <input type="checkbox" checked={showRank} onChange={(e) => setShowRank(e.target.checked)} />
          <span>{t('順位を表示')}</span>
        </label>
        <span className="settings__label stats__inlineLabel">{t('段組み')}</span>
        <select
          className="select select--xs"
          value={String(columns)}
          onChange={(e) => setColumns(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
          aria-label={t('段組み')}
        >
          <option value="auto">
            {t('自動（{0} 列）', { 0: raceColumns(width, height, Math.max(1, rankTo - rankFrom + 1), 'auto') })}
          </option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {t('{0} 列', { 0: n })}
            </option>
          ))}
        </select>
        {!rankValid && (
          <span className="stats__error">
            {t('順位は 1〜{0} 位の間で、始めが終わり以下になるように指定してください。', { 0: totalKeys === null ? '…' : num(totalKeys) })}
          </span>
        )}
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
          <canvas
            ref={canvasRef}
            className="stats__preview"
            width={width}
            height={height}
            style={{ aspectRatio: `${width} / ${height}`, maxWidth: preview.width }}
          />
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
              disabled={!!exporting}
              onChange={(e) => {
                const next = e.target.value as ExportFormat;
                setFormat(next);
                // GIF・WebP は大きくなりやすいので、同じ向きの小さい大きさに。MP4・WebM はその逆
                const current = SIZE_PRESETS.find((p) => p.key === sizeKey);
                const wantSmall = EXPORT_FORMATS[next].defaultWidth < 1000;
                const swap = current && SIZE_PRESETS.find((p) => p.orientation === current.orientation && !!p.small === wantSmall);
                if (current && swap && !!current.small !== wantSmall) setSizeKey(swap.key);
              }}
            >
              {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
                <option key={f} value={f}>
                  {t(EXPORT_FORMATS[f].label)}
                </option>
              ))}
            </select>
            <select
              className="select select--xs"
              value={sizeKey}
              disabled={!!exporting}
              onChange={(e) => {
                if (e.target.value === 'custom') setCustomSize({ w: width, h: height });
                setSizeKey(e.target.value);
              }}
              aria-label={t('大きさ')}
            >
              {SIZE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {t(ORIENTATION_LABELS[p.orientation])} {p.w}×{p.h}
                </option>
              ))}
              <option value="custom">{t('大きさを指定…')}</option>
            </select>
            {sizeKey === 'custom' && (
              <span className="stats__range">
                <input
                  className="input input--sm stats__size"
                  type="number"
                  min={MIN_SIDE}
                  max={MAX_SIDE}
                  step={2}
                  value={customSize.w}
                  onChange={(e) => setCustomSize((c) => ({ ...c, w: Math.trunc(Number(e.target.value)) }))}
                  aria-label={t('幅')}
                />
                <span>×</span>
                <input
                  className="input input--sm stats__size"
                  type="number"
                  min={MIN_SIDE}
                  max={MAX_SIDE}
                  step={2}
                  value={customSize.h}
                  onChange={(e) => setCustomSize((c) => ({ ...c, h: Math.trunc(Number(e.target.value)) }))}
                  aria-label={t('高さ')}
                />
              </span>
            )}
            <span className="muted">{t('{0} コマ/秒', { 0: fps })}</span>
            {/* 書き出し中は、同じ場所を「取り消す」にする（ボタンの位置を動かさない）。進み具合は下の行に出す */}
            {exporting ? (
              <button className="btn btn--xs btn--ghost" disabled={exporting.finishing} onClick={cancelExport}>
                {t('取り消す')}
              </button>
            ) : (
              <button
                className="btn btn--xs btn--primary"
                disabled={!ffmpeg || !!sizeError || !rankValid}
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
          {exporting && (
            <div className="settings__row stats__exporting">
              <div className="progress stats__progress">
                <div className="progress__bar" style={{ width: `${Math.round(exporting.progress * 100)}%` }} />
              </div>
              <span className="muted">{exporting.finishing ? t('仕上げています…') : `${Math.round(exporting.progress * 100)}%`}</span>
            </div>
          )}
          {sizeError && <p className="stats__error">{sizeError}</p>}
          {Math.ceil((rankTo - rankFrom + 1) / raceColumns(width, height, rankTo - rankFrom + 1, columns)) > 30 && width * height < 1280 * 1280 && (
            <p className="muted detail__note">{t('1 列の本数が多いと、名前が小さくなります。縦長・大きいサイズ・段組みがおすすめです（細すぎる行は名前を省いて棒だけにします）。')}</p>
          )}
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
