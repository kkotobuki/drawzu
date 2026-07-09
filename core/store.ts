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
}

export class FileStore implements ModelStore {
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

  async save(model: Model): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // 半端な書き込みで model.json を壊さないよう、一時ファイルに書いてから置き換える
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(model, null, 2) + "\n", "utf8");
    await rename(tmp, this.filePath);
  }
}
