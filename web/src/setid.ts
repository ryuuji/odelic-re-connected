/**
 * ホーム ID（公式アプリの 8 桁 = HOMEID + メッシュのパスワード）の設定。⚠️ **特権操作**。
 *
 * ## ⭐ 設計の要点
 *
 * `odelic-web` は非 root で動く。しかし ID の保存先 `/etc/default/odelicd`（0600 root）への
 * 書き込みと `odelicd` の再起動には root が要る。
 *
 * → ⭐ **専用ヘルパ 1 本だけ**を sudoers で許可する（`set-id.sh`）。
 *
 * ⚠️⚠️ **汎用スクリプトを sudoers に入れてはいけない。**引数で任意のことができると、
 * Web の脆弱性がそのまま root になる。`set-id.sh` は argv を厳格に絞ってある。
 *
 * ## ホーム ID は伏せない
 *
 * `--status` は**今の 8 桁をそのまま**返し、設定画面もそのまま表示する。
 * 同じ番号が純正アプリのメニュー画面にも出ているので、ここだけ伏せても守れるものが無い。
 *
 * ⚠️ ただし**ログには出さない**。`src/mask.ts` が journald の表示側で伏せているのはそのまま
 * （ログは人に見せることがあるが、この画面はログイン済みの本人しか見ない）。
 *
 * ⭐ 巻き戻しは**ヘルパ側の退避ファイル**で行う（Web が旧値を覚える必要がない）。
 *
 * ## 入力ミスの検出（docs/08 W5 / 02 C23-1）
 *
 * ⭐ **誤った ID は器具の応答で即座に分かる。**`odelicd` は `PERIPHERAL_LOGIN` を
 * LOGINKEY で復号し、先頭 4 バイトが HOMEID と一致するかを見ている。
 *
 * → ⚠️ **監視はサーバでブロックせず、ブラウザに `GET /api/homeid` を叩かせる。**
 * `odelicd` の再起動から参加までは数十秒かかることがあり、その間 HTTP を掴んだままにすると
 * 「固まった」ようにしか見えない。`joined` が立たなければ UI が巻き戻しを提案する。
 */

import { execFile } from "node:child_process";

export interface SetIdStatus {
    /** 今設定されている 8 桁。未設定なら空文字 */
    id: string;
    /** ID が設定されているか */
    configured: boolean;
    /** `--rollback` で戻せる退避があるか */
    rollbackAvailable: boolean;
}

export interface SetIdResult {
    ok: boolean;
    detail: string;
    stdout: string;
}

export interface SetIdOptions {
    /** ヘルパのパス。⚠️ sudoers に書いたパスと 1 文字も違ってはいけない */
    helper: string;
    /** テスト用に差し替える */
    run?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
    log?: (msg: string) => void;
}

/** ⚠️ ここを緩めない。8 桁の数字以外はヘルパに渡さない（ヘルパ側でも再検証している） */
export const ID_PATTERN = /^\d{8}$/;

export class SetId {
    constructor(private readonly opts: SetIdOptions) {}

    async status(): Promise<SetIdStatus> {
        const res = await this.invoke(["--status"]);
        if (!res.ok) return { id: "", configured: false, rollbackAvailable: false };
        // ヘルパは `id=12345678 rollback=yes` の形で 1 行返す
        const raw = /id=(\S+)/.exec(res.stdout)?.[1] ?? "";
        // ⚠️ 8 桁の数字以外は「未設定」として扱う（壊れた設定ファイルをそのまま表示しない）
        const id = ID_PATTERN.test(raw) ? raw : "";
        return {
            id,
            configured: id !== "",
            rollbackAvailable: /rollback=yes/.test(res.stdout),
        };
    }

    /**
     * ID を設定して `odelicd` を再起動する。
     *
     * ⚠️ 呼び出し側は**このあと必ず `joined` を監視する**こと。
     * 「保存できた」は「正しい ID だった」を意味しない。
     */
    async set(id: string): Promise<SetIdResult> {
        if (!ID_PATTERN.test(id)) {
            return { ok: false, detail: "ID は 8 桁の数字です", stdout: "" };
        }
        this.opts.log?.("ホーム ID を変更します（odelicd を再起動します）");
        return this.invoke([id]);
    }

    /** 直前の ID に戻す。⭐ 旧値はヘルパ側の退避ファイルにある。 */
    async rollback(): Promise<SetIdResult> {
        this.opts.log?.("ホーム ID を直前の値に戻します");
        return this.invoke(["--rollback"]);
    }

    private async invoke(args: string[]): Promise<SetIdResult> {
        const runner = this.opts.run ?? ((a: string[]) => runSudo(this.opts.helper, a));
        try {
            const res = await runner(args);
            if (res.code !== 0) {
                return { ok: false, detail: res.stderr.trim() || `終了コード ${res.code}`, stdout: res.stdout };
            }
            return { ok: true, detail: "", stdout: res.stdout };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e), stdout: "" };
        }
    }
}

function runSudo(helper: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        // ⚠️ execFile なのでシェルを経由しない。引数がそのまま argv になる
        execFile(
            "sudo",
            ["-n", helper, ...args],
            { timeout: 30_000, maxBuffer: 256 * 1024 },
            (err, stdout, stderr) => {
                const code = err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
                resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
            },
        );
    });
}
