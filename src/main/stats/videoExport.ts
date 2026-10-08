/**
 * 件数の移り変わりの動画・GIF を書き出す。
 *
 * 絵は画面側（renderer）が 1 コマずつ描いて RGBA のまま送ってくる。ここではそれを ffmpeg の標準入力に流すだけ。
 * - ffmpeg はアプリが使っている LGPL 版（設定 → ツール）。H.264 は OpenH264、無ければ Windows の Media Foundation
 * - GIF はきれいな 256 色にするため、いったん可逆（FFV1）で受けてから、パレットを作って 2 段で変換する
 * - ffmpeg は保護フォルダー（ドキュメント・ビデオ など）に書けないことがある（フォルダー アクセスの制御）。
 *   作業フォルダに書かせ、できあがったものをアプリが保存先へ写す
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t } from '@shared/i18n';
import { EXPORT_FORMATS, type ExportFormat, type ExportOptions } from '@shared/statsExport';

export { EXPORT_FORMATS, type ExportFormat, type ExportOptions };

interface Session {
  options: ExportOptions;
  dir: string;
  /** ffmpeg が最初に書くファイル（GIF は中間の FFV1） */
  firstOut: string;
  /** できあがりのファイル（作業フォルダの中） */
  finalOut: string;
  destination: string;
  proc: ChildProcess;
  stderr: string;
  exited: Promise<number | null>;
  frames: number;
}

/** 保存先へ写すときの待ち時間の上限（保護フォルダーへの書き込みが黙って止まることがあるため） */
const COPY_TIMEOUT_MS = 120_000;

export class VideoExporter {
  private sessions = new Map<string, Session>();
  private h264: string | null | undefined;

  constructor(private opts: { ffmpeg: () => string | null; workDir: string }) {
    // アプリが終わるときに、途中の ffmpeg を残さない
    process.once('exit', () => {
      for (const s of this.sessions.values()) s.proc.kill();
    });
  }

  /** 使える H.264 のエンコーダ（無ければ null。MPEG-4 Part 2 にする） */
  private h264Encoder(ffmpeg: string): string | null {
    if (this.h264 !== undefined) return this.h264;
    const out = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8' }).stdout ?? '';
    this.h264 = ['libopenh264', 'h264_mf'].find((name) => new RegExp(`\\s${name}\\s`).test(out)) ?? null;
    return this.h264;
  }

  private encodeArgs(ffmpeg: string, o: ExportOptions): string[] {
    switch (o.format) {
      case 'mp4': {
        const kbps = Math.max(800, Math.round((o.width * o.height * o.fps * 0.08) / 1000));
        const enc = this.h264Encoder(ffmpeg);
        const codec = enc
          ? ['-c:v', enc, '-b:v', `${kbps}k`, '-pix_fmt', enc === 'h264_mf' ? 'nv12' : 'yuv420p']
          : ['-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p'];
        return [...codec, '-movflags', '+faststart'];
      }
      case 'webm':
        return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
      case 'webp':
        return ['-c:v', 'libwebp_anim', '-q:v', '75', '-loop', '0'];
      case 'gif':
        // 中間ファイル（可逆）。仕上げで 256 色にする
        return ['-c:v', 'ffv1', '-pix_fmt', 'bgr0'];
    }
  }

  /** 書き出しを始める。destination は利用者が選んだ保存先 */
  begin(options: ExportOptions, destination: string): string {
    const ffmpeg = this.opts.ffmpeg();
    if (!ffmpeg) throw new Error(t('ffmpeg が見つかりません。設定の「ツール」から入れてください。'));
    const o = sanitize(options);
    const id = randomUUID();
    const dir = path.join(this.opts.workDir, `stats-export-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const ext = EXPORT_FORMATS[o.format].ext;
    const finalOut = path.join(dir, `out.${ext}`);
    const firstOut = o.format === 'gif' ? path.join(dir, 'frames.mkv') : finalOut;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', '-',
      ...this.encodeArgs(ffmpeg, o),
      firstOut
    ];
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const session: Session = {
      options: o, dir, firstOut, finalOut, destination, proc, stderr: '', frames: 0,
      exited: new Promise((resolve) => {
        proc.once('exit', (code) => resolve(code));
        proc.once('error', () => resolve(-1));
      })
    };
    proc.stderr?.on('data', (d: Buffer) => {
      session.stderr = (session.stderr + d.toString()).slice(-4000);
    });
    // 途中で ffmpeg が落ちたときの書き込みエラーは、frame / end で伝える
    proc.stdin?.on('error', () => undefined);
    this.sessions.set(id, session);
    return id;
  }

  /** 1 コマ（RGBA）を渡す。ffmpeg が受け取るまで待つ（画面側が送りすぎないように） */
  async frame(id: string, rgba: Uint8Array): Promise<void> {
    const s = this.session(id);
    const expected = s.options.width * s.options.height * 4;
    if (rgba.byteLength !== expected) throw new Error(t('コマの大きさが違います（{0} / {1}）', { 0: rgba.byteLength, 1: expected }));
    const stdin = s.proc.stdin;
    if (!stdin || stdin.destroyed || s.proc.exitCode !== null) throw new Error(this.failure(s));
    await new Promise<void>((resolve, reject) => {
      stdin.write(rgba, (err) => (err ? reject(new Error(this.failure(s))) : resolve()));
    });
    s.frames++;
  }

  /** 書き終わり。仕上げ（GIF のパレット）をして保存先へ写し、保存したパスを返す */
  async end(id: string): Promise<string> {
    const s = this.session(id);
    try {
      s.proc.stdin?.end();
      const code = await s.exited;
      if (code !== 0) throw new Error(this.failure(s));
      if (s.frames === 0) throw new Error(t('書き出すコマがありません。'));
      if (s.options.format === 'gif') await this.finishGif(s);
      await copyWithTimeout(s.finalOut, s.destination);
      return s.destination;
    } finally {
      this.sessions.delete(id);
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }

  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.proc.kill();
    void s.exited.then(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  }

  private async finishGif(s: Session): Promise<void> {
    const ffmpeg = this.opts.ffmpeg();
    if (!ffmpeg) throw new Error(t('ffmpeg が見つかりません。設定の「ツール」から入れてください。'));
    const palette = path.join(s.dir, 'palette.png');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', s.firstOut, '-vf', 'palettegen=max_colors=256:stats_mode=diff', palette]);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', s.firstOut, '-i', palette,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', s.finalOut
    ]);
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(t('書き出しは終わっているか、取り消されました。'));
    return s;
  }

  private failure(s: Session): string {
    const detail = s.stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
    return detail ? t('ffmpeg で書き出せませんでした: {0}', { 0: detail }) : t('ffmpeg で書き出せませんでした');
  }
}

/** 大きさは偶数（H.264 の都合）、コマ数は 1〜60 にそろえる */
function sanitize(o: ExportOptions): ExportOptions {
  const even = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n / 2) * 2));
  if (!(o.format in EXPORT_FORMATS)) throw new Error(t('知らない形式です: {0}', { 0: String(o.format) }));
  return { format: o.format, width: even(o.width, 160, 3840), height: even(o.height, 90, 2160), fps: Math.min(60, Math.max(1, Math.round(o.fps))) };
}

function run(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(t('ffmpeg で仕上げられませんでした: {0}', { 0: stderr.trim().split(/\r?\n/).pop() ?? code })))));
  });
}

async function copyWithTimeout(from: string, to: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fs.promises.copyFile(from, to),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(t('保存先に書き込めませんでした（{0}）。Windows の「フォルダー アクセスの制御」で止められている可能性があります。別の場所（ダウンロードなど）を選んでください。', { 0: to }))),
          COPY_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
