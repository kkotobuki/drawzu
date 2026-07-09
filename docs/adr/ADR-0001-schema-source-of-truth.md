---
id: ADR-0001
title: スキーマの真実の源を「1個のモデル」に置く
status: proposed
date: 2026-07-07
context: >-
  Figmaや従来のER図ツールでは、図を編集してもスキーマ(テキスト)に反映されず、
  リアルタイムに同期しない。図を真実の源にすると型・制約・RLS・indexなど
  「図に描けない情報」が毎回落ち、二重管理に戻る。真実の源をどこに置くかを決める。
axes: [リアルタイム同期, 情報の完全性, AIからの操作性, single-source適合]
options:
  - name: 図(GUI)を真実の源にする / AIがGUIをリモコン操作
    label: A
    scores: { リアルタイム同期: ◯, 情報の完全性: "✕", AIからの操作性: △, single-source適合: "✕" }
  - name: 1個のモデルを真実の源にし、図もSQLも投影にする
    label: B
    adopted: true
    scores: { リアルタイム同期: ◎, 情報の完全性: ◎, AIからの操作性: ◎, single-source適合: ◎ }
  - name: SQL/migrationを真実の源にし、図は出力のみ
    label: C
    scores: { リアルタイム同期: △, 情報の完全性: ◎, AIからの操作性: ◯, single-source適合: ◯ }
decision_axis: single-source適合
decision: >-
  真実の源を構造化された1個のモデルに置く。ER図・SQL・TS型・責務マップは
  すべてそのモデルへの投影とする。どのビューを編集してもモデルを経由するので、
  2つの真実を同期させる必要がなく、コンフリクトが原理的に起きない。
consequences:
  - モデルのスキーマ定義(型・制約・RLS等を保持)を先に固める必要がある
  - 逆方向(GUIやSQLでの編集→モデル)はパーサを1枚噛ませて集約する
  - RLS/index/check/default等、図に載らない情報もモデルには全て持たせる
---

## 背景

ER図ツール(drawDB / ChartDB / Azimutt 等)はドラッグ編集→SQL生成まで成熟している。
しかし各ツールが持つのは「図とSQLの相互変換」であり、真実の源が図側かSQL側かで
情報の欠落と同期ズレが起きる。特にSupabase運用では RLS ポリシーが設計の中核だが、
これは ER 図に載らない。図を源にする限り、この情報は毎回どこか別で管理され、
「どこが正か分からない」状態に戻る。

## 決定

真実の源は「図」でも「SQL」でもなく、その裏にある **1個の構造化モデル** に置く。

```
          Schema Model (source of truth)
          { tables, columns, constraints, rls, indexes }
           ↑編集        ↑編集         ↑投影      ↑投影
        ER図(GUI)     SQL/DBML      TS型      責務マップ
```

図もSQLも「モデルを映す窓」に格下げする。編集は必ずモデルを経由するため、
別々の真実を同期させる問題そのものが消える。これは既存の customer-base /
録画パイプラインで採った single source of truth の設計判断(ADR-録画取り込み)と同型。

## 却下した選択肢

- **A(図を源 / GUIリモコン)**: 既存の drawdb-mcp・drawio-mcp が採るGUI-first方式。
  リアルタイム性はあるが、状態がブラウザに閉じ、RLS等が扱えず、思想と逆行する。
- **C(SQLを源)**: 情報は完全だが、ビジュアル編集がリアルタイムに戻りにくく、
  「図を触ってスキーマが出る」という当初の体験要求を満たしにくい。
