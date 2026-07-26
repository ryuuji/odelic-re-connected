/**
 * 設定の読み込みのテスト。
 *
 * ⭐ 一番大事なのは **`config.example.json` が実際に読めること**。
 * install.sh がこれを `/etc/odelic-web/config.json` の雛形にするので、
 * 壊れていると「インストールしたのに起動しない」になる。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

// dist/test/ から見たリポジトリ内の位置
const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "..", "config.example.json");

describe("config.example.json", () => {
    it("⭐ 実際に読める（コメント付き JSON がパースできる）", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(EXAMPLE, m => warnings.push(m));
        assert.deepEqual(warnings, [], `警告が出ている: ${warnings.join(" / ")}`);
        assert.equal(cfg.odelicd, "http://127.0.0.1:8080");
        assert.equal(cfg.bridgeAdmin, "http://127.0.0.1:8081");
        assert.equal(cfg.port, 8443);
    });

    it("コードの既定と設定例がずれていない", () => {
        const cfg = loadConfig(EXAMPLE, () => {});
        assert.equal(cfg.port, DEFAULT_CONFIG.port);
        assert.equal(cfg.waitMs, DEFAULT_CONFIG.waitMs);
        assert.deepEqual(cfg.logUnits, DEFAULT_CONFIG.logUnits);
    });

    it("⚠️ 設定例に秘密が入っていない", () => {
        const cfg = loadConfig(EXAMPLE, () => {});
        const json = JSON.stringify(cfg);
        assert.ok(!/password|passcode|secret/i.test(json), json);
    });
});

describe("loadConfig", () => {
    let dir: string;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "odelic-web-cfg-"));
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const write = (name: string, body: string): string => {
        const p = join(dir, name);
        writeFileSync(p, body, "utf8");
        return p;
    };

    it("パス未指定なら既定値", () => {
        assert.deepEqual(loadConfig(undefined), { ...DEFAULT_CONFIG });
    });

    it("未知のキーは警告して無視する（書き間違いを黙って捨てない）", () => {
        const warnings: string[] = [];
        loadConfig(write("unknown.json", '{"portt": 8443}'), m => warnings.push(m));
        assert.ok(warnings.some(w => w.includes("portt")), warnings.join(" / "));
    });

    it("型が違えば警告して既定値を使う", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(write("badtype.json", '{"port": "8443"}'), m => warnings.push(m));
        assert.equal(cfg.port, DEFAULT_CONFIG.port);
        assert.ok(warnings.length > 0);
    });

    it("読めないファイルはエラーにする（黙って既定値で動かない）", () => {
        assert.throws(() => loadConfig(join(dir, "ない.json"), () => {}), /設定ファイルを読めません/);
    });

    it("⚠️ ポートの範囲外はエラー", () => {
        assert.throws(() => loadConfig(write("p1.json", '{"port": 0}'), () => {}), /1〜65535/);
        assert.throws(() => loadConfig(write("p2.json", '{"port": 70000}'), () => {}), /1〜65535/);
    });

    it("⚠️⚠️ logUnits に unit 名として使えない文字があればエラー（ログ画面の抜け穴を塞ぐ）", () => {
        assert.throws(
            () => loadConfig(write("lu.json", '{"logUnits": ["odelicd; rm -rf /"]}'), () => {}),
            /unit 名として使えない/,
        );
        assert.throws(
            () => loadConfig(write("lu2.json", '{"logUnits": ["../../etc/shadow"]}'), () => {}),
            /unit 名として使えない/,
        );
    });

    it("logUnits を絞れる", () => {
        const cfg = loadConfig(write("lu3.json", '{"logUnits": ["odelicd"]}'), () => {});
        assert.deepEqual(cfg.logUnits, ["odelicd"]);
    });

    it("⚠️ 既定の logUnits を書き換えてしまわない（配列の共有）", () => {
        const a = loadConfig(write("lu4.json", '{"logUnits": ["odelicd"]}'), () => {});
        a.logUnits.push("わるいの");
        assert.deepEqual(DEFAULT_CONFIG.logUnits, ["odelicd", "odelic-matter", "odelic-web"]);
    });

    it("空文字の URL を拒否する", () => {
        const warnings: string[] = [];
        const cfg = loadConfig(write("empty.json", '{"odelicd": ""}'), m => warnings.push(m));
        assert.equal(cfg.odelicd, DEFAULT_CONFIG.odelicd);
        assert.ok(warnings.length > 0);
    });
});
