import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelSchema } from "../core/model.ts";
import { applyOp, OpSchema } from "../core/ops.ts";

/* モデル・op スキーマの振る舞いを固定する（zod のメジャー更新で意味が変わらないことの確認）。
   特に UPDATE_* の patch は「送ったキーだけを上書き」でなければならず、
   スキーマの既定値（pk:false / nullable:true 等）が patch に混ざると既存の値を壊す */

const baseModel = () =>
  ModelSchema.parse({
    modelVersion: 1,
    tables: [
      {
        id: "t_users",
        name: "users",
        x: 10,
        y: 20,
        rlsEnabled: true,
        comment: "利用者",
        columns: [{ id: "c_users_id", name: "id", type: "uuid", pk: true, nullable: false, unique: true, comment: "主キー" }],
        indexes: [{ id: "i_users_1", name: "uq_users_id", columns: ["c_users_id"], unique: true }],
      },
    ],
  });

test("ModelSchema: 省略したフィールドに既定値が入る", () => {
  const m = ModelSchema.parse({ modelVersion: 1, tables: [{ id: "t", name: "t", columns: [{ id: "c", name: "c", type: "text" }] }] });
  const t = m.tables[0];
  assert.deepEqual(
    { x: t.x, y: t.y, indexes: t.indexes, rlsEnabled: t.rlsEnabled, rls: t.rls, comment: t.comment },
    { x: 80, y: 80, indexes: [], rlsEnabled: false, rls: [], comment: null }
  );
  assert.deepEqual(t.columns[0], { id: "c", name: "c", type: "text", pk: false, nullable: true, unique: false, fk: null, default: null, comment: null });
});

test("ModelSchema: テーブル id の重複は拒否する", () => {
  const r = ModelSchema.safeParse({ modelVersion: 1, tables: [{ id: "t", name: "a" }, { id: "t", name: "b" }] });
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error!.issues), /テーブル id が重複しています/);
});

test("OpSchema: UPDATE_COLUMN の patch は送ったキーだけを持つ（既定値を足さない）", () => {
  const op = OpSchema.parse({ type: "UPDATE_COLUMN", tableId: "t_users", columnId: "c_users_id", patch: { name: "user_id" } });
  assert.deepEqual(op, { type: "UPDATE_COLUMN", tableId: "t_users", columnId: "c_users_id", patch: { name: "user_id" } });
  const next = applyOp(baseModel(), op);
  assert.deepEqual(next.tables[0].columns[0], {
    id: "c_users_id", name: "user_id", type: "uuid", pk: true, nullable: false, unique: true, fk: null, default: null, comment: "主キー",
  });
});

test("OpSchema: UPDATE_TABLE の patch は送ったキーだけを持ち、構造系キーは捨てる", () => {
  const op = OpSchema.parse({ type: "UPDATE_TABLE", id: "t_users", patch: { comment: "更新", columns: [], id: "x" } });
  assert.deepEqual(op, { type: "UPDATE_TABLE", id: "t_users", patch: { comment: "更新" } });
  const t = applyOp(baseModel(), op).tables[0];
  assert.deepEqual({ x: t.x, y: t.y, rlsEnabled: t.rlsEnabled, comment: t.comment, cols: t.columns.length }, { x: 10, y: 20, rlsEnabled: true, comment: "更新", cols: 1 });
});

test("OpSchema: UPDATE_INDEX の patch は送ったキーだけを持つ", () => {
  const op = OpSchema.parse({ type: "UPDATE_INDEX", tableId: "t_users", indexId: "i_users_1", patch: { name: "renamed" } });
  assert.deepEqual(op, { type: "UPDATE_INDEX", tableId: "t_users", indexId: "i_users_1", patch: { name: "renamed" } });
  const ix = applyOp(baseModel(), op).tables[0].indexes[0];
  assert.deepEqual(ix, { id: "i_users_1", name: "renamed", columns: ["c_users_id"], unique: true });
});

test("OpSchema: 未知の type・必須欠落・型違いは拒否し、どこが悪いかを path で返す", () => {
  assert.equal(OpSchema.safeParse({ type: "NOPE" }).success, false);
  const r = OpSchema.safeParse({ type: "MOVE_TABLE", id: "t", x: "1", y: 2 });
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues[0].path, ["x"]);
  assert.equal(OpSchema.safeParse({ type: "RENAME_TABLE", id: "t", name: "" }).success, false);
});

test("OpSchema: ADD_TABLE は省略フィールドを既定値で埋める", () => {
  const op = OpSchema.parse({ type: "ADD_TABLE", table: { id: "t_new", name: "new", columns: [{ id: "c", name: "c", type: "text" }] } });
  assert.equal(op.type, "ADD_TABLE");
  if (op.type !== "ADD_TABLE") return;
  assert.equal(op.table.columns[0].nullable, true);
  assert.equal(op.table.rlsEnabled, false);
});
