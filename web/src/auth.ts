/**
 * パスワード認証とセッション。
 *
 * ⚠️⚠️ **このページはメッシュの 8 桁 ID を変更でき、Matter のフェアリングも破棄できる。**
 * 無認証にはできない。UI より先にここを固めた（docs/09 H4）。
 *
 * ## 方針
 *
 * | | |
 * | --- | --- |
 * | 利用者 | 家庭内の単一ユーザー。パスワード 1 つ |
 * | 保存 | ⭐ `scrypt` のハッシュだけ。**平文は 1 バイトも置かない** |
 * | セッション | 永続化する。⭐ ただし**保存するのはトークンの SHA-256 だけ** |
 * | 総当たり | IP ごとに失敗を数えて**応答を遅らせる**。締め出しはしない（家族が閉め出されるほうが困る） |
 *
 * ## ⭐ セッションの永続化（トークンそのものは置かない）
 *
 * 当初はメモリ内のみにしていたが、`systemctl restart odelic-web` のたびに
 * 家族全員がログアウトするのは実用に耐えなかった。→ ディスクに置く。
 *
 * ⚠️⚠️ **ただし生のトークンは書かない。**`sessions.json` が漏れたらそのまま
 * ログインできてしまう。⭐ **保存するのは `SHA-256(token)` だけ**にして、
 * 照合は「受け取ったトークンを SHA-256 して引く」で行う。
 * こうすればファイルが漏れても、そこからトークンは復元できない。
 *
 * ⚠️ パスワードと違って**遅いハッシュは要らない**。トークンは 32 バイトの乱数なので
 * 総当たりできる余地がない（scrypt を使うと毎リクエスト 100 ms 遅くなるだけ）。
 *
 * ⚠️ 書けなくても**ログインは通す**。永続化は利便性の機能であって、
 * 認証の可否をディスクの状態に握らせない（書けない理由は journald に出す）。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * scrypt のパラメータ。
 *
 * ⚠️ Pi 3（Cortex-A53）で 1 回あたり 100〜200 ms 程度。ログインは頻繁ではないので
 * これで良い。⚠️ N を上げるときは `maxmem`（既定 32 MB）も超えないか確認する
 * （必要量は約 `128 × N × r` バイト = 16 MB）。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/** パスワードの最低長。⚠️ install.sh が生成する初期値は 16 文字。 */
export const MIN_PASSWORD_LENGTH = 8;

/** ⚠️ 失敗の遅延の上限。無限に伸ばすと自分が困る */
const MAX_PENALTY_MS = 30_000;
/** 失敗の記憶が消えるまで */
const FAILURE_TTL_MS = 15 * 60_000;

export interface StoredPassword {
    version: 1;
    algorithm: "scrypt";
    N: number;
    r: number;
    p: number;
    keylen: number;
    salt: string;
    hash: string;
    updatedAt: string;
}

export interface Session {
    token: string;
    createdAt: number;
    expiresAt: number;
    /** 診断用。⚠️ 画面には出さない */
    ip: string;
}

/**
 * ディスクに置くセッション。
 *
 * ⚠️⚠️ **`token` は入っていない。**入っているのは `SHA-256(token)` の hex だけ。
 */
interface StoredSession {
    id: string;
    createdAt: number;
    expiresAt: number;
    ip: string;
    /**
     * 発行時のパスワードの `updatedAt`。
     *
     * ⚠️⚠️ **これが無いと「パスワードを忘れたのでリセットした」あとも古いセッションが生き残る。**
     * `reset-password.sh` は `auth.json` を差し替えるだけでプロセスを通らないので、
     * ⭐ **読み込み時に今のパスワードと突き合わせて、違うセッションは捨てる。**
     */
    pw: string;
}

export interface AuthOptions {
    /** `auth.json` のパス。⚠️ 0600 で書く */
    file: string;
    /**
     * セッションの保存先。省略すると `auth.json` と同じディレクトリの `sessions.json`。
     * ⚠️ `null` を渡すと永続化しない（テスト用）。
     */
    sessionFile?: string | null;
    sessionMaxAgeSec: number;
    /** テスト用の時計 */
    now?: () => number;
    /**
     * 読み込みに失敗したときの通知。
     *
     * ⚠️⚠️ **「ファイルが無い」と「あるのに読めない」を混ぜてはいけない。**
     * 権限を間違えて root 所有のまま置くと、プロセスからは「未設定」に見えて
     * **誰もログインできないのに理由が分からない**（実際に踏んだ）。
     */
    warn?: (msg: string) => void;
}

/** パスワードをハッシュ化する。⭐ salt は毎回新しく作る。 */
export function hashPassword(plain: string): StoredPassword {
    const salt = randomBytes(16);
    const hash = scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return {
        version: 1,
        algorithm: "scrypt",
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        keylen: SCRYPT.keylen,
        salt: salt.toString("hex"),
        hash: hash.toString("hex"),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * パスワードを検証する。
 *
 * ⚠️ **必ず `timingSafeEqual` で比較する。**`===` だと先頭何バイトまで合っているかが
 * 応答時間に出る。
 */
export function verifyPassword(plain: string, stored: StoredPassword): boolean {
    let expected: Buffer;
    try {
        expected = Buffer.from(stored.hash, "hex");
    } catch {
        return false;
    }
    if (expected.length !== stored.keylen) return false;
    let actual: Buffer;
    try {
        actual = scryptSync(plain, Buffer.from(stored.salt, "hex"), stored.keylen, {
            N: stored.N,
            r: stored.r,
            p: stored.p,
        });
    } catch {
        return false;
    }
    return timingSafeEqual(actual, expected);
}

/** ⭐ install.sh が使う初期パスワード生成。紛らわしい文字（0/O, 1/l/I）を外す。 */
export function generatePassword(length = 16): string {
    const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const out: string[] = [];
    // ⚠️ % でバイトを畳むと偏る。範囲外を捨てて引き直す
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    while (out.length < length) {
        for (const b of randomBytes(length * 2)) {
            if (b >= limit) continue;
            out.push(alphabet[b % alphabet.length]!);
            if (out.length === length) break;
        }
    }
    return out.join("");
}

/** トークン → ディスクに置く識別子。⭐ 一方向なので、これが漏れてもログインできない。 */
function sessionId(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

export class Auth {
    private readonly file: string;
    /** `null` なら永続化しない */
    private readonly sessionFile: string | null;
    private readonly sessionMaxAgeMs: number;
    private readonly now: () => number;
    private readonly warn: (msg: string) => void;
    private stored: StoredPassword | null = null;
    /** ⚠️ 「ファイルはあるのに使えない」ときの理由。UI とログに出す */
    private loadProblem: string | null = null;
    /** ⚠️ 鍵は `SHA-256(token)`。**生のトークンはここにも保持しない** */
    private readonly sessions = new Map<string, StoredSession>();
    /** IP → 直近の失敗（回数と最終時刻） */
    private readonly failures = new Map<string, { count: number; last: number }>();

    constructor(opts: AuthOptions) {
        this.file = opts.file;
        this.sessionFile =
            opts.sessionFile === undefined ? join(dirname(opts.file), "sessions.json") : opts.sessionFile;
        this.sessionMaxAgeMs = opts.sessionMaxAgeSec * 1000;
        this.now = opts.now ?? (() => Date.now());
        this.warn = opts.warn ?? (() => {});
        this.reload();
        this.loadSessions();
    }

    /**
     * ディスクから読み直す。
     *
     * ⚠️⚠️ **「無い」と「読めない」を区別する。**権限を間違えて root 所有のまま
     * 置くと、プロセスからは「未設定」に見えて**誰もログインできないのに
     * 理由が分からない**（実際に踏んだ）。読めないときは理由を残して警告する。
     */
    reload(): void {
        this.loadProblem = null;
        let text: string;
        try {
            text = readFileSync(this.file, "utf8");
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                this.loadProblem = `${this.file} を読めません（${code ?? "不明"}）。所有者と権限を確認してください（odelic-web:odelic-web / 0600）`;
                this.warn(this.loadProblem);
            }
            this.stored = null;
            return;
        }
        try {
            const raw = JSON.parse(text) as Partial<StoredPassword>;
            if (raw.algorithm !== "scrypt" || typeof raw.hash !== "string" || typeof raw.salt !== "string") {
                this.loadProblem = `${this.file} の中身が壊れています（scrypt のハッシュがありません）`;
                this.warn(this.loadProblem);
                this.stored = null;
                return;
            }
            this.stored = {
                version: 1,
                algorithm: "scrypt",
                N: typeof raw.N === "number" ? raw.N : SCRYPT.N,
                r: typeof raw.r === "number" ? raw.r : SCRYPT.r,
                p: typeof raw.p === "number" ? raw.p : SCRYPT.p,
                keylen: typeof raw.keylen === "number" ? raw.keylen : SCRYPT.keylen,
                salt: raw.salt,
                hash: raw.hash,
                updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
            };
        } catch (e) {
            this.loadProblem = `${this.file} を JSON として読めません: ${e instanceof Error ? e.message : String(e)}`;
            this.warn(this.loadProblem);
            this.stored = null;
        }
    }

    /** パスワードが設定済みか。 */
    get configured(): boolean {
        return this.stored !== null;
    }

    /** ⚠️ ファイルはあるのに使えないときの理由（無ければ null）。 */
    get problem(): string | null {
        return this.loadProblem;
    }

    get updatedAt(): string {
        return this.stored?.updatedAt ?? "";
    }

    /**
     * パスワードを設定して保存する。
     *
     * ⚠️ 一時ファイルに書いて rename する。書き込み中に電源が落ちても
     * `auth.json` が半端な状態で残らないようにする（そうなると誰もログインできない）。
     */
    setPassword(plain: string): void {
        if (plain.length < MIN_PASSWORD_LENGTH) {
            throw new Error(`パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください`);
        }
        const next = hashPassword(plain);
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        chmodSync(tmp, 0o600); // ⚠️ umask に負けないよう明示する
        renameSync(tmp, this.file);
        this.stored = next;
        // ⭐ パスワードを変えたら**全セッションを切る**（漏れていた場合に備えて）。
        //    ⚠️ ここでやる。呼び出し側に任せると、忘れた経路が 1 つあるだけで穴になる
        this.destroyAllSessions();
    }

    /** ⚠️ 未設定のときは常に false（「パスワード無しで通る」を作らない）。 */
    verify(plain: string): boolean {
        if (this.stored === null) return false;
        return verifyPassword(plain, this.stored);
    }

    // ------------------------------------------------------------ セッション

    createSession(ip: string): Session {
        this.pruneSessions();
        const token = randomBytes(32).toString("base64url");
        const now = this.now();
        const session: Session = { token, createdAt: now, expiresAt: now + this.sessionMaxAgeMs, ip };
        // ⚠️⚠️ 覚えるのは SHA-256 だけ。生のトークンは呼び出し元へ返すきりで、どこにも残さない
        this.sessions.set(sessionId(token), {
            id: sessionId(token),
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            ip,
            pw: this.updatedAt,
        });
        this.saveSessions();
        return session;
    }

    /** トークンが有効か。⚠️ 期限切れはその場で捨てる。 */
    validate(token: string | undefined): Session | null {
        if (token === undefined || token === "") return null;
        const id = sessionId(token);
        const s = this.sessions.get(id);
        if (s === undefined) return null;
        if (s.expiresAt <= this.now()) {
            this.sessions.delete(id);
            this.saveSessions();
            return null;
        }
        return { token, createdAt: s.createdAt, expiresAt: s.expiresAt, ip: s.ip };
    }

    destroySession(token: string | undefined): void {
        if (token === undefined) return;
        if (this.sessions.delete(sessionId(token))) this.saveSessions();
    }

    /** ⭐ パスワードを変えたら**全セッションを切る**（漏れていた場合に備えて）。 */
    destroyAllSessions(): void {
        this.sessions.clear();
        this.saveSessions();
    }

    get sessionCount(): number {
        this.pruneSessions();
        return this.sessions.size;
    }

    private pruneSessions(): void {
        const now = this.now();
        let dropped = false;
        for (const [id, s] of this.sessions) {
            if (s.expiresAt <= now) {
                this.sessions.delete(id);
                dropped = true;
            }
        }
        if (dropped) this.saveSessions();
    }

    /**
     * 保存してあるセッションを読み直す。
     *
     * ⚠️ 壊れていても**起動は止めない**。ログアウトされるだけで、認証は通常どおり動く。
     */
    private loadSessions(): void {
        if (this.sessionFile === null) return;
        let text: string;
        try {
            text = readFileSync(this.sessionFile, "utf8");
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                this.warn(`${this.sessionFile} を読めません（${code ?? "不明"}）。全員ログインし直しになります`);
            }
            return;
        }
        try {
            const raw = JSON.parse(text) as { sessions?: unknown };
            if (!Array.isArray(raw.sessions)) throw new Error("sessions が配列ではありません");
            const now = this.now();
            const pw = this.updatedAt;
            let staleByPassword = 0;
            for (const item of raw.sessions as Partial<StoredSession>[]) {
                // ⚠️ 形が合わないものは黙って捨てる（半端なセッションを生かさない）
                if (typeof item.id !== "string" || !/^[0-9a-f]{64}$/.test(item.id)) continue;
                if (typeof item.expiresAt !== "number" || item.expiresAt <= now) continue;
                // ⚠️⚠️ パスワードが変わっていたら無効。reset-password.sh で
                //     リセットしたのに前のセッションで入れてしまう、を防ぐ
                if (item.pw !== pw) {
                    staleByPassword++;
                    continue;
                }
                this.sessions.set(item.id, {
                    id: item.id,
                    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
                    expiresAt: item.expiresAt,
                    ip: typeof item.ip === "string" ? item.ip : "",
                    pw,
                });
            }
            if (staleByPassword > 0) {
                this.warn(`パスワードが変わっているので ${staleByPassword} 件のセッションを無効にしました`);
                this.saveSessions();
            }
        } catch (e) {
            this.warn(
                `${this.sessionFile} を読めません（${e instanceof Error ? e.message : String(e)}）。全員ログインし直しになります`,
            );
        }
    }

    /**
     * セッションを書き出す。
     *
     * ⚠️ **書けなくても例外にしない。**永続化は利便性の機能で、認証の可否ではない。
     * 理由は 1 回だけ journald に出す（毎リクエスト出すとログが埋まる）。
     */
    private saveSessions(): void {
        const path = this.sessionFile;
        if (path === null) return;
        try {
            if (this.sessions.size === 0) {
                // ⭐ 空ならファイルごと消す。残骸を置かない
                rmSync(path, { force: true });
                return;
            }
            mkdirSync(dirname(path), { recursive: true });
            const payload = { version: 1, sessions: [...this.sessions.values()] };
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
            chmodSync(tmp, 0o600); // ⚠️ umask に負けないよう明示する
            renameSync(tmp, path);
            this.sessionSaveWarned = false;
        } catch (e) {
            if (this.sessionSaveWarned) return;
            this.sessionSaveWarned = true;
            this.warn(
                `${path} に書けません（${e instanceof Error ? e.message : String(e)}）。` +
                    "再起動でログアウトしますが、認証そのものは動きます",
            );
        }
    }

    private sessionSaveWarned = false;

    // ------------------------------------------------------------ 総当たり対策

    /**
     * この IP を待たせるべきミリ秒。
     *
     * ⭐ 締め出さずに**遅らせる**。締め出すと、外から失敗させ続けるだけで
     * 家族がログインできなくなる（可用性への攻撃になる）。
     */
    penaltyMs(ip: string): number {
        const f = this.failures.get(ip);
        if (f === undefined) return 0;
        if (this.now() - f.last > FAILURE_TTL_MS) {
            this.failures.delete(ip);
            return 0;
        }
        return Math.min(MAX_PENALTY_MS, 250 * 2 ** (f.count - 1));
    }

    noteFailure(ip: string): void {
        const now = this.now();
        const f = this.failures.get(ip);
        if (f === undefined || now - f.last > FAILURE_TTL_MS) {
            this.failures.set(ip, { count: 1, last: now });
            return;
        }
        f.count++;
        f.last = now;
    }

    noteSuccess(ip: string): void {
        this.failures.delete(ip);
    }

    /** 診断用（`/api/health`）。⚠️ IP そのものは返さない。 */
    get throttledCount(): number {
        return this.failures.size;
    }
}

/** `Cookie:` ヘッダから 1 つ取り出す。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
    if (header === undefined) return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
}

export const SESSION_COOKIE = "odelic_sid";

/**
 * `Set-Cookie` の値を作る。
 *
 * ⚠️ `Secure` を必ず付ける。HTTPS でしか配らないので、平文で漏れる経路を作らない。
 * ⚠️ `SameSite=Lax` にする。`None` は外部サイトから送られてしまう。
 */
export function sessionCookie(token: string, maxAgeSec: number): string {
    return [
        `${SESSION_COOKIE}=${token}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        `Max-Age=${Math.floor(maxAgeSec)}`,
    ].join("; ");
}

export function clearedSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
