import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

/* server/index.ts を実プロセスとして起動し、HTTP/WS の境界が効くことを確認する回帰テスト。
   モデルの置き場は一時ディレクトリ（リポジトリの .drawzu は触らない） */

const here = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(here, "..", "server", "index.ts");
const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");

let child: ChildProcess;
let port: number;
let root: string;
const base = () => `http://127.0.0.1:${port}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

before(async () => {
  port = await freePort();
  root = mkdtempSync(join(tmpdir(), "drawzu-test-"));
  child = spawn(tsxBin, [serverPath], {
    env: { ...process.env, DRAWZU_PORT: String(port), DRAWZU_ROOT: root, DRAWZU_IDLE_TIMEOUT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`${base()}/api/health`);
      if (res.ok) return;
    } catch {}
  }
  throw new Error(`server did not start:\n${log}`);
});

after(() => {
  child?.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
});

test("GET /api/health: 正しい Host なら ok と root を返す", async () => {
  const res = await fetch(`${base()}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; root: string };
  assert.equal(body.ok, true);
  assert.equal(body.root, root);
});

/* fetch(undici) は Host ヘッダの上書きを黙って捨てるので、Host を偽装する試験は node:http で送る */
function getWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host }, setHost: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("Host が localhost 系でない要求(DNS リバインディング)は 403", async () => {
  assert.equal(await getWithHost("/api/model", "attacker.example"), 403);
  assert.equal(await getWithHost("/api/health", `localhost.attacker.example:${port}`), 403);
  assert.equal(await getWithHost("/", `127.0.0.1.nip.io:${port}`), 403);
});

test("Host が localhost:別ポート(vite dev プロキシ経由)や [::1] は通る", async () => {
  assert.equal(await getWithHost("/api/health", "localhost:5173"), 200);
  assert.equal(await getWithHost("/api/health", `[::1]:${port}`), 200);
});

const op = { type: "ADD_TABLE", table: { id: "t_x", name: "x", columns: [] } };

test("POST /api/ops: 許可外 Origin は 403、モデルは変わらない", async () => {
  const res = await fetch(`${base()}/api/ops`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ ops: [op] }),
  });
  assert.equal(res.status, 403);
  const model = (await (await fetch(`${base()}/api/model`)).json()) as { model: { tables: unknown[] } };
  assert.equal(model.model.tables.length, 0);
});

test("POST /api/ops: Content-Type が application/json 以外は 415", async () => {
  const res = await fetch(`${base()}/api/ops`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ ops: [op] }),
  });
  assert.equal(res.status, 415);
});

test("POST /api/ops: 本文が上限超なら 413", async () => {
  const huge = JSON.stringify({ ops: [{ ...op, table: { ...op.table, comment: "x".repeat(11 * 1024 * 1024) } }] });
  const res = await fetch(`${base()}/api/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  }).catch((e) => e);
  // サーバーは 413 を返して接続を閉じる。クライアント側では 413 か接続エラーのどちらかで観測される
  if (res instanceof Response) assert.equal(res.status, 413);
  else assert.ok(res instanceof Error);
  const model = (await (await fetch(`${base()}/api/model`)).json()) as { model: { tables: unknown[] } };
  assert.equal(model.model.tables.length, 0);
});

test("POST /api/ops: 不正な op は 400 で、形式エラーのみ返す", async () => {
  const res = await fetch(`${base()}/api/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ type: "NOPE" }] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /ops\[0\]/);
});

test("POST /api/ops: Origin 無し(MCPブリッジ相当)+JSON は適用される", async () => {
  const res = await fetch(`${base()}/api/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [op] }),
  });
  assert.equal(res.status, 200);
  const model = (await (await fetch(`${base()}/api/model`)).json()) as { model: { tables: { id: string }[] } };
  assert.deepEqual(model.model.tables.map((t) => t.id), ["t_x"]);
});

function wsAttempt(headers: Record<string, string>): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
}

test("WebSocket: 許可外 Origin / 非 localhost Host は握手で拒否される", async () => {
  assert.equal(await wsAttempt({ origin: "http://evil.example" }), 401);
  assert.equal(await wsAttempt({ host: "attacker.example" }), 401);
});

test("WebSocket: Origin 無し(同一マシン)・許可 Origin は接続できる", async () => {
  assert.equal(await wsAttempt({}), "open");
  assert.equal(await wsAttempt({ origin: `http://localhost:${port}` }), "open");
});
