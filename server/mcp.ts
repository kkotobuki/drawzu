import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/* ────────────────────────────────────────────────────────────
   drawzu MCP ブリッジ（ADR-0003 Phase 2）— AIの窓。
   モデルは drawzu サーバー（server/index.ts）が保持しており、
   このプロセスは stdio(MCP) と HTTP API の間の薄い橋に徹する。
   こうすると Claude Code が何セッション繋いでも、ブラウザと同じ
   1個のモデルを見ることになり、ポート衝突も起きない。
   ──────────────────────────────────────────────────────────── */

const BASE = process.env.DRAWZU_URL ?? "http://localhost:4989";

async function api(path: string, init?: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(
      `drawzu サーバー(${BASE})に接続できません。対象プロジェクトで「npm run dev」(drawzu リポジトリ) を起動してください。`
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`drawzu サーバーがエラーを返しました: ${body}`);
  return body;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const server = new McpServer({ name: "drawzu", version: "0.1.0" });

server.tool(
  "get_model",
  [
    "スキーマ設計の真実の源であるモデル（テーブル・カラム・FK・インデックス・RLS）を取得する。",
    "DBに関するコードを書く前・スキーマについて答える前に必ずこれを読んで、モデルを前提にすること。",
    "テーブルの comment には人間が書いた設計メモ（何を保存する・何に紐づく）が入っていることがある。",
  ].join("\n"),
  {},
  async () => text(await api("/api/model"))
);

server.tool(
  "patch_model",
  [
    "モデルに変更操作(op)の配列を適用する。適用結果は開いているブラウザのER図に即座に反映される。",
    "op の種類:",
    '- {"type":"ADD_TABLE","table":{id,name,x,y,columns:[...],indexes:[],rlsEnabled,rls:[],comment}}',
    '- {"type":"UPDATE_TABLE","id","patch":{name?,x?,y?,comment?,rlsEnabled?}}',
    '- {"type":"RENAME_TABLE","id","name"} / {"type":"MOVE_TABLE","id","x","y"} / {"type":"DELETE_TABLE","id"}',
    '- {"type":"ADD_COLUMN","tableId","column":{id,name,type,pk,nullable,unique,fk,default,comment}}',
    '- {"type":"UPDATE_COLUMN","tableId","columnId","patch":{...}} / {"type":"DELETE_COLUMN","tableId","columnId"}',
    '- {"type":"ADD_INDEX","tableId","index":{id,name,columns:[カラムid],unique}} / UPDATE_INDEX / DELETE_INDEX',
    '- {"type":"SET_MODEL","model":{modelVersion:1,tables:[...]}} … introspect結果の一括流し込み・全置換用',
    "規約: id は自分で採番する（テーブル t_<name>、カラム c_<name>_<col>、インデックス i_<name>_n 推奨）。",
    'RLSポリシーの形: {id,name,command:"select|insert|update|delete|all",roles:["authenticated"等],using,withCheck,audience:[...]}。',
    'audience は「このポリシーで許可される相手」の表示ラベル（例:["閲覧者","編集者"]/["オーナー"]/["本人"]）。図の権限×操作表の行になるので必ず付けること。name も「編集者はモデルを更新可」のように誰が何をできるかが分かる日本語にする。',
    "FK は {tableId} で参照先テーブルを指す（参照先カラムは相手のPK）。インデックスの columns はカラム名でなくカラム id。",
    "型は uuid/text/varchar/int8/int4/numeric/boolean/timestamptz/date/jsonb。",
    "座標 x,y はER図上の配置。新規テーブルは既存と重ならない位置に置くこと（カード幅248px、高さ約40+行数×30px）。",
  ].join("\n"),
  { ops: z.array(z.record(z.unknown())).describe("適用する op の配列。上記の形式に従うこと") },
  async ({ ops }) => {
    const res = await api("/api/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops }),
    });
    return text(`適用しました: ${res}`);
  }
);

server.tool(
  "to_sql",
  "モデルをSQL DDL（create table / FK / create index / comment / RLSポリシー）へ投影して返す。モデルが真実の源で、このSQLはその投影。",
  {},
  async () => text(await api("/api/sql"))
);

await server.connect(new StdioServerTransport());
