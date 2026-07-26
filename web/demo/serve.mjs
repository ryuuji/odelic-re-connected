/**
 * ⭐ 開発機で設定ページを動かす — **スクリーンショット撮影用**。
 *
 *     cd web && npm run build && node demo/serve.mjs
 *     → http://localhost:8080/ をブラウザで開く（パスワードは起動時に表示される）
 *
 * ## なぜ必要か
 *
 * 本番の設定ページは **Pi の上で HTTPS**（ローカル CA + 自己署名）で動き、
 * `odelicd`（BLE）とブリッジが生きていることを前提にする。ドキュメント用の
 * 画面キャプチャを撮るのにその一式を用意するのは重い。
 *
 * → **本物のハンドラと本物の `public/` を、偽の `odelicd` / ブリッジに繋いで立てる。**
 *   照明は実際には点かないが、画面は本物と同一。
 *
 * ## ⚠️ localhost 以外では動かない
 *
 * セッション Cookie には常に `Secure` が付く（`src/auth.ts`。HTTPS でしか
 * 配らない方針）。ブラウザは **`http://localhost` だけは secure context として
 * 扱う**ので Cookie を受け取れるが、LAN の IP やホスト名で開くと
 * **ログインが通らない**。⭐ 必ず `localhost` で開くこと。
 *
 * ## ⚠️ これは開発用。配備物ではない
 *
 * `web/install.sh` は `src` と `test` しか配らないので Pi には行かない。
 * 認証は本物（パスワードは毎回ランダム）だが、**外部に公開しないこと。**
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Auth } from "../dist/src/auth.js";
import { BridgeClient } from "../dist/src/bridge.js";
import { DEFAULT_CONFIG } from "../dist/src/config.js";
import { Journal } from "../dist/src/journal.js";
import { OdelicClient } from "../dist/src/odelicd.js";
import { createHandler } from "../dist/src/routes.js";
import { SetId } from "../dist/src/setid.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const PORT = Number(process.env.PORT ?? 8080);

const NOW = Math.floor(Date.now() / 1000);

/**
 * 画面を見て「作り込まれている」と判るだけの器具を用意する。
 * ⚠️ 形は `odelicd.py` の `Device.to_dict()`（= `src/odelicd.ts` の `OdelicDevice`）に合わせる。
 * ⚠️ MAC は実機の値ではない。
 */
const devices = [
    {
        key: "05000000", mac: "EC:C5:7F:81:DE:CD", vaddr: "05 00 00 00",
        product_code: 21184, product: "PLTCEOC-05", group_id: 1, version: "1.0.9",
        on: true, bright: 60, color: 50,
        night_on: false, night: 0, night_level: null,
        state_updated_at: NOW - 3, last_seen: NOW,
    },
    {
        key: "01000000", mac: "EC:C5:7F:80:28:A6", vaddr: "01 00 00 00",
        product_code: 21184, product: "PLTCEOC-05", group_id: 0, version: "1.0.9",
        on: false, bright: 100, color: 0,
        night_on: false, night: 0, night_level: null,
        state_updated_at: NOW - 11, last_seen: NOW,
    },
];

function json(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    res.end(body);
}

function readBody(req) {
    return new Promise(resolve => {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
        });
    });
}

/** 偽 odelicd。⭐ 操作を受けたら状態を書き換えるので、画面が生きて見える。 */
function startFakeOdelicd() {
    return createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const p = url.pathname;
        const q = Object.fromEntries(url.searchParams);
        // ⚠️ `?target=` の解釈は odelicd と同じにする（画面の対象選択が効かなくなる）
        const hit = () => {
            const t = q.target ?? "all";
            if (t.startsWith("dev:")) return devices.filter(d => d.key === t.slice(4).replace(/ /g, ""));
            if (t.startsWith("group:")) return devices.filter(d => String(d.group_id) === t.slice(6));
            return devices;
        };
        if (p === "/info") {
            return json(res, 200, {
                connected: true,
                joined: true,
                own_vaddr: "25 00 00 00",
                device_num: devices.length,
                devices_found: devices.length,
                devices,
                live_links: [devices[0].mac],
                primary_mac: devices[0].mac,
                link_held_sec: 5311,
                queued: 0,
                uptime_sec: 86_400,
            });
        }
        if (p === "/metrics") {
            return json(res, 200, {
                // ⚠️ delivery の値は数値ではなくオブジェクト（OdelicMetrics）
                delivery: {
                    "05000000": { ewma: 1.0, n: 642, absent: false },
                    "01000000": { ewma: 0.997, n: 642, absent: false },
                },
                rtt_ms: { p50: 57, p90: 78, max: 117, n: 1284 },
                link_life_sec: { p50: 152, max: 5311, disconnects: 0 },
                converge_ms: { p50: 312, p90: 347, n: 96 },
            });
        }
        if (p === "/on" || p === "/off") {
            for (const d of hit()) { d.on = p === "/on"; d.night = 0; d.night_on = false; d.state_updated_at = NOW; }
            return json(res, 200, { ok: true, detail: "converged" });
        }
        if (p === "/level") {
            for (const d of hit()) {
                d.on = true; d.night = 0; d.night_on = false; d.state_updated_at = NOW;
                if (q.bright !== undefined) d.bright = Number(q.bright);
                if (q.color !== undefined) d.color = Number(q.color);
            }
            return json(res, 200, { ok: true, detail: "converged" });
        }
        if (p === "/night") {
            // ⭐ level 0/1/2 → 器具値 3/2/1（逆順）。→ docs/02-protocol.md C24
            const level = Number(q.level ?? 0);
            for (const d of hit()) {
                d.on = true; d.night_on = true; d.night = 3 - level; d.night_level = level;
                d.state_updated_at = NOW;
            }
            return json(res, 200, { ok: true, detail: "converged" });
        }
        if (p === "/status" || p === "/ping" || p === "/discover") return json(res, 200, { ok: true });
        return json(res, 404, { ok: false, detail: `偽 odelicd: 未実装のパス ${p}` });
    });
}

/** 偽ブリッジ管理 API（`/admin/*`）。器具名と Matter の状態を返す。 */
function startFakeBridge() {
    const names = {
        "EC:C5:7F:81:DE:CD": "ダイニングの照明",
        "EC:C5:7F:80:28:A6": "リビングの照明",
    };
    let commissioning = {
        commissioned: true,
        manualPairingCode: "3497-011-2332",
        qrPairingCode: "MT:Y.K9042C00KA0648G00",
        qrText: null,
        open: false,
        fabrics: 1,
    };
    const settings = {
        nightBandPercent: 10,
        colorTempMinKelvin: 2700,
        colorTempMaxKelvin: 6500,
        colorTempInverted: false,
        statusRefreshSec: 0,
        waitMs: 1500,
        debounceMs: 250,
        coalesceAll: true,
    };
    const fixtures = () => devices.map((d, i) => ({
        mac: d.mac,
        name: names[d.mac] ?? d.mac,
        named: names[d.mac] !== undefined,
        product: d.product,
        productCode: d.product_code,
        version: d.version,
        nightLight: true,
        deviceType: "colorTemperatureLight",
        reason: "colorTemperature / 常夜灯あり",
        reachable: true,
        inRosterOnly: false,
        endpointId: String(i + 1),
    }));

    return createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const p = url.pathname;
        const m = req.method ?? "GET";

        if (p === "/admin/state" && m === "GET") {
            return json(res, 200, {
                version: "demo", uptimeSec: 86_400,
                fixtures: fixtures(), commissioning, odelicdReachable: true,
            });
        }
        if (p === "/admin/config" && m === "GET") return json(res, 200, settings);
        if (p === "/admin/config" && m === "POST") {
            Object.assign(settings, await readBody(req));
            return json(res, 200, { needsRestart: [] });
        }
        if (p === "/admin/commissioning" && m === "GET") return json(res, 200, commissioning);
        if (p === "/admin/commissioning/open" && m === "POST") {
            commissioning = { ...commissioning, open: true };
            return json(res, 200, commissioning);
        }
        if (p === "/admin/commissioning/close" && m === "POST") {
            commissioning = { ...commissioning, open: false };
            return json(res, 200, commissioning);
        }
        const rename = /^\/admin\/fixtures\/([^/]+)\/name$/.exec(p);
        if (rename !== null && m === "POST") {
            const { name } = await readBody(req);
            if (typeof name === "string" && name !== "") names[decodeURIComponent(rename[1])] = name;
            return json(res, 200, { ok: true, detail: "名前を変えました" });
        }
        if (/^\/admin\/fixtures\/[^/]+$/.test(p) && m === "DELETE") {
            return json(res, 200, { removed: true });
        }
        // ⚠️ 本物は commissioning 直後に 409 を返す（Nest ハブが器具を失うため）。
        //    デモでは踏めないので 200 のまま
        if (p === "/admin/restart" && m === "POST") return json(res, 200, { restarting: true });
        if (p === "/admin/factory-reset" && m === "POST") {
            return json(res, 409, { ok: false, detail: "デモでは実行しません" });
        }
        return json(res, 404, { ok: false, detail: `偽ブリッジ: 未実装のパス ${m} ${p}` });
    });
}

// -------------------------------------------------------------------- 起動

const stateDir = mkdtempSync(join(tmpdir(), "odelic-web-demo-"));
// ⚠️ /ca.crt は認証の外にあるので、無いと 404 が画面に出る。中身は偽物でよい
mkdirSync(join(stateDir, "tls"), { recursive: true });
writeFileSync(join(stateDir, "tls", "ca.crt"),
    "-----BEGIN CERTIFICATE-----\nこれはデモ用の偽証明書です\n-----END CERTIFICATE-----\n", "utf8");

const fakeOdelicd = startFakeOdelicd();
const fakeBridge = startFakeBridge();
await new Promise(r => fakeOdelicd.listen(0, "127.0.0.1", r));
await new Promise(r => fakeBridge.listen(0, "127.0.0.1", r));
const odelicdUrl = `http://127.0.0.1:${fakeOdelicd.address().port}`;
const bridgeUrl = `http://127.0.0.1:${fakeBridge.address().port}`;

const auth = new Auth({ file: join(stateDir, "auth.json"), sessionMaxAgeSec: 3600 });
// ⚠️ 毎回ランダム。デモでも固定パスワードは置かない
const password = `demo-${Math.random().toString(36).slice(2, 10)}`;
auth.setPassword(password);

const handler = createHandler({
    config: { ...DEFAULT_CONFIG, tlsDir: join(stateDir, "tls"), stateDir, waitMs: 0 },
    auth,
    odelicd: new OdelicClient({ baseUrl: odelicdUrl, waitMs: 0 }),
    bridge: new BridgeClient(bridgeUrl),
    journal: new Journal({
        allowedUnits: DEFAULT_CONFIG.logUnits,
        maxLines: 500,
        // ⭐ マスクが効いていることが画面で判るよう、伏せられるべき値を混ぜてある。
        // ⚠️ 書式は `odelicd.py` の `hexs()`（**空白区切りの 16 進**）に合わせること。
        //    詰めて書くと `src/mask.ts` の規則に当たらず、デモだけ伏せられない絵になる
        run: async () => ({
            stdout: [
                "7月 26 09:00:01 pi odelicd[812]: ID 12345678 → HOMEID D2 04 00 00 / パスワード 35 36 37 38",
                "7月 26 09:00:01 pi odelicd[812]: 鍵を導出: LOGINKEY D2 35 04 36 00 37 00 38 4C 4F 47 49 4E 4B 45 59 / EVENTKEY D2 35 04 36 00 37 00 38 45 56 45 4E 54 4B 45 59",
                "7月 26 09:00:03 pi odelicd[812]: #M adv state=conn why=start",
                "7月 26 09:00:08 pi odelicd[812]: #M link_up mac=EC:C5:7F:81:DE:CD links=1",
                "7月 26 09:00:08 pi odelicd[812]: ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = BD E1 AC C3",
                "7月 26 09:00:09 pi odelicd[812]: #M joined mac=EC:C5:7F:81:DE:CD devices=2 n=1",
                "7月 26 09:00:09 pi odelicd[812]: #M adv state=nonconn why=joined",
                "7月 26 09:00:12 pi odelicd[812]: #M rtt vaddr=05000000 ms=62.3 kind=confirm sends=1",
                "7月 26 09:01:44 pi odelic-matter[901]: 手入力コード : 34970112332",
                "7月 26 09:01:44 pi odelic-matter[901]: QR ペイロード: MT:Y.K9042C00KA0648G00",
                "7月 26 09:02:10 pi odelicd[812]: #M converged intent=9e8fd877 ms=312.1 attempts=1 target=all kind=level",
            ].join("\n") + "\n",
            stderr: "",
            code: 0,
        }),
    }),
    setId: new SetId({
        helper: "/opt/odelic-web/set-id.sh",
        // ⚠️ 実際には呼ばない（root 権限が要る特権操作）。画面の表示だけ本物にする
        run: async () => ({ stdout: "id=12345678 rollback=yes\n", stderr: "", code: 0 }),
    }),
    // ⭐ 本物の public/ を配る。ここが同一でないとキャプチャの意味がない
    publicDir: join(WEB_ROOT, "public"),
    caPath: join(stateDir, "tls", "ca.crt"),
    version: "demo",
    log: msg => console.log(`  [web] ${msg}`),
    // ⚠️ ログイン失敗時の総当たり遅延を潰す（撮影中に待たされないため）
    delay: async () => {},
});

const app = createServer(handler);
app.listen(PORT, "127.0.0.1", () => {
    console.log(`
================================================================
  設定ページ（デモ）— スクリーンショット撮影用
================================================================

  ⭐ http://localhost:${PORT}/

  パスワード: ${password}

  ⚠️ 必ず "localhost" で開いてください。セッション Cookie に Secure が
     付いているので、LAN の IP やホスト名では **ログインが通りません**
     （ブラウザは localhost だけを secure context として扱う）。

  照明は実際には点きません（偽 odelicd）。画面は本物と同一です。
  器具 2 台 / 器具名あり / Matter 登録済み / ログにマスク対象を含む。

  撮影リスト: docs/images/README.md
  止めるとき: Ctrl+C
`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        app.close();
        fakeOdelicd.close();
        fakeBridge.close();
        process.exit(0);
    });
}
