import { t } from '@shared/i18n';
import type { DgpSummary } from '@shared/types';
import { useCallback,useEffect,useState } from 'react';

/** DMM Player（ダウンロードした動画を開く公式プレイヤー）が入っているか */
export function DmmPlayerAccountRow(): JSX.Element | null {
  const [status, setStatus] = useState<{ installed: boolean; exe: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(() => {
    setChecking(true);
    void window.api.install
      .dmmPlayerStatus()
      .then(setStatus)
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);
  if (!status) return null;
  return (
    <div className="account">
      <span className={`status-dot ${status.installed ? 'status-dot--on' : ''}`} />
      <b className="account__site">DMM Player</b>
      <span className="muted" title={status.exe ?? undefined}>
        {status.installed ? t('入っています（ダウンロードした動画はこれで開きます）') : t('入っていません（ダウンロードした動画を開くには必要です）')}
      </span>
      <span className="account__actions">
        <button className="btn btn--xs btn--ghost" disabled={checking} onClick={check}>
          {checking ? t('確認中…') : t('確かめ直す')}
        </button>
      </span>
    </div>
  );
}

/** 同人・CG などの総集編の収録作品を推定するか（実験的） */
export function CompilationGuessRow(): JSX.Element | null {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void window.api.library.compilationGuess().then(setOn);
  }, []);
  if (on === null) return null;
  return (
    <>
      <label className="settings__row check">
        <input
          type="checkbox"
          checked={on}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.checked;
            setSaving(true);
            void window.api.library
              .setCompilationGuess(next)
              .then(setOn)
              .finally(() => setSaving(false));
          }}
        />
        <span>{t('同人・CG などの総集編から収録作品を推定する（実験的）')}</span>
      </label>
      <p className="muted detail__note">
        {t('説明文の一覧を読み取り、同じサークルの作品一覧と照らし合わせて推定します。説明文の書き方は作品ごとにまちまちなので、取りこぼしや誤りがあり、精度は保証しません。オフのときは、推定した収録作品・結び付き・「総集編」の印を出しません。PCゲームのセット商品など、はっきり分かるものはこの設定に関係なく出します。')}
      </p>
    </>
  );
}

/** 専用作品の起動に必要なDMM GAMES PLAYERの導入状況。 */
export function DgpAccountRow(): JSX.Element | null {
  const [dgp, setDgp] = useState<DgpSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(() => {
    setChecking(true);
    void window.api.install
      .dgpSummary()
      .then(setDgp)
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);
  if (!dgp) return null;
  const warn = !dgp.installed && dgp.dgpOnly > 0;
  return (
    <>
      <div className={`account ${warn ? 'account--warn' : ''}`}>
        <span className={`status-dot ${dgp.installed ? 'status-dot--on' : ''}`} />
        <b className="account__site">DMM GAMES PLAYER</b>
        <span className={dgp.installed ? 'muted' : 'account__state'} title={dgp.exe ?? undefined}>
          {dgp.installed ? t('入っています') : t('入っていません')}
          {dgp.dgpOnly > 0 && t('（専用の作品 {count} 件・紐付け済み {linked} 件）', { count: dgp.dgpOnly, linked: dgp.linked })}
        </span>
        <span className="account__actions">
          {dgp.installed && (
            <button className="btn btn--xs" onClick={() => void window.api.install.openDgp()}>
              {t('開く')}
            </button>
          )}
          <button className="btn btn--xs btn--ghost" disabled={checking} onClick={check}>
            {checking ? t('確認中…') : t('確かめ直す')}
          </button>
        </span>
      </div>
      {warn && (
        <p className="muted detail__note">
          {t('「DMM GAMES PLAYER専用」の作品は、DMM GAMES PLAYER でインストール・起動します。DMM の公式サイトから DMM GAMES PLAYER を入れ、その中で作品をインストールしてから、詳細の「インストール・起動」で紐付けてください。')}
        </p>
      )}
    </>
  );
}

