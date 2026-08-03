/**
 * `@odelic/common` — `odelic-matter` と `odelic-web` が共有するもの。
 *
 * ⚠️ ここに置くのは**二重に持つと必ずずれるもの**だけ。
 *
 * | 置く | 置かない |
 * | --- | --- |
 * | 製品コード → 器具の能力（`capability.ts`） | Matter 固有の量子化（level 1〜254 / mired） |
 * | 明るさの段の定義（`ladder.ts`） | 器具名・名簿（ブリッジが所有） |
 * | 器具一覧を MAC ごとに畳む（`devices.ts`） | 器具の並び順（画面ごとに違う） |
 * | MAC の正規化（`mac.ts`） | HTTP クライアント（用途が違うので各自） |
 * | 設定ファイルの JSONC パーサ（`jsonc.ts`） | 設定の項目そのもの（サービスごとに違う） |
 *
 * ⭐ **`dist/src/*.js` は node の API を一切使わない素の ESM。**
 * `odelic-web` はこれを `/vendor/common/` としてブラウザへそのまま配り、
 * 段の計算を UI と共有する（スライダーのために段の定義を書き直さないため）。
 */

export * from "./capability.js";
export * from "./devices.js";
export * from "./jsonc.js";
export * from "./ladder.js";
export * from "./mac.js";
