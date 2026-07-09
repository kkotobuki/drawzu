import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLUMN_TYPES, type Column, type Index, type Table } from "../../core/model.ts";
import type { Op } from "../../core/ops.ts";
import { toSQL } from "../../core/sql.ts";
import { uid, useModel } from "./useModel.ts";

/* prototype/schema-canvas.jsx の移植。真実の源はサーバー上のモデル
   （.drawzu/model.json）に移り、この画面はそれを映す「人間の窓」。 */

const CARD_W = 248;
const HEADER_H = 40;
const ROW_H = 30;
const IDX_ROW_H = 24;
/** メモ欄の固定高さ。可変にするとFK線の座標計算がDOM計測依存になるため固定 */
const MEMO_H = 46;

const ink = "#232a36", sub = "#6b7280", line = "#e3e5ea", accent = "#4f5bd5", pkColor = "#b7791f";

function memoHeight(t: Table) {
  return t.comment != null ? MEMO_H : 0;
}
function idxSectionHeight(t: Table) {
  return t.indexes.length > 0 ? t.indexes.length * IDX_ROW_H + 8 : 0;
}
function tableHeight(t: Table) {
  return HEADER_H + memoHeight(t) + t.columns.length * ROW_H + idxSectionHeight(t) + 34;
}
/** カラム行の縦中心（キャンバス座標）。FK線の起点/終点に使う */
function colY(t: Table, columnId: string) {
  const i = t.columns.findIndex((c) => c.id === columnId);
  if (i < 0) return t.y + HEADER_H / 2;
  return t.y + HEADER_H + memoHeight(t) + 4 + i * ROW_H + ROW_H / 2;
}

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
  const [showHelp, setShowHelp] = useState(() => localStorage.getItem("drawzu.help") !== "closed");
  const toggleHelp = () => {
    setShowHelp((v) => {
      localStorage.setItem("drawzu.help", v ? "closed" : "open");
      return !v;
    });
  };
  const [link, setLink] = useState<LinkDrag | null>(null);
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

  // 画面座標 → ワールド座標（パン/ズームを打ち消してモデル上の座標にする）
  const canvasPoint = useCallback((ev: { clientX: number; clientY: number }) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  }, [view]);

  /** 背景ドラッグでパン（カード上は各自のハンドラが先に受けるのでここに来ない） */
  const onPanStart = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
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

  /** FK線: 起点はカラム行、終点は相手テーブルのPK行（無ければヘッダ）。近い側面から出入りする */
  const edgePath = (from: Table, columnId: string, to: Table) => {
    const toRight = to.x + CARD_W / 2 >= from.x + CARD_W / 2;
    const x1 = toRight ? from.x + CARD_W : from.x;
    const y1 = colY(from, columnId);
    const pk = to.columns.find((c) => c.pk);
    const y2 = pk ? colY(to, pk.id) : to.y + HEADER_H / 2;
    const x2 = toRight ? to.x : to.x + CARD_W;
    const d1 = toRight ? 60 : -60;
    return { d: `M ${x1} ${y1} C ${x1 + d1} ${y1}, ${x2 - d1} ${y2}, ${x2} ${y2}`, x1, y1 };
  };

  const fkEdges = model.tables.flatMap((t) =>
    t.columns
      .filter((c) => c.fk && byId[c.fk.tableId])
      .map((c) => ({ ...edgePath(t, c.id, byId[c.fk!.tableId]), key: `${t.id}-${c.id}` }))
  );

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
            {fkEdges.map((e) => (
              <g key={e.key}>
                <path d={e.d} fill="none" stroke={accent} strokeWidth="1.6" opacity="0.55" markerEnd="url(#fk-arrow)" />
                <circle cx={e.x1} cy={e.y1} r="3" fill={accent} opacity="0.75" />
              </g>
            ))}
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
              dropTarget={!!link && linkTarget?.id === t.id && link.tableId !== t.id} />
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

        {/* SQL panel */}
        <div style={{ width: 380, flexShrink: 0, background: "#1b1f2a", display: "flex", flexDirection: "column",
          boxShadow: flash ? `inset 3px 0 0 ${accent}` : "inset 3px 0 0 transparent", transition: "box-shadow 240ms ease" }}>
          <div style={{ height: 42, borderBottom: "1px solid #2a2f3d", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px" }}>
            <span style={{ color: "#8b93a7", fontSize: 11, letterSpacing: "0.06em", fontWeight: 600 }}>GENERATED · schema.sql</span>
            <button onClick={copy}
              style={{ background: "transparent", color: copied ? "#6ee7a8" : "#8b93a7", fontSize: 12, border: "none", cursor: "pointer" }}>
              {copied ? "✓ コピーした" : "コピー"}
            </button>
          </div>
          <pre style={{ margin: 0, padding: "16px 18px", overflow: "auto", flex: 1, fontSize: 12.5, lineHeight: 1.7,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#c8cede", whiteSpace: "pre" }}>
            <SqlHighlighted sql={sql} />
          </pre>
          <div style={{ padding: "10px 18px", borderTop: "1px solid #2a2f3d", color: "#5f6577", fontSize: 11, flexShrink: 0 }}>
            図を触っても、AIが patch しても、同じ1個のモデルが更新されて即再生成される。
          </div>
        </div>
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
          <Term word="RLS">行単位のアクセス制御。「このテーブルは読めるが、自分の行だけ」ができる。Supabase では実質必須。</Term>
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

      <H>カラム</H>
      <Row icon="⚿">鍵クリックで主キー切替</Row>
      <Row icon="N?">クリックで NULL 許可を切替</Row>
      <Row icon="A">型はカラム名の右のプルダウンで変更</Row>
      <Row icon="🗑">ゴミ箱で削除</Row>

      <H>リレーション（FK）</H>
      <Row icon="●">行右端の <b>●</b> をドラッグして相手テーブルに落とすと FK が張れる</Row>
      <Row icon="–">「–」プルダウンから参照先を選んでも同じ</Row>
      <Row icon="→">線は FK カラムから出て、参照先の主キーに矢印で刺さる</Row>

      <H>インデックス</H>
      <Row icon="⌗">カード下の「＋ ⌗ index」→ カラム行をクリックして対象を選ぶ（複数可＝複合）→ インデックス名をクリックで確定</Row>
      <Row icon="U">「U」で unique 切替</Row>

      <H>SQL</H>
      <Row icon="▤">右パネルに常に最新の DDL（FK・index・RLS 込み）。「コピー」でそのまま Supabase 等に貼れる</Row>

          <H>保存とAI連携</H>
          <Row icon="💾">変更は即座に <code style={{ fontSize: 10.5 }}>.drawzu/model.json</code> に保存される</Row>
          <Row icon="🤖">Claude が同じモデルを読み書きする（MCP は Phase 2 で追加予定）。図での手直しは AI の前提にもそのまま反映される</Row>
        </>
      )}
    </div>
  );
}

function TableCard({ t, tables, onDragStart, onLinkStart, edit, dropTarget }: {
  t: Table;
  tables: Table[];
  onDragStart: (e: React.MouseEvent, t: Table) => void;
  onLinkStart: (e: React.MouseEvent, t: Table, c: Column) => void;
  edit: (op: Op) => void;
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
        <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
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
