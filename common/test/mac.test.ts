/**
 * MAC の扱いのテスト。
 *
 * ⭐ ここがずれると**ブリッジの器具名と `odelic-web` のカードが一致しない**。
 * 元は `odelic-matter` の `config.test.ts` にあったものを、共有化に合わせて移した。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultFixtureName, isUnknownMac, normalizeMac } from "../src/mac.js";

describe("normalizeMac", () => {
    it("区切りの揺れを吸収する", () => {
        for (const s of ["ec:c5:7f:81:de:cd", "EC-C5-7F-81-DE-CD", "ecc57f81decd", "ec c5 7f 81 de cd"]) {
            assert.equal(normalizeMac(s), "EC:C5:7F:81:DE:CD", s);
        }
    });

    it("⭐ 何度通しても同じ（冪等）", () => {
        const once = normalizeMac("ec-c5-7f-81-de-cd");
        assert.equal(normalizeMac(once), once);
    });

    it("⚠️ 12 桁にならないものは捨てずに大文字化だけして返す", () => {
        // 捨てるとキーが消えて器具が行方不明になる
        assert.equal(normalizeMac("なんだこれ"), "なんだこれ");
        assert.equal(normalizeMac("ec:c5:7f"), "EC:C5:7F");
    });
});

describe("isUnknownMac", () => {
    it("Ping 応答前の器具（オール 0）を見分ける", () => {
        assert.equal(isUnknownMac("00:00:00:00:00:00"), true);
        assert.equal(isUnknownMac("000000000000"), true);
        assert.equal(isUnknownMac("EC:C5:7F:81:DE:CD"), false);
    });
});

describe("defaultFixtureName", () => {
    it("名前が無い器具にも既定名が付く（設定漏れで名無しにならないため）", () => {
        assert.equal(defaultFixtureName("EC:C5:7F:81:DE:CD"), "ODELIC 81DECD");
        assert.equal(defaultFixtureName("ec-c5-7f-80-28-a6"), "ODELIC 8028A6");
    });

    it("⭐ 2 台の器具で名前が衝突しない", () => {
        assert.notEqual(
            defaultFixtureName("EC:C5:7F:81:DE:CD"),
            defaultFixtureName("EC:C5:7F:80:28:A6"),
        );
    });
});
