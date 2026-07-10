import type { Model, Table } from "../../core/model.ts";
import {
  CARD_W, HEADER_H, ROW_H, IDX_ROW_H, RLS_HEAD_H, RLS_AUD_ROW_H, MEMO_H,
  ink, sub, line, accent, pkColor, rlsColor, CMD_COLOR,
  rlsAudiences, rlsSectionHeight, tableHeight, computeFkEdges,
} from "./layout.ts";

/* いまの図を「そのままの配置」で1枚の自己完結HTMLに投影する。
   画面DOMのコピーではなくモデルから描き直す（画面は input/select だらけで、
   シリアライズしても入力値が残らないため）。座標計算は layout.ts と共通なので配置はズレない */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CMDS = ["select", "insert", "update", "delete"] as const;
const CMD_SHORT: Record<string, string> = { select: "SEL", insert: "INS", update: "UPD", delete: "DEL" };

function cardHtml(t: Table, byId: Record<string, Table>, ox: number, oy: number): string {
  const rows = t.columns.map((c) => {
    const fkName = c.fk && byId[c.fk.tableId] ? byId[c.fk.tableId].name : null;
    return `<div style="height:${ROW_H}px;padding:0 10px;display:flex;align-items:center;gap:5px">
      <span style="opacity:${c.pk ? 1 : 0.18};color:${c.pk ? pkColor : sub};font-size:11px;flex-shrink:0">⚿</span>
      <span style="font-size:12.5px;font-weight:500;color:${ink};white-space:nowrap">${esc(c.name)}</span>
      <span style="font-size:11px;color:${sub};font-family:ui-monospace,monospace">${esc(c.type)}</span>
      ${c.nullable ? `<span style="font-size:9px;font-weight:700;color:#b6bcc7">N?</span>` : ""}
      <span style="flex:1"></span>
      ${fkName ? `<span style="font-size:10px;color:${accent};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:76px">→ ${esc(fkName)}</span>` : ""}
      <span style="width:9px;height:9px;border-radius:999px;flex-shrink:0;border:1.5px solid ${fkName ? accent : "#d4d7dd"};background:${fkName ? accent : "#fff"}"></span>
    </div>`;
  }).join("");

  const memo = t.comment != null
    ? `<div style="height:${MEMO_H}px;overflow:hidden;border-bottom:1px solid ${line};background:#fdf9e8;color:#6b6018;font-size:11px;line-height:1.5;padding:5px 12px;white-space:pre-wrap">${esc(t.comment)}</div>`
    : "";

  const idxRows = t.indexes.map((ix) => {
    const cols = ix.columns.map((cid) => t.columns.find((c) => c.id === cid)?.name).filter(Boolean);
    const name = ix.name ?? `${ix.unique ? "uq" : "idx"}_${t.name}${cols.length ? "_" + cols.join("_") : ""}`;
    return `<div style="height:${IDX_ROW_H}px;padding:0 10px 0 12px;display:flex;align-items:center;gap:5px">
      <span style="color:${sub};font-size:10px">⌗</span>
      <span style="font-size:10.5px;color:${sub};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(name)}</span>
      ${ix.unique ? `<span style="font-size:9px;font-weight:700;color:${accent}">U</span>` : ""}
    </div>`;
  }).join("");
  const idxSection = t.indexes.length ? `<div style="border-top:1px solid ${line};padding:4px 0">${idxRows}</div>` : "";

  let rlsSection = "";
  const rlsH = rlsSectionHeight(t);
  if (rlsH > 0) {
    let inner: string;
    if (!t.rlsEnabled) {
      inner = `<div style="height:100%;display:flex;align-items:center;padding:0 10px"><span style="font-size:9.5px;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 8px;border-radius:4px">RLS無効 — 全行に触れる状態</span></div>`;
    } else if (t.rls.length === 0) {
      inner = `<div style="height:100%;display:flex;align-items:center;padding:0 10px"><span style="font-size:9.5px;font-weight:700;color:#b45309">⚠ ポリシー未定義 — 全アクセス拒否</span></div>`;
    } else {
      const head = `<div style="display:flex;gap:3px;height:${RLS_HEAD_H}px;align-items:center"><span style="width:62px;flex-shrink:0;font-size:8px;font-weight:700;color:${rlsColor}">🛡 権限</span>${CMDS.map((c) =>
        `<span style="flex:1;text-align:center;font-size:8px;font-weight:800;color:${CMD_COLOR[c]}">${CMD_SHORT[c]}</span>`).join("")}</div>`;
      const audRows = rlsAudiences(t).map((aud) =>
        `<div style="display:flex;gap:3px;height:${RLS_AUD_ROW_H}px;align-items:center"><span style="width:62px;flex-shrink:0;font-size:9px;font-weight:700;color:#4b5261;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(aud)}</span>${CMDS.map((c) => {
          const ok = t.rls.some((p) => (p.command === c || p.command === "all") && (p.audience.length > 0 ? p.audience : ["その他"]).includes(aud));
          return `<span style="flex:1;text-align:center;font-size:9.5px;font-weight:800;line-height:15px;border-radius:3px;color:${ok ? CMD_COLOR[c] : "#d4d7dd"};background:${ok ? CMD_COLOR[c] + "12" : "transparent"}">${ok ? "✓" : "✕"}</span>`;
        }).join("")}</div>`).join("");
      inner = `<div style="padding:5px 8px 0">${head}${audRows}</div>`;
    }
    rlsSection = `<div style="border-top:1px solid ${line};height:${rlsH}px;background:${rlsColor}08;overflow:hidden">${inner}</div>`;
  }

  return `<div style="position:absolute;left:${t.x - ox}px;top:${t.y - oy}px;width:${CARD_W}px;background:#fff;border-radius:10px;border:1.5px solid ${line};box-shadow:0 4px 16px rgba(30,35,50,0.08)">
    <div style="height:${HEADER_H}px;padding:0 10px 0 12px;border-bottom:1px solid ${line};border-radius:10px 10px 0 0;background:#fafbfc;display:flex;align-items:center;justify-content:space-between">
      <span style="display:flex;align-items:center;gap:6px;min-width:0"><span style="color:${accent};font-size:12px">▦</span><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span></span>
      ${t.rlsEnabled ? `<span style="font-size:8.5px;font-weight:800;letter-spacing:0.04em;padding:3px 5px;border-radius:5px;background:${rlsColor};color:#fff;flex-shrink:0">RLS</span>` : ""}
    </div>
    ${memo}
    <div style="padding:4px 0">${rows}</div>
    ${idxSection}${rlsSection}
  </div>`;
}

export function buildExportHtml(model: Model, sql: string): string {
  const tables = model.tables;
  const byId = Object.fromEntries(tables.map((t) => [t.id, t]));
  const edges = computeFkEdges(tables);
  const PAD = 60;
  const minX = tables.length ? Math.min(...tables.map((t) => t.x)) : 0;
  const minY = tables.length ? Math.min(...tables.map((t) => t.y)) : 0;
  const maxX = tables.length ? Math.max(...tables.map((t) => t.x + CARD_W)) : 400;
  const maxY = tables.length ? Math.max(...tables.map((t) => t.y + tableHeight(t))) : 200;
  const w = Math.round(maxX - minX + PAD * 2), h = Math.round(maxY - minY + PAD * 2);
  const ox = minX - PAD, oy = minY - PAD;

  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;top:0;left:0">
    <defs><marker id="fk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${accent}" opacity="0.75"/></marker></defs>
    <g transform="translate(${-ox} ${-oy})">
      ${edges.map((e) => `<path d="${e.d}" fill="none" stroke="${accent}" stroke-width="1.6" opacity="0.55" marker-end="url(#fk-arrow)"/><circle cx="${e.x1}" cy="${e.y1}" r="3" fill="${accent}" opacity="0.75"/>`).join("\n      ")}
    </g>
  </svg>`;

  const stamp = new Date().toLocaleString("ja-JP");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>drawzu schema — ${esc(stamp)}</title>
<style>*{box-sizing:border-box;margin:0}body{font-family:'Inter',system-ui,sans-serif;color:${ink};background:#eef0f3}</style>
</head><body>
<div style="padding:14px 20px;display:flex;align-items:baseline;gap:10px">
  <span style="font-weight:700;font-size:15px">drawzu</span>
  <span style="font-size:11px;color:${sub}">スキーマ図のスナップショット · ${esc(stamp)} · テーブル ${tables.length}</span>
</div>
<div style="overflow:auto;padding:0 20px 16px">
  <div style="position:relative;width:${w}px;height:${h}px;background-color:#eef0f3;background-image:radial-gradient(#d4d7dd 1px,transparent 1px);background-size:22px 22px;border:1px solid ${line};border-radius:12px;overflow:hidden">
    ${svg}
    ${tables.map((t) => cardHtml(t, byId, ox, oy)).join("\n    ")}
  </div>
</div>
<details style="margin:0 20px 24px">
  <summary style="cursor:pointer;font-size:12px;color:${sub};font-weight:600">schema.sql（クリックで開く）</summary>
  <pre style="margin-top:8px;background:#1b1f2a;color:#c8cede;font-size:12px;line-height:1.7;padding:14px 16px;border-radius:10px;overflow:auto;font-family:'JetBrains Mono',ui-monospace,monospace">${esc(sql)}</pre>
</details>
</body></html>`;
}
