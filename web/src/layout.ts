import type { Table } from "../../core/model.ts";

/* 図のジオメトリ（カード寸法・行の座標・FK線の経路）と配色の単一の置き場。
   画面（App）とHTMLエクスポート（exportHtml）が同じ計算を使うことで、両者の見た目がズレない */

export const CARD_W = 248;
export const HEADER_H = 40;
export const ROW_H = 30;
export const IDX_ROW_H = 24;
/** RLS表示の高さ（警告/無効バッジは固定、権限×動詞の表は権限の行数で決まる） */
export const RLS_STRIP_H = 30;
export const RLS_HEAD_H = 15;
export const RLS_AUD_ROW_H = 17;
/** メモ欄の固定高さ。可変にするとFK線の座標計算がDOM計測依存になるため固定 */
export const MEMO_H = 46;

export const ink = "#232a36", sub = "#6b7280", line = "#e3e5ea", accent = "#4f5bd5", pkColor = "#b7791f";
export const rlsColor = "#7c3aed";
/** RLSポリシーのコマンド別の色（select=青 / insert=緑 / update=橙 / delete=赤 / all=紫） */
export const CMD_COLOR: Record<string, string> = {
  select: "#2563eb", insert: "#059669", update: "#d97706", delete: "#dc2626", all: rlsColor,
};

export function memoHeight(t: Table) {
  return t.comment != null ? MEMO_H : 0;
}
export function idxSectionHeight(t: Table) {
  return t.indexes.length > 0 ? t.indexes.length * IDX_ROW_H + 8 : 0;
}
/** テーブルのポリシーに登場する権限ラベル（表の行）。ラベル未設定のポリシーは「その他」に寄せる */
export function rlsAudiences(t: Table): string[] {
  const seen: string[] = [];
  for (const p of t.rls) {
    for (const a of p.audience.length > 0 ? p.audience : ["その他"]) {
      if (!seen.includes(a)) seen.push(a);
    }
  }
  return seen;
}
export function rlsSectionHeight(t: Table) {
  if (!t.rlsEnabled) return t.rls.length > 0 ? RLS_STRIP_H : 0;
  if (t.rls.length === 0) return RLS_STRIP_H;
  return 10 + RLS_HEAD_H + rlsAudiences(t).length * RLS_AUD_ROW_H;
}
export function tableHeight(t: Table) {
  return HEADER_H + memoHeight(t) + t.columns.length * ROW_H + idxSectionHeight(t) + rlsSectionHeight(t) + 34;
}
/** カラム行の縦中心（キャンバス座標）。FK線の起点/終点に使う */
export function colY(t: Table, columnId: string) {
  const i = t.columns.findIndex((c) => c.id === columnId);
  if (i < 0) return t.y + HEADER_H / 2;
  return t.y + HEADER_H + memoHeight(t) + 4 + i * ROW_H + ROW_H / 2;
}

export type FkEdge = {
  d: string;
  x1: number; y1: number; x2: number; y2: number;
  key: string; tableId: string; columnId: string; toId: string;
};

/** FK線: 起点はカラム行、終点は相手テーブルのPK行（無ければヘッダ）。近い側面から出入りする。
    同じテーブルの同じ側面に複数刺さる時は、終点を縦に少しずつずらして1点に収束させない */
export function computeFkEdges(tables: Table[]): FkEdge[] {
  const byId = Object.fromEntries(tables.map((t) => [t.id, t]));
  const raw = tables.flatMap((t) =>
    t.columns
      .filter((c) => c.fk && byId[c.fk.tableId])
      .map((c) => {
        const to = byId[c.fk!.tableId];
        return { from: t, columnId: c.id, to, toRight: to.x + CARD_W / 2 >= t.x + CARD_W / 2 };
      })
  );
  const anchorGroups = new Map<string, typeof raw>();
  for (const e of raw) {
    const k = `${e.to.id}:${e.toRight ? "L" : "R"}`;
    const g = anchorGroups.get(k);
    if (g) g.push(e);
    else anchorGroups.set(k, [e]);
  }
  // 起点の高さ順にアンカーを割り当てると、同じ側面に入る線同士が交差しない
  for (const g of anchorGroups.values()) g.sort((a, b) => colY(a.from, a.columnId) - colY(b.from, b.columnId));
  return raw.map((e) => {
    const { from, columnId, to, toRight } = e;
    const g = anchorGroups.get(`${to.id}:${toRight ? "L" : "R"}`)!;
    const spread = Math.min(13, (tableHeight(to) - 24) / g.length);
    const off = g.length > 1 ? (g.indexOf(e) - (g.length - 1) / 2) * spread : 0;
    const x1 = toRight ? from.x + CARD_W : from.x;
    const y1 = colY(from, columnId);
    const pk = to.columns.find((c) => c.pk);
    const y2 = (pk ? colY(to, pk.id) : to.y + HEADER_H / 2) + off;
    const x2 = toRight ? to.x : to.x + CARD_W;
    const d1 = toRight ? 60 : -60;
    return { d: `M ${x1} ${y1} C ${x1 + d1} ${y1}, ${x2 - d1} ${y2}, ${x2} ${y2}`,
      x1, y1, x2, y2, key: `${from.id}-${columnId}`, tableId: from.id, columnId, toId: to.id };
  });
}
