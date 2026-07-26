#!/usr/bin/env node
/**
 * odelic-web — ODELIC Re-Connected ウェブ管理画面（設定ページとスマートフォン UI）。
 *
 *   使い方: node dist/src/main.js --config /etc/odelic-web/config.json
 *
 * 環境変数でも指定できる（systemd 用）:
 *   ODELIC_WEB_CONFIG    設定ファイルのパス
 *
 * ## この 3 つは触らない
 *
 * | | |
 * | --- | --- |
 * | `odelicd` | BLE の安定性を実測で詰めた資産（docs C33）。HTTP で呼ぶだけ |
 * | `odelic-matter` | Matter の状態機械を持つ。管理 API で読み書きするだけ |
 * | `/etc/default/odelicd` | 0600 root。⭐ `set-id.sh` 経由でしか触らない |
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Auth } from "./auth.js";
import { BridgeClient } from "./bridge.js";
import { loadConfig } from "./config.js";
import { Journal, serviceStatus } from "./journal.js";
import { OdelicClient } from "./odelicd.js";
import { createHandler } from "./routes.js";
import { startListener } from "./server.js";
import { SetId } from "./setid.js";
import { ApiScope } from "./apiscope.js";
import { Backup } from "./backup.js";

export const WEB_VERSION = "0.1.0";

const START = Date.now();

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

const USAGE = `odelic-web — ODELIC Re-Connected ウェブ管理画面

  --config, -c <path>   設定ファイル（JSON。// コメント可）
  --help,   -h          このヘルプ

設定を省略すると既定値で動く（odelicd = http://127.0.0.1:8080 / ポート 8443）。
設定例は config.example.json を参照。`;

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }

    const path = args.config ?? process.env.ODELIC_WEB_CONFIG;
    let config;
    try {
        config = loadConfig(path, msg => log(`[!] ${msg}`));
    } catch (e) {
        log(`[!] ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    log(`odelic-web ${WEB_VERSION}`);
    log(path === undefined ? "設定ファイルの指定がないので既定値で動きます" : `設定を読みました: ${path}`);

    // dist/src/main.js から見たパッケージのルート
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const publicDir = join(pkgRoot, "public");

    const certPath = join(config.tlsDir, "server.crt");
    const keyPath = join(config.tlsDir, "server.key");
    const caPath = join(config.tlsDir, "ca.crt");

    let tls;
    try {
        tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    } catch (e) {
        // ⚠️ ここで落ちるのは「gencert.sh を実行していない」か「鍵が読めない」の 2 択。
        //    どちらかを言い切れるようにする
        log(`[!] TLS 証明書を読めません: ${e instanceof Error ? e.message : String(e)}`);
        log(`    ⭐ 生成する:   sudo ${join(pkgRoot, "gencert.sh")}`);
        log(`    ⚠️ 鍵の権限:   ${keyPath} は 0640 で odelic-web グループが読める必要があります`);
        return 1;
    }

    const auth = new Auth({
        file: join(config.stateDir, "auth.json"),
        sessionMaxAgeSec: config.sessionMaxAgeSec,
        warn: msg => log(`[!] ${msg}`),
    });
    if (!auth.configured) {
        // ⚠️ ここに来たら誰もログインできない。理由を言い分ける
        if (auth.problem !== null) {
            log("[!] ⚠️ パスワードのファイルはありますが使えません。上の理由を直してください");
        } else {
            log("[!] パスワードが設定されていません。sudo ./install.sh を実行してください");
        }
    }

    const odelicd = new OdelicClient({ baseUrl: config.odelicd, waitMs: config.waitMs, log });
    const bridge = new BridgeClient(config.bridgeAdmin, log);
    const journal = new Journal({ allowedUnits: config.logUnits, maxLines: config.logMaxLines });
    const setId = new SetId({ helper: config.setIdHelper, log });
    const apiScope = new ApiScope({ helper: config.setApiHelper, log });
    const backup = new Backup({ helper: config.backupHelper, log });

    const handler = createHandler({
        config,
        auth,
        odelicd,
        bridge,
        journal,
        setId,
        apiScope,
        backup,
        publicDir,
        caPath,
        version: WEB_VERSION,
        log,
    });

    let listener;
    try {
        listener = await startListener({
            tls,
            handler,
            port: config.port,
            bind: config.bind,
            log,
        });
    } catch (e) {
        log(`[!] ポート ${config.port} を待ち受けられません: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }

    log(`HTTPS を開始: https://<このホスト>:${listener.port}/`);
    log(`  ⭐ 平文 HTTP で来ても同じポートで受けて https:// にリダイレクトします`);
    log(`  ⭐ CA 証明書は認証なしで取れます: https://<このホスト>:${listener.port}/ca.crt`);
    log(`  odelicd = ${config.odelicd} / ブリッジ管理 API = ${config.bridgeAdmin}`);
    log(`  収束確認 = ${config.waitMs} ms / セッション有効期限 = ${config.sessionMaxAgeSec} 秒`);

    // 起動時の見取り図。⚠️ 落ちていても起動は止めない（あとから復帰する）
    void (async () => {
        const services = await serviceStatus(config.logUnits);
        for (const [unit, state] of Object.entries(services)) {
            log(`  ${unit}: ${state}`);
        }
        if ((await odelicd.info(3000)) === null) {
            log(`[!] ${config.odelicd} に応答がありません。照明の操作はできません（復帰は自動）`);
        }
        if (!(await bridge.state()).reachable) {
            log(`[!] ブリッジ管理 API に応答がありません。器具名は既定名になります（照明の操作は可能）`);
        }
    })();

    let stopping = false;
    const shutdown = (signal: string): void => {
        if (stopping) return;
        stopping = true;
        log(`${signal} を受けたので終了します`);
        void listener
            .close()
            .catch(e => log(`[!] 終了処理で例外: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    log("起動完了。Ctrl-C か SIGTERM で終了します");
    return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
