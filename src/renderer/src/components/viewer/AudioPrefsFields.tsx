import { AUDIO_PRESETS, DEFAULT_AUDIO_PREFS, HIGH_CUTS, LOW_CUTS, MAX_VOLUME, presetOf, useAudioPrefs } from '../../lib/audioPrefs';
import { t } from '@shared/i18n';

/** ボイスプレイヤーの音の調整。設定画面とプレイヤーのメニューで同じものを使う */
export default function AudioPrefsFields({ compact = false }: { compact?: boolean }): JSX.Element {
  const [prefs, setPrefs] = useAudioPrefs();
  const preset = presetOf(prefs);
  return (
    <>
      <div className="settings__row">
        <span className="settings__label">{t('音の調整')}</span>
        <select
          className="select select--xs"
          value={preset ?? 'custom'}
          onChange={(e) => {
            const p = AUDIO_PRESETS.find((x) => x.key === e.target.value);
            if (p) setPrefs(p.prefs);
          }}
        >
          {AUDIO_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          {preset === null && <option value="custom">{t('カスタム')}</option>}
        </select>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('音量')}</span>
        <input
          className="audioprefs__range"
          type="range"
          min={0}
          max={MAX_VOLUME}
          step={0.05}
          value={prefs.volume}
          onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
        />
        <span className={`audioprefs__value ${prefs.volume > 1 ? 'audioprefs__value--over' : ''}`}>{Math.round(prefs.volume * 100)}%</span>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('ボイスを目立たせる')}</span>
        <input
          className="audioprefs__range"
          type="range"
          min={0}
          max={12}
          step={1}
          value={prefs.voiceBoost}
          onChange={(e) => setPrefs({ voiceBoost: Number(e.target.value) })}
        />
        <span className="audioprefs__value">{prefs.voiceBoost === 0 ? t('切') : `+${prefs.voiceBoost} dB`}</span>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('音量の均し')}</span>
        <select
          className="select select--xs"
          value={prefs.leveling}
          onChange={(e) => setPrefs({ leveling: e.target.value as 'off' | 'light' | 'strong' })}
        >
          <option value="off">{t('切')}</option>
          <option value="light">{t('弱（小さい声を少し持ち上げる）')}</option>
          <option value="strong">{t('強（ささやきも聞き取りやすく）')}</option>
        </select>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('低音カット')}</span>
        <select className="select select--xs" value={prefs.lowCut} onChange={(e) => setPrefs({ lowCut: Number(e.target.value) })}>
          {LOW_CUTS.map((hz) => (
            <option key={hz} value={hz}>
              {hz === 0 ? t('切') : t('{hz} Hz 以下を抑える', { hz })}
            </option>
          ))}
        </select>
        <span className="settings__label">{t('高音カット')}</span>
        <select className="select select--xs" value={prefs.highCut} onChange={(e) => setPrefs({ highCut: Number(e.target.value) })}>
          {HIGH_CUTS.map((hz) => (
            <option key={hz} value={hz}>
              {hz === 0 ? t('切') : t('{khz} kHz 以上を抑える', { khz: hz / 1000 })}
            </option>
          ))}
        </select>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('左右のバランス')}</span>
        <input
          className="audioprefs__range"
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={prefs.balance}
          onChange={(e) => setPrefs({ balance: Number(e.target.value) })}
          onDoubleClick={() => setPrefs({ balance: 0 })}
        />
        <span className="audioprefs__value">
          {Math.abs(prefs.balance) < 0.01 ? t('中央') : prefs.balance < 0 ? t('左 {n}%', { n: Math.round(-prefs.balance * 100) }) : t('右 {n}%', { n: Math.round(prefs.balance * 100) })}
        </span>
      </div>
      <label className="settings__row check">
        <input type="checkbox" checked={prefs.mono} onChange={(e) => setPrefs({ mono: e.target.checked })} />
        <span>{t('左右を混ぜる（モノラル・片耳で聞くとき）')}</span>
      </label>
      <div className="settings__row">
        <button className="btn btn--xs btn--ghost" onClick={() => setPrefs({ ...DEFAULT_AUDIO_PREFS, volume: prefs.volume })}>
          {t('調整を元に戻す')}
        </button>
      </div>
      {!compact && (
        <p className="muted detail__note">
          {t('ボイスを目立たせるは、声の帯域（2.5 kHz 付近）を持ち上げます。音量の均しは、小さい声を持ち上げて大きい音を抑えます。100% を超えて上げても音が割れにくいよう、最後に音の天井（リミッター）を置いています。バイノーラル作品では、左右を混ぜると立体感がなくなります。')}
        </p>
      )}
    </>
  );
}
