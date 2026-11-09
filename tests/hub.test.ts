import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelHub } from "../core/hub.ts";
import type { ModelStore } from "../core/store.ts";
import { emptyModel, type Model } from "../core/model.ts";

/* 終了処理（flush）の回帰テスト: 保存の await 中に届いた変更も失わない */

function slowStore(delayMs: number) {
  const saved: Model[] = [];
  let pending = Promise.resolve();
  const store: ModelStore = {
    async load() {
      return null;
    },
    save(m) {
      const p = new Promise<void>((r) => setTimeout(r, delayMs)).then(() => {
        saved.push(m);
      });
      pending = pending.then(() => p);
      return p;
    },
    flush() {
      return pending;
    },
  };
  return { store, saved };
}

const table = (id: string) => ({ id, name: id, x: 0, y: 0, columns: [], indexes: [], rlsEnabled: false, rls: [], comment: null });

test("ModelHub.flush: flush 中に apply された変更も保存されてから解決する", async () => {
  const { store, saved } = slowStore(50);
  // デバウンス(100ms) > 書き込み(50ms) にしておく。逆だと 2 件目のタイマーが 1 件目の保存完了前に
  // 発火して旧実装（if 単発）でも通ってしまい、回帰テストにならない
  const hub = new ModelHub(store, emptyModel(), 100);
  hub.apply({ type: "ADD_TABLE", table: table("t_first") });
  const flushing = hub.flush();
  // 1 回目の保存が進行中のあいだに 2 つ目の変更が届く
  await new Promise((r) => setTimeout(r, 10));
  hub.apply({ type: "ADD_TABLE", table: table("t_second") });
  await flushing;
  const last = saved.at(-1)!;
  assert.deepEqual(last.tables.map((t) => t.id).sort(), ["t_first", "t_second"]);
});

test("ModelHub.flush: タイマー発火済みで書き込み中の保存を待つ", async () => {
  const { store, saved } = slowStore(100);
  const hub = new ModelHub(store, emptyModel(), 10);
  hub.apply({ type: "ADD_TABLE", table: table("t_inflight") });
  await new Promise((r) => setTimeout(r, 30)); // タイマー発火 → 書き込み中
  assert.equal(saved.length, 0);
  await hub.flush();
  assert.equal(saved.length, 1);
});
