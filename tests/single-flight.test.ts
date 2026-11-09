import assert from "node:assert/strict";
import { test } from "node:test";
import { singleFlight } from "../server/single-flight.ts";

/* MCP ブリッジのサーバー自動起動を束ねるヘルパーの回帰テスト。
   並列ツール呼び出しで ensureServer が多重に走り、サーバーが二重 spawn された障害の再発防止 */

test("singleFlight: 同時に run() しても fn は 1 回だけ走り、全員が同じ完了を待つ", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const sf = singleFlight(async () => {
    calls++;
    await gate;
  });
  const all = Promise.all([sf.run(), sf.run(), sf.run()]);
  assert.equal(calls, 1);
  release();
  await all;
  assert.equal(calls, 1);
});

test("singleFlight: 成功後の run() は fn を呼ばず即 resolve する", async () => {
  let calls = 0;
  const sf = singleFlight(async () => {
    calls++;
  });
  await sf.run();
  await sf.run();
  assert.equal(calls, 1);
});

test("singleFlight: fn が失敗したら全員に reject が届き、次の run() で再実行される", async () => {
  let calls = 0;
  const sf = singleFlight(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
  });
  const results = await Promise.allSettled([sf.run(), sf.run()]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  await sf.run();
  assert.equal(calls, 2);
});

test("singleFlight: reset() 後は fn をもう一度走らせる（通信失敗後の再起動に相当）", async () => {
  let calls = 0;
  const sf = singleFlight(async () => {
    calls++;
  });
  await sf.run();
  sf.reset();
  await sf.run();
  assert.equal(calls, 2);
});
