import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { retryTransient } from '../fsRetry';
import { archiveListing, extractArchive, type ArchiveEntry } from './sevenZip';

/**
 * ソリッド形式の rar / 7z の事前展開（NeeView の「事前展開」にならう）。
 *
 * ソリッド形式は、目的のファイルに届くまで頭から展開し直す。1 枚読むたびに 7-Zip を起こしていると、
 * 後ろのページほど遅くなり、一覧を開くと同じところを何十回も展開し直すことになる。
 * そこで、初めて中身を頼まれたときに丸ごと一時フォルダへ展開し、展開できたものからそのファイルを返す。
 *
 * - 7-Zip は中身を並び順に 1 つずつ書く。次のファイルができていれば、その前のファイルは書き終わっている
 *   （7-Zip の進み具合の出力はまとめて最後に出ることがあり、当てにできない）
 * - 展開し終えたものは目印を置いて残し、次に開いたときもそのまま使う（元が変われば別物）
 * - 大きすぎるもの・空きが足りないとき・展開に失敗したときは使わない（呼び出し側は今までどおり 1 枚ずつ取り出す）
 */

/** これより大きい（中身の合計）ものは事前展開しない（NeeView の既定と同じ 1GB） */
export const PRE_EXTRACT_MAX_BYTES = 1024 * 1024 * 1024;
/** 残しておく展開済みの数と合計の上限 */
const KEEP_COUNT = 3;
const KEEP_BYTES = 2 * 1024 * 1024 * 1024;
/** 一度に展開する数。超えたら、いちばん長く使っていないものを止める */
const MAX_RUNNING = 2;
/** 使っている最中とみなす間（このあいだは片付けで消さない） */
const IN_USE_MS = 5 * 60 * 1000;
/** 書き進まないまま、これだけ経ったら諦める */
const STALL_MS = 120_000;
const POLL_MS = 100;
/** 空き容量の余裕 */
const FREE_MARGIN = 512 * 1024 * 1024;

interface Job {
  key: string;
  dir: string;
  bytes: number;
  /** 展開される順のファイル（アーカイブ内のパス） */
  order: string[];
  index: Map<string, number>;
  state: 'running' | 'done' | 'failed';
  /** 先頭からこの数までは書き終わっている */
  ready: number;
  usedAt: number;
  abort: AbortController | null;
}

let root = '';
const jobs = new Map<string, Job>();
/** 確かめている最中・始めている最中（アーカイブ → 処理）。同時に頼まれても 7-Zip を 2 本起こさない */
const resolving = new Map<string, Promise<Job | null>>();

export function configurePreExtract(dir: string): void {
  root = dir;
}

/**
 * 事前展開したファイルの場所。事前展開の対象でない・使えないときは null（呼び出し側が 1 枚ずつ取り出す）。
 * 展開がまだそのファイルに届いていなければ、届くまで待つ。
 */
export async function preExtractedPath(exe: string, archive: string, entry: string): Promise<string | null> {
  if (!root) return null;
  const listing = await archiveListing(exe, archive);
  if (!listing.solid) return null;
  const job = await jobFor(exe, archive, listing.entries);
  if (!job) return null;
  const i = job.index.get(entry);
  if (i === undefined) return null;
  job.usedAt = Date.now();
  if (!(await waitFor(job, i))) return null;
  const file = inside(job.dir, entry);
  if (!file) return null;
  return (await exists(file)) ? file : null;
}

/** 起動時: 展開し終えていないもの（目印が無いもの）と、上限を超えた古いものを片付ける */
export async function cleanPreExtract(): Promise<void> {
  if (!root) return;
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.done')) {
      if (!names.includes(name.slice(0, -'.done'.length))) await fs.rm(path.join(root, name), { force: true }).catch(() => undefined);
      continue;
    }
    if (!names.includes(`${name}.done`)) await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
  await trim();
}

function jobFor(exe: string, archive: string, entries: ArchiveEntry[]): Promise<Job | null> {
  const id = path.resolve(archive).toLowerCase();
  let pending = resolving.get(id);
  if (!pending) {
    pending = findOrStart(exe, archive, entries).finally(() => resolving.delete(id));
    resolving.set(id, pending);
  }
  return pending;
}

async function findOrStart(exe: string, archive: string, entries: ArchiveEntry[]): Promise<Job | null> {
  const files = entries.filter((e) => !e.isDir);
  const bytes = files.reduce((s, e) => s + e.size, 0);
  if (files.length === 0 || bytes > PRE_EXTRACT_MAX_BYTES) return null;
  const stat = await retryTransient(() => fs.stat(archive));
  const key = crypto.createHash('sha1').update(`${path.resolve(archive).toLowerCase()}|${stat.size}|${stat.mtimeMs}`).digest('hex');
  const known = jobs.get(key);
  // 失敗したもの（パスワード付き・壊れているなど）は、開いているあいだは試し直さない（ページごとに丸ごと展開し直さない）
  if (known) return known.state === 'failed' ? null : known;

  const dir = path.join(root, key);
  const order = files.map((e) => e.path);
  const job: Job = { key, dir, bytes, order, index: new Map(order.map((p, i) => [p, i])), state: 'running', ready: 0, usedAt: Date.now(), abort: null };
  // 前に展開し終えたものが残っていれば、そのまま使う
  if ((await exists(`${dir}.done`)) && (await exists(dir))) {
    job.state = 'done';
    job.ready = order.length;
    jobs.set(key, job);
    void touch(`${dir}.done`);
    return job;
  }
  if (!(await enoughSpace(bytes))) return null;
  jobs.set(key, job);
  await makeRoom(job);
  void run(exe, archive, job);
  return job;
}

async function run(exe: string, archive: string, job: Job): Promise<void> {
  const abort = new AbortController();
  job.abort = abort;
  try {
    await fs.rm(job.dir, { recursive: true, force: true });
    await extractArchive(exe, archive, job.dir, { signal: abort.signal });
    job.state = 'done';
    job.ready = job.order.length;
    await fs.writeFile(`${job.dir}.done`, '');
  } catch (err) {
    job.state = 'failed';
    if (!abort.signal.aborted) console.warn(`[pre-extract] 事前展開できませんでした（${path.basename(archive)}）:`, err instanceof Error ? err.message : err);
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    job.abort = null;
  }
}

/** i 番目のファイルが書き終わるまで待つ。展開に失敗した・止めたなら false */
async function waitFor(job: Job, i: number): Promise<boolean> {
  let lastReady = job.ready;
  let lastSize = -1;
  let progressAt = Date.now();
  for (;;) {
    if (job.state === 'done' || i < job.ready) return true;
    if (job.state === 'failed') return false;
    // 次のファイルができていれば、その前までは書き終わっている
    while (job.ready + 1 < job.order.length && (await exists(inside(job.dir, job.order[job.ready + 1])))) job.ready++;
    if (i < job.ready) return true;
    // 書き進んでいるか（大きなファイル 1 つに時間がかかっているだけのときは待つ）
    const writing = inside(job.dir, job.order[job.ready]);
    const size = writing ? await fs.stat(writing).then((s) => s.size, () => -1) : -1;
    if (job.ready !== lastReady || size !== lastSize) {
      lastReady = job.ready;
      lastSize = size;
      progressAt = Date.now();
    } else if (Date.now() - progressAt > STALL_MS) {
      job.abort?.abort();
      return false;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** 一度に展開する数を守り、残しておく展開済みを上限まで減らす */
async function makeRoom(starting: Job): Promise<void> {
  const running = [...jobs.values()].filter((j) => j !== starting && j.state === 'running').sort((a, b) => a.usedAt - b.usedAt);
  while (running.length >= MAX_RUNNING) {
    const oldest = running.shift() as Job;
    oldest.abort?.abort();
    jobs.delete(oldest.key);
  }
  await trim(starting.bytes);
}

/** 展開済みを、数と大きさの上限まで古いものから消す。使っている最中のものは消さない */
async function trim(incoming = 0): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(root)).filter((n) => n.endsWith('.done'));
  } catch {
    return;
  }
  const done = await Promise.all(
    names.map(async (n) => {
      const key = n.slice(0, -'.done'.length);
      const usedAt = jobs.get(key)?.usedAt ?? (await fs.stat(path.join(root, n)).then((s) => s.mtimeMs, () => 0));
      return { key, usedAt, bytes: jobs.get(key)?.bytes ?? (await folderBytes(path.join(root, key))) };
    })
  );
  done.sort((a, b) => a.usedAt - b.usedAt);
  // これから展開するものも数に入れる
  let count = done.length + (incoming > 0 ? 1 : 0);
  let bytes = done.reduce((s, d) => s + d.bytes, 0) + incoming;
  for (const d of done) {
    if (count <= KEEP_COUNT && bytes <= KEEP_BYTES) break;
    if (Date.now() - d.usedAt < IN_USE_MS) continue;
    jobs.delete(d.key);
    await fs.rm(path.join(root, `${d.key}.done`), { force: true }).catch(() => undefined);
    await fs.rm(path.join(root, d.key), { recursive: true, force: true }).catch(() => undefined);
    count--;
    bytes -= d.bytes;
  }
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    total += await fs.stat(path.join(e.parentPath, e.name)).then((s) => s.size, () => 0);
  }
  return total;
}

async function enoughSpace(bytes: number): Promise<boolean> {
  try {
    await fs.mkdir(root, { recursive: true });
    const s = await fs.statfs(root);
    return s.bavail * s.bsize > bytes + FREE_MARGIN;
  } catch {
    return false;
  }
}

/** アーカイブの中のパスを、展開先の中の場所にする（外に出るものは null） */
function inside(dir: string, entry: string): string | null {
  const full = path.resolve(dir, ...entry.split('/'));
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

/** 有るか。開かずに確かめる（新しいファイルを開くと、Windows の検査で待たされることがある） */
function exists(file: string | null): Promise<boolean> {
  return file ? fs.access(file).then(() => true, () => false) : Promise.resolve(false);
}

function touch(file: string): Promise<void> {
  const now = new Date();
  return fs.utimes(file, now, now).catch(() => undefined);
}
