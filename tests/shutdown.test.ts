import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
  }
  throw new Error("server did not become healthy");
}

const exitOf = (child: ReturnType<typeof spawn>) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((r) => child.once("exit", (c) => r(c)));

test("SIGTERM: 直前に適用した変更が model.json に残り、exit code は 0", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "drawzu-shutdown-"));
  const { child, logs } = startServer(port, root);
  const log = logs.text;
  try {
    await waitHealthy(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ type: "ADD_TABLE", table: { id: "t_last", name: "last", columns: [] } }] }),
    });
    assert.equal(res.status, 200);
    // 300ms のデバウンスが発火する前に止める → flush が書く
    const code = await new Promise<number | null>((r) => {
      child.once("exit", (c) => r(c));
      child.kill("SIGTERM");
    });
    assert.equal(code, 0, log);
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
  const { child } = startServer(port, root);
  try {
    await waitHealthy(port);
    const wsClosed = new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("close", (c) => resolve(c));
      ws.on("error", reject);
    });
    // 本文を途中まで送った状態で止め、終了シグナルを送ってから残りを送る
    let finish!: () => void;
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
    });
    const pending = fetch(`http://127.0.0.1:${port}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error undici 拡張: ストリーム本文は duplex 指定が必要
      duplex: "half",
    }).then(
      (r) => r.status,
      () => "error" as const
    );
    await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
    finish();
    const outcome = await pending;
    // 503（終了中）か、終了で接続が切れたかのどちらか。200 で「適用した」と言ってはいけない
    assert.notEqual(outcome, 200);
    assert.equal(await wsClosed, 1001);
    assert.equal(await exitOf(child), 0);
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
    const [codeA, codeB] = await Promise.race([
      Promise.all([exitOf(a.child), exitOf(b.child)]).then(() => "both" as const),
      new Promise<[number | null, number | null]>((resolve) => {
        const check = () => {
          const done = [a.child.exitCode, b.child.exitCode];
          if (done.filter((c) => c !== null).length === 1) resolve(done as [number | null, number | null]);
          else setTimeout(check, 50);
        };
        check();
      }),
    ]).then((v) => (v === "both" ? ([a.child.exitCode, b.child.exitCode] as [number | null, number | null]) : v));
    const exited = [codeA, codeB].filter((c) => c !== null);
    assert.equal(exited.length, 1, `exactly one process should have exited: ${JSON.stringify([codeA, codeB])}`);
    assert.equal(exited[0], 1);
    await waitHealthy(port);
    const files = readdirSync(join(root, ".drawzu"));
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    const saved = JSON.parse(readFileSync(join(root, ".drawzu", "model.json"), "utf8")) as { modelVersion: number };
    assert.equal(saved.modelVersion, 1);
    const winner = a.child.exitCode === null ? a.child : b.child;
    const code = await new Promise<number | null>((r) => {
      winner.once("exit", (c) => r(c));
      winner.kill("SIGTERM");
    });
    assert.equal(code, 0);
  } finally {
    for (const c of [a.child, b.child]) if (c.exitCode === null) c.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
