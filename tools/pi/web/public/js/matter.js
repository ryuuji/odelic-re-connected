/**
 * Matter の登録画面。
 *
 * - 未 commissioning: QR と手入力コードを出す
 * - commissioning 済み: fabric 一覧と ⭐ **追加フェアリング**（Apple Home / Alexa を足す）
 * - ⚠️⚠️ フェアリングの破棄は取り返しがつかない。二段確認にする
 *
 * ⭐ QR はブリッジが matter.js の `QrCode` で作った**文字ブロック**をそのまま描く。
 *    QR エンコーダのライブラリを足していない（依存を増やさない）。
 */

import { api, card, el, loading, notice, replace, svg, toast } from "./api.js";

/** 受付中のカウントダウン用。⚠️ タブを離れたら必ず止める（app.js が `stop()` を呼ぶ） */
let timer = null;

export function render(container) {
    void draw(container);
}

export function stop() {
    clearInterval(timer);
    timer = null;
}

async function draw(container) {
    // ⚠️ 描き直すたびに前のカウントダウンを止める。止めないとタイマーが増えていく
    clearInterval(timer);
    timer = null;
    replace(container, card(loading("Matter の状態を読み込み中")));
    const { data } = await api("/api/bridge/commissioning");
    if (data.commissioning === null || data.commissioning === undefined) {
        replace(
            container,
            card(
                el("h2", { text: "Matter" }),
                notice(
                    "bad",
                    "Matter ブリッジに繋がっていません",
                    "照明の操作には影響しません。Pi で systemctl status odelic-matter を確認してください。",
                ),
            ),
        );
        return;
    }
    const c = data.commissioning;
    replace(
        container,
        c.commissioned ? commissionedCard(c, container) : pairingCard(c),
        c.commissioned ? multiAdminCard(c, container) : null,
        dangerCard(container),
    );
}

function pairingCard(c) {
    return card(
        el("h2", { text: "Google Home に追加する" }),
        el("ol", {}, [
            el("li", { text: "Google Home アプリ →「デバイスを追加」→「Matter デバイス」" }),
            el("li", { text: "QR を読み取るか、下の手入力コードを入力する" }),
        ]),
        pairingCodes(c),
        notice(
            "warn",
            "テスト VID を使っています",
            "Google Home Developer Console に Matter integration を登録していないと拒否されます。",
        ),
        el("p", {
            class: "muted",
            text: "BLE は使いません。Pi と Google スピーカーが同じ LAN にいて IPv6 / mDNS が通ることが前提です。",
        }),
    );
}

/**
 * ベンダー ID → 名前。
 *
 * ⚠️ **網羅していない。**CSA の一覧は巨大で、家庭のコントローラとして出るのはごく一部。
 * ⭐ **知らない ID に名前を作らない。**16 進をそのまま出す（P4: 推測で名乗らせない）。
 * ⚠️ 名前が分かるときも**16 進を必ず併記する**。取り違えていても元の値は読める。
 *
 * ⚠️ この表は手で書いたもの。実機で確認できているのは `0x6006`（Google）だけ。
 */
const VENDORS = new Map([
    [0x6006, "Google"],
    [0x1349, "Apple"],
    [0x1217, "Amazon"],
    [0x1049, "SmartThings（Samsung）"],
]);

function vendorName(id) {
    // ⭐ 0xFFF1〜0xFFF4 は Matter の仕様がテスト用に予約している範囲
    if (id >= 0xfff1 && id <= 0xfff4) return "テスト用ベンダー";
    return VENDORS.get(id) ?? null;
}

function commissionedCard(c, container) {
    return card(
        el("h2", { text: "登録済み" }),
        el("p", { class: "muted", text: "この Pi は既に Matter のコントローラに登録されています。" }),
        el("div", { class: "scroll-x" }, [
            el("table", {}, [
                el("tr", {}, [
                    el("th", { text: "#" }),
                    el("th", { text: "登録元" }),
                    el("th", { text: "ベンダー ID" }),
                ]),
                ...c.fabrics.map(f => {
                    const name = vendorName(f.vendorId);
                    return el("tr", {}, [
                        el("td", { text: String(f.index) }),
                        el("td", {}, [
                            el("div", { text: name ?? "不明なコントローラ" }),
                            // fabric のラベルはコントローラが付ける。空のことも多い
                            f.label ? el("div", { class: "muted", text: f.label }) : null,
                        ]),
                        el("td", { class: "mono", text: `0x${f.vendorId.toString(16).toUpperCase()}` }),
                    ]);
                }),
            ]),
        ]),
        c.fabrics.length === 0 ? el("p", { class: "muted", text: "fabric がありません。" }) : null,
        el("button", { class: "small ghost", text: "再読み込み", onclick: () => void draw(container) }),
    );
}

/**
 * ⭐ 追加登録（Matter の multi-admin）。Apple Home / Alexa をあとから足せる。
 *
 * ⚠️ 「窓を開ける」は commissioning window の直訳で、画面の言葉としては通じない。
 *    **何が起きるか**（10 分間だけ追加の登録を受け付ける）で書く。
 * ⚠️ 「フェアリング」も使わない（pairing の綴り間違いで、日本語として意味を成さない）。
 */
function multiAdminCard(c, container) {
    return card(
        el("h2", { text: "他のアプリからも操作する" }),
        el("p", {
            class: "muted",
            text: "Apple Home や Alexa からも操作したいときは、ここで追加の登録を受け付けてから、相手のアプリで「Matter デバイスを追加」を実行します。",
        }),
        c.windowOpen ? acceptingBlock(c, container) : startButton(container),
        // ⭐ 受付中だけコードを出す。⚠️ 受け付けていないコードを見せても混乱するだけ
        c.windowOpen ? pairingCodes(c) : null,
    );
}

function startButton(container) {
    return el("button", {
        class: "primary",
        text: "追加の登録を受け付ける",
        onclick: async event => {
            // ⚠️ await のあとでは currentTarget が null になる。先に掴む
            event.currentTarget.disabled = true;
            const { ok, data } = await api("/api/bridge/commissioning/open", {
                method: "POST",
                body: { seconds: 600 },
            });
            // ⭐ サーバの言葉をそのまま出す（「すでに受け付け中」も向こうが判断している）
            toast(data.detail ?? (ok ? "受け付けを開始しました" : "受け付けを開始できませんでした"), ok ? "good" : "bad");
            void draw(container);
        },
    });
}

/**
 * 受付中の表示。残り時間と「終了する」ボタン。
 *
 * ⭐ 残りは**ブラウザ側で数える**。1 秒ごとにサーバを叩く理由がない。
 * ⚠️ ただしペアリングが成立すると受付は**勝手に閉じる**ので、15 秒ごとに実際の状態を取り直す。
 * ⚠️ 残り時間が分からないこともある（ブリッジ再起動後など）。そのときは数えずに「受付中」だけ出す。
 */
function acceptingBlock(c, container) {
    let remain = typeof c.windowRemainingSec === "number" ? c.windowRemainingSec : null;
    const pill = el("span", { class: "pill good", text: remainText(remain) });

    let tick = 0;
    timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        tick++;
        if (remain !== null) {
            remain = Math.max(0, remain - 1);
            pill.textContent = remainText(remain);
            if (remain === 0) {
                void draw(container);
                return;
            }
        }
        if (tick % 15 === 0) void draw(container);
    }, 1000);

    return el("div", { class: "row wrap" }, [
        pill,
        el("span", { class: "muted grow", text: "相手のアプリから追加してください。" }),
        el("button", {
            class: "small danger",
            text: "受付を終了する",
            onclick: async event => {
                event.currentTarget.disabled = true;
                const { ok, data } = await api("/api/bridge/commissioning/close", { method: "POST" });
                toast(data.detail ?? (ok ? "終了しました" : "終了できませんでした"), ok ? "good" : "bad");
                void draw(container);
            },
        }),
    ]);
}

function remainText(remain) {
    if (remain === null) return "受付中";
    const m = Math.floor(remain / 60);
    return `受付中 あと ${m}:${String(remain % 60).padStart(2, "0")}`;
}

/**
 * QR と手入力コード。
 *
 * ⭐ 追加登録は **Basic Commissioning Window** なので、最初に使ったのと同じ
 * passcode / discriminator が効く。だから登録済みでも元のコードがそのまま使える。
 */
function pairingCodes(c) {
    const text = c.qrText ?? null;
    // ⚠️ 解釈に失敗したら文字ブロックのまま出す（読めないよりまし）
    const code = text === null ? null : (qrSvg(text) ?? el("pre", { class: "qr", text }));
    return el("div", { class: "pairing" }, [
        code,
        el("p", { class: "pairing-code" }, [
            el("span", { class: "muted", text: "手入力コード " }),
            el("strong", { class: "mono", text: c.manualPairingCode ?? "—" }),
        ]),
    ]);
}

/**
 * matter.js の文字ブロック QR を**モジュールの並びに戻して SVG で描く**。
 *
 * ## ⚠️⚠️ そのまま `<pre>` に流すと読めない
 *
 * 1. **極性が逆。**`QrCode.get()` は半角ブロック（`▀▄█`）で描くが、
 *    ⭐ **塗られている = 明るいモジュール**（端末で白文字・黒地に出す前提）。
 *    白地に黒文字で出すと**白黒が反転した QR** になり、多くのアプリが読み取れない。
 * 2. **行間に隙間が出る。**ブロック文字が行ボックスを埋めきるかはフォント任せで、
 *    実機では横縞が入っていた。
 *
 * → ⭐ **文字を解釈してモジュールの表に戻し、自分で描く。**
 *    QR エンコーダは足していない（依存は増やさない）。
 *
 * ⚠️ matter.js の出力形式に依存する。読めない形なら `null` を返して
 *    呼び出し側が文字ブロックにフォールバックする。
 */
function qrSvg(text) {
    const lines = text.split("\n").filter(line => line.length > 0);
    // 先頭行と最終行は上下の余白、各行の左右 1 文字も余白
    if (lines.length < 3) return null;

    const rows = [];
    for (const line of lines.slice(1, -1)) {
        const cells = [...line].slice(1, -1);
        const top = [];
        const bottom = [];
        for (const ch of cells) {
            // ⭐ 塗られている = 明るい。QR の「黒」は塗られていないほう
            const upperLit = ch === "▀" || ch === "█";
            const lowerLit = ch === "▄" || ch === "█";
            top.push(upperLit ? 0 : 1);
            bottom.push(lowerLit ? 0 : 1);
        }
        rows.push(top, bottom);
    }

    const n = rows[0]?.length ?? 0;
    // ⚠️ 1 行で 2 段ぶん作るので下に 1 段余る。正方形に切る
    if (n === 0 || rows.length < n) return null;
    const matrix = rows.slice(0, n);

    const quiet = 4; // QR の仕様。⚠️ 余白が無いと読み取り率が落ちる
    const size = n + quiet * 2;
    const root = svg("svg", {
        viewBox: `0 0 ${size} ${size}`,
        class: "qr-svg",
        role: "img",
        "aria-label": "Matter の QR コード",
    });
    root.append(svg("rect", { x: 0, y: 0, width: size, height: size, fill: "#ffffff" }));
    // ⭐ 矩形を 1 本の path にまとめる。<rect> を 400 個並べると Pi のブラウザで重い
    let d = "";
    matrix.forEach((row, y) => {
        row.forEach((dark, x) => {
            if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        });
    });
    root.append(svg("path", { d, fill: "#000000", "shape-rendering": "crispEdges" }));
    return root;
}

/** ⚠️⚠️ 取り返しがつかない操作。 */
function dangerCard(container) {
    return card(
        el("h2", { text: "Matter の登録を破棄する" }),
        notice(
            "bad",
            "取り返しがつきません",
            "登録情報をすべて消して未登録の状態に戻します。Google Home / Apple Home 側でもデバイスを削除する必要があり、部屋割り・名前・自動化はすべて失われます。",
        ),
        el("button", {
            class: "danger",
            text: "登録を破棄する",
            onclick: async () => {
                if (!confirm("本当に破棄しますか？ Google Home の設定がすべて失われます。")) return;
                // ⭐ 二段確認。合言葉を打たせる（サーバ側でも同じ語を要求している）
                const typed = prompt('確認のため「破棄する」と入力してください:');
                if (typed === null) return;
                const { ok, data } = await api("/api/bridge/factory-reset", {
                    method: "POST",
                    body: { confirm: typed.trim() },
                });
                toast(data.detail ?? (ok ? "破棄しました" : "できませんでした"), ok ? "good" : "bad");
                if (ok) void draw(container);
            },
        }),
    );
}
