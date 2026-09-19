import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';

/**
 * ボイスプレイヤーの音の調整。聞こえ方の好みなので、このPCのこの画面にだけ持つ（localStorage）。
 * 設定画面とプレイヤーの両方から変えられるので、変えたら知らせ合う。
 */
export interface AudioPrefs {
  /** 音量（1 = 100%。最大 4 = 400%） */
  volume: number;
  /** ボイスを目立たせる強さ（dB。声の帯域 2.5kHz 付近を持ち上げる。0 で切） */
  voiceBoost: number;
  /** 低音カット（Hz。0 で切）。こもり・ノイズを抑えて声を聞き取りやすくする */
  lowCut: number;
  /** 高音カット（Hz。0 で切）。サーッという音・耳に刺さる音を抑える */
  highCut: number;
  /** 音量の均し（小さい声を持ち上げ、大きい音を抑える） */
  leveling: 'off' | 'light' | 'strong';
  /** 左右のバランス（-1: 左 〜 1: 右） */
  balance: number;
  /** 左右を混ぜて 1 つにする（片耳で聞くとき） */
  mono: boolean;
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = { volume: 0.8, voiceBoost: 0, lowCut: 0, highCut: 0, leveling: 'off', balance: 0, mono: false };

export const AUDIO_PRESETS: Array<{ key: string; label: string; prefs: Omit<AudioPrefs, 'volume' | 'balance' | 'mono'> }> = [
  { key: 'flat', label: t('そのまま'), prefs: { voiceBoost: 0, lowCut: 0, highCut: 0, leveling: 'off' } },
  { key: 'voice', label: t('ボイスを目立たせる'), prefs: { voiceBoost: 6, lowCut: 150, highCut: 0, leveling: 'light' } },
  { key: 'whisper', label: t('ささやき・小さい声を聞き取りやすく'), prefs: { voiceBoost: 4, lowCut: 100, highCut: 0, leveling: 'strong' } },
  { key: 'soft', label: t('耳に刺さる音をやわらげる'), prefs: { voiceBoost: 0, lowCut: 0, highCut: 8000, leveling: 'light' } }
];

export const LOW_CUTS = [0, 80, 150, 250];
export const HIGH_CUTS = [0, 12000, 8000, 5000];
export const MAX_VOLUME = 4;

const KEY = 'player.audio';
const LEGACY_VOLUME_KEY = 'player.volume';
const EVENT = 'audio-prefs';

const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

export function readAudioPrefs(): AudioPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<AudioPrefs> | null;
    // 以前は音量だけを別に持っていた
    const legacy = Number(localStorage.getItem(LEGACY_VOLUME_KEY));
    const d = DEFAULT_AUDIO_PREFS;
    return {
      volume: clamp(raw?.volume, 0, MAX_VOLUME, Number.isFinite(legacy) && localStorage.getItem(LEGACY_VOLUME_KEY) !== null ? legacy : d.volume),
      voiceBoost: clamp(raw?.voiceBoost, 0, 12, d.voiceBoost),
      lowCut: LOW_CUTS.includes(raw?.lowCut as number) ? (raw!.lowCut as number) : d.lowCut,
      highCut: HIGH_CUTS.includes(raw?.highCut as number) ? (raw!.highCut as number) : d.highCut,
      leveling: raw?.leveling === 'light' || raw?.leveling === 'strong' ? raw.leveling : 'off',
      balance: clamp(raw?.balance, -1, 1, d.balance),
      mono: raw?.mono === true
    };
  } catch {
    return DEFAULT_AUDIO_PREFS;
  }
}

export function writeAudioPrefs(next: Partial<AudioPrefs>): AudioPrefs {
  const merged = { ...readAudioPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // 保存できなくても、開いている間は効かせる
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: merged }));
  return merged;
}

export function useAudioPrefs(): [AudioPrefs, (next: Partial<AudioPrefs>) => void] {
  const [prefs, setPrefs] = useState(readAudioPrefs);
  useEffect(() => {
    const on = (e: Event): void => setPrefs((e as CustomEvent<AudioPrefs>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [prefs, (next) => setPrefs(writeAudioPrefs(next))];
}

/** 今の調整がどのプリセットと同じか（どれとも違えば null） */
export function presetOf(prefs: AudioPrefs): string | null {
  return (
    AUDIO_PRESETS.find(
      (p) =>
        p.prefs.voiceBoost === prefs.voiceBoost &&
        p.prefs.lowCut === prefs.lowCut &&
        p.prefs.highCut === prefs.highCut &&
        p.prefs.leveling === prefs.leveling
    )?.key ?? null
  );
}

/**
 * 音量の均し（DynamicsCompressor）の値。
 * Chromium の DynamicsCompressor は、圧縮したぶんを自動で持ち上げる（0 dBFS での減衰の 0.6 乗ぶん）。
 * 弱: 0 dB で約 -11 dB → 自動で約 +6.5 dB、強: 約 -22.5 dB → 約 +13.5 dB。手で足す分は無し
 */
const LEVELING = {
  off: { threshold: 0, ratio: 1, knee: 0, makeup: 1 },
  light: { threshold: -18, ratio: 2.5, knee: 12, makeup: 1 },
  strong: { threshold: -30, ratio: 4, knee: 18, makeup: 1 }
} as const;

interface Chain {
  ctx: AudioContext;
  lowCut: BiquadFilterNode;
  voice: BiquadFilterNode;
  highCut: BiquadFilterNode;
  leveler: DynamicsCompressorNode;
  makeup: GainNode;
  monoMix: GainNode;
  stereo: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

/** 要素ごとに 1 回しか createMediaElementSource できないので、作った経路を覚えておく */
const chains = new WeakMap<HTMLMediaElement, Chain>();

function buildChain(el: HTMLMediaElement): Chain {
  const existing = chains.get(el);
  if (existing) return existing;
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(el);

  // 左右を混ぜる経路と、そのままの経路を用意して、音量で切り替える
  const stereo = ctx.createGain();
  const monoMix = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const half = ctx.createGain();
  half.gain.value = 0.5;
  source.connect(stereo);
  source.connect(splitter);
  splitter.connect(half, 0);
  splitter.connect(half, 1);
  half.connect(merger, 0, 0);
  half.connect(merger, 0, 1);
  merger.connect(monoMix);

  const lowCut = ctx.createBiquadFilter();
  lowCut.type = 'highpass';
  lowCut.Q.value = 0.7;
  const voice = ctx.createBiquadFilter();
  voice.type = 'peaking';
  voice.frequency.value = 2500;
  voice.Q.value = 0.8;
  const highCut = ctx.createBiquadFilter();
  highCut.type = 'lowpass';
  highCut.Q.value = 0.7;
  const leveler = ctx.createDynamicsCompressor();
  leveler.attack.value = 0.01;
  leveler.release.value = 0.25;
  const makeup = ctx.createGain();
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner();
  // 100% を超えて上げたときに音が割れないよう、最後に天井を置く
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;

  stereo.connect(lowCut);
  monoMix.connect(lowCut);
  lowCut.connect(voice).connect(highCut).connect(leveler).connect(makeup).connect(gain).connect(pan).connect(limiter).connect(ctx.destination);

  const chain = { ctx, lowCut, voice, highCut, leveler, makeup, monoMix, stereo, gain, pan };
  chains.set(el, chain);
  return chain;
}

function applyChain(c: Chain, p: AudioPrefs): void {
  const now = c.ctx.currentTime;
  const set = (param: AudioParam, value: number): void => {
    param.setTargetAtTime(value, now, 0.03);
  };
  set(c.stereo.gain, p.mono ? 0 : 1);
  set(c.monoMix.gain, p.mono ? 1 : 0);
  // 切のときは、効かない値にする（ノードを付け外しすると音が途切れる）
  set(c.lowCut.frequency, p.lowCut > 0 ? p.lowCut : 10);
  set(c.voice.gain, p.voiceBoost);
  set(c.highCut.frequency, p.highCut > 0 ? p.highCut : Math.min(22050, c.ctx.sampleRate / 2));
  const lv = LEVELING[p.leveling];
  set(c.leveler.threshold, lv.threshold);
  set(c.leveler.ratio, lv.ratio);
  set(c.leveler.knee, lv.knee);
  set(c.makeup.gain, lv.makeup);
  set(c.gain.gain, p.volume);
  set(c.pan.pan, p.balance);
}

/**
 * <audio> を Web Audio の経路に通して、音の調整を効かせる。
 * 経路を作れなかったとき（まれ）は、要素の音量（100% まで）だけで鳴らす。
 * @returns 調整が効いているか
 */
export function useAudioChain(ref: React.RefObject<HTMLMediaElement>, prefs: AudioPrefs): boolean {
  const [active, setActive] = useState(false);
  const chainRef = useRef<Chain | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      chainRef.current = buildChain(el);
      el.volume = 1;
      setActive(true);
    } catch (err) {
      console.warn('[audio] 音の調整を使えません:', err);
      chainRef.current = null;
      setActive(false);
    }
    // 画面を閉じたら、音声の処理を止める
    return () => {
      const c = chainRef.current;
      if (c && c.ctx.state !== 'closed') void c.ctx.suspend().catch(() => undefined);
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    const c = chainRef.current;
    if (c) applyChain(c, prefs);
    else if (el) el.volume = Math.min(1, prefs.volume);
  }, [prefs, active, ref]);

  // 再生を始めるときに、止まっている AudioContext を動かす（自動再生の制限で止まっていることがある）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resume = (): void => {
      const c = chainRef.current;
      if (c && c.ctx.state === 'suspended') void c.ctx.resume().catch(() => undefined);
    };
    el.addEventListener('play', resume);
    return () => el.removeEventListener('play', resume);
  }, [ref]);

  return active;
}
