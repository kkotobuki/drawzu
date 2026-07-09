import React, { useReducer, useRef, useState, useMemo, useCallback } from "react";
import { Plus, Trash2, Key, Link2, Copy, Check, Table2, X } from "lucide-react";

/* ────────────────────────────────────────────────────────────
   真実の源はこの reducer の中の 1 個のモデルだけ。
   ER図もSQLも、両方このモデルを映す「窓」。編集は必ずここを通る。
   ──────────────────────────────────────────────────────────── */

const TYPES = ["uuid", "text", "varchar", "int8", "int4", "numeric", "boolean", "timestamptz", "date", "jsonb"];

const CARD_W = 248;
const HEADER_H = 40;
const ROW_H = 30;

let _id = 100;
const uid = (p) => `${p}_${++_id}`;

const initial = {
  tables: [
    {
      id: "t_companies", name: "companies", x: 80, y: 90,
      columns: [
        { id: "c_1", name: "id", type: "uuid", pk: true, nullable: false, unique: false, fk: null },
        { id: "c_2", name: "name", type: "text", pk: false, nullable: false, unique: false, fk: null },
      ],
    },
    {
      id: "t_ri", name: "recording_imports", x: 440, y: 60,
      columns: [
        { id: "c_3", name: "id", type: "uuid", pk: true, nullable: false, unique: false, fk: null },
        { id: "c_4", name: "zoom_uuid", type: "text", pk: false, nullable: false, unique: true, fk: null },
        { id: "c_5", name: "company_id", type: "uuid", pk: false, nullable: true, unique: false, fk: "t_companies" },
        { id: "c_6", name: "raw", type: "jsonb", pk: false, nullable: false, unique: false, fk: null },
        { id: "c_7", name: "created_at", type: "timestamptz", pk: false, nullable: false, unique: false, fk: null },
      ],
    },
    {
      id: "t_sessions", name: "sessions", x: 470, y: 340,
      columns: [
        { id: "c_8", name: "id", type: "uuid", pk: true, nullable: false, unique: false, fk: null },
        { id: "c_9", name: "recording_import_id", type: "uuid", pk: false, nullable: false, unique: false, fk: "t_ri" },
        { id: "c_10", name: "started_at", type: "timestamptz", pk: false, nullable: true, unique: false, fk: null },
      ],
    },
  ],
};

function reducer(state, a) {
  switch (a.type) {
    case "ADD_TABLE": {
      const n = state.tables.length;
      return {
        ...state,
        tables: [...state.tables, {
          id: uid("t"), name: `new_table_${n}`, x: 120 + n * 28, y: 120 + n * 28,
          columns: [{ id: uid("c"), name: "id", type: "uuid", pk: true, nullable: false, unique: false, fk: null }],
        }],
      };
    }
    case "DELETE_TABLE":
      return {
        ...state,
        tables: state.tables
          .filter((t) => t.id !== a.id)
          .map((t) => ({ ...t, columns: t.columns.map((c) => (c.fk === a.id ? { ...c, fk: null } : c)) })),
      };
    case "RENAME_TABLE":
      return { ...state, tables: state.tables.map((t) => (t.id === a.id ? { ...t, name: a.name } : t)) };
    case "MOVE_TABLE":
      return { ...state, tables: state.tables.map((t) => (t.id === a.id ? { ...t, x: a.x, y: a.y } : t)) };
    case "ADD_COLUMN":
      return {
        ...state,
        tables: state.tables.map((t) => t.id === a.id ? {
          ...t, columns: [...t.columns, { id: uid("c"), name: "column", type: "text", pk: false, nullable: true, unique: false, fk: null }],
        } : t),
      };
    case "UPDATE_COLUMN":
      return {
        ...state,
        tables: state.tables.map((t) => t.id === a.tableId ? {
          ...t, columns: t.columns.map((c) => (c.id === a.columnId ? { ...c, ...a.patch } : c)),
        } : t),
      };
    case "DELETE_COLUMN":
      return {
        ...state,
        tables: state.tables.map((t) => t.id === a.tableId ? {
          ...t, columns: t.columns.filter((c) => c.id !== a.columnId),
        } : t),
      };
    default:
      return state;
  }
}

/* ── モデル → SQL（もう一つの窓）──────────────────────────── */
function toSQL(tables) {
  const byId = Object.fromEntries(tables.map((t) => [t.id, t]));
  const pkName = (t) => (t.columns.find((c) => c.pk)?.name ?? "id");
  return tables.map((t) => {
    const lines = t.columns.map((c) => {
      let s = `  "${c.name}" ${c.type}`;
      if (c.pk) s += " primary key";
      if (!c.nullable && !c.pk) s += " not null";
      if (c.unique && !c.pk) s += " unique";
      return s;
    });
    const fks = t.columns
      .filter((c) => c.fk && byId[c.fk])
      .map((c) => `  foreign key ("${c.name}") references "${byId[c.fk].name}" ("${pkName(byId[c.fk])}")`);
    return `create table "${t.name}" (\n${[...lines, ...fks].join(",\n")}\n);`;
  }).join("\n\n");
}

/* ── FK線のジオメトリ ─────────────────────────────────────── */
function tableHeight(t) { return HEADER_H + t.columns.length * ROW_H + 34; }

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);
  const dragRef = useRef(null);

  const sql = useMemo(() => toSQL(state.tables), [state.tables]);

  // 編集が起きるたびSQL窓を一瞬フラッシュ → 「同期してる」を体で分からせる
  const pulse = useCallback(() => { setFlash(true); setTimeout(() => setFlash(false), 260); }, []);
  const act = useCallback((action) => { dispatch(action); pulse(); }, [pulse]);

  const onDragStart = (e, t) => {
    if (e.target.closest("input,select,button")) return;
    dragRef.current = { id: t.id, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y };
    const move = (ev) => {
      const d = dragRef.current; if (!d) return;
      dispatch({ type: "MOVE_TABLE", id: d.id, x: Math.max(8, d.ox + ev.clientX - d.sx), y: Math.max(8, d.oy + ev.clientY - d.sy) });
    };
    const up = () => { dragRef.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const byId = Object.fromEntries(state.tables.map((t) => [t.id, t]));
  const fkEdges = state.tables.flatMap((t) =>
    t.columns.filter((c) => c.fk && byId[c.fk]).map((c) => ({ from: t, to: byId[c.fk], key: `${t.id}-${c.id}` }))
  );

  const copy = () => {
    navigator.clipboard?.writeText(sql);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };

  const ink = "#232a36", sub = "#6b7280", line = "#e3e5ea", accent = "#4f5bd5", pk = "#b7791f";

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", color: ink, background: "#eef0f3", height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-5" style={{ height: 56, background: "#fff", borderBottom: `1px solid ${line}`, flexShrink: 0 }}>
        <div className="flex items-center gap-3">
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>スキーマ・キャンバス</div>
          <div className="flex items-center gap-1.5" style={{ fontSize: 11, color: sub, background: "#f4f5f7", padding: "3px 9px", borderRadius: 999 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: accent, display: "inline-block" }} />
            1 model · 2 views
          </div>
        </div>
        <button onClick={() => act({ type: "ADD_TABLE" })} className="flex items-center gap-1.5"
          style={{ background: ink, color: "#fff", fontSize: 13, fontWeight: 500, padding: "7px 13px", borderRadius: 8, border: "none", cursor: "pointer" }}>
          <Plus size={15} /> テーブル追加
        </button>
      </div>

      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Canvas */}
        <div style={{ flex: 1, position: "relative", overflow: "auto",
          backgroundImage: "radial-gradient(#d4d7dd 1px, transparent 1px)", backgroundSize: "22px 22px", backgroundColor: "#eef0f3" }}>
          {/* FK lines */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
            {fkEdges.map((e) => {
              const x1 = e.from.x + CARD_W / 2, y1 = e.from.y + tableHeight(e.from) / 2;
              const x2 = e.to.x + CARD_W / 2, y2 = e.to.y + tableHeight(e.to) / 2;
              const mx = (x1 + x2) / 2;
              return (
                <g key={e.key}>
                  <path d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke={accent} strokeWidth="1.6" opacity="0.5" />
                  <circle cx={x2} cy={y2} r="3.5" fill={accent} opacity="0.7" />
                </g>
              );
            })}
          </svg>

          {state.tables.map((t) => (
            <TableCard key={t.id} t={t} tables={state.tables} onDragStart={onDragStart} act={act}
              tokens={{ ink, sub, line, accent, pk }} />
          ))}
        </div>

        {/* SQL panel */}
        <div style={{ width: 380, flexShrink: 0, background: "#1b1f2a", display: "flex", flexDirection: "column",
          boxShadow: flash ? `inset 3px 0 0 ${accent}` : "inset 3px 0 0 transparent", transition: "box-shadow 240ms ease" }}>
          <div className="flex items-center justify-between px-4" style={{ height: 42, borderBottom: "1px solid #2a2f3d", flexShrink: 0 }}>
            <span style={{ color: "#8b93a7", fontSize: 11, letterSpacing: "0.06em", fontWeight: 600 }}>GENERATED · schema.sql</span>
            <button onClick={copy} className="flex items-center gap-1.5"
              style={{ background: "transparent", color: copied ? "#6ee7a8" : "#8b93a7", fontSize: 12, border: "none", cursor: "pointer" }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "コピーした" : "コピー"}
            </button>
          </div>
          <pre style={{ margin: 0, padding: "16px 18px", overflow: "auto", flex: 1, fontSize: 12.5, lineHeight: 1.7,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#c8cede", whiteSpace: "pre" }}>
            <SqlHighlighted sql={sql} />
          </pre>
          <div style={{ padding: "10px 18px", borderTop: "1px solid #2a2f3d", color: "#5f6577", fontSize: 11, flexShrink: 0 }}>
            図を触るたび、この裏の1個のモデルが更新されて即再生成されてる。
          </div>
        </div>
      </div>
    </div>
  );
}

function TableCard({ t, tables, onDragStart, act, tokens }) {
  const { ink, sub, line, accent, pk } = tokens;
  const [editingName, setEditingName] = useState(false);
  const others = tables.filter((x) => x.id !== t.id);

  return (
    <div onMouseDown={(e) => onDragStart(e, t)}
      style={{ position: "absolute", left: t.x, top: t.y, width: CARD_W, background: "#fff",
        borderRadius: 10, border: `1px solid ${line}`, boxShadow: "0 4px 16px rgba(30,35,50,0.08)", cursor: "grab", userSelect: "none" }}>
      {/* header */}
      <div className="flex items-center justify-between" style={{ height: HEADER_H, padding: "0 10px 0 12px", borderBottom: `1px solid ${line}`, borderRadius: "10px 10px 0 0", background: "#fafbfc" }}>
        <div className="flex items-center gap-1.5" style={{ minWidth: 0 }}>
          <Table2 size={13} color={accent} style={{ flexShrink: 0 }} />
          {editingName ? (
            <input autoFocus defaultValue={t.name} onBlur={(e) => { act({ type: "RENAME_TABLE", id: t.id, name: e.target.value.trim() || t.name }); setEditingName(false); }}
              onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
              style={{ fontSize: 13, fontWeight: 600, border: `1px solid ${accent}`, borderRadius: 4, padding: "1px 4px", width: 150, outline: "none" }} />
          ) : (
            <span onClick={() => setEditingName(true)} style={{ fontSize: 13, fontWeight: 600, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
          )}
        </div>
        <button onClick={() => act({ type: "DELETE_TABLE", id: t.id })} style={{ background: "none", border: "none", cursor: "pointer", color: "#c0c4cc", display: "flex", padding: 2 }}>
          <X size={14} />
        </button>
      </div>

      {/* columns */}
      <div style={{ padding: "4px 0" }}>
        {t.columns.map((c) => (
          <div key={c.id} className="flex items-center gap-1" style={{ height: ROW_H, padding: "0 8px 0 10px" }}>
            <button title="主キー" onClick={() => act({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { pk: !c.pk, nullable: c.pk ? c.nullable : false } })}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", flexShrink: 0, opacity: c.pk ? 1 : 0.22 }}>
              <Key size={12} color={c.pk ? pk : sub} />
            </button>
            <input value={c.name} onChange={(e) => act({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { name: e.target.value } })}
              style={{ border: "none", outline: "none", fontSize: 12.5, fontWeight: 500, width: 96, background: "transparent", color: ink }} />
            <select value={c.type} onChange={(e) => act({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { type: e.target.value } })}
              style={{ border: "none", outline: "none", fontSize: 11, color: sub, background: "transparent", cursor: "pointer", flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace" }}>
              {TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
            <button title="NULL許可" onClick={() => act({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { nullable: !c.nullable } })}
              style={{ background: "none", border: "none", cursor: c.pk ? "default" : "pointer", padding: "0 2px", fontSize: 9.5, fontWeight: 700, color: c.nullable ? sub : "#c0c4cc", flexShrink: 0, opacity: c.pk ? 0.3 : 1 }}>
              N?
            </button>
            <select title="外部キー参照先" value={c.fk ?? ""} onChange={(e) => act({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { fk: e.target.value || null } })}
              style={{ border: "none", outline: "none", fontSize: 11, color: c.fk ? accent : "#c8ccd4", background: "transparent", cursor: "pointer", flexShrink: 0, width: 20, appearance: "none", textAlign: "center" }}>
              <option value="">–</option>
              {others.map((o) => <option key={o.id} value={o.id}>→ {o.name}</option>)}
            </select>
            <button onClick={() => act({ type: "DELETE_COLUMN", tableId: t.id, columnId: c.id })}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#d4d7dd", padding: 0, display: "flex", flexShrink: 0 }}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      <button onClick={() => act({ type: "ADD_COLUMN", id: t.id })} className="flex items-center gap-1"
        style={{ width: "100%", background: "none", border: "none", borderTop: `1px solid ${line}`, cursor: "pointer", color: sub, fontSize: 11.5, padding: "8px 12px", justifyContent: "flex-start" }}>
        <Plus size={12} /> カラム
      </button>
    </div>
  );
}

/* ── ごく軽いSQLハイライト ─────────────────────────────────── */
function SqlHighlighted({ sql }) {
  const kw = /\b(create table|primary key|foreign key|references|not null|unique)\b/gi;
  const parts = sql.split(/(create table|primary key|foreign key|references|not null|unique|"[^"]*")/gi);
  return parts.map((p, i) => {
    if (/^"/.test(p)) return <span key={i} style={{ color: "#7dd3fc" }}>{p}</span>;
    if (kw.test(p)) { kw.lastIndex = 0; return <span key={i} style={{ color: "#c4a3ff" }}>{p}</span>; }
    if (TYPES.includes(p.trim())) return <span key={i} style={{ color: "#6ee7a8" }}>{p}</span>;
    return <span key={i}>{p}</span>;
  });
}
