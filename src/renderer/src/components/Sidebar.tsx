import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  WORK_TYPE_LABELS,
  type Category,
  type LocalState,
  type LoginStatus,
  type Playlist,
  type ServiceWarning,
  type SortDir,
  type WorkType
} from '@shared/types';
import ClearableInput from './ClearableInput';
import { t } from '@shared/i18n';

interface Props {
  /** 区分ごとの件数 */
  categoryCounts: Array<{ category: string; count: number }>;
  /** 購入サイトごとの件数 */
  siteCounts: Array<{ siteId: string; count: number }>;
  /** お気に入りの件数 */
  favoriteCount: number;
  favoriteOnly: boolean;
  onFavoriteOnly: (only: boolean) => void;
  /** ♡「使った」の件数と絞り込み */
  usedCount: number;
  usedOnly: boolean;
  onUsedOnly: (only: boolean) => void;
  /** プレイリスト（自分で作る一覧）と、いま見ているプレイリスト */
  playlists: Playlist[];
  playlistId: number | null;
  onSelectPlaylist: (id: number | null) => void;
  /** 作った・名前を変えた・消したあとに読み直す */
  onReloadPlaylists: () => void;
  /** 手元にあるか（ダウンロード済み / 未取得）の件数と絞り込み */
  localCounts: { have: number; none: number; installed: number; notInstalled: number; linkable: number; broken: number };
  localState: LocalState | null;
  onLocalState: (state: LocalState | null) => void;
  /** 手元の状態をまとめて最新にする */
  onRefreshLocal: () => void;
  /** 最新化の進みぐあい（動いていなければ null） */
  refreshMessage: string | null;
  selectedCategories: Category[];
  onSelectCategories: (categories: Category[]) => void;
  selectedSites: string[];
  onSelectSites: (siteIds: string[]) => void;
  /** 絞り込みに使うブランド/サークル（複数はOR） */
  selectedMakers: string[];
  onSelectMakers: (makers: string[]) => void;
  /** 絞り込みに使うタグ（複数はAND） */
  selectedTags: string[];
  onSelectTags: (tags: string[]) => void;
  /** 作品の種別（マンガ/CG/ボイス/ゲーム…）。複数はOR */
  selectedWorkTypes: WorkType[];
  onSelectWorkTypes: (types: WorkType[]) => void;
  /** 人・シリーズ（作者・声優・シナリオ・シリーズ…）。複数はAND */
  selectedCreators: string[];
  onSelectCreators: (names: string[]) => void;
  /** サイトごとのログイン状態。サイトが増えたらそのまま行が増える */
  auth: LoginStatus[];
  siteLabels: Record<string, string>;
  /** 本体とは別にログインが要るサービスのうち、未ログインのもの（FANZA動画・dmm.com） */
  serviceWarnings: ServiceWarning[];
  /** DMM GAMES PLAYER が要る作品があるのに入っていないとき */
  dgpWarning: string | null;
  onLogin: (siteId: string) => void;
  onLoginService: (siteId: string, service: string) => void;
  /** 設定画面を開く（アカウント・ID/PW もそちら） */
  onOpenSettings: (section?: 'account') => void;
}

/** 区分の並び順。件数に関係なくこの順で出す */
const CATEGORY_ORDER: Category[] = ['game', 'doujin', 'book', 'video', 'other'];

export default function Sidebar({
  categoryCounts,
  siteCounts,
  favoriteCount,
  favoriteOnly,
  onFavoriteOnly,
  usedCount,
  usedOnly,
  onUsedOnly,
  playlists,
  playlistId,
  onSelectPlaylist,
  onReloadPlaylists,
  localCounts,
  localState,
  onLocalState,
  selectedCategories,
  onSelectCategories,
  selectedSites,
  onSelectSites,
  selectedMakers,
  onSelectMakers,
  selectedTags,
  onSelectTags,
  selectedWorkTypes,
  onSelectWorkTypes,
  selectedCreators,
  onSelectCreators,
  auth,
  siteLabels,
  serviceWarnings,
  dgpWarning,
  onLogin,
  onLoginService,
  onOpenSettings,
  onRefreshLocal,
  refreshMessage
}: Props): JSX.Element {
  const loginWarnings = auth.filter((a) => !a.loggedIn || a.uncertain);
  const warnCount = loginWarnings.length + serviceWarnings.length + (dgpWarning ? 1 : 0);
  const [makers, setMakers] = useState<Array<{ maker: string; count: number }>>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [workTypes, setWorkTypes] = useState<Array<{ workType: string; count: number }>>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [tagRegex, setTagRegex] = useState(false);
  const [makerRegex, setMakerRegex] = useState(false);
  const [makerFilter, setMakerFilter] = useState('');
  const [makerSort, setMakerSort] = useState<'count' | 'name'>('count');
  const [makerDir, setMakerDir] = useState<SortDir>('desc');
  /** 新しいプレイリストの名前（null なら入力欄を出さない） */
  const [newPlaylist, setNewPlaylist] = useState<string | null>(null);
  /** 名前を変えているプレイリスト */
  const [editPlaylist, setEditPlaylist] = useState<{ id: number; name: string } | null>(null);
  /** 消してよいか尋ねているプレイリスト */
  const [askDelete, setAskDelete] = useState<Playlist | null>(null);

  // 作る・名前を変える・消す。一覧は playlists:changed を受けて App 側で入れ替わる
  const createPlaylist = async (): Promise<void> => {
    const name = (newPlaylist ?? '').trim();
    setNewPlaylist(null);
    if (!name) return;
    await window.api.playlists.create(name);
    onReloadPlaylists();
  };
  const savePlaylistName = async (): Promise<void> => {
    if (!editPlaylist) return;
    const name = editPlaylist.name.trim();
    const before = playlists.find((p) => p.id === editPlaylist.id);
    setEditPlaylist(null);
    if (!name || name === before?.name) return;
    await window.api.playlists.rename(editPlaylist.id, name);
    onReloadPlaylists();
  };
  const deletePlaylist = async (p: Playlist): Promise<void> => {
    setAskDelete(null);
    await window.api.playlists.remove(p.id);
    onReloadPlaylists();
  };

  // ブランド/サークルの候補と件数は、選択中の区分・購入サイトの中だけで数える。
  // 絞り込んだ結果、選択中のブランドが候補から消えたら選択も外す（一覧が空のまま
  // 理由の見えない絞り込みが残るのを防ぐ）。
  useEffect(() => {
    let cancelled = false;
    void window.api.library
      .makers({
        categories: selectedCategories,
        siteIds: selectedSites,
        tags: selectedTags,
        workTypes: selectedWorkTypes,
        creators: selectedCreators
      })
      .then((list) => {
        if (cancelled) return;
        setMakers(list);
        // 絞り込んだ結果、選択中のブランドが候補から消えたら選択も外す
        // （一覧が空のまま、理由の見えない絞り込みが残るのを防ぐ）
        const alive = selectedMakers.filter((m) => list.some((x) => x.maker === m));
        if (alive.length !== selectedMakers.length) onSelectMakers(alive);
      });
    return () => {
      cancelled = true;
    };
    // selectedMakers/onSelectMakers は取り直しの理由ではないので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryCounts, selectedCategories, selectedSites, selectedTags, selectedWorkTypes, selectedCreators]);

  // タグも同じく、区分・購入サイト・選択済みタグの中だけで数える。
  // 選択済みタグを条件に入れるので、絞り込むほど共起するタグだけが残る。
  useEffect(() => {
    let cancelled = false;
    void window.api.library
      .tags({
        categories: selectedCategories,
        siteIds: selectedSites,
        tags: selectedTags,
        makers: selectedMakers,
        workTypes: selectedWorkTypes,
        creators: selectedCreators
      })
      .then((list) => {
        if (!cancelled) setTags(list);
      });
    return () => {
      cancelled = true;
    };
  }, [
    categoryCounts,
    selectedCategories,
    selectedSites,
    selectedTags,
    selectedMakers,
    selectedWorkTypes,
    selectedCreators
  ]);

  // 種別も他の絞り込みに連動させる。種別自身は条件に入れない（選び直せなくなるため）
  useEffect(() => {
    let cancelled = false;
    void window.api.library
      .workTypes({
        categories: selectedCategories,
        siteIds: selectedSites,
        tags: selectedTags,
        makers: selectedMakers,
        creators: selectedCreators
      })
      .then((list) => {
        if (!cancelled) setWorkTypes(list);
      });
    return () => {
      cancelled = true;
    };
  }, [
    categoryCounts,
    selectedCategories,
    selectedSites,
    selectedTags,
    selectedMakers,
    selectedCreators
  ]);

  const total = categoryCounts.reduce((a, c) => a + c.count, 0);
  const countOf = (category: Category): number =>
    categoryCounts.find((c) => c.category === category)?.count ?? 0;

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  /**
   * 絞り込み用の判定を作る。正規表現モードのときは式をコンパイルし、
   * 不正なら「まだ書きかけ」とみなして絞り込まない（入力のたびに0件になるのを避ける）。
   */
  const matcher = (
    text: string,
    regex: boolean
  ): { test: (value: string) => boolean; error: string | null } => {
    const trimmed = text.trim();
    if (!trimmed) return { test: () => true, error: null };
    if (!regex) {
      const lower = trimmed.toLowerCase();
      return { test: (value) => value.toLowerCase().includes(lower), error: null };
    }
    try {
      const re = new RegExp(trimmed, 'i');
      return { test: (value) => re.test(value), error: null };
    } catch (err) {
      return { test: () => true, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const makerMatch = matcher(makerFilter, makerRegex);
  const tagMatch = matcher(tagFilter, tagRegex);

  const visibleMakers = makers
    .filter((m) => makerMatch.test(m.maker))
    // 名前順は SQLite のバイト順だと日本語が期待通りに並ばないので、ここで日本語ロケール比較する
    .sort((a, b) => {
      const base =
        makerSort === 'name'
          ? a.maker.localeCompare(b.maker, 'ja')
          : a.count - b.count || a.maker.localeCompare(b.maker, 'ja');
      return makerDir === 'asc' ? base : -base;
    })
    .slice(0, 300);

  // タグは件数順のまま。数が多いので入力での絞り込みを前提にする
  const visibleTags = tags.filter((tItem) => tagMatch.test(tItem.tag)).slice(0, 300);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">▤</span>
        <span>{t('ライブラリ')}</span>
        <button
          className={`sidebar__gear ${warnCount > 0 ? 'sidebar__gear--warn' : ''}`}
          onClick={() => onOpenSettings(warnCount > 0 ? 'account' : undefined)}
          title={warnCount > 0 ? t('設定（ログインしていないサイトがあります）') : t('設定')}
          aria-label={t('設定')}
        >
          ⚙
        </button>
      </div>

      {/* ログインしていないサイトは、いつでも目に入る場所に出す（ログイン・ID/PW の管理は設定画面） */}
      {warnCount > 0 && (
        <div className="sidebar__warnings">
          {loginWarnings.map((a) => (
            <div key={a.siteId} className={`loginWarn ${a.uncertain ? 'loginWarn--unknown' : ''}`} title={a.message ?? undefined}>
              <span className="loginWarn__icon">⚠</span>
              <span className="loginWarn__text">
                {a.uncertain
                  ? t('{site} のログインを確認できません', { site: siteLabels[a.siteId] ?? a.siteId })
                  : t('{site} に未ログイン', { site: siteLabels[a.siteId] ?? a.siteId })}
              </span>
              <button className="btn btn--xs" onClick={() => onLogin(a.siteId)}>
                {t('ログイン')}
              </button>
            </div>
          ))}
          {serviceWarnings.map((w) => (
            <div key={`${w.siteId}:${w.service}`} className="loginWarn">
              <span className="loginWarn__icon">⚠</span>
              <span className="loginWarn__text">{w.text}</span>
              <button className="btn btn--xs" onClick={() => w.uncertain ? onOpenSettings('account') : onLoginService(w.siteId, w.service)}>
                {w.uncertain ? t('設定') : t('ログイン')}
              </button>
            </div>
          ))}
          {dgpWarning && (
            <div className="loginWarn">
              <span className="loginWarn__icon">⚠</span>
              <span className="loginWarn__text">{dgpWarning}</span>
              <button className="btn btn--xs" onClick={() => onOpenSettings('account')}>
                {t('確認')}
              </button>
            </div>
          )}
          <button className="link sidebar__sublink" onClick={() => onOpenSettings('account')}>
            {t('アカウントの設定')}
          </button>
        </div>
      )}

      {/* 絞り込みの段が増えると縦に収まらなくなるので、ここだけスクロールさせる。
          ロゴとログイン状態は動かさない。 */}
      <div className="sidebar__scroll">

      {/* 区分（作品の種類）。どのサイトで買ったかとは独立した軸にしてある */}
      <nav className="sidebar__section">
        <button
          className={`floor ${selectedCategories.length === 0 ? 'floor--active' : ''}`}
          onClick={() => onSelectCategories([])}
        >
          <span className="floor__label">{t('すべて')}</span>
          <span className="floor__count">{total.toLocaleString()}</span>
        </button>
        {/* お気に入りは区分と同じ並びに置く。押すと絞り込みが入る */}
        <button
          className={`floor ${favoriteOnly ? 'floor--active' : ''}`}
          onClick={() => onFavoriteOnly(!favoriteOnly)}
          title={t('お気に入りだけを表示')}
        >
          <span className="floor__label">{t('★ お気に入り')}</span>
          <span className="floor__count">{favoriteCount.toLocaleString()}</span>
        </button>
        {/* ♡「使った」。お気に入りとは別の印で、同じように絞り込める */}
        <button
          className={`floor ${usedOnly ? 'floor--active' : ''}`}
          onClick={() => onUsedOnly(!usedOnly)}
          title={t('「使った」だけを表示')}
        >
          <span className="floor__label">{t('♥ 使った')}</span>
          <span className="floor__count">{usedCount.toLocaleString()}</span>
        </button>
        {CATEGORY_ORDER.filter((cat) => countOf(cat) > 0).map((cat) => (
          <button
            key={cat}
            className={`floor ${selectedCategories.includes(cat) ? 'floor--active' : ''}`}
            onClick={() => onSelectCategories(toggle(selectedCategories, cat))}
          >
            <span className="floor__label">{t(CATEGORY_LABELS[cat])}</span>
            <span className="floor__count">{countOf(cat).toLocaleString()}</span>
          </button>
        ))}
      </nav>

      {/* 手元の状態。未取得だけ見てまとめて落とす動線になる */}
      <nav className="sidebar__section">
        <div className="sidebar__heading sidebar__heading--row">
          <span>{t('手元の状態')}</span>
          <button
            className="link sidebar__refresh"
            onClick={onRefreshLocal}
            disabled={!!refreshMessage}
            title={t('ファイルの有無と中身の情報を、手元のファイルからまとめて取り直します')}
          >
            {refreshMessage ? t('更新中…') : t('↻ 最新にする')}
          </button>
        </div>
        {refreshMessage && <div className="muted sidebar__progress">{refreshMessage}</div>}
        <button
          className={`floor ${localState === 'have' ? 'floor--active' : ''}`}
          onClick={() => onLocalState(localState === 'have' ? null : 'have')}
        >
          <span className="floor__label">{t('ダウンロード済み')}</span>
          <span className="floor__count">{localCounts.have.toLocaleString()}</span>
        </button>
        {/* 起動の紐付けが済んだもの（アプリで落としていない、DMM GAMES PLAYER や既存の導入先と紐付けたものを含む） */}
        <button
          className={`floor floor--sub ${localState === 'installed' ? 'floor--active' : ''}`}
          onClick={() => onLocalState(localState === 'installed' ? null : 'installed')}
          title={t('起動の紐付け（インストール）が済んでいるゲーム・ツール。DMM GAMES PLAYER や導入済みプログラムと紐付けたものを含みます')}
        >
          <span className="floor__label">{t('└ インストール済み')}</span>
          <span className="floor__count">{localCounts.installed.toLocaleString()}</span>
        </button>
        {/* 落としたが起動の紐付けがまだのゲーム。インストール待ちを拾う */}
        <button
          className={`floor floor--sub ${localState === 'notInstalled' ? 'floor--active' : ''}`}
          onClick={() => onLocalState(localState === 'notInstalled' ? null : 'notInstalled')}
          title={t('ダウンロード済みで、インストール（起動ファイルの紐付け）がまだのゲーム・ツール（紐付け候補のあるものは除く）')}
        >
          <span className="floor__label">{t('└ 未インストール')}</span>
          <span className="floor__count">{localCounts.notInstalled.toLocaleString()}</span>
        </button>
        {/* 導入済みプログラムや DMM GAMES PLAYER の中に、紐付けられそうな相手が見つかったもの */}
        <button
          className={`floor floor--sub ${localState === 'linkable' ? 'floor--active' : ''}`}
          onClick={() => onLocalState(localState === 'linkable' ? null : 'linkable')}
          title={t('導入済みのプログラムや DMM GAMES PLAYER の中に、起動の紐付けができそうな相手が見つかったゲーム（「最新にする」で探し直します）')}
        >
          <span className="floor__label">{t('└ 紐付け候補あり')}</span>
          <span className="floor__count">{localCounts.linkable.toLocaleString()}</span>
        </button>
        {/* 紐付けたソフトをアンインストール・移動して、起動できなくなったもの */}
        {(localCounts.broken > 0 || localState === 'broken') && (
          <button
            className={`floor floor--sub floor--warn ${localState === 'broken' ? 'floor--active' : ''}`}
            onClick={() => onLocalState(localState === 'broken' ? null : 'broken')}
            title={t('紐付けた起動ファイルやインストール先、DMM GAMES PLAYER のゲームが見つからなくなったもの（アンインストール・移動した可能性があります）')}
          >
            <span className="floor__label">{t('└ リンク切れ')}</span>
            <span className="floor__count">{localCounts.broken.toLocaleString()}</span>
          </button>
        )}
        <button
          className={`floor ${localState === 'none' ? 'floor--active' : ''}`}
          onClick={() => onLocalState(localState === 'none' ? null : 'none')}
        >
          <span className="floor__label">{t('未取得')}</span>
          <span className="floor__count">{localCounts.none.toLocaleString()}</span>
        </button>
      </nav>

      {/* プレイリスト（自分で作る一覧）。押すとそのプレイリストだけを出す */}
      <nav className="sidebar__section">
        <div className="sidebar__heading sidebar__heading--row">
          <span>{t('プレイリスト')}</span>
          <button
            className="link sidebar__refresh"
            onClick={() => setNewPlaylist((v) => (v === null ? '' : null))}
            title={t('新しいプレイリストを作ります')}
          >
            {newPlaylist === null ? t('＋ 作る') : t('やめる')}
          </button>
        </div>
        {newPlaylist !== null && (
          <div className="sidebar__filterRow">
            <input
              className="input input--sm"
              autoFocus
              value={newPlaylist}
              placeholder={t('新しいプレイリストの名前')}
              aria-label={t('新しいプレイリストの名前')}
              onChange={(e) => setNewPlaylist(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createPlaylist();
                if (e.key === 'Escape') setNewPlaylist(null);
              }}
              onBlur={() => void createPlaylist()}
            />
          </div>
        )}
        {playlists.length === 0 && newPlaylist === null && (
          <div className="muted sidebar__progress">{t('一覧で作品を選んで「プレイリストに追加」から作れます。')}</div>
        )}
        {playlists.map((p) =>
          askDelete?.id === p.id ? (
            /* 中身（作品）は消えないことを伝えてから消す。ほかの削除と同じ確認の見た目 */
            <div key={p.id} className="confirm confirm--danger">
              <div>{t('プレイリスト「{name}」を消します。作品そのものは消えません。', { name: p.name })}</div>
              <div className="confirm__row">
                <button className="btn btn--danger btn--xs" onClick={() => void deletePlaylist(p)}>
                  {t('消す')}
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => setAskDelete(null)}>
                  {t('やめる')}
                </button>
              </div>
            </div>
          ) : editPlaylist?.id === p.id ? (
            <div key={p.id} className="sidebar__filterRow">
              <input
                className="input input--sm"
                autoFocus
                value={editPlaylist.name}
                aria-label={t('プレイリストの名前')}
                onChange={(e) => setEditPlaylist({ id: p.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void savePlaylistName();
                  if (e.key === 'Escape') setEditPlaylist(null);
                }}
                onBlur={() => void savePlaylistName()}
              />
            </div>
          ) : (
            <div key={p.id} className={`floor floor--row ${playlistId === p.id ? 'floor--active' : ''}`}>
              <button
                className="floor__main"
                title={t('「{name}」だけを表示')}
                onClick={() => onSelectPlaylist(playlistId === p.id ? null : p.id)}
              >
                <span className="floor__label">{p.name}</span>
                <span className="floor__count">{p.count.toLocaleString()}</span>
              </button>
              <button
                className="floor__act"
                title={t('名前を変える')}
                aria-label={t('名前を変える')}
                onClick={() => setEditPlaylist({ id: p.id, name: p.name })}
              >
                ✎
              </button>
              <button
                className="floor__act"
                title={t('このプレイリストを消す')}
                aria-label={t('このプレイリストを消す')}
                onClick={() => setAskDelete(p)}
              >
                ×
              </button>
            </div>
          )
        )}
      </nav>

      {/* 購入サイト */}
      <nav className="sidebar__section">
        <div className="sidebar__heading">{t('購入サイト')}</div>
        {siteCounts.map((s) => (
          <button
            key={s.siteId}
            className={`floor ${selectedSites.includes(s.siteId) ? 'floor--active' : ''}`}
            onClick={() => onSelectSites(toggle(selectedSites, s.siteId))}
          >
            <span className="floor__label">{siteLabels[s.siteId] ?? s.siteId}</span>
            <span className="floor__count">{s.count.toLocaleString()}</span>
          </button>
        ))}
      </nav>

      {/* 作品の種別。同人はマンガもCGもボイスもゲームも混ざるので、ここで分ける */}
      {workTypes.length > 1 && (
        <nav className="sidebar__section">
          <div className="sidebar__heading">
            {t('種別')}
            {selectedWorkTypes.length > 0 && (
              <button className="link" onClick={() => onSelectWorkTypes([])}>
                {t('解除')}
              </button>
            )}
          </div>
          {workTypes.map((w) => (
            <button
              key={w.workType}
              className={`floor ${
                selectedWorkTypes.includes(w.workType as WorkType) ? 'floor--active' : ''
              }`}
              onClick={() => onSelectWorkTypes(toggle(selectedWorkTypes, w.workType as WorkType))}
            >
              <span className="floor__label">
                {WORK_TYPE_LABELS[w.workType as WorkType] ? t(WORK_TYPE_LABELS[w.workType as WorkType]) : w.workType}
              </span>
              <span className="floor__count">{w.count.toLocaleString()}</span>
            </button>
          ))}
        </nav>
      )}

      {/* 人・シリーズ。詳細画面のクリエイター名を押すとここに入る */}
      {selectedCreators.length > 0 && (
        <nav className="sidebar__section">
          <div className="sidebar__heading">
            {t('人 / シリーズ')}
            <button className="link" onClick={() => onSelectCreators([])}>
              {t('解除')}
            </button>
          </div>
          <div className="sidebar__chips">
            {selectedCreators.map((name) => (
              <button
                key={name}
                className="chip chip--active chip--button"
                onClick={() => onSelectCreators(selectedCreators.filter((v) => v !== name))}
                title={t('この絞り込みを外す')}
              >
                {name} ×
              </button>
            ))}
          </div>
        </nav>
      )}

      <div className="sidebar__section sidebar__section--grow">
        <div className="sidebar__heading">
          {t('ブランド / サークル')}
          {selectedMakers.length > 0 && (
            <button className="link" onClick={() => onSelectMakers([])}>
              {t('解除')}
            </button>
          )}
        </div>
        {selectedMakers.length > 0 && (
          <div className="sidebar__chips">
            {selectedMakers.map((m) => (
              <button
                key={m}
                className="chip chip--active chip--button"
                onClick={() => onSelectMakers(selectedMakers.filter((v) => v !== m))}
                title={t('この絞り込みを外す')}
              >
                {m} ×
              </button>
            ))}
          </div>
        )}
        <div className="sidebar__sortRow">
          <div className="segmented segmented--sm">
            <button
              className={makerSort === 'count' ? 'on' : ''}
              onClick={() => setMakerSort('count')}
            >
              {t('件数')}
            </button>
            <button
              className={makerSort === 'name' ? 'on' : ''}
              onClick={() => setMakerSort('name')}
            >
              {t('名前')}
            </button>
          </div>
          <button
            className="btn btn--dir btn--xs"
            title={makerDir === 'asc' ? t('昇順') : t('降順')}
            onClick={() => setMakerDir(makerDir === 'asc' ? 'desc' : 'asc')}
          >
            {makerDir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
        <div className="sidebar__filterRow">
          <ClearableInput
            value={makerFilter}
            onChange={setMakerFilter}
            placeholder={makerRegex ? t('正規表現で絞り込み') : t('絞り込み')}
            small
          />
          <label className="sidebar__regex" title={t('正規表現で絞り込む（大文字小文字は区別しません）')}>
            <input
              type="checkbox"
              checked={makerRegex}
              onChange={(e) => setMakerRegex(e.target.checked)}
            />
            .*
          </label>
        </div>
        {makerMatch.error && <div className="sidebar__regexError">{t('式が不正です')}</div>}
        <div className="makers">
          {visibleMakers.map((m) => (
            <button
              key={m.maker}
              className={`maker ${selectedMakers.includes(m.maker) ? 'maker--active' : ''}`}
              onClick={() =>
                onSelectMakers(
                  selectedMakers.includes(m.maker)
                    ? selectedMakers.filter((v) => v !== m.maker)
                    : [...selectedMakers, m.maker]
                )
              }
              title={m.maker}
            >
              <span className="maker__name">{m.maker}</span>
              <span className="maker__count">{m.count}</span>
            </button>
          ))}
          {visibleMakers.length === 0 && <div className="muted">{t('該当なし')}</div>}
        </div>
      </div>

      <div className="sidebar__section sidebar__section--grow">
        <div className="sidebar__heading">
          {t('タグ')}
          {selectedTags.length > 0 && (
            <button className="link" onClick={() => onSelectTags([])}>
              {t('解除')}
            </button>
          )}
        </div>
        {selectedTags.length > 0 && (
          <div className="sidebar__chips">
            {selectedTags.map((tItem) => (
              <button
                key={tItem}
                className="chip chip--active chip--button"
                onClick={() => onSelectTags(selectedTags.filter((v) => v !== tItem))}
                title={t('この絞り込みを外す')}
              >
                {t(tItem)} ×
              </button>
            ))}
          </div>
        )}
        <div className="sidebar__filterRow">
          <ClearableInput
            value={tagFilter}
            onChange={setTagFilter}
            placeholder={tagRegex ? t('正規表現でタグを検索') : t('タグを検索')}
            small
          />
          <label className="sidebar__regex" title={t('正規表現で絞り込む（大文字小文字は区別しません）')}>
            <input
              type="checkbox"
              checked={tagRegex}
              onChange={(e) => setTagRegex(e.target.checked)}
            />
            .*
          </label>
        </div>
        {tagMatch.error && <div className="sidebar__regexError">{t('式が不正です')}</div>}
        <div className="makers">
          {visibleTags.map((tItem) => (
            <button
              key={tItem.tag}
              className={`maker ${selectedTags.includes(tItem.tag) ? 'maker--active' : ''}`}
              onClick={() =>
                onSelectTags(
                  selectedTags.includes(tItem.tag)
                    ? selectedTags.filter((v) => v !== tItem.tag)
                    : [...selectedTags, tItem.tag]
                )
              }
              title={tItem.tag}
            >
              <span className="maker__name">{t(tItem.tag)}</span>
              <span className="maker__count">{tItem.count}</span>
            </button>
          ))}
          {visibleTags.length === 0 && <div className="muted">{t('該当なし')}</div>}
        </div>
      </div>

      </div>

    </aside>
  );
}
