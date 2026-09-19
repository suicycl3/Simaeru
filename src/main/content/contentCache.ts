import fs from 'node:fs/promises';
import type { ContentIndex, InstallAnalysis } from '@shared/types';
import { decideStorage } from '@shared/storagePolicy';
import type { Repo } from '../db/repo';
import { analyzeProduct } from '../install/installService';
import { buildContentIndex } from './contentIndex';

/**
 * 作品の中身の見取り図（音声・画像・台本…）とインストール判定を、DB に作り置きする。
 *
 * 以前は詳細を開くたびにアーカイブやフォルダを読み直していたので、
 * - 開くたびに待たされる（新しいファイルは Defender の照会で30秒ほど）
 * - 詳細を切り替えても、読み終わるまで前の作品の中身が残って見える
 * という問題があった。
 *
 * - ダウンロード・展開・FLAC 変換・取り込み・移動のあとに作り直す（裏で1件ずつ）
 * - 詳細を開いたら作り置きをすぐ返す。台帳が変わっていたら（signature 不一致）裏で作り直して知らせる
 * - ファイルの有無は、開いたときに「開かずに」確かめる（fs.access は検査を待たされない）
 */

export interface CachedContent {
  index: ContentIndex;
  install: InstallAnalysis[];
  /** 台帳と一致している（false なら裏で作り直し中） */
  fresh: boolean;
  updatedAt: number;
}

export interface ContentCacheOptions {
  repo: Repo;
  sevenZip: () => string | null;
  /** 作り直しが済んだ（画面に読み直させる） */
  onUpdated: (productRef: number) => void;
}

export class ContentCache {
  private queue: number[] = [];
  private queued = new Set<number>();
  private inflight = new Map<number, Promise<CachedContent>>();
  private pumping = false;

  constructor(private opts: ContentCacheOptions) {}

  /**
   * 作り置きの印。見取り図の形を変えたら VERSION を上げる（古い作り置きは作り直される）。
   * v2: MP3 などがある WAV / FLAC（lossyOnly）を足した
   * v3: 画像と同じ内容の PDF（pdfStrip）を足した
   * v4: PDF の見分け方を変えた（画像フォルダごとの大きさ・フォルダ名との重なり）
   */
  private signature(productRef: number): string {
    return `v4|${this.opts.repo.localFileSignature(productRef)}`;
  }

  /** 作り置きを返す。無ければ null（呼び出し側が build を待つ） */
  get(productRef: number): CachedContent | null {
    const row = this.opts.repo.getContentCache(productRef);
    if (!row) return null;
    const fresh = row.signature === this.signature(productRef);
    if (!fresh) this.schedule(productRef);
    try {
      const index = JSON.parse(row.indexJson) as ContentIndex;
      // 古い形の作り置き（項目が足りない）は作り直すまでの間、空で埋めておく
      index.lossyOnly ??= [];
      index.pdfStrip ??= [];
      return {
        index,
        install: JSON.parse(row.installJson) as InstallAnalysis[],
        fresh,
        updatedAt: row.updatedAt
      };
    } catch {
      this.schedule(productRef);
      return null;
    }
  }

  /** 作り置きがあればそれを、無ければ作ってから返す */
  async getOrBuild(productRef: number): Promise<CachedContent> {
    return this.get(productRef) ?? this.build(productRef);
  }

  /** 今すぐ作り直す（同じ作品を並べて作らない） */
  build(productRef: number): Promise<CachedContent> {
    const running = this.inflight.get(productRef);
    if (running) return running;
    const job = (async (): Promise<CachedContent> => {
      const repo = this.opts.repo;
      // 作り始める前の印で保存する。作っている最中に台帳が変わったら、次に見たとき不一致になって作り直される
      const signature = this.signature(productRef);
      const product = repo.getProduct(productRef);
      const files = repo.localFiles(productRef);
      const index = await buildContentIndex(productRef, files, this.opts.sevenZip(), (a) => repo.extractedFrom(a));
      if (product && index.archives.length > 0) {
        index.storage = decideStorage(product, { hasExecutable: index.archives.some((a) => a.hasExecutable) });
      }
      const install = await analyzeProduct(repo, productRef);
      // 読めなかったものがある結果は作り置きにしない（一時的な失敗を、次に開いたときも引きずらないため）
      const failed = index.sources.some((s) => s.error);
      if (files.length === 0 || failed) repo.deleteContentCache(productRef);
      else repo.setContentCache(productRef, signature, JSON.stringify(index), JSON.stringify(install));
      if (failed) console.warn(`[content] 作品 ${productRef}: ${index.sources.filter((s) => s.error).map((s) => s.error).join(' / ')}`);
      return { index, install, fresh: true, updatedAt: Date.now() };
    })().finally(() => this.inflight.delete(productRef));
    this.inflight.set(productRef, job);
    return job;
  }

  /** 裏で作り直す（済んだら onUpdated で知らせる） */
  schedule(productRef: number): void {
    if (this.queued.has(productRef)) return;
    this.queued.add(productRef);
    this.queue.push(productRef);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const productRef = this.queue.shift()!;
        this.queued.delete(productRef);
        try {
          await this.build(productRef);
          this.opts.onUpdated(productRef);
        } catch (err) {
          console.warn(`[content] 作品 ${productRef} の見取り図を作れませんでした:`, err);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * 詳細を開いたときの確認。ファイルがあるかだけを「開かずに」見て、変わっていれば台帳を直して作り直す。
   * @returns 変わったものがあったか
   */
  async verify(productRef: number): Promise<boolean> {
    const repo = this.opts.repo;
    let changed = false;
    for (const f of repo.localFiles(productRef)) {
      const exists = await fs.access(f.path).then(
        () => true,
        () => false
      );
      if (exists === !f.missingAt) continue;
      repo.setLocalFileMissing(f.id, exists ? null : Date.now());
      changed = true;
    }
    // 作り置きが無い、または「手元にファイルがあるのに中身が空」の作り置きなら作り直す
    const cached = changed ? null : this.get(productRef);
    const hasFiles = repo.localFiles(productRef).some((f) => !f.missingAt);
    if (changed || !cached || (hasFiles && cached.index.sources.length === 0)) this.schedule(productRef);
    return changed;
  }

  /**
   * 手元の状態をまとめて最新にする: 実体の有無 → 全作品の見取り図の作り直し。
   * 1件ずつ進め、進みぐあいを知らせる。
   */
  async refreshAll(onProgress: (done: number, total: number, title: string | null) => void): Promise<{ products: number; missing: number; errors: number }> {
    const repo = this.opts.repo;
    const missing = await repo.markMissingFilesAsync((p) =>
      fs.access(p).then(
        () => true,
        () => false
      )
    );
    const products = [...repo.productsWithFiles()];
    let errors = 0;
    for (const [i, productRef] of products.entries()) {
      onProgress(i, products.length, repo.getProduct(productRef)?.title ?? null);
      try {
        await this.build(productRef);
        this.opts.onUpdated(productRef);
      } catch {
        errors++;
      }
    }
    onProgress(products.length, products.length, null);
    return { products: products.length, missing, errors };
  }
}
