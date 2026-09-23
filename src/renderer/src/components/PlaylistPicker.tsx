import { useEffect, useRef, useState } from 'react';
import type { Playlist } from '@shared/types';
import { t } from '@shared/i18n';

interface Props {
  /** 入れる作品 */
  ids: number[];
  playlists: Playlist[];
  onClose: () => void;
  /** 入れ終わったら（足した数と、入れたプレイリスト） */
  onAdded?: (added: number, playlist: Playlist) => void;
}

/**
 * 選んだ作品をプレイリストに入れる小窓。
 * すでにあるプレイリストを選ぶか、名前を書いて新しく作る（作るのと入れるのを1回で済ませる）。
 */
export default function PlaylistPicker({ ids, playlists, onClose, onAdded }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (playlists.length === 0) inputRef.current?.focus();
  }, [playlists.length]);

  const run = async (work: () => Promise<{ added: number; playlist: Playlist }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { added, playlist } = await work();
      onAdded?.(added, playlist);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addTo = (playlist: Playlist): Promise<void> =>
    run(async () => ({ added: await window.api.playlists.add(playlist.id, ids), playlist }));

  const createAndAdd = (): Promise<void> =>
    run(async () => {
      const playlist = await window.api.playlists.create(name, ids);
      return { added: ids.length, playlist };
    });

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('プレイリストに追加')}>
      <div className="modal__panel">
        <div className="modal__head">
          <h3>{t('プレイリストに追加（{0} 件）', { 0: ids.length.toLocaleString() })}</h3>
          <button className="detail__close" aria-label={t('閉じる')} onClick={onClose}>
            ×
          </button>
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        <div className="playlistpick">
          {playlists.length === 0 && <p className="muted">{t('プレイリストはまだありません。名前を書いて作れます。')}</p>}
          {playlists.map((p) => (
            <button key={p.id} className="btn playlistpick__item" disabled={busy} onClick={() => void addTo(p)}>
              <span className="playlistpick__name">{p.name}</span>
              <span className="muted">{t('{0} 件', { 0: p.count.toLocaleString() })}</span>
            </button>
          ))}
        </div>

        <div className="dlbar">
          <input
            ref={inputRef}
            className="findbar__input"
            value={name}
            placeholder={t('新しいプレイリストの名前')}
            aria-label={t('新しいプレイリストの名前')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void createAndAdd();
            }}
          />
          <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void createAndAdd()}>
            {t('作って追加')}
          </button>
        </div>
      </div>
    </div>
  );
}
