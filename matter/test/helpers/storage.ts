/**
 * ⚠️⚠️ **matter.js のストレージをテストファイルごとに分ける。**
 *
 * ## 踏んだ罠
 *
 * `node --test` はテストファイルを**別プロセスで並列に**走らせる。
 * ところが `ServerNode` の id は `odelic-bridge` 固定なので、
 * 2 つのテストファイルが `ServerNode` を作ると**同じストレージを取り合う**。
 * matter.js はディレクトリロックを持っているため、後から来たほうが
 * **ロック待ちで永久に止まる**（`npm test` が 4 分でタイムアウトした）。
 *
 * ## ⚠️ `before()` で環境変数を設定しても遅い
 *
 * `MATTER_STORAGE_PATH` は matter.js が **import 時**に読む
 * （`Environment.default` が作られるのがそこ）。`before()` で書いても
 * すでに既定の場所（`~/AppData/Roaming/matter` など）が決まっている。
 *
 * → ⭐ **このモジュールを `@matter` より前に import する。**
 *   ESM の副作用 import は宣言順に評価されるので、
 *   テストファイルの一番上に置けば間に合う。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MATTER_STORAGE = mkdtempSync(join(tmpdir(), "odelic-matter-store-"));

process.env.MATTER_STORAGE_PATH = MATTER_STORAGE;

/** テストの後始末で呼ぶ。 */
export function cleanupMatterStorage(): void {
    rmSync(MATTER_STORAGE, { recursive: true, force: true });
}
