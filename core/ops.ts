import { z } from "zod";
import {
  ColumnSchema,
  IndexSchema,
  ModelSchema,
  TableSchema,
  type Model,
} from "./model.ts";

/* ────────────────────────────────────────────────────────────
   モデルへの変更操作（op）。
   Webビューの手動編集も、AI(MCPのpatch_model)も、必ずこの op を
   経由してモデルを変更する。プロトタイプの reducer をここへ移植した。
   ADD 系が id 込みの完成形を運ぶのは、送信側(クライアント)の楽観適用と
   サーバー適用の結果を一致させるため。
   ──────────────────────────────────────────────────────────── */

export const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_TABLE"), table: TableSchema }),
  z.object({ type: z.literal("DELETE_TABLE"), id: z.string() }),
  z.object({ type: z.literal("RENAME_TABLE"), id: z.string(), name: z.string().min(1) }),
  /** name/座標/comment/rlsEnabled などテーブル自身の属性を部分更新（構造の変更は各専用op） */
  z.object({
    type: z.literal("UPDATE_TABLE"),
    id: z.string(),
    patch: TableSchema.partial().omit({ id: true, columns: true, indexes: true, rls: true }),
  }),
  z.object({ type: z.literal("MOVE_TABLE"), id: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("ADD_COLUMN"), tableId: z.string(), column: ColumnSchema }),
  z.object({
    type: z.literal("UPDATE_COLUMN"),
    tableId: z.string(),
    columnId: z.string(),
    patch: ColumnSchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("DELETE_COLUMN"), tableId: z.string(), columnId: z.string() }),
  z.object({ type: z.literal("ADD_INDEX"), tableId: z.string(), index: IndexSchema }),
  z.object({
    type: z.literal("UPDATE_INDEX"),
    tableId: z.string(),
    indexId: z.string(),
    patch: IndexSchema.partial().omit({ id: true }),
  }),
  z.object({ type: z.literal("DELETE_INDEX"), tableId: z.string(), indexId: z.string() }),
  /** AI が introspect 結果を一括で流し込む・全置換する用 */
  z.object({ type: z.literal("SET_MODEL"), model: ModelSchema }),
]);

export type Op = z.infer<typeof OpSchema>;

export function applyOp(model: Model, op: Op): Model {
  switch (op.type) {
    case "ADD_TABLE":
      return { ...model, tables: [...model.tables, op.table] };

    case "DELETE_TABLE":
      return {
        ...model,
        tables: model.tables
          .filter((t) => t.id !== op.id)
          .map((t) => ({
            ...t,
            columns: t.columns.map((c) =>
              c.fk?.tableId === op.id ? { ...c, fk: null } : c
            ),
          })),
      };

    case "RENAME_TABLE":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.id ? { ...t, name: op.name } : t
        ),
      };

    case "UPDATE_TABLE":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.id ? { ...t, ...op.patch } : t
        ),
      };

    case "MOVE_TABLE":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.id ? { ...t, x: op.x, y: op.y } : t
        ),
      };

    case "ADD_COLUMN":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId ? { ...t, columns: [...t.columns, op.column] } : t
        ),
      };

    case "UPDATE_COLUMN":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId
            ? {
                ...t,
                columns: t.columns.map((c) =>
                  c.id === op.columnId ? { ...c, ...op.patch } : c
                ),
              }
            : t
        ),
      };

    case "DELETE_COLUMN":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId
            ? {
                ...t,
                columns: t.columns.filter((c) => c.id !== op.columnId),
                // 消えたカラムを参照するインデックス定義も掃除する
                indexes: t.indexes
                  .map((ix) => ({ ...ix, columns: ix.columns.filter((cid) => cid !== op.columnId) }))
                  .filter((ix) => ix.columns.length > 0),
              }
            : t
        ),
      };

    case "ADD_INDEX":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId ? { ...t, indexes: [...t.indexes, op.index] } : t
        ),
      };

    case "UPDATE_INDEX":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId
            ? {
                ...t,
                indexes: t.indexes.map((ix) =>
                  ix.id === op.indexId ? { ...ix, ...op.patch } : ix
                ),
              }
            : t
        ),
      };

    case "DELETE_INDEX":
      return {
        ...model,
        tables: model.tables.map((t) =>
          t.id === op.tableId
            ? { ...t, indexes: t.indexes.filter((ix) => ix.id !== op.indexId) }
            : t
        ),
      };

    case "SET_MODEL":
      return op.model;
  }
}
