import { useEffect, useState } from 'react';
import type { CatalogStatus, CompilationCandidate, CompilationEntryView, CompilationInfo, CompilationMatchView, Product } from '@shared/types';
import { locale, t } from '@shared/i18n';
import { titleCore } from '@shared/compilation';

interface Props {
  product: Product;
  /** 手元の作品・総集編を押したときに、その作品の詳細へ移る */
  onOpenProduct: (id: number) => void;
}

const storeLabel = (store: string): string =>
  store === 'dmm-doujin' ? t('DMM 同人') : store === 'dmm-dlsoft' ? t('DMM PCゲーム') : 'DLsite';

/**
 * 総集編・セットの収録作品。説明文の一覧を、同じサイトの同じサークルの作品一覧（未購入を含む）と照らし合わせたもの。
 * 単独で買っているか・単独では未購入か（総集編で持っているので買い直さなくてよい）を並べる。
 * 読み取りと照らし合わせは自動なので、違っていたら選び直せる。
 */
export default function CompilationSection({ product, onOpenProduct }: Props): JSX.Element | null {
  const [info, setInfo] = useState<CompilationInfo | null>(null);
  /** 選び直す候補を開いている収録作品のタイトル */
  const [picking, setPicking] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void window.api.library.compilation(product.id).then((res) => {
        if (!cancelled) setInfo(res);
      });
    };
    setInfo(null);
    setPicking(null);
    setError(null);
    load();
    const off = window.api.on.compilationsChanged(() => load());
    return () => {
      cancelled = true;
      off();
    };
  }, [product.id]);

  if (!info || (info.entries.length === 0 && info.containedIn.length === 0)) return null;

  const override = (entry: CompilationEntryView, action: 'set' | 'none' | 'clear', productId?: string): void => {
    void window.api.library.setCompilationOverride(product.id, entry.title, action, productId).then((res) => {
      setInfo(res);
      setPicking(null);
    });
  };
  const refreshCatalog = (): void => {
    setRefreshing(true);
    setError(null);
    window.api.library
      .refreshCatalog(product.id)
      .then(setInfo)
      .catch((err: unknown) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)))
      .finally(() => setRefreshing(false));
  };

  const single = info.entries.filter((e) => e.matches.some((m) => m.ownedVia === 'single')).length;
  const notOwned = info.entries.filter((e) => e.matches.length > 0 && e.matches.every((m) => !m.ownedVia)).length;

  return (
    <>
      {info.entries.length > 0 && (
        <div className="detail__section">
          <div className="detail__heading">
            {t('収録作品 {total}（単独で購入済み {single}・単独では未購入 {notOwned}）', { total: info.entries.length, single, notOwned })}
          </div>
          <ol className="compilation">
            {info.entries.map((entry) => (
              <li key={entry.position} className="compilation__entry">
                <span className="compilation__no">{entry.position}</span>
                <div className="compilation__body">
                  <div className="compilation__head">
                    <div className="compilation__title" title={entry.title}>
                      {entry.title}
                    </div>
                    <div className="compilation__actions">
                      <button className="btn btn--xs btn--ghost" onClick={() => setPicking(picking === entry.title ? null : entry.title)}>
                        {picking === entry.title ? t('閉じる') : t('選び直す')}
                      </button>
                      {!entry.manual && entry.matches.length > 0 && (
                        <button className="btn btn--xs btn--ghost" onClick={() => override(entry, 'none')} title={t('この収録作品の結び付けを外す')}>
                          {t('外す')}
                        </button>
                      )}
                      {entry.manual && (
                        <button className="btn btn--xs btn--ghost" onClick={() => override(entry, 'clear')}>
                          {t('自動に戻す')}
                        </button>
                      )}
                    </div>
                  </div>
                  {entry.matches.length === 0 && (
                    <div className="compilation__links muted">
                      {entry.manual ? t('結び付けを外しました') : t('サークルの作品一覧で見つかりませんでした')}
                    </div>
                  )}
                  {entry.matches.map((m) => (
                    <MatchRow key={m.productId} compilationRef={product.id} entry={entry} match={m} onOpenProduct={onOpenProduct} />
                  ))}
                  {picking === entry.title && (
                    <CandidatePicker compilationRef={product.id} entry={entry} onPick={(id) => override(entry, 'set', id)} />
                  )}
                </div>
              </li>
            ))}
          </ol>
          <CatalogNote catalog={info.catalog} refreshing={refreshing} onRefresh={refreshCatalog} />
          {error && <div className="banner banner--error">{error}</div>}
        </div>
      )}

      {info.containedIn.length > 0 && (
        <div className="detail__section">
          <div className="detail__heading">{t('この作品を収録している総集編・セット（所持）')}</div>
          <ul className="compilation compilation--plain">
            {info.containedIn.map((p) => (
              <li key={p.id}>
                <button className="link" onClick={() => onOpenProduct(p.id)} title={p.title}>
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function MatchRow({
  compilationRef,
  entry,
  match: m,
  onOpenProduct
}: {
  compilationRef: number;
  entry: CompilationEntryView;
  match: CompilationMatchView;
  onOpenProduct: (id: number) => void;
}): JSX.Element {
  const owned = m.owned;
  return (
    <div className="compilation__links">
      {owned ? (
        <button
          className={`cstate cstate--button ${m.ownedVia === 'single' ? 'cstate--single' : 'cstate--set'}`}
          onClick={() => onOpenProduct(owned.id)}
          title={owned.title}
        >
          {m.ownedVia === 'single' ? t('単独で購入済み') : t('セットの中身として所持')}
        </button>
      ) : (
        <span className="cstate cstate--none" title={t('この作品は単独では買っていません。この総集編・セットで持っています')}>
          {t('単独では未購入')}
        </span>
      )}
      {m.url ? (
        <button
          className="link compilation__store"
          title={t('ストアの作品ページを開く')}
          onClick={() => void window.api.library.openCompilationItem(compilationRef, m.url!)}
        >
          {titleCore(m.title) !== titleCore(entry.title) ? m.title : t('ストアで見る')} ↗
        </button>
      ) : (
        <span className="muted">{m.productId}</span>
      )}
      {m.alsoIn.map((c) => (
        <button key={c.id} className="link muted" onClick={() => onOpenProduct(c.id)} title={c.title}>
          {t('ほかに「{title}」にも収録', { title: c.title })}
        </button>
      ))}
    </div>
  );
}

function CatalogNote({ catalog, refreshing, onRefresh }: { catalog: CatalogStatus | null; refreshing: boolean; onRefresh: () => void }): JSX.Element {
  if (!catalog) {
    return <p className="muted detail__note">{t('説明文の一覧を読み取って、手元にある同じサークルの作品と照らし合わせています。')}</p>;
  }
  return (
    <p className="muted detail__note">
      {catalog.fetchedAt === null
        ? t('説明文の一覧を読み取っています。{store}のサークルの作品一覧（未購入を含む）はまだ取得していません。', { store: storeLabel(catalog.store) })
        : t('説明文の一覧を、{store}のサークルの作品一覧（未購入を含む {count} 件・{date} 取得）と照らし合わせています。', {
            store: storeLabel(catalog.store),
            count: catalog.count,
            date: new Date(catalog.fetchedAt).toLocaleDateString(locale())
          })}
      {catalog.error && ` ${t('前回は一覧を取れませんでした（{error}）。', { error: catalog.error.slice(0, 80) })}`}{' '}
      <button className="link" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? t('取得中…') : t('一覧を取り直す')}
      </button>
    </p>
  );
}

function CandidatePicker({
  compilationRef,
  entry,
  onPick
}: {
  compilationRef: number;
  entry: CompilationEntryView;
  onPick: (productId: string) => void;
}): JSX.Element {
  const [candidates, setCandidates] = useState<CompilationCandidate[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api.library.compilationCandidates(compilationRef, entry.title).then((res) => {
      if (!cancelled) setCandidates(res);
    });
    return () => {
      cancelled = true;
    };
  }, [compilationRef, entry.title]);

  const current = new Set(entry.matches.map((m) => m.productId));
  const list = (candidates ?? []).filter((c) => !current.has(c.productId));
  return (
    <div className="compilation__picker">
      {candidates === null && <span className="muted">{t('候補を探しています…')}</span>}
      {candidates !== null && list.length === 0 && <span className="muted">{t('タイトルの近い作品が見つかりませんでした')}</span>}
      {list.map((c) => (
        <button key={c.productId} className="compilation__candidate" onClick={() => onPick(c.productId)} title={c.title}>
          <span className="compilation__candidateTitle">{c.title}</span>
          <span className="muted">
            {c.owned ? `${t('所持')} · ` : ''}
            {Math.round((c.score ?? 0) * 100)}%
          </span>
        </button>
      ))}
    </div>
  );
}
