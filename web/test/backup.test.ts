/**
 * バックアップの特権ヘルパ（`backup-helper.py`）の検査。
 *
 * ⭐ **`--restore` は他人が作った ZIP を root で展開する。**このプロジェクトで
 * いちばん危ない処理なので、パス検証と往復をテストで固定する。
 *
 * ## ⚠️⚠️ Windows では「実行する」テストが動かない
 *
 * ヘルパは `pwd` / `grp`（**Unix 専用**）を import するので、開発機が Windows だと
 * **スクリプトとして起動した時点で ImportError になる。**
 *
 * ⚠️ ここを踏んだ: 最初は「不正な argv が非ゼロで終わること」だけ見ていたので、
 *    **ImportError の非ゼロでテストが通ってしまっていた**（検証になっていない）。
 *    → ⭐ 実行を要するテストは `import grp` が通る環境に限定し、
 *      **理由を書いて skip する。**Pi 上（`install.sh` が `npm test` を回す）では実行される。
 *
 * ⭐ 対象リストの検査は**ファイルを読むだけ**にしてあるので、どの OS でも必ず走る。
 * ⚠️ 以前は `backup.sh`（毎日のタイマー）と 2 か所に同じリストがあり、その一致を
 *    検査していた。⭐ **`backup.sh` を廃止して単一ソースにしたので不要になった**
 *    （バックアップは設定ページの ZIP に一本化した）。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// ⚠️ テストは `dist/test/` から動く。web のルートは 2 つ上、リポジトリはその上
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..", "..");

const HELPER = join(WEB_ROOT, "backup-helper.py");
const PY_TEST = join(WEB_ROOT, "test", "backup_helper_test.py");

/**
 * ヘルパを**実行できる** python を探す。
 *
 * ⚠️ `python -c "import zipfile"` では足りない。`pwd` / `grp` が要る
 * （Windows の python では通らない）。ここを緩めると skip されずに
 * ImportError で「合格」してしまう。
 */
function usablePython(): string | null {
    for (const exe of ["python3", "python"]) {
        try {
            execFileSync(exe, ["-c", "import zipfile, pwd, grp"], { stdio: "ignore" });
            return exe;
        } catch {
            /* 次を試す */
        }
    }
    return null;
}

const PY = usablePython();

/**
 * ⚠️⚠️ ヘルパが隣に無いことがある。
 *
 * `web/install.sh` は `src` / `test` / `public` を `/opt/odelic-web` に配ってから
 * `npm test` を回すが、`backup-helper.py` を置くのは**そのあと**（root 所有で
 * 置く必要があり、`chown -R` の後にしなければならないため）。
 *
 * ⚠️ ここで fail させると **install.sh が set -e で中断し、sudoers が書かれない。**
 *    実際にそれで「画面は新しいのに sudo が通らない」状態を作った。
 *    → ⭐ 無ければ理由を書いて skip する。⭐ 配備後の検証は
 *      `install.sh` が `"$DEST/backup-helper.py" --targets` で別途行っている。
 */
const HAS_HELPER = existsSync(HELPER);

/** ⚠️ install.sh は root で回す。root では「非 root なら断る」を検査できない。 */
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** ⚠️ ファイルを読むだけのテストも、ヘルパが無ければ readFileSync で落ちる */
const NO_HELPER = HAS_HELPER ? false : `${HELPER} がまだ置かれていません`;

const SKIP =
    PY === null
        ? "Unix の python3（pwd / grp が使えるもの）がありません"
        : !HAS_HELPER
          ? `${HELPER} がまだ置かれていません（install.sh はテストのあとに置く）`
          : false;

/** 配列リテラルからパスだけを抜く（`"...",  # コメント` の形を想定）。 */
function pathsInBlock(body: string): string[] {
    return body
        .split("\n")
        .map(l => l.replace(/#.*$/, "").trim().replace(/^["']|["'],?$/g, "").replace(/,$/, ""))
        .map(l => l.replace(/^["']|["']$/g, ""))
        .filter(l => l.startsWith("/"));
}

/** ⭐ `backup-helper.py` の TARGETS を**読んで**取る（実行しないのでどの OS でも動く）。 */
function helperTargets(): string[] {
    const text = readFileSync(HELPER, "utf8");
    const block = /^TARGETS = \[([\s\S]*?)^\]/m.exec(text);
    assert.notEqual(block, null, "backup-helper.py に TARGETS = [ ... ] が見つかりません");
    return pathsInBlock(block?.[1] ?? "");
}

describe("バックアップの特権ヘルパ", () => {
    it("テストの一式が存在する", () => {
        // ⚠️ HELPER はここでは要求しない（上のコメントの理由）
        assert.ok(existsSync(PY_TEST), `${PY_TEST} がありません`);
    });

    // ------------------------------------------- どの OS でも走らせる（読むだけ）

    it("⭐ 復旧に要るものが対象から漏れていない", { skip: NO_HELPER }, () => {
        const helper = helperTargets();
        assert.ok(helper.length >= 5, `対象が少なすぎます: ${JSON.stringify(helper)}`);
        // ⚠️ 失うと復旧が重いもの。1 つでも抜けると「復元したのに動かない」になる
        for (const must of [
            "/var/lib/odelic-matter", // Matter の fabric 鍵（抜けると再 commissioning）
            "/etc/default/odelicd", //   8 桁 ID
            "/etc/odelic-web", //        ローカル CA の鍵（抜けると全端末で信頼やり直し）
            "/var/lib/odelic-web", //    設定ページのパスワード
        ]) {
            assert.ok(helper.includes(must), `対象に ${must} が入っていません`);
        }
    });

    it("⚠️ 対象は絶対パスだけ（相対だと実行時のカレント次第になる）", { skip: NO_HELPER }, () => {
        for (const t of helperTargets()) {
            assert.ok(t.startsWith("/"), `絶対パスではありません: ${t}`);
            assert.ok(!t.includes(".."), `.. を含みます: ${t}`);
        }
    });

    it("⚠️ sudoers に入れる 3 本が揃っている", { skip: NO_HELPER }, () => {
        for (const f of ["set-id.sh", "set-api.sh", "backup-helper.py"]) {
            assert.ok(existsSync(join(WEB_ROOT, f)), `${f} がありません`);
        }
    });

    // --------------------------------------------- 実行が要るもの（Unix のみ）

    it("⚠️ argv はちょうど 1 つ・既知のものだけを受け付ける", { skip: SKIP }, () => {
        // ⭐ まず「正しい argv では 0 で終わる」ことを確かめる。
        //    これを先に見ないと、環境の問題で全部が非ゼロでも合格してしまう
        const good = spawnSync(PY as string, [HELPER, "--targets"], { encoding: "utf8" });
        assert.equal(good.status, 0, `--targets が失敗しました: ${good.stderr}`);

        for (const args of [[], ["--info", "extra"], ["--evil"], ["-"], ["--export=x"]]) {
            const res = spawnSync(PY as string, [HELPER, ...args], { encoding: "utf8" });
            assert.notEqual(res.status, 0, `拒否されるべき argv が通った: ${JSON.stringify(args)}`);
        }
    });

    it("⭐ --targets の出力がソースと一致する（読み取りが正しいことの裏取り）", { skip: SKIP }, () => {
        const res = spawnSync(PY as string, [HELPER, "--targets"], { encoding: "utf8" });
        assert.equal(res.status, 0, res.stderr);
        const printed = res.stdout.split("\n").map(l => l.trim()).filter(l => l !== "");
        assert.deepEqual(printed, helperTargets());
    });

    it("⚠️ root でなければ --info / --export / --restore を断る", {
        skip: SKIP || (AS_ROOT ? "root で実行中（install.sh 経由）なので検査できません" : false),
    }, () => {
        for (const action of ["--info", "--export", "--restore"]) {
            const res = spawnSync(PY as string, [HELPER, action], { encoding: "utf8", input: "" });
            assert.notEqual(res.status, 0, `${action} が非 root で通った`);
            assert.match(res.stderr, /root/, `${action} の理由が root と分かる文言でない`);
        }
    });

    it("⭐⭐ export → restore の往復とパストラバーサルの拒否", { skip: SKIP }, () => {
        const res = spawnSync(PY as string, [PY_TEST, HELPER], { encoding: "utf8" });
        // ⚠️ 落ちたときは中身をそのまま出す。「失敗した」だけでは直せない
        assert.equal(res.status, 0, `\n${res.stdout}\n${res.stderr}`);
        assert.match(res.stdout, /すべて通った/);
    });
});
