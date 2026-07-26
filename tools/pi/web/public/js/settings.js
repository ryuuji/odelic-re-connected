/**
 * 設定画面。器具名 / ブリッジの設定 / ホーム ID / パスワード。
 *
 * ⚠️ **器具名の変更は Google Home 側の名前を上書きしない**（docs/07 M6）。画面に必ず出す。
 * ⚠️ **ホーム ID の変更は `odelicd` を再起動する。**間違えると器具に参加できなくなるので、
 *    保存後に `joined` を監視して、駄目なら巻き戻せるようにする（docs/02 C23-1）。
 *
 * ## ⚠️⚠️ `event.currentTarget` を await のあとで触らない
 *
 * DOM のイベントは dispatch が終わると `currentTarget` を `null` に戻す。
 * `await` を挟んだあとに `event.currentTarget.disabled = false` と書くと
 * **必ず TypeError になる**。処理は成功しているのに赤いトーストだけ出る、という
 * 一番たちの悪い壊れ方をする（実際に器具名の変更で踏んだ）。
 *
 * → ⭐ **await より前にローカル変数へ掴んでおく。**
 */

import { api, card, el, loading, notice, replace, toast } from "./api.js";

let joinWatchTimer = null;

export function render(container) {
    void draw(container);
}

export function stop() {
    clearInterval(joinWatchTimer);
    joinWatchTimer = null;
}

async function draw(container) {
    replace(container, card(loading("設定を読み込み中")));
    const [state, settings, homeid] = await Promise.all([
        api("/api/bridge/state"),
        api("/api/bridge/settings"),
        api("/api/homeid"),
    ]);
    replace(
        container,
        fixtureNamesCard(state.data, container),
        bridgeSettingsCard(settings.data, container),
        homeidCard(homeid.data, container),
        passwordCard(),
        logoutCard(),
    );
}

// ---------------------------------------------------------------- 器具名

function fixtureNamesCard(bridgeState, container) {
    if (bridgeState?.state === null || bridgeState?.state === undefined) {
        return card(
            el("h2", { text: "照明器具の名前" }),
            notice(
                "bad",
                "名前を変更できません",
                "Matter ブリッジに繋がっていません。照明の操作はできます。",
            ),
        );
    }
    const fixtures = bridgeState.state.fixtures;
    return card(
        el("h2", { text: "照明器具の名前" }),
        // ⚠️ ここは「変わらない」と断定できない（ハブの実装による）。docs/07 M6 では
        //    Google Home が登録時の名前を握っていたが、ハブが違えば追随することもある
        notice(
            "",
            "Matter ハブ上の名前は連動しない場合があります",
            "Google Home などの表示名は、それぞれのアプリで変えてください。",
        ),
        ...fixtures.map(f => nameRow(f, container)),
        fixtures.length === 0 ? el("p", { class: "muted", text: "照明器具がまだありません。" }) : null,
    );
}

/**
 * 1 台分の行。
 *
 * ⭐ 入力欄とボタンを**同じ行**に置き、ボタンは右に寄せる。
 * ⚠️ 狭い画面では折り返すが、`margin-left: auto` を付けてあるので
 *    折り返した先でも右揃えのまま（左に落ちて入力欄と紛れない）。
 */
function nameRow(f, container) {
    const input = el("input", {
        type: "text",
        class: "grow",
        value: f.name,
        maxlength: 64,
        "aria-label": `${f.mac} の名前`,
    });
    return el("div", { class: "card" }, [
        el("div", { class: "muted mono", text: `${f.mac} / ${f.product}` }),
        el("div", { class: "row wrap name-row" }, [
            input,
            el("div", { class: "row actions" }, [
                el("button", {
                    class: "small primary",
                    text: "名前を変える",
                    onclick: async event => {
                        // ⚠️ await のあとでは currentTarget が null になる。先に掴む
                        const button = event.currentTarget;
                        button.disabled = true;
                        const { ok, data } = await api("/api/bridge/fixtures/name", {
                            method: "POST",
                            body: { mac: f.mac, name: input.value },
                        });
                        toast(data.detail ?? (ok ? "変更しました" : "失敗しました"), ok ? "good" : "bad");
                        button.disabled = false;
                    },
                }),
                el("button", {
                    class: "small danger",
                    text: "登録を削除",
                    onclick: () => void removeFixture(f, container),
                }),
            ]),
        ]),
    ]);
}

/**
 * ⚠️⚠️ 破壊的。**何が起きるかを具体的に書く**（「外す」だけでは伝わらない）。
 *
 * 1. 名簿（`fixtures.json`）からこの MAC の項目が消える → 付けた表示名も消える
 * 2. Matter のエンドポイントを `delete()` する → ⚠️ **`uniqueId` が失われる**
 * 3. Google Home からは**別のデバイス**になり、部屋割り・名前・自動化が失われる
 *
 * ⚠️ **器具が生きていれば戻ってくる。**次に `odelicd` が見つけた時点で
 * 新しいデバイスとして登録し直される（同じ器具なのに別物として並ぶ）。
 * つまりこれは「撤去した器具の後始末」であって、リセット手段ではない。
 */
async function removeFixture(f, container) {
    const first = confirm(
        `「${f.name}」の登録を削除します。\n\n` +
            "・Google Home からは別のデバイスになり、部屋割り・名前・自動化が失われます\n" +
            "・器具がまだ生きていれば、次に見つかったときに新しいデバイスとして登録し直されます\n\n" +
            "照明器具を本当に撤去したときだけ実行してください。",
    );
    if (!first) return;
    // ⭐ 二段確認。MAC を打たせる
    const typed = prompt(`確認のため MAC アドレスを入力してください:\n${f.mac}`);
    if (typed === null) return;
    const { ok, data } = await api("/api/bridge/fixtures/remove", {
        method: "POST",
        body: { mac: f.mac, confirm: typed.trim().toUpperCase() },
    });
    toast(data.detail ?? (ok ? "外しました" : "失敗しました"), ok ? "good" : "bad");
    if (ok) void draw(container);
}

// ------------------------------------------------------------ ブリッジ設定

const NUMBER_FIELDS = [
    ["nightBandPercent", "明るさ軸の下端を常夜灯に割り当てる割合（%）", 0, 90],
    ["colorTempMinKelvin", "色温度の下限（K・電球色）", 1000, 10000],
    ["colorTempMaxKelvin", "色温度の上限（K・昼光色）", 1000, 10000],
    ["statusRefreshSec", "定期の状態要求（秒・0 で無効）", 0, 3600],
    ["waitMs", "収束を待つ時間（ms・0 なら送信の成否だけ見る）", 0, 10000],
    ["debounceMs", "明るさと色温度を 1 通にまとめる窓（ms）", 0, 2000],
];

/** 補足が要る項目だけ。⭐ 全部に付けると読まれなくなる */
const FIELD_HINTS = {
    statusRefreshSec: "この設定だけが定期的に BLE を使います。",
};

function bridgeSettingsCard(payload, container) {
    if (payload?.settings === null || payload?.settings === undefined) {
        return card(
            el("h2", { text: "ブリッジの設定" }),
            notice("bad", "設定を読めません", "Matter ブリッジに繋がっていません。"),
        );
    }
    const s = payload.settings;
    const inputs = new Map();
    const fields = NUMBER_FIELDS.map(([key, label, min, max]) => {
        const input = el("input", { type: "number", value: s[key], min, max, step: 1 });
        inputs.set(key, input);
        return el("label", { class: "field" }, [
            el("span", { text: label }),
            input,
            FIELD_HINTS[key] === undefined ? null : el("span", { class: "muted", text: FIELD_HINTS[key] }),
        ]);
    });

    const inverted = el("input", { type: "checkbox", checked: s.colorTempInverted });
    const coalesce = el("input", { type: "checkbox", checked: s.coalesceAll });

    return card(
        el("h2", { text: "ブリッジの設定" }),
        ...fields,
        el("label", { class: "row" }, [inverted, el("span", { text: "色温度の向きを反転する" })]),
        el("label", { class: "row" }, [
            coalesce,
            el("span", { text: "全器具が同じ指示なら 1 通にまとめる（推奨）" }),
        ]),
        el("div", { class: "row" }, [
            el("button", {
                class: "primary",
                text: "保存する",
                onclick: async event => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    const body = { colorTempInverted: inverted.checked, coalesceAll: coalesce.checked };
                    for (const [key, input] of inputs) body[key] = Number(input.value);
                    const { ok, data } = await api("/api/bridge/settings", { method: "POST", body });
                    toast(data.detail ?? (ok ? "保存しました" : "失敗しました"), ok ? "good" : "bad");
                    button.disabled = false;
                    // ⭐ 再起動しないと効かない項目があるならそう出す（黙って効かないのが一番困る）
                    if (ok && (data.needsRestart ?? []).length > 0) void draw(container);
                },
            }),
            el("button", {
                text: "ブリッジを再起動",
                onclick: async event => {
                    const button = event.currentTarget;
                    if (!confirm("Matter ブリッジを再起動します。数秒で戻ります。")) return;
                    button.disabled = true;
                    const { ok, data } = await api("/api/bridge/restart", { method: "POST" });
                    // ⚠️ commissioning 直後は 409 で断られる（Nest ハブが器具を失うため）
                    toast(data.detail ?? (ok ? "再起動します" : "できませんでした"), ok ? "good" : "bad");
                    button.disabled = false;
                },
            }),
        ]),
        notice(
            "",
            "明るさ軸と色温度は再起動後に反映されます",
            "既存のエンドポイントに効かせるにはブリッジの再起動が必要です。",
        ),
    );
}

// -------------------------------------------------------------- ホーム ID

function homeidCard(h, container) {
    const input = el("input", {
        type: "text",
        inputmode: "numeric",
        pattern: "[0-9]{8}",
        maxlength: 8,
        placeholder: h?.id || "12345678",
        "aria-label": "ホーム ID（8 桁の数字）",
    });
    const status = el("p", { class: "muted", text: joinText(h) });

    return card(
        el("h2", { text: "公式アプリのホーム ID（8 桁の数字）" }),
        el("p", {
            class: "muted",
            text: "公式アプリのメニュー画面に「ID:12345678」と表示されている番号です。上位 4 桁が HOMEID、下位 4 桁がメッシュのパスワードになっています。",
        }),
        el("div", { class: "row" }, [
            el("span", { class: "muted", text: "現在の ID" }),
            el("strong", { class: "mono", text: h?.id || "未設定" }),
        ]),
        status,
        el("label", { class: "field" }, [el("span", { text: "新しい ID" }), input]),
        el("div", { class: "row" }, [
            el("button", {
                class: "primary",
                text: "設定する",
                onclick: event => void applyId(event, input, status, container),
            }),
            h?.rollbackAvailable
                ? el("button", {
                      text: "直前の ID に戻す",
                      onclick: event => void rollback(event, status, container),
                  })
                : null,
        ]),
        notice(
            "warn",
            "設定すると odelicd が再起動します",
            "ID が違うと器具に参加できません。そのときは「直前の ID に戻す」で戻せます。",
        ),
    );
}

function joinText(h) {
    if (h === null || h === undefined) return "";
    if (!h.odelicdReachable) return "照明サーバ（odelicd）に届きません。";
    return h.joined
        ? "器具に参加できています（ID が正しいことは器具の応答で確認済みです）"
        : "まだ器具に参加できていません。";
}

async function applyId(event, input, status, container) {
    const button = event.currentTarget;
    const id = input.value.trim();
    if (!/^\d{8}$/.test(id)) {
        toast("ID は 8 桁の数字です", "bad");
        return;
    }
    if (!confirm("ホーム ID を変更し、odelicd を再起動します。よろしいですか？")) return;
    button.disabled = true;
    const { ok, data } = await api("/api/homeid", { method: "POST", body: { id } });
    if (!ok) {
        toast(data.detail ?? "変更できませんでした", "bad");
        button.disabled = false;
        return;
    }
    input.value = "";
    toast("保存しました。器具に参加できるか確認しています…");
    // ⭐ 参加できたかを 60 秒見張る。⚠️ サーバをブロックしない（数十秒かかることがある）
    watchJoin(status, container, button);
}

function watchJoin(status, container, button) {
    clearInterval(joinWatchTimer);
    const deadline = Date.now() + 60_000;
    status.textContent = "確認中…（最大 60 秒）";
    joinWatchTimer = setInterval(async () => {
        const { data } = await api("/api/homeid");
        if (data.joined) {
            clearInterval(joinWatchTimer);
            status.textContent = "器具に参加できました。ID は正しいです";
            toast("器具に参加できました", "good");
            button.disabled = false;
            void draw(container);
            return;
        }
        if (Date.now() > deadline) {
            clearInterval(joinWatchTimer);
            // ⚠️ 断定しない。器具の電源が落ちているだけのこともある
            status.textContent =
                "60 秒たっても参加できませんでした。ID が違う可能性があります（器具の電源が入っているかも確認してください）";
            toast("参加を確認できませんでした。ID を確かめてください", "bad");
            button.disabled = false;
            void draw(container);
        }
    }, 3000);
}

async function rollback(event, status, container) {
    const button = event.currentTarget;
    if (!confirm("直前の ID に戻して odelicd を再起動します。よろしいですか？")) return;
    button.disabled = true;
    const { ok, data } = await api("/api/homeid/rollback", { method: "POST" });
    toast(data.detail ?? (ok ? "戻しました" : "失敗しました"), ok ? "good" : "bad");
    if (ok) watchJoin(status, container, button);
    else button.disabled = false;
}

// ------------------------------------------------------------ パスワード

function passwordCard() {
    const current = el("input", { type: "password", autocomplete: "current-password" });
    const next = el("input", { type: "password", autocomplete: "new-password" });
    const again = el("input", { type: "password", autocomplete: "new-password" });
    return card(
        el("h2", { text: "このページのパスワード" }),
        el("label", { class: "field" }, [el("span", { text: "現在のパスワード" }), current]),
        el("label", { class: "field" }, [el("span", { text: "新しいパスワード（8 文字以上）" }), next]),
        el("label", { class: "field" }, [el("span", { text: "もう一度" }), again]),
        el("button", {
            class: "primary",
            text: "変更する",
            onclick: async event => {
                const button = event.currentTarget;
                if (next.value !== again.value) {
                    toast("新しいパスワードが一致しません", "bad");
                    return;
                }
                button.disabled = true;
                const { ok, data } = await api("/api/password", {
                    method: "POST",
                    body: { current: current.value, next: next.value },
                });
                if (ok) {
                    // ⭐ 変更すると全セッションが切れる（漏れていた場合に備えて）
                    toast("変更しました。もう一度ログインしてください", "good");
                    setTimeout(() => (location.href = "/login"), 1500);
                    return;
                }
                toast(data.detail ?? "変更できませんでした", "bad");
                button.disabled = false;
            },
        }),
        el("p", {
            class: "muted",
            text: "変更するとすべての端末からログアウトされます。",
        }),
    );
}

// -------------------------------------------------------------- ログアウト

/**
 * ⭐ ヘッダーではなくここに置く。
 *
 * スマホの幅では「ロゴ + 名前 + 接続状態 + ログアウト」が並ばず、名前が折り返してしまう。
 * めったに押さないものをいちばん狭い場所に置く理由がない。
 */
function logoutCard() {
    return card(
        el("h2", { text: "ログアウト" }),
        el("p", {
            class: "muted",
            text: "この端末だけログアウトします。ほかの端末はそのままです。",
        }),
        el("button", {
            text: "ログアウトする",
            onclick: async () => {
                await api("/api/logout", { method: "POST" }).catch(() => {});
                location.href = "/login";
            },
        }),
    );
}
