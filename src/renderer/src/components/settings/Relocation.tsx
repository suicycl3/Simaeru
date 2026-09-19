import { t } from '@shared/i18n';
import type { RelocationPlan } from '@shared/types';
import { useState } from 'react';
import { formatBytes } from '../../lib/format';

/** 保存先・フォルダ構成に合わせて移す。何を・どこへ・どれくらいを見せてから選んで実行する */
export default function Relocation({
  plan,
  reason,
  onDone,
  onCancel
}: {
  plan: RelocationPlan;
  reason: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set(plan.items.map((i) => i.from)));
  const [showAll, setShowAll] = useState(false);
  const chosen = plan.items.filter((i) => selected.has(i.from));
  const bytes = chosen.reduce((s, i) => s + i.bytes, 0);
  const cross = chosen.filter((i) => i.crossDevice).reduce((s, i) => s + i.bytes, 0);
  const shown = showAll ? plan.items : plan.items.slice(0, 8);
  const rel = (p: string): string => p.replace(plan.root, '…');

  return (
    <div className="confirm relocation">
      <div>
        {t('{reason} 既存のファイル', { reason })} <b>{t('{length} 件（{1}）', { length: plan.items.length, 1: formatBytes(plan.totalBytes) })}</b> {t('を、今の保存先・フォルダ構成へ移しますか？')}
      </div>
      {plan.crossDeviceBytes > 0 && (
        <div className="muted">
          {t('うち {0} は別のドライブへの移動です。複製して中身を照らし合わせてから元を消すので、時間がかかります。', { 0: formatBytes(plan.crossDeviceBytes) })}
        </div>
      )}
      <div className="relocation__list">
        {shown.map((i) => (
          <label key={i.from} className="check relocation__item" title={`${i.from}\n→ ${i.to}`}>
            <input
              type="checkbox"
              checked={selected.has(i.from)}
              onChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(i.from)) next.delete(i.from);
                  else next.add(i.from);
                  return next;
                })
              }
            />
            <span className="relocation__title">
              {i.kind === 'folder' ? '📁 ' : ''}
              {i.title}
            </span>
            <span className="muted relocation__to">→ {rel(i.to)}</span>
            <span className="muted">{formatBytes(i.bytes)}</span>
          </label>
        ))}
        {plan.items.length > shown.length && (
          <button className="link" onClick={() => setShowAll(true)}>
            {t('ほか {0} 件を表示', { 0: plan.items.length - shown.length })}
          </button>
        )}
      </div>
      {plan.skipped.length > 0 && <div className="muted">{t('{length} 件はダウンロード中などのため対象外です。', { length: plan.skipped.length })}</div>}
      <div className="confirm__row">
        <button
          className="btn btn--xs btn--primary"
          disabled={chosen.length === 0}
          onClick={() =>
            void window.api.download.relocate(chosen.map((i) => i.from)).then(() =>
              onDone(t('{length} 件（{1}{2}）の移動を始めました。進みぐあいは「ダウンロード → 展開・変換」で見られます。', { length: chosen.length, 1: formatBytes(bytes), 2: cross ? t('・うち別ドライブ {0}', { 0: formatBytes(cross) }) : '' }))
            )
          }
        >
          {t('選んだ {length} 件を移動する', { length: chosen.length })}
        </button>
        <button className="btn btn--xs btn--ghost" onClick={onCancel}>
          {t('移動しない')}
        </button>
      </div>
    </div>
  );
}

