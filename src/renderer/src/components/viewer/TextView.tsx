import { useEffect, useRef, useState } from 'react';
import { decodeText, parseSubtitles, toPlainText, type Cue } from '../../lib/format';
import { t } from '@shared/i18n';

/** 台本のテキスト（txt / html / rtf）。文字コードは自動で判定する */
export function TextView({ url, name }: { url: string; name: string }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(15);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) setText(toPlainText(name, decodeText(buf)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [url, name]);

  return (
    <div className="textview">
      <div className="pdf__bar">
        <button className="btn btn--xs" onClick={() => setSize((s) => Math.max(10, s - 1))}>
          A−
        </button>
        <button className="btn btn--xs" onClick={() => setSize((s) => Math.min(28, s + 1))}>
          {t('A＋')}
        </button>
      </div>
      {error && <div className="banner banner--error">{t('読み込めませんでした: {error}', { error })}</div>}
      {text === null && !error && <div className="muted">{t('読み込み中…')}</div>}
      {text !== null && (
        <pre className="textview__body" style={{ fontSize: size }}>
          {text}
        </pre>
      )}
    </div>
  );
}

/** 字幕（.lrc / .srt / .vtt）。再生位置に合わせて今の行を強調し、押すとその位置へ飛ぶ */
export function SubtitleView({
  url,
  name,
  currentTime,
  onSeek
}: {
  url: string;
  name: string;
  currentTime: number;
  onSeek: (tItem: number) => void;
}): JSX.Element {
  const [cues, setCues] = useState<Cue[] | null>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let cancelled = false;
    setCues(null);
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!cancelled) setCues(parseSubtitles(name, decodeText(buf)));
      })
      .catch(() => {
        if (!cancelled) setCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [url, name]);

  const active = cues
    ? cues.findIndex((c) => currentTime >= c.start && (c.end === null || currentTime < c.end))
    : -1;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active]);

  if (!cues) return <div className="muted">{t('読み込み中…')}</div>;
  if (cues.length === 0) return <div className="muted">{t('字幕を読み取れませんでした。')}</div>;
  return (
    <ol className="lyrics">
      {cues.map((c, i) => (
        <li
          key={i}
          ref={i === active ? activeRef : undefined}
          className={`lyrics__line ${i === active ? 'lyrics__line--active' : ''}`}
          onClick={() => onSeek(c.start)}
        >
          {c.text || '♪'}
        </li>
      ))}
    </ol>
  );
}
