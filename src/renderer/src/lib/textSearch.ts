/**
 * ビューア内の検索（テキスト・PDF で共通）。
 *
 * 文章は「塊」（テキストなら行、PDF ならページ内の文字の並び）の列として受け取り、
 * 見つかった位置が**どの塊にまたがるか**を返す。PDF はこの塊を枠として光らせる。
 *
 * 比べるときは次をそろえる（見た目が同じなら当たるように）。
 * - 全角・半角（NFKC）と大文字・小文字
 * - 空白と改行は無視する。PDF は文字ごとに区切られていたり、行の途中で改行されていたりするため
 */

/** 1文字を比べる形にする。空白は空文字（＝読み飛ばす） */
function fold(ch: string): string {
  if (/\s/.test(ch)) return '';
  return ch.normalize('NFKC').toLowerCase();
}

export interface SearchIndex {
  /** 比べる形にした本文 */
  text: string;
  /** text の各文字が、どの塊の何文字目（元の文字の長さ）から来たか */
  owner: Array<{ chunk: number; offset: number; length: number }>;
}

/** 塊の列から、検索用の本文を作る */
export function buildSearchIndex(chunks: string[]): SearchIndex {
  let text = '';
  const owner: SearchIndex['owner'] = [];
  chunks.forEach((chunk, chunkIndex) => {
    let offset = 0;
    for (const ch of chunk) {
      const folded = fold(ch);
      // text は UTF-16 の単位で数える（indexOf と同じ単位）。owner もそれにそろえる
      for (let k = 0; k < folded.length; k++) {
        text += folded[k];
        owner.push({ chunk: chunkIndex, offset, length: ch.length });
      }
      offset += ch.length;
    }
  });
  return { text, owner };
}

/** 検索語を比べる形にする */
export function foldQuery(query: string): string {
  let out = '';
  for (const ch of query) out += fold(ch);
  return out;
}

export interface SearchHit {
  /** 当たった範囲に含まれる塊（重複なし・昇順） */
  chunks: number[];
  /** 最初の塊の中での開始位置と、最後の塊の中での終了位置（元の文字列での位置） */
  start: { chunk: number; offset: number };
  end: { chunk: number; offset: number };
}

/** すべての当たりを返す。重ならないように先頭から順に探す */
export function findAll(index: SearchIndex, query: string, limit = 2000): SearchHit[] {
  const q = foldQuery(query);
  if (!q) return [];
  const hits: SearchHit[] = [];
  let from = 0;
  while (hits.length < limit) {
    const at = index.text.indexOf(q, from);
    if (at < 0) break;
    const first = index.owner[at];
    const last = index.owner[at + q.length - 1];
    const chunks: number[] = [];
    for (let i = at; i < at + q.length; i++) {
      const c = index.owner[i].chunk;
      if (chunks[chunks.length - 1] !== c) chunks.push(c);
    }
    hits.push({
      chunks,
      start: { chunk: first.chunk, offset: first.offset },
      // 終わりは「最後の文字の次」を指す（サロゲートペアなど2単位の文字もある）
      end: { chunk: last.chunk, offset: last.offset + last.length }
    });
    from = at + q.length;
  }
  return hits;
}
