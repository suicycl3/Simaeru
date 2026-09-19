/**
 * PDF の見開きの組み方。
 * - off: 1 ページずつ
 * - on: 1-2, 3-4, …
 * - cover: 表紙（1 ページ目）だけ単独で、2-3, 4-5, …（本の並びと同じ）
 */
export type PdfSpread = 'off' | 'on' | 'cover';

/** ページ（1 から）を、並べて表示する組に分ける。読む順（左綴じの並び）で返す */
export function spreadRows(pages: number, spread: PdfSpread): number[][] {
  const rows: number[][] = [];
  if (pages <= 0) return rows;
  if (spread === 'off') {
    for (let p = 1; p <= pages; p++) rows.push([p]);
    return rows;
  }
  let p = 1;
  if (spread === 'cover') {
    rows.push([1]);
    p = 2;
  }
  for (; p <= pages; p += 2) rows.push(p + 1 <= pages ? [p, p + 1] : [p]);
  return rows;
}

/** そのページを含む組の番号（見つからなければ 0） */
export function rowIndexOf(rows: number[][], page: number): number {
  const i = rows.findIndex((row) => row.includes(page));
  return i < 0 ? 0 : i;
}
