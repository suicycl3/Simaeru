import { t } from './i18n';

/**
 * MCP サーバーが出しているツール（設定の「MCP」タブで一覧にする）。
 * 名前は src/main/mcp/mcpServer.ts の registerTool と同じにする（tools/test-mcp.mjs で突き合わせる）
 */
export type McpToolKind = 'read' | 'library' | 'site';

export const MCP_TOOL_KIND_LABELS = (): Record<McpToolKind, string> => ({
  read: t('読み取り'),
  library: t('ライブラリを変更'),
  site: t('サイトにアクセス')
});

export const MCP_TOOLS = (): Array<{ name: string; kind: McpToolKind; summary: string }> => [
  { name: 'search_works', kind: 'read', summary: t('作品を探す（文字・タグ・サークル・声優など・区分・種別・お気に入り・使った・手元にあるか・プレイリスト。並べ替えも）') },
  { name: 'get_work', kind: 'read', summary: t('作品の詳細（説明文・スタッフ・すべてのタグ・入っているプレイリスト・手元のファイルの名前と大きさ）') },
  { name: 'list_tags', kind: 'read', summary: t('タグの一覧と作品数') },
  { name: 'list_brands', kind: 'read', summary: t('サークル・ブランドの一覧と作品数') },
  { name: 'list_people', kind: 'read', summary: t('声優・作者・イラストなどの一覧と作品数') },
  { name: 'list_playlists', kind: 'read', summary: t('プレイリストの一覧') },
  { name: 'purchase_stats', kind: 'read', summary: t('購入の統計（サイト・種別・月ごと、タグ・サークル・声優・作者の上位）。期間は月・日付・直近の日数で絞れる') },
  { name: 'get_status', kind: 'read', summary: t('同期中か、ダウンロードの状況、詳細の自動取得の状況') },
  { name: 'set_favorite', kind: 'library', summary: t('★お気に入りを付ける・外す') },
  { name: 'set_used', kind: 'library', summary: t('♥使った を付ける・外す') },
  { name: 'add_to_playlist', kind: 'library', summary: t('プレイリストに作品を足す（名前を指定すると、無ければ作る）') },
  { name: 'show_work', kind: 'library', summary: t('アプリの画面で作品の詳細を開く') },
  { name: 'download_works', kind: 'site', summary: t('作品をダウンロードのキューに入れる') },
  { name: 'start_sync', kind: 'site', summary: t('購入履歴の同期を始める') }
];
