import { t } from '@shared/i18n';

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** 残り時間などの目安。「約 3 分」「約 1 時間 20 分」 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return t('1 分未満');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('約 {minutes} 分', { minutes });
  return t('約 {hours} 時間 {minutes} 分', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** 3:05 / 1:02:03 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * 台本などのテキストを文字コードを判定して読む。
 * BOM → UTF-8（厳密） → Shift_JIS の順に試す。DLsite / DMM の古い作品は Shift_JIS が多い。
 */
export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** HTML / RTF を「文字だけ」にする。台本の表示用で、スクリプトやリンクは生かさない */
export function toPlainText(name: string, text: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove());
    doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
    doc.querySelectorAll('p,div,li,tr,h1,h2,h3,h4').forEach((el) => el.append('\n'));
    return (doc.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (lower.endsWith('.rtf')) {
    return text
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
      .trim();
  }
  return text;
}

export interface Cue {
  start: number;
  end: number | null;
  text: string;
}

/**
 * .ass / .ssa（Advanced SubStation Alpha）。日本の作品の字幕でよく使われる。
 * [Events] の `Format:` で列の並びを決め、`Dialogue:` の行から開始・終了・本文を取る。
 * 本文の `{\\…}`（装飾の指定）は落とし、`\\N` `\\n` は改行、`\\h` は空白にする。
 */
function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let inEvents = false;
  let columns: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const time = (v: string): number => {
    const m = /(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?/.exec(v.trim());
    if (!m) return 0;
    const frac = m[4] ? Number(`0.${m[4]}`) : 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  };
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    const format = /^format\s*:\s*(.*)$/i.exec(line);
    if (format) {
      columns = format[1].split(',').map((c) => c.trim().toLowerCase());
      continue;
    }
    const dialogue = /^dialogue\s*:\s*(.*)$/i.exec(line);
    if (!dialogue) continue;
    // 本文にはカンマが入りうるので、最後の列（text）より前の数だけで区切る
    const parts = dialogue[1].split(',');
    const textAt = columns.indexOf('text');
    const head = parts.slice(0, textAt);
    const body = parts.slice(textAt).join(',');
    const startAt = columns.indexOf('start');
    const endAt = columns.indexOf('end');
    if (startAt < 0 || endAt < 0 || textAt < 0) continue;
    const cleaned = body
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    cues.push({ start: time(head[startAt] ?? ''), end: time(head[endAt] ?? ''), text: cleaned });
  }
  return cues;
}

/** .lrc / .srt / .vtt / .ass / .ssa を「開始秒・文」の並びにする */
export function parseSubtitles(name: string, text: string): Cue[] {
  const lower = name.toLowerCase();
  const cues: Cue[] = [];
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) {
    cues.push(...parseAss(text));
  } else if (lower.endsWith('.lrc')) {
    for (const line of text.split(/\r?\n/)) {
      const stamps = [...line.matchAll(/\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
      if (stamps.length === 0) continue;
      const body = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const s of stamps) {
        cues.push({ start: Number(s[1]) * 60 + Number(s[2].replace(':', '.')), end: null, text: body });
      }
    }
  } else {
    const time = (t: string): number => {
      const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t);
      if (!m) return 0;
      return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
    };
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const idx = lines.findIndex((l) => l.includes('-->'));
      if (idx < 0) continue;
      const [a, b] = lines[idx].split('-->');
      cues.push({ start: time(a), end: time(b), text: lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').trim() });
    }
  }
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end === null) cues[i].end = cues[i + 1]?.start ?? null;
  }
  return cues;
}

/**
 * 再生位置で出ている字幕。重なって出ているものは（.ass では同時に複数出せる）改行でつなぐ。
 * 何も出ていなければ空文字。
 */
export function activeCueText(cues: Cue[], time: number): string {
  const lines: string[] = [];
  for (const c of cues) {
    if (c.start > time) break;
    if (c.end === null || time < c.end) lines.push(c.text);
  }
  return lines.filter(Boolean).join('\n');
}
