import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FlacEstimate, FlacOriginal, JobResult } from '@shared/types';
import { t } from '@shared/i18n';

/**
 * WAV → FLAC（DESIGN-download.md §6-5）。ffmpeg を別プロセスで呼ぶ。
 *
 * **元の WAV を消す前に、変換結果が元と同じ音であることを確かめる。**
 *  1. サンプルレート・チャンネル数・サンプル数（duration_ts）が一致する
 *  2. デコードした音声データの MD5 が一致する
 * どちらかが合わなければ、FLAC を捨てて WAV を残す。
 *
 * 32bit 浮動小数点の WAV は FLAC に可逆で入らないので、変換せずに飛ばす。
 *
 * **ffmpeg には作業フォルダ（既定は一時フォルダ）に書かせ、置き場所への移動はこのプロセスが行う。**
 * Windows の「フォルダー アクセスの制御」が有効だと、許可されていない ffmpeg.exe は
 * ドキュメント配下に書き込めない（"Error opening output ... No such file or directory" になる）。
 *
 * ファイル操作はすべて非同期（同期で開くと、検査中にメインプロセスが止まる）。
 */

/** 圧縮後のおよその比率。ボイス作品（無音が多い）の実測傾向から */
export const FLAC_RATIO = 0.55;

const LOSSLESS_PCM = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_s16be', 'pcm_s24be']);

export async function findWavs(target: string): Promise<string[]> {
  const out: string[] = [];
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return out;
  if (stat.isFile()) return path.extname(target).toLowerCase() === '.wav' ? [target] : out;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full, depth + 1);
      else if (item.isFile() && path.extname(item.name).toLowerCase() === '.wav') out.push(full);
    }
  };
  await walk(target, 0);
  return out.sort();
}

async function sizeOf(f: string): Promise<number> {
  return fs
    .stat(f)
    .then((s) => s.size)
    .catch(() => 0);
}

export async function estimateFlac(target: string): Promise<FlacEstimate> {
  const wavs = await findWavs(target);
  const sizes = await Promise.all(wavs.map(sizeOf));
  const bytes = sizes.reduce((a, b) => a + b, 0);
  return { files: wavs.length, bytes, estimatedBytes: Math.round(bytes * FLAC_RATIO) };
}

export interface AudioProbe {
  codec: string;
  sampleFmt: string;
  sampleRate: number;
  channels: number;
  durationTs: number;
  bits: number | null;
}

export async function probeAudio(ffprobe: string, file: string): Promise<AudioProbe> {
  const { code, stdout, stderr } = await run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_fmt,sample_rate,channels,duration_ts,bits_per_sample,bits_per_raw_sample',
    '-of', 'json',
    file
  ]);
  if (code !== 0) throw new Error(t('音声の情報を読めませんでした: {0}', { 0: stderr.trim().slice(0, 200) }));
  const s = (JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> }).streams?.[0];
  if (!s) throw new Error(t('音声が入っていません'));
  const raw = Number(s.bits_per_raw_sample);
  const bps = Number(s.bits_per_sample);
  return {
    codec: String(s.codec_name ?? ''),
    sampleFmt: String(s.sample_fmt ?? ''),
    sampleRate: Number(s.sample_rate) || 0,
    channels: Number(s.channels) || 0,
    durationTs: Number(s.duration_ts) || 0,
    bits: raw > 0 ? raw : bps > 0 ? bps : null
  };
}

/** デコードした音声データの MD5 */
export async function audioMd5(ffmpeg: string, file: string, signal?: AbortSignal): Promise<string> {
  const { code, stdout, stderr } = await run(
    ffmpeg,
    ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'],
    signal
  );
  const m = /MD5=([0-9a-f]{32})/i.exec(stdout);
  if (code !== 0 || !m) throw new Error(t('検証用のハッシュを取れませんでした: {0}', { 0: stderr.trim().slice(0, 200) }));
  return m[1].toLowerCase();
}

export interface ConvertOptions {
  ffmpeg: string;
  ffprobe: string;
  /** ffmpeg に書かせる作業フォルダ。置き場所と同じドライブなら移動は名前の付け替えだけで済む */
  workDir: string;
  /** 作業フォルダの空き容量（足りなければ置き場所に直接書かせる） */
  freeBytes?: (dir: string) => number | null;
  original: FlacOriginal;
  trashItem: (p: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export type ConvertOutcome =
  | { ok: true; before: number; after: number; flac: string }
  | { ok: false; skipped: string };

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** 1ファイルを変換して検証する */
export async function convertWav(wav: string, opts: ConvertOptions): Promise<ConvertOutcome> {
  const src = await probeAudio(opts.ffprobe, wav);
  if (!LOSSLESS_PCM.has(src.codec)) {
    return {
      ok: false,
      skipped:
        src.sampleFmt.startsWith('flt') || src.sampleFmt.startsWith('dbl')
          ? t('浮動小数点のWAVはFLACで可逆に保存できないため変換しません')
          : t('この形式（{codec}）は変換の対象外です', { codec: src.codec })
    };
  }
  const flac = wav.replace(/\.wav$/i, '.flac');
  if (await exists(flac)) return { ok: false, skipped: t('同じ名前のFLACがすでにあります') };
  const part = await workPathFor(wav, opts);
  await fs.rm(part, { force: true });

  const totalUs = src.sampleRate > 0 ? (src.durationTs / src.sampleRate) * 1e6 : 0;
  const encode = await run(
    opts.ffmpeg,
    [
      '-y', '-v', 'error', '-nostdin',
      '-i', wav,
      '-map', '0:a:0',
      '-map_metadata', '0',
      '-c:a', 'flac',
      '-compression_level', '8',
      '-progress', 'pipe:1', '-nostats',
      '-f', 'flac',
      part
    ],
    opts.signal,
    (chunk) => {
      const all = [...chunk.matchAll(/out_time_us=(\d+)/g)];
      const last = all[all.length - 1];
      if (last && totalUs > 0) {
        opts.onProgress?.(Math.min(0.9, (Number(last[1]) / totalUs) * 0.9), t('変換中'));
      }
    }
  );
  if (opts.signal?.aborted) {
    await fs.rm(part, { force: true });
    throw new Error(t('中止しました'));
  }
  if (encode.code !== 0) {
    await fs.rm(part, { force: true });
    const detail = encode.stderr.trim();
    if (/Error opening output/i.test(detail)) {
      throw new Error(
        t('FLAC の書き出し先を開けませんでした（{0}）。', { 0: path.dirname(part) }) +
          t('Windows の「フォルダー アクセスの制御」などで ffmpeg の書き込みが止められていないか確認してください。')
      );
    }
    throw new Error(t('FLACへの変換に失敗しました: {0}', { 0: detail.slice(-300) }));
  }

  // ── 検証 ──
  opts.onProgress?.(0.92, t('検証中'));
  const out = await probeAudio(opts.ffprobe, part);
  const sameShape =
    out.codec === 'flac' &&
    out.sampleRate === src.sampleRate &&
    out.channels === src.channels &&
    out.durationTs === src.durationTs;
  let sameAudio = false;
  if (sameShape) {
    const [a, b] = await Promise.all([audioMd5(opts.ffmpeg, wav, opts.signal), audioMd5(opts.ffmpeg, part, opts.signal)]);
    sameAudio = a === b;
  }
  if (!sameShape || !sameAudio) {
    await fs.rm(part, { force: true });
    return {
      ok: false,
      skipped: sameShape
        ? t('変換結果の音声データが元と一致しなかったため、WAVを残しました')
        : t('変換結果の長さ・形式が元と一致しなかったため、WAVを残しました（{durationTs}→{durationTs2}）', { durationTs: src.durationTs, durationTs2: out.durationTs })
    };
  }

  await moveInto(part, flac);
  // 更新日時を元に揃える（並び順や差分バックアップのため）
  const st = await fs.stat(wav).catch(() => null);
  if (st) await fs.utimes(flac, st.atime, st.mtime).catch(() => undefined);
  const before = await sizeOf(wav);
  const after = await sizeOf(flac);

  if (opts.original === 'trash') {
    try {
      await opts.trashItem(wav);
    } catch {
      // ごみ箱に入らない（容量超過など）場合は残す。消してしまうことはしない
      return { ok: true, before, after: after + before, flac };
    }
  } else if (opts.original === 'delete') {
    await fs.rm(wav, { force: true });
  }
  return { ok: true, before, after: opts.original === 'keep' ? after + before : after, flac };
}

/**
 * フォルダ（またはWAV単体）をまとめて変換する。進捗はバイト数で重み付けする。
 *
 * 小さい WAV が多い作品（システムボイスなど）は、1本ごとに ffprobe・ffmpeg・検証で数回プロセスを起こすぶんが
 * 支配的になる（16本で1分かかった）。**同時に数本ずつ**変換する。大きいファイルは I/O が詰まるので2本まで。
 */
export async function convertTarget(target: string, opts: ConvertOptions): Promise<JobResult> {
  const wavs = await findWavs(target);
  const sizes = await Promise.all(wavs.map(sizeOf));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const result: JobResult = { converted: 0, skipped: [], beforeBytes: 0, afterBytes: 0 };
  const average = total / Math.max(1, wavs.length);
  const parallel = Math.max(1, Math.min(average > 64 * 1024 * 1024 ? 2 : 4, wavs.length));
  const partial = new Map<number, number>();
  let doneBytes = 0;
  let finished = 0;
  let next = 0;
  const report = (message: string): void => {
    const inFlight = [...partial.values()].reduce((a, b) => a + b, 0);
    opts.onProgress?.((doneBytes + inFlight) / total, message);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= wavs.length) return;
      if (opts.signal?.aborted) throw new Error(t('中止しました'));
      const wav = wavs[i];
      const name = path.basename(wav);
      const outcome = await convertWav(wav, {
        ...opts,
        onProgress: (f, msg) => {
          partial.set(i, sizes[i] * f);
          report(t('{msg}: {name}（{2}/{length}）', { msg, name, 2: finished + 1, length: wavs.length }));
        }
      });
      partial.delete(i);
      doneBytes += sizes[i];
      finished++;
      if (outcome.ok) {
        result.converted! += 1;
        result.beforeBytes! += outcome.before;
        result.afterBytes! += outcome.after;
      } else {
        result.skipped!.push({ path: wav, reason: outcome.skipped });
      }
      report(t('{finished}/{length} 件', { finished, length: wavs.length }));
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return result;
}

/** 作業フォルダ内の書き出し先。元のパスから名前を作るので、日本語や記号を含むパスでも安全 */
async function workPathFor(wav: string, opts: ConvertOptions): Promise<string> {
  const size = await sizeOf(wav);
  const free = opts.freeBytes?.(opts.workDir) ?? null;
  // 作業フォルダに入らないほど大きいときは、置き場所の隣に直接書かせる
  if (free !== null && free < size + 256 * 1024 * 1024) return `${wav.replace(/\.wav$/i, '.flac')}.part`;
  await fs.mkdir(opts.workDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(wav).digest('hex').slice(0, 16);
  return path.join(opts.workDir, `${hash}.flac.part`);
}

/** 置き場所へ移す。別ドライブなら複製してから消す */
export async function moveInto(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const tmp = `${to}.moving`;
    await fs.cp(from, tmp, { recursive: true });
    await fs.rename(tmp, to);
    await fs.rm(from, { recursive: true, force: true });
  }
}

export function run(
  exe: string,
  args: string[],
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
  cwd?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      // -progress の出力は延々と続くので、全部は溜めない
      if (onStdout) onStdout(c);
      else stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 8000) stderr += c;
    });
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
