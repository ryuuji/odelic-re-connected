/**
 * 認証のテスト。⭐ **UI より先にここを固めた**（docs/09 H4）。
 *
 * 見るのは「通してはいけないものを通さないこと」。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
    Auth,
    MIN_PASSWORD_LENGTH,
    SESSION_COOKIE,
    clearedSessionCookie,
    generatePassword,
    hashPassword,
    readCookie,
    sessionCookie,
    verifyPassword,
} from "../src/auth.js";

let dir: string;
before(() => {
    dir = mkdtempSync(join(tmpdir(), "odelic-web-auth-"));
});
after(() => {
    rmSync(dir, { recursive: true, force: true });
});

/**
 * ⚠️ `sessionFile` を明示する。既定は `auth.json` と同じディレクトリの `sessions.json` なので、
 * テストが同じ `dir` を使い回すと**別のテストのセッションを読み込んでしまう**。
 * 永続化そのものを見るテストだけが自分のファイルを持つ。
 */
const authAt = (name: string, now?: () => number): Auth =>
    new Auth({
        file: join(dir, name),
        sessionFile: null,
        sessionMaxAgeSec: 3600,
        ...(now ? { now } : {}),
    });

describe("パスワードのハッシュ", () => {
    it("正しいパスワードだけ通る", () => {
        const stored = hashPassword("correct horse battery");
        assert.equal(verifyPassword("correct horse battery", stored), true);
        assert.equal(verifyPassword("correct horse batterx", stored), false);
        assert.equal(verifyPassword("", stored), false);
    });

    it("⭐ 平文がどこにも入っていない", () => {
        const stored = hashPassword("ひみつのぱすわーど");
        const json = JSON.stringify(stored);
        assert.ok(!json.includes("ひみつ"), json);
    });

    it("⭐ salt が毎回変わる（同じパスワードでもハッシュが違う）", () => {
        const a = hashPassword("same-password");
        const b = hashPassword("same-password");
        assert.notEqual(a.salt, b.salt);
        assert.notEqual(a.hash, b.hash);
    });

    it("壊れた保存内容で例外を投げない（落ちるより弾く）", () => {
        const broken = { ...hashPassword("x"), hash: "ではない 16 進" };
        assert.equal(verifyPassword("x", broken), false);
    });

    it("keylen と合わないハッシュを拒否する", () => {
        const stored = { ...hashPassword("x"), hash: "aabb" };
        assert.equal(verifyPassword("x", stored), false);
    });
});

describe("初期パスワードの生成", () => {
    it("指定した長さになる", () => {
        assert.equal(generatePassword(16).length, 16);
        assert.equal(generatePassword(24).length, 24);
    });

    it("⚠️ 紛らわしい文字（0 O 1 l I）を含まない（口頭・手書きで伝えるため）", () => {
        for (let i = 0; i < 50; i++) {
            assert.ok(!/[0O1lI]/.test(generatePassword(32)));
        }
    });

    it("⭐ 毎回違う", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) seen.add(generatePassword(16));
        assert.equal(seen.size, 50);
    });
});

describe("Auth の保存と読み込み", () => {
    it("未設定なら configured が false で、どんなパスワードも通らない", () => {
        const auth = authAt("empty.json");
        assert.equal(auth.configured, false);
        assert.equal(auth.verify(""), false);
        assert.equal(auth.verify("なんでも"), false);
    });

    it("設定すると通る", () => {
        const auth = authAt("set.json");
        auth.setPassword("pw-12345678");
        assert.equal(auth.configured, true);
        assert.equal(auth.verify("pw-12345678"), true);
        assert.equal(auth.verify("pw-12345679"), false);
    });

    it(`⚠️ ${MIN_PASSWORD_LENGTH} 文字未満は拒否する`, () => {
        const auth = authAt("short.json");
        assert.throws(() => auth.setPassword("short"), /文字以上/);
        assert.equal(auth.configured, false);
    });

    it("⭐ ファイルは 0600 で、平文が入っていない", function () {
        const file = join(dir, "perm.json");
        const auth = new Auth({ file, sessionMaxAgeSec: 3600 });
        auth.setPassword("secret-password-1");
        const body = readFileSync(file, "utf8");
        assert.ok(!body.includes("secret-password-1"), body);
        if (process.platform !== "win32") {
            assert.equal(statSync(file).mode & 0o777, 0o600);
        }
    });

    it("プロセスをまたいで読み直せる", () => {
        const file = join(dir, "reload.json");
        new Auth({ file, sessionMaxAgeSec: 3600 }).setPassword("across-restart-1");
        const fresh = new Auth({ file, sessionMaxAgeSec: 3600 });
        assert.equal(fresh.verify("across-restart-1"), true);
    });

    it("⚠️ 壊れた auth.json は「未設定」として扱う（例外で起動を止めない）", () => {
        const file = join(dir, "broken.json");
        writeFileSync(file, "{ これは JSON ではない", "utf8");
        const auth = new Auth({ file, sessionMaxAgeSec: 3600 });
        assert.equal(auth.configured, false);
        assert.equal(auth.verify("なんでも"), false);
    });

    it("⭐⭐ 「ファイルが無い」と「あるのに読めない」を区別する", () => {
        // 無い → problem は null（正常な初回状態）
        const fresh = new Auth({ file: join(dir, "まだない.json"), sessionMaxAgeSec: 3600 });
        assert.equal(fresh.configured, false);
        assert.equal(fresh.problem, null);

        // ⚠️ あるのに読めない → 理由が残る。
        //    これが無いと「root 所有のまま置いた」を「未設定」と誤診して、
        //    誰もログインできないのに原因が分からない（実際に踏んだ）
        const broken = join(dir, "こわれ.json");
        writeFileSync(broken, '{"algorithm":"みしらぬ"}', "utf8");
        const auth = new Auth({ file: broken, sessionMaxAgeSec: 3600 });
        assert.equal(auth.configured, false);
        assert.ok(auth.problem !== null, "理由が残っていない");
        assert.match(auth.problem, /こわれ\.json/);
    });

    it("読めないときは warn に理由が飛ぶ（journald に出す）", () => {
        const warnings: string[] = [];
        const file = join(dir, "warned.json");
        writeFileSync(file, "こわれた", "utf8");
        new Auth({ file, sessionMaxAgeSec: 3600, warn: m => warnings.push(m) });
        assert.equal(warnings.length, 1, warnings.join(" / "));
    });
});

describe("セッション", () => {
    it("発行したトークンで通る", () => {
        const auth = authAt("sess1.json");
        const s = auth.createSession("127.0.0.1");
        assert.notEqual(auth.validate(s.token), null);
    });

    it("知らないトークンは通らない", () => {
        const auth = authAt("sess2.json");
        assert.equal(auth.validate("にせもの"), null);
        assert.equal(auth.validate(undefined), null);
        assert.equal(auth.validate(""), null);
    });

    it("⭐ トークンは 32 バイト以上の乱数（推測できない）", () => {
        const auth = authAt("sess3.json");
        const tokens = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const t = auth.createSession("::1").token;
            assert.ok(t.length >= 43, `短すぎる: ${t.length}`);
            tokens.add(t);
        }
        assert.equal(tokens.size, 20);
    });

    it("⚠️ 期限が切れたら通らない", () => {
        let now = 1_000_000;
        const auth = new Auth({ file: join(dir, "sess4.json"), sessionFile: null, sessionMaxAgeSec: 10, now: () => now });
        const s = auth.createSession("::1");
        now += 9_000;
        assert.notEqual(auth.validate(s.token), null);
        now += 2_000;
        assert.equal(auth.validate(s.token), null);
    });

    it("ログアウトで無効になる", () => {
        const auth = authAt("sess5.json");
        const s = auth.createSession("::1");
        auth.destroySession(s.token);
        assert.equal(auth.validate(s.token), null);
    });

    it("⭐ パスワードを変えたら全セッションが切れる", () => {
        const auth = authAt("sess6.json");
        const a = auth.createSession("::1");
        const b = auth.createSession("::2");
        auth.destroyAllSessions();
        assert.equal(auth.validate(a.token), null);
        assert.equal(auth.validate(b.token), null);
    });

    it("期限切れは数からも消える（メモリを溜めない）", () => {
        let now = 1_000_000;
        const auth = new Auth({ file: join(dir, "sess7.json"), sessionFile: null, sessionMaxAgeSec: 10, now: () => now });
        auth.createSession("::1");
        auth.createSession("::2");
        assert.equal(auth.sessionCount, 2);
        now += 11_000;
        assert.equal(auth.sessionCount, 0);
    });
});

/**
 * セッションの永続化。
 *
 * ⚠️⚠️ ここで守りたいのは「再起動でログアウトしない」と
 * 「⭐ **ファイルが漏れてもログインできない**」の両方。
 */
describe("セッションの永続化", () => {
    /** ⭐ 1 テスト 1 ディレクトリ。共有すると別のテストのセッションを読んでしまう */
    const persistDir = (name: string) => {
        const d = join(dir, name);
        return { file: join(d, "auth.json"), sessionFile: join(d, "sessions.json") };
    };

    it("⭐ 再起動をまたいでログインしたままになる", () => {
        const p = persistDir("p1");
        const first = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        first.setPassword("persist-me-please");
        const s = first.createSession("172.16.0.9");

        // プロセスが落ちて上がり直した想定
        const second = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        const restored = second.validate(s.token);
        assert.notEqual(restored, null, "再起動でログアウトしている");
        assert.equal(restored?.ip, "172.16.0.9");
    });

    it("⭐⭐ 保存されるのは SHA-256 だけ（ファイルが漏れてもログインできない）", () => {
        const p = persistDir("p2");
        const auth = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        auth.setPassword("hash-only-please");
        const s = auth.createSession("::1");

        const body = readFileSync(p.sessionFile, "utf8");
        // ⚠️⚠️ 生のトークンが 1 バイトでも入っていたら、このファイルは Cookie そのもの
        assert.ok(!body.includes(s.token), body);
        assert.match(body, /"id":"[0-9a-f]{64}"/);
        if (process.platform !== "win32") {
            assert.equal(statSync(p.sessionFile).mode & 0o777, 0o600);
        }
    });

    it("⚠️⚠️ パスワードをリセットすると保存済みのセッションも無効になる", () => {
        const p = persistDir("p3");
        const first = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        first.setPassword("before-the-reset");
        const s = first.createSession("::1");

        // reset-password.sh 相当。⚠️ プロセスを通さずに auth.json だけ差し替わる
        writeFileSync(p.file, `${JSON.stringify(hashPassword("after-the-reset"), null, 2)}\n`, "utf8");

        const second = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        assert.equal(second.validate(s.token), null, "リセット前のセッションで入れてしまう");
        assert.equal(second.verify("after-the-reset"), true);
    });

    it("⚠️ 期限切れは読み込み時に落とす", () => {
        const p = persistDir("p4");
        let now = 1_000_000;
        const first = new Auth({ ...p, sessionMaxAgeSec: 10, now: () => now });
        first.setPassword("expire-on-load");
        const s = first.createSession("::1");

        now += 11_000;
        const second = new Auth({ ...p, sessionMaxAgeSec: 10, now: () => now });
        assert.equal(second.validate(s.token), null);
        assert.equal(second.sessionCount, 0);
    });

    it("⚠️ 壊れた sessions.json でも起動する（ログアウトするだけ）", () => {
        const p = persistDir("p5");
        const first = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        first.setPassword("broken-sessions-1");
        first.createSession("::1");
        writeFileSync(p.sessionFile, "{ これは JSON ではない", "utf8");

        const warnings: string[] = [];
        const second = new Auth({ ...p, sessionMaxAgeSec: 3600, warn: m => warnings.push(m) });
        assert.equal(second.sessionCount, 0);
        assert.equal(second.verify("broken-sessions-1"), true, "認証まで巻き添えになっている");
        assert.ok(warnings.length > 0, "理由が journald に出ていない");
    });

    it("ログアウトすると保存からも消える", () => {
        const p = persistDir("p6");
        const auth = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        auth.setPassword("logout-clears-it");
        const a = auth.createSession("::1");
        const b = auth.createSession("::2");
        auth.destroySession(a.token);

        const fresh = new Auth({ ...p, sessionMaxAgeSec: 3600 });
        assert.equal(fresh.validate(a.token), null);
        assert.notEqual(fresh.validate(b.token), null);
    });
});

describe("総当たり対策", () => {
    it("最初は待たされない", () => {
        const auth = authAt("bf1.json");
        assert.equal(auth.penaltyMs("10.0.0.1"), 0);
    });

    it("⭐ 失敗するほど待ち時間が伸びる", () => {
        const auth = authAt("bf2.json");
        const ip = "10.0.0.2";
        const delays: number[] = [];
        for (let i = 0; i < 6; i++) {
            auth.noteFailure(ip);
            delays.push(auth.penaltyMs(ip));
        }
        for (let i = 1; i < delays.length; i++) {
            assert.ok(delays[i]! > delays[i - 1]!, `伸びていない: ${delays.join(",")}`);
        }
    });

    it("⚠️ 上限がある（自分が締め出されない）", () => {
        const auth = authAt("bf3.json");
        const ip = "10.0.0.3";
        for (let i = 0; i < 100; i++) auth.noteFailure(ip);
        assert.ok(auth.penaltyMs(ip) <= 30_000, String(auth.penaltyMs(ip)));
    });

    it("成功したら忘れる", () => {
        const auth = authAt("bf4.json");
        const ip = "10.0.0.4";
        auth.noteFailure(ip);
        auth.noteFailure(ip);
        auth.noteSuccess(ip);
        assert.equal(auth.penaltyMs(ip), 0);
    });

    it("時間が経てば忘れる", () => {
        let now = 1_000_000;
        const auth = new Auth({ file: join(dir, "bf5.json"), sessionMaxAgeSec: 60, now: () => now });
        auth.noteFailure("10.0.0.5");
        assert.ok(auth.penaltyMs("10.0.0.5") > 0);
        now += 16 * 60_000;
        assert.equal(auth.penaltyMs("10.0.0.5"), 0);
    });

    it("⭐ IP ごとに独立している（誰かの失敗で他人が待たされない）", () => {
        const auth = authAt("bf6.json");
        for (let i = 0; i < 5; i++) auth.noteFailure("10.0.0.6");
        assert.ok(auth.penaltyMs("10.0.0.6") > 0);
        assert.equal(auth.penaltyMs("10.0.0.7"), 0);
    });
});

describe("クッキー", () => {
    it("⭐ HttpOnly / Secure / SameSite が必ず付く", () => {
        const c = sessionCookie("abc", 3600);
        assert.ok(c.includes("HttpOnly"), c);
        assert.ok(c.includes("Secure"), c);
        assert.ok(c.includes("SameSite=Lax"), c);
        assert.ok(c.includes("Max-Age=3600"), c);
        assert.ok(c.startsWith(`${SESSION_COOKIE}=abc`), c);
    });

    it("消すクッキーは Max-Age=0", () => {
        assert.ok(clearedSessionCookie().includes("Max-Age=0"));
    });

    it("Cookie ヘッダから取り出せる", () => {
        assert.equal(readCookie("a=1; odelic_sid=tok3n; b=2", SESSION_COOKIE), "tok3n");
        assert.equal(readCookie("odelic_sid=tok3n", SESSION_COOKIE), "tok3n");
        assert.equal(readCookie("other=1", SESSION_COOKIE), undefined);
        assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
    });

    it("⚠️ 前方一致で誤検出しない", () => {
        assert.equal(readCookie("xodelic_sid=わな; odelic_sid=ほんもの", SESSION_COOKIE), "ほんもの");
    });
});
