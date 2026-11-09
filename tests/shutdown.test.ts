import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("SIGTERM: 直前に適用した変更が model.json に残り、exit code は 0", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "drawzu-shutdown-"));
  const child = spawn(tsxBin, [serverPath], {
    env: { ...process.env, DRAWZU_PORT: String(port), DRAWZU_ROOT: root, DRAWZU_IDLE_TIMEOUT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch {}
    }
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
