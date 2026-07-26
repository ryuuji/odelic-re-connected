/**
 * 待ち受け。
 *
 * ## ⭐ 1 つのポートで HTTPS と「平文で来た人のリダイレクト」の両方をやる
 *
 * ⚠️ **スマホで `odelic-re-connected.local:8443` と打つと、ブラウザは `http://` を
 * 既定にする。**そのまま TLS サーバに渡すと handshake が失敗し、
 * 「安全に接続できません」としか出ない。**何が悪いのか分からない**画面になる。
 *
 * → 最初の 1 バイトを覗いて振り分ける。
 *
 * | 先頭バイト | |
 * | --- | --- |
 * | `0x16` | TLS handshake → HTTPS サーバへ |
 * | それ以外（`G` `P` など ASCII） | 平文 HTTP → **301 で https:// へ** |
 *
 * ⭐ ポートを 2 つ使わずに済む。`odelicd` が 8080、ブリッジの管理 API が 8081 を
 * 使っており、80/443 は `CAP_NET_BIND_SERVICE` が要る（権限を増やしたくない）。
 *
 * ⚠️ 1 バイト読むまでソケットを消費してはいけない。`read(1)` → `unshift()` で
 * 巻き戻してから、目的のサーバに `connection` として渡す。
 */

import { type Server as HttpServer, createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Server as HttpsServer, type ServerOptions as HttpsOptions, createServer as createHttpsServer } from "node:https";
import { type Server as NetServer, type Socket, createServer as createNetServer } from "node:net";

import { SECURITY_HEADERS } from "./httputil.js";

/** TLS handshake の先頭バイト（ContentType = handshake(22)）。 */
const TLS_HANDSHAKE = 0x16;

/** ⚠️ 1 バイトも送ってこない接続を溜めない（ポートスキャンで枯渇させられる） */
const SNIFF_TIMEOUT_MS = 10_000;

export interface ListenerOptions {
    tls: HttpsOptions;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    /** リダイレクト先 URL に使う。⚠️ 既定ポートでなければ `:port` を付ける */
    port: number;
    bind: string;
    log: (msg: string) => void;
}

export interface Listener {
    /** 実際に割り当てられたポート（テストで 0 を渡したとき用） */
    readonly port: number;
    close(): Promise<void>;
}

export async function startListener(opts: ListenerOptions): Promise<Listener> {
    const https = createHttpsServer(opts.tls, opts.handler);
    const redirector = createHttpServer((req, res) => redirectToHttps(req, res, opts.port));
    // ⚠️ `opts.port` が 0（自動割り当て）のこともあるので、リダイレクト先は
    //    **実際に接続してきたポート**（`socket.localPort`）を優先する

    // ⚠️ ここでエラーを拾わないと、TLS の握手失敗でプロセスごと落ちる
    https.on("clientError", (err, socket) => {
        opts.log(`[!] TLS クライアントエラー: ${err.message}`);
        socket.destroy();
    });
    https.on("tlsClientError", err => {
        // ⚠️ 「CA を入れていない端末が接続を切った」で日常的に出る。うるさくしない
        if (!/unknown ca|certificate unknown|sslv3 alert|ECONNRESET/i.test(err.message)) {
            opts.log(`[!] TLS ハンドシェイク失敗: ${err.message}`);
        }
    });
    redirector.on("clientError", (_err, socket) => socket.destroy());

    const front = createNetServer(socket => sniff(socket, https, redirector, opts.log));
    front.on("error", err => opts.log(`[!] 待ち受けでエラー: ${err.message}`));

    await new Promise<void>((resolve, reject) => {
        front.once("error", reject);
        front.listen(opts.port, opts.bind, () => {
            front.removeListener("error", reject);
            resolve();
        });
    });

    const addr = front.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;

    return {
        port: actualPort,
        close: () => closeAll(front, https, redirector),
    };
}

/**
 * 先頭 1 バイトで振り分ける。
 *
 * ⚠️ `read(1)` は最初の `readable` でも `null` を返すことがある（まだ届いていない）。
 * その場合は次の `readable` を待つ。
 */
function sniff(socket: Socket, https: HttpsServer, redirector: HttpServer, log: (msg: string) => void): void {
    const timer = setTimeout(() => {
        // 何も送ってこない接続は捨てる
        socket.destroy();
    }, SNIFF_TIMEOUT_MS);

    const onError = (err: Error): void => {
        clearTimeout(timer);
        // ⚠️ ここは日常的に起きる（スキャン・切断）。ログを埋めない
        if (!/ECONNRESET|EPIPE/.test(err.message)) log(`[!] 接続エラー: ${err.message}`);
        socket.destroy();
    };
    socket.on("error", onError);

    const tryRead = (): void => {
        const head = socket.read(1) as Buffer | null;
        if (head === null) {
            socket.once("readable", tryRead);
            return;
        }
        clearTimeout(timer);
        socket.removeListener("error", onError);
        // ⭐ 読んだ 1 バイトを戻してから引き渡す。そうしないと最初の 1 文字が欠ける
        socket.unshift(head);
        const target = head[0] === TLS_HANDSHAKE ? https : redirector;
        target.emit("connection", socket);
    };
    socket.once("readable", tryRead);
}

function redirectToHttps(req: IncomingMessage, res: ServerResponse, configuredPort: number): void {
    // ⚠️ Host にポートが入っていることがある。付け直すので剥がす
    const rawHost = req.headers.host ?? "";
    const host = rawHost.replace(/:\d+$/, "") || "localhost";
    // ⭐ 実際に接続してきたポートが唯一の正。設定値は 0（自動割り当て）のこともある
    const port = req.socket.localPort ?? configuredPort;
    const suffix = port === 443 ? "" : `:${port}`;
    const location = `https://${host}${suffix}${req.url ?? "/"}`;
    res.writeHead(301, {
        ...SECURITY_HEADERS,
        Location: location,
        "Content-Type": "text/plain; charset=utf-8",
        // ⭐ 平文で来たということはパスワードを平文で送りかねない。キャッシュさせない
        "Cache-Control": "no-store",
    });
    res.end(`このページは HTTPS でのみ提供しています。移動してください: ${location}\n`);
}

async function closeAll(front: NetServer, https: HttpsServer, redirector: HttpServer): Promise<void> {
    await new Promise<void>(resolve => front.close(() => resolve()));
    // ⚠️ 個々の接続は front の下にぶら下がっているので、両方閉じないとプロセスが終わらない
    https.closeAllConnections?.();
    redirector.closeAllConnections?.();
    await Promise.all([
        new Promise<void>(resolve => https.close(() => resolve())),
        new Promise<void>(resolve => redirector.close(() => resolve())),
    ]);
}
