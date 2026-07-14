import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { emptyModel } from "../core/model.ts";
import { ModelHub } from "../core/hub.ts";
import { OpSchema } from "../core/ops.ts";
import { toSQL } from "../core/sql.ts";
import { FileStore } from "../core/store.ts";

/* ────────────────────────────────────────────────────────────
   drawzu ローカルサーバー（ADR-0003 Phase 1）
   - 対象プロジェクト（DRAWZU_ROOT、既定は起動時のカレント）の
     .drawzu/model.json を真実の源として読み書き
   - /ws     … ブラウザのER図ビューとのライブ同期
   - /api/*  … スナップショット取得（model / sql）
   - /       … web/dist（ビルド済みビュー）を配信
   ──────────────────────────────────────────────────────────── */

const PORT = Number(process.env.DRAWZU_PORT ?? 4989);
const ROOT = resolve(process.env.DRAWZU_ROOT ?? process.cwd());
const MODEL_PATH = join(ROOT, ".drawzu", "model.json");
const WEB_DIST = fileURLToPath(new URL("../web/dist", import.meta.url));

/* 悪意あるWebページからの localhost 攻撃(CSRF / WebSocketハイジャック)対策。
   ブラウザはクロスサイト要求に必ず Origin を付けるので、許可リスト外の Origin は弾く。
   Origin が無いのは非ブラウザクライアント(MCPブリッジ・curl等 = 同一マシン)なので許可。 */
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const originOk = (origin: string | undefined) => !origin || ALLOWED_ORIGINS.has(origin);

/* アイドル自動停止（MCPブリッジの自動起動と一対のライフサイクル管理）。
   ブラウザ(WS)が1つも繋がっておらず、最後のアクセスからこの時間が過ぎたら自発終了する。
   次に必要になればブリッジが再起動するので、体感は「常に生きている」のまま。0 で無効 */
const IDLE_TIMEOUT_MIN = Number(process.env.DRAWZU_IDLE_TIMEOUT ?? 30);
let lastActivity = Date.now();

const store = new FileStore(MODEL_PATH);
const loaded = await store.load();
const hub = new ModelHub(store, loaded ?? emptyModel());
if (!loaded) await store.save(hub.model);

/** 全クライアント（開いているブラウザ）へ最新モデルを配る。except は楽観適用済みの送信元 */
function broadcastModel(except?: import("ws").WebSocket) {
  const payload = JSON.stringify({ type: "model", version: hub.version, model: hub.model });
  for (const client of wss.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  lastActivity = Date.now();
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // MCPブリッジの生存確認・接続先確認用。root を返すのは「別プロジェクトの
  // サーバーに誤接続していないか」をブリッジ側で検証できるようにするため
  if (path === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, root: ROOT, version: hub.version }));
    return;
  }
  if (path === "/api/model") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ version: hub.version, model: hub.model }));
    return;
  }
  if (path === "/api/sql") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(toSQL(hub.model));
    return;
  }

  // MCPブリッジ等の外部窓からの変更受け口。op の配列を順に適用して全ブラウザへ配る
  if (path === "/api/ops" && req.method === "POST") {
    if (!originOk(req.headers.origin)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "許可されていない Origin からの要求です" }));
      return;
    }
    // application/json を強制すると、クロスサイトの単純POST(text/plain等)を弾ける
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Content-Type: application/json で送ってください" }));
      return;
    }
    try {
      const parsed = JSON.parse(await readBody(req));
      const raw: unknown[] = Array.isArray(parsed) ? parsed : parsed?.ops;
      if (!Array.isArray(raw) || raw.length === 0) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "ops の配列を送ってください: { ops: [...] }" }));
        return;
      }
      const ops = raw.map((o, i) => {
        const r = OpSchema.safeParse(o);
        if (!r.success) throw new Error(`ops[${i}] が不正です: ${r.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
        return r.data;
      });
      let version = hub.version;
      for (const op of ops) version = hub.apply(op).version;
      broadcastModel();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ version, applied: ops.length }));
    } catch (e: any) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }

  // 静的配信（ビルド済みWebビュー）。開発中は vite dev サーバー(5173)を使う
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "drawzu server is running.\n" +
        "Webビューが未ビルドです: npm run build:web\n" +
        "開発中は npm run dev:web で http://localhost:5173 を開いてください。\n"
    );
    return;
  }
  const rel = path === "/" ? "/index.html" : path;
  const file = normalize(join(WEB_DIST, rel));
  if (!file.startsWith(WEB_DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA フォールバック
    const body = await readFile(join(WEB_DIST, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(body);
  }
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  // クロスサイトのWebSocketハイジャック対策（ブラウザは Origin を必ず送る）
  verifyClient: ({ origin }: { origin?: string }) => originOk(origin),
});

wss.on("connection", (ws: WebSocket) => {
  lastActivity = Date.now();
  // 切断時刻を起点にしないと「ブラウザを長時間開いて閉じた直後」に即終了してしまう
  ws.on("close", () => {
    lastActivity = Date.now();
  });
  ws.send(JSON.stringify({ type: "model", version: hub.version, model: hub.model }));

  ws.on("message", (data) => {
    lastActivity = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "JSONとして解釈できませんでした" }));
      return;
    }
    const op = OpSchema.safeParse(parsed);
    if (!op.success) {
      ws.send(JSON.stringify({ type: "error", message: op.error.message }));
      return;
    }
    const { version } = hub.apply(op.data);
    // 送信元は楽観適用済みなので ack のみ。他の窓には全量を配る
    ws.send(JSON.stringify({ type: "ack", version }));
    broadcastModel(ws);
  });
});

// 127.0.0.1 に明示バインドし、同一LANの他マシンから届かないようにする
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[drawzu] model: ${MODEL_PATH}`);
  console.log(`[drawzu] web:   http://localhost:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await hub.flush();
    process.exit(0);
  });
}

if (IDLE_TIMEOUT_MIN > 0) {
  // チェック間隔はタイムアウトより細かく（短いタイムアウト設定でも遅延なく効くように）
  const tick = Math.min(60_000, IDLE_TIMEOUT_MIN * 60_000);
  setInterval(async () => {
    if (wss.clients.size > 0) return;
    if (Date.now() - lastActivity < IDLE_TIMEOUT_MIN * 60_000) return;
    console.log(`[drawzu] ${IDLE_TIMEOUT_MIN}分間使われていないため自動終了します`);
    await hub.flush();
    process.exit(0);
  }, tick);
}
