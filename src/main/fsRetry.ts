/**
 * 一時的に開けないファイルを、少し待ってやり直す。
 *
 * この PC では、ファイルを開いた直後に Windows Defender が検査して付加情報（`mshield` という代替データストリーム）を
 * 書き込み、その間に同じファイルを stat / open すると **EPERM** が返ることがある（実測。数百ms〜数秒で治る）。
 * そのまま失敗にすると、再生が「この形式は再生できません」になったり、中身の一覧が空になったりした。
 */

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function retryTransient<T>(fn: () => Promise<T>, attempts = 12, delayMs = 250): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT.has(code) || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
