/**
 * `@odelic/common` — `odelic-matter` と `odelic-web` が共有するもの。
 *
 * ⚠️ ここに置くのは**二重に持つと必ずずれるもの**だけ。
 *
 * | 置く | 置かない |
 * | --- | --- |
 * | 製品コード → 器具の能力（`capability.ts`） | Matter 固有の量子化（level 1〜254 / mired） |
 * | 明るさの段の定義（`ladder.ts`） | 器具名・名簿（ブリッジが所有） |
 * | | HTTP クライアント（用途が違うので各自） |
 */
export * from "./capability.js";
export * from "./ladder.js";
//# sourceMappingURL=index.js.map