/**
 * capability.ts のテスト。
 *
 * 一番大事なのは**センサーをライトとして出さないこと**。ここが漏れると
 * Google Home の「全部消して」がセンサーに照明コマンドを投げる。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityOf, hasSideRgb, hasSideSpot, isCeilingLight, isInterface, isOnlyLightness, } from "../src/capability.js";
describe("isCeilingLight（UtilDeviceFW からの転記）", () => {
    it("⭐ 手元の器具 0x2B（PLTCEOC-05）は天井灯", () => {
        assert.equal(isCeilingLight(0x2b), true);
    });
    it("LED_CEILING_MAT_* (0x04〜0x0A) は天井灯", () => {
        for (let c = 0x04; c <= 0x0a; c++)
            assert.equal(isCeilingLight(c), true, `0x${c.toString(16)}`);
    });
    it("docs の一覧から漏れていたグループも天井灯", () => {
        // 0x40〜0x43 / 0x4B〜0x53 / 0x63〜0x66 / 0x78〜0x7D
        for (const c of [0x40, 0x43, 0x4b, 0x53, 0x63, 0x66, 0x78, 0x7d]) {
            assert.equal(isCeilingLight(c), true, `0x${c.toString(16)}`);
        }
    });
    it("単独比較のコードも天井灯", () => {
        for (const c of [0x25, 0x26, 0x60, 0x6b, 0x6d, 0x6e, 0x71, 0x75, 0x76, 0x80]) {
            assert.equal(isCeilingLight(c), true, `0x${c.toString(16)}`);
        }
    });
    it("ライン・チューブ系は天井灯ではない", () => {
        for (const c of [0x01, 0x02, 0x03, 0x12, 0x13, 0x14, 0x15]) {
            assert.equal(isCeilingLight(c), false, `0x${c.toString(16)}`);
        }
    });
});
describe("その他の述語", () => {
    it("isOnlyLightness は 0x8A と 0x91 だけ", () => {
        assert.equal(isOnlyLightness(0x8a), true);
        assert.equal(isOnlyLightness(0x91), true);
        assert.equal(isOnlyLightness(0x2b), false);
        assert.equal(isOnlyLightness(0x10), false);
    });
    it("isInterface は 0x1D と 0x88", () => {
        assert.equal(isInterface(0x1d), true);
        assert.equal(isInterface(0x88), true);
        assert.equal(isInterface(0x2b), false);
    });
    it("サイド RGB / スポットの製品コード", () => {
        for (const c of [0x18, 0x19, 0x56, 0x57])
            assert.equal(hasSideRgb(c), true, `0x${c.toString(16)}`);
        for (const c of [0x16, 0x17, 0x54, 0x55])
            assert.equal(hasSideSpot(c), true, `0x${c.toString(16)}`);
        assert.equal(hasSideRgb(0x2b), false);
        assert.equal(hasSideSpot(0x2b), false);
    });
});
describe("capabilityOf", () => {
    it("⭐⭐ センサー・インターフェース・ドングルはライトにしない", () => {
        for (const c of [0x1b, 0x1c, 0x1d, 0x4a, 0x88]) {
            const cap = capabilityOf(c);
            assert.equal(cap.isLight, false, `0x${c.toString(16)} が除外されていない: ${cap.reason}`);
        }
    });
    it("⭐ 手元の器具 0x2B は調光調色 + 常夜灯対応", () => {
        const cap = capabilityOf(0x2b);
        assert.equal(cap.isLight, true);
        assert.equal(cap.kind, "colorTemperature");
        assert.equal(cap.nightLight, true);
    });
    it("調光のみの器具は Dimmable Light になる", () => {
        const cap = capabilityOf(0x8a);
        assert.equal(cap.isLight, true);
        assert.equal(cap.kind, "dimmable");
    });
    it("天井灯でない照明は常夜灯非対応（明るさ軸の下端が主灯 5〜15% になる）", () => {
        const cap = capabilityOf(0x01);
        assert.equal(cap.isLight, true);
        assert.equal(cap.kind, "colorTemperature");
        assert.equal(cap.nightLight, false);
    });
    it("製品コード未取得なら調光調色として出すが常夜灯は使わない", () => {
        const cap = capabilityOf(null);
        assert.equal(cap.isLight, true);
        assert.equal(cap.kind, "colorTemperature");
        assert.equal(cap.nightLight, false);
    });
    it("未知の製品コードは調光調色として出す（器具を隠さない）", () => {
        const cap = capabilityOf(0xf3);
        assert.equal(cap.isLight, true);
        assert.equal(cap.kind, "colorTemperature");
    });
    it("設定で除外できる", () => {
        assert.equal(capabilityOf(0x2b, { exclude: true }).isLight, false);
    });
    it("設定でデバイスタイプを固定できる", () => {
        assert.equal(capabilityOf(0x2b, { deviceType: "dimmable" }).kind, "dimmable");
    });
    it("設定で常夜灯の有無を固定できる", () => {
        assert.equal(capabilityOf(0x2b, { nightLight: false }).nightLight, false);
        assert.equal(capabilityOf(0x01, { nightLight: true }).nightLight, true);
    });
    it("判定理由が必ず入る（ログとドキュメントのため）", () => {
        for (const c of [null, 0x01, 0x2b, 0x1b, 0x8a]) {
            assert.ok(capabilityOf(c).reason.length > 0, `${c}`);
        }
    });
    it("符号付きバイトで渡ってきても解釈が変わらない", () => {
        // Java の byte は符号付き。0x80 は -128 として現れる
        assert.equal(capabilityOf(-128).nightLight, capabilityOf(0x80).nightLight);
        assert.equal(isCeilingLight(-128), isCeilingLight(0x80));
    });
});
//# sourceMappingURL=capability.test.js.map