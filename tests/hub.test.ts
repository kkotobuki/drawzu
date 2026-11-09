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

test("ModelHub.flush: store.flush の待ち中に apply された変更も保存してから解決する", async () => {
  // save は即完了、flush（書き込み中の待ち）だけが遅い store
  const saved: Model[] = [];
  let flushCalls = 0;
  const store: ModelStore = {
    async load() {
      return null;
    },
    async save(m) {
      saved.push(m);
    },
    flush() {
      flushCalls++;
      return new Promise((r) => setTimeout(r, 50));
    },
  };
  const hub = new ModelHub(store, emptyModel(), 100);
  hub.apply({ type: "ADD_TABLE", table: table("t_first") });
  const flushing = hub.flush();
  await new Promise((r) => setTimeout(r, 10)); // save 済み・store.flush 待ちの最中
  hub.apply({ type: "ADD_TABLE", table: table("t_second") });
  await flushing;
  assert.deepEqual(saved.at(-1)!.tables.map((t) => t.id).sort(), ["t_first", "t_second"]);
  assert.ok(flushCalls >= 2);
});

test("ModelHub.flush: store.flush の待ち中にタイマーが発火して始まった保存も待つ", async () => {
  // FileStore 風: save は遅く、flush は「呼んだ時点のキュー」だけを待つ
  const saved: Model[] = [];
  let queue = Promise.resolve();
  const store: ModelStore = {
    async load() {
      return null;
    },
    save(m) {
      const run = queue.then(() => new Promise<void>((r) => setTimeout(r, 100))).then(() => {
        saved.push(m);
      });
      queue = run.catch(() => {});
      return run;
    },
    flush() {
      return queue;
    },
  };
  const hub = new ModelHub(store, emptyModel(), 10); // デバウンス(10ms) < 書き込み(100ms)
  hub.apply({ type: "ADD_TABLE", table: table("t_first") });
  await new Promise((r) => setTimeout(r, 30)); // タイマー発火済み → t_first の保存(100ms)が進行中、タイマーは無い
  const flushing = hub.flush(); // 内側の while は回らず、store.flush（進行中の保存）の待ちに入る
  await new Promise((r) => setTimeout(r, 20));
  hub.apply({ type: "ADD_TABLE", table: table("t_second") }); // 10ms 後にタイマー発火 → 2 件目の保存がキューへ、タイマーは null
  await flushing;
  assert.deepEqual(saved.at(-1)!.tables.map((t) => t.id).sort(), ["t_first", "t_second"]);
});
