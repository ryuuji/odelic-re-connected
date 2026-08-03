/**
 * 器具一覧を MAC ごとに畳むテスト（C34）。
 *
 * ⭐ 実機で起きた形をそのまま置く。他のリモコンがメッシュに繋がっているときに
 * `EC:C5:7F:81:DE:CD` が 2 つの vAddr で見え、片方は到達率 0%（`absent`）だった。
 * 畳まないと Matter と設定ページが**生きている照明を「反応なし」と表示する。**
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldDevicesByMac, foldedAwayKeys } from "../src/devices.js";

const MAC_A = "EC:C5:7F:81:DE:CD";
const MAC_B = "EC:C5:7F:80:28:A6";

function dev(key: string, mac: string, stateAt: number | null = null, lastSeen = 0) {
    return { key, mac, state_updated_at: stateAt, last_seen: lastSeen };
}

describe("foldDevicesByMac", () => {
    it("重複が無ければそのまま返す", () => {
        const list = [dev("01000000", MAC_A), dev("02000000", MAC_B)];
        assert.deepEqual(foldDevicesByMac(list), list);
    });

    it("⭐ 実機の形: 応答している方を残し、absent な幽霊を捨てる", () => {
        const alive = dev("01000000", MAC_A, 1000);
        const ghost = dev("05000000", MAC_A, null);
        const kept = foldDevicesByMac([alive, ghost], new Set(["05000000"]));
        assert.deepEqual(kept, [alive]);
        assert.deepEqual(foldedAwayKeys([alive, ghost], kept), ["05000000"]);
    });

    it("⭐ 幽霊が先に並んでいても勝たせない（順序に依存しない）", () => {
        const ghost = dev("05000000", MAC_A);
        const alive = dev("01000000", MAC_A, 1000);
        assert.deepEqual(foldDevicesByMac([ghost, alive], new Set(["05000000"])), [alive]);
    });

    it("どちらも absent でないなら状態が新しい方を残す", () => {
        const older = dev("01000000", MAC_A, 100);
        const newer = dev("05000000", MAC_A, 200);
        assert.deepEqual(foldDevicesByMac([older, newer]), [newer]);
    });

    it("状態が同じなら最後に見えた方を残す", () => {
        const older = dev("01000000", MAC_A, null, 100);
        const newer = dev("05000000", MAC_A, null, 200);
        assert.deepEqual(foldDevicesByMac([older, newer]), [newer]);
    });

    it("⚠️ 両方 absent でも 1 台に畳む（2 台に見せない）", () => {
        const a = dev("01000000", MAC_A);
        const b = dev("05000000", MAC_A);
        const kept = foldDevicesByMac([a, b], new Set(["01000000", "05000000"]));
        assert.equal(kept.length, 1);
    });

    it("MAC の書き方が違っても同じ器具として畳む", () => {
        const kept = foldDevicesByMac([dev("01000000", "ec:c5:7f:81:de:cd"), dev("05000000", MAC_A)]);
        assert.equal(kept.length, 1);
    });

    it("⚠️ 他の器具の位置を動かさない（並びが安定する）", () => {
        const list = [dev("02000000", MAC_B), dev("01000000", MAC_A, 1000), dev("05000000", MAC_A)];
        const kept = foldDevicesByMac(list, new Set(["05000000"]));
        assert.deepEqual(kept.map(d => d.key), ["02000000", "01000000"]);
    });

    it("MAC 未取得（オール 0）の器具は畳んでしまうが、呼ぶ側が先に捨てている", () => {
        // ⚠️ この関数は MAC 未取得を特別扱いしない。`isUnknownMac` で先に落とす前提
        const kept = foldDevicesByMac([
            dev("01000000", "00:00:00:00:00:00"),
            dev("05000000", "00:00:00:00:00:00"),
        ]);
        assert.equal(kept.length, 1);
    });
});