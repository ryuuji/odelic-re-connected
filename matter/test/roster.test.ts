/**
 * 名簿の永続化のテスト。
 *
 * ⭐ 守りたいのは 1 点: **一度見つけた器具が、通電していない状態で再起動しても
 * Google Home から消えないこと。**
 *
 * 消えると `uniqueId` が変わり、次に通電したとき別デバイスとして出てしまうので、
 * 部屋割り・名前・自動化の設定が失われる。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { loadRoster, remove, rosterPath, saveRoster, upsert, type Roster } from "../src/roster.js";

const MAC_A = "EC:C5:7F:81:DE:CD";
const MAC_B = "EC:C5:7F:80:28:A6";
const NOW = new Date("2026-07-26T06:00:00Z");

describe("名簿の読み書き", () => {
    let dir: string;

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "odelic-roster-"));
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const fresh = (name: string): string => join(dir, name);

    it("無いファイルは空の名簿として読める（起動を止めない）", () => {
        const r = loadRoster(fresh("ない.json"));
        assert.deepEqual(r.fixtures, []);
    });

    it("⚠️ 壊れたファイルでも空として読み、起動を止めない", () => {
        const p = fresh("broken.json");
        writeFileSync(p, "{ これは JSON ではない", "utf8");
        const warnings: string[] = [];
        const r = loadRoster(p, m => warnings.push(m));
        assert.deepEqual(r.fixtures, []);
        assert.ok(warnings.length > 0, "壊れていることは警告する");
    });

    it("書いて読み戻せる", () => {
        const p = fresh("rt.json");
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: MAC_A, product: "CODE_2B", productCode: 0x2b, version: "0x52C0 fw1.7" }, NOW);
        assert.equal(saveRoster(p, r), true);

        const back = loadRoster(p);
        assert.equal(back.fixtures.length, 1);
        assert.equal(back.fixtures[0]!.mac, MAC_A);
        assert.equal(back.fixtures[0]!.productCode, 0x2b);
    });

    it("MAC の表記が正規化される", () => {
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: "ec-c5-7f-81-de-cd", product: "x", productCode: 1, version: "" }, NOW);
        assert.equal(r.fixtures[0]!.mac, MAC_A);
    });

    it("同じ器具を二重に登録しない", () => {
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: MAC_A, product: "CODE_2B", productCode: 0x2b, version: "v1" }, NOW);
        upsert(r, { mac: MAC_A, product: "CODE_2B", productCode: 0x2b, version: "v1" }, NOW);
        assert.equal(r.fixtures.length, 1);
    });

    it("⭐ 内容が変わらなければ false を返す（無駄な書き込みを避ける）", () => {
        const r: Roster = { version: 1, fixtures: [] };
        assert.equal(upsert(r, { mac: MAC_A, product: "A", productCode: 1, version: "v1" }, NOW), true);
        assert.equal(upsert(r, { mac: MAC_A, product: "A", productCode: 1, version: "v1" }, NOW), false);
        // 製品コードが判明したら書き込む
        assert.equal(upsert(r, { mac: MAC_A, product: "A", productCode: 2, version: "v1" }, NOW), true);
    });

    it("MAC 順に並ぶ（差分を読みやすくする）", () => {
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: MAC_A, product: "A", productCode: 1, version: "" }, NOW);
        upsert(r, { mac: MAC_B, product: "B", productCode: 1, version: "" }, NOW);
        assert.deepEqual(r.fixtures.map(f => f.mac), [MAC_B, MAC_A].sort());
    });

    it("明示的に消せる（器具を本当に外したとき）", () => {
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: MAC_A, product: "A", productCode: 1, version: "" }, NOW);
        assert.equal(remove(r, "ec:c5:7f:81:de:cd"), true);
        assert.equal(r.fixtures.length, 0);
        assert.equal(remove(r, MAC_A), false);
    });

    it("保存は一時ファイル経由（書き込み中の電断で名簿が壊れない）", () => {
        const p = fresh("atomic.json");
        const r: Roster = { version: 1, fixtures: [] };
        upsert(r, { mac: MAC_A, product: "A", productCode: 1, version: "" }, NOW);
        saveRoster(p, r);
        // .tmp が残っていないこと
        assert.throws(() => readFileSync(`${p}.tmp`, "utf8"));
        assert.ok(readFileSync(p, "utf8").includes(MAC_A));
    });

    it("名簿の場所はストレージ直下の fixtures.json", () => {
        assert.equal(rosterPath("/var/lib/odelic-matter"), join("/var/lib/odelic-matter", "fixtures.json"));
        assert.equal(rosterPath(DEFAULT_CONFIG.matter.storagePath), join(DEFAULT_CONFIG.matter.storagePath, "fixtures.json"));
    });
});
