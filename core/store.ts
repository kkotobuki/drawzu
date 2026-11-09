import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ModelSchema, type Model } from "./model.ts";

/* ────────────────────────────────────────────────────────────
   モデルの永続化を1枚に抽象化する（ADR-0003）。
   Phase 1 は対象プロジェクト内の .drawzu/model.json（FileStore）。
   リモート化(Phase 3)する場合はこのインターフェースの別実装を足す。
   ──────────────────────────────────────────────────────────── */

export interface ModelStore {
  load(): Promise<Model | null>;
  save(model: Model): Promise<void>;
  /** 進行中の保存がすべて終わるのを待つ（プロセス終了前に使う）。実装が無ければ待つものが無い */
  flush?(): Promise<void>;
}

export class FileStore implements ModelStore {
  /** 保存を直列化する。並行した save() が同じ一時ファイルを書いて rename で競合しないように */
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<Model | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
    return ModelSchema.parse(JSON.parse(raw));
  }

  save(model: Model): Promise<void> {
    const run = this.#queue.then(() => this.#write(model));
    // 失敗しても次の保存が詰まらないように、キュー自体は常に解決させる
    this.#queue = run.catch(() => {});
    return run;
  }

  /** キューに並んだ保存がすべて完了するまで待つ（失敗は呼び出し元へ既に返しているので待つだけ） */
  flush(): Promise<void> {
    return this.#queue;
  }

  async #write(model: Model): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // 半端な書き込みで model.json を壊さないよう、一時ファイルに書いてから置き換える
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(model, null, 2) + "\n", "utf8");
    await rename(tmp, this.filePath);
  }
}
