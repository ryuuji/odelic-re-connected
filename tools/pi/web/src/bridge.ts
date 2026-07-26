/**
 * Matter ブリッジの管理 API クライアント（`127.0.0.1:8081`）。
 *
 * ⚠️⚠️ **ブリッジが落ちていても照明は操作できなければならない。**
 * 器具名と Matter の状態はここから取るが、取れなければ**名前を既定名に落として続行する**。
 * ここを必須にすると、ブリッジが単一障害点になってしまう（docs/08 W1 で避けた構成）。
 *
 * 認証は `odelic-web` 側で済ませてある（管理 API 自体は localhost 限定で無認証）。
 */

export interface BridgeFixture {
    mac: string;
    name: string;
    /** 設定で明示された名前か（false なら MAC からの既定名） */
    named: boolean;
    product: string;
    productCode: number | null;
    version: string;
    nightLight: boolean;
    deviceType: string;
    reason: string;
    reachable: boolean;
    /** 名簿にあるが odelicd から見えていない */
    inRosterOnly: boolean;
    endpointId: string;
}

export interface BridgeCommissioning {
    commissioned: boolean;
    manualPairingCode: string | null;
    qrPairingCode: string | null;
    /** ⭐ matter.js が作る文字ブロックの QR。UI は <pre> で描くだけ */
    qrText: string | null;
    fabrics: Array<{ index: number; label: string; vendorId: number }>;
    /** 追加の登録を受け付けているか（multi-admin） */
    windowOpen: boolean;
    /** 受付が閉じるまでの秒数。⚠️ 分からないことがある（`null`） */
    windowRemainingSec: number | null;
    commissionedAt: string | null;
}

export interface BridgeState {
    version: string;
    uptimeSec: number;
    fixtures: BridgeFixture[];
    commissioning: BridgeCommissioning;
    odelicdReachable: boolean;
}

export interface BridgeSettings {
    nightBandPercent: number;
    colorTempMinKelvin: number;
    colorTempMaxKelvin: number;
    colorTempInverted: boolean;
    statusRefreshSec: number;
    waitMs: number;
    debounceMs: number;
    coalesceAll: boolean;
}

/** ブリッジの応答。⚠️ 届かないときは `reachable: false` を返し、例外にしない。 */
export interface BridgeResult<T> {
    reachable: boolean;
    status: number;
    ok: boolean;
    data: T | null;
    detail: string;
}

export class BridgeClient {
    constructor(
        private readonly baseUrl: string,
        private readonly log?: (msg: string) => void,
    ) {}

    state(): Promise<BridgeResult<BridgeState>> {
        return this.request<BridgeState>("GET", "/admin/state");
    }

    settings(): Promise<BridgeResult<BridgeSettings>> {
        return this.request<BridgeSettings>("GET", "/admin/config");
    }

    updateSettings(patch: Partial<BridgeSettings>): Promise<BridgeResult<{ needsRestart: string[] }>> {
        return this.request("POST", "/admin/config", patch);
    }

    commissioning(): Promise<BridgeResult<BridgeCommissioning>> {
        return this.request<BridgeCommissioning>("GET", "/admin/commissioning");
    }

    openCommissioning(seconds: number): Promise<BridgeResult<BridgeCommissioning>> {
        return this.request("POST", "/admin/commissioning/open", { seconds });
    }

    /** ⭐ 受け付けをやめる。⚠️ 開いていなくても 200（目的は達成されているので失敗にしない）。 */
    closeCommissioning(): Promise<BridgeResult<BridgeCommissioning>> {
        return this.request("POST", "/admin/commissioning/close");
    }

    /** ⚠️ ブリッジは `{ok, detail}` しか返さない（更新後の器具は `/admin/state` で取り直す）。 */
    renameFixture(mac: string, name: string): Promise<BridgeResult<{ ok: boolean; detail: string }>> {
        return this.request("POST", `/admin/fixtures/${encodeURIComponent(mac)}/name`, { name });
    }

    removeFixture(mac: string): Promise<BridgeResult<{ removed: boolean }>> {
        return this.request("DELETE", `/admin/fixtures/${encodeURIComponent(mac)}`);
    }

    /** ⚠️ commissioning 直後は 409 で拒否される（Nest ハブが器具を失うため）。 */
    restart(): Promise<BridgeResult<{ restarting: boolean }>> {
        return this.request("POST", "/admin/restart");
    }

    /** ⚠️⚠️ 破壊的。フェアリング情報を消して未 commissioning に戻す。 */
    factoryReset(confirm: string): Promise<BridgeResult<{ reset: boolean }>> {
        return this.request("POST", "/admin/factory-reset", { confirm });
    }

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        timeoutMs = 8000,
    ): Promise<BridgeResult<T>> {
        let res: Response;
        try {
            res = await fetch(new URL(path, this.baseUrl), {
                method,
                signal: AbortSignal.timeout(timeoutMs),
                ...(body === undefined
                    ? {}
                    : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            // ⚠️ ここでは頻繁にログしない。ブリッジが止まっているのは異常ではあるが、
            //    画面を開くたびに journal を埋めても仕方がない
            return { reachable: false, status: 0, ok: false, data: null, detail };
        }
        let data: unknown = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }
        const detail =
            typeof data === "object" && data !== null && typeof (data as { detail?: unknown }).detail === "string"
                ? (data as { detail: string }).detail
                : `HTTP ${res.status}`;
        if (!res.ok) this.log?.(`[!] ブリッジ管理 API ${method} ${path}: ${detail}`);
        return { reachable: true, status: res.status, ok: res.ok, data: res.ok ? (data as T) : null, detail };
    }
}
