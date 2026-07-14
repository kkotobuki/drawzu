import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/* ────────────────────────────────────────────────────────────
   drawzu MCP ブリッジ（ADR-0003 Phase 2）— AIの窓。
   モデルは drawzu サーバー（server/index.ts）が保持しており、
   このプロセスは stdio(MCP) と HTTP API の間の薄い橋に徹する。
   こうすると Claude Code が何セッション繋いでも、ブラウザと同じ
   1個のモデルを見ることになり、ポート衝突も起きない。

   サーバーが立っていなければブリッジが自分で起動する（detached）。
   Claude Code はブリッジを対象プロジェクトの cwd で spawn するので、
   DRAWZU_ROOT は自然に決まり、ポートもプロジェクトパスから決定的に
   導出する。「Claude Code を開けば drawzu も生きている」を成立させる。
   ──────────────────────────────────────────────────────────── */

const ROOT = resolve(process.env.DRAWZU_ROOT ?? process.cwd());

/* プロジェクトパスから決定的にポートを導出（43117〜44116。エフェメラル帯
   49152〜 と衝突せず、既知サービスの定番ポートも避けた帯）。同じプロジェクト
   なら毎回同じポート、別プロジェクトなら（ほぼ）別ポートになる。 */
function derivePort(root: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of root) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return 43117 + ((h >>> 0) % 1000);
}

const EXPLICIT_URL = process.env.DRAWZU_URL;
const BASE = EXPLICIT_URL ?? `http://127.0.0.1:${derivePort(ROOT)}`;
const PORT = Number(new URL(BASE).port || "80");

/** 生存確認。root はサーバーがどのプロジェクトを見ているか（旧サーバーは null）。
    レスポンスの形まで検証する: /api/health を持たない旧サーバーは 404 ではなく
    SPAフォールバックで index.html(200) を返すため、ステータスだけでは判定できない */
async function ping(): Promise<{ root: string | null } | null> {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { ok?: boolean; root?: string } | null;
      if (body?.ok === true) return { root: typeof body.root === "string" ? body.root : null };
    }
    // 旧バージョンのサーバーか確認。/api/model が model を返せば生きているので使う
    const legacy = await fetch(`${BASE}/api/model`);
    if (legacy.ok) {
      const body = (await legacy.json().catch(() => null)) as { model?: unknown } | null;
      if (body?.model) return { root: null };
    }
    return null;
  } catch {
    return null;
  }
}

function assertRoot(root: string | null): void {
  // DRAWZU_URL 明示時はユーザーの指定を尊重。旧サーバー(root不明)も許容
  if (EXPLICIT_URL || root === null) return;
  if (resolve(root) !== ROOT) {
    throw new Error(
      `ポート${PORT}は別プロジェクト(${root})の drawzu サーバーが使用中です。` +
        `DRAWZU_URL で接続先を明示するか、そちらのサーバーを止めてください。`
    );
  }
}

let ensured = false;

/** サーバーが立っていなければ detached で起動し、応答するまで待つ */
async function ensureServer(): Promise<void> {
  if (ensured) return;
  const alive = await ping();
  if (alive) {
    assertRoot(alive.root);
    ensured = true;
    return;
  }

  const serverPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const logDir = join(ROOT, ".drawzu");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "server.log"), "a");
  // detached: ブリッジ(Claude Codeセッション)が死んでもサーバーは残り、
  // ブラウザや次のセッションがそのまま同じモデルを見続けられる
  spawn(tsxBin, [serverPath], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, DRAWZU_PORT: String(PORT), DRAWZU_ROOT: ROOT },
  }).unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await ping();
    if (health) {
      assertRoot(health.root);
      ensured = true;
      return;
    }
  }
  throw new Error(
    `drawzu サーバー(${BASE})を自動起動できませんでした。${join(logDir, "server.log")} を確認するか、` +
      `drawzu リポジトリで「DRAWZU_PORT=${PORT} DRAWZU_ROOT=${ROOT} npm run start」を試してください。`
  );
}

async function api(path: string, init?: RequestInit): Promise<string> {
  await ensureServer();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    ensured = false; // 起動確認後に落ちた。次の呼び出しで再起動を試みる
    throw new Error(`drawzu サーバー(${BASE})との通信に失敗しました。もう一度試してください。`);
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
