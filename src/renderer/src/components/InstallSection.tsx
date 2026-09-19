import { useCallback, useEffect, useRef, useState } from 'react';
import type { DgpStatus, InstallAnalysis, InstalledProgram, Product } from '@shared/types';
import { formatBytes } from '../lib/format';
import { locale, t } from '@shared/i18n';

interface Props {
  product: Product;
  onChanged: (product: Product) => void;
}

const TYPE_LABELS: Record<InstallAnalysis['type'], string> = {
  installer: t('インストールが必要そうです'),
  installer_with_files: t('インストーラと本体が並んでいます（コピーするだけのことが多い）'),
  portable: t('インストールせずに動かせそうです'),
  patch: t('本体に当てる追加データ・パッチのようです'),
  unknown: t('判定できませんでした')
};

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const relTo = (folder: string, p: string): string =>
  p.toLowerCase().startsWith(folder.toLowerCase()) ? p.slice(folder.length).replace(/^[\\/]/, '') : p;

/**
 * インストール・起動（DESIGN-download.md §8 / Phase 2）。
 * 判定は初期値にすぎないので、どの型でも「インストーラを実行」「そのまま使う」「導入済みと紐付ける」を全部選べる。
 * **インストーラの自動実行はしない。** 既存の導入と紐付けるかどうかも、必ずユーザーが選ぶ。
 */
export default function InstallSection({ product, onChanged }: Props): JSX.Element | null {
  const [analyses, setAnalyses] = useState<InstallAnalysis[]>([]);
  const [analyzing, setAnalyzing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ranInstaller, setRanInstaller] = useState(false);
  const [picked, setPicked] = useState<InstallAnalysis | null>(null);
  const [programsOpen, setProgramsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = useRef(product.id);

  // 作品を切り替えたら、前の作品の判定を残さない
  useEffect(() => {
    current.current = product.id;
    setAnalyses([]);
    setAnalyzing(true);
    setError(null);
    setRanInstaller(false);
    setPicked(null);
    setProgramsOpen(false);
  }, [product.id]);

  const reload = useCallback(async () => {
    const id = product.id;
    setAnalyzing(true);
    try {
      const list = await window.api.install.analyze(id);
      if (current.current === id) setAnalyses(list);
    } finally {
      if (current.current === id) setAnalyzing(false);
    }
  }, [product.id]);

  useEffect(() => {
    void reload();
    const off = window.api.on.filesChanged((p) => {
      if (p.productRef === product.id) void reload();
    });
    const offContent = window.api.on.contentUpdated((p) => {
      if (p.productRef === product.id) void reload();
    });
    return () => {
      off();
      offContent();
    };
  }, [reload, product.id]);

  const run = async (fn: () => Promise<Product | null | string>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (result && typeof result === 'object') onChanged(result);
      if (typeof result === 'string' && result) setError(result);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
    } finally {
      setBusy(false);
    }
  };

  const inst = product.installation;
  // 紐付けたソフトをアンインストール・移動していないか、詳細を開いたときに確かめる
  const hasInst = !!inst;
  useEffect(() => {
    if (!hasInst) return;
    let cancelled = false;
    void window.api.install.checkLink(product.id).then((updated) => {
      if (updated && !cancelled) onChanged(updated);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id, hasInst]);
  const dgpOnly = isDgpOnly(product);
  // DLsite は VJ（PCゲーム区分）にボイス作品なども入るので、区分ではなく種別で見る。
  // 種別が分からない作品でも、展開した中身に実行ファイルがあれば出す
  const isGameLike =
    product.workType === 'game' ||
    product.workType === 'tool' ||
    (product.category === 'game' && (!product.workType || product.workType === 'other')) ||
    dgpOnly ||
    analyses.some((a) => a.executables.length > 0 || a.installers.length > 0);
  if (!inst && !isGameLike) return null;

  return (
    <div className="detail__section">
      <div className="detail__heading">{t('インストール・起動')}</div>
      {error && <div className="banner banner--error">{error}</div>}
      {inst?.state === 'broken' && (
        <div className="banner banner--warn">
          {inst.kind === 'dmm_game_player'
            ? t('リンク切れ: DMM GAMES PLAYER にこのゲームが見つかりません。アンインストールした場合は紐付けを外してください。入れ直したら「最新にする」で戻ります。')
            : t('リンク切れ: 紐付けた起動ファイル・インストール先が見つかりません。アンインストール・移動した場合は、紐付けを外すか、起動ファイルを選び直してください。')}
        </div>
      )}
      {(!inst || inst.state === 'broken') && product.linkCandidate && (
        <p className="muted detail__note">
          {product.linkCandidate.kind === 'dgp'
            ? t('紐付け候補: DMM GAMES PLAYER に入っている「{name}」', { name: product.linkCandidate.name })
            : t('紐付け候補: 導入済みのプログラム「{name}」（「導入済みプログラムと紐付ける…」から選べます）', { name: product.linkCandidate.name })}
        </p>
      )}

      {inst ? (
        <div className="install">
          <div className="install__name">{inst.displayName ?? baseName(inst.executablePath ?? inst.installPath ?? '')}</div>
          <div className="muted install__path" title={inst.executablePath ?? ''}>
            {inst.kind === 'dmm_game_player' ? (inst.installPath ?? '') : (inst.executablePath ?? t('（起動ファイル未指定）'))}
          </div>
          <div className="muted">
            {inst.kind === 'linked_existing' ? t('導入済みプログラムと紐付け') : inst.notes ?? t('このアプリで紐付け')}
            {inst.lastLaunchedAt ? t(' ・ 最終起動 {0}', { 0: new Date(inst.lastLaunchedAt).toLocaleString(locale()) }) : ''}
          </div>
          <div className="install__actions">
            <button
              className="btn btn--primary"
              disabled={busy || (!inst.executablePath && inst.kind !== 'dmm_game_player')}
              onClick={() => void run(() => window.api.install.launch(product.id))}
              title={inst.kind === 'dmm_game_player' ? t('DMM GAMES PLAYER に起動してもらいます') : undefined}
            >
              {t('▶ 起動')}
            </button>
            {(inst.executablePath || inst.installPath) && (
              <button className="btn btn--sm" onClick={() => void window.api.showInFolder(inst.executablePath ?? inst.installPath!)}>
                {t('場所')}
              </button>
            )}
            {inst.kind !== 'dmm_game_player' && (
            <button
              className="btn btn--sm"
              onClick={() =>
                void run(async () => {
                  const exe = await window.api.install.pickExe(inst.installPath ?? undefined);
                  if (!exe) return null;
                  return inst.kind === 'linked_existing'
                    ? window.api.install.linkExisting(
                        product.id,
                        {
                          key: inst.uninstallKey ?? '',
                          displayName: inst.displayName ?? '',
                          publisher: null,
                          installLocation: inst.installPath,
                          displayIcon: null,
                          version: inst.version,
                          score: 1
                        },
                        exe
                      )
                    : window.api.install.linkInstalled(product.id, inst.installPath ?? exe.replace(/[\\/][^\\/]+$/, ''), exe);
                })
              }
            >
              {t('起動ファイルを変更')}
            </button>
            )}
            <button className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.install.unlink(product.id))}>
              {t('紐付けを外す')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {dgpOnly && <DgpChoice product={product} busy={busy} onLink={(id) => void run(() => window.api.install.linkDgp(product.id, id))} />}
          {analyzing && analyses.length === 0 && !dgpOnly && <p className="muted detail__note">{t('展開したフォルダを確認しています…')}</p>}
          {!analyzing && analyses.length === 0 && !dgpOnly && (
            <p className="muted detail__note">
              {t('展開したフォルダがありません。ダウンロードしたアーカイブを「展開」すると、インストールが必要か判定して起動方法を選べます。')}
            </p>
          )}
          {analyses.map((a) => (
            <FolderChoice
              key={a.folder}
              analysis={a}
              busy={busy}
              onRunInstaller={(installer) =>
                void run(async () => {
                  const msg = await window.api.install.runInstaller(product.id, installer);
                  if (!msg) setRanInstaller(true);
                  return msg;
                })
              }
              onUse={(exe) => void run(() => window.api.install.useFolder(product.id, a.folder, exe))}
              onUseAndLaunch={(exe) =>
                void run(async () => {
                  // インストール不要の作品は「起動」＝このファイルで紐付け＋起動。一度起動すれば未インストールの一覧から外れる
                  await window.api.install.useFolder(product.id, a.folder, exe);
                  return window.api.install.launch(product.id);
                })
              }
            />
          ))}

          {ranInstaller && (
            <div className="confirm">
              {t('インストールが終わったら、導入した場所を教えてください。')}
              <div className="confirm__row">
                <button
                  className="btn btn--xs btn--primary"
                  onClick={() => void window.api.install.pickFolder().then((res) => setPicked(res))}
                >
                  {t('導入先のフォルダを選ぶ…')}
                </button>
                <button className="btn btn--xs" onClick={() => setProgramsOpen(true)}>
                  {t('導入済みプログラムの一覧から選ぶ…')}
                </button>
              </div>
            </div>
          )}

          {picked && (
            <div className="confirm">
              <div className="muted" title={picked.folder}>
                {picked.folder}
              </div>
              <ExePicker
                folder={picked.folder}
                candidates={[...picked.executables.map((e) => e.path), ...picked.htmlEntries]}
                busy={busy}
                actionLabel={t('この起動ファイルで紐付ける')}
                onPick={(exe) =>
                  void run(async () => {
                    const res = await window.api.install.linkInstalled(product.id, picked.folder, exe);
                    setPicked(null);
                    setRanInstaller(false);
                    return res;
                  })
                }
              />
            </div>
          )}

          <div className="install__actions">
            <button className="btn btn--sm" onClick={() => setProgramsOpen(true)}>
              {t('導入済みプログラムと紐付ける…')}
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => void window.api.install.pickFolder().then((res) => setPicked(res))}>
              {t('別の場所にあるフォルダを選ぶ…')}
            </button>
          </div>
        </>
      )}

      {programsOpen && (
        <ProgramPicker
          product={product}
          onClose={() => setProgramsOpen(false)}
          onLinked={(p) => {
            setProgramsOpen(false);
            setRanInstaller(false);
            onChanged(p);
          }}
        />
      )}
    </div>
  );
}

function FolderChoice({
  analysis,
  busy,
  onRunInstaller,
  onUse,
  onUseAndLaunch
}: {
  analysis: InstallAnalysis;
  busy: boolean;
  onRunInstaller: (installer: string) => void;
  onUse: (exe: string) => void;
  onUseAndLaunch: (exe: string) => void;
}): JSX.Element {
  const a = analysis;
  return (
    <div className="install">
      <div className="install__type">
        <span className={`tag ${a.type === 'portable' ? 'tag--ok' : ''}`}>{TYPE_LABELS[a.type]}</span>
      </div>
      <div className="muted install__path" title={a.folder}>
        {a.folder}
      </div>
      <ul className="install__reasons">
        {a.reasons.map((r) => (
          <li key={r} className="muted">
            {r}
          </li>
        ))}
      </ul>
      {a.readmes.length > 0 && (
        <div className="install__readmes">
          <span className="muted">{t('お読みください:')}</span>
          {a.readmes.map((r) => (
            <button key={r} className="link" onClick={() => void window.api.openPath(r)} title={r}>
              {baseName(r)}
            </button>
          ))}
        </div>
      )}

      {a.installers.length > 0 && (
        <div className="install__block">
          <div className="muted">
            {a.type === 'patch'
              ? t('アップデータを実行（本体の導入先を指定するよう求められることがあります）')
              : t('インストーラを実行（自分で操作します。自動では進めません）')}
          </div>
          {a.installers.map((i) => (
            <button key={i.path} className="btn btn--sm" disabled={busy} onClick={() => onRunInstaller(i.path)} title={i.path}>
              {t('{0}（{1}）を実行', { 0: relTo(a.folder, i.path), 1: formatBytes(i.size) })}
            </button>
          ))}
        </div>
      )}

      <div className="install__block">
        <div className="muted">{t('このフォルダをそのまま使う（インストール不要）')}</div>
        <ExePicker
          folder={a.folder}
          candidates={[...a.executables.map((e) => e.path), ...a.htmlEntries]}
          busy={busy}
          actionLabel={t('紐付けだけ')}
          onPick={onUse}
          launchLabel={t('▶ 起動')}
          onLaunch={onUseAndLaunch}
        />
      </div>
    </div>
  );
}

function ExePicker({
  folder,
  candidates,
  busy,
  actionLabel,
  onPick,
  launchLabel,
  onLaunch
}: {
  folder: string;
  candidates: string[];
  busy: boolean;
  actionLabel: string;
  onPick: (exe: string) => void;
  /** 選んだファイルで紐付けてそのまま起動する（インストール不要の作品向け） */
  launchLabel?: string;
  onLaunch?: (exe: string) => void;
}): JSX.Element {
  const [choice, setChoice] = useState(candidates[0] ?? '');
  // 候補の配列は描画のたびに作り直されるので、中身が変わったときだけ選び直す
  const signature = candidates.join('\n');
  useEffect(() => setChoice(candidates[0] ?? ''), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="confirm__row">
      <select className="select select--xs install__select" value={choice} onChange={(e) => setChoice(e.target.value)}>
        {candidates.length === 0 && <option value="">{t('（候補が見つかりません）')}</option>}
        {candidates.map((c) => (
          <option key={c} value={c}>
            {relTo(folder, c)}
          </option>
        ))}
      </select>
      <button
        className="btn btn--xs"
        onClick={() =>
          void window.api.install.pickExe(folder).then((exe) => {
            if (exe) onPick(exe);
          })
        }
      >
        {t('参照…')}
      </button>
      {onLaunch && (
        <button className="btn btn--xs btn--primary" disabled={busy || !choice} onClick={() => onLaunch(choice)} title={t('このファイルで紐付けて起動します')}>
          {launchLabel ?? t('起動')}
        </button>
      )}
      <button className={`btn btn--xs ${onLaunch ? '' : 'btn--primary'}`} disabled={busy || !choice} onClick={() => onPick(choice)}>
        {actionLabel}
      </button>
    </div>
  );
}

/** 「DMM GAMES PLAYER専用」のタグが付いた作品か。紐付けの導線はこの作品にだけ出す */
function isDgpOnly(product: Product): boolean {
  return product.tags.some((tItem) => tItem.includes('DMM GAMES PLAYER専用'));
}

const folderName = (p: string | null, fallback: string): string => (p ? baseName(p) : fallback);

/**
 * DMM GAMES PLAYER に入っているゲームと紐付ける。起動は DMM GAMES PLAYER に頼む（ログイン情報は読まない）。
 * DMM GAMES PLAYER 側の ID は作品IDと別物なので、近い順に並べて**ユーザーに選んでもらう**。
 */
function DgpChoice({
  product,
  busy,
  onLink
}: {
  product: Product;
  busy: boolean;
  onLink: (dgpProductId: string) => void;
}): JSX.Element | null {
  const [status, setStatus] = useState<DgpStatus | null>(null);
  const [choice, setChoice] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void window.api.install.dgpStatus(product.id).then((s) => {
      if (cancelled) return;
      setStatus(s);
      setChoice(s.games[0]?.productId ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  return (
    <div className="install">
      <div className="install__type">
        <span className="tag">DMM GAMES PLAYER</span>
        <span className="muted"> {t('この作品は DMM GAMES PLAYER 専用です')}</span>
      </div>
      {!status && <p className="muted">{t('DMM GAMES PLAYER を確認しています…')}</p>}
      {status && !status.installed && (
        <p className="muted detail__note">
          {t('DMM GAMES PLAYER が見つかりません。DMM GAMES PLAYER をインストールし、その中でこの作品をインストールしてから紐付けてください。')}
        </p>
      )}
      {status && status.installed && status.games.length === 0 && (
        <div className="install__block">
          <p className="muted detail__note">
            {t('{0} まず DMM GAMES PLAYER でインストールしてください。', { 0: status.message ?? t('DMM GAMES PLAYER にゲームが入っていません。') })}
          </p>
          <button className="btn btn--sm" onClick={() => void window.api.install.openDgp()}>
            {t('DMM GAMES PLAYER を開く')}
          </button>
        </div>
      )}
      {status && status.installed && status.games.length > 0 && (
        <div className="install__block">
          <div className="muted">
            {t('DMM GAMES PLAYER に入っているゲームから選んでください（DMM GAMES PLAYER 側には作品名が無いので、フォルダ名で近い順に並べています）。見つからなければ DMM GAMES PLAYER でインストールしてから選び直してください。')}
          </div>
          <div className="confirm__row">
            <select className="select select--xs install__select" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {status.games.map((g) => (
                <option key={g.productId} value={g.productId}>
                  {t('{0}（{1}・{productId}）{3}', { 0: folderName(g.path, g.productId), 1: /MAIN$/i.test(g.gameType) ? t('PCゲーム') : t('オンライン'), productId: g.productId, 3: g.score >= 0.4 ? t(' ★近い') : '' })}
                </option>
              ))}
            </select>
            <button className="btn btn--xs btn--primary" disabled={busy || !choice} onClick={() => onLink(choice)}>
              {t('紐付ける')}
            </button>
            <button className="btn btn--xs" onClick={() => void window.api.install.openDgp()}>
              {t('DMM GAMES PLAYER を開く')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** レジストリの「プログラムと機能」から選ぶ。近い順に並べるが、決めるのはユーザー */
function ProgramPicker({
  product,
  onClose,
  onLinked
}: {
  product: Product;
  onClose: () => void;
  onLinked: (p: Product) => void;
}): JSX.Element {
  const [programs, setPrograms] = useState<InstalledProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<InstalledProgram | null>(null);
  const [exes, setExes] = useState<{ folder: string | null; executables: string[] } | null>(null);

  useEffect(() => {
    window.api.install
      .programs(product.id)
      .then(setPrograms)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [product.id]);

  useEffect(() => {
    setExes(null);
    if (selected) void window.api.install.programExes(selected).then(setExes);
  }, [selected]);

  const shown = (programs ?? [])
    .filter((p) => !filter || `${p.displayName} ${p.publisher ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 200);

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel modal__panel--wide">
        <div className="modal__head">
          <h3>{t('導入済みプログラムと紐付ける')}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>
        <p className="muted">
          {t('「{title}」に近い順に並べています。同じ名前でも購入元が違うと別物のことがあるので、確かめてから選んでください。', { title: product.title })}
        </p>
        <input className="input" placeholder={t('名前で絞り込む')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <div className="banner banner--error">{error}</div>}
        {!programs && !error && <p className="muted">{t('一覧を読み込んでいます…')}</p>}
        <div className="programs">
          {shown.map((p) => (
            <button
              key={`${p.key}`}
              className={`program ${selected?.key === p.key ? 'program--selected' : ''}`}
              onClick={() => setSelected(p)}
            >
              <span className="program__name">{p.displayName}</span>
              <span className="muted program__sub">
                {[p.publisher, p.version, p.installLocation].filter(Boolean).join(t(' ・ '))}
              </span>
              {p.score >= 0.5 && <span className="tag tag--ok">{t('近い')}</span>}
            </button>
          ))}
        </div>
        {selected && (
          <div className="confirm">
            <div>
              <b>{selected.displayName}</b> {t('と紐付けます。')}
            </div>
            {exes && exes.folder && (
              <ExePicker
                folder={exes.folder}
                candidates={exes.executables}
                busy={false}
                actionLabel={t('紐付ける')}
                onPick={(exe) =>
                  void window.api.install.linkExisting(product.id, selected, exe).then((p) => p && onLinked(p))
                }
              />
            )}
            {exes && !exes.folder && (
              <div className="confirm__row">
                <span className="muted">{t('導入先が登録されていません。')}</span>
                <button
                  className="btn btn--xs"
                  onClick={() =>
                    void window.api.install.pickExe().then((exe) => {
                      if (exe) void window.api.install.linkExisting(product.id, selected, exe).then((p) => p && onLinked(p));
                    })
                  }
                >
                  {t('起動ファイルを選ぶ…')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
