import { PAGE_SPEEDS, SHARPEN_LABELS, useViewerPrefs } from '../../lib/viewerPrefs';
import { t } from '@shared/i18n';

/** 画像ビューアの表示とページ送りの設定。設定画面とビューアのメニューで同じものを使う */
export default function ViewerPrefsFields(): JSX.Element {
  const [prefs, setPrefs] = useViewerPrefs();
  // 選択肢に無い値が入っていたら、いちばん近いものを選んでおく
  const speed = PAGE_SPEEDS.reduce((best, s) =>
    Math.abs(s.ms - prefs.pageInterval) < Math.abs(best.ms - prefs.pageInterval) ? s : best
  );
  return (
    <>
      <div className="settings__row">
        <span className="settings__label">{t('ページ送りの速さ')}</span>
        <select
          className="select select--xs"
          value={speed.ms}
          onChange={(e) => setPrefs({ pageInterval: Number(e.target.value) })}
        >
          {PAGE_SPEEDS.map((s) => (
            <option key={s.ms} value={s.ms}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted detail__note">
        {t('ホイールを回し続けたり、キーを押し続けたりしたときに、どのくらいの間隔でページをめくるか。')}
      </p>
      <div className="settings__row">
        <span className="settings__label">{t('ホイールの向き')}</span>
        <select
          className="select select--xs"
          value={prefs.wheelInvert ? 'up' : 'down'}
          onChange={(e) => setPrefs({ wheelInvert: e.target.value === 'up' })}
        >
          <option value="down">{t('下に回すと次のページ')}</option>
          <option value="up">{t('上に回すと次のページ（反転）')}</option>
        </select>
      </div>
      <p className="muted detail__note">{t('「幅合わせ」で縦にスクロールしているあいだは、スクロールの向きに従います。')}</p>
      <div className="settings__row">
        <span className="settings__label">{t('シャープ化（ラプラシアン）')}</span>
        <select
          className="select select--xs"
          value={prefs.sharpen}
          onChange={(e) => setPrefs({ sharpen: Number(e.target.value) as 0 | 1 | 2 | 3 })}
        >
          {SHARPEN_LABELS.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted detail__note">
        {t('表示する大きさにしてから、3×3 のラプラシアンで輪郭を強めます。縮小して表示したときに、細い線や文字がぼやけるのを抑えます。強くすると輪郭が白く縁取られることがあります。')}
      </p>
      <div className="settings__row">
        <span className="settings__label">{t('拡大の補間方式')}</span>
        <select
          className="select select--xs"
          value={prefs.smoothing}
          onChange={(e) => setPrefs({ smoothing: e.target.value === 'pixelated' ? 'pixelated' : 'smooth' })}
        >
          <option value="smooth">{t('バイキュービック（標準）')}</option>
          <option value="pixelated">{t('ニアレストネイバー')}</option>
        </select>
      </div>
      <p className="muted detail__note">
        {t('ニアレストネイバーは、ピクセルをそのまま大きくします（ドット絵・細かい文字向け）。拡大して表示しているときだけ効きます。縮小はどちらでも Chromium の高品質な縮小（ミップマップ）を使います。')}
      </p>
      <p className="muted detail__note">
        {t('拡大・縮小はビューアの −／＋、Ctrl+ホイール、+ / - / 0 キーで。合わせ方（全体・幅合わせ・原寸）は F キーでも切り替えられます。')}
      </p>
      <div className="settings__row">
        <span className="settings__label">{t('PDF の表示')}</span>
        <select
          className="select select--xs"
          value={prefs.pdfMode}
          onChange={(e) => setPrefs({ pdfMode: e.target.value === 'page' ? 'page' : 'scroll' })}
        >
          <option value="scroll">{t('縦にスクロール')}</option>
          <option value="page">{t('ページ送り（1 ページずつ）')}</option>
        </select>
      </div>
      <p className="muted detail__note">
        {t('ページ送りでは、ホイール・← → キー・PageUp / PageDown・Space でめくります（ページ送りの速さとホイールの向きは上の設定に従います）。PDF の上のボタンでも切り替えられます。')}
      </p>
      <div className="settings__row">
        <span className="settings__label">{t('PDF の見開き')}</span>
        <select
          className="select select--xs"
          value={prefs.pdfSpread}
          onChange={(e) => setPrefs({ pdfSpread: e.target.value === 'on' || e.target.value === 'cover' ? e.target.value : 'off' })}
        >
          <option value="off">{t('単ページ')}</option>
          <option value="on">{t('見開き')}</option>
          <option value="cover">{t('見開き（表紙は単独）')}</option>
        </select>
        <select
          className="select select--xs"
          value={prefs.pdfRtl ? 'rtl' : 'ltr'}
          onChange={(e) => setPrefs({ pdfRtl: e.target.value === 'rtl' })}
        >
          <option value="ltr">{t('左綴じ（左から右へ）')}</option>
          <option value="rtl">{t('右綴じ（右から左へ・マンガなど）')}</option>
        </select>
      </div>
      <p className="muted detail__note">
        {t('見開きでは 2 ページを並べます。表紙が単独の本は「表紙は単独」にすると、本と同じ組み合わせになります。右綴じでは、右のページから読み、← キーで次へ進みます。')}
      </p>
    </>
  );
}
