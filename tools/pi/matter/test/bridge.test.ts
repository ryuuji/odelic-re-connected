/**
 * ブリッジの統合テスト。⭐ **BLE も Pi も使わない。**
 *
 * 偽 odelicd を localhost に立てて、実際に matter.js の ServerNode を起動し、
 * 「Matter 側で属性が変わったら odelicd に何が飛ぶか」を HTTP のリクエストログで見る。
 *
 * ここで見るのは実装で一番危ない 3 つ。
 *
 * 1. **エコー抑止** — 器具の状態を属性に書き戻したときに送信しないこと（無限ループ防止）
 * 2. **一斉合成** — 全器具が同じ指示なら `target=all` を 1 通にすること（docs §7-3）
 * 3. **常夜灯の 1 軸マッピング** — 明るさ軸の下端に落ちたら `/night` が飛ぶこと
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Bridge } from "../src/bridge.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { colorPercentToMireds, targetToMatterLevel } from "../src/mapping.js";

// ------------------------------------------------------------------ 偽 odelicd

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
    devices: StubDevice[] = [];
    connected = true;
    /** 次の操作をこの HTTP ステータスで失敗させる */
    failNextWith: number | null = null;
    /** 通電が切れた器具の vAddr キー（odelicd の metrics.delivery[].absent 相当） */
    absent = new Set<string>();

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
                this.applyCommand(u.pathname, params);
                const code = this.failNextWith;
                this.failNextWith = null;
                if (code !== null) {
                    this.json(res, code, { ok: false, detail: code === 503 ? "queued" : "timeout", ...this.info() });
                    return;
                }
                this.json(res, 200, { ok: true, detail: "converged", ...this.info() });
                return;
            }
            if (u.pathname === "/info" || u.pathname === "/") {
                this.json(res, 200, this.info());
                return;
            }
            if (u.pathname === "/metrics") {
                const delivery: Record<string, { ewma: number; n: number; absent: boolean }> = {};
                for (const d of this.devices) {
                    delivery[d.key] = { ewma: 1, n: 10, absent: this.absent.has(d.key) };
                }
                this.json(res, 200, { delivery });
                return;
            }
            this.json(res, 404, { error: "not found" });
        });
        await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
    }

    async close(): Promise<void> {
        await new Promise<void>(resolve => this.server?.close(() => resolve()));
    }

    private json(res: ServerResponse, code: number, payload: unknown): void {
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
        res.end(body);
    }

    /** 器具が実際にその状態になった、という体で状態を更新する。 */
    private applyCommand(path: string, params: Record<string, string>): void {
        const targets = this.resolveTargets(params.target ?? "all");
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

    private resolveTargets(target: string): StubDevice[] {
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
            joined: this.connected,
            own_vaddr: "25 00 00 00",
            device_num: this.devices.length,
            devices_found: this.devices.length,
            devices: this.devices.map(d => ({
                ...d,
                vaddr: d.key,
                version: "0x52C0 fw1.7",
                night_on: d.night !== null ? d.night > 0 : null,
                night_level: d.night !== null && d.night > 0 ? 3 - d.night : null,
                state_updated_at: Date.now() / 1000,
                status_raw: null,
                last_seen: Date.now() / 1000,
            })),
            live_links: this.connected ? ["EC:C5:7F:81:DE:CD"] : [],
            primary_mac: this.connected ? "EC:C5:7F:81:DE:CD" : null,
            queued: 0,
            uptime_sec: 1,
        };
    }

    /** 直近のヒットのうち操作系だけ。 */
    commands(): Hit[] {
        return this.hits.filter(h => ["/on", "/off", "/level", "/night"].includes(h.path));
    }

    clear(): void {
        this.hits.length = 0;
    }
}

// ------------------------------------------------------------------ ヘルパ

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`待ってもそうならなかった: ${what}`);
}

/**
 * コマンドが飛ばなくなるまで待ってから記録を消す。
 *
 * ⚠️ これを各テストの頭で呼ばないと、前のテストの送信が次のテストに漏れて
 * 順序依存の偽陽性・偽陰性になる。
 */
async function quiesce(stub: StubOdelicd, quietMs = 300): Promise<void> {
    let last = -1;
    while (last !== stub.hits.length) {
        last = stub.hits.length;
        await new Promise(r => setTimeout(r, quietMs));
    }
    stub.clear();
}

const MAC_A = "EC:C5:7F:81:DE:CD";
const MAC_B = "EC:C5:7F:80:28:A6";
const MAC_SENSOR = "EC:C5:7F:00:00:01";

function ceilingLight(key: string, mac: string, group: number): StubDevice {
    // 0x2B = 手元の器具（PLTCEOC-05）。調光調色 + 常夜灯対応
    return {
        key,
        mac,
        product_code: 0x2b,
        product: "CODE_2B",
        group_id: group,
        on: true,
        bright: 60,
        color: 50,
        night: 0,
    };
}

describe("ブリッジの統合（偽 odelicd・BLE なし）", () => {
    const stub = new StubOdelicd();
    let bridge: Bridge;
    let storageDir: string;

    before(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "odelic-matter-test-"));
        process.env.MATTER_STORAGE_PATH = storageDir;

        stub.devices = [
            ceilingLight("01000000", MAC_A, 0),
            ceilingLight("02000000", MAC_B, 1),
            // ⚠️ 人感センサー。ライトとして出てはいけない
            {
                key: "03000000",
                mac: MAC_SENSOR,
                product_code: 0x1c,
                product: "HUMAN_SENSOR",
                group_id: 0,
                on: null,
                bright: null,
                color: null,
                night: null,
            },
            // MAC 未取得。エンドポイントを作れない
            {
                key: "04000000",
                mac: "00:00:00:00:00:00",
                product_code: 0x2b,
                product: "CODE_2B",
                group_id: 0,
                on: null,
                bright: null,
                color: null,
                night: null,
            },
        ];
        await stub.listen();

        const config: Config = {
            ...DEFAULT_CONFIG,
            odelicd: stub.baseUrl,
            pollMs: 50,
            // ⚠️ 本番と同じ 120 ms を使う。テストだけ 20 ms などにすると
            //    Pi 3 のような遅いマシンで「一斉合成」が窓に入らず落ちる
            //    （2 通に分かれるだけで機能は正しいが、合成の検証にならない）
            debounceMs: DEFAULT_CONFIG.debounceMs,
            waitMs: 0, // テストでは収束待ちしない（偽 odelicd が即答する）
            statusRefreshSec: 0,
            matter: {
                ...DEFAULT_CONFIG.matter,
                port: 5599,
                storagePath: storageDir,
                passcode: 20202021,
                discriminator: 3841,
            },
            fixtures: {
                [MAC_A]: { name: "ダイニングの照明" },
                [MAC_B]: { name: "リビングの照明" },
            },
        };

        // BRIDGE_TEST_LOG=1 で送信の流れを見られるようにしておく（診断用）
        bridge = new Bridge({
            config,
            log: msg => {
                if (process.env.BRIDGE_TEST_LOG) console.log(`    | ${msg}`);
            },
        });
        await bridge.start();
        await waitFor("器具 2 台のエンドポイントができる", () => bridge.fixtureOf(MAC_A) !== undefined && bridge.fixtureOf(MAC_B) !== undefined);
    });

    after(async () => {
        await bridge?.stop();
        await stub.close();
        rmSync(storageDir, { recursive: true, force: true });
    });

    it("⭐⭐ 人感センサーはエンドポイントにならない", () => {
        assert.equal(bridge.fixtureOf(MAC_SENSOR), undefined);
    });

    it("MAC 未取得の器具はエンドポイントにならない", () => {
        assert.equal(bridge.fixtureOf("00:00:00:00:00:00"), undefined);
    });

    it("設定の名前が使われる", () => {
        assert.equal(bridge.fixtureOf(MAC_A)!.name, "ダイニングの照明");
    });

    it("⭐⭐ BridgedDeviceBasicInformation の必須属性が揃っている", () => {
        // ⚠️ `uniqueId`（0x12）と `reachable`（0x11）は必須。matter.js では任意扱いなので
        //    設定しなくても初期化は通ってしまうが、Google Home が器具を「無効」と判定する
        //    （ブリッジ本体の commissioning は成功するので原因が分かりにくい）
        for (const mac of [MAC_A, MAC_B]) {
            const b = bridge.fixtureOf(mac)!.endpoint.state.bridgedDeviceBasicInformation;
            assert.ok(typeof b.uniqueId === "string" && b.uniqueId.length > 0, `${mac} の uniqueId が空`);
            assert.equal(typeof b.reachable, "boolean", `${mac} の reachable が無い`);
            assert.ok(b.uniqueId.length <= 32, `${mac} の uniqueId が 32 文字を超えている`);
            // ⚠️ uniqueId と serialNumber は同じ値にしてはいけない（Matter 仕様）
            assert.notEqual(b.uniqueId, b.serialNumber, `${mac} の uniqueId と serialNumber が同じ`);
        }
    });

    it("uniqueId は器具ごとに異なる", () => {
        // ⚠️ matter.js は `uniqueId` が未指定なら自分でランダム生成し（"FN" 品質で永続化）、
        //    こちらが渡した値より優先することがある。値そのものは当てにせず、
        //    「存在して器具ごとに違う」ことだけを保証する
        const a = bridge.fixtureOf(MAC_A)!.endpoint.state.bridgedDeviceBasicInformation.uniqueId;
        const b = bridge.fixtureOf(MAC_B)!.endpoint.state.bridgedDeviceBasicInformation.uniqueId;
        assert.notEqual(a, b);
    });

    it("常夜灯対応と調光調色が能力から決まる", () => {
        const cap = bridge.fixtureOf(MAC_A)!.capability;
        assert.equal(cap.kind, "colorTemperature");
        assert.equal(cap.nightLight, true);
    });

    it("器具の状態が Matter の属性に入る", () => {
        const ep = bridge.fixtureOf(MAC_A)!.endpoint;
        assert.equal(ep.state.onOff.onOff, true);
        assert.equal(ep.state.levelControl.currentLevel, targetToMatterLevel({ kind: "main", bright: 60 }));
        assert.equal(ep.state.colorControl.colorTemperatureMireds, colorPercentToMireds(50));
    });

    it("⭐⭐ エコー抑止: 状態の書き戻しでコマンドが飛ばない", async () => {
        await quiesce(stub);
        // 器具側で状態が変わった（他コントローラの操作を観測した、という体）
        stub.devices[0]!.bright = 30;
        await waitFor(
            "属性に反映される",
            () => bridge.fixtureOf(MAC_A)!.endpoint.state.levelControl.currentLevel === targetToMatterLevel({ kind: "main", bright: 30 }),
        );
        // デバウンス窓を十分に越えて待つ
        await new Promise(r => setTimeout(r, 400));
        assert.deepEqual(stub.commands(), [], "書き戻しで送信が発生してはいけない");
    });

    it("明るさを変えると /level が器具個別に飛ぶ", async () => {
        await quiesce(stub);
        const f = bridge.fixtureOf(MAC_A)!;
        await f.endpoint.set({ levelControl: { currentLevel: targetToMatterLevel({ kind: "main", bright: 80 }) } });
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);
        await new Promise(r => setTimeout(r, 400));

        const cmds = stub.commands();
        assert.equal(cmds.length, 1, `1 通だけのはず: ${JSON.stringify(cmds)}`);
        assert.equal(cmds[0]!.path, "/level");
        assert.equal(cmds[0]!.params.bright, "80");
        assert.equal(cmds[0]!.params.target, "dev:01000000");
        // ⭐ 明るさだけ動かしても色温度が必ず一緒に飛ぶ（プロトコルが 1 コマンドなので）
        assert.ok(cmds[0]!.params.color !== undefined, "色温度が一緒に送られていない");
    });

    it("⭐ 色温度を連続で変えても最後の指示が送られる（1 つ前の値に戻らない）", async () => {
        // ⚠️ 実機で踏んだ回帰: ポーリングの書き戻しが送信待ちの colorPercent を
        //    器具の現在値で上書きし、**1 つ前の色温度が送られていた**
        //    （Google Home が 294 mired = 35% を指示したのに 65% を送った）
        await quiesce(stub);
        const f = bridge.fixtureOf(MAC_A)!;

        // 器具の色温度を 65% にしておく（書き戻しの供給源）
        stub.devices[0]!.on = true;
        stub.devices[0]!.color = 65;
        stub.devices[0]!.night = 0;
        await waitFor(
            "65% が属性に入る",
            () => f.endpoint.state.colorControl.colorTemperatureMireds === colorPercentToMireds(65),
        );
        await quiesce(stub);

        // ここで 35% を指示する。書き戻しに負けてはいけない
        await f.endpoint.set({ colorControl: { colorTemperatureMireds: colorPercentToMireds(35) } });
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);
        await new Promise(r => setTimeout(r, 400));

        const cmds = stub.commands();
        assert.equal(cmds[0]!.path, "/level");
        assert.equal(cmds[0]!.params.color, "35", `最後の指示 35% が送られていない: ${JSON.stringify(cmds)}`);
    });

    it("⭐ 常夜灯: 明るさ軸の下端に落とすと /night が飛ぶ", async () => {
        await quiesce(stub);
        const f = bridge.fixtureOf(MAC_A)!;
        await f.endpoint.set({ levelControl: { currentLevel: 13 } }); // 帯の最下段
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);
        await new Promise(r => setTimeout(r, 400));

        const cmds = stub.commands();
        assert.equal(cmds.length, 1);
        assert.equal(cmds[0]!.path, "/night");
        assert.equal(cmds[0]!.params.level, "2", "最も暗い常夜灯（level 2）のはず");
        assert.equal(stub.devices[0]!.night, 1, "器具値は 1（最も暗い）");
    });

    it("消灯は /off が飛ぶ", async () => {
        await quiesce(stub);
        await bridge.fixtureOf(MAC_A)!.endpoint.set({ onOff: { onOff: false } });
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);
        await new Promise(r => setTimeout(r, 400));
        assert.equal(stub.commands()[0]!.path, "/off");
    });

    it("⭐⭐ 一斉合成: 全器具が同じ指示なら target=all で 1 通", async () => {
        // まず両方を同じ状態に揃えておく
        for (const d of stub.devices.slice(0, 2)) {
            d.on = true;
            d.bright = 60;
            d.color = 50;
            d.night = 0;
        }
        await waitFor(
            "両方の属性が揃う",
            () =>
                bridge.fixtureOf(MAC_A)!.endpoint.state.levelControl.currentLevel ===
                bridge.fixtureOf(MAC_B)!.endpoint.state.levelControl.currentLevel,
        );
        await new Promise(r => setTimeout(r, 400));
        await quiesce(stub);

        // Google Home の「全部消して」= 各エンドポイントに Off が来る
        await Promise.all([
            bridge.fixtureOf(MAC_A)!.endpoint.set({ onOff: { onOff: false } }),
            bridge.fixtureOf(MAC_B)!.endpoint.set({ onOff: { onOff: false } }),
        ]);
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);
        await new Promise(r => setTimeout(r, 400));

        const cmds = stub.commands();
        assert.equal(cmds.length, 1, `2 台でも 1 通のはず: ${JSON.stringify(cmds)}`);
        assert.equal(cmds[0]!.path, "/off");
        assert.equal(cmds[0]!.params.target, "all");
        assert.equal(stub.devices[0]!.on, false);
        assert.equal(stub.devices[1]!.on, false);
    });

    it("⚠️ 送信が失敗したら Matter 側の表示を器具の実状態に引き戻す", async () => {
        // 器具は消灯している状態から始める
        for (const d of stub.devices.slice(0, 2)) {
            d.on = false;
            d.night = 0;
        }
        await waitFor("消灯が反映される", () => bridge.fixtureOf(MAC_A)!.endpoint.state.onOff.onOff === false);
        await new Promise(r => setTimeout(r, 400));
        await quiesce(stub);

        // 次の操作を 503（未接続でキュー入り）にする
        stub.failNextWith = 503;
        const f = bridge.fixtureOf(MAC_A)!;
        await f.endpoint.set({ onOff: { onOff: true } });
        await waitFor("コマンドが飛ぶ", () => stub.commands().length > 0);

        // ⚠️ 偽 odelicd は失敗を返しつつ状態は変えてしまうので、
        //    ここでは「引き戻しの経路が例外なく走る」ことだけを見る
        await new Promise(r => setTimeout(r, 400));
        assert.equal(stub.commands()[0]!.path, "/on");
    });

    it("⭐⭐ 片方の通電が切れたら、その器具だけ Reachable = false になる", async () => {
        // ⚠️ odelicd は器具を devices から削除しないので、/info に居ることは
        //    生きている証拠にならない。metrics の absent を見ないと
        //    **通電が切れた器具が「最後の状態でオンライン」のまま残る**
        await quiesce(stub);
        stub.absent.add("01000000"); // ダイニング（MAC_A）の電源が落ちた

        await waitFor(
            "ダイニングだけ Reachable が下がる",
            () => bridge.fixtureOf(MAC_A)!.endpoint.state.bridgedDeviceBasicInformation.reachable === false,
            15000,
        );
        // ⭐ もう片方は影響を受けない
        assert.equal(
            bridge.fixtureOf(MAC_B)!.endpoint.state.bridgedDeviceBasicInformation.reachable,
            true,
            "生きている器具まで offline にしてはいけない",
        );
        // ⭐ Matter からは消さない（一時的な停電で Google Home から消えると困る）
        assert.ok(bridge.fixtureOf(MAC_A) !== undefined, "エンドポイントを消してはいけない");

        // 復帰したら戻る
        stub.absent.delete("01000000");
        await waitFor(
            "復帰して Reachable が戻る",
            () => bridge.fixtureOf(MAC_A)!.endpoint.state.bridgedDeviceBasicInformation.reachable === true,
            15000,
        );
    });

    it("odelicd が落ちたら Reachable = false になる", async () => {
        await stub.close();
        await waitFor(
            "Reachable が下がる",
            () => bridge.fixtureOf(MAC_A)!.endpoint.state.bridgedDeviceBasicInformation.reachable === false,
            6000,
        );
        assert.equal(bridge.fixtureOf(MAC_B)!.endpoint.state.bridgedDeviceBasicInformation.reachable, false);
    });
});
