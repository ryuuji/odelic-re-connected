/**
 * `odelicd` の HTTP API の公開範囲。⚠️ **特権操作**。
 *
 * ## ⚠️⚠️ この API には認証が無い
 *
 * `odelicd` の HTTP API は誰でも叩ける。`POST /on` に鍵は要らない。
 * LAN に出すということは「**その LAN に居る誰でも照明を操作できる**」という意味。
 *
 * ⭐ **localhost 限定のままで、音声操作もスマホ操作も全部できる。**
 * Matter ブリッジも設定ページも `127.0.0.1` から叩いているため。
 * LAN に出す価値があるのは「別のマシンのスクリプトから直接叩きたい」ときだけ。
 *
 * → だから **既定は `local`**、切り替えは利用者が明示的に選んだときだけ。
 *
 * ## ⭐ 設計の要点
 *
 * 待ち受けアドレスは `/etc/default/odelicd`（0600 root）にあり、変更には
 * root と `odelicd` の再起動が要る。→ 専用ヘルパ `set-api.sh` を sudoers で許可する。
 *
 * ⚠️ ヘルパが受け付けるのは `--status` / `local` / `lan` の 3 つだけ。
 * **任意のアドレスは渡せない**（別ホストへの bind を作らせない）。
 */

import { execFile } from "node:child_process";

/** 公開範囲。⚠️ この 2 つ以外をヘルパに渡さない */
export type Scope = "local" | "lan";

export interface ApiScopeStatus {
    scope: Scope;
    /** 実際の待ち受けアドレス（`127.0.0.1` / `0.0.0.0`） */
    bind: string;
    /** `odelicd` の HTTP ポート。分からなければ `null` */
    port: number | null;
}

export interface ApiScopeResult {
    ok: boolean;
    detail: string;
}

export interface ApiScopeOptions {
    /** ヘルパのパス。⚠️ sudoers に書いたパスと 1 文字も違ってはいけない */
    helper: string;
    /** テスト用に差し替える */
    run?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
    log?: (msg: string) => void;
}

export function isScope(v: unknown): v is Scope {
    return v === "local" || v === "lan";
}

export class ApiScope {
    constructor(private readonly opts: ApiScopeOptions) {}

    /**
     * 今の公開範囲。
     *
     * ⚠️ 取れなかったときは `null` を返す（**`local` と嘘をつかない**）。
     * 「安全側の既定を表示する」と、実は LAN に出ているのに閉じて見える。
     */
    async status(): Promise<{ status: ApiScopeStatus | null; detail: string }> {
        const res = await this.invoke(["--status"]);
        // ⚠️⚠️ **理由を捨てない。**ここを `null` だけ返す作りにしていたため、
        //    画面には「読み取れませんでした」しか出ず、原因（sudoers の設定漏れ /
        //    ヘルパが古い / 設定ファイルが無い）に辿り着けなかった。
        if (!res.ok) {
            this.opts.log?.(`[!] set-api.sh --status が失敗: ${res.detail}`);
            return { status: null, detail: res.detail || "ヘルパを実行できませんでした" };
        }
        const scope = /scope=(\S+)/.exec(res.stdout)?.[1];
        const bind = /bind=(\S+)/.exec(res.stdout)?.[1];
        if (!isScope(scope) || bind === undefined) {
            const detail = `ヘルパの出力を解釈できません: ${res.stdout.trim().slice(0, 120)}`;
            this.opts.log?.(`[!] ${detail}`);
            return { status: null, detail };
        }
        const rawPort = /port=(\d+)/.exec(res.stdout)?.[1];
        return {
            status: { scope, bind, port: rawPort === undefined ? null : Number(rawPort) },
            detail: "",
        };
    }

    /**
     * 公開範囲を変える。⚠️ `odelicd` を再起動するので、器具が繋ぎ直すまで
     * 数秒（実測 約 5 秒）操作できない。
     */
    async set(scope: Scope): Promise<ApiScopeResult> {
        // ⚠️ ここを緩めない。ヘルパ側でも再検証している
        if (!isScope(scope)) return { ok: false, detail: "local か lan のどちらかです" };
        this.opts.log?.(
            scope === "lan"
                ? "⚠️ odelicd の API を LAN に公開します（この API に認証はありません）"
                : "odelicd の API を localhost 限定にします",
        );
        return this.invoke([scope]);
    }

    private async invoke(args: string[]): Promise<ApiScopeResult & { stdout: string }> {
        const runner = this.opts.run ?? ((a: string[]) => runSudo(this.opts.helper, a));
        try {
            const res = await runner(args);
            if (res.code !== 0) {
                return { ok: false, detail: res.stderr.trim() || `終了コード ${res.code}`, stdout: res.stdout };
            }
            return { ok: true, detail: res.stdout.trim(), stdout: res.stdout };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e), stdout: "" };
        }
    }
}

function runSudo(helper: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        // ⚠️ `-n` を付ける。パスワードを聞かれたら待たずに失敗させる
        execFile(
            "sudo",
            ["-n", helper, ...args],
            { timeout: 60_000, maxBuffer: 256 * 1024 },
            (err, stdout, stderr) => {
                const code =
                    err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
                resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
            },
        );
    });
}
