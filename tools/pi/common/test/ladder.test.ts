/**
 * 段の定義のテスト。
 *
 * ⭐ ここが `odelic-matter` と `odelic-web` の共通の土台なので、
 * 「器具が受け付けない値を作らない」ことを固定する。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    MAIN_BRIGHTS,
    MAIN_STEPS,
    NIGHT_STEPS,
    describeRung,
    ladder,
    nightDeviceToLevel,
    nightLevelToDevice,
    rungIndexOfState,
} from "../src/ladder.js";

describe("主灯の段", () => {
    it("5% 刻みで 20 段（器具が受け付ける値だけ）", () => {
        assert.equal(MAIN_BRIGHTS.length, MAIN_STEPS);
        assert.equal(MAIN_BRIGHTS[0], 5);
        assert.equal(MAIN_BRIGHTS[MAIN_STEPS - 1], 100);
        for (const b of MAIN_BRIGHTS) assert.equal(b % 5, 0, `${b} が 5 の倍数でない`);
    });

    it("⚠️ 0% は含まない（消灯は OnOff の仕事）", () => {
        assert.ok(!MAIN_BRIGHTS.includes(0));
    });
});

describe("常夜灯の値の反転（C24-6）", () => {
    it("器具値 3 が最も明るく、コマンド level 0 に対応する", () => {
        assert.equal(nightDeviceToLevel(3), 0);
        assert.equal(nightDeviceToLevel(2), 1);
        assert.equal(nightDeviceToLevel(1), 2);
    });

    it("往復する", () => {
        for (const d of [1, 2, 3]) assert.equal(nightLevelToDevice(nightDeviceToLevel(d)), d);
        for (const l of [0, 1, 2]) assert.equal(nightDeviceToLevel(nightLevelToDevice(l)), l);
    });
});

describe("ladder()", () => {
    it("⭐ 常夜灯ありなら 3 + 20 = 23 段", () => {
        assert.equal(ladder(true).length, NIGHT_STEPS + MAIN_STEPS);
    });

    it("常夜灯なしなら 20 段（主灯だけ）", () => {
        const r = ladder(false);
        assert.equal(r.length, MAIN_STEPS);
        assert.ok(r.every(x => x.kind === "main"));
    });

    it("⭐ 暗い順に並ぶ（常夜灯 → 主灯、常夜灯の中も暗い順）", () => {
        const r = ladder(true);
        // 先頭 3 つが常夜灯で、器具値 1→3（暗→明）の順
        assert.deepEqual(r.slice(0, 3), [
            { kind: "night", level: 2 }, // 器具値 1 = 最も暗い
            { kind: "night", level: 1 },
            { kind: "night", level: 0 }, // 器具値 3 = 最も明るい
        ]);
        // 残りは主灯で昇順
        const brights = r.slice(3).map(x => (x.kind === "main" ? x.bright : -1));
        assert.deepEqual(brights, [...MAIN_BRIGHTS]);
    });

    it("最下段は常夜灯の最も暗い段、最上段は主灯 100%", () => {
        const r = ladder(true);
        assert.deepEqual(r[0], { kind: "night", level: 2 });
        assert.deepEqual(r[r.length - 1], { kind: "main", bright: 100 });
    });
});

describe("rungIndexOfState()", () => {
    it("常夜灯が点いていれば常夜灯の段（主灯の値は無視する）", () => {
        // ⭐ 排他なので主灯の値に意味はない
        assert.equal(rungIndexOfState({ on: false, bright: 80, night: 1 }, true), 0);
        assert.equal(rungIndexOfState({ on: false, bright: 80, night: 2 }, true), 1);
        assert.equal(rungIndexOfState({ on: false, bright: 80, night: 3 }, true), 2);
    });

    it("主灯が点いていればその明るさの段", () => {
        const r = ladder(true);
        for (const bright of MAIN_BRIGHTS) {
            const i = rungIndexOfState({ on: true, bright, night: 0 }, true);
            assert.notEqual(i, null, `bright ${bright}`);
            assert.deepEqual(r[i!], { kind: "main", bright });
        }
    });

    it("⚠️ 消灯なら null（段が無い）", () => {
        assert.equal(rungIndexOfState({ on: false, bright: 60, night: 0 }, true), null);
    });

    it("⚠️ 状態が未取得なら null（適当な段を返さない）", () => {
        assert.equal(rungIndexOfState({ on: null, bright: null, night: null }, true), null);
    });

    it("ON だが明るさ未取得なら null", () => {
        assert.equal(rungIndexOfState({ on: true, bright: null, night: 0 }, true), null);
    });

    it("常夜灯非対応の器具では常夜灯の状態を段にしない", () => {
        // 設定と実機が食い違っている場合。主灯として扱えないので null
        assert.equal(rungIndexOfState({ on: false, bright: null, night: 2 }, false), null);
    });

    it("刻みから外れた値でも最も近い段に寄せる（想定外の入力に耐える）", () => {
        const r = ladder(true);
        const i = rungIndexOfState({ on: true, bright: 63, night: 0 }, true);
        assert.notEqual(i, null);
        assert.deepEqual(r[i!], { kind: "main", bright: 65 });
    });

    it("往復する（段 → 状態 → 段）", () => {
        const r = ladder(true);
        r.forEach((rung, idx) => {
            const state =
                rung.kind === "night"
                    ? { on: false, bright: null, night: nightLevelToDevice(rung.level) }
                    : { on: true, bright: rung.bright, night: 0 };
            assert.equal(rungIndexOfState(state, true), idx, `段 ${idx} (${describeRung(rung)})`);
        });
    });
});

describe("describeRung()", () => {
    it("人が読めるラベルになる", () => {
        assert.equal(describeRung({ kind: "main", bright: 70 }), "70%");
        assert.equal(describeRung({ kind: "night", level: 0 }), "常夜灯（明）");
        assert.equal(describeRung({ kind: "night", level: 2 }), "常夜灯（暗）");
    });
});
