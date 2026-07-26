/**
 * mapping.ts の往復を固定する。
 *
 * ここが壊れると「Google Home で 70% にしたのに器具が別の明るさになる」「収束判定が
 * 永遠に失敗して 504 を返す」といった形で出る。刻み（主灯 5% × 20 段 / 色温度 5% × 21 段）
 * から外れた値を絶対に生成しないことが最重要。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    COLOR_STEPS,
    ColorScale,
    DEFAULT_COLOR_SCALE,
    DEFAULT_SCALE,
    LightScale,
    MAIN_STEPS,
    MATTER_LEVEL_MAX,
    MATTER_LEVEL_MIN,
    NIGHT_STEPS,
    colorPercentToMireds,
    deviceStateToMatter,
    kelvinToMireds,
    matterLevelToTarget,
    miredsToColorPercent,
    nightBandTop,
    nightDeviceToLevel,
    nightLevelToDevice,
    physicalMaxMireds,
    physicalMinMireds,
    targetToMatterLevel,
} from "../src/mapping.js";

const NO_NIGHT: LightScale = { nightBandPercent: 30, nightLight: false };

describe("nightBandTop", () => {
    it("既定 30% では 76", () => {
        assert.equal(nightBandTop(DEFAULT_SCALE), 76);
    });

    it("常夜灯非対応なら 0（軸全体が主灯）", () => {
        assert.equal(nightBandTop(NO_NIGHT), 0);
    });

    it("0% を指定しても 0（帯を作らない）", () => {
        assert.equal(nightBandTop({ nightBandPercent: 0, nightLight: true }), 0);
    });

    it("極端に小さい割合でも 3 段を区別できる幅を確保する", () => {
        assert.ok(nightBandTop({ nightBandPercent: 1, nightLight: true }) >= NIGHT_STEPS);
    });
});

describe("matterLevelToTarget（既定スケール）", () => {
    it("常夜灯の 3 段に分かれる", () => {
        // 帯は 1..76 を 3 等分 → 1-25 / 26-50 / 51-76
        assert.deepEqual(matterLevelToTarget(1), { kind: "night", level: 2 }); // 最暗
        assert.deepEqual(matterLevelToTarget(25), { kind: "night", level: 2 });
        assert.deepEqual(matterLevelToTarget(26), { kind: "night", level: 1 });
        assert.deepEqual(matterLevelToTarget(50), { kind: "night", level: 1 });
        assert.deepEqual(matterLevelToTarget(51), { kind: "night", level: 0 }); // 最明
        assert.deepEqual(matterLevelToTarget(76), { kind: "night", level: 0 });
    });

    it("⭐ 境界 76/77 で常夜灯から主灯に切り替わる", () => {
        assert.equal(matterLevelToTarget(76).kind, "night");
        assert.deepEqual(matterLevelToTarget(77), { kind: "main", bright: 5 });
    });

    it("主灯の両端が 5% と 100%", () => {
        assert.deepEqual(matterLevelToTarget(77), { kind: "main", bright: 5 });
        assert.deepEqual(matterLevelToTarget(MATTER_LEVEL_MAX), { kind: "main", bright: 100 });
    });

    it("計画に書いた代表値と一致する", () => {
        assert.deepEqual(matterLevelToTarget(86), { kind: "main", bright: 10 });
    });

    it("値域外は丸めてから扱う", () => {
        assert.equal(matterLevelToTarget(0).kind, "night");
        assert.deepEqual(matterLevelToTarget(999), { kind: "main", bright: 100 });
    });
});

describe("matterLevelToTarget（常夜灯非対応）", () => {
    it("常夜灯を一切返さない", () => {
        for (let lv = MATTER_LEVEL_MIN; lv <= MATTER_LEVEL_MAX; lv++) {
            assert.equal(matterLevelToTarget(lv, NO_NIGHT).kind, "main", `level ${lv}`);
        }
    });

    it("最下段が主灯 5%、最上段が 100%", () => {
        assert.deepEqual(matterLevelToTarget(1, NO_NIGHT), { kind: "main", bright: 5 });
        assert.deepEqual(matterLevelToTarget(254, NO_NIGHT), { kind: "main", bright: 100 });
    });
});

describe("明るさは必ず刻みに乗る", () => {
    // ⚠️ odelicd の bright_to_code は 5 の倍数以外を切り捨てる。刻みから外れた値を
    //    送ると状態応答と一致せず、収束判定（P4）が永遠に失敗する
    for (const scale of [DEFAULT_SCALE, NO_NIGHT]) {
        const label = scale.nightLight ? "既定" : "常夜灯非対応";
        it(`${label}: 全 level が 5〜100 の 5 の倍数か常夜灯 0〜2 になる`, () => {
            for (let lv = MATTER_LEVEL_MIN; lv <= MATTER_LEVEL_MAX; lv++) {
                const t = matterLevelToTarget(lv, scale);
                if (t.kind === "main") {
                    assert.equal(t.bright % 5, 0, `level ${lv} → bright ${t.bright}`);
                    assert.ok(t.bright >= 5 && t.bright <= 100, `level ${lv} → bright ${t.bright}`);
                } else {
                    assert.ok([0, 1, 2].includes(t.level), `level ${lv} → night ${t.level}`);
                }
            }
        });
    }
});

describe("targetToMatterLevel → matterLevelToTarget の往復", () => {
    it("主灯 20 段がすべて往復する", () => {
        for (let bright = 5; bright <= 100; bright += 5) {
            const lv = targetToMatterLevel({ kind: "main", bright });
            assert.deepEqual(matterLevelToTarget(lv), { kind: "main", bright }, `bright ${bright} (level ${lv})`);
        }
    });

    it("常夜灯 3 段がすべて往復する", () => {
        for (const level of [0, 1, 2] as const) {
            const lv = targetToMatterLevel({ kind: "night", level });
            assert.deepEqual(matterLevelToTarget(lv), { kind: "night", level }, `night ${level} (level ${lv})`);
        }
    });

    it("常夜灯非対応でも主灯 20 段が往復する", () => {
        for (let bright = 5; bright <= 100; bright += 5) {
            const lv = targetToMatterLevel({ kind: "main", bright }, NO_NIGHT);
            assert.deepEqual(matterLevelToTarget(lv, NO_NIGHT), { kind: "main", bright }, `bright ${bright}`);
        }
    });

    it("主灯の代表 level は帯の中で単調増加する", () => {
        let prev = -1;
        for (let bright = 5; bright <= 100; bright += 5) {
            const lv = targetToMatterLevel({ kind: "main", bright });
            assert.ok(lv > prev, `bright ${bright} → level ${lv} は ${prev} より大きいこと`);
            prev = lv;
        }
        assert.equal(prev, MATTER_LEVEL_MAX);
    });

    it("常夜灯の代表 level は帯の中に収まる", () => {
        const top = nightBandTop(DEFAULT_SCALE);
        for (const level of [0, 1, 2] as const) {
            const lv = targetToMatterLevel({ kind: "night", level });
            assert.ok(lv >= MATTER_LEVEL_MIN && lv <= top, `night ${level} → level ${lv}`);
        }
    });

    it("常夜灯非対応の器具に常夜灯状態が来ても値域を外れない", () => {
        const lv = targetToMatterLevel({ kind: "night", level: 1 }, NO_NIGHT);
        assert.ok(lv >= MATTER_LEVEL_MIN && lv <= MATTER_LEVEL_MAX);
    });

    it("主灯の段数は 20、常夜灯は 3 で全 23 段が別々の level になる", () => {
        const levels = new Set<number>();
        for (const level of [0, 1, 2] as const) levels.add(targetToMatterLevel({ kind: "night", level }));
        for (let bright = 5; bright <= 100; bright += 5) levels.add(targetToMatterLevel({ kind: "main", bright }));
        assert.equal(levels.size, NIGHT_STEPS + MAIN_STEPS);
    });
});

describe("常夜灯の値の反転（C24-6）", () => {
    it("器具値 3 が最も明るく、コマンド level 0 に対応する", () => {
        assert.equal(nightDeviceToLevel(3), 0);
        assert.equal(nightDeviceToLevel(2), 1);
        assert.equal(nightDeviceToLevel(1), 2);
    });

    it("往復する", () => {
        for (const dev of [1, 2, 3]) {
            assert.equal(nightLevelToDevice(nightDeviceToLevel(dev)), dev);
        }
        for (const level of [0, 1, 2]) {
            assert.equal(nightDeviceToLevel(nightLevelToDevice(level)), level);
        }
    });
});

describe("色温度", () => {
    it("mired の物理レンジが 2700〜6500K に対応する", () => {
        assert.equal(physicalMinMireds(), kelvinToMireds(6500)); // 153
        assert.equal(physicalMaxMireds(), kelvinToMireds(2700)); // 370
        assert.equal(physicalMinMireds(), 154);
        assert.equal(physicalMaxMireds(), 370);
    });

    it("0% が電球色（mired 上限）、100% が昼光色（mired 下限）", () => {
        assert.equal(colorPercentToMireds(0), physicalMaxMireds());
        assert.equal(colorPercentToMireds(100), physicalMinMireds());
    });

    it("inverted で向きが逆になる", () => {
        const inv: ColorScale = { ...DEFAULT_COLOR_SCALE, inverted: true };
        assert.equal(colorPercentToMireds(0, inv), physicalMinMireds(inv));
        assert.equal(colorPercentToMireds(100, inv), physicalMaxMireds(inv));
    });

    it("21 段すべてが往復する", () => {
        for (let pct = 0; pct <= 100; pct += 5) {
            const mireds = colorPercentToMireds(pct);
            assert.equal(miredsToColorPercent(mireds), pct, `color ${pct}% (mired ${mireds})`);
        }
    });

    it("inverted でも 21 段すべてが往復する", () => {
        const inv: ColorScale = { ...DEFAULT_COLOR_SCALE, inverted: true };
        for (let pct = 0; pct <= 100; pct += 5) {
            assert.equal(miredsToColorPercent(colorPercentToMireds(pct, inv), inv), pct, `color ${pct}%`);
        }
    });

    it("⚠️ 任意の mired を入れても 5% 刻みしか返さない", () => {
        for (let m = physicalMinMireds(); m <= physicalMaxMireds(); m++) {
            const pct = miredsToColorPercent(m);
            assert.equal(pct % 5, 0, `mired ${m} → ${pct}%`);
            assert.ok(pct >= 0 && pct <= 100, `mired ${m} → ${pct}%`);
        }
    });

    it("値域外の mired は端に丸める", () => {
        assert.equal(miredsToColorPercent(1), 100);
        assert.equal(miredsToColorPercent(10_000), 0);
    });

    it("段数は 21", () => {
        const seen = new Set<number>();
        for (let m = physicalMinMireds(); m <= physicalMaxMireds(); m++) seen.add(miredsToColorPercent(m));
        assert.equal(seen.size, COLOR_STEPS);
    });
});

describe("deviceStateToMatter", () => {
    it("常夜灯が点いていれば軸の下端になる（主灯の値は無視）", () => {
        const r = deviceStateToMatter({ on: false, bright: 60, color: 50, night: 2 });
        assert.equal(r.onOff, true);
        assert.deepEqual(matterLevelToTarget(r.level!), { kind: "night", level: 1 });
    });

    it("⭐ 常夜灯 3 段が Matter の別の level になる", () => {
        const levels = [1, 2, 3].map(
            night => deviceStateToMatter({ on: false, bright: null, color: null, night }).level,
        );
        assert.equal(new Set(levels).size, 3);
        // 器具値が大きいほど明るい → level も大きい
        assert.ok(levels[0]! < levels[1]! && levels[1]! < levels[2]!);
    });

    it("主灯が点いていれば bright が level になる", () => {
        const r = deviceStateToMatter({ on: true, bright: 70, color: 50, night: 0 });
        assert.equal(r.onOff, true);
        assert.deepEqual(matterLevelToTarget(r.level!), { kind: "main", bright: 70 });
    });

    it("⚠️ 消灯時は level を変えない（Matter は消灯中も「次に点ける明るさ」を保持する）", () => {
        const r = deviceStateToMatter({ on: false, bright: 60, color: 50, night: 0 });
        assert.equal(r.onOff, false);
        assert.equal(r.level, null);
    });

    it("⚠️ 状態が未取得なら何も断定しない（P4）", () => {
        const r = deviceStateToMatter({ on: null, bright: null, color: null, night: null });
        assert.equal(r.onOff, null);
        assert.equal(r.level, null);
        assert.equal(r.mireds, null);
    });

    it("ON だが bright 未取得なら level を動かさない", () => {
        const r = deviceStateToMatter({ on: true, bright: null, color: 50, night: 0 });
        assert.equal(r.onOff, true);
        assert.equal(r.level, null);
        assert.equal(r.mireds, colorPercentToMireds(50));
    });

    it("色温度は常夜灯中でも保持される", () => {
        const r = deviceStateToMatter({ on: false, bright: null, color: 25, night: 3 });
        assert.equal(r.mireds, colorPercentToMireds(25));
    });

    it("器具の状態と Matter 属性が閉ループする（docs C23 の実測ケース）", () => {
        // bright=60 & color=50 を指示 → 器具が on=true bright=60 color=50 を返した
        const r = deviceStateToMatter({ on: true, bright: 60, color: 50, night: 0 });
        assert.equal(r.onOff, true);
        assert.deepEqual(matterLevelToTarget(r.level!), { kind: "main", bright: 60 });
        assert.equal(miredsToColorPercent(r.mireds!), 50);
    });
});
