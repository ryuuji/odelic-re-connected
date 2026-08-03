/**
 * `odelicd` の `GET /info` の器具一覧を **MAC ごとに 1 台へ畳む**。
 * `odelic-matter` と `odelic-web` の両方が同じ判断をしないと表示が食い違うので共有する。
 *
 * ## ⚠️ なぜ必要か（C34）
 *
 * `odelicd` の器具一覧のキーは vAddr だが、**同じ器具が別の vAddr でも見えることがある**
 * （他のリモコンがメッシュに繋がっているときに実機で観測）。すると 1 台が 2 台に増え、
 * 片方は永久に状態要求へ応答しないので到達率 0% → `absent` になる。
 *
 * `absent` は「通電が切れた器具」の唯一の判定手段なので、畳まずに使うと
 * **生きている器具を「反応なし・状態不明」と表示してしまう。**
 * odelicd 側でも束ねているが（`vaddr_alias`）、
 * 古い odelicd や再起動前の状態でも嘘をつかないよう、受け取る側でも畳む。
 *
 * ⭐ 残すのは「応答している方」。同一性は MAC（[[mac.ts]] と同じ原則）。
 */

import { normalizeMac } from "./mac.js";

/** 畳むのに必要な最小限。`OdelicDevice` はこれを満たす（両サービスで型が別々なので構造で受ける）。 */
export interface MacKeyedDevice {
    /** vAddr の 16 進。`absent` の判定キー */
    key: string;
    mac: string;
    state_updated_at?: number | null;
    last_seen?: number;
}

/**
 * MAC が重複する器具を 1 台に畳む。順序は入力のまま（最初に現れた位置を保つ）。
 *
 * 優先順位は
 *   1. `absent` でない（＝状態要求に応答している）
 *   2. 状態が新しい（`state_updated_at`）
 *   3. 最後に見えたのが新しい（`last_seen`）
 *
 * @param absent 到達率が 0 になった vAddr キーの集合（`/metrics` の `delivery[].absent`）
 */
export function foldDevicesByMac<T extends MacKeyedDevice>(
    devices: readonly T[],
    absent: ReadonlySet<string> = new Set(),
): T[] {
    const isAbsent = (d: T): boolean => absent.has(d.key.toUpperCase());
    const rank = (d: T): [number, number, number] => [
        isAbsent(d) ? 0 : 1,
        d.state_updated_at ?? 0,
        d.last_seen ?? 0,
    ];
    const better = (a: T, b: T): boolean => {
        const [x, y] = [rank(a), rank(b)];
        for (let i = 0; i < x.length; i++) {
            if (x[i]! !== y[i]!) return x[i]! > y[i]!;
        }
        return false;
    };

    const at = new Map<string, number>();
    const out: T[] = [];
    for (const d of devices) {
        const mac = normalizeMac(d.mac);
        const i = at.get(mac);
        if (i === undefined) {
            at.set(mac, out.length);
            out.push(d);
        } else if (better(d, out[i]!)) {
            out[i] = d;
        }
    }
    return out;
}

/**
 * 畳んだ結果、捨てられた器具のキー。⭐ ログに出して気づけるようにするため。
 *
 * ⚠️ 「消えた器具」ではない。**同じ 1 台が別の vAddr でも見えていた**ぶん。
 */
export function foldedAwayKeys<T extends MacKeyedDevice>(
    devices: readonly T[],
    kept: readonly T[],
): string[] {
    const keep = new Set(kept.map(d => d.key));
    return devices.filter(d => !keep.has(d.key)).map(d => d.key);
}