/**
 * TLS と ⭐ **1 ポートでのプロトコル判別**のテスト。
 *
 * ⚠️ スマホで `host:8443` と打つとブラウザは `http://` を既定にする。
 * そのまま TLS サーバに渡すと「安全に接続できません」としか出ず、
 * **何が悪いのか分からない**画面になる。ここを固定する。
 *
 * 証明書は openssl で一時的に作る（テスト用の鍵をリポジトリに置かないため）。
 * ⚠️ openssl が無い環境ではこのファイルだけ丸ごと飛ばす。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

import { startListener } from "../src/server.js";

function hasOpenssl(): boolean {
    try {
        execFileSync("openssl", ["version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const AVAILABLE = hasOpenssl();

let dir: string;
let listener: Awaited<ReturnType<typeof startListener>> | undefined;
let port = 0;

before(async () => {
    if (!AVAILABLE) return;
    dir = mkdtempSync(join(tmpdir(), "odelic-web-tls-"));
    const key = join(dir, "test.key");
    const crt = join(dir, "test.crt");
    execFileSync(
        "openssl",
        [
            "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
            "-keyout", key, "-out", crt,
            "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
    );

    listener = await startListener({
        tls: { cert: readFileSync(crt), key: readFileSync(key) },
        handler: (_req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
        },
        // ⚠️ 0 で待ち受けて、実際に割り当てられたポートを使う
        port: 0,
        bind: "127.0.0.1",
        log: () => {},
    });
    port = listener.port;
});

after(async () => {
    await listener?.close();
    if (AVAILABLE) rmSync(dir, { recursive: true, force: true });
});

/** 素の TCP で 1 リクエスト投げて、返ってきた文字列を返す。 */
function rawRequest(p: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(p, "127.0.0.1", () => socket.write(payload));
        let out = "";
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error("タイムアウト"));
        });
        socket.on("data", c => {
            out += c.toString("utf8");
        });
        socket.on("end", () => resolve(out));
        socket.on("close", () => resolve(out));
        socket.on("error", reject);
    });
}

describe("1 ポートでのプロトコル判別", { skip: AVAILABLE ? false : "openssl がありません" }, () => {
    it("⭐ HTTPS でつながる", async () => {
        const res = await fetch(`https://127.0.0.1:${port}/`, {
            // 自己署名なので検証を切る（証明書の中身は gencert.sh 側の責務）
            // @ts-expect-error Node の fetch に dispatcher を渡す代わりに環境変数で切る
            tls: undefined,
        }).catch((e: unknown) => e);
        // Node の fetch は自己署名を拒否する。⭐ ここで見たいのは
        // 「TLS として応答している（HTTP として応答していない）」ことなので、
        // 拒否の理由が証明書であれば合格
        assert.ok(res instanceof Error, "自己署名なのに通ってしまった");
        assert.match(String((res as { cause?: unknown }).cause ?? res), /self[- ]signed|SELF_SIGNED/i);
    });

    it("⭐⭐ 平文 HTTP で来たら 301 で https:// に送る", async () => {
        const out = await rawRequest(port, `GET /settings HTTP/1.1\r\nHost: odelic.local:${port}\r\nConnection: close\r\n\r\n`);
        assert.match(out, /^HTTP\/1\.1 301/, out.slice(0, 200));
        assert.match(out, new RegExp(`Location: https://odelic\\.local:${port}/settings`), out.slice(0, 400));
    });

    it("⭐ リダイレクト先はパスとクエリを保つ", async () => {
        const out = await rawRequest(port, `GET /?tab=logs HTTP/1.1\r\nHost: pi.local:${port}\r\nConnection: close\r\n\r\n`);
        assert.match(out, /Location: https:\/\/pi\.local:\d+\/\?tab=logs/, out.slice(0, 400));
    });

    it("⚠️ 平文の応答をキャッシュさせない（パスワードを平文で送りかねない経路）", async () => {
        const out = await rawRequest(port, `GET / HTTP/1.1\r\nHost: pi.local\r\nConnection: close\r\n\r\n`);
        assert.match(out, /Cache-Control: no-store/, out.slice(0, 400));
    });

    it("⚠️ ごみを送っても落ちない", async () => {
        await rawRequest(port, "これは HTTP でも TLS でもない\r\n\r\n").catch(() => "");
        // 続けて正しいリクエストが通れば、サーバは生きている
        const out = await rawRequest(port, `GET / HTTP/1.1\r\nHost: pi.local\r\nConnection: close\r\n\r\n`);
        assert.match(out, /^HTTP\/1\.1 301/);
    });
});
