/**
 * 器具の MAC アドレスの扱い。**プロトコル由来ではないが、二重に持つと必ずずれる**ので
 * `odelic-matter` と `odelic-web` で共有する。
 *
 * ## ⭐ なぜ共有するのか
 *
 * 器具の同一性は **MAC** で取る（vAddr は変わり得る・docs/07-matter.md §7-4）。
 * ブリッジは MAC をキーに器具名と名簿を持ち、`odelic-web` はその名前を引く。
 * **正規化の仕方が 1 文字でも違えば器具名が一致しない**（`ec:c5:…` と `EC:C5:…` が
 * 別物になる）ので、ここに 1 つだけ置く。
 *
 * ⚠️ Matter 固有のもの（`macToEndpointId`）はここに入れない。
 * それは `odelic-matter` の `config.ts` の仕事。
 */

/**
 * MAC を大文字コロン区切りに正規化する。設定の書き方の揺れを吸収する。
 *
 * ⚠️ 16 進 12 桁として解釈できないものは**大文字化だけして返す**。
 * 捨てるとキーが消えて器具が行方不明になるため。
 */
export function normalizeMac(mac: string): string {
    const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (hex.length !== 12) return mac.toUpperCase();
    return (hex.match(/.{2}/g) ?? []).join(":");
}

/**
 * MAC が未取得（オール 0）かどうか。
 *
 * `odelicd` は Ping 応答が返るまで `00:00:00:00:00:00` を返す。この器具は
 * 同一性を取れないので、エンドポイントも UI のカードも作れない。
 */
export function isUnknownMac(mac: string): boolean {
    return normalizeMac(mac) === "00:00:00:00:00:00";
}

/** 名前が設定されていない器具の既定名。⭐ 設定漏れで器具が名無しにならないように。 */
export function defaultFixtureName(mac: string): string {
    const hex = normalizeMac(mac).replace(/:/g, "");
    return `ODELIC ${hex.slice(-6)}`;
}
