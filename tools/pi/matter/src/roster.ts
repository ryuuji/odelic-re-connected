/**
 * 見つけた器具の名簿を永続化する。
 *
 * ## なぜ必要か
 *
 * ⚠️ **`odelicd` は器具一覧をメモリにしか持っていない。**再起動すると空になり、
 * 器具が接続してきて `_auto_discover` が走るまで復元されない。
 * そして**壁スイッチで消えている器具は接続してこないので永久に再発見されない。**
 *
 * 名簿が無いと、この状況で次のことが起きる。
 *
 * 1. 通電していない器具が `GET /info` に現れない
 * 2. ブリッジがエンドポイントを作らない（または撤去してしまう）
 * 3. `endpoint.delete()` は**永続データを消去する**ので `uniqueId` が失われる
 * 4. 後で通電すると**別の新しいデバイス**として Google Home に出る
 *    → 部屋割り・名前・自動化の設定が失われる
 *
 * → **一度見つけた器具はここに記録し、起動時にエンドポイントを復元する。**
 *   `odelicd` から見えていない器具は `Reachable = false` で出す（P4: 嘘をつかない）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeMac } from "./config.js";

/** 名簿の 1 件。エンドポイントを復元するのに必要な最小限。 */
export interface RosterEntry {
    /** 器具の MAC（大文字コロン区切り）。⭐ これが同一性の鍵 */
    mac: string;
    /** `GET /devices` の `product`（表示用） */
    product: string;
    /** `GET /devices` の `product_code`。能力判定に使う */
    productCode: number | null;
    version: string;
    /** 最後に `odelicd` から見えた時刻（ISO8601）。診断用 */
    lastSeen: string;
}

export interface Roster {
    version: 1;
    fixtures: RosterEntry[];
}

const EMPTY: Roster = { version: 1, fixtures: [] };

export function rosterPath(storagePath: string): string {
    return join(storagePath, "fixtures.json");
}

/**
 * 名簿を読む。無い・壊れている場合は空を返す（起動を止めない）。
 */
export function loadRoster(path: string, warn: (msg: string) => void = () => {}): Roster {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return { ...EMPTY, fixtures: [] };
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null) throw new Error("オブジェクトではない");
        const fixtures = (parsed as { fixtures?: unknown }).fixtures;
        if (!Array.isArray(fixtures)) throw new Error("fixtures が配列ではない");
        const out: RosterEntry[] = [];
        for (const f of fixtures) {
            if (typeof f !== "object" || f === null) continue;
            const e = f as Partial<RosterEntry>;
            if (typeof e.mac !== "string") continue;
            out.push({
                mac: normalizeMac(e.mac),
                product: typeof e.product === "string" ? e.product : "不明",
                productCode: typeof e.productCode === "number" ? e.productCode : null,
                version: typeof e.version === "string" ? e.version : "",
                lastSeen: typeof e.lastSeen === "string" ? e.lastSeen : "",
            });
        }
        return { version: 1, fixtures: out };
    } catch (err) {
        // ⚠️ 壊れていても起動は続ける。名簿は「あると嬉しい」ものであって必須ではない
        warn(`名簿を読めません（無視します）: ${path}: ${err instanceof Error ? err.message : String(err)}`);
        return { ...EMPTY, fixtures: [] };
    }
}

/**
 * 名簿を書く。
 *
 * ⚠️ 一時ファイルに書いて rename する。書き込み中に電源が落ちても
 * 名簿が半端な状態で残らないようにする（そうなると器具が消える）。
 */
export function saveRoster(path: string, roster: Roster, warn: (msg: string) => void = () => {}): boolean {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(roster, null, 2)}\n`, "utf8");
        renameSync(tmp, path);
        return true;
    } catch (err) {
        warn(`名簿を保存できません: ${path}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * 名簿に 1 件を反映する。変わっていなければ `false` を返す（無駄な書き込みを避ける）。
 *
 * `lastSeen` は比較に含めない。含めるとポーリングごとに書き込みが走る。
 */
export function upsert(roster: Roster, entry: Omit<RosterEntry, "lastSeen">, now: Date): boolean {
    const mac = normalizeMac(entry.mac);
    const found = roster.fixtures.find(f => f.mac === mac);
    const stamp = now.toISOString();
    if (found === undefined) {
        roster.fixtures.push({ ...entry, mac, lastSeen: stamp });
        roster.fixtures.sort((a, b) => a.mac.localeCompare(b.mac));
        return true;
    }
    const changed =
        found.product !== entry.product ||
        found.productCode !== entry.productCode ||
        found.version !== entry.version;
    found.product = entry.product;
    found.productCode = entry.productCode;
    found.version = entry.version;
    found.lastSeen = stamp;
    return changed;
}

/** 名簿から 1 件を消す。器具を本当に外したときだけ使う。 */
export function remove(roster: Roster, mac: string): boolean {
    const target = normalizeMac(mac);
    const before = roster.fixtures.length;
    roster.fixtures = roster.fixtures.filter(f => f.mac !== target);
    return roster.fixtures.length !== before;
}
