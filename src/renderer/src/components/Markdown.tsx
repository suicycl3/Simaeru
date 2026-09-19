import { Fragment } from 'react';

/**
 * 同梱の Markdown 文書（ライセンス一覧など）を表示するための小さな描画。
 * 見出し・段落・箇条書き・表・コード（```）・行内の `code` / **太字** / URL だけを扱う。
 * HTML は解釈しない（文字列のまま出す）。
 *
 * collapseFrom: この深さ以上の見出し（例: 3 = ###）から次の見出しまでを折りたたむ
 */
export default function Markdown({ source, collapseFrom }: { source: string; collapseFrom?: number }): JSX.Element {
  const blocks = parse(source);
  const out: JSX.Element[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (collapseFrom && b.type === 'heading' && b.level >= collapseFrom) {
      // 次の同じか浅い見出しまでを1つにまとめる
      const body: Block[] = [];
      let j = i + 1;
      while (j < blocks.length && !(blocks[j].type === 'heading' && (blocks[j] as HeadingBlock).level <= b.level)) {
        body.push(blocks[j]);
        j++;
      }
      out.push(
        <details key={i} className="md__details">
          <summary>{inline(b.text)}</summary>
          {body.map((c, k) => render(c, k))}
        </details>
      );
      i = j - 1;
      continue;
    }
    out.push(render(b, i));
  }
  return <div className="md">{out}</div>;
}

interface HeadingBlock {
  type: 'heading';
  level: number;
  text: string;
}
type Block =
  | HeadingBlock
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'code'; text: string };

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push({ type: 'list', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\||\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

function render(b: Block, key: number): JSX.Element {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(6, b.level + 2)}` as 'h3';
      return <Tag key={key}>{inline(b.text)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{inline(b.text)}</p>;
    case 'list':
      return (
        <ul key={key}>
          {b.items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="md__tableWrap">
          <table className="rules">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre key={key} className="md__code">
          {b.text}
        </pre>
      );
  }
}

/** 行内: `code`・**太字**・URL */
function inline(text: string): JSX.Element {
  const parts: JSX.Element[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)|）]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const token = m[0];
    if (token.startsWith('`')) parts.push(<code key={k++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) parts.push(<b key={k++}>{token.slice(2, -2)}</b>);
    else
      parts.push(
        <button key={k++} className="link" onClick={() => void window.api.openExternal(token)}>
          {token}
        </button>
      );
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
