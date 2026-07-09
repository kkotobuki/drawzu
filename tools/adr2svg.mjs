// adr2svg.mjs — ADR.md のフロントマターから「判断の地図」SVGを決定的に生成する。
// 実運用では TypeScript で型付けする前提。ここはデモなので最小構成。
//
//   node adr2svg.mjs ADR-002.md > ADR-002.svg
//
import fs from "node:fs";
import { load as yamlLoad } from "js-yaml";

// --- 1. フロントマターを切り出してパース -------------------------------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("フロントマターが見つからへん");
  return yamlLoad(m[1]);
}

// --- 2. スコア記号 → 色（決定的なマッピング）---------------------------
const MARK_COLOR = { "◎": "#2d6a4f", "◯": "#3a8a63", "△": "#b06a4a", "✕": "#c25c4a" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- 3. SVG テンプレート（前に手書きしたやつをデータ駆動に）-----------
function renderSVG(adr) {
  const axes = adr.axes;
  const colX = axes.map((_, i) => 300 + i * ((880 - 300) / axes.length) + ((880 - 300) / axes.length) / 2);
  const rowH = 70, rowY0 = 300;

  const axisHeaders = axes.map((ax, i) =>
    `<text x="${colX[i].toFixed(0)}" y="248" text-anchor="middle" font-size="12.5" fill="#5a5248">${esc(ax)}</text>`
  ).join("\n    ");

  const rows = adr.options.map((opt, r) => {
    const y = rowY0 + r * (rowH + 10);
    const adopted = !!opt.adopted;
    const fill = adopted ? "#e3efe8" : "#f2ede5";
    const stroke = adopted ? ` stroke="#2d6a4f" stroke-width="2"` : "";
    const accent = adopted ? `<rect x="40" y="${y}" width="6" height="${rowH}" rx="3" fill="#2d6a4f"/>` : "";
    const nameColor = adopted ? "#2d6a4f" : "#8a8276";
    const subColor = adopted ? "#4a7a60" : "#9a8f80";
    const cells = axes.map((ax, i) => {
      const mark = opt.scores[ax] ?? "–";
      const c = MARK_COLOR[mark] ?? "#9a8f80";
      return `<text x="${colX[i].toFixed(0)}" y="${y + 42}" text-anchor="middle" font-size="18" fill="${c}">${esc(mark)}</text>`;
    }).join("\n    ");
    return `<rect x="40" y="${y}" width="840" height="${rowH}" rx="8" fill="${fill}"${stroke}/>
    ${accent}
    <text x="60" y="${y + 32}" font-size="15" font-weight="700" fill="${nameColor}">選択肢 ${esc(opt.label)}${adopted ? " ✓" : ""}</text>
    <text x="60" y="${y + 52}" font-size="11.5" fill="${subColor}">${esc(opt.name)}</text>
    ${cells}`;
  }).join("\n  ");

  const conseq = (adr.consequences || []).map((c, i) =>
    `<text x="480" y="${560 + i * 20}" font-size="12.5" fill="#4a4a4a">・${esc(c)}</text>`
  ).join("\n  ");

  return `<svg viewBox="0 0 920 660" xmlns="http://www.w3.org/2000/svg" font-family="'Helvetica Neue', Arial, 'Hiragino Sans', sans-serif">
  <rect width="920" height="660" fill="#faf9f7"/>
  <text x="40" y="48" font-size="13" fill="#9a8f80" letter-spacing="2">${esc(adr.id)} · 設計判断の地図</text>
  <text x="40" y="80" font-size="24" font-weight="700" fill="#2a2a2a">${esc(adr.title)}</text>
  <line x1="40" y1="98" x2="880" y2="98" stroke="#e5ddd2" stroke-width="1.5"/>
  <text x="40" y="128" font-size="13" fill="#7a7266" font-weight="600">CONTEXT</text>
  <text x="40" y="152" font-size="14" fill="#3a3a3a">${esc(adr.context)}</text>
  <text x="40" y="212" font-size="13" fill="#7a7266" font-weight="600">DECISION MATRIX ─ 選択肢 × 評価軸</text>
    ${axisHeaders}
  ${rows}
  <text x="40" y="500" font-size="13" fill="#7a7266" font-weight="600">なぜこの決定か ─ 決め手：${esc(adr.decision_axis)}</text>
  <rect x="40" y="514" width="400" height="118" rx="8" fill="#fff" stroke="#e5ddd2"/>
  <text x="60" y="540" font-size="12.5" fill="#4a4a4a">${esc(adr.decision).slice(0, 34)}</text>
  <text x="60" y="560" font-size="12.5" fill="#4a4a4a">${esc(adr.decision).slice(34, 70)}</text>
  <text x="60" y="580" font-size="12.5" fill="#4a4a4a">${esc(adr.decision).slice(70, 106)}</text>
  <rect x="460" y="514" width="420" height="118" rx="8" fill="#fff" stroke="#e5ddd2"/>
  <text x="480" y="540" font-size="13" fill="#5a5248" font-weight="700">帰結 ─ 引き受けたトレードオフ</text>
  ${conseq}
</svg>`;
}

// --- 4. 実行 -----------------------------------------------------------
const path = process.argv[2];
const raw = fs.readFileSync(path, "utf8");
const adr = parseFrontmatter(raw);
process.stdout.write(renderSVG(adr));
