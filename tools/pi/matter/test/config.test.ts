/**
 * 設定の読み込みのテスト。
 *
 * ⭐ 一番大事なのは **`config.example.json` が実際に読めること**。
 * install.sh がこれを雛形として `/etc/odelic-matter/config.json` に置くので、
 * 壊れていると「インストールしたのに起動しない」になる。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_CONFIG,
    colorScaleOf,
    defaultFixtureName,
    isUnknownMac,
    lightScaleOf,
    loadConfig,
    macToEndpointId,
    normalizeMac,
    stripJsonComments,
} from "../src/config.js";

// dist/test/ から見たリポジトリ内の位置
const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "..", "config.example.json");

describe("config.example.json", () => {
    it("⭐ 実際に読める（コメント付き JSON がパースできる）", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(EXAMPLE, m => warnings.push(m));
        assert.deepEqual(warnings, [], `警告が出ている: ${warnings.join(" / ")}`);
        assert.equal(cfg.odelicd, "http://127.0.0.1:8080");
        assert.equal(cfg.nightBandPercent, 30);
        assert.equal(cfg.matter.vendorId, 0xfff1);
        assert.equal(cfg.matter.productId, 0x8001);
    });

    it("statusRefreshSec が壁スイッチ追従の既定になっている", () => {
        const cfg = loadConfig(EXAMPLE, () => {});
        assert.equal(cfg.statusRefreshSec, 30);
        assert.equal(DEFAULT_CONFIG.statusRefreshSec, 30, "コードの既定と設定例をずらさない");
    });

    it("⭐ missingGraceSec の既定は 0（器具を勝手に撤去しない）", () => {
        const cfg = loadConfig(EXAMPLE, () => {});
        assert.equal(cfg.missingGraceSec, 0);
        assert.equal(DEFAULT_CONFIG.missingGraceSec, 0, "コードの既定と設定例をずらさない");
    });

    it("器具の名前が 2 台とも入っている", () => {
        const cfg = loadConfig(EXAMPLE, () => {});
        assert.equal(cfg.fixtures["EC:C5:7F:81:DE:CD"]?.name, "ダイニングの照明");
        assert.equal(cfg.fixtures["EC:C5:7F:80:28:A6"]?.name, "リビングの照明");
    });
});

describe("stripJsonComments", () => {
    it("行コメントとブロックコメントを落とす", () => {
        assert.equal(JSON.parse(stripJsonComments('{"a":1 /* x */, "b":2 // y\n}')).b, 2);
    });

    it("⚠️ 文字列の中の // は消さない", () => {
        const parsed = JSON.parse(stripJsonComments('{"url":"http://127.0.0.1:8080"}')) as { url: string };
        assert.equal(parsed.url, "http://127.0.0.1:8080");
    });

    it("エスケープされた引用符に惑わされない", () => {
        const parsed = JSON.parse(stripJsonComments('{"a":"x\\"// y"}')) as { a: string };
        assert.equal(parsed.a, 'x"// y');
    });
});

describe("MAC の扱い", () => {
    it("区切りの揺れを吸収する", () => {
        for (const s of ["ec:c5:7f:81:de:cd", "EC-C5-7F-81-DE-CD", "ecc57f81decd"]) {
            assert.equal(normalizeMac(s), "EC:C5:7F:81:DE:CD", s);
        }
    });

    it("未取得の MAC を判定する", () => {
        assert.equal(isUnknownMac("00:00:00:00:00:00"), true);
        assert.equal(isUnknownMac("EC:C5:7F:81:DE:CD"), false);
    });

    it("⭐ エンドポイント id は MAC から決まる（再起動しても変わらない）", () => {
        assert.equal(macToEndpointId("EC:C5:7F:81:DE:CD"), "odelic-ecc57f81decd");
        assert.equal(macToEndpointId("ec-c5-7f-81-de-cd"), macToEndpointId("EC:C5:7F:81:DE:CD"));
    });

    it("名前が無い器具にも既定名が付く（設定漏れで器具が消えないため）", () => {
        assert.equal(defaultFixtureName("EC:C5:7F:81:DE:CD"), "ODELIC 81DECD");
    });
});

describe("loadConfig", () => {
    let dir: string;

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "odelic-matter-cfg-"));
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const write = (name: string, body: string): string => {
        const p = join(dir, name);
        writeFileSync(p, body, "utf8");
        return p;
    };

    it("パス未指定なら既定値", () => {
        assert.deepEqual(loadConfig(undefined), { ...DEFAULT_CONFIG });
    });

    it("未知のキーは警告して無視する（書き間違いを黙って捨てない）", () => {
        const warnings: string[] = [];
        loadConfig(write("unknown.json", '{"pollMS": 500}'), m => warnings.push(m));
        assert.ok(
            warnings.some(w => w.includes("pollMS")),
            `警告が出ていない: ${warnings.join(" / ")}`,
        );
    });

    it("型が違えば警告して既定値を使う", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(write("badtype.json", '{"pollMs": "1000"}'), m => warnings.push(m));
        assert.equal(cfg.pollMs, DEFAULT_CONFIG.pollMs);
        assert.ok(warnings.length > 0);
    });

    it("読めないファイルはエラーにする（黙って既定値で動かない）", () => {
        assert.throws(() => loadConfig(join(dir, "ない.json"), () => {}), /設定ファイルを読めません/);
    });

    it("壊れたケルビン値はエラーにする", () => {
        assert.throws(() => loadConfig(write("k.json", '{"colorTempMinKelvin": 0}'), () => {}), /Kelvin/);
    });

    it("deviceType は既知の値だけ受ける", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(
            write("dt.json", '{"fixtures":{"aa:bb:cc:dd:ee:ff":{"deviceType":"rgb"}}}'),
            m => warnings.push(m),
        );
        assert.equal(cfg.fixtures["AA:BB:CC:DD:EE:FF"]?.deviceType, undefined);
        assert.ok(warnings.some(w => w.includes("deviceType")));
    });

    it("fixtures のキーが正規化される", () => {
        const cfg = loadConfig(write("mac.json", '{"fixtures":{"ec-c5-7f-81-de-cd":{"name":"台所"}}}'), () => {});
        assert.equal(cfg.fixtures["EC:C5:7F:81:DE:CD"]?.name, "台所");
    });

    it("scale ヘルパが設定を反映する", () => {
        const cfg = loadConfig(
            write("scale.json", '{"nightBandPercent":25,"colorTempInverted":true}'),
            () => {},
        );
        assert.deepEqual(lightScaleOf(cfg, true), { nightBandPercent: 25, nightLight: true });
        assert.equal(colorScaleOf(cfg).inverted, true);
        assert.equal(lightScaleOf(cfg, false).nightLight, false);
    });
});
