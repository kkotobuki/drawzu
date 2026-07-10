import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLUMN_TYPES, type Column, type Index, type Model, type Table } from "../../core/model.ts";
import type { Op } from "../../core/ops.ts";
import { toSQL } from "../../core/sql.ts";
import { uid, useModel } from "./useModel.ts";
import {
  CARD_W, HEADER_H, ROW_H, IDX_ROW_H, RLS_HEAD_H, RLS_AUD_ROW_H, MEMO_H,
  ink, sub, line, accent, pkColor, rlsColor, CMD_COLOR,
  memoHeight, rlsAudiences, rlsSectionHeight, tableHeight, colY, computeFkEdges,
} from "./layout.ts";
import { buildExportHtml } from "./exportHtml.ts";

/* prototype/schema-canvas.jsx の移植。真実の源はサーバー上のモデル
   （.drawzu/model.json）に移り、この画面はそれを映す「人間の窓」。
   カード寸法・FK線の座標計算は layout.ts（エクスポートと共有）にある。 */

function newColumn(partial?: Partial<Column>): Column {
  return { id: uid("c"), name: "column", type: "text", pk: false, nullable: true, unique: false, fk: null, default: null, comment: null, ...partial };
}

type LinkDrag = { tableId: string; columnId: string; x: number; y: number };

export function App() {
  const { model, act, connected } = useModel();
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(() => localStorage.getItem("drawzu.help") !== "closed");
  const toggleHelp = () => {
    setShowHelp((v) => {
      localStorage.setItem("drawzu.help", v ? "closed" : "open");
      return !v;
    });
  };
  /** SQLパネルの開閉。畳むと右端の帯だけ残り、キャンバスが広く使える */
  const [sqlOpen, setSqlOpen] = useState(() => localStorage.getItem("drawzu.sql") !== "closed");
  const toggleSql = () => {
    setSqlOpen((v) => {
      localStorage.setItem("drawzu.sql", v ? "closed" : "open");
      return !v;
    });
  };
  const [link, setLink] = useState<LinkDrag | null>(null);
  /** 選択中のFK線（クリックで選択 → Delete / ✕ ボタンで解除）。UIの状態なのでモデルには持たせない */
  const [selectedEdge, setSelectedEdge] = useState<{ tableId: string; columnId: string } | null>(null);
  /** ホバー中のテーブル。繋がるFK線だけ濃く見せ、他を薄める（線が多い図でも追えるように） */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** キャンバスの視点。x/y はパン量(px)、k は拡大率。UIの状態なのでモデルには持たせない */
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; k: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const sql = useMemo(() => (model ? toSQL(model) : ""), [model]);

  // ズーム/パン。React の onWheel は preventDefault が効かない(passive)ため素のリスナーで拾う
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          // ピンチ / ⌘+ホイール: カーソル位置を不動点にしてズーム
          const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.01)));
          return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [model === null]);

  const zoomBy = (f: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = r.width / 2, py = r.height / 2;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * f));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  // 編集が起きるたびSQL窓を一瞬フラッシュ → 「同期してる」を体で分からせる
  const pulse = useCallback(() => {
    setFlash(true);
    setTimeout(() => setFlash(false), 260);
  }, []);
  const edit = useCallback((op: Op) => { act(op); pulse(); }, [act, pulse]);

  const removeFk = useCallback((tableId: string, columnId: string) => {
    edit({ type: "UPDATE_COLUMN", tableId, columnId, patch: { fk: null } });
    setSelectedEdge(null);
  }, [edit]);

  // 選択中のFK線を Delete / Backspace で解除（入力欄にフォーカスがある間は拾わない）
  useEffect(() => {
    if (!selectedEdge) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeFk(selectedEdge.tableId, selectedEdge.columnId);
      }
      if (e.key === "Escape") setSelectedEdge(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdge, removeFk]);

  // 画面座標 → ワールド座標（パン/ズームを打ち消してモデル上の座標にする）
  const canvasPoint = useCallback((ev: { clientX: number; clientY: number }) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  }, [view]);

  /** 背景ドラッグでパン（カード上は各自のハンドラが先に受けるのでここに来ない） */
  const onPanStart = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    setSelectedEdge(null);
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    const el = canvasRef.current;
    if (el) el.style.cursor = "grabbing";
    const move = (ev: MouseEvent) => setView((v) => ({ ...v, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }));
    const up = () => {
      if (el) el.style.cursor = "default";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!model) {
    return (
      <div style={{ fontFamily: "'Inter', system-ui, sans-serif", color: sub, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#eef0f3" }}>
        {connected ? "モデルを読み込み中…" : "drawzu サーバーに接続中…（npm run dev で起動していますか？）"}
      </div>
    );
  }

  const hitTable = (p: { x: number; y: number }) =>
    model.tables.find((t) => p.x >= t.x && p.x <= t.x + CARD_W && p.y >= t.y && p.y <= t.y + tableHeight(t));

  const makeTable = (name: string, x: number, y: number): Table => ({
    id: uid("t"), name, x, y,
    columns: [newColumn({ name: "id", type: "uuid", pk: true, nullable: false })],
    indexes: [], rlsEnabled: false, rls: [], comment: null,
  });

  const addTable = () => {
    const n = model.tables.length;
    edit({ type: "ADD_TABLE", table: makeTable(`new_table_${n}`, 120 + n * 28, 120 + n * 28) });
  };

  /** 名詞の洗い出し（設計手順1）: 1行 = 1テーブル。「名前: メモ」でメモも同時に付く */
  const parseBulk = (raw: string): { name: string; memo: string | null }[] => {
    const existing = new Set(model.tables.map((t) => t.name));
    const seen = new Set<string>();
    return raw
      .split("\n")
      .map((lineText) => {
        const s = lineText.trim();
        if (!s) return null;
        const m = s.match(/^([^\s:：]+)[\s:：]*(.*)$/);
        if (!m) return null;
        return { name: m[1], memo: m[2].trim() || null };
      })
      .filter((e): e is { name: string; memo: string | null } => e != null)
      .filter((e) => {
        if (existing.has(e.name) || seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
      });
  };

  const addTablesBulk = (entries: { name: string; memo: string | null }[]) => {
    if (entries.length === 0) return;
    // 既存テーブルの下の空き地に3列グリッドで並べる
    const baseY = model.tables.length > 0
      ? Math.max(...model.tables.map((t) => t.y + tableHeight(t))) + 40
      : 100;
    entries.forEach(({ name, memo }, i) => {
      edit({
        type: "ADD_TABLE",
        table: { ...makeTable(name, 100 + (i % 3) * (CARD_W + 48), baseY + Math.floor(i / 3) * 200), comment: memo },
      });
    });
  };

  const commitBulk = () => {
    addTablesBulk(parseBulk(bulkText));
    setBulkText("");
    setBulkOpen(false);
  };

  /** 整列: FKグラフから階層(rank)を作り、参照される側を左・参照する側を右へ並べ直す。
      結果は MOVE_TABLE でモデルに書き戻す（配置もモデルの一部、という思想のまま） */
  const autoLayout = () => {
    const tables = model.tables;
    if (tables.length < 2) return;
    const byIdL = Object.fromEntries(tables.map((t) => [t.id, t]));
    const refs = new Map(tables.map((t) => [
      t.id,
      t.columns.filter((c) => c.fk && byIdL[c.fk.tableId] && c.fk.tableId !== t.id).map((c) => c.fk!.tableId),
    ]));
    const referenced = new Set([...refs.values()].flat());
    const placed: { id: string; x: number; y: number }[] = [];
    const GAP_X = 110, GAP_Y = 44;

    if (referenced.size === 0) {
      // FKがまだ1本も無い → 素直にグリッド。今の並び（上から・左から）をなるべく保つ
      const perRow = Math.max(2, Math.ceil(Math.sqrt(tables.length)));
      const sorted = [...tables].sort((a, b) => a.y - b.y || a.x - b.x);
      let y = 60;
      for (let i = 0; i < sorted.length; i += perRow) {
        const row = sorted.slice(i, i + perRow);
        row.forEach((t, j) => placed.push({ id: t.id, x: 60 + j * (CARD_W + 48), y }));
        y += Math.max(...row.map(tableHeight)) + GAP_Y;
      }
    } else {
      // rank = 参照先の最大rank+1（参照する側ほど右）。循環参照はそこで打ち切る
      const rank = new Map<string, number>();
      const calc = (id: string, stack: Set<string>): number => {
        const memo = rank.get(id);
        if (memo != null) return memo;
        if (stack.has(id)) return 0;
        stack.add(id);
        const r = (refs.get(id) ?? []).reduce((mx, p) => Math.max(mx, calc(p, stack) + 1), 0);
        stack.delete(id);
        rank.set(id, r);
        return r;
      };
      tables.forEach((t) => calc(t.id, new Set()));
      // 孤立テーブル（FKが出ても入ってもいない）は本流に混ぜず最後の列へ
      const maxRank = Math.max(...rank.values());
      const isolated = tables.filter((t) => (refs.get(t.id)?.length ?? 0) === 0 && !referenced.has(t.id));
      if (isolated.length < tables.length) isolated.forEach((t) => rank.set(t.id, maxRank + 1));

      const rankVals = [...new Set(rank.values())].sort((a, b) => a - b);
      const cols = rankVals.map((r) => tables.filter((t) => rank.get(t.id) === r));
      // 列内の順序: まず今のy順（ユーザーの並びを尊重）→ 参照先の並び位置の重心で寄せて線の交差を減らす
      cols.forEach((col) => col.sort((a, b) => a.y - b.y));
      const orderIdx = new Map<string, number>();
      cols.forEach((col) => col.forEach((t, i) => orderIdx.set(t.id, i)));
      for (let i = 1; i < cols.length; i++) {
        const bary = (t: Table) => {
          const ps = (refs.get(t.id) ?? []).map((p) => orderIdx.get(p) ?? 0);
          return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : orderIdx.get(t.id)!;
        };
        cols[i].sort((a, b) => bary(a) - bary(b));
        cols[i].forEach((t, j) => orderIdx.set(t.id, j));
      }

      const heights = cols.map((col) => col.reduce((s, t) => s + tableHeight(t), 0) + GAP_Y * (col.length - 1));
      const maxH = Math.max(...heights);
      cols.forEach((col, i) => {
        const x = 60 + i * (CARD_W + GAP_X);
        let y = 60 + (maxH - heights[i]) / 2; // 短い列は縦中央に寄せる
        for (const t of col) {
          placed.push({ id: t.id, x, y });
          y += tableHeight(t) + GAP_Y;
        }
      });
    }

    placed.forEach((p) => act({ type: "MOVE_TABLE", id: p.id, x: p.x, y: p.y }));
    pulse();
    // 整列後は全体が収まる位置へ視点を移す
    const el = canvasRef.current;
    if (el) {
      const hOf = new Map(tables.map((t) => [t.id, tableHeight(t)]));
      const maxX = Math.max(...placed.map((p) => p.x + CARD_W)) + 60;
      const maxY = Math.max(...placed.map((p) => p.y + hOf.get(p.id)!)) + 60;
      const r = el.getBoundingClientRect();
      setView({ x: 0, y: 0, k: Math.max(0.2, Math.min(1, r.width / maxX, r.height / maxY)) });
    }
  };

  const onDragStart = (e: React.MouseEvent, t: Table) => {
    if ((e.target as HTMLElement).closest("input,select,button,textarea,[data-fk-handle]")) return;
    dragRef.current = { id: t.id, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, k: view.k };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      act({ type: "MOVE_TABLE", id: d.id, x: d.ox + (ev.clientX - d.sx) / d.k, y: d.oy + (ev.clientY - d.sy) / d.k });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** カラム行右端の ● からドラッグして相手テーブルに落とすと FK が張られる */
  const onLinkStart = (e: React.MouseEvent, t: Table, c: Column) => {
    e.preventDefault();
    e.stopPropagation();
    const p = canvasPoint(e);
    setLink({ tableId: t.id, columnId: c.id, x: p.x, y: p.y });
    const move = (ev: MouseEvent) => {
      const q = canvasPoint(ev);
      setLink((l) => (l ? { ...l, x: q.x, y: q.y } : l));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const target = hitTable(canvasPoint(ev));
      setLink(null);
      if (target && target.id !== t.id) {
        edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { fk: { tableId: target.id } } });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const byId = Object.fromEntries(model.tables.map((t) => [t.id, t]));

  const fkEdges = computeFkEdges(model.tables);

  const linkSource = link ? byId[link.tableId] : null;
  const linkTarget = link ? hitTable(link) : null;
  const linkFrom = link && linkSource
    ? { x: link.x >= linkSource.x + CARD_W / 2 ? linkSource.x + CARD_W : linkSource.x, y: colY(linkSource, link.columnId) }
    : null;

  const copy = () => {
    navigator.clipboard?.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  /** いまの図をそのままの配置で1枚の自己完結HTMLとしてダウンロード（共有・資料用） */
  const downloadHtml = () => {
    const blob = new Blob([buildExportHtml(model, sql)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = url;
    a.download = `drawzu-schema-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", color: ink, background: "#eef0f3", height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div style={{ height: 56, background: "#fff", borderBottom: `1px solid ${line}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>drawzu</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: sub, background: "#f4f5f7", padding: "3px 9px", borderRadius: 999 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: connected ? "#3fb27f" : "#d9534f", display: "inline-block" }} />
            {connected ? "モデルと同期中" : "切断 — 再接続中…"}
          </div>
          {link && (
            <div style={{ fontSize: 11, color: accent, fontWeight: 600 }}>
              参照先のテーブルにドロップして FK を張る
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={autoLayout} title="FKの向きで並べ直す（参照される側が左・参照する側が右）"
            style={{ background: "none", color: sub, fontSize: 12, padding: "6px 11px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer", whiteSpace: "nowrap" }}>
            ✦ 整列
          </button>
          <button onClick={downloadHtml} title="いまの図をそのままの配置で1枚のHTMLに保存（SQL付き・共有用）"
            style={{ background: "none", color: sub, fontSize: 12, padding: "6px 11px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer", whiteSpace: "nowrap" }}>
            📷 HTML保存
          </button>
          <button onClick={() => setPermOpen(true)}
            style={{ background: "none", color: sub, fontSize: 12, padding: "6px 11px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer", whiteSpace: "nowrap" }}>
            🛡 権限マップ
          </button>
          <button onClick={() => setBulkOpen(true)}
            style={{ background: "none", color: sub, fontSize: 12, padding: "6px 11px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer", whiteSpace: "nowrap" }}>
            ⇥ 洗い出し
          </button>
          <button onClick={toggleHelp}
            style={{ background: showHelp ? "#f4f5f7" : "none", color: sub, fontSize: 12, padding: "6px 11px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer", whiteSpace: "nowrap" }}>
            ？ 使い方
          </button>
          <button onClick={addTable}
            style={{ background: ink, color: "#fff", fontSize: 13, fontWeight: 500, padding: "7px 13px", borderRadius: 8, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
            ＋ テーブル追加
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {showHelp && <HelpPanel onClose={toggleHelp} />}
        {/* Canvas */}
        <div ref={canvasRef} onMouseDown={onPanStart}
          style={{ flex: 1, position: "relative", overflow: "hidden",
            backgroundImage: "radial-gradient(#d4d7dd 1px, transparent 1px)",
            backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
            backgroundColor: "#eef0f3" }}>
          {/* world: パン/ズームの transform はこの1枚に集約。カードもFK線も同じ座標系で動く */}
          <div style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}>
          <svg style={{ position: "absolute", top: 0, left: 0, width: 1, height: 1, pointerEvents: "none", overflow: "visible" }}>
            <defs>
              <marker id="fk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} opacity="0.75" />
              </marker>
            </defs>
            {fkEdges.map((e) => {
              const selected = selectedEdge?.tableId === e.tableId && selectedEdge?.columnId === e.columnId;
              // FK張りのドラッグ中はドロップ先の判断が主役なので、ホバーによる強弱は付けない
              const hover = link ? null : hoverId;
              const focused = hover != null && (e.tableId === hover || e.toId === hover);
              const dimmed = hover != null && !focused && !selected;
              return (
                <g key={e.key}>
                  <path d={e.d} fill="none" stroke={accent}
                    strokeWidth={selected ? 2.6 : focused ? 2.2 : 1.6}
                    opacity={selected ? 0.95 : focused ? 0.9 : dimmed ? 0.08 : 0.55}
                    markerEnd="url(#fk-arrow)" style={{ transition: "opacity 130ms ease" }} />
                  <circle cx={e.x1} cy={e.y1} r="3" fill={accent} opacity={dimmed ? 0.08 : 0.75} style={{ transition: "opacity 130ms ease" }} />
                  {/* 透明な太い当たり判定。1.6pxの線を狙わなくてもクリックで選択できる */}
                  <path d={e.d} fill="none" stroke="transparent" strokeWidth="14"
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onMouseDown={(ev) => ev.stopPropagation()}
                    onClick={() => setSelectedEdge({ tableId: e.tableId, columnId: e.columnId })}>
                    <title>クリックで選択 → Delete で FK を解除</title>
                  </path>
                  {selected && (
                    <g style={{ pointerEvents: "auto", cursor: "pointer" }}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={() => removeFk(e.tableId, e.columnId)}>
                      <title>FK を解除（Delete キーでも消せる）</title>
                      <circle cx={(e.x1 + e.x2) / 2} cy={(e.y1 + e.y2) / 2} r="8" fill="#fff" stroke={accent} strokeWidth="1.2" />
                      <text x={(e.x1 + e.x2) / 2} y={(e.y1 + e.y2) / 2} textAnchor="middle" dominantBaseline="central"
                        fontSize="9" fontWeight="700" fill={accent} style={{ userSelect: "none" }}>✕</text>
                    </g>
                  )}
                </g>
              );
            })}
            {link && linkFrom && (
              <g>
                <path
                  d={`M ${linkFrom.x} ${linkFrom.y} C ${(linkFrom.x + link.x) / 2} ${linkFrom.y}, ${(linkFrom.x + link.x) / 2} ${link.y}, ${link.x} ${link.y}`}
                  fill="none" stroke={accent} strokeWidth="1.6" strokeDasharray="5 4" opacity="0.8" markerEnd="url(#fk-arrow)" />
                <circle cx={linkFrom.x} cy={linkFrom.y} r="3" fill={accent} />
              </g>
            )}
          </svg>

          {model.tables.map((t) => (
            <TableCard key={t.id} t={t} tables={model.tables} onDragStart={onDragStart} onLinkStart={onLinkStart} edit={edit}
              onHover={setHoverId} dropTarget={!!link && linkTarget?.id === t.id && link.tableId !== t.id} />
          ))}
          </div>

          {model.tables.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: sub, fontSize: 13, pointerEvents: "none" }}>
              テーブルがありません。「＋ テーブル追加」か、Claude に設計を流し込んでもらってください。
            </div>
          )}

          {/* zoom controls */}
          <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", alignItems: "center", gap: 1,
            background: "#fff", border: `1px solid ${line}`, borderRadius: 8, padding: 2, boxShadow: "0 2px 8px rgba(30,35,50,0.1)" }}>
            <button onClick={() => zoomBy(1 / 1.2)} title="縮小"
              style={{ background: "none", border: "none", cursor: "pointer", color: sub, fontSize: 14, width: 26, height: 24, lineHeight: 1 }}>−</button>
            <button onClick={() => setView({ x: 0, y: 0, k: 1 })} title="100%に戻す"
              style={{ background: "none", border: "none", cursor: "pointer", color: sub, fontSize: 11, width: 44, height: 24, fontVariantNumeric: "tabular-nums" }}>
              {Math.round(view.k * 100)}%
            </button>
            <button onClick={() => zoomBy(1.2)} title="拡大"
              style={{ background: "none", border: "none", cursor: "pointer", color: sub, fontSize: 14, width: 26, height: 24, lineHeight: 1 }}>＋</button>
          </div>
        </div>

        {/* SQL panel（畳むと右端の帯だけ残る） */}
        {sqlOpen ? (
          <div style={{ width: 380, flexShrink: 0, background: "#1b1f2a", display: "flex", flexDirection: "column",
            boxShadow: flash ? `inset 3px 0 0 ${accent}` : "inset 3px 0 0 transparent", transition: "box-shadow 240ms ease" }}>
            <div style={{ height: 42, borderBottom: "1px solid #2a2f3d", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px" }}>
              <span style={{ color: "#8b93a7", fontSize: 11, letterSpacing: "0.06em", fontWeight: 600 }}>GENERATED · schema.sql</span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={copy}
                  style={{ background: "transparent", color: copied ? "#6ee7a8" : "#8b93a7", fontSize: 12, border: "none", cursor: "pointer" }}>
                  {copied ? "✓ コピーした" : "コピー"}
                </button>
                <button onClick={toggleSql} title="SQLパネルを畳む"
                  style={{ background: "transparent", color: "#8b93a7", fontSize: 13, border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}>
                  »
                </button>
              </div>
            </div>
            <pre style={{ margin: 0, padding: "16px 18px", overflow: "auto", flex: 1, fontSize: 12.5, lineHeight: 1.7,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#c8cede", whiteSpace: "pre" }}>
              <SqlHighlighted sql={sql} />
            </pre>
            <div style={{ padding: "10px 18px", borderTop: "1px solid #2a2f3d", color: "#5f6577", fontSize: 11, flexShrink: 0 }}>
              図を触っても、AIが patch しても、同じ1個のモデルが更新されて即再生成される。
            </div>
          </div>
        ) : (
          <button onClick={toggleSql} title="SQLパネルを開く"
            style={{ width: 28, flexShrink: 0, background: "#1b1f2a", border: "none", cursor: "pointer",
              color: "#8b93a7", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em",
              writingMode: "vertical-rl", padding: "14px 0", textAlign: "center",
              boxShadow: flash ? `inset 3px 0 0 ${accent}` : "inset 3px 0 0 transparent", transition: "box-shadow 240ms ease" }}>
            « SQL
          </button>
        )}
      </div>

      {/* 洗い出しモーダル: まだ図を見ていない段階の操作なので、大きく開いて頭の中を一気に流し込む */}
      {bulkOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setBulkOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(20,24,33,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ width: 640, maxWidth: "92vw", background: "#fff", borderRadius: 14, boxShadow: "0 18px 50px rgba(20,24,33,0.35)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px 0" }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>保存したいものを洗い出す</div>
              <div style={{ fontSize: 12, color: sub, marginTop: 4, lineHeight: 1.6 }}>
                1行に1テーブル。<b>「名前: メモ」</b>の形で書くと、メモ（何を保存する？何に紐づく？）も一緒に付きます。
                名前だけの行でも OK。カラム設計は後でよくて、まずここに頭の中を全部出すのがコツ。
              </div>
            </div>
            <textarea autoFocus value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setBulkOpen(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitBulk();
              }}
              placeholder={"users: サービスの利用者\nposts: ユーザーの投稿。users に属する\ntags: 投稿に付くタグ。posts と多対多\ncomments\n…"}
              style={{ margin: "14px 20px 0", height: 260, resize: "vertical", border: `1px solid ${line}`, borderRadius: 10, outline: "none",
                background: "#fdf9e8", color: "#5c5313", fontSize: 13, lineHeight: 1.9, padding: "12px 14px",
                fontFamily: "'JetBrains Mono', ui-monospace, monospace" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 16px" }}>
              <span style={{ fontSize: 11.5, color: sub }}>
                {parseBulk(bulkText).length > 0
                  ? `${parseBulk(bulkText).length} 個のテーブルを追加します（既存と同名はスキップ）`
                  : "⌘Enter で追加 / Esc で閉じる"}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setBulkOpen(false)}
                  style={{ background: "none", color: sub, fontSize: 12.5, padding: "7px 14px", borderRadius: 8, border: `1px solid ${line}`, cursor: "pointer" }}>
                  キャンセル
                </button>
                <button onClick={commitBulk} disabled={parseBulk(bulkText).length === 0}
                  style={{ background: parseBulk(bulkText).length ? ink : "#c8ccd4", color: "#fff", fontSize: 12.5, fontWeight: 600, padding: "7px 16px", borderRadius: 8, border: "none", cursor: parseBulk(bulkText).length ? "pointer" : "default" }}>
                  テーブルにして並べる
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {permOpen && <PermMatrix model={model} onClose={() => setPermOpen(false)} />}
    </div>
  );
}

/** 権限マップ: モデルのRLSポリシーから「どのテーブルの何を・誰ができるか」を自動生成する投影 */
function PermMatrix({ model, onClose }: { model: Model; onClose: () => void }) {
  const CMDS = ["select", "insert", "update", "delete"] as const;
  const CMD_LABEL: Record<string, string> = { select: "読む", insert: "入れる", update: "書換", delete: "消す" };

  const cell = (t: Table, c: string) => {
    if (!t.rlsEnabled) {
      return <span title="RLSが無効なので、テーブルに触れるロール全員が全行を操作できる"
        style={{ fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "2px 7px", borderRadius: 4 }}>開放</span>;
    }
    const pols = t.rls.filter((p) => p.command === c || p.command === "all");
    if (pols.length === 0) {
      return <span title="この操作を許可するポリシーが無い = 誰もできない" style={{ fontSize: 11, color: "#c8ccd4" }}>✕</span>;
    }
    const color = CMD_COLOR[c] ?? rlsColor;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
        {pols.map((p) => (
          <span key={p.id}
            title={`${p.command === "all" ? "[ALLポリシー] " : ""}using: ${p.using ?? "—"}\nwith check: ${p.withCheck ?? "—"}`}
            style={{ fontSize: 10, color, background: `${color}14`, padding: "2px 7px", borderRadius: 4,
              maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              border: p.command === "all" ? `1px dashed ${color}66` : "1px solid transparent" }}>
            {p.name}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(20,24,33,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ width: 980, maxWidth: "94vw", maxHeight: "84vh", background: "#fff", borderRadius: 14,
        boxShadow: "0 18px 50px rgba(20,24,33,0.35)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>🛡 権限マップ</div>
            <div style={{ fontSize: 11.5, color: sub, marginTop: 3 }}>
              モデルの RLS ポリシーから自動生成（図・SQLと同じモデルのもう1つの投影）。セルにホバーすると条件式が見える。
              点線枠は ALL ポリシー由来。
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#c0c4cc", fontSize: 14, padding: 4 }}>✕</button>
        </div>
        <div style={{ overflow: "auto", padding: "0 20px 20px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", fontSize: 10.5, color: sub, fontWeight: 700, padding: "8px 10px", borderBottom: `2px solid ${line}`, position: "sticky", top: 0, background: "#fff" }}>テーブル</th>
                {CMDS.map((c) => (
                  <th key={c} style={{ textAlign: "left", fontSize: 10.5, fontWeight: 800, color: CMD_COLOR[c], padding: "8px 10px", borderBottom: `2px solid ${line}`, position: "sticky", top: 0, background: "#fff" }}>
                    {c.toUpperCase()} <span style={{ color: sub, fontWeight: 500 }}>{CMD_LABEL[c]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.tables.map((t) => (
                <tr key={t.id}>
                  <td style={{ padding: "7px 10px", borderBottom: `1px solid ${line}`, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", verticalAlign: "top" }}>
                    {t.name}
                    {!t.rlsEnabled && <span style={{ marginLeft: 6, fontSize: 9, color: "#b45309" }}>RLS無効</span>}
                  </td>
                  {CMDS.map((c) => (
                    <td key={c} style={{ padding: "7px 10px", borderBottom: `1px solid ${line}`, verticalAlign: "top" }}>{cell(t, c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: sub, marginTop: 10, lineHeight: 1.6 }}>
            <b>読み方</b>: ✕ = 許可するポリシーが無い（誰もできない） / <span style={{ color: "#b45309" }}>開放</span> = RLS無効で全行に触れる ／
            チップ = その操作を許可するポリシー（名前が「誰ができるか」を表すように命名する）。
          </div>
        </div>
      </div>
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"ops" | "guide">("ops");
  const H = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 10.5, fontWeight: 700, color: sub, letterSpacing: "0.05em", margin: "14px 0 6px" }}>{children}</div>
  );
  const Row = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, lineHeight: 1.55, color: ink, marginBottom: 6 }}>
      <span style={{ flexShrink: 0, width: 20, textAlign: "center", color: accent }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 2 }}>
        <span style={{ flexShrink: 0, width: 17, height: 17, borderRadius: 999, background: accent, color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: ink }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#4b5261", paddingLeft: 24 }}>{children}</div>
    </div>
  );
  const Term = ({ word, children }: { word: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 8 }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: ink }}>{word}</span>
      <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#4b5261" }}>{children}</div>
    </div>
  );

  const tabBtn = (key: "ops" | "guide", label: string) => (
    <button onClick={() => setTab(key)}
      style={{ flex: 1, background: tab === key ? "#fff" : "transparent", color: tab === key ? ink : sub,
        fontSize: 11.5, fontWeight: tab === key ? 700 : 500, padding: "5px 0", borderRadius: 6,
        border: "none", cursor: "pointer", boxShadow: tab === key ? "0 1px 3px rgba(30,35,50,0.12)" : "none" }}>
      {label}
    </button>
  );

  return (
    <div style={{ width: 252, flexShrink: 0, background: "#fff", borderRight: `1px solid ${line}`, overflowY: "auto", padding: "12px 14px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>ガイド</span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#c0c4cc", fontSize: 12, padding: 2 }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 3, background: "#eef0f3", borderRadius: 8, padding: 3 }}>
        {tabBtn("ops", "操作")}
        {tabBtn("guide", "DB設計の考え方")}
      </div>

      {tab === "guide" ? (
        <>
          <div style={{ border: `1px solid ${line}`, borderRadius: 8, background: "#fafbfc", padding: "8px 10px", margin: "12px 0 2px", fontSize: 11, lineHeight: 1.6, color: "#4b5261" }}>
            <b style={{ color: ink }}>前提</b>: drawzu が生成する SQL・カラム型・RLS は <b>Postgres 方言</b>（Supabase / Neon / 素の Postgres など）。
            RLS は Postgres の機能で、MySQL や SQLite に同等物は無い。
            対象プロジェクトの言語は問わない（モデルは <code style={{ fontSize: 10 }}>.drawzu/model.json</code>、出力は SQL）。
          </div>
          <H>設計の手順（この順にやる）</H>
          <Step n={1} title="保存したいものを名詞で洗い出す">
            画面や機能を眺めて「覚えておく必要があるもの」を名詞で列挙する（ユーザー、投稿、コメント、注文…）。この名詞が、だいたいそのままテーブルになる。<br />
            → 上の「⇥ 洗い出し」を開いて、1行1テーブルで「名前: メモ」を一気に流し込む。メモ（何を保存する？何に紐づく？）を書いておくと、後の手順4（線を引く）と AI への指示がそのまま楽になる。
          </Step>
          <Step n={2} title="1テーブル = 1つの関心事">
            1つのテーブルには1種類のものだけ入れる。「ユーザーと投稿」を1テーブルに混ぜない。同じ行の中に「タグ1, タグ2, タグ3」のような繰り返しが出たら、それは別テーブルに切り出すサイン。
          </Step>
          <Step n={3} title="全テーブルに主キー（id）">
            行を一意に特定するカラムを必ず置く。迷ったら <code style={{ fontSize: 10.5 }}>id uuid</code> でよい。連番より uuid の方が、URLに出ても推測されず、複数環境でも衝突しない。
          </Step>
          <Step n={4} title="関係を線にする">
            「AはBを複数持つ」（1対多）なら、<b>多side（B）にFKを置く</b>。投稿はユーザーに属する → posts に user_id。<br />
            「AとBが互いに複数」（多対多。例: 投稿とタグ）は中間テーブル（post_tags）を作り、両方へのFKを置く。
          </Step>
          <Step n={5} title="型と制約は厳しめに">
            まず全カラム not null で考えて、「本当に空がありうるか」を問うてから緩める。日時は timestamptz、金額は numeric、真偽は boolean。「メールは重複禁止」のようなルールは unique で DB に守らせる（アプリのコードだけで守らない）。
          </Step>
          <Step n={6} title="インデックスを張る">
            「検索条件・JOIN・並び替え」に使うカラムに張る。<b>FKカラムにはまず張る</b>（JOINで必ず使うため）。「ユーザーごとに新しい順」なら (user_id, created_at) の複合。張りすぎは書き込みを遅くするので、使う見込みのある所だけ。
          </Step>
          <Step n={7} title="誰がどの行を見られるか（RLS）">
            Supabase なら Row Level Security を必ず考える。「自分の行だけ読める」「管理者は全部」など、行単位のアクセス制御ルール。図には描けないが drawzu のモデルは保持していて、SQL に create policy として出る。
          </Step>
          <Step n={8} title="最後に重複チェック">
            同じ事実が2箇所に書かれていないか見直す（正規化）。例: 注文テーブルに商品名をコピーして持つと、商品名変更時に食い違う。基本はFKで参照し、コピーするのは「注文時点の価格」のように<b>その時点の値を残したい</b>意図がある時だけ。
          </Step>

          <H>用語ミニ辞典</H>
          <Term word="主キー（PK ⚿）">その行を一意に特定するカラム。全テーブルに1つ。</Term>
          <Term word="外部キー（FK ●）">他のテーブルの行を指すカラム。「posts.user_id は users の誰か」。参照先が消えたら困る関係を DB が守ってくれる。</Term>
          <Term word="1対多 / 多対多">1対多はFK1本。多対多は中間テーブル＋FK2本。ER図でほとんどの線はこのどちらか。</Term>
          <Term word="正規化">「同じ事実は1箇所にだけ書く」への言い換え。重複が無ければ、更新漏れによる食い違いが起きない。</Term>
          <Term word="インデックス（⌗）">本の索引と同じ。検索は速くなるが、書き込みのたびに索引も更新されるので少し遅くなる。</Term>
          <Term word="unique / not null / default">重複禁止 / 空禁止 / 未指定時の値。ルールはアプリでなく DB に守らせるのが鉄則（アプリは書き間違えるが DB は必ず守る）。</Term>
          <Term word="SELECT / INSERT / UPDATE / DELETE / ALL">DBへの操作を表す SQL の4動詞（読む / 入れる / 書き換える / 消す ＝ CRUD）。RLSポリシーのコマンドもこの語彙で、<b>ALL は「4つ全部」の省略記法</b>。drawzu 独自の言葉ではなく、どの DB でも通じる標準語。閲覧者/編集者/オーナーで例にするとこう:</Term>
          <table style={{ borderCollapse: "collapse", fontSize: 9.5, margin: "2px 0 10px", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${line}`, padding: "3px 5px", background: "#fafbfc" }}></th>
                {(["select", "insert", "update", "delete"] as const).map((c) => (
                  <th key={c} style={{ border: `1px solid ${line}`, padding: "3px 4px", color: CMD_COLOR[c], fontWeight: 800, background: "#fafbfc" }}>
                    {c.toUpperCase().slice(0, 3)}<div style={{ fontWeight: 500, color: sub }}>{{ select: "読む", insert: "入れる", update: "書換", delete: "消す" }[c]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([
                ["閲覧者", [true, false, false, false]],
                ["編集者", [true, true, true, false]],
                ["オーナー = ALL", [true, true, true, true]],
              ] as [string, boolean[]][]).map(([role, cells]) => (
                <tr key={role}>
                  <td style={{ border: `1px solid ${line}`, padding: "3px 6px", fontWeight: 700, whiteSpace: "nowrap" }}>{role}</td>
                  {cells.map((ok, i) => (
                    <td key={i} style={{ border: `1px solid ${line}`, padding: "3px 4px", textAlign: "center", color: ok ? "#059669" : "#c8ccd4", fontWeight: 700 }}>
                      {ok ? "✓" : "✕"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Term word="RLS">行単位のアクセス制御。「このテーブルは読めるが、自分の行だけ」ができる。条件に合わない行は<b>エラーでなく「存在しない」ように見える</b>（0行が返るだけ）。Supabase では実質必須。</Term>
          <Term word="GRANT と RLS の違い">どちらも門番だが粒度が違う。門は二段になっている:</Term>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, margin: "2px 0 4px", flexWrap: "wrap" }}>
            <span style={{ color: sub }}>リクエスト</span>
            <span style={{ color: "#c8ccd4" }}>→</span>
            <span style={{ border: `1px solid ${line}`, borderRadius: 5, padding: "3px 6px", background: "#fafbfc" }}>🚪 <b>GRANT</b><br /><span style={{ color: sub }}>テーブルに入れるか</span></span>
            <span style={{ color: "#c8ccd4" }}>→</span>
            <span style={{ border: `1px solid ${rlsColor}55`, borderRadius: 5, padding: "3px 6px", background: `${rlsColor}0a` }}>🚪 <b style={{ color: rlsColor }}>RLS</b><br /><span style={{ color: sub }}>どの行を見せるか</span></span>
            <span style={{ color: "#c8ccd4" }}>→</span>
            <span style={{ color: sub }}>許された行だけ返る</span>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#4b5261", marginBottom: 8 }}>
            Supabase では GRANT 側（1段目）は設定済みなので、開発者が書くのは実質 RLS（2段目）だけ。
            いまのモデルで「どのテーブルの何を誰ができるか」は、上部の <b>🛡 権限マップ</b> ボタンで一覧できる。
          </div>
          <Term word="using / with check">ポリシーの2つの条件式。<b>using は「既にある行を見る/触る条件」</b>、<b>with check は「これから入れる行が満たすべき条件」</b>。だから INSERT のポリシーは with check 側に書く（UPDATE は両方）。</Term>
          <Term word="migration">DB への変更履歴をSQLファイルで積み上げる運用。最初の1回はこの図のSQLをそのまま流せばよい。</Term>
        </>
      ) : (
        <>
          <H>テーブル</H>
      <Row icon="＋">右上の「テーブル追加」で新規作成</Row>
      <Row icon="⇥">上の「⇥ 洗い出し」で大きなメモが開く。1行1テーブルで「名前: メモ」を流し込むと<b>一括追加</b>（設計手順1に）</Row>
      <Row icon="📝">ヘッダの 📝 でメモ。「何を保存する？何に紐づく？」を自由文で。SQL の comment にもなり、AI も読む</Row>
      <Row icon="✎">テーブル名をクリックして変更（Enter で確定）</Row>
      <Row icon="✥">カードをドラッグして移動</Row>
      <Row icon="✕">ヘッダ右の ✕ で削除</Row>

      <H>キャンバス</H>
      <Row icon="✋">背景をドラッグで全体を移動（スクロールでも動く）</Row>
      <Row icon="🔍">ピンチ or ⌘＋ホイールでズーム。左下の − / ＋ でも。% クリックで100%に戻る</Row>
      <Row icon="✦">上の「✦ 整列」で、FKの向きに沿って自動で並べ直す（参照される側が左に来る）</Row>

      <H>カラム</H>
      <Row icon="⚿">鍵クリックで主キー切替</Row>
      <Row icon="N?">クリックで NULL 許可を切替</Row>
      <Row icon="A">型はカラム名の右のプルダウンで変更</Row>
      <Row icon="🗑">ゴミ箱で削除</Row>

      <H>リレーション（FK）</H>
      <Row icon="●">行右端の <b>●</b> をドラッグして相手テーブルに落とすと FK が張れる</Row>
      <Row icon="–">「–」プルダウンから参照先を選んでも同じ</Row>
      <Row icon="→">線は FK カラムから出て、参照先の主キーに矢印で刺さる</Row>
      <Row icon="◉">テーブルにホバーすると、そのテーブルに繋がる線だけ濃く表示（線が多い時に）</Row>
      <Row icon="✕">線をクリックで選択 → <b>Delete</b> キーか線上の ✕ ボタンで FK を解除</Row>

      <H>インデックス</H>
      <Row icon="⌗">カード下の「＋ ⌗ index」→ カラム行をクリックして対象を選ぶ（複数可＝複合）→ インデックス名をクリックで確定</Row>
      <Row icon="U">「U」で unique 切替</Row>

      <H>RLS（行アクセス制御）</H>
      <Row icon="🛡">ヘッダの <b>RLS バッジ</b>が紫=有効 / グレー=無効。クリックで切替</Row>
      <Row icon="▨">有効なテーブルは下部に <b>SEL / INS / UPD / DEL の ✓✕ ミニ表</b>（SELECT=青 / INSERT=緑 / UPDATE=橙 / DELETE=赤）。ホバーでポリシー名と using / with check の式が見える</Row>
      <Row icon="⚠">全部 ✕ のテーブルは「有効なのにポリシー0件 = 誰もアクセスできない」状態。ポリシーの中身の編集は AI（patch_model）経由で</Row>
      <Row icon="🛡">上部の「<b>権限マップ</b>」で、全テーブル × 4動詞 × ポリシーの一覧表が見られる（モデルからの自動生成）</Row>

      <H>SQL</H>
      <Row icon="▤">右パネルに常に最新の DDL（FK・index・RLS 込み）。「コピー」でそのまま Supabase 等に貼れる</Row>
      <Row icon="»">パネル右上の » で畳める。畳んでも右端の「« SQL」帯クリックで戻る</Row>
      <Row icon="📷">上の「📷 HTML保存」で、いまの図をそのままの配置＋SQL付きの1枚のHTMLとして保存（共有・資料用）</Row>

          <H>保存とAI連携</H>
          <Row icon="💾">変更は即座に <code style={{ fontSize: 10.5 }}>.drawzu/model.json</code> に保存される</Row>
          <Row icon="🤖">Claude が同じモデルを読み書きする（MCP は Phase 2 で追加予定）。図での手直しは AI の前提にもそのまま反映される</Row>
        </>
      )}
    </div>
  );
}

function TableCard({ t, tables, onDragStart, onLinkStart, edit, onHover, dropTarget }: {
  t: Table;
  tables: Table[];
  onDragStart: (e: React.MouseEvent, t: Table) => void;
  onLinkStart: (e: React.MouseEvent, t: Table, c: Column) => void;
  edit: (op: Op) => void;
  onHover: (id: string | null) => void;
  dropTarget: boolean;
}) {
  const [editingName, setEditingName] = useState(false);
  const [editingMemo, setEditingMemo] = useState(false);
  /** カラム選択中のインデックス id。この間はカラム行クリックで対象カラムをトグルする */
  const [editingIdx, setEditingIdx] = useState<string | null>(null);
  const others = tables.filter((x) => x.id !== t.id);
  const activeIdx = t.indexes.find((ix) => ix.id === editingIdx) ?? null;

  const toggleIdxColumn = (ix: Index, columnId: string) => {
    const columns = ix.columns.includes(columnId)
      ? ix.columns.filter((cid) => cid !== columnId)
      : [...ix.columns, columnId];
    edit({ type: "UPDATE_INDEX", tableId: t.id, indexId: ix.id, patch: { columns } });
  };

  const idxLabel = (ix: Index) => {
    const cols = ix.columns
      .map((cid) => t.columns.find((c) => c.id === cid)?.name)
      .filter(Boolean);
    return { name: ix.name ?? `${ix.unique ? "uq" : "idx"}_${t.name}${cols.length ? "_" + cols.join("_") : ""}`, cols };
  };

  return (
    <div onMouseDown={(e) => onDragStart(e, t)}
      onMouseEnter={() => onHover(t.id)} onMouseLeave={() => onHover(null)}
      style={{ position: "absolute", left: t.x, top: t.y, width: CARD_W, background: "#fff",
        borderRadius: 10, border: `1.5px solid ${dropTarget ? accent : line}`,
        boxShadow: dropTarget ? `0 0 0 3px ${accent}33, 0 4px 16px rgba(30,35,50,0.08)` : "0 4px 16px rgba(30,35,50,0.08)",
        cursor: "grab", userSelect: "none" }}>
      {/* header */}
      <div style={{ height: HEADER_H, padding: "0 10px 0 12px", borderBottom: `1px solid ${line}`, borderRadius: "10px 10px 0 0", background: "#fafbfc", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ color: accent, fontSize: 12, flexShrink: 0 }}>▦</span>
          {editingName ? (
            <input autoFocus defaultValue={t.name}
              onBlur={(e) => { edit({ type: "RENAME_TABLE", id: t.id, name: e.target.value.trim() || t.name }); setEditingName(false); }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              style={{ fontSize: 13, fontWeight: 600, border: `1px solid ${accent}`, borderRadius: 4, padding: "1px 4px", width: 150, outline: "none" }} />
          ) : (
            <span onClick={() => setEditingName(true)}
              style={{ fontSize: 13, fontWeight: 600, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          <button
            title={t.rlsEnabled
              ? `RLS有効（ポリシー${t.rls.length}件）。クリックで無効化`
              : "RLS無効 — 誰でも全行にアクセスできる状態。クリックで有効化"}
            onClick={() => edit({ type: "UPDATE_TABLE", id: t.id, patch: { rlsEnabled: !t.rlsEnabled } })}
            style={{ cursor: "pointer", fontSize: 8.5, fontWeight: 800, letterSpacing: "0.04em", lineHeight: 1,
              padding: "3px 5px", borderRadius: 5,
              background: t.rlsEnabled ? rlsColor : "transparent",
              color: t.rlsEnabled ? "#fff" : "#c0c4cc",
              border: `1px solid ${t.rlsEnabled ? rlsColor : "#d4d7dd"}` }}>
            RLS
          </button>
          <button title={t.comment != null ? "メモを編集" : "メモを追加（何を保存する？何に紐づく？）"}
            onClick={() => setEditingMemo(true)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, fontSize: 11, lineHeight: 1,
              color: t.comment != null ? pkColor : "#c0c4cc" }}>
            📝
          </button>
          <button onClick={() => edit({ type: "DELETE_TABLE", id: t.id })}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#c0c4cc", padding: 2, fontSize: 13, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      </div>

      {/* memo（設計手順1の「何を保存する・何に紐づくか」を自由文で。モデルの comment に保存され AI も読める） */}
      {editingMemo ? (
        <textarea autoFocus defaultValue={t.comment ?? ""}
          placeholder="何を保存する？何に紐づく？（例: ユーザーの投稿。users に属し tags を複数持つ）"
          onBlur={(e) => {
            const v = e.target.value.trim();
            edit({ type: "UPDATE_TABLE", id: t.id, patch: { comment: v || null } });
            setEditingMemo(false);
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
          style={{ display: "block", width: "100%", height: MEMO_H, resize: "none", border: "none", outline: "none",
            borderBottom: `1px solid ${line}`, background: "#fdf9e8", color: "#6b6018",
            fontSize: 11, lineHeight: 1.5, padding: "5px 12px", fontFamily: "inherit" }} />
      ) : t.comment != null && (
        <div onClick={() => setEditingMemo(true)} title="クリックで編集"
          style={{ height: MEMO_H, overflowY: "auto", borderBottom: `1px solid ${line}`, background: "#fdf9e8",
            color: "#6b6018", fontSize: 11, lineHeight: 1.5, padding: "5px 12px", cursor: "text", whiteSpace: "pre-wrap" }}>
          {t.comment}
        </div>
      )}

      {/* columns */}
      <div style={{ padding: "4px 0" }}>
        {t.columns.map((c) => {
          const inActiveIdx = activeIdx?.columns.includes(c.id) ?? false;
          return (
            <div key={c.id}
              onClick={activeIdx ? () => toggleIdxColumn(activeIdx, c.id) : undefined}
              style={{ height: ROW_H, padding: "0 8px 0 10px", display: "flex", alignItems: "center", gap: 4,
                cursor: activeIdx ? "pointer" : undefined,
                background: inActiveIdx ? `${accent}14` : undefined,
                boxShadow: inActiveIdx ? `inset 2px 0 0 ${accent}` : undefined }}>
              <button title="主キー"
                onClick={() => edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { pk: !c.pk, nullable: c.pk ? c.nullable : false } })}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0, opacity: c.pk ? 1 : 0.22, color: c.pk ? pkColor : sub, fontSize: 11, lineHeight: 1 }}>
                ⚿
              </button>
              <input value={c.name} readOnly={!!activeIdx}
                onChange={(e) => edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { name: e.target.value } })}
                style={{ border: "none", outline: "none", fontSize: 12.5, fontWeight: 500, width: 92, background: "transparent", color: ink, pointerEvents: activeIdx ? "none" : undefined }} />
              <select value={c.type} disabled={!!activeIdx}
                onChange={(e) => edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { type: e.target.value } })}
                style={{ border: "none", outline: "none", fontSize: 11, color: sub, background: "transparent", cursor: "pointer", flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace" }}>
                {COLUMN_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
              </select>
              <button title="NULL許可"
                onClick={() => edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { nullable: !c.nullable } })}
                style={{ background: "none", border: "none", cursor: c.pk ? "default" : "pointer", padding: "0 2px", fontSize: 9.5, fontWeight: 700, color: c.nullable ? sub : "#c0c4cc", flexShrink: 0, opacity: c.pk ? 0.3 : 1 }}>
                N?
              </button>
              <select title="外部キー参照先" value={c.fk?.tableId ?? ""} disabled={!!activeIdx}
                onChange={(e) => edit({ type: "UPDATE_COLUMN", tableId: t.id, columnId: c.id, patch: { fk: e.target.value ? { tableId: e.target.value } : null } })}
                style={{ border: "none", outline: "none", fontSize: 11, color: c.fk ? accent : "#c8ccd4", background: "transparent", cursor: "pointer", flexShrink: 0, width: 16, appearance: "none", textAlign: "center" }}>
                <option value="">–</option>
                {others.map((o) => <option key={o.id} value={o.id}>→ {o.name}</option>)}
              </select>
              <button onClick={() => edit({ type: "DELETE_COLUMN", tableId: t.id, columnId: c.id })}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#d4d7dd", padding: 0, flexShrink: 0, fontSize: 11, lineHeight: 1 }}>
                🗑
              </button>
              <span data-fk-handle title="ドラッグして相手テーブルに落とすと FK"
                onMouseDown={(e) => onLinkStart(e, t, c)}
                style={{ width: 9, height: 9, borderRadius: 999, flexShrink: 0, cursor: "crosshair",
                  border: `1.5px solid ${c.fk ? accent : "#b6bcc7"}`, background: c.fk ? accent : "#fff" }} />
            </div>
          );
        })}
      </div>

      {/* indexes */}
      {t.indexes.length > 0 && (
        <div style={{ borderTop: `1px solid ${line}`, padding: "4px 0" }}>
          {t.indexes.map((ix) => {
            const { name, cols } = idxLabel(ix);
            const editing = editingIdx === ix.id;
            return (
              <div key={ix.id} style={{ height: IDX_ROW_H, padding: "0 8px 0 12px", display: "flex", alignItems: "center", gap: 5,
                background: editing ? `${accent}0d` : undefined }}>
                <span style={{ color: editing ? accent : sub, fontSize: 10, flexShrink: 0 }}>⌗</span>
                <span onClick={() => setEditingIdx(editing ? null : ix.id)}
                  title={editing ? "クリックで確定" : "クリックしてカラムを選び直す"}
                  style={{ fontSize: 10.5, color: editing ? accent : sub, fontWeight: editing ? 700 : 500, cursor: "pointer",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                  {editing ? (cols.length ? `(${cols.join(", ")}) ✓確定` : "カラム行をクリックして選択…") : `${name}`}
                </span>
                <button title="unique切替"
                  onClick={() => edit({ type: "UPDATE_INDEX", tableId: t.id, indexId: ix.id, patch: { unique: !ix.unique } })}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", fontSize: 9, fontWeight: 700,
                    color: ix.unique ? accent : "#c0c4cc", flexShrink: 0 }}>
                  U
                </button>
                <button onClick={() => { if (editingIdx === ix.id) setEditingIdx(null); edit({ type: "DELETE_INDEX", tableId: t.id, indexId: ix.id }); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#d4d7dd", padding: 0, flexShrink: 0, fontSize: 10, lineHeight: 1 }}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* RLS: 権限（audience）×4動詞 の表。「どの権限がどの操作をできるか」をカード上で示す */}
      {rlsSectionHeight(t) > 0 && (
        <div style={{ borderTop: `1px solid ${line}`, height: rlsSectionHeight(t), background: `${rlsColor}08`, overflow: "hidden" }}>
          {!t.rlsEnabled || t.rls.length === 0 ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", padding: "0 10px" }}>
              {!t.rlsEnabled ? (
                <span title={`RLSが無効なので、テーブルに触れるロール全員が全行を操作できる${t.rls.length ? `（定義済みポリシー${t.rls.length}件は休眠中）` : ""}`}
                  style={{ fontSize: 9.5, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "3px 8px", borderRadius: 4 }}>
                  RLS無効 — 全行に触れる状態
                </span>
              ) : (
                <span title="RLSを有効にするとポリシーで許可した行しか見えなくなる。0件のままだと誰も読み書きできない"
                  style={{ fontSize: 9.5, fontWeight: 700, color: "#b45309" }}>
                  ⚠ ポリシー未定義 — 全アクセス拒否
                </span>
              )}
            </div>
          ) : (
            <div style={{ padding: "5px 8px 0" }}>
              <div style={{ display: "flex", gap: 3, height: RLS_HEAD_H, alignItems: "center" }}>
                <span style={{ width: 62, flexShrink: 0, fontSize: 8, fontWeight: 700, color: rlsColor }}>🛡 権限</span>
                {(["select", "insert", "update", "delete"] as const).map((c) => (
                  <span key={c} style={{ flex: 1, textAlign: "center", fontSize: 8, fontWeight: 800, color: CMD_COLOR[c], letterSpacing: "0.02em" }}>
                    {{ select: "SEL", insert: "INS", update: "UPD", delete: "DEL" }[c]}
                  </span>
                ))}
              </div>
              {rlsAudiences(t).map((aud) => (
                <div key={aud} style={{ display: "flex", gap: 3, height: RLS_AUD_ROW_H, alignItems: "center" }}>
                  <span style={{ width: 62, flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#4b5261",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{aud}</span>
                  {(["select", "insert", "update", "delete"] as const).map((c) => {
                    const pols = t.rls.filter((p) =>
                      (p.command === c || p.command === "all") &&
                      (p.audience.length > 0 ? p.audience : ["その他"]).includes(aud)
                    );
                    const ok = pols.length > 0;
                    return (
                      <span key={c}
                        title={ok
                          ? pols.map((p) => `${p.command === "all" ? "[ALL] " : ""}${p.name}\n  using: ${p.using ?? "—"}${p.withCheck ? `\n  with check: ${p.withCheck}` : ""}`).join("\n")
                          : `「${aud}」に ${c.toUpperCase()} を許可するポリシーは無い`}
                        style={{ flex: 1, textAlign: "center", fontSize: 9.5, fontWeight: 800, lineHeight: "15px",
                          borderRadius: 3, cursor: "default",
                          color: ok ? CMD_COLOR[c] : "#d4d7dd", background: ok ? `${CMD_COLOR[c]}12` : "transparent" }}>
                        {ok ? "✓" : "✕"}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", borderTop: `1px solid ${line}` }}>
        <button onClick={() => edit({ type: "ADD_COLUMN", tableId: t.id, column: newColumn() })}
          style={{ flex: 1, background: "none", border: "none", cursor: "pointer", color: sub, fontSize: 11.5, padding: "8px 12px", textAlign: "left" }}>
          ＋ カラム
        </button>
        <button
          onClick={() => {
            const ix: Index = { id: uid("i"), name: null, columns: [], unique: false };
            edit({ type: "ADD_INDEX", tableId: t.id, index: ix });
            setEditingIdx(ix.id);
          }}
          style={{ background: "none", border: "none", borderLeft: `1px solid ${line}`, cursor: "pointer", color: sub, fontSize: 11.5, padding: "8px 12px", whiteSpace: "nowrap" }}>
          ＋ ⌗ index
        </button>
      </div>
    </div>
  );
}

function SqlHighlighted({ sql }: { sql: string }) {
  const kw = /\b(create table|create policy|create unique index|create index|alter table|enable row level security|primary key|foreign key|references|not null|unique|default|for (?:select|insert|update|delete|all)|using|with check|to|on)\b/gi;
  const parts = sql.split(/(create table|create policy|create unique index|create index|alter table|enable row level security|primary key|foreign key|references|not null|unique|"[^"]*")/gi);
  return (
    <>
      {parts.map((p, i) => {
        if (/^"/.test(p)) return <span key={i} style={{ color: "#7dd3fc" }}>{p}</span>;
        if (kw.test(p)) { kw.lastIndex = 0; return <span key={i} style={{ color: "#c4a3ff" }}>{p}</span>; }
        if ((COLUMN_TYPES as readonly string[]).includes(p.trim())) return <span key={i} style={{ color: "#6ee7a8" }}>{p}</span>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
