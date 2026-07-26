/**
 * コメント付き JSON（JSONC）を素の JSON にする。
 *
 * ## なぜ共有するのか
 *
 * `odelic-matter` と `odelic-web` は**同じ書き方の設定ファイル**を読む
 * （`config.example.json` にコメントを書いて配布し、install.sh がそれを
 * `/etc/<service>/config.json` の雛形にする）。
 *
 * ⚠️ パーサが 2 つに分かれると、**片方では読める設定例がもう片方では読めない**
 * という分かりにくい壊れ方をする。1 つに寄せる。
 */

/**
 * `//` 行コメントと `/* *\/` ブロックコメントを落とす。
 *
 * ⚠️ **文字列リテラルの中は触らない。**`"http://127.0.0.1:8080"` の `//` を
 * コメントとして消すと URL が壊れる（実際に踏みやすい）。
 */
export function stripJsonComments(text: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i]!;
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
