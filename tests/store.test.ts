import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("FileStore: 同じ model.json を別インスタンス（別プロセス相当）が並行保存しても落ちず、どちらかの完全な内容が残る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drawzu-store-"));
  try {
    const path = join(dir, ".drawzu", "model.json");
    const a = new FileStore(path);
    const b = new FileStore(path);
    const mk = (id: string): Model => ({ ...emptyModel(), tables: [{ id, name: id, x: 0, y: 0, columns: [], indexes: [], rlsEnabled: false, rls: [], comment: null }] });
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).save(mk(`t_${i}`))));
    const saved = JSON.parse(readFileSync(path, "utf8")) as Model;
    assert.equal(saved.tables.length, 1);
    assert.match(saved.tables[0].id, /^t_\d$/);
    // 一時ファイルは残らない
    const leftovers = readdirSync(join(dir, ".drawzu")).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileStore.flush: 最後の保存が失敗していれば reject し、成功すれば解消する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drawzu-store-"));
  try {
    // ファイルをディレクトリ代わりに置いて mkdir を失敗させる
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const bad = new FileStore(join(blocker, ".drawzu", "model.json"));
    await assert.rejects(bad.save(emptyModel()));
    await assert.rejects(bad.flush());
    // 同じインスタンスで原因が取り除かれて保存が成功すれば flush は解消する
    rmSync(blocker);
    await bad.save(emptyModel());
    await bad.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
