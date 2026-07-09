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
      void this.store.save(this.#model).catch((e) => {
        console.error("[drawzu] モデルの保存に失敗:", e);
      });
    }, this.saveDelayMs);
  }

  /** プロセス終了前などに未保存分を確実に書き出す */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      await this.store.save(this.#model);
    }
  }
}
