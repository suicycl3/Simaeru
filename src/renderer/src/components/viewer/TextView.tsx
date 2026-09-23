import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { decodeText, parseSubtitles, toPlainText, type Cue } from '../../lib/format';
import { buildSearchIndex, findAll, type SearchHit } from '../../lib/textSearch';
import FindBar from './FindBar';
import { t } from '@shared/i18n';

/** 台本のテキスト（txt / html / rtf）。文字コードは自動で判定する。Ctrl+F で中を検索できる */
export function TextView({ url, name }: { url: string; name: string }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(15);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLElement | null>(null);

  const lines = useMemo(() => (text === null ? [] : text.split('\n')), [text]);
  const index = useMemo(() => buildSearchIndex(lines), [lines]);
  const hits = useMemo(() => (finding && query.trim() ? findAll(index, query) : []), [finding, index, query]);
  useEffect(() => setCurrent(0), [query]);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [current, hits]);

  // Ctrl+F で検索欄を開く（このビューアを表示しているときだけ）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && hostRef.current?.offsetParent) {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    <div className="textview" ref={hostRef}>
      <div className="pdf__bar">
        <button className="btn btn--xs" onClick={() => setSize((s) => Math.max(10, s - 1))}>
          A−
        </button>
        <button className="btn btn--xs" onClick={() => setSize((s) => Math.min(28, s + 1))}>
          {t('A＋')}
        </button>
        <button
          className={`btn btn--xs ${finding ? 'btn--on' : ''}`}
          onClick={() => setFinding((f) => !f)}
          title={t('検索（Ctrl+F）')}
          aria-label={t('検索')}
        >
          🔍
        </button>
        {finding && (
          <FindBar
            query={query}
            onQuery={setQuery}
            count={hits.length}
            current={current}
            onMove={(d) => hits.length && setCurrent((c) => (c + d + hits.length) % hits.length)}
            onClose={() => {
              setFinding(false);
              setQuery('');
            }}
          />
        )}
      </div>
      {error && <div className="banner banner--error">{t('読み込めませんでした: {error}', { error })}</div>}
      {text === null && !error && <div className="muted">{t('読み込み中…')}</div>}
      {text !== null && (
        <pre className="textview__body" style={{ fontSize: size }}>
          {hits.length === 0
            ? text
            : lines.map((line, i) => (
                <Fragment key={i}>
                  {markLine(line, i, hits, current, currentRef)}
                  {i < lines.length - 1 ? '\n' : ''}
                </Fragment>
              ))}
        </pre>
      )}
    </div>
  );
}

/** 1行の中の当たりを <mark> で囲む。行をまたぐ当たりは、それぞれの行の部分を囲む */
function markLine(
  line: string,
  lineIndex: number,
  hits: SearchHit[],
  current: number,
  currentRef: React.MutableRefObject<HTMLElement | null>
): React.ReactNode {
  const ranges: Array<{ from: number; to: number; hit: number }> = [];
  hits.forEach((h, hit) => {
    if (!h.chunks.includes(lineIndex)) return;
    const from = h.start.chunk === lineIndex ? h.start.offset : 0;
    const to = h.end.chunk === lineIndex ? h.end.offset : line.length;
    if (to > from) ranges.push({ from, to, hit });
  });
  if (ranges.length === 0) return line;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.from > at) out.push(line.slice(at, r.from));
    const isCurrent = r.hit === current;
    out.push(
      <mark
        key={`${r.hit}:${r.from}`}
        className={`find__mark ${isCurrent ? 'find__mark--current' : ''}`}
        ref={isCurrent && (hits[r.hit].start.chunk === lineIndex) ? (el) => (currentRef.current = el) : undefined}
      >
        {line.slice(r.from, r.to)}
      </mark>
    );
    at = r.to;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}

/** 字幕（.lrc / .srt / .vtt / .ass / .ssa）。再生位置に合わせて今の行を強調し、押すとその位置へ飛ぶ */
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
