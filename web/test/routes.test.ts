/**
 * ルーティングと認証の統合テスト。⭐ **BLE も Pi も使わない。**
 *
 * 偽 `odelicd` と偽ブリッジ管理 API を localhost に立て、実際のハンドラを
 * 素の `http.createServer` に載せて叩く（TLS は `tls.test.ts` で別に見る）。
 *
 * ⭐ ここで固定したいのは「通してはいけないものを通さない」こと。
 *
 * 1. **ログインなしで API が使えないこと**
 * 2. **`/ca.crt` だけは認証の外にあること**（信頼の循環を作らない）
 * 3. **CSRF の確認**
 * 4. 段のスライダーが `/level` と `/night` に正しく落ちること
 * 5. ⚠️ **明るさと色温度が必ず 1 通で飛ぶこと**（片方だけ送ると上書きされる）
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Auth } from "../src/auth.js";
import { BridgeClient } from "../src/bridge.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { Journal } from "../src/journal.js";
import { OdelicClient } from "../src/odelicd.js";
import { createHandler } from "../src/routes.js";
import { SetId } from "../src/setid.js";

const PASSWORD = "test-password-1";

// -------------------------------------------------------------- 偽 odelicd

interface StubDevice {
    key: string;
    mac: string;
    product_code: number | null;
    product: string;
    group_id: number | null;
    on: boolean | null;
    bright: number | null;
    color: number | null;
    night: number | null;
}

interface Hit {
    path: string;
    params: Record<string, string>;
}

class StubOdelicd {
    readonly hits: Hit[] = [];
    connected = true;
    joined = true;
    absent = new Set<string>();
    /** 次の操作をこの HTTP ステータスで失敗させる */
    failNextWith: number | null = null;
    devices: StubDevice[] = [];
    private server: Server | undefined;
    private port = 0;

    get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async listen(): Promise<void> {
        this.server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const params: Record<string, string> = {};
            for (const [k, v] of u.searchParams) params[k] = v;
            if (req.method === "POST") {
                this.hits.push({ path: u.pathname, params });
                this.apply(u.pathname, params);
                const code = this.failNextWith;
                this.failNextWith = null;
                if (code !== null) {
                    json(res, code, { ok: false, detail: code === 503 ? "queued" : "timeout", ...this.info() });
                    return;
                }
                json(res, 200, { ok: true, detail: "converged", ...this.info() });
                return;
            }
            if (u.pathname === "/info" || u.pathname === "/") {
                json(res, 200, this.info());
                return;
            }
            if (u.pathname === "/metrics") {
                const delivery: Record<string, { ewma: number; n: number; absent: boolean }> = {};
                for (const d of this.devices) delivery[d.key] = { ewma: 1, n: 10, absent: this.absent.has(d.key) };
                json(res, 200, { delivery, rtt_ms: {}, links: {} });
                return;
            }
            json(res, 404, { error: "not found" });
        });
        await new Promise<void>(r => this.server!.listen(0, "127.0.0.1", r));
        const a = this.server!.address();
        this.port = typeof a === "object" && a !== null ? a.port : 0;
    }

    async close(): Promise<void> {
        await new Promise<void>(r => this.server?.close(() => r()));
    }

    lastHit(path: string): Hit | undefined {
        return [...this.hits].reverse().find(h => h.path === path);
    }

    private apply(path: string, params: Record<string, string>): void {
        const targets = this.resolve(params.target ?? "all");
        for (const d of targets) {
            if (path === "/off") {
                d.on = false;
                d.night = 0;
            } else if (path === "/on") {
                d.on = true;
                d.night = 0;
            } else if (path === "/level") {
                d.on = true;
                d.night = 0;
                d.bright = Number(params.bright);
                d.color = Number(params.color);
            } else if (path === "/night") {
                d.on = false;
                d.night = 3 - Number(params.level);
            }
        }
    }

    private resolve(target: string): StubDevice[] {
        if (target === "all") return this.devices;
        if (target.startsWith("dev:")) {
            const key = target.slice(4).toUpperCase();
            return this.devices.filter(d => d.key.toUpperCase() === key);
        }
        if (target.startsWith("group:")) {
            const g = Number(target.slice(6));
            return this.devices.filter(d => d.group_id === g);
        }
        return [];
    }

    private info(): Record<string, unknown> {
        return {
            connected: this.connected,
            joined: this.joined,
            own_vaddr: "25 00 00 00",
            device_num: this.devices.length,
            devices_found: this.devices.length,
            devices: this.devices.map(d => ({
                ...d,
                vaddr: d.key,
                version: "0x52C0 fw1.7",
                night_on: d.night !== null ? d.night > 0 : null,
                night_level: d.night !== null && d.night > 0 ? 3 - d.night : null,
                state_updated_at: 1,
                last_seen: 1,
            })),
            live_links: this.connected ? ["EC:C5:7F:81:DE:CD"] : [],
            primary_mac: this.connected ? "EC:C5:7F:81:DE:CD" : null,
            link_held_sec: 120,
            queued: 0,
            uptime_sec: 42,
        };
    }
}

// ------------------------------------------------------ 偽ブリッジ管理 API

class StubBridge {
    up = true;
    names = new Map<string, string>();
    lastRename: { mac: string; name: string } | null = null;
    private server: Server | undefined;
    private port = 0;

    get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async listen(): Promise<void> {
        this.server = createServer((req, res) => {
            if (!this.up) {
                res.socket?.destroy();
                return;
            }
            const u = new URL(req.url ?? "/", "http://x");
            if (req.method === "GET" && u.pathname === "/admin/state") {
                json(res, 200, {
                    version: "0.1.0",
                    uptimeSec: 10,
                    odelicdReachable: true,
                    fixtures: [...this.names].map(([mac, name]) => ({
                        mac,
                        name,
                        named: true,
                        product: "PLTCEOC-05",
                        productCode: 0x2b,
                        version: "fw1.7",
                        nightLight: true,
                        deviceType: "colorTemperature",
                        reason: "テスト",
                        reachable: true,
                        inRosterOnly: false,
                        endpointId: `odelic-${mac.replace(/:/g, "").toLowerCase()}`,
                    })),
                    commissioning: {
                        commissioned: true,
                        manualPairingCode: null,
                        qrPairingCode: null,
                        qrText: null,
                        fabrics: [{ index: 1, label: "Google", vendorId: 0x6006 }],
                        windowOpen: false,
                        commissionedAt: null,
                    },
                });
                return;
            }
            const rename = /^\/admin\/fixtures\/([^/]+)\/name$/.exec(u.pathname);
            if (req.method === "POST" && rename !== null) {
                const mac = decodeURIComponent(rename[1]!);
                let body = "";
                req.on("data", c => (body += String(c)));
                req.on("end", () => {
                    const name = (JSON.parse(body) as { name: string }).name;
                    this.names.set(mac, name);
                    this.lastRename = { mac, name };
                    json(res, 200, { mac, name, named: true });
                });
                return;
            }
            json(res, 404, { detail: "not found" });
        });
        await new Promise<void>(r => this.server!.listen(0, "127.0.0.1", r));
        const a = this.server!.address();
        this.port = typeof a === "object" && a !== null ? a.port : 0;
    }

    async close(): Promise<void> {
        await new Promise<void>(r => this.server?.close(() => r()));
    }
}

function json(res: import("node:http").ServerResponse, code: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
}

// ------------------------------------------------------------------ 環境

let dir: string;
let odelicd: StubOdelicd;
let bridge: StubBridge;
let app: Server;
let base: string;
let auth: Auth;
let setIdArgs: string[][];
let setIdReply: { stdout: string; stderr: string; code: number };
let journalArgs: string[][];

before(async () => {
    dir = mkdtempSync(join(tmpdir(), "odelic-web-routes-"));
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), "<h1>照明</h1>", "utf8");
    writeFileSync(join(dir, "public", "login.html"), "<h1>ログイン</h1>", "utf8");
    mkdirSync(join(dir, "public", "css"), { recursive: true });
    writeFileSync(join(dir, "public", "css", "style.css"), "body{}", "utf8");
    mkdirSync(join(dir, "tls"), { recursive: true });
    writeFileSync(join(dir, "tls", "ca.crt"), "-----BEGIN CERTIFICATE-----\nテスト\n", "utf8");

    odelicd = new StubOdelicd();
    bridge = new StubBridge();
    await odelicd.listen();
    await bridge.listen();

    auth = new Auth({ file: join(dir, "auth.json"), sessionMaxAgeSec: 3600 });
    auth.setPassword(PASSWORD);

    setIdArgs = [];
    setIdReply = { stdout: "id=12345678 rollback=yes\n", stderr: "", code: 0 };
    journalArgs = [];

    const handler = createHandler({
        config: { ...DEFAULT_CONFIG, waitMs: 0, stateDir: dir },
        auth,
        odelicd: new OdelicClient({ baseUrl: odelicd.baseUrl, waitMs: 0 }),
        bridge: new BridgeClient(bridge.baseUrl),
        journal: new Journal({
            allowedUnits: DEFAULT_CONFIG.logUnits,
            maxLines: 500,
            run: async args => {
                journalArgs.push(args);
                return {
                    stdout: "2026-07-26T09:00:00 pi odelicd[1]: ID 12345678 → HOMEID D2 04 00 00\n",
                    stderr: "",
                    code: 0,
                };
            },
        }),
        setId: new SetId({
            helper: "/opt/odelic-web/set-id.sh",
            run: async args => {
                setIdArgs.push(args);
                return setIdReply;
            },
        }),
        publicDir: join(dir, "public"),
        caPath: join(dir, "tls", "ca.crt"),
        version: "test",
        log: () => {},
        // ⚠️ 総当たり遅延を潰す（テストが遅くなるだけなので）
        delay: async () => {},
    });

    app = createServer(handler);
    await new Promise<void>(r => app.listen(0, "127.0.0.1", r));
    const a = app.address();
    base = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
});

after(async () => {
    await new Promise<void>(r => app.close(() => r()));
    await odelicd.close();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    odelicd.hits.length = 0;
    odelicd.connected = true;
    odelicd.joined = true;
    odelicd.absent.clear();
    odelicd.failNextWith = null;
    odelicd.devices = [
        {
            key: "09 00 00 00",
            mac: "EC:C5:7F:81:DE:CD",
            product_code: 0x2b,
            product: "PLTCEOC-05",
            group_id: 0,
            on: true,
            bright: 60,
            color: 50,
            night: 0,
        },
        {
            key: "0A 00 00 00",
            mac: "EC:C5:7F:80:28:A6",
            product_code: 0x2b,
            product: "PLTCEOC-05",
            group_id: 1,
            on: true,
            bright: 60,
            color: 50,
            night: 0,
        },
    ];
    bridge.up = true;
    bridge.names.clear();
    auth.destroyAllSessions();
});

// ------------------------------------------------------------- ヘルパ

async function login(): Promise<string> {
    const res = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Odelic-Request": "1" },
        body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.status, 200, await res.text());
    const cookie = res.headers.getSetCookie()[0] ?? "";
    return cookie.split(";")[0]!;
}

async function get(path: string, cookie?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
        redirect: "manual",
        headers: cookie === undefined ? {} : { Cookie: cookie },
    });
}

async function post(path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
            "Content-Type": "application/json",
            "X-Odelic-Request": "1",
            ...(cookie === undefined ? {} : { Cookie: cookie }),
            ...extra,
        },
        body: JSON.stringify(body),
    });
}

// ------------------------------------------------------------------ テスト

describe("⭐ 認証していないとき", () => {
    it("⭐⭐ /api/state が 401（器具の情報が漏れない）", async () => {
        const res = await get("/api/state");
        assert.equal(res.status, 401);
        const body = (await res.json()) as { ok: boolean };
        assert.equal(body.ok, false);
    });

    it("⭐ 操作系も 401（照明を勝手に操作されない）", async () => {
        for (const [path, body] of [
            ["/api/lights/power", { target: "all", on: true }],
            ["/api/lights/rung", { target: "all", rung: 5 }],
            ["/api/lights/color", { target: "all", color: 50 }],
            ["/api/homeid", { id: "12345678" }],
            ["/api/bridge/restart", {}],
        ] as const) {
            const res = await post(path, body);
            assert.equal(res.status, 401, `${path} が ${res.status}`);
        }
        assert.deepEqual(odelicd.hits, [], "odelicd に何か飛んでいる");
    });

    it("⭐ ログ・状態・設定も 401", async () => {
        for (const path of ["/api/logs", "/api/metrics", "/api/health", "/api/homeid", "/api/bridge/state"]) {
            assert.equal((await get(path)).status, 401, path);
        }
    });

    it("画面はログインへリダイレクトする（API と違って HTML を返さない）", async () => {
        const res = await get("/");
        assert.equal(res.status, 302);
        assert.equal(res.headers.get("location"), "/login");
    });

    it("ログイン画面は見られる", async () => {
        const res = await get("/login");
        assert.equal(res.status, 200);
        assert.match(await res.text(), /ログイン/);
    });

    it("静的アセットは見られる（秘密を含まない）", async () => {
        assert.equal((await get("/css/style.css")).status, 200);
    });

    it("⭐⭐ /ca.crt は認証なしで取れる（ここが認証の内側だと信頼の循環になる）", async () => {
        const res = await get("/ca.crt");
        assert.equal(res.status, 200);
        assert.match(await res.text(), /BEGIN CERTIFICATE/);
        // ⭐ これでないと iOS / Android が「証明書」として扱わず、信頼させる導線に入れない
        assert.equal(res.headers.get("content-type"), "application/x-x509-ca-cert");
    });

    it("/api/session は認証状態を答える", async () => {
        const body = (await (await get("/api/session")).json()) as { authenticated: boolean; configured: boolean };
        assert.equal(body.authenticated, false);
        assert.equal(body.configured, true);
    });

    it("⚠️ ディレクトリ抜けができない", async () => {
        for (const p of ["/css/../../../etc/passwd", "/js/%2e%2e%2f%2e%2e%2fauth.json"]) {
            const res = await get(p);
            assert.notEqual(res.status, 200, p);
        }
    });
});

describe("ログイン", () => {
    it("正しいパスワードで通り、クッキーが返る", async () => {
        const res = await post("/api/login", { password: PASSWORD });
        assert.equal(res.status, 200);
        const cookie = res.headers.getSetCookie()[0] ?? "";
        assert.match(cookie, /^odelic_sid=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /Secure/);
        assert.match(cookie, /SameSite=Lax/);
    });

    it("違うパスワードは 401 でクッキーを出さない", async () => {
        const res = await post("/api/login", { password: "ちがう" });
        assert.equal(res.status, 401);
        assert.equal(res.headers.getSetCookie().length, 0);
    });

    it("⭐ 失敗するほど次回の待ち時間が伸びる", async () => {
        const before = auth.penaltyMs("127.0.0.1");
        await post("/api/login", { password: "ちがう" });
        await post("/api/login", { password: "ちがう" });
        assert.ok(auth.penaltyMs("127.0.0.1") > before);
        await post("/api/login", { password: PASSWORD });
        assert.equal(auth.penaltyMs("127.0.0.1"), 0, "成功したら忘れるはず");
    });

    it("ログイン後は画面が見られる", async () => {
        const cookie = await login();
        const res = await get("/", cookie);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /照明/);
    });

    it("ログアウトすると通らなくなる", async () => {
        const cookie = await login();
        assert.equal((await post("/api/logout", {}, cookie)).status, 200);
        assert.equal((await get("/api/state", cookie)).status, 401);
    });
});

describe("⚠️ CSRF の確認", () => {
    it("⭐ X-Odelic-Request が無い POST を拒否する", async () => {
        const cookie = await login();
        const res = await fetch(`${base}/api/lights/power`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ target: "all", on: false }),
        });
        assert.equal(res.status, 403);
        assert.deepEqual(odelicd.hits, []);
    });

    it("⭐ 別オリジンからの POST を拒否する", async () => {
        const cookie = await login();
        // ⚠️ ヘッダ値は ByteString なので ASCII で書く（日本語だと fetch が投げる）
        const res = await post("/api/lights/power", { target: "all", on: false }, cookie, {
            Origin: "https://evil.example",
        });
        assert.equal(res.status, 403);
        assert.deepEqual(odelicd.hits, []);
    });

    it("同一オリジンの Origin は通る", async () => {
        const cookie = await login();
        const host = new URL(base).host;
        const res = await post("/api/lights/power", { target: "all", on: false }, cookie, {
            Origin: `http://${host}`,
        });
        assert.equal(res.status, 200);
    });

    it("GET には要らない", async () => {
        const cookie = await login();
        const res = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
        assert.equal(res.status, 200);
    });
});

describe("/api/state", () => {
    it("器具が段つきで出る", async () => {
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as {
            connected: boolean;
            fixtures: Array<{ mac: string; name: string; rungs: unknown[]; rungIndex: number | null; online: boolean }>;
            allRungs: unknown[];
        };
        assert.equal(s.connected, true);
        assert.equal(s.fixtures.length, 2);
        // ⭐ 常夜灯 3 段 + 主灯 20 段
        assert.equal(s.fixtures[0]!.rungs.length, 23);
        assert.equal(s.allRungs.length, 23);
        // bright=60 は主灯の 12 段目（添字 3 + 11）
        assert.equal(s.fixtures[0]!.rungIndex, 3 + 11);
    });

    it("⭐ ブリッジから器具名を取る", async () => {
        bridge.names.set("EC:C5:7F:81:DE:CD", "ダイニングの照明");
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as {
            fixtures: Array<{ mac: string; name: string; named: boolean }>;
        };
        const f = s.fixtures.find(x => x.mac === "EC:C5:7F:81:DE:CD")!;
        assert.equal(f.name, "ダイニングの照明");
        assert.equal(f.named, true);
    });

    it("⭐⭐ ブリッジが落ちていても器具が出る（単一障害点にしない）", async () => {
        bridge.up = false;
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as {
            fixtures: Array<{ name: string; online: boolean }>;
            bridge: { reachable: boolean };
        };
        assert.equal(s.fixtures.length, 2);
        assert.equal(s.bridge.reachable, false);
        // 名前は MAC 由来の既定名に落ちる
        assert.ok(s.fixtures.every(f => f.name.startsWith("ODELIC ")), JSON.stringify(s.fixtures));
        assert.ok(s.fixtures.every(f => f.online));
    });

    it("⚠️ 通電が切れた器具は online=false・段は不明（P4: 嘘をつかない）", async () => {
        odelicd.absent.add("09 00 00 00");
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as {
            fixtures: Array<{ key: string; online: boolean; absent: boolean; rungIndex: number | null }>;
        };
        const f = s.fixtures.find(x => x.key === "09 00 00 00")!;
        assert.equal(f.absent, true);
        assert.equal(f.online, false);
        assert.equal(f.rungIndex, null);
    });

    it("odelicd に届かなければ理由を出す", async () => {
        const handlerBase = base;
        odelicd.connected = false;
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as { unavailableReason: string | null };
        assert.ok(s.unavailableReason !== null, handlerBase);
    });

    it("⭐ センサーは照明として出さない", async () => {
        odelicd.devices.push({
            key: "0B 00 00 00",
            mac: "EC:C5:7F:00:00:01",
            product_code: 0x1c, // HUMAN_SENSOR
            product: "人感センサー",
            group_id: 0,
            on: null,
            bright: null,
            color: null,
            night: null,
        });
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as { fixtures: Array<{ key: string }> };
        assert.equal(s.fixtures.length, 2);
        assert.ok(!s.fixtures.some(f => f.key === "0B 00 00 00"));
    });

    it("⚠️ MAC 未取得の器具はカードを作らない", async () => {
        odelicd.devices.push({
            key: "0C 00 00 00",
            mac: "00:00:00:00:00:00",
            product_code: 0x2b,
            product: "PLTCEOC-05",
            group_id: 0,
            on: true,
            bright: 60,
            color: 50,
            night: 0,
        });
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as { fixtures: unknown[] };
        assert.equal(s.fixtures.length, 2);
    });
});

describe("照明の操作", () => {
    it("電源は /on と /off になる", async () => {
        const cookie = await login();
        await post("/api/lights/power", { target: "all", on: true }, cookie);
        assert.equal(odelicd.lastHit("/on")?.params.target, "all");
        await post("/api/lights/power", { target: "all", on: false }, cookie);
        assert.equal(odelicd.lastHit("/off")?.params.target, "all");
    });

    it("⭐ 段が主灯なら /level（⚠️ 明るさと色温度が 1 通で飛ぶ）", async () => {
        const cookie = await login();
        // 添字 3 = 主灯 5%、3+11 = 60%
        const res = await post("/api/lights/rung", { target: "dev:09 00 00 00", rung: 3 + 11, color: 40 }, cookie);
        assert.equal(res.status, 200);
        const hit = odelicd.lastHit("/level")!;
        assert.equal(hit.params.bright, "60");
        // ⚠️⚠️ ここが抜けると色温度が意図しない値で上書きされる（docs C18-4 / 07 M5）
        assert.equal(hit.params.color, "40");
        assert.equal(hit.params.target, "dev:09 00 00 00");
    });

    it("⭐ 色温度を省いたら今の値を引き継ぐ", async () => {
        const cookie = await login();
        await post("/api/lights/rung", { target: "dev:09 00 00 00", rung: 3 + 3 }, cookie);
        assert.equal(odelicd.lastHit("/level")?.params.color, "50");
    });

    it("⭐ 段が常夜灯なら /night", async () => {
        const cookie = await login();
        // 添字 0 = 器具値 1 = level 2（最も暗い）
        await post("/api/lights/rung", { target: "all", rung: 0 }, cookie);
        assert.equal(odelicd.lastHit("/night")?.params.level, "2");
        // 添字 2 = 器具値 3 = level 0（最も明るい常夜灯）
        await post("/api/lights/rung", { target: "all", rung: 2 }, cookie);
        assert.equal(odelicd.lastHit("/night")?.params.level, "0");
    });

    it("段 -1 は消灯", async () => {
        const cookie = await login();
        await post("/api/lights/rung", { target: "all", rung: -1 }, cookie);
        assert.equal(odelicd.lastHit("/off")?.params.target, "all");
    });

    it("⚠️ 存在しない段は 400（odelicd に何も飛ばさない）", async () => {
        const cookie = await login();
        const res = await post("/api/lights/rung", { target: "all", rung: 999 }, cookie);
        assert.equal(res.status, 400);
        assert.deepEqual(odelicd.hits, []);
    });

    it("⚠️⚠️ 常夜灯に対応しない器具が混ざると、一斉操作の段から常夜灯が消える", async () => {
        // 0x8A = isOnlyLightness かつ天井灯ではない → nightLight = false
        odelicd.devices[1]!.product_code = 0x8a;
        const cookie = await login();
        const s = (await (await get("/api/state", cookie)).json()) as { allRungs: unknown[] };
        assert.equal(s.allRungs.length, 20, "常夜灯の 3 段が混ざっている");
        // 段 0 は主灯 5% になる
        await post("/api/lights/rung", { target: "all", rung: 0 }, cookie);
        assert.equal(odelicd.lastHit("/night"), undefined, "非対応の器具に /night が飛んだ");
        assert.equal(odelicd.lastHit("/level")?.params.bright, "5");
    });

    it("色温度だけの変更も /level（明るさは今の値）", async () => {
        const cookie = await login();
        await post("/api/lights/color", { target: "dev:09 00 00 00", color: 100 }, cookie);
        const hit = odelicd.lastHit("/level")!;
        assert.equal(hit.params.color, "100");
        assert.equal(hit.params.bright, "60");
    });

    it("⚠️ 消灯中に色温度だけ変えようとしたら断る（勝手に点けない）", async () => {
        for (const d of odelicd.devices) d.on = false;
        const cookie = await login();
        const res = await post("/api/lights/color", { target: "dev:09 00 00 00", color: 100 }, cookie);
        assert.equal(res.status, 409);
        assert.equal(odelicd.lastHit("/level"), undefined);
    });

    it("⚠️ 5 の倍数に丸める（器具はそれ以外を受け付けない）", async () => {
        const cookie = await login();
        await post("/api/lights/color", { target: "dev:09 00 00 00", color: 43 }, cookie);
        assert.equal(odelicd.lastHit("/level")?.params.color, "45");
    });

    it("⭐ odelicd が 503 なら「キューに入った」と正直に返す（P4）", async () => {
        const cookie = await login();
        odelicd.failNextWith = 503;
        const res = await post("/api/lights/power", { target: "all", on: true }, cookie);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { ok: boolean; detail: string };
        assert.equal(body.ok, false);
        assert.match(body.detail, /接続したときに送ります/);
    });

    it("⭐ odelicd が 504 なら「確認できなかった」と返す（成功と言わない）", async () => {
        const cookie = await login();
        odelicd.failNextWith = 504;
        const res = await post("/api/lights/power", { target: "all", on: true }, cookie);
        assert.equal(res.status, 504);
        assert.match(((await res.json()) as { detail: string }).detail, /確認できません/);
    });

    it("⚠️ 妙な target は odelicd に渡さない", async () => {
        const cookie = await login();
        const res = await post("/api/lights/power", { target: "dev:; rm -rf /", on: true }, cookie);
        assert.equal(res.status, 400);
        assert.deepEqual(odelicd.hits, []);
    });

    it("応答に最新の状態が入っている（UI が次のポーリングを待たない）", async () => {
        const cookie = await login();
        const res = await post("/api/lights/rung", { target: "all", rung: 3 + 3, color: 50 }, cookie);
        const body = (await res.json()) as { state: { fixtures: Array<{ rungIndex: number | null }> } };
        assert.equal(body.state.fixtures[0]!.rungIndex, 3 + 3);
    });
});

describe("ログ画面", () => {
    it("⭐⭐ 秘密がマスクされて返る", async () => {
        const cookie = await login();
        const body = (await (await get("/api/logs?lines=10", cookie)).json()) as { ok: boolean; lines: string[] };
        assert.equal(body.ok, true);
        assert.ok(!body.lines.join("\n").includes("12345678"), body.lines.join("\n"));
        assert.ok(body.lines.join("\n").includes("1234••••"));
    });

    it("⚠️ 許可していない unit は拒否する", async () => {
        const cookie = await login();
        journalArgs.length = 0;
        const res = await get("/api/logs?units=ssh", cookie);
        assert.equal(res.status, 400);
        assert.equal(journalArgs.length, 0, "journalctl を叩いてしまっている");
    });

    it("許可されている unit は渡る", async () => {
        const cookie = await login();
        journalArgs.length = 0;
        await get("/api/logs?units=odelicd&lines=5", cookie);
        assert.deepEqual(journalArgs[0]?.slice(-2), ["-u", "odelicd"]);
    });

    it("⚠️ 行数の上限を超えられない（Pi 3 のメモリ）", async () => {
        const cookie = await login();
        journalArgs.length = 0;
        await get("/api/logs?lines=99999", cookie);
        const n = journalArgs[0]![journalArgs[0]!.indexOf("-n") + 1];
        assert.equal(n, "500");
    });
});

describe("HOMEID", () => {
    it("8 桁をそのまま返す（公式アプリにも同じ番号が出ているので伏せない）", async () => {
        const cookie = await login();
        const body = (await (await get("/api/homeid", cookie)).json()) as {
            id: string;
            joined: boolean;
            rollbackAvailable: boolean;
        };
        assert.equal(body.id, "12345678");
        assert.equal(body.joined, true);
        assert.equal(body.rollbackAvailable, true);
    });

    it("⚠️ ヘルパの出力が壊れていたら「未設定」にする（それらしい値を作らない）", async () => {
        const cookie = await login();
        setIdReply = { stdout: "id=none rollback=no\n", stderr: "", code: 0 };
        const body = (await (await get("/api/homeid", cookie)).json()) as {
            id: string;
            configured: boolean;
        };
        assert.equal(body.id, "");
        assert.equal(body.configured, false);
        setIdReply = { stdout: "id=12345678 rollback=yes\n", stderr: "", code: 0 };
    });

    it("⚠️ 8 桁の数字以外はヘルパに渡さない", async () => {
        const cookie = await login();
        setIdArgs.length = 0;
        for (const id of ["1234", "1234567a", "; reboot", "123456789", ""]) {
            const res = await post("/api/homeid", { id }, cookie);
            assert.equal(res.status, 400, id);
        }
        assert.deepEqual(setIdArgs, [], "ヘルパを呼んでしまっている");
    });

    it("8 桁ならヘルパを呼ぶ", async () => {
        const cookie = await login();
        setIdArgs.length = 0;
        const res = await post("/api/homeid", { id: "12345678" }, cookie);
        assert.equal(res.status, 200);
        assert.deepEqual(setIdArgs, [["12345678"]]);
    });

    it("巻き戻しはヘルパの --rollback を呼ぶ（Web が旧値を持たない）", async () => {
        const cookie = await login();
        setIdArgs.length = 0;
        assert.equal((await post("/api/homeid/rollback", {}, cookie)).status, 200);
        assert.deepEqual(setIdArgs, [["--rollback"]]);
    });

    it("⭐ ヘルパが失敗したら成功と言わない", async () => {
        const cookie = await login();
        setIdReply = { stdout: "", stderr: "拒否しました", code: 2 };
        const res = await post("/api/homeid", { id: "12345678" }, cookie);
        assert.equal(res.status, 500);
        setIdReply = { stdout: "id=12345678 rollback=yes\n", stderr: "", code: 0 };
    });
});

describe("ブリッジ管理", () => {
    it("器具名を変更できる", async () => {
        const cookie = await login();
        const res = await post(
            "/api/bridge/fixtures/name",
            { mac: "EC:C5:7F:81:DE:CD", name: "ダイニング" },
            cookie,
        );
        assert.equal(res.status, 200);
        assert.deepEqual(bridge.lastRename, { mac: "EC:C5:7F:81:DE:CD", name: "ダイニング" });
    });

    it("⭐ Google Home の名前は変わらないことを応答で伝える（docs 07 M6）", async () => {
        const cookie = await login();
        const body = (await (
            await post("/api/bridge/fixtures/name", { mac: "EC:C5:7F:81:DE:CD", name: "台所" }, cookie)
        ).json()) as { note: string };
        assert.match(body.note, /Google Home/);
    });

    it("⚠️ 撤去は MAC の入力を確認する（破壊的・uniqueId が失われる）", async () => {
        const cookie = await login();
        const res = await post(
            "/api/bridge/fixtures/remove",
            { mac: "EC:C5:7F:81:DE:CD", confirm: "はい" },
            cookie,
        );
        assert.equal(res.status, 400);
    });

    it("⭐ ブリッジに届かないときは 502（odelicd の失敗と混ぜない）", async () => {
        bridge.up = false;
        const cookie = await login();
        const res = await post("/api/bridge/restart", {}, cookie);
        assert.equal(res.status, 502);
    });
});

describe("パスワードの変更", () => {
    it("⚠️ 現在のパスワードが要る（セッションを盗まれても変えられない）", async () => {
        const cookie = await login();
        const res = await post("/api/password", { current: "ちがう", next: "new-password-1" }, cookie);
        assert.equal(res.status, 403);
        assert.equal(auth.verify(PASSWORD), true);
    });

    it("⚠️ 短いパスワードを拒否する", async () => {
        const cookie = await login();
        const res = await post("/api/password", { current: PASSWORD, next: "みじかい" }, cookie);
        assert.equal(res.status, 400);
    });

    it("⭐ 変更すると全セッションが切れる", async () => {
        const cookie = await login();
        const res = await post("/api/password", { current: PASSWORD, next: "new-password-1" }, cookie);
        assert.equal(res.status, 200);
        assert.equal((await get("/api/state", cookie)).status, 401);
        // 後片付け
        auth.setPassword(PASSWORD);
    });
});
