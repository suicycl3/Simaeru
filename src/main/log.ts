import fs from 'node:fs';
import path from 'node:path';

/**
 * アプリの動きの記録（アプリログ）。
 *
 * これまで `console` に出していたものは、ターミナルから起動したときしか見られず、
 * 「うまく動かない」ときに手掛かりが残らなかった。userData の中のファイルにも書いて、
 * 「このアプリについて」から書き出せるようにする。
 *
 * **秘密になりうるものは書かない。** ダウンロードURLの署名付きクエリ、Cookie、ID/パスワードは
 * `scrubForLog` で落としてから書く。落とし損ねても困らないよう、そもそも記録する側（console の呼び出し）でも
 * URL はホストとパスの先頭までにしている。
 */

/** 1本あたりの上限。超えたら1世代だけ残して作り直す */
const MAX_BYTES = 2 * 1024 * 1024;

let target: { dir: string; file: string; previous: string } | null = null;

/** 秘密になりうる部分を落とす */
export function scrubForLog(text: string): string {
  return (
    text
      // 署名付きURLのクエリ（ダウンロードURLの有効期限・署名など）
      .replace(/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/gi, '$1?…')
      // ヘッダの形で混ざったもの
      .replace(/((?:cookie|set-cookie|authorization)\s*[:=]\s*)\S+/gi, '$1…')
      // それらしい名前の値
      .replace(/((?:password|passwd|token|secret|session[_-]?id)\s*[:=]\s*)\S+/gi, '$1…')
  );
}

const line = (level: string, args: unknown[]): string => {
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return `${new Date().toISOString()} [${level}] ${scrubForLog(body)}\n`;
};

function append(text: string): void {
  if (!target) return;
  try {
    const size = fs.statSync(target.file).size;
    if (size + Buffer.byteLength(text) > MAX_BYTES) {
      fs.rmSync(target.previous, { force: true });
      fs.renameSync(target.file, target.previous);
    }
  } catch {
    // まだ無い・読めない場合はそのまま書く
  }
  try {
    fs.appendFileSync(target.file, text);
  } catch {
    // 記録できないこと自体でアプリを止めない
  }
}

/**
 * `console` の出力をファイルにも残すようにする。起動のできるだけ早い段階で1回だけ呼ぶ。
 * @returns 書き出し先（表示・書き出しに使う）
 */
export function installLogCapture(userDataDir: string): { file: string; previous: string } {
  const dir = path.join(userDataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  target = { dir, file: path.join(dir, 'app.log'), previous: path.join(dir, 'app-1.log') };

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      append(line(level, args));
    };
  }
  process.on('uncaughtException', (err) => {
    append(line('error', ['uncaughtException', err]));
    throw err;
  });
  process.on('unhandledRejection', (reason) => {
    append(line('error', ['unhandledRejection', reason]));
  });
  return { file: target.file, previous: target.previous };
}

/** 画面（renderer）側で起きたことを記録する */
export function logFromRenderer(level: 'log' | 'warn' | 'error', message: string): void {
  append(line(`renderer:${level}`, [message]));
}

/** 書き出し用に、古い方から順に1つの文字列へまとめる */
export function readLog(): string {
  if (!target) return '';
  const read = (p: string): string => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return read(target.previous) + read(target.file);
}

/** いまの書き出し先（無ければ null） */
export function logFiles(): { file: string; previous: string } | null {
  return target ? { file: target.file, previous: target.previous } : null;
}
