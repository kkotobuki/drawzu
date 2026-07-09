import { z } from "zod";

/* ────────────────────────────────────────────────────────────
   真実の源のスキーマ定義（ADR-0001 / ADR-0003）。
   図・SQL・TS型はすべてこのモデルからの投影。
   RLS など「図に載らない情報」もここが正として保持する。
   ──────────────────────────────────────────────────────────── */

export const COLUMN_TYPES = [
  "uuid",
  "text",
  "varchar",
  "int8",
  "int4",
  "numeric",
  "boolean",
  "timestamptz",
  "date",
  "jsonb",
] as const;

export const ForeignKeySchema = z.object({
  /** 参照先テーブルの id（参照先カラムは相手の PK とする） */
  tableId: z.string(),
});

export const ColumnSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.string().min(1),
  pk: z.boolean().default(false),
  nullable: z.boolean().default(true),
  unique: z.boolean().default(false),
  fk: ForeignKeySchema.nullable().default(null),
  default: z.string().nullable().default(null),
  comment: z.string().nullable().default(null),
});

export const RlsPolicySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  command: z.enum(["select", "insert", "update", "delete", "all"]),
  roles: z.array(z.string()).default([]),
  using: z.string().nullable().default(null),
  withCheck: z.string().nullable().default(null),
});

export const IndexSchema = z.object({
  id: z.string(),
  /** null なら投影時に idx_<table>_<cols> を自動生成 */
  name: z.string().nullable().default(null),
  /** カラム名でなく id で持つ。カラムをリネームしてもインデックス定義が壊れないため */
  columns: z.array(z.string()).default([]),
  unique: z.boolean().default(false),
});

export const TableSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** ER図ビュー上の配置。モデルの一部として永続化する（開き直しても配置が保たれる） */
  x: z.number().default(80),
  y: z.number().default(80),
  columns: z.array(ColumnSchema).default([]),
  indexes: z.array(IndexSchema).default([]),
  rlsEnabled: z.boolean().default(false),
  rls: z.array(RlsPolicySchema).default([]),
  comment: z.string().nullable().default(null),
});

export const ModelSchema = z.object({
  /** モデル自体のスキーマ版数。構造を変えたら上げてマイグレーションを書く */
  modelVersion: z.literal(1),
  tables: z.array(TableSchema).default([]),
});

export type ForeignKey = z.infer<typeof ForeignKeySchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type Index = z.infer<typeof IndexSchema>;
export type RlsPolicy = z.infer<typeof RlsPolicySchema>;
export type Table = z.infer<typeof TableSchema>;
export type Model = z.infer<typeof ModelSchema>;

export function emptyModel(): Model {
  return { modelVersion: 1, tables: [] };
}
