/**
 * 明るさの「段」の定義。**プロトコル由来の事実**なので `odelic-matter` と
 * `odelic-web` の両方がここを見る。
 *
 * ⚠️ 二重に持つと必ずずれる。器具は連続値を持たず、
 * **主灯 20 段（5〜100% の 5% 刻み）+ 常夜灯 3 段**しかない（docs C15-9 / C24）。
 *
 * ## ⭐ 常夜灯は明るさ軸の下端
 *
 * 常夜灯は主灯の最小値（5%）より暗く、両者は排他（点けると主灯が消える・C24-5）。
 * つまり**物理的な明るさは 1 本の連続軸**になる。
 *
 * ```
 * 暗い ←─────────────────────────────────────────────→ 明るい
 *  消灯 | 常夜灯 3 段 | 主灯 5% 10% 15% … 95% 100%（20 段）
 * ```
 *
 * ⭐ 公式アプリも天井灯でない器具には明るさコード 17/18/19（= 15%/10%/5%）を
 * 常夜灯の代用として送っており、同じ考え方をしている（C24）。
 *
 * ## このファイルに入れないもの
 *
 * ⚠️ **Matter 固有の量子化（`CurrentLevel` 1〜254 や mired）は入れない。**
 * それは `odelic-matter` の `mapping.ts` の仕事。`odelic-web` は
 * `odelicd` を直接呼ぶので Matter の値域を知る必要がない。
 */

/** 主灯の段数。`bright` は 5, 10, … 100（C15-9）。 */
export const MAIN_STEPS = 20;

/** 常夜灯の段数。器具値 1 / 2 / 3（3 が最も明るい・C24-6）。 */
export const NIGHT_STEPS = 3;

/** 主灯の明るさ（%）を暗い順に並べたもの。⚠️ 器具はこの値以外を受け付けない。 */
export const MAIN_BRIGHTS: readonly number[] = Array.from(
    { length: MAIN_STEPS },
    (_, i) => (i + 1) * 5,
);

/** 常夜灯が点いている段。`level` は `odelicd` の `/night?level=` の値（0 が最も明るい）。 */
export interface NightRung {
    kind: "night";
    level: 0 | 1 | 2;
}

/** 主灯が点いている段。`bright` は必ず `MAIN_BRIGHTS` のいずれか。 */
export interface MainRung {
    kind: "main";
    bright: number;
}

/** 明るさ軸上の 1 段。消灯は「段が無い」状態として別に扱う。 */
export type Rung = NightRung | MainRung;

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

/** 器具が返す常夜灯の値（1〜3）→ `/night?level=` の値（0〜2）。C24-6 で反転する。 */
export function nightDeviceToLevel(deviceValue: number): 0 | 1 | 2 {
    return clamp(3 - deviceValue, 0, 2) as 0 | 1 | 2;
}

/** `/night?level=` の値（0〜2）→ 器具が返す値（3〜1）。 */
export function nightLevelToDevice(level: number): number {
    return clamp(3 - level, 1, 3);
}

/**
 * 器具の能力に応じた段の一覧を**暗い順**に返す。
 *
 * ⭐ UI のスライダーはこの配列の添字をそのまま使えばよい
 * （0 が最も暗い。`length - 1` が最も明るい）。
 *
 * @param nightLight 専用の常夜灯を持つか（`capabilityOf().nightLight`）
 */
export function ladder(nightLight: boolean): Rung[] {
    const rungs: Rung[] = [];
    if (nightLight) {
        // 器具値 1（最も暗い）→ 3（最も明るい）の順に並べる
        for (let dev = 1; dev <= NIGHT_STEPS; dev++) {
            rungs.push({ kind: "night", level: nightDeviceToLevel(dev) });
        }
    }
    for (const bright of MAIN_BRIGHTS) rungs.push({ kind: "main", bright });
    return rungs;
}

/** `GET /devices` の 1 台分のうち、段の判定に必要なフィールド。 */
export interface FixtureState {
    on: boolean | null;
    bright: number | null;
    /** 器具が返す常夜灯の値。0 = 消灯 / 1〜3（3 が最も明るい） */
    night: number | null;
}

/**
 * 器具の状態が `ladder()` の何段目かを返す。
 *
 * - 常夜灯が点いていれば常夜灯の段（主灯の値は無視する。排他だから）
 * - 主灯が点いていればその明るさの段
 * - 消灯なら `null`（段が無い）
 * - ⚠️ 状態が未取得なら `null`。**適当な段を返さない**（P4: 嘘をつかない）
 */
export function rungIndexOfState(state: FixtureState, nightLight: boolean): number | null {
    const rungs = ladder(nightLight);

    if (nightLight && state.night !== null && state.night > 0) {
        const level = nightDeviceToLevel(state.night);
        const i = rungs.findIndex(r => r.kind === "night" && r.level === level);
        return i < 0 ? null : i;
    }

    if (state.on !== true || state.bright === null || state.bright <= 0) return null;

    // ⚠️ 器具は 5% 刻みしか返さないが、念のため最も近い段に寄せる
    const target = clamp(Math.round(state.bright / 5) * 5, 5, 100);
    const i = rungs.findIndex(r => r.kind === "main" && r.bright === target);
    if (i >= 0) return i;
    // 段に無い値（想定外）。最も近い主灯の段を返す
    let best = -1;
    let bestDiff = Infinity;
    rungs.forEach((r, idx) => {
        if (r.kind !== "main") return;
        const d = Math.abs(r.bright - target);
        if (d < bestDiff) {
            bestDiff = d;
            best = idx;
        }
    });
    return best < 0 ? null : best;
}

/** 段を人が読める形にする（UI のラベル用）。 */
export function describeRung(rung: Rung): string {
    if (rung.kind === "night") {
        // level 0 が最も明るい常夜灯
        const names = ["常夜灯（明）", "常夜灯（中）", "常夜灯（暗）"];
        return names[rung.level] ?? `常夜灯 ${rung.level}`;
    }
    return `${rung.bright}%`;
}
