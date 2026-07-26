/**
 * 状態のバックアップと復元。⚠️ **特権操作**。
 *
 * ## ⭐ 設計の要点
 *
 * `odelic-web` は非 root で動くが、バックアップ対象は
 * `/etc/default/odelicd`（0600 root）や Matter の fabric 鍵なので root が要る。
 * → ⭐ **専用ヘルパ 1 本だけ**を sudoers で許可する（`backup-helper.py`）。
 *
 * ⚠️ ヘルパが Python なのは `--restore` が「他人が作った ZIP を root で展開する」
 * 処理で、エントリ名の検証・シンボリックリンクの拒否・所有者の復元を
 * シェルで書き切れないため。`python3` は `odelicd` が必須にしている。
 *
 * ## ⚠️⚠️ この ZIP は Pi ごと持ち出せる鍵束
 *
 *   - 8 桁 ID（下位 4 桁はメッシュのパスワード）
 *   - Matter の fabric 秘密鍵
 *   - ⭐ ローカル CA の秘密鍵（漏れると偽サイトを作られる）
 *   - 設定ページのパスワードのハッシュ
 *
 * → ⭐ **一時ファイルに落とさない。**ヘルパの標準出力／標準入力で流す。
 * → ⭐ ダウンロードは **POST** にする。GET だと他サイトからのリンクや
 *   `<img>` で不意にダウンロードが始まり得るし、CSRF の確認も通らない
 *   （このプロジェクトは GET を CSRF 検査の対象外にしている）。
 * → ⚠️ 応答に `Cache-Control: no-store` を付ける（プロキシやディスクに残さない）。
 */

import { execFile } from "node:child_process";

/** ⚠️ ヘルパ側の MAX_UPLOAD と合わせる。状態は実測で数百 KB なので十分すぎる */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** ヘルパの `--info` が返す JSON。 */
export interface BackupInfo {
    formatVersion: number;
    targets: { path: string; present: boolean; files: number; bytes: number }[];
    files: number;
    bytes: number;
    /** 対象の中でいちばん新しい更新時刻（unix 秒）。0 なら何も無い */
    newestMtime: number;
    services: string[];
}

export interface BackupResult<T> {
    ok: boolean;
    detail: string;
    data: T | null;
}

export interface BackupOptions {
    /** ヘルパのパス。⚠️ sudoers に書いたパスと 1 文字も違ってはいけない */
    helper: string;
    /** テスト用に差し替える */
    run?: (args: string[], stdin?: Buffer) => Promise<{ stdout: Buffer; stderr: string; code: number }>;
    log?: (msg: string) => void;
}

export class Backup {
    constructor(private readonly opts: BackupOptions) {}

    /** 何がどれだけ入るか。⭐ 画面に「取れるものが無い」を出せるようにする。 */
    async info(): Promise<BackupResult<BackupInfo>> {
        const res = await this.invoke(["--info"]);
        if (!res.ok) return { ok: false, detail: res.detail, data: null };
        try {
            return { ok: true, detail: "", data: JSON.parse(res.stdout.toString("utf8")) as BackupInfo };
        } catch (e) {
            return { ok: false, detail: `--info の出力を読めません: ${String(e)}`, data: null };
        }
    }

    /** ZIP を作って返す。⚠️ 中身は秘密情報。呼び出し側は no-store で返すこと。 */
    async export(): Promise<BackupResult<Buffer>> {
        this.opts.log?.("バックアップを作成します（⚠️ 秘密情報を含む ZIP）");
        const res = await this.invoke(["--export"]);
        if (!res.ok) return { ok: false, detail: res.detail, data: null };
        if (res.stdout.length === 0) {
            return { ok: false, detail: "ヘルパが空の ZIP を返しました", data: null };
        }
        return { ok: true, detail: "", data: res.stdout };
    }

    /**
     * ZIP から復元してサービスを再起動する。
     *
     * ⚠️⚠️ 破壊的。⭐ **検証はヘルパ側で行う**（root で展開するので、
     * 最後の砦はヘルパでなければならない）。ここでの検査は「無駄な起動を省く」だけ。
     */
    async restore(zip: Buffer): Promise<BackupResult<{ restored: number }>> {
        if (zip.length === 0) return { ok: false, detail: "ファイルが空です", data: null };
        if (zip.length > MAX_BACKUP_BYTES) {
            return { ok: false, detail: `ファイルが大きすぎます（上限 ${MAX_BACKUP_BYTES / 1024 / 1024} MB）`, data: null };
        }
        // ⚠️ ZIP の magic（`PK\x03\x04`）だけ見る。中身の検証はヘルパの責務
        if (!(zip[0] === 0x50 && zip[1] === 0x4b)) {
            return { ok: false, detail: "ZIP ファイルではありません", data: null };
        }
        this.opts.log?.(`バックアップから復元します（${zip.length} バイト）⚠️ サービスを再起動します`);
        const res = await this.invoke(["--restore"], zip);
        if (!res.ok) return { ok: false, detail: res.detail, data: null };
        try {
            return { ok: true, detail: "", data: JSON.parse(res.stdout.toString("utf8")) as { restored: number } };
        } catch {
            // ⚠️ 復元自体は成功しているので ok は落とさない（件数だけ分からない）
            return { ok: true, detail: "", data: null };
        }
    }

    private async invoke(
        args: string[],
        stdin?: Buffer,
    ): Promise<{ ok: boolean; detail: string; stdout: Buffer }> {
        const runner = this.opts.run ?? ((a: string[], i?: Buffer) => runSudo(this.opts.helper, a, i));
        try {
            const res = await runner(args, stdin);
            if (res.code !== 0) {
                // ⭐ ヘルパは理由を stderr に日本語で書く。そのまま画面に出す
                return { ok: false, detail: res.stderr.trim() || `終了コード ${res.code}`, stdout: res.stdout };
            }
            return { ok: true, detail: "", stdout: res.stdout };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e), stdout: Buffer.alloc(0) };
        }
    }
}

function runSudo(
    helper: string,
    args: string[],
    stdin?: Buffer,
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    return new Promise(resolve => {
        // ⚠️ `-n` を付ける。パスワードを聞かれたら**待たずに失敗させる**
        //    （sudoers の設定漏れを「固まった」ではなく「失敗」として見せる）
        const child = execFile(
            "sudo",
            ["-n", helper, ...args],
            // ⚠️ ZIP はバイナリ。encoding を付けると壊れる
            { encoding: "buffer", maxBuffer: MAX_BACKUP_BYTES + 1024 * 1024, timeout: 120_000 },
            (err, stdout, stderr) => {
                const code =
                    err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
                resolve({
                    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)),
                    stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr),
                    code: typeof code === "number" ? code : 1,
                });
            },
        );
        if (stdin !== undefined) {
            // ⚠️ EPIPE を握る。ヘルパが検証で早期に終了すると書き込み中に閉じられる
            child.stdin?.on("error", () => {});
            child.stdin?.end(stdin);
        } else {
            child.stdin?.end();
        }
    });
}
