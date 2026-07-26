/**
 * ログに出る秘密情報を潰す。
 *
 * ⚠️⚠️ **`journalctl` の出力には秘密がそのまま出る。**表示前に必ずここを通す
 * （docs/09 H7）。
 *
 * ## ⭐ 行を捨てず、値だけを潰す
 *
 * `grep -v` で行ごと落とすと「なぜ動かないか」を追えなくなる。
 * **バイト 1 個を `••` に置き換え、長さと構造は残す。**
 *
 * ## 実際のログに出ている形（実機の journal から採取）
 *
 * ```
 * [ 0.012] ID 12345678 → HOMEID D2 04 00 00 / パスワード 35 36 37 38
 * [ 0.035] 鍵を導出: LOGINKEY D2 35 04 36 00 37 00 38 4C 4F 47 49 4E 4B 45 59 / EVENTKEY ...
 * [ 3.912] ★ ログイン要求を復号: EC:C5:7F:81:DE:CD の鍵 = BD E1 AC C3
 *          手入力コード : 34970112332
 *          QR ペイロード: MT:Y.K9042C00KA0648G00
 * ```
 *
 * ⚠️ **`LOGINKEY` の 16 バイトにはパスワードが 1 バイトおきに入っている**
 * （`homeid[0] pwd[0] homeid[1] pwd[1] …` + 固定文字列・docs C21）。
 * 「鍵だから平文ではない」ではない。**必ず潰す。**
 *
 * ## ⭐ 意図的に潰さないもの
 *
 * - `アドバタイズ開始 … AD=02 01 06 …`（HOMEID を含むが、
 *   **これは電波に平文で乗っている**ので隠しても意味がない。診断価値のほうが高い）
 * - `discriminator` / VID / PID（公開情報）
 * - 器具の MAC（LAN 内の機器名と同程度。診断に要る）
 */

const DOT = "••";

/** 16 進バイト列（`D2 04 00 00` / `D2:04:00:00` / `D2040000`）を潰す。区切りは残す。 */
function maskHexBytes(hex: string): string {
    return hex.replace(/[0-9A-Fa-f]{2}/g, DOT);
}

/** 数字列を同じ長さの `•` にする。 */
function maskDigits(s: string): string {
    return s.replace(/\d/g, "•");
}

interface Rule {
    /** 何を守っているか。テストとドキュメントのため */
    readonly why: string;
    readonly apply: (line: string) => string;
}

const RULES: readonly Rule[] = [
    {
        why: "8 桁 ID の下位 4 桁はメッシュのパスワードそのもの",
        // `ID 12345678` / `ODELIC_ID=12345678` / `ID:12345678`
        apply: line =>
            line.replace(/\b(ODELIC_ID\s*=\s*|ID\s*[:：]?\s+)(\d{4})(\d{4})\b/g, (_m, lead: string, hi: string) => `${lead}${hi}••••`),
    },
    {
        why: "パスワードの ASCII バイト列（`35 36 37 38`）",
        apply: line =>
            line.replace(/((?:パスワード|password)\s*[:：=]?\s*)((?:[0-9A-Fa-f]{2}[\s:]+)*[0-9A-Fa-f]{2})/gi, (_m, lead: string, hex: string) => lead + maskHexBytes(hex)),
    },
    {
        why: "⚠️ LOGINKEY / EVENTKEY はパスワードを 1 バイトおきに含む（C21）",
        apply: line =>
            line.replace(/\b(LOGINKEY|EVENTKEY)(\s+)((?:[0-9A-Fa-f]{2}[\s:]+)*[0-9A-Fa-f]{2})/g, (_m, name: string, sp: string, hex: string) => name + sp + maskHexBytes(hex)),
    },
    {
        why: "リンクごとの XOR ホワイトニング鍵（これがあると受信を復号できる）",
        apply: line =>
            line.replace(/((?:の鍵|鍵|key)\s*[=＝]\s*)((?:[0-9A-Fa-f]{2}[\s:]+)*[0-9A-Fa-f]{2})/gi, (_m, lead: string, hex: string) => lead + maskHexBytes(hex)),
    },
    {
        why: "Matter の手入力コード（これだけで別の家から commissioning できる）",
        apply: line =>
            line.replace(/((?:手入力コード|manual\s*pairing\s*code)\s*[:：]?\s*)([\d-]{8,})/gi, (_m, lead: string, code: string) => lead + maskDigits(code)),
    },
    {
        why: "Matter の QR ペイロード（手入力コードと同じ効力）",
        apply: line => line.replace(/\bMT:[A-Z0-9.$%*+\-/:]+/g, "MT:••••••••••"),
    },
    {
        why: "Matter の passcode",
        apply: line => line.replace(/\b(passcode\s*[:=]?\s*)(\d{4,})/gi, (_m, lead: string, code: string) => lead + maskDigits(code)),
    },
];

/** 1 行をマスクする。 */
export function maskLine(line: string): string {
    let out = line;
    for (const rule of RULES) out = rule.apply(out);
    return out;
}

/** 複数行をマスクする。⚠️ 行数は変えない（何行目で何が起きたかを追えるように）。 */
export function maskSecrets(text: string): string {
    return text.split("\n").map(maskLine).join("\n");
}

/** テストとドキュメント用。何を守っているかの一覧。 */
export function maskRuleReasons(): string[] {
    return RULES.map(r => r.why);
}
