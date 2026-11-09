import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { emptyModel } from "../core/model.ts";
import { ModelHub } from "../core/hub.ts";
import { OpSchema } from "../core/ops.ts";
import { toSQL } from "../core/sql.ts";
import { FileStore } from "../core/store.ts";
import { BodyTooLargeError, hostOk, MAX_BODY_BYTES, originOk as isAllowedOrigin, readBodyLimited, resolveStaticFile } from "./guard.ts";

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
   Origin が無いのは非ブラウザクライアント(MCPブリッジ・curl等 = 同一マシン)なので許可。
   加えて Host ヘッダも localhost 系に限定する（DNS リバインディングで攻撃者ドメインから
   同一オリジン扱いで GET /api/model 等を読まれるのを防ぐ）。判定の実体は server/guard.ts */
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const originOk = (origin: string | undefined) => isAllowedOrigin(origin, ALLOWED_ORIGINS);

/* アイドル自動停止（MCPブリッジの自動起動と一対のライフサイクル管理）。
   ブラウザ(WS)が1つも繋がっておらず、最後のアクセスからこの時間が過ぎたら自発終了する。
   次に必要になればブリッジが再起動するので、体感は「常に生きている」のまま。0 で無効 */
const IDLE_TIMEOUT_MIN = Number(process.env.DRAWZU_IDLE_TIMEOUT ?? 30);
let lastActivity = Date.now();

const store = new FileStore(MODEL_PATH);
const loaded = await store.load();
const hub = new ModelHub(store, loaded ?? emptyModel());
// 無ければ空モデルを書くが、それは listen に成功した後で行う（同じプロジェクトで同時に起動された
// 2 本目は EADDRINUSE で落ちる。listen 前に書くと敗者も model.json に触ってしまう）

/* 終了処理。シグナルやアイドル停止で呼ばれる。
   新しい変更の受け付けを止めてから flush しないと、flush の await 中に届いた変更が
   保存されずに process.exit で消える。保存に失敗していれば exit 1 で知らせる */
let shuttingDown = false;
async function shutdown(reason: string): Promise<never> {
  if (shuttingDown) return new Promise(() => {}); // 2 回目以降は最初の終了処理に任せる
  shuttingDown = true;
  console.log(`[drawzu] 終了します（${reason}）`);
  server.close(); // 新規接続を止める（進行中の要求は shuttingDown で 503 を返す）
  for (const client of wss.clients) client.close(1001, "server shutting down");
  try {
    await hub.flush();
    process.exit(0);
  } catch (e) {
    console.error("[drawzu] 終了時の保存に失敗しました。model.json は直前の内容のままです:", e);
    process.exit(1);
  }
}

/** 全クライアント（開いているブラウザ）へ最新モデルを配る。except は楽観適用済みの送信元 */
function broadcastModel(except?: import("ws").WebSocket) {
  const payload = JSON.stringify({ type: "model", version: hub.version, model: hub.model });
  for (const client of wss.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
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
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (!hostOk(req.headers.host)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "localhost 以外の Host からの要求は受け付けません" }));
    return;
  }
  // 弾いた要求でアイドル自動停止を延命させない（Host 検査の後で更新する）
  lastActivity = Date.now();

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
    if (shuttingDown) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", connection: "close" });
      res.end(JSON.stringify({ error: "サーバーは終了処理中です。もう一度試してください" }));
      return;
    }
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
      const parsed = JSON.parse(await readBodyLimited(req));
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
      // 本文を待っている間に終了処理が始まっていたら適用しない（適用すると flush 後に消えるのに 200 を返してしまう）
      if (shuttingDown) {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "サーバーは終了処理中です。変更は適用されませんでした。もう一度試してください" }));
        return;
      }
      let version = hub.version;
      for (const op of ops) version = hub.apply(op).version;
      broadcastModel();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ version, applied: ops.length }));
    } catch (e: any) {
      // 413 でも socket は閉じない（残りは readBodyLimited / Node が読み捨てる）。即 destroy すると
      // クライアントに 413 が届く前に RST になり、MCP ブリッジが「通信失敗」と誤報する
      const status = e instanceof BodyTooLargeError ? 413 : 400;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
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
  const file = resolveStaticFile(WEB_DIST, path);
  if (!file) {
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
  maxPayload: MAX_BODY_BYTES,
  // クロスサイトのWebSocketハイジャック対策（ブラウザは Origin を必ず送る）+ DNS リバインディング対策
  verifyClient: ({ origin, req }: { origin?: string; req: import("node:http").IncomingMessage }) =>
    originOk(origin) && hostOk(req.headers.host),
});

// ws は server オプション指定時に http サーバーの 'error' も wss へ転送する。ここで受けるだけだと
// listen 失敗(EADDRINUSE)まで飲み込んで「何も listen しないプロセス」が残るので、
// サーバー自身のエラーは明示的に落とす（MCP ブリッジは ping で生存判定するので再起動に支障はない）
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(`[drawzu] サーバーを起動できません: ${e.code ?? ""} ${e.message}`);
  process.exit(1);
});
wss.on("error", (e) => console.error("[drawzu] ws server error:", e.message));

wss.on("connection", (ws: WebSocket) => {
  lastActivity = Date.now();
  // maxPayload 超過・不正フレームは ws が接続ごとの 'error' で通知し、リスナーが無いと
  // プロセスごと落ちる（ws 側が 1009 等で close まで行うので、ここでは記録だけでよい）
  ws.on("error", (e) => console.warn("[drawzu] ws error:", e.message));
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
    if (shuttingDown) {
      ws.send(JSON.stringify({ type: "error", message: "サーバーは終了処理中です。変更は適用されませんでした" }));
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
  if (!loaded) {
    void store.save(hub.model).catch((e) => console.error("[drawzu] 初期モデルの保存に失敗:", e));
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown(sig));
}

if (IDLE_TIMEOUT_MIN > 0) {
  // チェック間隔はタイムアウトより細かく（短いタイムアウト設定でも遅延なく効くように）
  const tick = Math.min(60_000, IDLE_TIMEOUT_MIN * 60_000);
  setInterval(() => {
    if (wss.clients.size > 0) return;
    if (Date.now() - lastActivity < IDLE_TIMEOUT_MIN * 60_000) return;
    void shutdown(`${IDLE_TIMEOUT_MIN}分間使われていないため自動終了`);
  }, tick);
}
