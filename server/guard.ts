import type { IncomingMessage } from "node:http";
import { normalize, resolve, sep } from "node:path";

/* ────────────────────────────────────────────────────────────
   ローカルサーバーの境界判定（server/index.ts から分離してテスト可能にした）。
   drawzu は 127.0.0.1 にしか bind しないが、ブラウザ経由の攻撃は
   「同じマシンのブラウザ」から届くので、HTTP 層でも次を弾く:
   - Origin: 許可リスト外のサイトからの状態変更(POST /api/ops, WebSocket)
   - Host:   DNS リバインディング（攻撃者ドメイン→127.0.0.1 解決）で
             同一オリジン扱いにされ、GET /api/model 等を読まれるのを防ぐ
   - 本文サイズ: 無制限読み込みによるメモリ枯渇
   - 静的配信: web/dist の外（兄弟ディレクトリ含む）へ出ない
   ──────────────────────────────────────────────────────────── */

/** ブラウザがローカルサーバーに付けてよい Host のホスト名部分（ポートは問わない） */
export const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 既定の本文上限。SET_MODEL で丸ごと送っても十分な大きさで、無制限ではない値 */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Origin ヘッダが無い(非ブラウザ=同一マシンのクライアント)か、許可リスト内なら OK */
export function originOk(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return !origin || allowed.has(origin);
}

/** Host ヘッダのホスト名が localhost 系なら OK。無い・不正・他ドメインは NG */
export function hostOk(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  // URL は IPv6 を "[::1]" の形で返す
  return LOCAL_HOSTNAMES.has(hostname);
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`リクエスト本文が上限(${limit} bytes)を超えています`);
  }
}

/** 本文を上限付きで読む。超えたら BodyTooLargeError で reject する。
    超過後も残りの本文は読み捨てて接続を生かす（即 destroy すると未読データ付きで socket が
    閉じられ、クライアントは 413 を受け取る前に EPIPE/ECONNRESET になる）。
    読み捨ての時間は server.requestTimeout（既定 300s）で上限が付く */
export function readBodyLimited(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  // Content-Length で事前に分かる超過は読む前に拒否する。残りは Node が応答完了時に読み捨てる
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new BodyTooLargeError(limit));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (buf: Buffer) => {
      if (failed) return; // 超過後は捨てるだけ（メモリに溜めない）
      total += buf.length;
      if (total > limit) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** URL パスを web/dist 内のファイルパスへ解決する。dist の外に出るなら null */
export function resolveStaticFile(webDist: string, urlPath: string): string | null {
  const root = resolve(webDist);
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = normalize(resolve(root, `.${rel}`));
  // 単純な startsWith だと "web/dist" に対して "web/dist-old/..." が通ってしまうので区切り文字まで含めて比べる
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}
