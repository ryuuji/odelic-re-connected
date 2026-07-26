/**
 * 設定の読み込みと既定値。
 *
 * 器具は odelicd が自動で見つけるので、設定に書くのは
 * **「名前」と「既定から外れる器具だけの上書き」**だけ。
 */

import { readFileSync } from "node:fs";

import {
    type CapabilityOverride,
    type MatterLightKind,
    normalizeMac,
    stripJsonComments,
} from "@odelic/common";
import type { ColorScale, LightScale } from "./mapping.js";

// ⭐ MAC の扱いと JSONC パーサは `@odelic/common` に移した（`odelic-web` と共有する。
//    ずれるとブリッジの器具名と Web のカードが一致しなくなる／設定例が片方でしか
//    読めなくなる）。呼び出し側を変えずに済むようここから re-export する
export { defaultFixtureName, isUnknownMac, normalizeMac, stripJsonComments } from "@odelic/common";

export interface FixtureConfig extends CapabilityOverride {
    /** Google Home に出す表示名。未指定なら MAC から自動生成する */
    name?: string;
}

export interface MatterConfig {
    /** テスト VID は 0xFFF1（65521）。⚠️ Google Home Developer Console への登録が必要 */
    vendorId: number;
    productId: number;
    port: number;
    passcode: number;
    discriminator: number;
    /** フェアリング情報の保存先。ここを消すと再 commissioning になる */
    storagePath: string;
    vendorName: string;
    productName: string;
}

/**
 * 設定ページ（`odelic-web`）が叩く管理 API。
 *
 * ⚠️⚠️ **無認証。**`127.0.0.1` 以外に bind しようとすると起動時にエラーで止まる。
 * 認証は `odelic-web` 側が持っている。
 */
export interface AdminApiConfig {
    enabled: boolean;
    /** ⚠️ localhost のみ */
    host: string;
    port: number;
}

export interface Config {
    /** odelicd の URL。⚠️ localhost に閉じる（odelicd は無認証） */
    odelicd: string;
    /** `GET /info` のポーリング間隔（ms）。BLE を使わないので短くて構わない */
    pollMs: number;
    /**
     * 定期的な状態要求の間隔（秒）。0 で無効。
     *
     * ⚠️ **これだけが定期的に BLE を消費する**（1 分に 1 通・往復 50〜78 ms）。
     * 壁スイッチでの変更を拾う唯一の手段。HCI ログを採取して通信を測るときは 0 にする。
     */
    statusRefreshSec: number;
    /**
     * これを超えて見えない器具をエンドポイントから外す（秒）。**0 で撤去しない（既定）**。
     *
     * ⚠️ 撤去は `endpoint.delete()` で**永続データを消す**ので `uniqueId` が変わり、
     * Google Home からは別デバイスになって部屋割り・名前・自動化が失われる。
     * 壁スイッチで消えている器具は odelicd から見えないのが通常状態なので、
     * 「見えない」を撤去の理由にしてはいけない。器具を本当に外したときは
     * 名簿（`<storagePath>/fixtures.json`）から該当行を消して再起動する。
     */
    missingGraceSec: number;
    /** odelicd の `?wait=` に渡す ms。0 なら収束を待たない */
    waitMs: number;
    /** 明るさと色温度を 1 通に合成する窓（ms） */
    debounceMs: number;
    /** 全器具が同じ指示なら `target=all` を 1 通にまとめる */
    coalesceAll: boolean;
    /** 明るさ軸の下端を常夜灯に割り当てる割合（%） */
    nightBandPercent: number;
    colorTempMinKelvin: number;
    colorTempMaxKelvin: number;
    colorTempInverted: boolean;
    matter: MatterConfig;
    /** ⭐ 設定ページ（odelic-web）向けの管理 API */
    admin: AdminApiConfig;
    /** キーは器具の MAC（大文字コロン区切り） */
    fixtures: Record<string, FixtureConfig>;
}

export const DEFAULT_CONFIG: Config = {
    odelicd: "http://127.0.0.1:8080",
    pollMs: 1000,
    // 壁スイッチでの変更を拾い、通電切れも検知する。⚠️ BLE を 30 秒に 1 通使う
    // （HCI ログを採取するときだけ 0 にする）
    statusRefreshSec: 30,
    // ⚠️ 0 = 撤去しない。器具の永続化のため（上のコメント参照）
    missingGraceSec: 0,
    waitMs: 1500,
    debounceMs: 120,
    coalesceAll: true,
    nightBandPercent: 30,
    colorTempMinKelvin: 2700,
    colorTempMaxKelvin: 6500,
    colorTempInverted: false,
    matter: {
        vendorId: 0xfff1,
        productId: 0x8001,
        port: 5540,
        passcode: 20202021,
        discriminator: 3840,
        storagePath: "/var/lib/odelic-matter",
        vendorName: "odelic-re-connected",
        productName: "ODELIC Mesh Bridge",
    },
    // ⚠️ 無認証なので localhost 固定。認証は odelic-web が持つ
    admin: { enabled: true, host: "127.0.0.1", port: 8081 },
    fixtures: {},
};

/**
 * エンドポイント id に使える形にする。matter.js はこれでエンドポイント番号を永続化する。
 *
 * ⚠️ **Matter 固有なので `@odelic/common` には置かない。**`odelic-web` は
 * エンドポイント番号を知る必要がない。
 */
export function macToEndpointId(mac: string): string {
    return `odelic-${normalizeMac(mac).replace(/:/g, "").toLowerCase()}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

const DEVICE_TYPES: readonly MatterLightKind[] = ["colorTemperature", "dimmable"];

/**
 * 設定ファイルを読む。
 *
 * ⚠️ 未知のキーは黙って捨てず警告する。設定の書き間違いが
 * 「なぜか反映されない」という形で出るのを避ける。
 */
export function loadConfig(path: string | undefined, warn: (msg: string) => void = console.warn): Config {
    if (path === undefined) return { ...DEFAULT_CONFIG };

    let raw: unknown;
    try {
        raw = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    } catch (e) {
        throw new Error(`設定ファイルを読めません (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isRecord(raw)) throw new Error(`設定ファイルの中身がオブジェクトではありません: ${path}`);

    const cfg: Config = {
        ...DEFAULT_CONFIG,
        matter: { ...DEFAULT_CONFIG.matter },
        admin: { ...DEFAULT_CONFIG.admin },
        fixtures: {},
    };

    for (const [key, value] of Object.entries(raw)) {
        switch (key) {
            case "odelicd":
                if (typeof value === "string") cfg.odelicd = value;
                else warn(`設定 odelicd は文字列で指定してください`);
                break;
            case "pollMs":
            case "statusRefreshSec":
            case "missingGraceSec":
            case "waitMs":
            case "debounceMs":
            case "nightBandPercent":
            case "colorTempMinKelvin":
            case "colorTempMaxKelvin":
                if (typeof value === "number" && Number.isFinite(value)) cfg[key] = value;
                else warn(`設定 ${key} は数値で指定してください`);
                break;
            case "coalesceAll":
            case "colorTempInverted":
                if (typeof value === "boolean") cfg[key] = value;
                else warn(`設定 ${key} は true / false で指定してください`);
                break;
            case "matter":
                if (isRecord(value)) Object.assign(cfg.matter, pickMatter(value, warn));
                else warn(`設定 matter はオブジェクトで指定してください`);
                break;
            case "admin":
                if (isRecord(value)) Object.assign(cfg.admin, pickAdmin(value, warn));
                else warn(`設定 admin はオブジェクトで指定してください`);
                break;
            case "fixtures":
                if (isRecord(value)) cfg.fixtures = pickFixtures(value, warn);
                else warn(`設定 fixtures はオブジェクトで指定してください`);
                break;
            default:
                warn(`設定に未知のキーがあります（無視します）: ${key}`);
        }
    }

    if (cfg.colorTempMinKelvin <= 0 || cfg.colorTempMaxKelvin <= 0) {
        throw new Error("colorTempMinKelvin / colorTempMaxKelvin は正の数で指定してください");
    }
    return cfg;
}

function pickMatter(raw: Record<string, unknown>, warn: (msg: string) => void): Partial<MatterConfig> {
    const out: Partial<MatterConfig> = {};
    for (const [key, value] of Object.entries(raw)) {
        switch (key) {
            case "vendorId":
            case "productId":
            case "port":
            case "passcode":
            case "discriminator":
                if (typeof value === "number" && Number.isInteger(value)) out[key] = value;
                else warn(`設定 matter.${key} は整数で指定してください`);
                break;
            case "storagePath":
            case "vendorName":
            case "productName":
                if (typeof value === "string") out[key] = value;
                else warn(`設定 matter.${key} は文字列で指定してください`);
                break;
            default:
                warn(`設定 matter に未知のキーがあります（無視します）: ${key}`);
        }
    }
    return out;
}

function pickAdmin(raw: Record<string, unknown>, warn: (msg: string) => void): Partial<AdminApiConfig> {
    const out: Partial<AdminApiConfig> = {};
    for (const [key, value] of Object.entries(raw)) {
        switch (key) {
            case "enabled":
                if (typeof value === "boolean") out.enabled = value;
                else warn("設定 admin.enabled は true / false で指定してください");
                break;
            case "host":
                // ⚠️ 値の妥当性（localhost かどうか）は AdminServer が起動時に見る。
                //    ここで黙って直すと「直したつもりが効いていない」になる
                if (typeof value === "string") out.host = value;
                else warn("設定 admin.host は文字列で指定してください");
                break;
            case "port":
                if (typeof value === "number" && Number.isInteger(value)) out.port = value;
                else warn("設定 admin.port は整数で指定してください");
                break;
            default:
                warn(`設定 admin に未知のキーがあります（無視します）: ${key}`);
        }
    }
    return out;
}

function pickFixtures(raw: Record<string, unknown>, warn: (msg: string) => void): Record<string, FixtureConfig> {
    const out: Record<string, FixtureConfig> = {};
    for (const [mac, value] of Object.entries(raw)) {
        if (!isRecord(value)) {
            warn(`設定 fixtures["${mac}"] はオブジェクトで指定してください`);
            continue;
        }
        const entry: FixtureConfig = {};
        for (const [key, v] of Object.entries(value)) {
            switch (key) {
                case "name":
                    if (typeof v === "string") entry.name = v;
                    else warn(`設定 fixtures["${mac}"].name は文字列で指定してください`);
                    break;
                case "exclude":
                case "nightLight":
                    if (typeof v === "boolean") entry[key] = v;
                    else warn(`設定 fixtures["${mac}"].${key} は true / false で指定してください`);
                    break;
                case "deviceType":
                    if (typeof v === "string" && (DEVICE_TYPES as readonly string[]).includes(v)) {
                        entry.deviceType = v as MatterLightKind;
                    } else {
                        warn(`設定 fixtures["${mac}"].deviceType は ${DEVICE_TYPES.join(" / ")} のいずれか`);
                    }
                    break;
                default:
                    warn(`設定 fixtures["${mac}"] に未知のキーがあります（無視します）: ${key}`);
            }
        }
        out[normalizeMac(mac)] = entry;
    }
    return out;
}

export function lightScaleOf(cfg: Config, nightLight: boolean): LightScale {
    return { nightBandPercent: cfg.nightBandPercent, nightLight };
}

export function colorScaleOf(cfg: Config): ColorScale {
    return {
        minKelvin: cfg.colorTempMinKelvin,
        maxKelvin: cfg.colorTempMaxKelvin,
        inverted: cfg.colorTempInverted,
    };
}
