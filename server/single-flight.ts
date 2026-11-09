/* 「一度成功すれば以後は何もしない」非同期処理を、並行呼び出しでも 1 本に束ねる。
   MCP ブリッジのサーバー自動起動で使う: Claude Code がツールを並列に呼ぶと api() が同時に
   複数走るので、束ねないと同じポート・同じ model.json に向けてサーバーが複数 spawn される。 */
export interface SingleFlight {
  /** 未完了なら fn を 1 回だけ走らせ、進行中なら同じ Promise を返す。完了済みなら即 resolve */
  run(): Promise<void>;
  /** 完了フラグを下ろす（次の run() で fn をもう一度走らせる） */
  reset(): void;
}

export function singleFlight(fn: () => Promise<void>): SingleFlight {
  let done = false;
  let inflight: Promise<void> | null = null;
  return {
    run() {
      if (done) return Promise.resolve();
      if (!inflight) {
        inflight = fn()
          .then(() => {
            done = true;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    reset() {
      done = false;
    },
  };
}
