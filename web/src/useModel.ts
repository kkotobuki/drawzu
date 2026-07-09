import { useCallback, useEffect, useRef, useState } from "react";
import type { Model } from "../../core/model.ts";
import { applyOp, type Op } from "../../core/ops.ts";

/* ────────────────────────────────────────────────────────────
   サーバー上のモデルとのライブ同期。
   - 自分の編集: 楽観適用（即座に画面反映）→ op をサーバーへ送信
   - 他の窓（AIの patch_model や別タブ）の編集: サーバーからの全量で置換
   自分の op はサーバーから ack だけが返る（全量エコーが返らない）ので、
   ドラッグ中に自分の画面が巻き戻ることはない。
   ──────────────────────────────────────────────────────────── */

export function useModel() {
  const [model, setModel] = useState<Model | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "model") setModel(msg.model);
        if (msg.type === "error") console.error("[drawzu]", msg.message);
      };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!disposed) retry = setTimeout(connect, 1000);
      };
    };
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const act = useCallback((op: Op) => {
    setModel((m) => (m ? applyOp(m, op) : m));
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(op));
  }, []);

  return { model, act, connected };
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
