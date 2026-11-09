import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import WebSocket from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* 終了シグナルを受けたサーバーが、適用済みの変更を model.json に書いてから exit 0 することを確認する */

const here = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(here, "..", "server", "index.ts");
const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");

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

function startServer(port: number, root: string) {
  const child = spawn(tsxBin, [serverPath], {
    env: { ...process.env, DRAWZU_PORT: String(port), DRAWZU_ROOT: root, DRAWZU_IDLE_TIMEOUT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { text: "" };
  child.stdout?.on("data", (d) => (logs.text += d));
  child.stderr?.on("data", (d) => (logs.text += d));
  return { child, logs };
}

async function waitHealthy(port: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
  }
  throw new Error("server did not become healthy");
}

const exitOf = (child: ReturnType<typeof spawn>) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((r) => child.once("exit", (c) => r(c)));

/** 期限付きで待つ。待ちきれなければ理由付きで落とす（ハングさせない） */
function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms}ms: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("SIGTERM: 直前に適用した変更が model.json に残り、exit code は 0", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "drawzu-shutdown-"));
  const { child, logs } = startServer(port, root);
  try {
    await waitHealthy(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ type: "ADD_TABLE", table: { id: "t_last", name: "last", columns: [] } }] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    // 300ms のデバウンスが発火する前に止める → flush が書く
    const code = await within(5000, new Promise<number | null>((r) => {
      child.once("exit", (c) => r(c));
      child.kill("SIGTERM");
    }), "server exit");
    assert.equal(code, 0, logs.text);
    const saved = JSON.parse(readFileSync(join(root, ".drawzu", "model.json"), "utf8")) as { tables: { id: string }[] };
    assert.deepEqual(saved.tables.map((t) => t.id), ["t_last"]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM: 本文受信中だった POST は適用されず、開いていた WS は 1001 で閉じられる", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "drawzu-shutdown-"));
  const { child, logs } = startServer(port, root);
  try {
    await waitHealthy(port);
    // WS は open を確認してから進める（接続成立前に SIGTERM が届くと error になりうる）
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const wsClosed = new Promise<number>((resolve, reject) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", reject);
    });
    await within(3000, new Promise<void>((r) => ws.once("open", () => r())), "ws open");
    // 本文を途中まで送った状態で止め、終了シグナルを送ってから残りを送る。
    // 前半が実際に送信路へ渡ったことは pull() が呼ばれたことで確認する
    let finish!: () => void;
    let firstChunkPulled!: () => void;
    const pulled = new Promise<void>((r) => (firstChunkPulled = r));
    const body = JSON.stringify({ ops: [{ type: "ADD_TABLE", table: { id: "t_late", name: "late", columns: [] } }] });
    const half = Math.floor(body.length / 2);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body.slice(0, half)));
        finish = () => {
          controller.enqueue(new TextEncoder().encode(body.slice(half)));
          controller.close();
        };
      },
      pull() {
        firstChunkPulled();
      },
    });
    const pending = fetch(`http://127.0.0.1:${port}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      signal: AbortSignal.timeout(5000),
      // @ts-expect-error undici 拡張: ストリーム本文は duplex 指定が必要
      duplex: "half",
    }).then(
      (r) => r.status,
      (e: Error) => (e.name === "TimeoutError" ? ("timeout" as const) : ("disconnected" as const))
    );
    await within(3000, pulled, "first chunk pulled");
    await new Promise((r) => setTimeout(r, 50)); // 前半がサーバーへ届くまでの猶予
    child.kill("SIGTERM");
    // サーバーが終了処理に入った証拠（ログ）を待ってから残りを送る
    await waitFor(() => logs.text.includes("終了します"), "shutdown log");
    finish();
    const outcome = await within(6000, pending, "pending POST");
    // 503（終了中）か、終了で接続が切れたかのどちらか。200 で「適用した」と言ってはいけない。
    // どちらで観測されても、model.json に t_late が無いこと（下で確認）が「適用されなかった」証拠
    assert.ok(outcome === 503 || outcome === "disconnected", `unexpected outcome: ${outcome}`);
    assert.equal(await within(3000, wsClosed, "ws close"), 1001);
    assert.equal(await within(5000, exitOf(child), "server exit"), 0);
    const saved = JSON.parse(readFileSync(join(root, ".drawzu", "model.json"), "utf8")) as { tables: { id: string }[] };
    assert.ok(!saved.tables.some((t) => t.id === "t_late"));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("同じポート・同じ root で 2 本同時に起動すると、敗者は exit 1 で model.json に触らず、.tmp も残らない", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "drawzu-shutdown-"));
  const a = startServer(port, root);
  const b = startServer(port, root);
  try {
    // どちらか 1 本が終了するまで待つ（期限付き）。両方生き続ける／両方落ちるのはどちらも失敗
    await waitFor(() => a.child.exitCode !== null || b.child.exitCode !== null, "one of the two servers exits", 10_000);
    await new Promise((r) => setTimeout(r, 200)); // もう片方も落ちるなら、この間に落ちる
    const codes = [a.child.exitCode, b.child.exitCode];
    assert.equal(codes.filter((c) => c !== null).length, 1, `exactly one process should have exited: ${JSON.stringify(codes)}`);
    const loserIdx = codes.findIndex((c) => c !== null);
    const loser = loserIdx === 0 ? a : b;
    const winner = loserIdx === 0 ? b : a;
    assert.equal(codes[loserIdx], 1);
    // 敗者は listen に失敗して落ちたので、listen 成功時にだけ出る "model:" 行が無い = 初期保存に到達していない
    assert.match(loser.logs.text, /EADDRINUSE/);
    assert.doesNotMatch(loser.logs.text, /\[drawzu\] model:/);
    await waitHealthy(port);
    // 勝者の初期保存は listen 後に非同期で走るので、ファイルが現れるまで待ってから読む
    const modelPath = join(root, ".drawzu", "model.json");
    await waitFor(() => existsSync(modelPath), "model.json written by winner");
    const files = readdirSync(join(root, ".drawzu"));
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    const saved = JSON.parse(readFileSync(modelPath, "utf8")) as { modelVersion: number };
    assert.equal(saved.modelVersion, 1);
    assert.match(winner.logs.text, /\[drawzu\] model:/);
    const code = await within(5000, new Promise<number | null>((r) => {
      winner.child.once("exit", (c) => r(c));
      winner.child.kill("SIGTERM");
    }), "winner exit");
    assert.equal(code, 0);
  } finally {
    for (const c of [a.child, b.child]) if (c.exitCode === null) c.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
