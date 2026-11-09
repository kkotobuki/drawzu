import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { join, sep } from "node:path";
import {
  BodyTooLargeError,
  hostOk,
  originOk,
  readBodyLimited,
  resolveStaticFile,
} from "../server/guard.ts";

const ALLOWED = new Set(["http://localhost:4989", "http://127.0.0.1:4989"]);

test("originOk: Origin 無し(非ブラウザ)と許可リスト内は通し、他サイトは弾く", () => {
  assert.equal(originOk(undefined, ALLOWED), true);
  assert.equal(originOk("http://localhost:4989", ALLOWED), true);
  assert.equal(originOk("http://evil.example", ALLOWED), false);
  assert.equal(originOk("null", ALLOWED), false);
  // 空文字は「Origin 無し」扱い（ブラウザは空文字ではなく "null" を送るので実害なし。仕様の固定）
  assert.equal(originOk("", ALLOWED), true);
  // ポート違い・スキーム違いは別オリジン
  assert.equal(originOk("http://localhost:4990", ALLOWED), false);
  assert.equal(originOk("https://localhost:4989", ALLOWED), false);
});

test("hostOk: localhost / 127.0.0.1 / [::1] はポートを問わず通す", () => {
  assert.equal(hostOk("localhost:4989"), true);
  assert.equal(hostOk("127.0.0.1:43117"), true);
  assert.equal(hostOk("[::1]:4989"), true);
  assert.equal(hostOk("localhost"), true);
});

test("hostOk: loopback の別表記は通す（仕様の固定。ブラウザは接続先が loopback の時だけこれらを送る）", () => {
  assert.equal(hostOk("LOCALHOST:4989"), true);
  assert.equal(hostOk("127.1"), true);
  assert.equal(hostOk("0x7f000001"), true);
});

test("hostOk: DNS リバインディング相当の Host・不正な Host は弾く", () => {
  assert.equal(hostOk("attacker.example:4989"), false);
  assert.equal(hostOk("localhost.attacker.example"), false);
  assert.equal(hostOk("127.0.0.1.nip.io"), false);
  assert.equal(hostOk(undefined), false);
  assert.equal(hostOk(""), false);
  assert.equal(hostOk("bad host"), false);
});

function reqOf(body: string | Buffer, contentLength?: number) {
  const r = Readable.from([Buffer.from(body)]) as unknown as import("node:http").IncomingMessage;
  (r as any).headers = contentLength == null ? {} : { "content-length": String(contentLength) };
  return r;
}

test("readBodyLimited: 上限以内はそのまま返す", async () => {
  assert.equal(await readBodyLimited(reqOf('{"ops":[]}'), 1024), '{"ops":[]}');
});

test("readBodyLimited: Content-Length が上限超なら読む前に拒否する", async () => {
  await assert.rejects(readBodyLimited(reqOf("x", 2048), 1024), BodyTooLargeError);
});

test("readBodyLimited: 実際の本文が上限超なら途中で拒否する", async () => {
  await assert.rejects(readBodyLimited(reqOf("a".repeat(2000)), 1024), BodyTooLargeError);
});

test("resolveStaticFile: dist 内のパスはそのまま、/ は index.html", () => {
  const dist = join(sep, "srv", "web", "dist");
  assert.equal(resolveStaticFile(dist, "/"), join(dist, "index.html"));
  assert.equal(resolveStaticFile(dist, "/assets/app.js"), join(dist, "assets", "app.js"));
});

test("resolveStaticFile: .. で dist の外へ出る要求は null", () => {
  const dist = join(sep, "srv", "web", "dist");
  assert.equal(resolveStaticFile(dist, "/../index.ts"), null);
  assert.equal(resolveStaticFile(dist, "/a/../../secret"), null);
});

test("resolveStaticFile: 接頭辞が同じ兄弟ディレクトリ(dist-old 等)へも出られない", () => {
  const dist = join(sep, "srv", "web", "dist");
  assert.equal(resolveStaticFile(dist, "/../dist-old/index.html"), null);
  assert.equal(resolveStaticFile(dist, "/../dist2/x"), null);
});
