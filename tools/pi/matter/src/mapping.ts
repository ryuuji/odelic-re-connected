/**
 * Matter の属性値と odelicd の HTTP API 値を相互変換する。
 *
 * ⚠️ このファイルは**純関数だけ**にしてある。ここが唯一の非自明なロジックなので、
 *    test/mapping.test.ts で往復を固定している。
 *
 * 根拠は docs/02-protocol.md の C15-9 / C18-4 / C24 と docs/07-matter.md。
 * odelicd.py の `bright_to_code` / `code_to_bright` / `color_to_code`（L168-186）と
 * **同じ刻み**でなければならない。刻みから外れた値を送ると器具側の
 * ルックアップテーブルで丸められ、状態応答との等値比較（収束判定）が壊れる。
 */

// ------------------------------------------------------------------ 明るさ

/** Matter LevelControl の値域。仕様どおり 1〜254（0 は無効値）。 */
export const MATTER_LEVEL_MIN = 1;
export const MATTER_LEVEL_MAX = 254;

/** 主灯の段数。`bright` は 5, 10, … 100 の 20 段（C15-9）。 */
export const MAIN_STEPS = 20;

/** 常夜灯の段数。器具値 1 / 2 / 3（3 が最も明るい・C24-6）。 */
export const NIGHT_STEPS = 3;

/** 器具 1 台の明るさ軸の作り方。 */
export interface LightScale {
    /**
     * 明るさ軸の下端を常夜灯に割り当てる割合（%）。既定 30。
     *
     * ⚠️ ここちょうどの値（既定なら「30%」）は境界に当たる。Matter level への
     * 丸め方はコントローラ依存なので、どちら側に落ちるかは断定できない。
     * 「30% にして」を確実に主灯にしたいなら 25 などに下げる。
     */
    nightBandPercent: number;
    /**
     * この器具が専用の常夜灯を持つか。
     *
     * ⚠️ 天井灯タイプだけが対応する（odelicd.py `set_night` の docstring）。
     * false なら常夜灯の帯を作らず、軸全体を主灯 5〜100% に使う。
     */
    nightLight: boolean;
}

export const DEFAULT_SCALE: LightScale = { nightBandPercent: 30, nightLight: true };

/** 主灯が点いている状態。`bright` は必ず 5 の倍数で 5〜100。 */
export interface MainTarget {
    kind: "main";
    bright: number;
}

/** 常夜灯が点いている状態。`level` は odelicd の `/night?level=` の値（0 が最も明るい）。 */
export interface NightTarget {
    kind: "night";
    level: 0 | 1 | 2;
}

/** 明るさ軸上の 1 点。消灯は OnOff クラスタの仕事なのでここには含めない。 */
export type LightTarget = MainTarget | NightTarget;

/**
 * 2 つの指示が同じ段を指しているか。
 *
 * ⭐ 器具は主灯 20 段 + 常夜灯 3 段しか持たないので、Matter level の 92 と 96 は
 * どちらも「主灯 15%」を意味する。**同じ段なら Matter 側の値を書き換えない**ために使う
 * （書き換えるとスライダーが設定直後に動く）。
 */
export function sameTarget(a: LightTarget, b: LightTarget): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "main" && b.kind === "main") return a.bright === b.bright;
    if (a.kind === "night" && b.kind === "night") return a.level === b.level;
    return false;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

/**
 * 常夜灯に割り当てる Matter level の上限。
 *
 * 常夜灯非対応なら 0 を返し、軸全体が主灯になる。
 */
export function nightBandTop(scale: LightScale): number {
    const pct = clamp(scale.nightBandPercent, 0, 90);
    if (!scale.nightLight || pct <= 0) return 0;
    const top = Math.floor((MATTER_LEVEL_MAX * pct) / 100);
    // 常夜灯 3 段と主灯 20 段のどちらも潰さない範囲に収める。
    // 下限を NIGHT_STEPS にしておかないと 3 段を区別できる level が無くなる
    return clamp(top, NIGHT_STEPS, MATTER_LEVEL_MAX - MAIN_STEPS);
}

/** 器具が返す常夜灯の値（1〜3）→ odelicd `/night?level=` の値（0〜2）。C24-6 で反転する。 */
export function nightDeviceToLevel(deviceValue: number): 0 | 1 | 2 {
    return clamp(3 - deviceValue, 0, 2) as 0 | 1 | 2;
}

/** odelicd `/night?level=` の値（0〜2）→ 器具が返す値（3〜1）。 */
export function nightLevelToDevice(level: number): number {
    return clamp(3 - level, 1, 3);
}

/**
 * Matter の CurrentLevel を、実際に送るコマンドへ落とす。
 *
 * 下端 `nightBandTop()` までが常夜灯 3 段、その上が主灯 20 段（5〜100%）。
 * 境界ちょうど（`top` / `top + 1`）は **`top + 1` から主灯**になる。
 */
export function matterLevelToTarget(level: number, scale: LightScale = DEFAULT_SCALE): LightTarget {
    const lv = clamp(Math.round(level), MATTER_LEVEL_MIN, MATTER_LEVEL_MAX);
    const top = nightBandTop(scale);

    if (lv <= top) {
        // 常夜灯の帯を 3 等分する。n = 0 が最も暗い
        const n = clamp(Math.ceil((lv * NIGHT_STEPS) / top) - 1, 0, NIGHT_STEPS - 1);
        // n = 0,1,2 → 器具値 1,2,3 → コマンド level 2,1,0
        return { kind: "night", level: nightDeviceToLevel(n + 1) };
    }

    const span = MATTER_LEVEL_MAX - (top + 1); // 主灯の帯の幅
    const r = span === 0 ? 0 : clamp(Math.round(((lv - (top + 1)) * (MAIN_STEPS - 1)) / span), 0, MAIN_STEPS - 1);
    return { kind: "main", bright: (r + 1) * 5 };
}

/**
 * コマンドの値を Matter の CurrentLevel に戻す。
 *
 * 常夜灯は帯の**中央**を返す（帯のどこを指されても同じ段になるので、
 * 往復させたときに段が動かない代表値を選ぶ）。
 */
export function targetToMatterLevel(target: LightTarget, scale: LightScale = DEFAULT_SCALE): number {
    const top = nightBandTop(scale);

    if (target.kind === "night") {
        if (top === 0) {
            // 常夜灯非対応の器具に常夜灯の状態が来た（設定と実機が食い違っている）。
            // 軸の最下段（主灯 5%）に寄せておく
            return MATTER_LEVEL_MIN;
        }
        const n = nightLevelToDevice(target.level) - 1; // 0..2
        const lo = Math.floor((n * top) / NIGHT_STEPS) + 1;
        const hi = Math.floor(((n + 1) * top) / NIGHT_STEPS);
        return clamp(Math.floor((lo + hi) / 2), MATTER_LEVEL_MIN, top);
    }

    const bright = clamp(Math.round(target.bright / 5) * 5, 5, 100);
    const r = bright / 5 - 1; // 0..19
    const span = MATTER_LEVEL_MAX - (top + 1);
    return clamp(top + 1 + Math.round((r * span) / (MAIN_STEPS - 1)), MATTER_LEVEL_MIN, MATTER_LEVEL_MAX);
}

// ------------------------------------------------------------------ 色温度

/** 色温度の換算設定。ケルビン値は実機で確定させる（docs/07-matter.md の検証 D）。 */
export interface ColorScale {
    /** `color = 0%` 側のケルビン（既定 2700 = 電球色）。 */
    minKelvin: number;
    /** `color = 100%` 側のケルビン（既定 6500 = 昼光色）。 */
    maxKelvin: number;
    /** true なら `color = 0%` が `maxKelvin` 側。実機で向きが逆だった場合に立てる。 */
    inverted: boolean;
}

export const DEFAULT_COLOR_SCALE: ColorScale = { minKelvin: 2700, maxKelvin: 6500, inverted: false };

/** 色温度の段数。`color` は 0, 5, … 100 の 21 段（C15-9）。 */
export const COLOR_STEPS = 21;

export function kelvinToMireds(kelvin: number): number {
    return Math.round(1_000_000 / kelvin);
}

/** Matter に申告する mired の下限（= 最も高いケルビン）。 */
export function physicalMinMireds(scale: ColorScale = DEFAULT_COLOR_SCALE): number {
    return kelvinToMireds(Math.max(scale.minKelvin, scale.maxKelvin));
}

/** Matter に申告する mired の上限（= 最も低いケルビン）。 */
export function physicalMaxMireds(scale: ColorScale = DEFAULT_COLOR_SCALE): number {
    return kelvinToMireds(Math.min(scale.minKelvin, scale.maxKelvin));
}

/** odelicd の `color`（0〜100%）→ Matter の ColorTemperatureMireds。 */
export function colorPercentToMireds(percent: number, scale: ColorScale = DEFAULT_COLOR_SCALE): number {
    const lo = physicalMinMireds(scale);
    const hi = physicalMaxMireds(scale);
    const pct = clamp(percent, 0, 100);
    // 既定（inverted=false）: 0% = minKelvin = mired 上限側
    const t = scale.inverted ? pct / 100 : 1 - pct / 100;
    return clamp(Math.round(lo + t * (hi - lo)), lo, hi);
}

/**
 * Matter の ColorTemperatureMireds → odelicd の `color`（0〜100%）。
 *
 * ⚠️ **5% 刻みに丸める。**器具は 21 段のコードしか持たないので、
 * 刻みから外れた値を送ると状態応答と一致せず収束判定が失敗する。
 */
export function miredsToColorPercent(mireds: number, scale: ColorScale = DEFAULT_COLOR_SCALE): number {
    const lo = physicalMinMireds(scale);
    const hi = physicalMaxMireds(scale);
    if (hi === lo) return 0;
    const m = clamp(mireds, lo, hi);
    const t = (m - lo) / (hi - lo);
    const pct = (scale.inverted ? t : 1 - t) * 100;
    return clamp(Math.round(pct / 5) * 5, 0, 100);
}

// ------------------------------------------- odelicd の器具状態 → Matter の属性

/** `GET /devices` の 1 台分（必要なフィールドだけ）。 */
export interface OdelicDeviceState {
    on: boolean | null;
    bright: number | null;
    color: number | null;
    /** 器具が返す常夜灯の値。0 = 消灯 / 1〜3（3 が最も明るい）。 */
    night: number | null;
}

/** Matter 側に書き戻す値。`null` は「変えない」を意味する。 */
export interface MatterLightState {
    onOff: boolean | null;
    level: number | null;
    mireds: number | null;
}

/**
 * 器具の状態を Matter の属性値に写す。
 *
 * ⭐ 常夜灯と主灯は排他（C24-5）なので、**1 本の明るさ軸に畳める**。
 * 「常夜灯が点いている」は「軸の下端に居る」と同じことになる。
 */
export function deviceStateToMatter(
    state: OdelicDeviceState,
    scale: LightScale = DEFAULT_SCALE,
    colorScale: ColorScale = DEFAULT_COLOR_SCALE,
): MatterLightState {
    const mireds = state.color === null ? null : colorPercentToMireds(state.color, colorScale);

    // 常夜灯が点いていれば、主灯の値に関係なく軸の下端に居る
    if (state.night !== null && state.night > 0) {
        return {
            onOff: true,
            level: targetToMatterLevel({ kind: "night", level: nightDeviceToLevel(state.night) }, scale),
            mireds,
        };
    }

    if (state.on === true) {
        // ⚠️ ON は器具が記憶していた実値で返ってくる（`37 37` ではない）。
        //    bright が未取得のときは level を動かさない
        const level = state.bright === null || state.bright <= 0
            ? null
            : targetToMatterLevel({ kind: "main", bright: state.bright }, scale);
        return { onOff: true, level, mireds };
    }

    if (state.on === false) {
        // ⚠️ 消灯時に CurrentLevel を触らない。Matter では消灯中も
        //    「次に点けたときの明るさ」として保持される値なので、0 を書くと壊れる
        return { onOff: false, level: null, mireds };
    }

    // 状態が未取得。何も断定しない（docs/03-instability.md の P4）
    return { onOff: null, level: null, mireds };
}
