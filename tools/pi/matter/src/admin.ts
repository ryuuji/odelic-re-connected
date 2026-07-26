/**
 * 管理 API。⭐ `odelic-web`（設定ページ）だけが叩く。
 *
 * ## ⚠️⚠️ localhost 限定
 *
 * **認証は持たない。**`127.0.0.1` にだけ bind し、認証は `odelic-web` 側で済ませる。
 * ⚠️ `host` を `0.0.0.0` にすると、**LAN の誰でも器具名の変更とフェアリングの破棄が
 * できるようになる。**設定でそう書かれていたら拒否して起動を止める。
 *
 * ## なぜブリッジ側に置くのか
 *
 * 器具名・名簿・Matter の状態は**ブリッジが所有者**（docs/08 W1）。
 * 2 つのプロセスが同じファイルを書くと競合するので、書くのは常にブリッジ 1 つにする。
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import type { AdminSettings, Bridge } from "./bridge.js";

export interface AdminServerOptions {
    bridge: Bridge;
    host: string;
    port: number;
    log: (msg: string) => void;
}

/** ⚠️ ここに無いホストには bind しない */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export class AdminServer {
    private server: Server | undefined;
    private actualPort = 0;

    constructor(private readonly opts: AdminServerOptions) {}

    get port(): number {
        return this.actualPort;
    }

    async start(): Promise<void> {
        const { host, port } = this.opts;
        if (!LOOPBACK.has(host)) {
            // ⚠️ 設定ミスで LAN に開いてしまうのを防ぐ。黙って直さず、止めて気づかせる
            throw new Error(
                `管理 API は localhost にしか bind できません（設定: ${host}）。` +
                    "認証を持たないので、LAN に開くと誰でも器具名の変更とフェアリングの破棄ができます",
            );
        }
        const server = createServer((req, res) => {
            void this.handle(req, res).catch(e => {
                this.opts.log(`[!] 管理 API で例外: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
                if (!res.headersSent) json(res, 500, { detail: "内部エラー" });
                else res.end();
            });
        });
        server.on("clientError", (_e, socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, host, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        const addr = server.address();
        this.actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        this.server = server;
        this.opts.log(`管理 API を開始: http://${host}:${this.actualPort}/admin/…（⚠️ localhost 限定・無認証）`);
    }

    async stop(): Promise<void> {
        const s = this.server;
        if (s === undefined) return;
        s.closeAllConnections?.();
        await new Promise<void>(resolve => s.close(() => resolve()));
        this.server = undefined;
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // ⚠️ 二重の安全策。bind を間違えていても loopback 以外は拒否する
        const remote = req.socket.remoteAddress ?? "";
        if (!isLoopbackAddress(remote)) {
            this.opts.log(`[!] 管理 API へ loopback 以外から接続がありました: ${remote}`);
            json(res, 403, { detail: "管理 API は localhost からのみ使えます" });
            return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const method = req.method ?? "GET";
        const bridge = this.opts.bridge;

        if (method === "GET" && path === "/admin/state") {
            json(res, 200, bridge.adminState());
            return;
        }
        if (method === "GET" && path === "/admin/commissioning") {
            json(res, 200, bridge.commissioningInfo());
            return;
        }
        if (method === "GET" && path === "/admin/config") {
            json(res, 200, bridge.adminSettings());
            return;
        }
        if (method === "POST" && path === "/admin/config") {
            const body = await readBody(req);
            const result = bridge.updateSettings(pickSettings(body));
            json(res, result.ok ? 200 : 500, result);
            return;
        }
        if (method === "POST" && path === "/admin/commissioning/open") {
            const body = await readBody(req);
            const seconds = clampInt(body.seconds, 60, 900, 600);
            // ⭐ もう受け付けているなら**失敗ではない**。利用者の目的は達成されている
            if (bridge.commissioningInfo().windowOpen) {
                json(res, 200, {
                    ...bridge.commissioningInfo(),
                    detail: "すでに追加の登録を受け付けています。相手のアプリから追加してください",
                });
                return;
            }
            try {
                await bridge.openCommissioning(seconds);
            } catch (e) {
                // ⚠️ matter.js の英語をそのまま画面に出さない。日本語の前置きを必ず付ける
                const raw = e instanceof Error ? e.message : String(e);
                json(res, 409, { detail: `追加の登録を開始できませんでした: ${raw}` });
                return;
            }
            json(res, 200, {
                ...bridge.commissioningInfo(),
                detail: `これから ${Math.round(seconds / 60)} 分間、追加の登録を受け付けます`,
            });
            return;
        }

        if (method === "POST" && path === "/admin/commissioning/close") {
            // ⭐ もう閉じているなら目的は達成されている。失敗にしない
            if (!bridge.commissioningInfo().windowOpen) {
                json(res, 200, {
                    ...bridge.commissioningInfo(),
                    detail: "追加の登録は受け付けていません",
                });
                return;
            }
            try {
                await bridge.closeCommissioning();
            } catch (e) {
                const raw = e instanceof Error ? e.message : String(e);
                json(res, 409, { detail: `受付を終了できませんでした: ${raw}` });
                return;
            }
            json(res, 200, {
                ...bridge.commissioningInfo(),
                detail: "追加の登録の受け付けを終了しました",
            });
            return;
        }

        const rename = /^\/admin\/fixtures\/([^/]+)\/name$/.exec(path);
        if (method === "POST" && rename !== null) {
            const body = await readBody(req);
            const name = typeof body.name === "string" ? body.name : "";
            const result = await bridge.renameFixture(decodeURIComponent(rename[1]!), name);
            json(res, result.ok ? 200 : 400, result);
            return;
        }

        const removal = /^\/admin\/fixtures\/([^/]+)$/.exec(path);
        if (method === "DELETE" && removal !== null) {
            const result = await bridge.removeFixture(decodeURIComponent(removal[1]!));
            json(res, result.ok ? 200 : 404, result);
            return;
        }

        if (method === "POST" && path === "/admin/restart") {
            const result = bridge.requestRestart();
            // ⚠️ 409 は「今はダメ」であって「壊れた」ではない。UI で区別できるようにする
            json(res, result.ok ? 200 : 409, result);
            return;
        }

        if (method === "POST" && path === "/admin/factory-reset") {
            const body = await readBody(req);
            // ⚠️⚠️ 取り返しがつかない。合言葉を要求する（UI 側でも二段確認する）
            if (body.confirm !== "破棄する") {
                json(res, 400, { detail: "確認のため「破棄する」と入力してください" });
                return;
            }
            const result = await bridge.factoryReset();
            json(res, 200, result);
            return;
        }

        json(res, 404, { detail: "not found" });
    }
}

function isLoopbackAddress(addr: string): boolean {
    const a = addr.replace(/^::ffff:/, "");
    return a === "127.0.0.1" || a === "::1" || a.startsWith("127.");
}

function json(res: ServerResponse, code: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > limit) throw new Error("リクエストが大きすぎます");
        chunks.push(buf);
    }
    if (total === 0) return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** ⚠️ 知らないキーは通さない（設定を壊されないように）。 */
function pickSettings(body: Record<string, unknown>): Partial<AdminSettings> {
    const out: Partial<AdminSettings> = {};
    const numbers = {
        nightBandPercent: [0, 90],
        colorTempMinKelvin: [1000, 10000],
        colorTempMaxKelvin: [1000, 10000],
        statusRefreshSec: [0, 3600],
        waitMs: [0, 10000],
        debounceMs: [0, 2000],
    } as const;
    for (const [key, [lo, hi]] of Object.entries(numbers)) {
        const v = body[key];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        // ⚠️ 範囲外は黙って丸めず捨てる（設定ページ側で弾く。ここは最後の砦）
        if (v < lo || v > hi) continue;
        (out as Record<string, unknown>)[key] = Math.round(v);
    }
    for (const key of ["colorTempInverted", "coalesceAll"] as const) {
        const v = body[key];
        if (typeof v === "boolean") out[key] = v;
    }
    return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(v)));
}
