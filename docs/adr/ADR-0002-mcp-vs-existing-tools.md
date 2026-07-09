---
id: ADR-0002
title: model-first の薄いMCPを自作し、ER図エディタ本体は作らない
status: proposed
date: 2026-07-07
context: >-
  図↔SQLのビジュアルエディタは drawDB/ChartDB/Azimutt 等で既に成熟・コモディティ化。
  一方「ER図エディタ × MCP」は未成熟で、drawDB公式は未対応(Issue #992)、
  コミュニティfork(drawdb-mcp)はGUIをリモコン操作するGUI-first方式。
  どこを作り、どこを借りるかを決める。
axes: [新規性・差別化, 実装コスト, 思想適合, 拡張性]
options:
  - name: GUI+エディタ+MCPをフルスタックで自作
    label: A
    scores: { 新規性・差別化: △, 実装コスト: "✕", 思想適合: ◯, 拡張性: ◯ }
  - name: model-firstの薄いMCPを自作 / GUIは既存OSSを窓として借りる
    label: B
    adopted: true
    scores: { 新規性・差別化: ◎, 実装コスト: ◯, 思想適合: ◎, 拡張性: ◎ }
  - name: 既存の drawdb-mcp fork をそのまま使う
    label: C
    scores: { 新規性・差別化: "✕", 実装コスト: ◎, 思想適合: "✕", 拡張性: △ }
decision_axis: 思想適合
decision: >-
  ビジュアルER図エディタは車輪の再発明になるので作らない。作るのは、ADR-0001の
  モデルを真実の源として保持し、SQL/ER図/TS型/責務マップへ投影し、実DBからintrospectする
  「model-firstの薄いMCPサーバー」。既存のGUI(drawDB等)は必要ならモデルを映す窓として借りる。
consequences:
  - モデルのスキーマ(ADR-0001)がこのMCPの心臓部になる。ここの設計が全て
  - 既存GUIとの接続I/F(モデル⇔DBML/JSON)を1枚用意する必要がある
  - read中心で開始し、write(モデル変更)は段階的に。GUI-firstのfork群とは逆張り
---

## 背景

### 既存調査(2026-07 時点)

- **ビジュアルER↔SQL**: drawDB / ChartDB / Azimutt / dbdiagram.io / DrawSQL / Liam ERD が成熟。
  ドラッグ編集・SQL/DBMLエクスポート・DBからのintrospect・AI生成まで揃う。→ ここは作らない。
- **ER図エディタ × MCP**: 立ち上がり期。drawDB公式は未対応(Issue #992が要望段階)。
  fork `anatoly314/drawdb-mcp` は WebSocket で GUI をフル操作(create/modify)する GUI-first。
  drawio-mcp も同様にブラウザ拡張+WebSocketでキャンバスを双方向操作。
- **共通の限界**: 既存MCPは全て「図(GUI)が真実の源、AIがリモコン」。ブラウザに状態が閉じ、
  RLS等が扱えない。read/write の境界も未決着。

### 差別化の所在

新規性は「図↔SQLの相互変換」には無い(コモディティ)。**「真実の源を1個のモデルに置き、
MCPがそのモデルを保持・投影する model-first 設計」** に有る。これは既存のどのMCPもやっていない。
さらにモデルが源なので、ER図やSQLだけでなく責務マップ・ADR図といった
「引き継ぎ・自己理解向けの投影」まで同じ源から吐ける。

## 決定

作るのは薄いMCPサーバー。役割は4つに限定する。

| 機能 | MCPツール(例) | 担うこと |
|---|---|---|
| モデル保持 | get_model / patch_model | 真実の源(ADR-0001)を読み書き |
| SQL投影 | to_sql | モデル→DDL/migration |
| 図投影 | to_erd / to_map | モデル→ER図・責務マップ(SVG/DBML) |
| 取り込み | introspect | 実DB(Supabase)→モデル |

ER図エディタのGUIそのものは作らない。必要なら drawDB を「モデルを映す窓」として接続する。

## 却下した選択肢

- **A(フルスタック自作)**: 成熟済みのエディタ部分まで作ると実装コストが跳ね上がり、
  差別化に寄与しない部分に労力が向く。
- **C(既存forkをそのまま)**: 最速だが GUI-first で思想が逆。RLS等を扱えず、
  責務マップ等への拡張余地も乏しい。
