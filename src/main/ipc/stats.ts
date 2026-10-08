import { t } from '@shared/i18n';
import {
  buildDictionaryView,
  buildPurchaseStats,
  buildRaceData,
  type DictionaryView,
  type PurchaseStats,
  type RaceData,
  type RaceOptions,
  type StatsFilter
} from '@shared/purchaseStats';
import {
  TAG_GROUPS,
  applyDictionaryEdit,
  parseTagOverrides,
  type DictionaryEdit,
  type TagRuleOverrides
} from '@shared/tagRules';
import { app, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { EXPORT_FORMATS, type ExportOptions } from '@shared/statsExport';
import { knownBlurbTags } from '../stats/blurbTags';
import { VideoExporter } from '../stats/videoExport';
import type { IpcServices } from './services';

/** 統計で数えるタグの上書き（利用者が外した・数えるに戻したタグ） */
export const STATS_TAG_RULES_SETTING = 'stats.tagRules';

/**
 * 購入履歴の統計と、件数の移り変わりの動画・GIF の書き出し（設定の「統計・書き出し」）。
 * 集計は台帳を読むだけ。書き出しは利用者が選んだ保存先に 1 つのファイルを作るだけで、通信はしない。
 */
export function registerStatsIpc({ repo, jobs, workDir, getWindow }: Pick<IpcServices, 'repo' | 'jobs' | 'workDir' | 'getWindow'>) {
  // 利用者の上書きに、店舗ページで分かった宣伝文句を足す（宣伝文句は利用者の上書きとは別に持つ）
  const overrides = (): TagRuleOverrides => ({
    ...parseTagOverrides(repo.getSetting(STATS_TAG_RULES_SETTING)),
    blurbs: knownBlurbTags(repo)
  });
  const exporter = new VideoExporter({ ffmpeg: () => jobs.tools().ffmpeg, workDir });

  ipcMain.handle('stats:summary', (_e, filter: StatsFilter): PurchaseStats =>
    buildPurchaseStats(repo.statsRows(), filter ?? {}, overrides())
  );

  ipcMain.handle('stats:race', (_e, options: RaceOptions): RaceData =>
    buildRaceData(repo.statsRows(), options, overrides())
  );

  ipcMain.handle('stats:tagRules', (): TagRuleOverrides => {
    const { exclude, include, groups } = overrides();
    return { exclude, include, groups };
  });

  const save = (next: TagRuleOverrides): TagRuleOverrides => {
    const { exclude, include, groups, dismissed } = next;
    repo.setSetting(STATS_TAG_RULES_SETTING, JSON.stringify({ exclude, include, groups, ...(dismissed?.length ? { dismissed } : {}) }));
    return { exclude, include, groups };
  };

  /** タグを外す・数えるに戻す・既定に戻す（key は名寄せの鍵） */
  ipcMain.handle('stats:setTagRule', (_e, key: string, action: 'exclude' | 'include' | 'reset'): TagRuleOverrides => {
    if (typeof key !== 'string' || !key) throw new Error('bad key');
    const current = overrides();
    const next: TagRuleOverrides = {
      ...current,
      exclude: current.exclude.filter((k) => k !== key),
      include: current.include.filter((k) => k !== key)
    };
    if (action === 'exclude') next.exclude.push(key);
    else if (action === 'include') next.include.push(key);
    return save(next);
  });

  /** 自分で外したタグをすべて数えるに戻す */
  ipcMain.handle('stats:clearExcluded', (): TagRuleOverrides => save({ ...overrides(), exclude: [] }));

  ipcMain.handle('stats:dictionary', (): DictionaryView => buildDictionaryView(repo.statsRows(), overrides()));

  /**
   * 名寄せの辞典を編集する（reset で既定に戻す）。
   * グループの名前を変えた・消したときは、そのグループに付けた「数えない／数える」の印も付け替える・外す
   */
  ipcMain.handle('stats:editDictionary', (_e, edit: DictionaryEdit | { type: 'reset' }): DictionaryView => {
    const current = overrides();
    if (edit?.type === 'reset') {
      save({ ...current, groups: null });
    } else {
      const before = current.groups ?? TAG_GROUPS;
      const groups = applyDictionaryEdit(before, edit);
      // 名前は編集のときに整える（空白・全角半角）ので、編集のあとに増えた名前を新しい名前とする
      const renamed = Object.keys(groups).find((label) => !(label in before)) ?? (edit.type === 'renameGroup' ? edit.from : '');
      const move = (keys: string[]): string[] => {
        if (edit.type === 'renameGroup') return keys.map((k) => (k === `g:${edit.from}` ? `g:${renamed}` : k));
        if (edit.type === 'deleteGroup') return keys.filter((k) => k !== `g:${edit.label}`);
        return keys;
      };
      save({ ...current, exclude: move(current.exclude), include: move(current.include), groups });
    }
    return buildDictionaryView(repo.statsRows(), overrides());
  });

  /** 名寄せ辞典の「寄せる候補」から 1 組を外す（以後は出さない） */
  ipcMain.handle('stats:dismissSuggestion', (_e, id: string): DictionaryView => {
    if (typeof id !== 'string' || !id.includes('|')) throw new Error('bad id');
    const current = overrides();
    save({ ...current, dismissed: [...new Set([...(current.dismissed ?? []), id])] });
    return buildDictionaryView(repo.statsRows(), overrides());
  });

  /** 保存先を選ばせて、書き出しを始める。取り消したら null */
  ipcMain.handle('stats:exportBegin', async (_e, options: ExportOptions, defaultName: string): Promise<{ id: string; path: string } | null> => {
    const format = EXPORT_FORMATS[options?.format];
    if (!format) throw new Error('bad format');
    const win = getWindow();
    const safeName = String(defaultName || 'purchases').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const dialogOptions = {
      // 既定はダウンロード（ドキュメント・ビデオは「フォルダー アクセスの制御」で書けないことがある）
      defaultPath: path.join(app.getPath('downloads'), `${safeName}.${format.ext}`),
      filters: [{ name: t(format.label), extensions: [format.ext] }]
    };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return null;
    return { id: exporter.begin(options, result.filePath), path: result.filePath };
  });

  ipcMain.handle('stats:exportFrame', (_e, id: string, rgba: Uint8Array) => exporter.frame(id, rgba));
  ipcMain.handle('stats:exportEnd', (_e, id: string) => exporter.end(id));
  ipcMain.handle('stats:exportCancel', (_e, id: string) => exporter.cancel(id));
}
