/**
 * `odelic-web` の設定。
 *
 * 書き方は `odelic-matter` の `config.ts` と揃えてある
 * （⚠️ 未知のキーは黙って捨てず警告する。設定の書き間違いが
 * 「なぜか反映されない」という形で出るのを避けるため）。
 *
 * ⚠️ **秘密情報はここに入れない。**パスワードのハッシュは `stateDir/auth.json`（0600）、
 * メッシュの 8 桁 ID は `/etc/default/odelicd`（0600 root）にあり、
 * `odelic-web` のプロセスは実値を一切持たない。
 */

import { readFileSync } from "node:fs";

import { stripJsonComments } from "@odelic/common";

export interface WebConfig {
    /** ⭐ 照明の操作先。ブリッジを経由しない */
    odelicd: string;
    /** ブリッジの管理 API。⚠️ localhost 限定で動いている前提 */
    bridgeAdmin: string;
    /** ⭐ HTTPS と HTTP リダイレクトを兼ねる 1 ポート */
    port: number;
    bind: string;
    tlsDir: string;
    stateDir: string;
    sessionMaxAgeSec: number;
    waitMs: number;
    setIdHelper: string;
    /** ⚠️ ログ画面で journalctl に渡してよい unit 名のホワイトリスト */
    logUnits: string[];
    logMaxLines: number;
}

export const DEFAULT_CONFIG: WebConfig = {
    odelicd: "http://127.0.0.1:8080",
    bridgeAdmin: "http://127.0.0.1:8081",
    port: 8443,
    bind: "::",
    tlsDir: "/etc/odelic-web/tls",
    stateDir: "/var/lib/odelic-web",
    sessionMaxAgeSec: 7 * 24 * 60 * 60,
    waitMs: 1500,
    setIdHelper: "/opt/odelic-web/set-id.sh",
    logUnits: ["odelicd", "odelic-matter", "odelic-web"],
    logMaxLines: 500,
};

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadConfig(path: string | undefined, warn: (msg: string) => void = console.warn): WebConfig {
    if (path === undefined) return { ...DEFAULT_CONFIG, logUnits: [...DEFAULT_CONFIG.logUnits] };

    let raw: unknown;
    try {
        raw = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    } catch (e) {
        throw new Error(`設定ファイルを読めません (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isRecord(raw)) throw new Error(`設定ファイルの中身がオブジェクトではありません: ${path}`);

    const cfg: WebConfig = { ...DEFAULT_CONFIG, logUnits: [...DEFAULT_CONFIG.logUnits] };

    for (const [key, value] of Object.entries(raw)) {
        switch (key) {
            case "odelicd":
            case "bridgeAdmin":
            case "bind":
            case "tlsDir":
            case "stateDir":
            case "setIdHelper":
                if (typeof value === "string" && value !== "") cfg[key] = value;
                else warn(`設定 ${key} は空でない文字列で指定してください`);
                break;
            case "port":
            case "sessionMaxAgeSec":
            case "waitMs":
            case "logMaxLines":
                if (typeof value === "number" && Number.isFinite(value)) cfg[key] = value;
                else warn(`設定 ${key} は数値で指定してください`);
                break;
            case "logUnits":
                if (Array.isArray(value) && value.every(v => typeof v === "string")) {
                    cfg.logUnits = value as string[];
                } else {
                    warn("設定 logUnits は文字列の配列で指定してください");
                }
                break;
            default:
                warn(`設定に未知のキーがあります（無視します）: ${key}`);
        }
    }

    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
        throw new Error(`port は 1〜65535 の整数で指定してください（今: ${cfg.port}）`);
    }
    // ⚠️ ここを緩めると「ログ画面から任意の unit を覗ける」になる
    if (cfg.logUnits.some(u => !/^[A-Za-z0-9@._-]+$/.test(u))) {
        throw new Error("logUnits に unit 名として使えない文字が入っています");
    }
    if (cfg.logMaxLines < 1) throw new Error("logMaxLines は 1 以上で指定してください");
    return cfg;
}
