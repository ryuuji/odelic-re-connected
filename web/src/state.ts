/**
 * 画面に出す状態の組み立て。
 *
 * ## ⭐ 段の計算はここ（サーバ側）で完結させる
 *
 * ブラウザには**段のラベルの配列と現在の添字**だけを渡し、操作は
 * 「何段目にしたか」を送り返してもらう。ブラウザ側に段の定義を持たせない。
 *
 * ⚠️ 段の定義（常夜灯 3 段 + 主灯 20 段）は `@odelic/common` の `ladder()` が唯一の正で、
 * `odelic-matter` も同じものを見ている。**二重に持つと必ずずれる。**
 *
 * ## ⚠️ 3 つの情報源を混ぜる
 *
 * | 出所 | 使うもの |
 * | --- | --- |
 * | `odelicd` `GET /info` | 器具一覧・状態・接続 |
 * | `odelicd` `GET /metrics` | ⭐ `delivery[key].absent`（**通電切れの唯一の判定手段**） |
 * | ブリッジ `GET /admin/state` | 器具名（⚠️ 取れなくても続行する） |
 *
 * ⚠️ `odelicd` は一度見つけた器具を `devices` から削除しない。
 * **`/info` に居ることは生きている証拠にならない**（docs/07 M6-4）。
 *
 * ⚠️ さらに **同じ器具が 2 つの vAddr で並ぶことがある**（C34）。
 * `foldDevicesByMac()` で MAC ごとに 1 台へ畳んでから使う。
 */

import {
    type Capability,
    type Rung,
    capabilityOf,
    defaultFixtureName,
    describeRung,
    foldDevicesByMac,
    isUnknownMac,
    ladder,
    normalizeMac,
    rungIndexOfState,
} from "@odelic/common";

import type { BridgeState } from "./bridge.js";
import type { OdelicInfo, OdelicMetrics } from "./odelicd.js";

export interface UiRung {
    kind: "night" | "main";
    /** 「常夜灯（暗）」「40%」など */
    label: string;
    level?: number;
    bright?: number;
}

export interface UiFixture {
    /** `?target=dev:` に渡すキー */
    key: string;
    mac: string;
    name: string;
    product: string;
    productCode: number | null;
    groupId: number | null;
    version: string;
    vaddr: string;
    capability: Capability;
    /** ⭐ 操作してよいか（繋がっていて、通電が切れていない） */
    online: boolean;
    /** odelicd が「3 回連続で応答なし」と判断している */
    absent: boolean;
    on: boolean | null;
    bright: number | null;
    color: number | null;
    night: number | null;
    stateUpdatedAt: number | null;
    lastSeen: number;
    /** 暗い順の段。⭐ スライダーはこの配列の添字を使う（`-1` = 消灯） */
    rungs: UiRung[];
    /** 現在の段。⚠️ 状態が分からなければ `null`（適当な段を返さない・P4） */
    rungIndex: number | null;
    /** 器具名がブリッジの設定で明示されているか */
    named: boolean;
}

export interface UiState {
    odelicdReachable: boolean;
    connected: boolean;
    joined: boolean;
    ownVaddr: string | null;
    queued: number;
    uptimeSec: number;
    primaryMac: string | null;
    liveLinks: string[];
    linkHeldSec: number | null;
    bridge: { reachable: boolean; commissioned: boolean };
    fixtures: UiFixture[];
    /** 「すべて」カードの段。⚠️ 全器具が常夜灯対応のときだけ常夜灯の段を含める */
    allRungs: UiRung[];
    /** 操作できる器具が 1 台もないときの理由（UI にそのまま出す） */
    unavailableReason: string | null;
}

function toUiRung(r: Rung): UiRung {
    return r.kind === "night"
        ? { kind: "night", label: describeRung(r), level: r.level }
        : { kind: "main", label: describeRung(r), bright: r.bright };
}

export function uiLadder(nightLight: boolean): UiRung[] {
    return ladder(nightLight).map(toUiRung);
}

/** 段の添字から、実際に odelicd へ送る内容を決める。⚠️ `-1` は消灯。 */
export type LightCommand =
    | { kind: "off" }
    | { kind: "night"; level: 0 | 1 | 2 }
    | { kind: "main"; bright: number };

export function commandForRung(nightLight: boolean, index: number): LightCommand | null {
    if (index < 0) return { kind: "off" };
    const rungs = ladder(nightLight);
    const rung = rungs[index];
    if (rung === undefined) return null;
    return rung.kind === "night" ? { kind: "night", level: rung.level } : { kind: "main", bright: rung.bright };
}

/**
 * 3 つの情報源から画面用の状態を作る。
 *
 * @param info `null` なら odelicd に届いていない
 * @param metrics `null` でも続行する（`absent` が分からないだけ）
 * @param bridge `null` でも続行する（⭐ 名前が既定名に落ちるだけ。ブリッジを単一障害点にしない）
 */
export function buildState(
    info: OdelicInfo | null,
    metrics: OdelicMetrics | null,
    bridge: BridgeState | null,
): UiState {
    if (info === null) {
        return {
            odelicdReachable: false,
            connected: false,
            joined: false,
            ownVaddr: null,
            queued: 0,
            uptimeSec: 0,
            primaryMac: null,
            liveLinks: [],
            linkHeldSec: null,
            bridge: { reachable: bridge !== null, commissioned: bridge?.commissioning.commissioned ?? false },
            fixtures: [],
            allRungs: [],
            // ⭐ 家族も見る画面なので、内部の名前はカッコに落とす（消しはしない。調べるときに要る）
            unavailableReason: "照明サーバ（odelicd）に届いていません",
        };
    }

    const absent = new Set<string>();
    for (const [key, v] of Object.entries(metrics?.delivery ?? {})) {
        if (v.absent) absent.add(key.toUpperCase());
    }
    const names = new Map<string, { name: string; named: boolean }>();
    for (const f of bridge?.fixtures ?? []) {
        names.set(normalizeMac(f.mac), { name: f.name, named: f.named });
    }

    const fixtures: UiFixture[] = [];
    // ⚠️ 同じ器具が別の vAddr で二重に見えることがある（C34）。畳まないと
    //    同じ照明のカードが 2 枚並び、片方は「反応なし」と嘘をつく
    for (const d of foldDevicesByMac(info.devices, absent)) {
        const mac = normalizeMac(d.mac);
        // ⚠️ MAC 未取得の器具はカードを作れない（同一性が取れないので名前も付かない）
        if (isUnknownMac(mac)) continue;
        const cap = capabilityOf(d.product_code);
        // ⭐ センサー等は照明として出さない
        if (!cap.isLight) continue;

        const isAbsent = absent.has(d.key.toUpperCase());
        const online = info.connected && !isAbsent;
        const named = names.get(mac);
        const rungs = uiLadder(cap.nightLight);
        fixtures.push({
            key: d.key,
            mac,
            name: named?.name ?? defaultFixtureName(mac),
            named: named?.named ?? false,
            product: d.product,
            productCode: d.product_code,
            groupId: d.group_id,
            version: d.version,
            vaddr: d.vaddr,
            capability: cap,
            online,
            absent: isAbsent,
            on: d.on,
            bright: d.bright,
            color: d.color,
            night: d.night,
            stateUpdatedAt: d.state_updated_at,
            lastSeen: d.last_seen,
            rungs,
            // ⚠️ 通電が切れている器具の状態は信用できない。段も出さない（P4: 嘘をつかない）
            rungIndex: online ? rungIndexOfState({ on: d.on, bright: d.bright, night: d.night }, cap.nightLight) : null,
        });
    }
    fixtures.sort((a, b) => a.name.localeCompare(b.name, "ja"));

    // ⚠️ 1 台でも常夜灯に対応しない器具があれば、一斉操作の段に常夜灯を含めない。
    //    含めると `/night` が非対応の器具にも飛ぶ
    const allNight = fixtures.length > 0 && fixtures.every(f => f.capability.nightLight);

    let unavailable: string | null = null;
    if (fixtures.length === 0) {
        unavailable = info.connected ? "器具がまだ見つかっていません" : "器具に繋がっていません（接続を待っています）";
    } else if (!info.connected) {
        unavailable = "器具に繋がっていません。操作は接続できたときに送られます";
    }

    return {
        odelicdReachable: true,
        connected: info.connected,
        joined: info.joined,
        ownVaddr: info.own_vaddr,
        queued: info.queued,
        uptimeSec: info.uptime_sec,
        primaryMac: info.primary_mac,
        liveLinks: info.live_links ?? [],
        linkHeldSec: info.link_held_sec ?? null,
        bridge: { reachable: bridge !== null, commissioned: bridge?.commissioning.commissioned ?? false },
        fixtures,
        allRungs: uiLadder(allNight),
        unavailableReason: unavailable,
    };
}
