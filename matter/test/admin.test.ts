/**
 * 管理 API の統合テスト。⭐ **BLE も Pi も使わない。**
 *
 * 偽 `odelicd` の上で本物の `Bridge`（matter.js の ServerNode 込み）を起動し、
 * 管理 API を HTTP で叩く。
 *
 * ここで固定したいのは 4 つ。
 *
 * 1. ⚠️⚠️ **localhost 以外に bind できないこと**（無認証なので LAN に出したら終わり）
 * 2. 器具名の変更が**再起動なしで効き、名簿に残る**こと
 * 3. ⚠️ **commissioning 直後の再起動を断ること**（Nest ハブが器具を失う・M6-6）
 * 4. ⚠️ 撤去とフェアリング破棄が**合言葉なしでは動かない**こと
 */

// ⚠️⚠️ これを @matter より先に import する（理由は helpers/storage.ts）
import { cleanupMatterStorage } from "./helpers/storage.js";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { AdminServer } from "../src/admin.js";
import { type AdminState, Bridge, applySavedSettings, settingsPath } from "../src/bridge.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { loadRoster, rosterPath } from "../src/roster.js";

const MAC_A = "EC:C5:7F:81:DE:CD";
const MAC_B = "EC:C5:7F:80:28:A6";

// ------------------------------------------------------------- 偽 odelicd

class TinyOdelicd {
    private server: Server | undefined;
    private port = 0;

    get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async listen(): Promise<void> {
        this.server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (req.method === "POST") {
                json(res, 200, { ok: true, detail: "converged", ...this.info() });
                return;
            }
            if (u.pathname === "/metrics") {
                json(res, 200, { delivery: {} });
                return;
            }
            json(res, 200, this.info());
        });
        await new Promise<void>(r => this.server!.listen(0, "127.0.0.1", r));
        const a = this.server!.address();
        this.port = typeof a === "object" && a !== null ? a.port : 0;
    }

    async close(): Promise<void> {
        await new Promise<void>(r => this.server?.close(() => r()));
    }

    private info(): Record<string, unknown> {
        const dev = (key: string, mac: string, group: number) => ({
            key,
            mac,
            vaddr: key,
            product_code: 0x2b,
            product: "CODE_2B",
            group_id: group,
            version: "fw1.7",
            on: true,
            bright: 60,
            color: 50,
            night_on: false,
            night: 0,
            night_level: null,
            state_updated_at: 1,
            status_raw: null,
            last_seen: 1,
        });
        return {
            connected: true,
            joined: true,
            own_vaddr: "25 00 00 00",
            device_num: 2,
            devices_found: 2,
            devices: [dev("01000000", MAC_A, 0), dev("02000000", MAC_B, 1)],
            live_links: [MAC_A],
            primary_mac: MAC_A,
            queued: 0,
            uptime_sec: 1,
        };
    }
}

function json(res: ServerResponse, code: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`待ってもそうならなかった: ${what}`);
}

// ------------------------------------------------------------------ 環境

describe("管理 API（偽 odelicd・BLE なし）", () => {
    const stub = new TinyOdelicd();
    let bridge: Bridge;
    let admin: AdminServer;
    let storageDir: string;
    let base: string;
    let config: Config;
    let restartCalls = 0;

    before(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "odelic-admin-test-"));
        process.env.MATTER_STORAGE_PATH = storageDir;
        await stub.listen();

        config = {
            ...DEFAULT_CONFIG,
            odelicd: stub.baseUrl,
            pollMs: 50,
            waitMs: 0,
            statusRefreshSec: 0,
            matter: { ...DEFAULT_CONFIG.matter, port: 5601, storagePath: storageDir, discriminator: 3842 },
            admin: { enabled: true, host: "127.0.0.1", port: 0 },
            fixtures: { [MAC_A]: { name: "設定ファイルの名前" } },
        };

        bridge = new Bridge({ config, log: () => {} });
        bridge.onRestartRequest = () => {
            restartCalls++;
        };
        await bridge.start();
        await waitFor("器具 2 台が見える", () => bridge.fixtureOf(MAC_A) !== undefined && bridge.fixtureOf(MAC_B) !== undefined);

        admin = new AdminServer({ bridge, host: "127.0.0.1", port: 0, log: () => {} });
        await admin.start();
        base = `http://127.0.0.1:${admin.port}`;
    });

    after(async () => {
        await admin?.stop();
        await bridge?.stop();
        await stub.close();
        rmSync(storageDir, { recursive: true, force: true });
        cleanupMatterStorage();
    });

    const get = (p: string) => fetch(`${base}${p}`);
    const send = (method: string, p: string, body?: unknown) =>
        fetch(`${base}${p}`, {
            method,
            ...(body === undefined
                ? {}
                : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });

    // ------------------------------------------------------------ 安全性

    it("⚠️⚠️ localhost 以外に bind しようとしたら起動を止める（無認証だから）", async () => {
        const bad = new AdminServer({ bridge, host: "0.0.0.0", port: 0, log: () => {} });
        await assert.rejects(() => bad.start(), /localhost にしか bind できません/);
    });

    it("⚠️ 未知のパスは 404", async () => {
        assert.equal((await get("/admin/なにか")).status, 404);
        assert.equal((await get("/")).status, 404);
    });

    // ---------------------------------------------------------- 状態の取得

    it("器具の一覧が出る", async () => {
        const s = (await (await get("/admin/state")).json()) as AdminState;
        assert.equal(s.fixtures.length, 2);
        const a = s.fixtures.find(f => f.mac === MAC_A)!;
        assert.equal(a.nightLight, true, "0x2B は常夜灯対応");
        assert.equal(a.deviceType, "colorTemperature");
        assert.equal(a.reachable, true);
        assert.equal(a.inRosterOnly, false);
    });

    it("config.json の名前が使われる", async () => {
        const s = (await (await get("/admin/state")).json()) as AdminState;
        assert.equal(s.fixtures.find(f => f.mac === MAC_A)!.name, "設定ファイルの名前");
        assert.equal(s.fixtures.find(f => f.mac === MAC_A)!.named, true);
    });

    it("名前を付けていない器具は MAC からの既定名で、named=false", async () => {
        const s = (await (await get("/admin/state")).json()) as AdminState;
        const b = s.fixtures.find(f => f.mac === MAC_B)!;
        assert.equal(b.name, "ODELIC 8028A6");
        assert.equal(b.named, false);
    });

    it("commissioning の状況が出る（未 commissioning なら QR も）", async () => {
        const c = (await (await get("/admin/commissioning")).json()) as {
            commissioned: boolean;
            manualPairingCode: string | null;
            qrText: string | null;
        };
        assert.equal(c.commissioned, false);
        assert.ok(c.manualPairingCode !== null && /^\d{11}$/.test(c.manualPairingCode), String(c.manualPairingCode));
        // ⭐ matter.js の QrCode が文字ブロックを返す（QR エンコーダを足していない）
        assert.ok(c.qrText !== null && c.qrText.length > 100, `QR が短すぎる: ${c.qrText?.length}`);
    });

    // ------------------------------------------------------------ 器具名

    it("⭐ 器具名を変えると即座に Matter の nodeLabel に反映される（再起動不要）", async () => {
        const res = await send("POST", `/admin/fixtures/${encodeURIComponent(MAC_B)}/name`, { name: "リビング" });
        assert.equal(res.status, 200);
        assert.equal(bridge.fixtureOf(MAC_B)!.name, "リビング");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const label = (bridge.fixtureOf(MAC_B)!.endpoint as any).state.bridgedDeviceBasicInformation.nodeLabel;
        assert.equal(label, "リビング");
    });

    it("⭐ 名前は名簿に残る（再起動しても消えない）", async () => {
        await send("POST", `/admin/fixtures/${encodeURIComponent(MAC_B)}/name`, { name: "リビングの照明" });
        const roster = loadRoster(rosterPath(storageDir));
        assert.equal(roster.fixtures.find(f => f.mac === MAC_B)?.displayName, "リビングの照明");
    });

    it("⭐ 設定ページの名前は config.json より優先される", async () => {
        await send("POST", `/admin/fixtures/${encodeURIComponent(MAC_A)}/name`, { name: "設定ページの名前" });
        const s = (await (await get("/admin/state")).json()) as AdminState;
        assert.equal(s.fixtures.find(f => f.mac === MAC_A)!.name, "設定ページの名前");
    });

    it("⚠️ 空の名前は拒否する", async () => {
        const res = await send("POST", `/admin/fixtures/${encodeURIComponent(MAC_A)}/name`, { name: "   " });
        assert.equal(res.status, 400);
        assert.equal(bridge.fixtureOf(MAC_A)!.name, "設定ページの名前", "名前が壊れている");
    });

    it("⚠️ config.json は書き換えない（コメントを守る）", () => {
        // config オブジェクトの fixtures はそのまま
        assert.equal(config.fixtures[MAC_A]?.name, "設定ファイルの名前");
    });

    // ------------------------------------------------------------ 設定

    it("設定を読める", async () => {
        const s = (await (await get("/admin/config")).json()) as { colorTempMinKelvin: number };
        assert.equal(s.colorTempMinKelvin, 2700);
    });

    it("⭐ 再起動が要る項目は、そう返す（黙って効かないのが一番困る）", async () => {
        const res = await send("POST", "/admin/config", { colorTempMinKelvin: 2200 });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; needsRestart: string[]; detail: string };
        assert.equal(body.ok, true);
        assert.deepEqual(body.needsRestart, ["colorTempMinKelvin"]);
        assert.match(body.detail, /再起動/);
    });

    it("⭐ statusRefreshSec は再起動なしで効く", async () => {
        const body = (await (await send("POST", "/admin/config", { statusRefreshSec: 45 })).json()) as {
            needsRestart: string[];
        };
        assert.deepEqual(body.needsRestart, []);
        assert.equal(config.statusRefreshSec, 45);
        // 後片付け（BLE を使うタイマーを止める）
        await send("POST", "/admin/config", { statusRefreshSec: 0 });
    });

    it("⭐ 設定は別ファイルに保存され、次の起動で config.json に重なる", async () => {
        await send("POST", "/admin/config", { nightBandPercent: 25 });
        const saved = JSON.parse(readFileSync(settingsPath(storageDir), "utf8")) as { nightBandPercent: number };
        assert.equal(saved.nightBandPercent, 25);

        const fresh: Config = { ...DEFAULT_CONFIG, matter: { ...DEFAULT_CONFIG.matter, storagePath: storageDir } };
        const applied = applySavedSettings(fresh);
        assert.equal(fresh.nightBandPercent, 25);
        assert.ok(applied.some(a => a.startsWith("nightBandPercent=")), applied.join(" / "));
    });

    it("⚠️ 範囲外の値は捨てる（設定を壊されない）", async () => {
        const before = config.colorTempMaxKelvin;
        await send("POST", "/admin/config", { colorTempMaxKelvin: 999999 });
        assert.equal(config.colorTempMaxKelvin, before);
    });

    it("⚠️ 知らないキーは通さない", async () => {
        await send("POST", "/admin/config", { odelicd: "http://わるいところ" });
        assert.equal(config.odelicd, stub.baseUrl);
    });

    // ------------------------------------------------------------ 再起動

    it("⭐ 通常時は再起動できる", async () => {
        restartCalls = 0;
        const res = await send("POST", "/admin/restart");
        assert.equal(res.status, 200);
        await new Promise(r => setTimeout(r, 400));
        assert.equal(restartCalls, 1);
    });

    it("⚠️⚠️ commissioning 直後は再起動を断る（Nest ハブが器具を失う・M6-6）", async () => {
        restartCalls = 0;
        // commissioning されたことにする
        (bridge as unknown as { commissionedAt: number }).commissionedAt = Date.now();
        const res = await send("POST", "/admin/restart");
        assert.equal(res.status, 409);
        const body = (await res.json()) as { ok: boolean; detail: string };
        assert.equal(body.ok, false);
        assert.match(body.detail, /見失/);
        await new Promise(r => setTimeout(r, 400));
        assert.equal(restartCalls, 0, "再起動してしまった");
        (bridge as unknown as { commissionedAt: number | null }).commissionedAt = null;
    });

    it("十分に時間が経っていれば再起動できる", async () => {
        restartCalls = 0;
        (bridge as unknown as { commissionedAt: number }).commissionedAt = Date.now() - 30 * 60_000;
        assert.equal((await send("POST", "/admin/restart")).status, 200);
        await new Promise(r => setTimeout(r, 400));
        assert.equal(restartCalls, 1);
        (bridge as unknown as { commissionedAt: number | null }).commissionedAt = null;
    });

    // ------------------------------------------------ 破壊的な操作の入口

    it("⚠️⚠️ フェアリングの破棄は合言葉なしでは動かない", async () => {
        for (const body of [{}, { confirm: "はい" }, { confirm: "yes" }]) {
            const res = await send("POST", "/admin/factory-reset", body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        // 破棄されていないこと
        assert.equal((await (await get("/admin/commissioning")).json() as { commissioned: boolean }).commissioned, false);
    });

    it("⚠️ 名簿に無い器具の撤去は 404", async () => {
        const res = await send("DELETE", "/admin/fixtures/AA:BB:CC:DD:EE:FF");
        assert.equal(res.status, 404);
    });

    it("⚠️ 撤去すると名簿からもエンドポイントからも消える（最後に実行）", async () => {
        const res = await send("DELETE", `/admin/fixtures/${encodeURIComponent(MAC_B)}`);
        assert.equal(res.status, 200);
        assert.equal(bridge.fixtureOf(MAC_B), undefined);
        assert.equal(loadRoster(rosterPath(storageDir)).fixtures.some(f => f.mac === MAC_B), false);
        assert.match(((await res.json()) as { detail: string }).detail, /Google Home/);
    });
});
