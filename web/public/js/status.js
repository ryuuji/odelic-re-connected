/**
 * 状態画面。`odelicd` の `/info` と `/metrics` をそのまま可視化する。
 *
 * ⭐ グラフのライブラリは入れない（Pi 3 で軽く、依存を増やさない）。
 * 割合は CSS 変数 `--bar` を渡した横棒で足りる。
 *
 * ⭐ **数字の羅列の前に要約を置く。**「今どうなのか」を読み取るのに
 * 6 枚の表を上から読ませない。細かい値はその下に置いておけばよい。
 */

import { api, card, el, humanDuration, loading, notice, num, replace } from "./api.js";

let timer = null;

export function render(container) {
    replace(container, card(loading("状態を読み込み中")));
    void refresh(container);
    clearInterval(timer);
    timer = setInterval(() => {
        if (document.visibilityState === "visible") void refresh(container);
    }, 10_000);
}

export function stop() {
    clearInterval(timer);
    timer = null;
}

async function refresh(container) {
    const [metrics, bridge] = await Promise.all([api("/api/metrics"), api("/api/bridge/state")]);
    if (!metrics.ok) {
        replace(container, card(notice("bad", "状態を取得できませんでした", "しばらくしてから開き直してください。")));
        return;
    }
    const { info, metrics: m, odelicdReachable } = metrics.data;
    if (!odelicdReachable || info === null) {
        replace(
            container,
            card(
                notice(
                    "bad",
                    "照明サーバ（odelicd）に届きません",
                    "照明を操作できません。Pi で systemctl status odelicd を確認してください。",
                ),
            ),
        );
        return;
    }

    replace(
        container,
        summaryCard(info, m, bridge.data),
        linkCard(info),
        deliveryCard(info, m),
        rttCard(m),
        linksCard(m),
        countersCard(info, m),
        bridgeCard(bridge.data),
    );
}

function kv(rows) {
    return el(
        "table",
        {},
        rows
            .filter(Boolean)
            .map(([k, v]) => el("tr", {}, [el("th", { text: k }), el("td", { text: String(v) })])),
    );
}

function stat(label, value) {
    return el("div", {}, [el("dt", { text: label }), el("dd", { text: value })]);
}

/**
 * 先頭の要約。
 *
 * ⭐ ここに出すのは「困っているかどうかが分かる 4 つ」だけ。
 * ⚠️ 分からないものは `—` にする（それらしい数字を作らない・P4）。
 */
function summaryCard(info, m, bridge) {
    const delivery = Object.values(m?.delivery ?? {});
    const absent = delivery.filter(d => d.absent).length;
    const worst = delivery.length === 0 ? null : Math.min(...delivery.map(d => d.ewma ?? 0));
    const rtts = Object.values(m?.rtt_ms ?? {}).filter(s => typeof s.p90 === "number");
    const rttP90 = rtts.length === 0 ? null : Math.max(...rtts.map(s => s.p90));

    const lights = (info.devices ?? []).length;
    return card(
        el("h2", { text: "ステータス" }),
        el("dl", { class: "summary" }, [
            stat("器具", absent === 0 ? `${lights} 台すべて応答` : `${lights} 台中 ${absent} 台が無応答`),
            stat("最悪の到達率", worst === null ? "—" : `${Math.round(worst * 100)}%`),
            stat("応答時間 p90", rttP90 === null ? "—" : `${num(rttP90, 0)} ms`),
            stat("リンク継続", humanDuration(info.link_held_sec)),
        ]),
        absent > 0
            ? notice(
                  "warn",
                  `${absent} 台が応答していません`,
                  "壁スイッチで通電が切れているか、電波が届いていません。この器具の表示状態は当てになりません。",
              )
            : null,
        bridge?.state === null || bridge?.state === undefined
            ? notice("", "Matter ブリッジに繋がっていません", "照明の操作には影響しません。")
            : null,
    );
}

function linkCard(info) {
    return card(
        el("h2", { text: "リンク" }),
        kv([
            ["接続", info.connected ? "つながっている" : "つながっていない"],
            // ⭐ joined は「器具が返した HOMEID が一致した」の意味（C23-1）
            ["メッシュ参加", info.joined ? "参加済み（ID は正しい）" : "未参加"],
            ["主リンク", info.primary_mac ?? "—"],
            ["リンク継続", humanDuration(info.link_held_sec)],
            ["生きているリンク", (info.live_links ?? []).join(" / ") || "—"],
            ["自分の vAddr", info.own_vaddr ?? "—"],
            ["キュー", `${info.queued} 件`],
            ["odelicd の稼働", humanDuration(info.uptime_sec)],
        ]),
    );
}

/** ⭐ `absent` は通電が切れている器具の唯一の判定手段（docs/07 M6-4）。 */
function deliveryCard(info, m) {
    const delivery = m?.delivery ?? {};
    const byKey = new Map((info.devices ?? []).map(d => [d.key, d]));
    const rows = Object.entries(delivery).map(([key, v]) => {
        const d = byKey.get(key);
        const pct = Math.round((v.ewma ?? 0) * 100);
        return el("tr", {}, [
            el("td", { class: "mono", text: d?.mac ?? key }),
            el("td", {}, [
                el("div", { class: "bar", style: { "--bar": `${pct}%` } }, [el("i", {})]),
                el("span", { class: "muted", text: `${pct}%（${v.n} 回）` }),
            ]),
            el(
                "td",
                {},
                v.absent
                    ? el("span", { class: "pill bad", text: "応答なし" })
                    : el("span", { class: "pill good", text: "応答あり" }),
            ),
        ]);
    });
    return card(
        el("h2", { text: "到達率" }),
        el("p", { class: "muted", text: "状態要求に応答が返った割合（直近が効く指数移動平均）。" }),
        rows.length === 0
            ? el("p", { class: "muted", text: "まだ計測がありません。" })
            : el("div", { class: "scroll-x" }, [
                  el("table", {}, [
                      el("tr", {}, [
                          el("th", { text: "器具" }),
                          el("th", { text: "到達率" }),
                          el("th", { text: "通電" }),
                      ]),
                      ...rows,
                  ]),
              ]),
    );
}

function rttCard(m) {
    const rtt = m?.rtt_ms ?? {};
    const rows = Object.entries(rtt).map(([key, s]) =>
        el("tr", {}, [
            el("td", { class: "mono", text: key }),
            el("td", { text: num(s.p50, 1) }),
            el("td", { text: num(s.p90, 1) }),
            el("td", { text: num(s.p99, 1) }),
            el("td", { text: String(s.n ?? 0) }),
        ]),
    );
    const c = m?.converge_ms;
    return card(
        el("h2", { text: "応答時間" }),
        el("p", { class: "muted", text: "状態要求（0x70）から応答（0x71）までの往復時間（ミリ秒）。" }),
        rows.length === 0
            ? el("p", { class: "muted", text: "まだ計測がありません。" })
            : el("div", { class: "scroll-x" }, [
                  el("table", {}, [
                      el("tr", {}, [
                          el("th", { text: "vAddr" }),
                          el("th", { text: "p50" }),
                          el("th", { text: "p90" }),
                          el("th", { text: "p99" }),
                          el("th", { text: "回数" }),
                      ]),
                      ...rows,
                  ]),
              ]),
        c === undefined || c === null || c.n === 0
            ? null
            : el("p", {
                  class: "muted",
                  text: `収束（送信 → 期待どおりの状態を確認するまで）: p50 ${num(c.p50, 0)} ms / p90 ${num(c.p90, 0)} ms（${c.n} 回）`,
              }),
    );
}

function linksCard(m) {
    const links = m?.links ?? {};
    const rows = Object.entries(links).map(([mac, r]) =>
        el("tr", {}, [
            el("td", { class: "mono", text: mac }),
            el("td", { text: String(r.up ?? r.establish ?? "—") }),
            el("td", { text: String(r.down ?? r.disconnect ?? "—") }),
            el("td", { text: humanDuration(r.held_sec) }),
            el("td", { text: r.last_reason ?? r.reason ?? "—" }),
        ]),
    );
    return card(
        el("h2", { text: "リンクの履歴" }),
        rows.length === 0
            ? el("p", { class: "muted", text: "まだ記録がありません。" })
            : el("div", { class: "scroll-x" }, [
                  el("table", {}, [
                      el("tr", {}, [
                          el("th", { text: "器具" }),
                          el("th", { text: "確立" }),
                          el("th", { text: "切断" }),
                          el("th", { text: "継続" }),
                          el("th", { text: "直近の理由" }),
                      ]),
                      ...rows,
                  ]),
              ]),
    );
}

function countersCard(info, m) {
    const crypto = info.crypto ?? {};
    const tuning = info.tuning ?? {};
    return card(
        el("h2", { text: "内部の数値" }),
        el("div", { class: "scroll-x" }, [
            kv([
                ["送信回数", String(m?.send?.total ?? m?.send?.pdu ?? "—")],
                ["受信回数", String(m?.recv?.total ?? m?.recv?.pdu ?? "—")],
                ["復号 成功 / 失敗", `${crypto.decrypted ?? "—"} / ${crypto.decrypt_failed ?? "—"}`],
                // ⚠️ 分割 PDU の欠落は純正アプリの不安定さの核心だった（docs C30）
                ["分割 組立 / 欠落", `${crypto.segments_assembled ?? "—"} / ${crypto.segments_dropped ?? "—"}`],
                ["確認待ち", `${num(tuning.confirm_delay_ms, 0)} ms（実測 RTT p90 × 2）`],
                ["RTT p90", `${num(tuning.rtt_p90_ms, 1)} ms`],
                ["最悪の到達率", num(tuning.worst_delivery, 3)],
                ["1 操作あたりの送信回数", String(tuning.resend ?? "—")],
            ]),
        ]),
    );
}

function bridgeCard(bridge) {
    if (bridge === null || bridge === undefined || bridge.state === null || bridge.state === undefined) {
        return card(
            el("h2", { text: "Matter ブリッジ" }),
            notice("", "ブリッジに繋がっていません", "照明の操作には影響しません。"),
        );
    }
    const s = bridge.state;
    return card(
        el("h2", { text: "Matter ブリッジ" }),
        kv([
            ["バージョン", s.version],
            ["稼働", humanDuration(s.uptimeSec)],
            ["エンドポイント", `${s.fixtures.length} 個`],
            ["commissioning", s.commissioning.commissioned ? "済み" : "未"],
            [
                "fabric",
                s.commissioning.fabrics.length === 0
                    ? "—"
                    : s.commissioning.fabrics.map(f => f.label || `#${f.index}`).join(" / "),
            ],
        ]),
        el("div", { class: "scroll-x" }, [
            el("table", {}, [
                el("tr", {}, [
                    el("th", { text: "器具" }),
                    el("th", { text: "種別" }),
                    el("th", { text: "常夜灯" }),
                    el("th", { text: "状態" }),
                ]),
                ...s.fixtures.map(f =>
                    el("tr", {}, [
                        el("td", {}, [
                            el("div", { text: f.name }),
                            el("div", { class: "muted mono", text: f.mac }),
                        ]),
                        el("td", { text: f.deviceType === "colorTemperature" ? "調光調色" : "調光のみ" }),
                        el("td", { text: f.nightLight ? "あり" : "なし" }),
                        el(
                            "td",
                            {},
                            f.inRosterOnly
                                ? el("span", { class: "pill warn", text: "名簿のみ" })
                                : f.reachable
                                  ? el("span", { class: "pill good", text: "見えている" })
                                  : el("span", { class: "pill", text: "不明" }),
                        ),
                    ]),
                ),
            ]),
        ]),
    );
}
