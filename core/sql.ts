import type { Model, Table } from "./model.ts";

/* ────────────────────────────────────────────────────────────
   モデル → SQL(DDL) 投影。プロトタイプの toSQL を移植し、
   図に載らない情報（RLS）の投影を追加した。
   ──────────────────────────────────────────────────────────── */

function pkName(t: Table): string {
  return t.columns.find((c) => c.pk)?.name ?? "id";
}

export function toSQL(model: Model): string {
  const byId = Object.fromEntries(model.tables.map((t) => [t.id, t]));

  const creates = model.tables.map((t) => {
    const lines = t.columns.map((c) => {
      let s = `  "${c.name}" ${c.type}`;
      if (c.pk) s += " primary key";
      if (!c.nullable && !c.pk) s += " not null";
      if (c.unique && !c.pk) s += " unique";
      if (c.default != null) s += ` default ${c.default}`;
      return s;
    });
    const fks = t.columns
      .filter((c) => c.fk && byId[c.fk.tableId])
      .map((c) => {
        const ref = byId[c.fk!.tableId];
        return `  foreign key ("${c.name}") references "${ref.name}" ("${pkName(ref)}")`;
      });
    return `create table "${t.name}" (\n${[...lines, ...fks].join(",\n")}\n);`;
  });

  const esc = (s: string) => s.replace(/'/g, "''");
  const comments = model.tables.flatMap((t) => [
    ...(t.comment ? [`comment on table "${t.name}" is '${esc(t.comment)}';`] : []),
    ...t.columns
      .filter((c) => c.comment)
      .map((c) => `comment on column "${t.name}"."${c.name}" is '${esc(c.comment!)}';`),
  ]);

  const indexes = model.tables.flatMap((t) =>
    t.indexes.flatMap((ix) => {
      // カラム id → 名前へ解決。消えた id はスキップし、有効カラムが無ければ出さない
      const cols = ix.columns
        .map((cid) => t.columns.find((c) => c.id === cid)?.name)
        .filter((n): n is string => n != null);
      if (cols.length === 0) return [];
      const name = ix.name ?? `${ix.unique ? "uq" : "idx"}_${t.name}_${cols.join("_")}`;
      return [
        `create ${ix.unique ? "unique " : ""}index "${name}" on "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")});`,
      ];
    })
  );

  const rls = model.tables.flatMap((t) => {
    if (!t.rlsEnabled && t.rls.length === 0) return [];
    const stmts = [`alter table "${t.name}" enable row level security;`];
    for (const p of t.rls) {
      let s = `create policy "${p.name}" on "${t.name}"`;
      s += `\n  for ${p.command}`;
      if (p.roles.length > 0) s += `\n  to ${p.roles.join(", ")}`;
      if (p.using != null) s += `\n  using (${p.using})`;
      if (p.withCheck != null) s += `\n  with check (${p.withCheck})`;
      stmts.push(s + ";");
    }
    return [stmts.join("\n")];
  });

  return [...creates, ...comments, ...indexes, ...rls].join("\n\n");
}
