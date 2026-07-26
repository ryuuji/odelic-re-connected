/**
 * ルーティング。⭐ フレームワークは使わない（docs/08 W8）。
 *
 * ## ⚠️ 認証の外に置くもの
 *
 * `/ca.crt` **だけ**は認証なしで配る。ここを認証の内側にすると
 * 「信頼するには CA が要る／CA を取るにはログインが要る／ログインするには
 * 警告を踏む」という循環になる（docs/09 H4）。
 *
 * ログイン画面と静的アセット（CSS / JS）も認証の外。**秘密を含まない**ので問題ない。
 * ⚠️ 逆に `/api/*` は `/api/login` と `/api/session` 以外すべて認証必須。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Auth } from "./auth.js";
import { SESSION_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from "./auth.js";
import type { BridgeClient, BridgeSettings } from "./bridge.js";
import type { WebConfig } from "./config.js";
import {
    bodyBool,
    bodyNumber,
    bodyString,
    checkRequestOrigin,
    clientIp,
    queryInt,
    readJsonBody,
    readRawBody,
    redirect,
    sendJson,
    sendStatic,
    sendText,
    sleep,
} from "./httputil.js";
import type { Journal } from "./journal.js";
import { serviceStatus } from "./journal.js";
import type { OdelicClient, OdelicResponse, OdelicTarget } from "./odelicd.js";
import { describeOutcome, parseTarget } from "./odelicd.js";
import type { SetId } from "./setid.js";
import { ID_PATTERN } from "./setid.js";
import { type UiFixture, buildState, commandForRung } from "./state.js";
import type { ApiScope } from "./apiscope.js";
import { isScope } from "./apiscope.js";
import type { Backup } from "./backup.js";
import { MAX_BACKUP_BYTES } from "./backup.js";

/**
 * ⭐ ソースと解説の置き場。設定ページのバージョン欄からリンクする。
 *
 * ⚠️ ここだけに書く。画面（`public/js/*.js`）に URL を直書きすると、
 * 公開先が変わったときに直し漏れる（`.service` の `Documentation=` と同じ轍）。
 */
export const REPOSITORY_URL = "https://github.com/ryuuji/odelic-re-connected";

export interface RouteDeps {
    config: WebConfig;
    auth: Auth;
    odelicd: OdelicClient;
    bridge: BridgeClient;
    journal: Journal;
    setId: SetId;
    /** ⚠️ 特権操作: `odelicd` の API の公開範囲（`set-api.sh`） */
    apiScope: ApiScope;
    /** ⚠️ 特権操作: 状態のバックアップと復元（`backup-helper.py`） */
    backup: Backup;
    /** 静的ファイルの置き場（`public/`） */
    publicDir: string;
    /** `/ca.crt` で配る CA 証明書 */
    caPath: string;
    version: string;
    log: (msg: string) => void;
    /** テスト用に総当たり遅延を潰す */
    delay?: (ms: number) => Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function createHandler(deps: RouteDeps): Handler {
    const delay = deps.delay ?? sleep;

    return async (req, res) => {
        try {
            await route(req, res, deps, delay);
        } catch (e) {
            deps.log(`[!] リクエスト処理で例外: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
            if (!res.headersSent) sendJson(res, 500, { ok: false, detail: "内部エラー" });
            else res.end();
        }
    };
}

async function route(
    req: IncomingMessage,
    res: ServerResponse,
    deps: RouteDeps,
    delay: (ms: number) => Promise<void>,
): Promise<void> {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ------------------------------------------------------ 認証の外（ここだけ）

    // ⭐ CA は認証なしで配る。これが無いと端末に信頼させられない
    if (method === "GET" && path === "/ca.crt") {
        const ok = await sendStatic(res, dirOf(deps.caPath), baseOf(deps.caPath));
        if (!ok) sendText(res, 404, "CA 証明書がまだ生成されていません（gencert.sh を実行してください）");
        return;
    }

    if (method === "GET" && (path === "/login" || path === "/login.html")) {
        await servePublic(res, deps, "login.html");
        return;
    }
    if (method === "GET" && (path.startsWith("/css/") || path.startsWith("/js/") || path === "/favicon.svg")) {
        if (!(await sendStatic(res, deps.publicDir, path))) sendText(res, 404, "not found");
        return;
    }

    // 認証状態の問い合わせ（ログイン画面が使う）
    if (method === "GET" && path === "/api/session") {
        const session = deps.auth.validate(readCookie(req.headers.cookie, SESSION_COOKIE));
        sendJson(res, 200, {
            authenticated: session !== null,
            configured: deps.auth.configured,
        });
        return;
    }

    if (method === "POST" && path === "/api/login") {
        await handleLogin(req, res, deps, delay);
        return;
    }

    // ------------------------------------------------------------ ここから認証必須

    const session = deps.auth.validate(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (session === null) {
        // ⚠️ 画面はログインへ、API は 401。API がリダイレクトを返すと
        //    fetch が HTML を JSON として読もうとして原因が分からなくなる
        if (path.startsWith("/api/")) {
            sendJson(res, 401, { ok: false, detail: "ログインしてください" });
        } else {
            redirect(res, "/login");
        }
        return;
    }

    // ⚠️ 変更系は CSRF の確認を通す
    if (method !== "GET" && method !== "HEAD") {
        const bad = checkRequestOrigin(req);
        if (bad !== null) {
            deps.log(`[!] 不審なリクエストを拒否: ${method} ${path} — ${bad}`);
            sendJson(res, 403, { ok: false, detail: `リクエストを拒否しました: ${bad}` });
            return;
        }
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
        await servePublic(res, deps, "index.html");
        return;
    }

    if (method === "POST" && path === "/api/logout") {
        deps.auth.destroySession(session.token);
        sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedSessionCookie() });
        return;
    }

    if (method === "POST" && path === "/api/password") {
        await handlePasswordChange(req, res, deps);
        return;
    }

    // ------------------------------------------------------------------ 照明

    if (method === "GET" && path === "/api/state") {
        sendJson(res, 200, await collectState(deps));
        return;
    }

    if (method === "POST" && path === "/api/lights/power") {
        const body = await readJsonBody(req);
        const target = parseTarget(bodyString(body, "target"));
        const on = bodyBool(body, "on");
        if (target === null || on === undefined) {
            sendJson(res, 400, { ok: false, detail: "target と on を指定してください" });
            return;
        }
        await sendCommand(res, deps, await deps.odelicd.command(on ? "/on" : "/off", { target }));
        return;
    }

    if (method === "POST" && path === "/api/lights/rung") {
        await handleRung(req, res, deps);
        return;
    }

    if (method === "POST" && path === "/api/lights/color") {
        await handleColor(req, res, deps);
        return;
    }

    if (method === "POST" && path === "/api/lights/refresh") {
        // ⚠️ BLE を 1 通使う（壁スイッチでの変更を拾う唯一の手段）
        await sendCommand(res, deps, await deps.odelicd.command("/status", {}, 0));
        return;
    }

    // ------------------------------------------------------------------ 状態

    if (method === "GET" && path === "/api/metrics") {
        const [info, metrics] = await Promise.all([deps.odelicd.info(), deps.odelicd.metrics()]);
        sendJson(res, 200, { odelicdReachable: info !== null, info, metrics });
        return;
    }

    if (method === "GET" && path === "/api/health") {
        const services = await serviceStatus(deps.config.logUnits);
        const info = await deps.odelicd.info(2000);
        const bridge = await deps.bridge.state();
        sendJson(res, 200, {
            version: deps.version,
            // ⭐ 3 つの成果物のバージョンをまとめて返す（設定ページのバージョン欄）。
            // ⚠️ 届かないものは `null`。それらしい値を作らない（P4）
            versions: {
                web: deps.version,
                odelicd: typeof info?.version === "string" ? info.version : null,
                bridge: bridge.data?.version ?? null,
            },
            repository: REPOSITORY_URL,
            services,
            odelicdReachable: info !== null,
            bridgeReachable: bridge.reachable,
            sessions: deps.auth.sessionCount,
            throttledIps: deps.auth.throttledCount,
        });
        return;
    }

    // -------------------------------------------------------------- ブリッジ

    if (path.startsWith("/api/bridge/")) {
        await routeBridge(req, res, deps, method, path, url);
        return;
    }

    // ------------------------------------------------------------- HOMEID

    if (method === "GET" && path === "/api/homeid") {
        const [status, info] = await Promise.all([deps.setId.status(), deps.odelicd.info(2000)]);
        sendJson(res, 200, {
            ...status,
            // ⭐ 誤った ID なら joined が立たない（docs/02 C23-1）
            joined: info?.joined ?? false,
            odelicdReachable: info !== null,
        });
        return;
    }

    if (method === "POST" && path === "/api/homeid") {
        const body = await readJsonBody(req);
        const id = bodyString(body, "id") ?? "";
        if (!ID_PATTERN.test(id)) {
            sendJson(res, 400, { ok: false, detail: "ID は 8 桁の数字です（公式アプリのメニューに出ている番号）" });
            return;
        }
        const result = await deps.setId.set(id);
        if (!result.ok) {
            sendJson(res, 500, { ok: false, detail: `変更できませんでした: ${result.detail}` });
            return;
        }
        deps.log("ホーム ID を変更しました（odelicd を再起動しました）");
        sendJson(res, 200, {
            ok: true,
            // ⚠️ ここでは「保存できた」しか言えない。正しい ID かは joined で分かる
            detail: "保存しました。器具に参加できるか確認しています",
        });
        return;
    }

    if (method === "POST" && path === "/api/homeid/rollback") {
        const result = await deps.setId.rollback();
        sendJson(res, result.ok ? 200 : 500, {
            ok: result.ok,
            detail: result.ok ? "直前の ID に戻しました" : `戻せませんでした: ${result.detail}`,
        });
        return;
    }

    // ------------------------------------------------- API の公開範囲（W12）

    if (method === "GET" && path === "/api/apiscope") {
        const status = await deps.apiScope.status();
        // ⚠️ 取れなかったら null を返す。**`local` と嘘をつかない**
        //    （実は LAN に出ているのに閉じて見えるのが最悪）
        sendJson(res, 200, { ok: status !== null, status });
        return;
    }

    if (method === "POST" && path === "/api/apiscope") {
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (e) {
            sendJson(res, 400, { ok: false, detail: e instanceof Error ? e.message : String(e) });
            return;
        }
        const scope = body.scope;
        if (!isScope(scope)) {
            sendJson(res, 400, { ok: false, detail: "scope は local か lan です" });
            return;
        }
        const result = await deps.apiScope.set(scope);
        if (!result.ok) {
            sendJson(res, 500, { ok: false, detail: `変更できませんでした: ${result.detail}` });
            return;
        }
        deps.log(
            scope === "lan"
                ? "⚠️ odelicd の API を LAN に公開しました（認証はありません）"
                : "odelicd の API を localhost 限定にしました",
        );
        sendJson(res, 200, {
            ok: true,
            detail:
                scope === "lan"
                    ? "LAN に公開しました。⚠️ この API に認証はありません"
                    : "localhost 限定にしました",
            // ⚠️ 再起動したので器具が繋ぎ直すまで数秒かかる
            restarted: true,
        });
        return;
    }

    // ------------------------------------------------ バックアップと復元（W13）

    if (method === "GET" && path === "/api/backup") {
        const info = await deps.backup.info();
        sendJson(res, 200, { ok: info.ok, detail: info.detail, info: info.data });
        return;
    }

    if (method === "POST" && path === "/api/backup/export") {
        const result = await deps.backup.export();
        if (!result.ok || result.data === null) {
            sendJson(res, 500, { ok: false, detail: `作成できませんでした: ${result.detail}` });
            return;
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
        deps.log(`バックアップを配信しました（${result.data.length} バイト）`);
        // ⚠️⚠️ 中身は秘密情報の塊。**キャッシュさせない**
        res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": result.data.length,
            "Content-Disposition": `attachment; filename="odelic-backup-${stamp}.zip"`,
            "Cache-Control": "no-store",
        });
        res.end(result.data);
        return;
    }

    if (method === "POST" && path === "/api/backup/restore") {
        let zip: Buffer;
        try {
            zip = await readRawBody(req, MAX_BACKUP_BYTES);
        } catch (e) {
            sendJson(res, 413, { ok: false, detail: e instanceof Error ? e.message : String(e) });
            return;
        }
        const result = await deps.backup.restore(zip);
        if (!result.ok) {
            // ⚠️ ヘルパの理由をそのまま返す（「復元できません」だけでは直せない）
            sendJson(res, 400, { ok: false, detail: result.detail });
            return;
        }
        deps.log(`バックアップから復元しました（${result.data?.restored ?? "?"} ファイル）`);
        sendJson(res, 200, {
            ok: true,
            restored: result.data?.restored ?? null,
            detail: "復元してサービスを再起動しました",
        });
        return;
    }

    // ------------------------------------------------------------------ ログ

    if (method === "GET" && path === "/api/logs") {
        const unitsRaw = url.searchParams.get("units");
        const units = unitsRaw === null || unitsRaw === "" ? [] : unitsRaw.split(",").map(s => s.trim());
        const lines = queryInt(url, "lines", 200);
        const result = await deps.journal.read(units, lines);
        sendJson(res, result.ok ? 200 : 400, {
            ok: result.ok,
            units: result.units,
            available: deps.config.logUnits,
            lines: result.lines,
            detail: result.detail,
        });
        return;
    }

    sendJson(res, 404, { ok: false, detail: "not found" });
}

// ---------------------------------------------------------------- ハンドラ

async function handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
    deps: RouteDeps,
    delay: (ms: number) => Promise<void>,
): Promise<void> {
    // ⚠️ ログインは CSRF の確認をしない（ログイン前はセッションが無いので
    //    CSRF で得られるものが無い）。代わりに総当たり対策を必ず通す
    const ip = clientIp(req);
    const penalty = deps.auth.penaltyMs(ip);
    if (penalty > 0) await delay(penalty);

    let body: Record<string, unknown>;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        sendJson(res, 400, { ok: false, detail: e instanceof Error ? e.message : "不正なリクエスト" });
        return;
    }
    const password = bodyString(body, "password") ?? "";

    if (!deps.auth.configured) {
        // ⭐ 初期パスワードは install.sh がランダム生成して journald に出している。
        //    ここでブラウザから設定させると「先に到達した人が設定できる」ことになる
        deps.log("[!] パスワードが未設定です。install.sh を実行してください");
        sendJson(res, 503, {
            ok: false,
            detail:
                "パスワードが設定されていません。Pi で " +
                "`sudo journalctl -u odelic-web | grep 初期パスワード` を確認してください",
        });
        return;
    }

    if (!deps.auth.verify(password)) {
        deps.auth.noteFailure(ip);
        deps.log(`[!] ログイン失敗（${ip}）。次回は ${deps.auth.penaltyMs(ip)} ms 待たせます`);
        sendJson(res, 401, { ok: false, detail: "パスワードが違います" });
        return;
    }

    deps.auth.noteSuccess(ip);
    const session = deps.auth.createSession(ip);
    deps.log(`ログインしました（${ip}）`);
    sendJson(
        res,
        200,
        { ok: true },
        { "Set-Cookie": sessionCookie(session.token, deps.config.sessionMaxAgeSec) },
    );
}

async function handlePasswordChange(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
    const body = await readJsonBody(req);
    const current = bodyString(body, "current") ?? "";
    const next = bodyString(body, "next") ?? "";
    // ⚠️ 現在のパスワードを必ず確かめる。セッションが盗まれてもパスワードは変えられない
    if (!deps.auth.verify(current)) {
        sendJson(res, 403, { ok: false, detail: "現在のパスワードが違います" });
        return;
    }
    try {
        deps.auth.setPassword(next);
    } catch (e) {
        sendJson(res, 400, { ok: false, detail: e instanceof Error ? e.message : "変更できません" });
        return;
    }
    // ⭐ 変えたら全セッションを切る（漏れていた場合に備えて）
    deps.auth.destroyAllSessions();
    deps.log("パスワードを変更しました。全セッションを無効化しました");
    sendJson(res, 200, { ok: true, detail: "変更しました。もう一度ログインしてください" }, {
        "Set-Cookie": clearedSessionCookie(),
    });
}

async function handleRung(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
    const body = await readJsonBody(req);
    const target = parseTarget(bodyString(body, "target"));
    const rung = bodyNumber(body, "rung");
    if (target === null || rung === undefined) {
        sendJson(res, 400, { ok: false, detail: "target と rung を指定してください" });
        return;
    }

    const state = await collectState(deps);
    const scope = scopeOf(state.fixtures, target);
    if (scope.fixtures.length === 0 && target !== "all") {
        sendJson(res, 404, { ok: false, detail: "その器具が見つかりません" });
        return;
    }

    const cmd = commandForRung(scope.nightLight, rung);
    if (cmd === null) {
        sendJson(res, 400, { ok: false, detail: `段 ${rung} は存在しません` });
        return;
    }

    if (cmd.kind === "off") {
        await sendCommand(res, deps, await deps.odelicd.command("/off", { target }));
        return;
    }
    if (cmd.kind === "night") {
        await sendCommand(res, deps, await deps.odelicd.command("/night", { target, level: cmd.level }));
        return;
    }
    // ⚠️⚠️ 明るさと色温度は**必ず一緒に送る**。プロトコルが 1 コマンドで両方運ぶので
    //     （0xC0 sub 0・docs C18-4 / 07 M5）、片方だけ送るともう片方が上書きされる
    const color = quantizeColor(bodyNumber(body, "color") ?? scope.color);
    await sendCommand(res, deps, await deps.odelicd.command("/level", { target, bright: cmd.bright, color }));
}

async function handleColor(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
    const body = await readJsonBody(req);
    const target = parseTarget(bodyString(body, "target"));
    const colorRaw = bodyNumber(body, "color");
    if (target === null || colorRaw === undefined) {
        sendJson(res, 400, { ok: false, detail: "target と color を指定してください" });
        return;
    }
    const state = await collectState(deps);
    const scope = scopeOf(state.fixtures, target);
    const bright = bodyNumber(body, "bright") ?? scope.bright;
    if (bright === null) {
        // ⚠️ 消えている器具に色温度だけ送ると点灯してしまう。UI 側でも無効化しているが、
        //    ここでも断る（P4: 意図しない点灯を「成功」と言わない）
        sendJson(res, 409, { ok: false, detail: "消灯中は色温度を変えられません（先に点けてください）" });
        return;
    }
    await sendCommand(
        res,
        deps,
        await deps.odelicd.command("/level", { target, bright: quantizeBright(bright), color: quantizeColor(colorRaw) }),
    );
}

async function routeBridge(
    req: IncomingMessage,
    res: ServerResponse,
    deps: RouteDeps,
    method: string,
    path: string,
    _url: URL,
): Promise<void> {
    if (method === "GET" && path === "/api/bridge/state") {
        const r = await deps.bridge.state();
        sendJson(res, 200, { reachable: r.reachable, ok: r.ok, detail: r.detail, state: r.data });
        return;
    }
    if (method === "GET" && path === "/api/bridge/settings") {
        const r = await deps.bridge.settings();
        sendJson(res, 200, { reachable: r.reachable, ok: r.ok, detail: r.detail, settings: r.data });
        return;
    }
    if (method === "POST" && path === "/api/bridge/settings") {
        const body = await readJsonBody(req);
        const patch: Partial<BridgeSettings> = {};
        for (const key of [
            "nightBandPercent",
            "colorTempMinKelvin",
            "colorTempMaxKelvin",
            "statusRefreshSec",
            "waitMs",
            "debounceMs",
        ] as const) {
            const v = bodyNumber(body, key);
            if (v !== undefined) patch[key] = v;
        }
        for (const key of ["colorTempInverted", "coalesceAll"] as const) {
            const v = bodyBool(body, key);
            if (v !== undefined) patch[key] = v;
        }
        const r = await deps.bridge.updateSettings(patch);
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), {
            ok: r.ok,
            detail: r.detail,
            needsRestart: r.data?.needsRestart ?? [],
        });
        return;
    }
    if (method === "GET" && path === "/api/bridge/commissioning") {
        const r = await deps.bridge.commissioning();
        sendJson(res, 200, { reachable: r.reachable, ok: r.ok, detail: r.detail, commissioning: r.data });
        return;
    }
    if (method === "POST" && path === "/api/bridge/commissioning/open") {
        const body = await readJsonBody(req);
        const seconds = Math.max(60, Math.min(900, bodyNumber(body, "seconds") ?? 600));
        const r = await deps.bridge.openCommissioning(seconds);
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), {
            ok: r.ok,
            detail: r.detail,
            commissioning: r.data,
        });
        return;
    }
    if (method === "POST" && path === "/api/bridge/commissioning/close") {
        const r = await deps.bridge.closeCommissioning();
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), {
            ok: r.ok,
            detail: r.detail,
            commissioning: r.data,
        });
        return;
    }
    if (method === "POST" && path === "/api/bridge/fixtures/name") {
        const body = await readJsonBody(req);
        const mac = bodyString(body, "mac") ?? "";
        const name = (bodyString(body, "name") ?? "").trim();
        if (mac === "" || name === "") {
            sendJson(res, 400, { ok: false, detail: "mac と name を指定してください" });
            return;
        }
        if (name.length > 64) {
            sendJson(res, 400, { ok: false, detail: "名前は 64 文字までにしてください" });
            return;
        }
        const r = await deps.bridge.renameFixture(mac, name);
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), {
            ok: r.ok,
            detail: r.detail,
            // ⚠️ Matter ハブ側の表示名は追随しないことがある（docs/07 M6 で Google Home が
            //    登録時の名前を握っていた）。UI は常設の注意書きとしてこれを出している
            note: "Matter ハブ（Google Home など）上の名前は連動しない場合があります",
        });
        return;
    }
    if (method === "POST" && path === "/api/bridge/fixtures/remove") {
        const body = await readJsonBody(req);
        const mac = bodyString(body, "mac") ?? "";
        const confirm = bodyString(body, "confirm") ?? "";
        // ⚠️⚠️ 破壊的。endpoint.delete() は uniqueId ごと消すので、
        //     Google Home からは別デバイスになり部屋割り・自動化が失われる
        if (confirm !== mac) {
            sendJson(res, 400, { ok: false, detail: "確認のため MAC アドレスを入力してください" });
            return;
        }
        const r = await deps.bridge.removeFixture(mac);
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), { ok: r.ok, detail: r.detail });
        return;
    }
    if (method === "POST" && path === "/api/bridge/restart") {
        // ⚠️⚠️ commissioning 直後の再起動は Nest ハブが器具を失う。
        //     拒否の判断はブリッジ側（時刻を知っているのは向こう）
        const r = await deps.bridge.restart();
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), { ok: r.ok, detail: r.detail });
        return;
    }
    if (method === "POST" && path === "/api/bridge/factory-reset") {
        const body = await readJsonBody(req);
        const confirm = bodyString(body, "confirm") ?? "";
        const r = await deps.bridge.factoryReset(confirm);
        sendJson(res, r.ok ? 200 : bridgeStatus(r.reachable, r.status), { ok: r.ok, detail: r.detail });
        return;
    }
    sendJson(res, 404, { ok: false, detail: "not found" });
}

// ------------------------------------------------------------------ 補助

/** ブリッジに届かないことと、ブリッジが拒否したことを区別する。 */
function bridgeStatus(reachable: boolean, status: number): number {
    if (!reachable) return 502;
    return status >= 400 ? status : 500;
}

async function collectState(deps: RouteDeps) {
    // ⚠️ ブリッジが落ちていても照明は操作できる。3 つを並行に引いて、
    //    取れなかったものは無いものとして進む
    const [info, metrics, bridge] = await Promise.all([
        deps.odelicd.info(),
        deps.odelicd.metrics(),
        deps.bridge.state(),
    ]);
    return buildState(info, metrics, bridge.data);
}

/**
 * 操作の対象範囲から「常夜灯が使えるか」と「既定の色温度・明るさ」を決める。
 *
 * ⚠️ `all` のときは**全器具が常夜灯対応のときだけ**常夜灯の段を許す。
 * 1 台でも非対応なら `/night` を投げてはいけない。
 */
function scopeOf(
    fixtures: UiFixture[],
    target: OdelicTarget,
): { fixtures: UiFixture[]; nightLight: boolean; color: number; bright: number | null } {
    let scoped: UiFixture[];
    if (target === "all") scoped = fixtures;
    else if (target.startsWith("dev:")) {
        const key = target.slice(4).toUpperCase();
        scoped = fixtures.filter(f => f.key.toUpperCase() === key);
    } else {
        const g = Number(target.slice("group:".length));
        scoped = fixtures.filter(f => f.groupId === g);
    }
    const nightLight = scoped.length > 0 && scoped.every(f => f.capability.nightLight);
    // 色温度は「今わかっている値」を引き継ぐ。分からなければ中央（50 = 中間色）
    const color = scoped.find(f => f.color !== null)?.color ?? 50;
    const bright = scoped.find(f => f.bright !== null && f.on === true)?.bright ?? null;
    return { fixtures: scoped, nightLight, color, bright };
}

/** ⚠️ 器具は 5 の倍数しか受け付けない（docs C15-9）。 */
function quantizeColor(v: number): number {
    return Math.min(100, Math.max(0, Math.round(v / 5) * 5));
}

function quantizeBright(v: number): number {
    return Math.min(100, Math.max(5, Math.round(v / 5) * 5));
}

/**
 * odelicd の応答を UI に返す。
 *
 * ⭐ 「送った」と「効いた」を混ぜない（docs/03 P4）。
 * odelicd の HTTP ステータスをそのまま意味として運ぶ。
 */
async function sendCommand(res: ServerResponse, deps: RouteDeps, out: OdelicResponse): Promise<void> {
    const detail = describeOutcome(out);
    if (!out.ok) deps.log(`[!] ${detail}`);
    // 成功でも失敗でも最新の状態を返す。UI は必ずこれで描き直す
    const state = out.info !== null
        ? buildState(out.info, await deps.odelicd.metrics(), (await deps.bridge.state()).data)
        : await collectState(deps);
    sendJson(res, out.ok ? 200 : out.status === 0 ? 502 : out.status, { ok: out.ok, detail, state });
}

async function servePublic(res: ServerResponse, deps: RouteDeps, file: string): Promise<void> {
    if (!(await sendStatic(res, deps.publicDir, file))) {
        sendText(res, 500, `${file} が見つかりません（public/ が配置されていません）`);
    }
}

function dirOf(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "." : p.slice(0, i);
}

function baseOf(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? p : p.slice(i + 1);
}
