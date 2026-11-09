import type { Model } from "./model.ts";
import { applyOp, type Op } from "./ops.ts";
import type { ModelStore } from "./store.ts";

/* ────────────────────────────────────────────────────────────
   モデルの実行時の置き場。通信路(WebSocket / MCP)非依存（ADR-0003）。
   - どの窓からの変更も apply(op) を通る
   - 変更は購読者(開いているブラウザ等)へ通知される
   - 永続化は書き込みをまとめるため少し遅延させる（既定 300ms）
   ──────────────────────────────────────────────────────────── */

export type HubListener = (model: Model, version: number) => void;

export class ModelHub {
  #model: Model;
  #version = 0;
  #listeners = new Set<HubListener>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** store.save を呼んだ回数。flush が「待っている間に新しい保存が始まったか」を見るための世代番号 */
  #saveSeq = 0;

  constructor(
    readonly store: ModelStore,
    initial: Model,
    readonly saveDelayMs = 300
  ) {
    this.#model = initial;
  }

  get model(): Model {
    return this.#model;
  }

  get version(): number {
    return this.#version;
  }

  apply(op: Op): { model: Model; version: number } {
    this.#model = applyOp(this.#model, op);
    this.#version++;
    this.#scheduleSave();
    for (const fn of this.#listeners) fn(this.#model, this.#version);
    return { model: this.#model, version: this.#version };
  }

  subscribe(fn: HubListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #scheduleSave() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#saveSeq++;
      void this.store.save(this.#model).catch((e) => {
        console.error("[drawzu] モデルの保存に失敗:", e);
      });
    }, this.saveDelayMs);
  }

  /** プロセス終了前などに未保存分を確実に書き出す。
      保存の await 中に新しい apply が来てタイマーが立ち直る／発火して新しい保存が始まることがあるので、
      「タイマーが無く、待っている間に新しい保存も始まらなかった」状態になるまで繰り返す。
      呼び出し側は flush 中に apply が止まるよう取り計らう（サーバーは shuttingDown で止める）。
      そうでないと apply が続く限り戻らない。最後の保存が失敗していれば reject する */
  async flush(): Promise<void> {
    let seen: number;
    do {
      while (this.#saveTimer) {
        clearTimeout(this.#saveTimer);
        this.#saveTimer = null;
        this.#saveSeq++;
        await this.store.save(this.#model);
      }
      seen = this.#saveSeq;
      // タイマーが既に発火して書き込み中の保存も待つ（待たずに process.exit すると最後の変更が落ちる）
      await this.store.flush?.();
      // その待ちの間にタイマーが立ち直った／発火して新しい保存が始まったなら、もう一周する
    } while (this.#saveTimer || this.#saveSeq !== seen);
  }
}
