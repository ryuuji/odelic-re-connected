/**
 * HTTP の細々したところ。⭐ フレームワークを入れない代わりにここに集める
 * （Pi 3 で軽く、依存を増やさないため。docs/08 W8）。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";

/**
 * 全応答に付けるヘッダ。
 *
 * ⚠️ CSP は `'self'` だけにして**インラインの script / style を一切使わない**。
 * 素の HTML/CSS/JS なので、外部 CDN も要らない。
 *
 * ⚠️ HSTS は**付けない**。自己署名 + ローカル CA で運用しており、CA を入れる前の端末が
 * 恒久的に締め出される（`/ca.crt` を取りに行けなくなる）ほうが害が大きい。
 * 平文で来た場合は 301 で HTTPS に送るので、実害は無い。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
};

export function sendJson(res: ServerResponse, code: number, payload: unknown, extra: Record<string, string | string[]> = {}): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, {
        ...SECURITY_HEADERS,
        // ⚠️ API の応答は絶対にキャッシュさせない（器具の状態は毎回取り直す）
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(body.length),
        ...extra,
    });
    res.end(body);
}

export function sendText(res: ServerResponse, code: number, text: string, contentType = "text/plain; charset=utf-8"): void {
    const body = Buffer.from(text, "utf8");
    res.writeHead(code, {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
        "Content-Type": contentType,
        "Content-Length": String(body.length),
    });
    res.end(body);
}

export function redirect(res: ServerResponse, location: string, code = 302): void {
    res.writeHead(code, { ...SECURITY_HEADERS, Location: location, "Content-Length": "0" });
    res.end();
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    // ⭐ `/ca.crt` はこれでないと、iOS / Android が「証明書」として扱ってくれない
    //    （octet-stream だとただのダウンロードになり、信頼させる導線に入れない）
    ".crt": "application/x-x509-ca-cert",
};

/**
 * `root` の下のファイルを返す。
 *
 * ⚠️ **ディレクトリ抜けを必ず塞ぐ。**`/css/../../etc/shadow` のような相対を
 * 正規化してから `root` の内側にあることを確かめる。
 */
export async function sendStatic(res: ServerResponse, root: string, relPath: string): Promise<boolean> {
    const clean = normalize(decodeURIComponent(relPath)).replace(/^([/\\])+/, "");
    const full = resolve(root, clean);
    const rootResolved = resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return false;

    let size: number;
    try {
        const st = await stat(full);
        if (!st.isFile()) return false;
        size = st.size;
    } catch {
        return false;
    }
    const type = CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
        ...SECURITY_HEADERS,
        // ⚠️ UI を差し替えたときに古いものが残ると原因不明の不具合になる。
        //    家庭内の 1 台なので毎回取り直させる
        "Cache-Control": "no-cache",
        "Content-Type": type,
        "Content-Length": String(size),
    });
    createReadStream(full).pipe(res);
    return true;
}

/** JSON のリクエストボディを読む。⚠️ サイズ上限を必ず持たせる。 */
/**
 * ボディをそのまま Buffer で読む（ZIP のアップロード用）。
 *
 * ⚠️ `limit` を超えたら**読み進めずに例外にする**。Pi 3 のメモリを守る。
 * ⚠️ JSON ではないので `readJsonBody` と分ける（`toString` すると壊れる）。
 */
export async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > limit) throw new Error("リクエストが大きすぎます");
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > limit) throw new Error("リクエストが大きすぎます");
        chunks.push(buf);
    }
    if (total === 0) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("JSON として読めません");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSON オブジェクトを送ってください");
    }
    return parsed as Record<string, unknown>;
}

/**
 * リクエスト元の IP。総当たり対策の集計キーに使う。
 *
 * ⚠️ **`X-Forwarded-For` を信用しない。**この Web は LAN で直接公開しており、
 * 前段にプロキシは居ない。信用すると誰でもキーを詐称して遅延を回避できる。
 */
export function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
}

/**
 * 変更系リクエストの素性を確かめる（CSRF 対策）。
 *
 * ⭐ 2 段構え。
 *
 * 1. `Origin` が付いていれば `Host` と一致すること
 *    （ブラウザは cross-origin の POST に必ず `Origin` を付ける）
 * 2. 独自ヘッダ `X-Odelic-Request` があること
 *    （⭐ HTML フォームや `<img>` からは付けられない。付けようとすると
 *     プリフライトが飛び、それは同一オリジンでなければ通らない）
 *
 * @returns 問題があれば理由、無ければ null
 */
export function checkRequestOrigin(req: IncomingMessage): string | null {
    if (req.headers["x-odelic-request"] === undefined) {
        return "X-Odelic-Request ヘッダがありません";
    }
    const origin = req.headers.origin;
    if (origin === undefined || origin === "null") return null;
    const host = req.headers.host;
    if (host === undefined) return "Host ヘッダがありません";
    let originHost: string;
    try {
        originHost = new URL(origin).host;
    } catch {
        return `Origin を解釈できません: ${origin}`;
    }
    if (originHost !== host) return `Origin (${originHost}) と Host (${host}) が一致しません`;
    return null;
}

/** クエリ文字列から整数を取る。 */
export function queryInt(url: URL, name: string, fallback: number): number {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** 本文から文字列を取る（型が違えば undefined）。 */
export function bodyString(body: Record<string, unknown>, name: string): string | undefined {
    const v = body[name];
    return typeof v === "string" ? v : undefined;
}

/** 本文から数値を取る。 */
export function bodyNumber(body: Record<string, unknown>, name: string): number | undefined {
    const v = body[name];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 本文から真偽値を取る。 */
export function bodyBool(body: Record<string, unknown>, name: string): boolean | undefined {
    const v = body[name];
    return typeof v === "boolean" ? v : undefined;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
