/**
 * `journalctl` を読む。⚠️ **出力は必ず `mask.ts` を通してから返す**（docs/09 H7）。
 *
 * ## 権限
 *
 * `odelic-web` は非 root で動く。他の unit のログを読むには
 * ⭐ **`systemd-journal` グループに入れる**（install.sh がやる）。
 * sudo は使わない（sudo で許すのは `set-id.sh` 1 本だけ）。
 *
 * ## ⚠️ コマンド組み立て
 *
 * `execFile` を使い、**シェルを経由しない**。unit 名は設定のホワイトリストに
 * あるものだけを渡す（`loadConfig` が文字種も検証している）。
 */

import { execFile } from "node:child_process";

import { maskLine } from "./mask.js";

export interface JournalOptions {
    /** ⚠️ ここに無い unit は絶対に渡さない */
    allowedUnits: readonly string[];
    maxLines: number;
    /** テスト用に差し替える。既定は実際に journalctl を叩く */
    run?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface JournalResult {
    ok: boolean;
    units: string[];
    lines: string[];
    /** 読めなかったときの説明（権限不足など） */
    detail: string;
}

export class Journal {
    constructor(private readonly opts: JournalOptions) {}

    /**
     * 直近のログを取る。
     *
     * @param units 空なら許可された全部
     * @param lines 行数（1〜`maxLines` に丸める）
     */
    async read(units: string[], lines: number): Promise<JournalResult> {
        const wanted = units.length === 0 ? [...this.opts.allowedUnits] : units;
        const bad = wanted.filter(u => !this.opts.allowedUnits.includes(u));
        if (bad.length > 0) {
            return { ok: false, units: [], lines: [], detail: `許可されていない unit です: ${bad.join(" / ")}` };
        }
        const n = Math.max(1, Math.min(this.opts.maxLines, Math.floor(lines) || 100));

        const args = ["--no-pager", "-o", "short-iso", "-n", String(n)];
        for (const u of wanted) args.push("-u", u);

        const runner = this.opts.run ?? runJournalctl;
        let res: { stdout: string; stderr: string; code: number };
        try {
            res = await runner(args);
        } catch (e) {
            return {
                ok: false,
                units: wanted,
                lines: [],
                detail: `journalctl を実行できません: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
        if (res.code !== 0) {
            // ⚠️ よくあるのは systemd-journal グループに入っていないケース。
            //    そのまま出すと原因が分かる（stderr にも秘密は出ない想定だがマスクは通す）
            return {
                ok: false,
                units: wanted,
                lines: [],
                detail: `journalctl が終了コード ${res.code} で失敗しました: ${res.stderr.trim() || "(出力なし)"}`,
            };
        }
        // ⚠️ マスクは呼び出し側ではなく**ここで必ず**掛ける。呼び忘れを構造で防ぐ
        const masked = maskAll(res.stdout);
        return { ok: true, units: wanted, lines: masked, detail: "" };
    }
}

function maskAll(stdout: string): string[] {
    return stdout
        .split("\n")
        .filter(l => l !== "")
        .map(maskLine);
}

function runJournalctl(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        execFile(
            "journalctl",
            args,
            // ⚠️ Pi 3 のメモリを守る。500 行ならこれで十分足りる
            { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
            (err, stdout, stderr) => {
                const code = err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
                resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
            },
        );
    });
}

/**
 * unit が動いているか。⭐ `systemctl is-active` は非 root でも読める。
 *
 * ⚠️ 名前はホワイトリストから来たものだけを渡す（呼び出し側の責任）。
 */
export async function serviceStatus(
    units: readonly string[],
    run: (args: string[]) => Promise<{ stdout: string; code: number }> = runSystemctl,
): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (units.length === 0) return out;
    let stdout: string;
    try {
        // ⚠️ 全部止まっていると終了コードが 3 になる。stdout は取れるので code は見ない
        stdout = (await run(["is-active", ...units])).stdout;
    } catch {
        for (const u of units) out[u] = "unknown";
        return out;
    }
    const lines = stdout.split("\n").map(l => l.trim());
    units.forEach((u, i) => {
        out[u] = lines[i] !== undefined && lines[i] !== "" ? lines[i]! : "unknown";
    });
    return out;
}

function runSystemctl(args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise(resolve => {
        execFile("systemctl", args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => {
            const code = err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
            resolve({ stdout, code: typeof code === "number" ? code : 1 });
        });
    });
}
