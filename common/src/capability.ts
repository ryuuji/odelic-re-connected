/**
 * 器具の製品コードから「Matter 上で何として見せるか」を決める。
 *
 * ⭐ 根拠は公式アプリの `UtilDeviceFW` の述語**そのもの**（逆コンパイル結果から転記）。
 *    推測ではない。
 *
 * ⚠️ `CFormat.getLinearFormatCodeBy` の「調光のみ / ON-OFF のみ / 調光+色 / 調光調色」の
 *    4 系統は **LC シリーズ用の別系統**（`ProductorCode` enum で分岐する。docs C15-10）で、
 *    メッシュ照明には使われていない。メッシュ照明の明るさ・色温度は
 *    `color/5` と `(100-bright)/5` の直接計算（docs C18-4・odelicd も同じ）。
 *    したがって能力判定は `UtilDeviceFW` の述語を使う。
 *
 * 製品コードの一覧は docs/02-protocol.md C12 / odelicd.py の `PRODUCT_CODES`。
 */

/** Matter に出すデバイスタイプ。 */
export type MatterLightKind =
    /** Color Temperature Light 0x010C。OnOff + LevelControl + ColorControl(CT) */
    | "colorTemperature"
    /** Dimmable Light 0x0101。OnOff + LevelControl */
    | "dimmable";

export interface Capability {
    /** Matter に出すか。false なら照明ではないのでエンドポイントを作らない。 */
    isLight: boolean;
    /** Matter のデバイスタイプ。 */
    kind: MatterLightKind;
    /** 専用の常夜灯（`0xC5` / `0xC0` sub 1）に対応するか。 */
    nightLight: boolean;
    /** 判定の根拠。ログとドキュメントのため。 */
    reason: string;
}

/**
 * `UtilDeviceFW.isCeilingLight(byte)` の全体。
 *
 * ⚠️ docs/02-protocol.md の C24 に載っている一覧は**不完全**だった
 * （`0x40`〜`0x43` / `0x4B`〜`0x53` / `0x63`〜`0x66` / `0x78`〜`0x7D` が漏れていた）。
 * こちらが逆コンパイル結果の全体。
 */
const CEILING_LIGHT_CODES: ReadonlySet<number> = new Set([
    // 単独比較
    0x25, 0x26, 0x2b, 0x60, 0x6b, 0x6d, 0x6e, 0x71, 0x75, 0x76, 0x80,
    // switch の各グループ
    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
    0x40, 0x41, 0x42, 0x43,
    0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53,
    0x63, 0x64, 0x65, 0x66,
    0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d,
]);

/** `UtilDeviceFW.isOnlyLightness(int)` — 調光のみ（色温度を持たない）。 */
const ONLY_LIGHTNESS_CODES: ReadonlySet<number> = new Set([0x8a, 0x91]);

/** `UtilDeviceFW.isInterface(int)` — 照明ではない。 */
const INTERFACE_CODES: ReadonlySet<number> = new Set([0x1d, 0x88]);

/**
 * 照明ではない製品コード。
 *
 * `isInterface` に加えて、`PRODUCT_CODES`（docs C12）から名前で明らかな
 * センサー・ドングルを落とす。⭐ **落とさないと Google Home に「ライト」として出て、
 * 「全部消して」で照明コマンドを投げてしまう。**
 */
const NON_LIGHT_CODES: ReadonlyMap<number, string> = new Map([
    [0x1b, "BRIGHT_SENSOR（明るさセンサー）"],
    [0x1c, "HUMAN_SENSOR（人感センサー）"],
    [0x1d, "INTERFACE（インターフェース）"],
    [0x4a, "DONGLE（ドングル）"],
    [0x88, "INTERFACE（インターフェース）"],
]);

/** `UtilDeviceFW.isRGB(byte)` / `isCeilingSideRGB(byte)`。サイド RGB を持つ天井灯。 */
const SIDE_RGB_CODES: ReadonlySet<number> = new Set([0x18, 0x19, 0x56, 0x57]);

/** `UtilDeviceFW.isCeilingSideSpot(byte)`。スポットを持つ天井灯。 */
const SIDE_SPOT_CODES: ReadonlySet<number> = new Set([0x16, 0x17, 0x54, 0x55]);

export function isCeilingLight(productCode: number): boolean {
    return CEILING_LIGHT_CODES.has(productCode & 0xff);
}

export function isOnlyLightness(productCode: number): boolean {
    return ONLY_LIGHTNESS_CODES.has(productCode & 0xff);
}

export function isInterface(productCode: number): boolean {
    return INTERFACE_CODES.has(productCode & 0xff);
}

/** サイド RGB を持つか。⚠️ odelicd がサイド RGB を実装していないので Matter には出さない。 */
export function hasSideRgb(productCode: number): boolean {
    return SIDE_RGB_CODES.has(productCode & 0xff);
}

/** スポットを持つか。⚠️ odelicd が未実装なので Matter には出さない。 */
export function hasSideSpot(productCode: number): boolean {
    return SIDE_SPOT_CODES.has(productCode & 0xff);
}

/** 設定ファイルからの器具ごとの上書き。 */
export interface CapabilityOverride {
    /** true なら Matter に出さない。 */
    exclude?: boolean;
    /** デバイスタイプを固定する。 */
    deviceType?: MatterLightKind;
    /** 常夜灯対応の有無を固定する。 */
    nightLight?: boolean;
}

/**
 * 製品コードから能力を決める。
 *
 * `productCode` が `null`（Ping 応答も自己申告も未取得）のときは、
 * **最も一般的な調光調色として扱う**。手元の器具はすべて調光調色なので、
 * 未知を理由に器具を隠すほうが害が大きい。
 */
export function capabilityOf(productCode: number | null, override: CapabilityOverride = {}): Capability {
    const applied = (cap: Capability): Capability => {
        let out = cap;
        if (override.deviceType !== undefined && out.isLight) {
            out = { ...out, kind: override.deviceType, reason: `${out.reason} / 設定で ${override.deviceType} に固定` };
        }
        if (override.nightLight !== undefined) {
            out = { ...out, nightLight: override.nightLight, reason: `${out.reason} / 設定で常夜灯=${override.nightLight}` };
        }
        if (override.exclude === true) {
            out = { ...out, isLight: false, reason: `${out.reason} / 設定で除外` };
        }
        return out;
    };

    if (productCode === null) {
        return applied({
            isLight: true,
            kind: "colorTemperature",
            nightLight: false,
            reason: "製品コード未取得。調光調色として扱い、常夜灯は使わない",
        });
    }

    const code = productCode & 0xff;
    const nonLight = NON_LIGHT_CODES.get(code);
    if (nonLight !== undefined) {
        return applied({
            isLight: false,
            kind: "dimmable",
            nightLight: false,
            reason: `0x${code.toString(16).toUpperCase()} は ${nonLight} なので照明ではない`,
        });
    }

    const nightLight = isCeilingLight(code);
    const suffix = nightLight ? "天井灯タイプなので常夜灯に対応" : "天井灯ではないので専用常夜灯は非対応";

    if (isOnlyLightness(code)) {
        return applied({
            isLight: true,
            kind: "dimmable",
            nightLight,
            reason: `UtilDeviceFW.isOnlyLightness = true（調光のみ）。${suffix}`,
        });
    }

    return applied({
        isLight: true,
        kind: "colorTemperature",
        nightLight,
        reason: `調光調色として扱う（isOnlyLightness = false）。${suffix}`,
    });
}
