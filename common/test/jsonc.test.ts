/**
 * JSONC パーサのテスト。元は `odelic-matter` の `config.test.ts` にあったものを、
 * `odelic-web` と共有するのに合わせて移した。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripJsonComments } from "../src/jsonc.js";

describe("stripJsonComments", () => {
    it("行コメントとブロックコメントを落とす", () => {
        assert.equal(JSON.parse(stripJsonComments('{"a":1 /* x */, "b":2 // y\n}')).b, 2);
    });

    it("⚠️ 文字列の中の // は消さない（URL が壊れる）", () => {
        const parsed = JSON.parse(stripJsonComments('{"url":"http://127.0.0.1:8080"}')) as { url: string };
        assert.equal(parsed.url, "http://127.0.0.1:8080");
    });

    it("⚠️ 文字列の中の /* も消さない", () => {
        const parsed = JSON.parse(stripJsonComments('{"a":"/* not a comment */"}')) as { a: string };
        assert.equal(parsed.a, "/* not a comment */");
    });

    it("エスケープされた引用符に惑わされない", () => {
        const parsed = JSON.parse(stripJsonComments('{"a":"x\\"// y"}')) as { a: string };
        assert.equal(parsed.a, 'x"// y');
    });

    it("コメントが無ければそのまま返す", () => {
        const src = '{"a":1,"b":[2,3]}';
        assert.equal(stripJsonComments(src), src);
    });

    it("閉じていないブロックコメントで無限ループしない", () => {
        assert.equal(stripJsonComments('{"a":1} /* 閉じ忘れ').trim(), '{"a":1}');
    });
});
