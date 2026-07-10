# drawzu

**RLS-aware, git-native, model-first database schema design — an ER diagram for humans, MCP for AI agents.** PostgreSQL / Supabase.

**人間が図で見ているDBの姿と、AIがコードを書く時に前提にしているDBの姿を、同じ1個のモデルに揃える**ためのツール。
人間の窓はブラウザのER図ビュー、AIの窓はMCP（`get_model` / `patch_model` / `to_sql`）。
どちらの変更も同じモデルを経由するので、「AIの想定と実際のテーブルがズレる」ことが原理的に起きない。

## 何が違うのか

「AIと人間が同じスキーマを触る」こと自体は、もう drawzu だけのものではない
（ER Flow は MCP 内蔵の商用クラウド、drawdb-mcp / drawio-mcp は既存 GUI への AI リモコン。2026-07 調査時点）。
drawzu が取っている残りの差別化は3つ:

1. **RLS がモデルに載る** — ER図の記法には Row Level Security を描く場所が無く、既存ツールはここを落とす。
   drawzu はポリシー（command / using / with check / 権限ラベル）をモデルの一級市民として持ち、
   カード上の「権限×4動詞」ミニ表・全テーブル横断の権限マップ・`create policy` 込みのDDLに投影する。
2. **モデルが対象リポジトリに住む（git-native）** — 真実の源は `.drawzu/model.json` で、
   コードと同じ git 履歴に乗る。クラウドの向こう側にスキーマを置かない。ローカル常駐1プロセスに
   人間の窓とAIの窓が同居する。
3. **model-first** — 真実の源は図でもSQLでもDSLでもなく `{ tables, columns, constraints, rls, indexes }` の
   構造化モデル。ER図・DDL・権限マップは全部その投影で、編集は必ずモデル経由。
   図が源の GUI-first（drawdb-mcp 等）とも、DSL が源のコードファースト（dbdiagram.io の DBML 等）とも違う。

やらないと決めていること: フルスタックのER図エディタ（drawDB / ChartDB / Azimutt でコモディティ化済み。
ビューは薄いビューア+軽い編集まで）、introspect 専用機能（AI 自身が実DBや migration を読んで
`patch_model` すればよい）。判断の経緯は `docs/adr/` が正。

## できること

- **ER図ビュー**: パン/ズーム、カラム行からドラッグしてFK、複合インデックス、テーブルメモ、
  名詞の洗い出しモーダル（1行1テーブルの一括投入）
- **見やすさ**: ✦ 整列（FKグラフから階層を計算して自動配置）、テーブルにホバーで関連するFK線だけ強調、
  同一テーブルに集中する線の終点分散
- **RLS**: 有効/無効バッジ、カード上の権限×4動詞ミニ表（✓✕）、🛡 権限マップ
  （全テーブル × SELECT/INSERT/UPDATE/DELETE × ポリシーのマトリクス投影）
- **SQL**: 右パネルに常に最新のDDL（FK・index・comment・RLS込み、Postgres方言）。畳める
- **共有**: 📷 HTML保存 — いまの図をそのままの配置で1枚の自己完結HTMLに（SQL同梱）
- **同期**: ブラウザ複数窓・AIの `patch_model`、どこからの変更も全窓へ即反映（WebSocket）

## ディレクトリ

```
drawzu/
├── core/                         心臓部（通信路非依存 / ADR-0003）
│   ├── model.ts                  モデル型定義（Zod）= 真実の源のスキーマ
│   ├── ops.ts                    変更操作。人間の編集もAIのpatchも必ずここを通る
│   ├── hub.ts                    実行時のモデル保持・購読・遅延永続化
│   ├── sql.ts                    モデル→SQL投影（RLS込み）
│   └── store.ts                  永続化の抽象（FileStore: .drawzu/model.json）
├── server/
│   ├── index.ts                  ローカルサーバー（/ws ライブ同期・/api・Webビュー配信）
│   └── mcp.ts                    AIの窓。MCP(stdio)→HTTP API の薄いブリッジ
├── web/                          人間の窓（React。薄いビューア+軽い編集）
│   └── src/
│       ├── App.tsx               ER図ビュー本体
│       ├── layout.ts             カード寸法・FK線経路の計算（画面とエクスポートで共有）
│       └── exportHtml.ts         図→自己完結HTMLの投影
├── docs/adr/                     設計判断の記録（ADR）
│   ├── ADR-0001-...md            真実の源を1個のモデルに置く（model-first）
│   ├── ADR-0002-...md            薄いMCPを自作/ER図エディタ本体は作らない（build-buy）
│   └── ADR-0003-...md            ローカル常駐1プロセスに人間の窓とAIの窓を同居させる
├── tools/
│   └── adr2svg.mjs               ADR.md のフロントマター → 判断の地図SVG（決定的生成）
├── prototype/
│   └── schema-canvas.jsx         図↔SQL リアルタイム同期の動くプロトタイプ（React）
└── out/                          生成物（ADR図SVG など）
```

## 使い方

### ローカルで動かす（Phase 1）

```bash
npm install
npm run build:web   # Webビューをビルド
npm run dev         # サーバー起動 → http://localhost:4989 を開く
```

- 真実の源は起動ディレクトリの `.drawzu/model.json`（無ければ空で作られる）
- 別プロジェクトで使う場合: `DRAWZU_ROOT=/path/to/project npm run dev`
- UI 自体を開発する時は `npm run dev:web` も起動して http://localhost:5173 を開く（/ws と /api は 4989 へ中継される）
- ブラウザを複数窓で開くと、片方の編集がもう片方に即座に映る（AI の patch_model も同じ経路）

### AI から使う（Phase 2 / MCP）

MCP は薄いブリッジ（`server/mcp.ts`）で、起動中の drawzu サーバーの HTTP API に繋ぐ。
モデルを持つのはサーバー側の1プロセスだけなので、Claude が何セッション繋いでも真実の源は1個のまま。

```
Claude Code ←stdio→ server/mcp.ts ←HTTP→ server/index.ts（モデル保持）←WS→ ブラウザ
```

使う側プロジェクトでのセットアップ:

1. drawzu サーバーを対象プロジェクト向けに起動:
   `DRAWZU_ROOT=/path/to/project npm run dev`（drawzu リポジトリで実行。モデルは対象の .drawzu/model.json）
2. 対象プロジェクトに `.mcp.json` を置く:
   ```json
   {
     "mcpServers": {
       "drawzu": {
         "command": "npx",
         "args": ["tsx", "/Users/jemka/Desktop/個人開発/drawzu/server/mcp.ts"]
       }
     }
   }
   ```
3. Claude Code を起動し直すと `get_model` / `patch_model` / `to_sql` が使える。
   「この要件でテーブル設計してモデルに流し込んで」→ 図に現れる。

MCP ツール:

| ツール | 役割 |
|---|---|
| get_model | モデル取得。AIはコードを書く前にこれを読んで前提を揃える |
| patch_model | op の配列で変更。開いているブラウザのER図に即反映 |
| to_sql | モデル→DDL（FK・index・comment・RLS込み） |

### ADR → 図の生成

```bash
cd tools
npm install
node adr2svg.mjs ../docs/adr/ADR-0001-schema-source-of-truth.md > ../out/ADR-0001.svg
```

ADR.md のフロントマター（`axes` / `options[].scores` / `decision` 等）を編集すれば、
同じ入力から同じ図が決定的に再生成される。本文は自由記述のまま、図には影響しない。

### プロトタイプ（図↔SQL）

`prototype/schema-canvas.jsx` は React コンポーネント。裏の1個のモデル(reducer)を
真実の源にして、図の編集がリアルタイムにSQLへ反映される様子を確認できる骨格。

## 進捗と次にやること（ADR-0003 の実装フェーズ）

- ✅ **Phase 1: モデル + ローカルWebビュー** … Zod のモデル型定義（RLS・index・comment 込み）、
  ER図ビュー（パン/ズーム・ドラッグFK・複合index・テーブルメモ・洗い出しモーダル）、
  WebSocket ライブ同期、`.drawzu/model.json` 永続化。
- ✅ **Phase 2: MCP化** … `get_model` / `patch_model` / `to_sql`（stdio ブリッジ `server/mcp.ts`）。
- ✅ **見やすさ・共有** … RLS可視化（権限×4動詞・権限マップ）、✦ 整列、ホバーフォーカス、📷 HTML保存。
- ⬜ **RLS の編集（ADR-0004 候補）** … 表示と有効/無効切替は実装済み。
  ポリシー本文の編集はAI経由の想定だが、op に RLS 専用操作が無く SET_MODEL 頼み（ADD/UPDATE/DELETE_POLICY を足す）。
- ⬜ **実プロジェクトで使ってみる** … AI が migration を読んで `patch_model` する（AI-as-introspector）の実地検証。
- ⬜ **公開準備** … npm の `drawzu` 確保、GitHub description に英語のカテゴリ語
  （model-first / RLS-aware / MCP）を入れて検索導線を作る。
- ⬜ **Phase 3: リモート化（任意）** … 候補は Cloud Run / Fly.io（WebSocket 対応が条件）。

## ADRの運用

- `status: proposed` … これから作る判断
- `status: accepted` … 実装して確定
- `status: superseded` … 後続ADRに置き換えられた（置き換え先IDを本文に明記）
