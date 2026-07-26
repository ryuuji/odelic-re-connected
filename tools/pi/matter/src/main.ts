#!/usr/bin/env node
/**
 * odelic-matter — ODELIC CONNECTED LIGHTING を Matter ブリッジとして公開する。
 *
 * odelicd（BLE 側）はそのまま。こちらは HTTP でつないで Matter の顔をかぶせるだけ。
 * ⭐ **BLE は一切触らない**（`@matter/nodejs-ble` を入れていない）。Pi の
 * 唯一の BLE アダプタは odelicd が握ったままで、commissioning は
 * オンネットワーク（mDNS / IPv6）で行う。
 *
 *   使い方: node dist/src/main.js --config /etc/odelic-matter/config.json
 *
 * 環境変数でも指定できる（systemd 用）:
 *   ODELIC_MATTER_CONFIG   設定ファイルのパス
 *   MATTER_STORAGE_PATH    matter.js のストレージ位置（設定の matter.storagePath を上書き）
 */

import { LogLevel, Logger } from "@matter/main";

import { AdminServer } from "./admin.js";
import { BRIDGE_VERSION, Bridge, applySavedSettings } from "./bridge.js";
import { loadConfig } from "./config.js";

const START = Date.now();

// ⚠️ matter.js の既定は DEBUG で、journald が 1 秒に何行も埋まる。
//    NOTICE を既定にする（commissioning コードは NOTICE なので消えない）。
//    MATTER_LOG_LEVEL=debug で詳細に戻せる。
Logger.level = LogLevel(process.env.MATTER_LOG_LEVEL ?? "notice");

function log(msg: string): void {
    const t = ((Date.now() - START) / 1000).toFixed(3).padStart(9);
    console.log(`[${t}] ${msg}`);
}

function parseArgs(argv: string[]): { config?: string; help: boolean } {
    const out: { config?: string; help: boolean } = { help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--help" || a === "-h") out.help = true;
        else if (a === "--config" || a === "-c") out.config = argv[++i];
        else if (a.startsWith("--config=")) out.config = a.slice("--config=".length);
        else log(`[!] 不明な引数を無視します: ${a}`);
    }
    return out;
}

const USAGE = `odelic-matter — ODELIC 照明を Matter ブリッジとして公開する

  --config, -c <path>   設定ファイル（JSON。// コメント可）
  --help,   -h          このヘルプ

設定を省略すると既定値で動く（odelicd = http://127.0.0.1:8080）。
設定例は config.example.json を参照。`;

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }

    const path = args.config ?? process.env.ODELIC_MATTER_CONFIG;
    let config;
    try {
        config = loadConfig(path, msg => log(`[!] ${msg}`));
    } catch (e) {
        log(`[!] ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    log(`odelic-matter ${BRIDGE_VERSION} / matter.js のログレベル = ${Logger.level}`);
    log(path === undefined ? "設定ファイルの指定がないので既定値で動きます" : `設定を読みました: ${path}`);

    const storage = process.env.MATTER_STORAGE_PATH ?? config.matter.storagePath;
    if (storage !== config.matter.storagePath) {
        config.matter.storagePath = storage;
        log(`ストレージ位置を環境変数で上書き: ${storage}`);
    }
    // matter.js は Environment 経由でストレージ位置を受け取る
    process.env.MATTER_STORAGE_PATH = storage;

    // ⭐ 設定ページで変えた値を config.json の上に重ねる。
    //    ⚠️ config.json を書き戻すとコメントが消えるので別ファイルにしてある
    const overridden = applySavedSettings(config, msg => log(`[!] ${msg}`));
    if (overridden.length > 0) log(`設定ページの保存内容を反映: ${overridden.join(" / ")}`);

    log(`odelicd = ${config.odelicd} / ポーリング ${config.pollMs} ms / デバウンス ${config.debounceMs} ms`);
    log(
        `明るさ軸: 下端 ${config.nightBandPercent}% を常夜灯に割り当て / ` +
            `色温度 ${config.colorTempMinKelvin}〜${config.colorTempMaxKelvin}K` +
            `${config.colorTempInverted ? "（向き反転）" : ""}`,
    );
    if (config.waitMs > 0) {
        log(`収束確認あり: odelicd の ?wait=1&timeout=${config.waitMs} を使います`);
    } else {
        log("⚠️ 収束確認なし（waitMs = 0）。送信の成否だけを見ます");
    }

    const bridge = new Bridge({ config, log });
    const admin = config.admin.enabled
        ? new AdminServer({ bridge, host: config.admin.host, port: config.admin.port, log })
        : undefined;

    let stopping = false;
    const shutdown = (signal: string): void => {
        if (stopping) return;
        stopping = true;
        log(`${signal} を受けたので終了します`);
        void Promise.resolve()
            .then(() => admin?.stop())
            .then(() => bridge.stop())
            .catch(e => log(`[!] 終了処理で例外: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // ⭐ 設定ページからの再起動は「きれいに終わる」で実現する（systemd が上げ直す）
    bridge.onRestartRequest = () => shutdown("設定ページからの再起動要求");

    try {
        await bridge.start();
    } catch (e) {
        log(`[!] 起動に失敗: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return 1;
    }

    if (admin !== undefined) {
        try {
            await admin.start();
        } catch (e) {
            // ⚠️ 管理 API が上がらなくても Matter は動く。止めずに理由だけ大きく出す
            log(`[!] 管理 API を開始できません: ${e instanceof Error ? e.message : String(e)}`);
            log("    設定ページからの器具名の変更と Matter の登録操作は使えません");
        }
    } else {
        log("管理 API は無効です（設定 admin.enabled = false）。設定ページから操作できません");
    }

    for (const line of bridge.describe()) log(line);
    log("起動完了。Ctrl-C か SIGTERM で終了します");
    // ServerNode がイベントループを保持するので、ここで return しても走り続ける
    return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
