import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../core/store.ts";
import { emptyModel, type Model } from "../core/model.ts";

/* 同じ store へ並行して save() しても rename が競合せず、最後の内容が残ることを確認する
   （MCP ブリッジの並列呼び出しでサーバーが二重起動した際に起きた ENOENT の回帰テスト） */
test("FileStore.save: 並行保存でも落ちず、最後の保存内容が残る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drawzu-store-"));
  try {
    const store = new FileStore(join(dir, ".drawzu", "model.json"));
    const models: Model[] = Array.from({ length: 10 }, (_, i) => ({
      ...emptyModel(),
      tables: [{ id: `t_${i}`, name: `t${i}`, x: 0, y: 0, columns: [], indexes: [], rlsEnabled: false, rls: [], comment: null }],
    }));
    await Promise.all(models.map((m) => store.save(m)));
    const saved = JSON.parse(readFileSync(join(dir, ".drawzu", "model.json"), "utf8")) as Model;
    assert.equal(saved.tables[0].id, "t_9");
    assert.deepEqual(await store.load(), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileStore.flush: 進行中の保存が終わるまで待つ", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drawzu-store-"));
  try {
    const store = new FileStore(join(dir, ".drawzu", "model.json"));
    const m: Model = { ...emptyModel(), tables: [{ id: "t_flush", name: "f", x: 0, y: 0, columns: [], indexes: [], rlsEnabled: false, rls: [], comment: null }] };
    void store.save(m); // await しない（タイマー発火済みで書き込み中、に相当）
    await store.flush();
    const saved = JSON.parse(readFileSync(join(dir, ".drawzu", "model.json"), "utf8")) as Model;
    assert.equal(saved.tables[0].id, "t_flush");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
