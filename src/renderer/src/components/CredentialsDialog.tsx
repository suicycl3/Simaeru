import { useCallback, useEffect, useState } from 'react';
import type { CredentialSummary } from '@shared/types';
import { locale, t } from '@shared/i18n';

interface Props {
  siteId: string;
  siteLabel: string;
  onClose: () => void;
}

/**
 * サイトのログイン情報を保存する小さなダイアログ。
 *
 * 値は OS の保護領域（Windows なら DPAPI）で暗号化してから保存する。平文では持たない。
 * 保存した情報は「ログイン画面を開いたときの自動入力」と「コピー」に使うだけで、
 * ログインボタンを自動で押すことはしない（2段階認証や規約同意が挟まるため）。
 */
export default function CredentialsDialog({ siteId, siteLabel, onClose }: Props): JSX.Element {
  const [available, setAvailable] = useState(true);
  const [summary, setSummary] = useState<CredentialSummary | null>(null);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await window.api.credentials.list();
    setAvailable(list.available);
    const current = list.items.find((i) => i.siteId === siteId) ?? null;
    setSummary(current);
    setLoginId(current?.loginId ?? '');
  }, [siteId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      // パスワード欄が空のままなら、IDだけ更新して既存のパスワードは残す
      const next = password || (await window.api.credentials.reveal(siteId)).password || '';
      if (!loginId || !next) {
        setError(t('ログインIDとパスワードの両方が必要です。'));
        return;
      }
      await window.api.credentials.save(siteId, loginId, next);
      setPassword('');
      // 保存は読み戻しまで確かめてから返ってくる。失敗なら例外になって下の catch に落ちる
      setMessage(t('保存しました。読み戻して確認済みです（DBと控えファイルの二重に暗号化して保存）。'));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyPassword = async (): Promise<void> => {
    const { password: stored } = await window.api.credentials.reveal(siteId);
    if (!stored) {
      setError(t('保存されたパスワードがありません。'));
      return;
    }
    await navigator.clipboard.writeText(stored);
    setMessage(t('パスワードをクリップボードにコピーしました。'));
  };

  const clear = async (): Promise<void> => {
    await window.api.credentials.clear(siteId);
    setPassword('');
    setLoginId('');
    setMessage(t('保存した情報を削除しました。'));
    await reload();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel">
        <div className="modal__head">
          <h3>{t('{siteLabel} のログイン情報', { siteLabel })}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>

        {/* 「保存されていない」と誤解されやすいので、状態を先に出す。
            パスワードは復号できても画面には出さない（コピーか自動入力で使う）。 */}
        {summary?.unreadable ? (
          <div className="banner banner--error">
            {t('保存済みの情報を読み出せませんでした。お手数ですが、もう一度入力して保存してください。')}
          </div>
        ) : (
          <p className={summary?.hasPassword ? 'muted' : 'muted detail__note'}>
            {summary?.hasPassword
              ? t('保存済み（{0} 更新）。ログイン画面で自動入力します。', { 0: summary.updatedAt ? new Date(summary.updatedAt).toLocaleString(locale()) : '' })
              : t('まだ保存されていません。')}
          </p>
        )}

        {!available && (
          <div className="banner banner--error">
            {t('この環境では暗号化して保存できないため、保存は無効です。')}
          </div>
        )}

        <label className="field">
          <span>{t('ログインID / メールアドレス')}</span>
          <input
            type="text"
            value={loginId}
            autoComplete="off"
            onChange={(e) => setLoginId(e.target.value)}
            placeholder="example@example.com"
          />
        </label>

        <label className="field">
          <span>
            {t('パスワード{0}', { 0: summary?.hasPassword ? t('（保存済み。変更しないなら空のまま）') : '' })}
          </span>
          <div className="field__row">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
              placeholder={summary?.hasPassword ? '••••••••' : ''}
            />
            <button className="btn btn--xs" onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? t('隠す') : t('表示')}
            </button>
          </div>
        </label>

        {message && <p className="muted">{message}</p>}
        {error && <div className="banner banner--error">{error}</div>}

        <p className="muted detail__note">
          {t('保存した情報はこのPCのこのユーザーだけが復号できる形で暗号化されます。ログイン画面を開いたときに入力欄へ自動で入れますが、ログインボタンは押しません。')}
        </p>

        <div className="modal__actions">
          {summary?.hasPassword && (
            <>
              <button className="btn" onClick={() => void copyPassword()}>
                {t('パスワードをコピー')}
              </button>
              <button className="btn btn--ghost" onClick={() => void clear()}>
                {t('削除')}
              </button>
            </>
          )}
          <button className="btn btn--primary" disabled={!available} onClick={() => void save()}>
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  );
}
