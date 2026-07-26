/**
 * `odelicd` の HTTP API クライアント（Web 用）。
 *
 * ⭐ **odelicd 側は一切変更しない。**既存のエンドポイントだけを使う。
 * ⭐ **照明の操作はここを通る。**ブリッジを経由しないので、Matter ブリッジが
 *    落ちていてもスマホから照明を操作できる（docs/08 W1）。
 *
 * ⚠️ ブリッジの `odelicd.ts` とは目的が違う（あちらは Matter の状態機械に合わせて
 *    `CommandOutcome` に畳む）。ここは **HTTP の応答をほぼそのまま UI に渡す**のが仕事。
 */

/** `GET /info` の `devices[]` の 1 台分。odelicd.py の `Device.to_dict()` に対応。 */
export interface OdelicDevice {
    /** API で器具を指定するキー（vAddr の 16 進）。⚠️ 同一性には使えない */
    key: string;
    /** `EC:C5:7F:81:DE:CD` 形式。未取得なら `00:00:00:00:00:00`。⭐ 同一性はこれ */
    mac: string;
    vaddr: string;
    product_code: number | null;
    product: string;
    group_id: number | null;
    version: string;
    on: boolean | null;
    bright: number | null;
    color: number | null;
    night_on: boolean | null;
    /** 器具が返す常夜灯の値。0 = 消灯 / 1〜3（3 が最も明るい） */
    night: number | null;
    night_level: number | null;
    state_updated_at: number | null;
    last_seen: number;
}

export interface OdelicInfo {
    /** `odelicd` 自身のバージョン。⚠️ 古い odelicd は返さないので `undefined` を許す */
    version?: string;
    connected: boolean;
    joined: boolean;
    own_vaddr: string | null;
    device_num: number | null;
    devices_found: number;
    devices: OdelicDevice[];
    live_links: string[];
    primary_mac: string | null;
    link_held_sec: number | null;
    queued: number;
    uptime_sec: number;
    [key: string]: unknown;
}

export interface OdelicMetrics {
    delivery?: Record<string, { ewma: number; n: number; absent: boolean }>;
    [key: string]: unknown;
}

/** 操作の対象。odelicd の `?target=` に渡す文字列と 1:1。 */
export type OdelicTarget = "all" | `group:${number}` | `dev:${string}`;

/** ⚠️ UI から来た文字列をそのまま odelicd に渡さない。ここで形を検証する。 */
export function parseTarget(raw: string | null | undefined): OdelicTarget | null {
    if (raw === null || raw === undefined || raw === "" || raw === "all") return "all";
    let m = /^group:(\d{1,3})$/.exec(raw);
    if (m !== null) return `group:${Number(m[1])}`;
    m = /^dev:([0-9A-Fa-f ]{1,32})$/.exec(raw);
    if (m !== null) return `dev:${m[1]!.toUpperCase()}`;
    return null;
}

/** odelicd からの応答。⭐ HTTP ステータスをそのまま UI まで運ぶ（P4: 嘘をつかない）。 */
export interface OdelicResponse {
    /** odelicd に届かなかったときは 0 */
    status: number;
    ok: boolean;
    detail: string;
    /** 操作系の応答には最新の器具状態が入っている */
    info: OdelicInfo | null;
}

export interface OdelicClientOptions {
    baseUrl: string;
    waitMs: number;
    log?: (msg: string) => void;
}

export class OdelicClient {
    constructor(private readonly options: OdelicClientOptions) {}

    private url(path: string, params: Record<string, string | number | undefined> = {}): string {
        const u = new URL(path, this.options.baseUrl);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) u.searchParams.set(k, String(v));
        }
        return u.toString();
    }

    /** `GET /info`。⭐ BLE を使わない（キャッシュを読むだけ）。 */
    async info(timeoutMs = 4000): Promise<OdelicInfo | null> {
        return this.getJson<OdelicInfo>("/info", timeoutMs);
    }

    /** `GET /metrics`。⭐ BLE を使わない。`delivery[].absent` が通電切れの判定。 */
    async metrics(timeoutMs = 4000): Promise<OdelicMetrics | null> {
        return this.getJson<OdelicMetrics>("/metrics", timeoutMs);
    }

    private async getJson<T>(path: string, timeoutMs: number): Promise<T | null> {
        try {
            const res = await fetch(this.url(path), { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) return null;
            return (await res.json()) as T;
        } catch {
            return null;
        }
    }

    /**
     * 操作を送る。
     *
     * ⭐ 既定で `?wait=1` を付ける。「送った」ではなく**「効いた」を確認してから**
     * UI に成功を出すため（docs/03 P4）。
     */
    async command(
        path: "/on" | "/off" | "/level" | "/night" | "/status" | "/ping" | "/discover",
        params: Record<string, string | number | undefined>,
        waitMs = this.options.waitMs,
    ): Promise<OdelicResponse> {
        const wait = waitMs > 0 ? { wait: 1, timeout: waitMs } : {};
        // ⚠️ odelicd は ?wait= の間ブロックする。こちらは必ずそれより長く待つ
        const timeoutMs = Math.max(4000, waitMs + 2500);
        let res: Response;
        try {
            res = await fetch(this.url(path, { ...params, ...wait }), {
                method: "POST",
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const detail = describeError(e);
            this.options.log?.(`[!] POST ${path} に失敗: ${detail}`);
            return { status: 0, ok: false, detail, info: null };
        }

        let body: { ok?: boolean; detail?: string } & Partial<OdelicInfo>;
        try {
            body = (await res.json()) as typeof body;
        } catch {
            body = {};
        }
        const info = body.devices !== undefined ? (body as unknown as OdelicInfo) : null;
        return {
            status: res.status,
            ok: res.ok && body.ok !== false,
            detail: body.detail ?? `HTTP ${res.status}`,
            info,
        };
    }
}

/** ⭐ odelicd の HTTP ステータスを人間向けの説明にする。UI にそのまま出す。 */
export function describeOutcome(res: OdelicResponse): string {
    if (res.ok) return "反映しました";
    if (res.status === 0) return `odelicd に届きません（${res.detail}）`;
    if (res.status === 503) return "器具に繋がっていないので、接続したときに送ります";
    if (res.status === 504) return "送りましたが、器具がその状態になったことを確認できませんでした";
    return `odelicd が拒否しました（${res.detail}）`;
}

function describeError(e: unknown): string {
    if (e instanceof Error) {
        if (e.name === "TimeoutError") return "タイムアウト";
        const cause = (e as { cause?: { code?: string } }).cause;
        if (cause?.code === "ECONNREFUSED") return "odelicd に接続できない（ECONNREFUSED）";
        return `${e.name}: ${e.message}`;
    }
    return String(e);
}
