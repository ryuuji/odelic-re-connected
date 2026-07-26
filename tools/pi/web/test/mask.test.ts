/**
 * ログのマスクのテスト。⭐ **ここが漏れると秘密がそのまま画面に出る**（docs/09 H7）。
 *
 * 入れてある行は**実機の journal から採った実際の形**（値だけリポジトリの
 * プレースホルダ `12345678` / `D2 04 00 00` / `35 36 37 38` に置き換えてある）。
 *
 * 見るのは 2 つ。
 *
 * 1. ⭐ **秘密が 1 つも通り抜けないこと**
 * 2. ⭐ **行が消えていないこと**（`grep -v` で捨てると原因を追えなくなる）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maskLine, maskRuleReasons, maskSecrets } from "../src/mask.js";

/** リポジトリのプレースホルダ。⚠️ 実値は書かない（PLAN.md の方針） */
const ID = "12345678";
const PASSWORD_BYTES = "35 36 37 38";
const LOGINKEY = "D2 35 04 36 00 37 00 38 4C 4F 47 49 4E 4B 45 59";
const EVENTKEY = "D2 35 04 36 00 37 00 38 45 56 45 4E 54 4B 45 59";
const LINK_KEY = "BD E1 AC C3";
const MANUAL_CODE = "34970112332";

describe("odelicd の起動ログ", () => {
    const line = `[    0.012] ID ${ID} → HOMEID D2 04 00 00 / パスワード ${PASSWORD_BYTES}`;

    it("⭐ 8 桁 ID の下位 4 桁（＝メッシュのパスワード）が消える", () => {
        const out = maskLine(line);
        assert.ok(!out.includes(ID), out);
        assert.ok(out.includes("1234••••"), out);
    });

    it("⭐ パスワードのバイト列が消える", () => {
        const out = maskLine(line);
        assert.ok(!out.includes(PASSWORD_BYTES), out);
        assert.ok(out.includes("パスワード •• •• •• ••"), out);
    });

    it("HOMEID の上位 4 桁は残る（診断に要る。パスワードではない）", () => {
        assert.ok(maskLine(line).includes("HOMEID D2 04 00 00"), maskLine(line));
    });

    it("⭐ 行そのものは消えない", () => {
        const out = maskLine(line);
        assert.ok(out.startsWith("[    0.012] ID "), out);
        assert.ok(out.includes("→"), out);
    });
});

describe("鍵の導出ログ", () => {
    const line = `[    0.035] 鍵を導出: LOGINKEY ${LOGINKEY} / EVENTKEY ${EVENTKEY}  ログイン応答=する  SET_LINK=never`;

    it("⚠️⚠️ LOGINKEY はパスワードを 1 バイトおきに含む。必ず消える", () => {
        const out = maskLine(line);
        assert.ok(!out.includes(LOGINKEY), out);
        assert.ok(!out.includes("35 04 36"), out);
    });

    it("EVENTKEY も消える", () => {
        assert.ok(!maskLine(line).includes(EVENTKEY), maskLine(line));
    });

    it("⭐ 前後の診断情報は残る", () => {
        const out = maskLine(line);
        assert.ok(out.includes("鍵を導出:"), out);
        assert.ok(out.includes("ログイン応答=する"), out);
        assert.ok(out.includes("SET_LINK=never"), out);
    });
});

describe("リンクごとの鍵", () => {
    const line = `[    3.912] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = ${LINK_KEY}`;

    it("⭐ XOR ホワイトニング鍵が消える（これがあると受信を復号できる）", () => {
        const out = maskLine(line);
        assert.ok(!out.includes(LINK_KEY), out);
        assert.ok(out.includes("の鍵 = •• •• •• ••"), out);
    });

    it("⚠️ 器具の MAC は残す（診断に要る。LAN 内の機器名と同程度）", () => {
        assert.ok(maskLine(line).includes("EC:C5:7F:81:DE:CD"), maskLine(line));
    });
});

describe("Matter の commissioning", () => {
    it("⭐ 手入力コードが消える（これだけで別の家から参加できる）", () => {
        const out = maskLine(`  手入力コード : ${MANUAL_CODE}`);
        assert.ok(!out.includes(MANUAL_CODE), out);
        assert.ok(out.includes("手入力コード : •••••••••••"), out);
    });

    it("⭐ QR ペイロードが消える", () => {
        const out = maskLine("  QR ペイロード: MT:Y.K9042C00KA0648G00");
        assert.ok(!out.includes("Y.K9042C00KA0648G00"), out);
        assert.ok(out.includes("MT:"), out);
    });

    it("passcode が消える", () => {
        const out = maskLine("commissioning: passcode=20202021 discriminator=3840");
        assert.ok(!out.includes("20202021"), out);
        // ⚠️ discriminator は公開情報なので残す
        assert.ok(out.includes("discriminator=3840"), out);
    });
});

describe("⭐ 意図的に潰さないもの", () => {
    it("アドバタイズの AD は残す（電波に平文で乗っているので隠す意味がない）", () => {
        const line = "[    2.755] アドバタイズ開始 E0:5C:04:05:82:D7  AD=02 01 06 10 FF 00 00 C0 FF D2 04 00 00 D8 A3 40 F8 6B BF";
        assert.equal(maskLine(line), line);
    });

    it("計測行は素通りする", () => {
        const line = "[    3.885] #M link_up mac=EC:C5:7F:80:28:A6 links=1 via=write";
        assert.equal(maskLine(line), line);
    });

    it("PDU のダンプは素通りする（照明コマンドは電波上も平文）", () => {
        const line = "  ↑送信 [20] 03 FF FF FF FF 20 25 00 00 00 C1 37 37 00 00 00 00 00 00 00";
        assert.equal(maskLine(line), line);
    });
});

describe("maskSecrets（複数行）", () => {
    const log = [
        `[    0.012] ID ${ID} → HOMEID D2 04 00 00 / パスワード ${PASSWORD_BYTES}`,
        `[    0.035] 鍵を導出: LOGINKEY ${LOGINKEY} / EVENTKEY ${EVENTKEY}`,
        "[    0.450] HTTP API を開始: http://0.0.0.0:8080/",
        `[    3.912] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = ${LINK_KEY}`,
        "[    3.988] ★ 参加完了（器具 2 台）",
    ].join("\n");

    it("⭐⭐ 秘密が 1 つも通り抜けない", () => {
        const out = maskSecrets(log);
        for (const secret of [ID, PASSWORD_BYTES, LOGINKEY, EVENTKEY, LINK_KEY]) {
            assert.ok(!out.includes(secret), `${secret} が残っている:\n${out}`);
        }
    });

    it("⭐ 行数が変わらない（行ごと捨てない）", () => {
        assert.equal(maskSecrets(log).split("\n").length, log.split("\n").length);
    });

    it("秘密を含まない行はそのまま", () => {
        const out = maskSecrets(log).split("\n");
        assert.equal(out[2], "[    0.450] HTTP API を開始: http://0.0.0.0:8080/");
        assert.equal(out[4], "[    3.988] ★ 参加完了（器具 2 台）");
    });

    it("空文字でも落ちない", () => {
        assert.equal(maskSecrets(""), "");
    });
});

describe("マスク規則の一覧", () => {
    it("何を守っているかが説明できる（ドキュメントとの対応）", () => {
        const reasons = maskRuleReasons();
        assert.ok(reasons.length >= 7, `規則が少なすぎる: ${reasons.length}`);
        assert.ok(reasons.every(r => r.length > 0));
    });
});
