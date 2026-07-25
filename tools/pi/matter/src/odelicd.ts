/**
 * odelicd の HTTP API クライアント。
 *
 * ⭐ **odelicd 側は一切変更しない。**既存のエンドポイントだけを使う。
 *
 * ## BLE を使うエンドポイントと使わないエンドポイント
 *
 * | | BLE |
 * | --- | --- |
 * | `GET /` `/info` `/devices` `/metrics` | **使わない**（キャッシュを読むだけ） |
 * | `POST /on` `/off` `/level` `/night` | 1 通 |
 * | `POST /status` `/ping` `/discover` | 1 通 |
 *
 * ポーリングは `GET /info` だけを使うので、**定常状態では BLE を一切増やさない**。
 * これは接続ログを採取している最中でもブリッジを動かせるということ。
 */

/** `GET /info` の `devices[]` の 1 台分。odelicd.py の `Device.to_dict()` に対応。 */
export interface OdelicDevice {
    /** API で器具を指定するキー。vAddr の 16 進。⚠️ 同一性には使えない（変わり得る） */
    key: string;
    /** `EC:C5:7F:81:DE:CD` 形式。未取得なら `00:00:00:00:00:00`。⭐ 同一性はこれで取る */
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
    status_raw: string | null;
    last_seen: number;
}

/** `GET /info` のうちブリッジが使う部分。 */
export interface OdelicInfo {
    connected: boolean;
    joined: boolean;
    own_vaddr: string | null;
    device_num: number | null;
    devices_found: number;
    devices: OdelicDevice[];
    live_links: string[];
    primary_mac: string | null;
    queued: number;
    uptime_sec: number;
}

/**
 * `GET /metrics` のうちブリッジが使う部分。
 *
 * ⭐ `delivery[<vAddr>].absent` は odelicd が「状態要求に 3 回連続で応答がない」器具に
 * 立てるフラグ。**電源が落ちている器具を見分ける唯一の手段**（odelicd は一度見つけた
 * 器具を `devices` から削除しないので、`/info` に居ることは生きている証拠にならない）。
 */
export interface OdelicMetrics {
    delivery: Record<string, { ewma: number; n: number; absent: boolean }>;
}

/** 操作の対象。odelicd の `?target=` に渡す文字列と 1:1。 */
export type OdelicTarget = "all" | `group:${number}` | `dev:${string}`;

export function deviceTarget(device: OdelicDevice): OdelicTarget {
    return `dev:${device.key}`;
}

/**
 * 操作の結果。
 *
 * ⭐ odelicd の HTTP ステータスをそのまま意味に写す（docs/03-instability.md P4）。
 * 「送った」と「効いた」を混ぜない。
 */
export type CommandOutcome =
    | { ok: true; detail: string; info: OdelicInfo | null }
    /** 未接続。odelicd のキューに入った（HTTP 503） */
    | { ok: false; reason: "queued"; detail: string; info: OdelicInfo | null }
    /** 送ったが期待どおりの状態を確認できなかった（HTTP 504） */
    | { ok: false; reason: "timeout"; detail: string; info: OdelicInfo | null }
    /** odelicd が拒否した（HTTP 4xx / 500） */
    | { ok: false; reason: "error"; detail: string; info: OdelicInfo | null }
    /** odelicd 自体に届かない（プロセスが落ちている等） */
    | { ok: false; reason: "unreachable"; detail: string; info: null };

export interface OdelicClientOptions {
    /** 既定 `http://127.0.0.1:8080` */
    baseUrl: string;
    /**
     * `?wait=` に渡すミリ秒。0 なら収束を待たずに即応答をもらう。
     *
     * ⭐ 既定 1500。実測の収束は 277〜320 ms（docs C33）なので余裕があり、
     * Matter の invoke 応答が「本当にその状態になった」を意味するようになる。
     */
    waitMs: number;
    /** ログ出力。 */
    log?: (msg: string) => void;
}

const DEFAULTS: OdelicClientOptions = {
    baseUrl: "http://127.0.0.1:8080",
    waitMs: 1500,
};

export class OdelicClient {
    readonly options: OdelicClientOptions;

    constructor(options: Partial<OdelicClientOptions> = {}) {
        this.options = { ...DEFAULTS, ...options };
    }

    private log(msg: string): void {
        this.options.log?.(msg);
    }

    private url(path: string, params: Record<string, string | number | undefined> = {}): string {
        const u = new URL(path, this.options.baseUrl);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) u.searchParams.set(k, String(v));
        }
        return u.toString();
    }

    /**
     * 現在の状態を取る。⭐ **BLE を使わない。**
     *
     * `GET /info` は `devices` と `connected` の両方を返すので 1 リクエストで足りる。
     */
    async info(timeoutMs = 4000): Promise<OdelicInfo | null> {
        // ⚠️ ここでは失敗をログしない。1 秒ごとに呼ばれるので journal が埋まる。
        //    「届かない」の報告は呼び出し側（Bridge）が状態変化のときだけ出す
        try {
            const res = await fetch(this.url("/info"), { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) return null;
            return (await res.json()) as OdelicInfo;
        } catch {
            return null;
        }
    }

    /**
     * 電源が落ちている器具の vAddr キー集合を返す。⭐ **BLE を使わない。**
     *
     * ⚠️ `absent` は状態要求の応答から判定されるので、`statusRefreshSec = 0` だと
     * 更新されない（操作したときだけ動く）。
     */
    async absentKeys(timeoutMs = 4000): Promise<Set<string> | null> {
        try {
            const res = await fetch(this.url("/metrics"), { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) return null;
            const m = (await res.json()) as OdelicMetrics;
            const out = new Set<string>();
            for (const [key, v] of Object.entries(m.delivery ?? {})) {
                if (v.absent) out.add(key.toUpperCase());
            }
            return out;
        } catch {
            return null;
        }
    }

    /** 直近の失敗理由を人間向けに説明する（診断用）。 */
    async describeReachability(): Promise<string> {
        try {
            const res = await fetch(this.url("/info"), { signal: AbortSignal.timeout(3000) });
            return res.ok ? "OK" : `HTTP ${res.status}`;
        } catch (e) {
            return describeError(e);
        }
    }

    /** 操作系の共通処理。odelicd のステータスコードを `CommandOutcome` に写す。 */
    private async post(
        path: string,
        params: Record<string, string | number | undefined>,
        waitMs: number,
    ): Promise<CommandOutcome> {
        const wait = waitMs > 0 ? { wait: 1, timeout: waitMs } : {};
        const url = this.url(path, { ...params, ...wait });
        // ⚠️ odelicd は ?wait= の間ブロックする。クライアント側は必ずそれより長く待つ
        const timeoutMs = Math.max(4000, waitMs + 2500);

        let res: Response;
        try {
            res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            const detail = describeError(e);
            this.log(`[!] POST ${path} に失敗: ${detail}`);
            return { ok: false, reason: "unreachable", detail, info: null };
        }

        let body: { ok?: boolean; detail?: string } & Partial<OdelicInfo>;
        try {
            body = (await res.json()) as typeof body;
        } catch {
            body = {};
        }
        // ⭐ 操作の応答に最新の器具状態が入っている。次のポーリングを待たずに反映できる
        const info = body.devices !== undefined ? (body as unknown as OdelicInfo) : null;
        const detail = body.detail ?? `HTTP ${res.status}`;

        if (res.ok && body.ok !== false) return { ok: true, detail, info };
        if (res.status === 503) return { ok: false, reason: "queued", detail, info };
        if (res.status === 504) return { ok: false, reason: "timeout", detail, info };
        return { ok: false, reason: "error", detail, info };
    }

    /** ON / OFF。⭐ ON は器具が記憶していた明るさに戻す（`37 37`）。 */
    setOn(target: OdelicTarget, on: boolean, waitMs = this.options.waitMs): Promise<CommandOutcome> {
        return this.post(on ? "/on" : "/off", { target }, waitMs);
    }

    /**
     * 明るさと色温度。
     *
     * ⚠️ **必ず両方を一緒に送る。**プロトコルが 1 コマンドで両方を運ぶ（`0xC0` sub 0）ので、
     * 片方だけ送るともう片方が意図しない値で上書きされる。
     * `bright` は 5 の倍数で 5〜100、`color` は 5 の倍数で 0〜100（mapping.ts が保証する）。
     */
    setLevel(
        target: OdelicTarget,
        bright: number,
        color: number,
        waitMs = this.options.waitMs,
    ): Promise<CommandOutcome> {
        return this.post("/level", { target, bright, color }, waitMs);
    }

    /** 常夜灯。`level` は 0 / 1 / 2 で 0 が最も明るい。 */
    setNight(target: OdelicTarget, level: 0 | 1 | 2, waitMs = this.options.waitMs): Promise<CommandOutcome> {
        return this.post("/night", { target, level }, waitMs);
    }

    /**
     * 状態を要求する。⚠️ **BLE を 1 通使う。**
     *
     * 壁スイッチでの変更を拾う唯一の手段だが、接続ログの採取中は呼ばない。
     */
    requestStatus(target?: OdelicTarget): Promise<CommandOutcome> {
        return this.post("/status", { target }, 0);
    }

    /** Ping（暗号化・チャネル 0xFE）。応答で器具の MAC / vAddr / 機種が埋まる。 */
    ping(): Promise<CommandOutcome> {
        return this.post("/ping", {}, 0);
    }

    /** 器具の探索（MSGID 0x02 / 0xD0）。応答で製品コードとグループ ID が埋まる。 */
    discover(): Promise<CommandOutcome> {
        return this.post("/discover", {}, 0);
    }
}

function describeError(e: unknown): string {
    if (e instanceof Error) {
        // AbortSignal.timeout は TimeoutError を投げる
        if (e.name === "TimeoutError") return "タイムアウト";
        const cause = (e as { cause?: { code?: string } }).cause;
        if (cause?.code === "ECONNREFUSED") return "odelicd に接続できない（ECONNREFUSED）";
        return `${e.name}: ${e.message}`;
    }
    return String(e);
}
