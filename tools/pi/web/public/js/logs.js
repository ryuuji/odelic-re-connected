/**
 * ログ画面。
 *
 * ⚠️⚠️ **秘密のマスクはサーバ側で必ず掛かっている**（`src/mask.ts`）。
 * ここでマスクしてはいけない（クライアント側の処理は当てにならないし、
 * ネットワークに流れた時点で漏れている）。ここは表示するだけ。
 */

import { api, card, el, notice, replace, toast } from "./api.js";

let timer = null;
/** チェックされている unit。空なら全部 */
let selected = new Set();
let lines = 200;
let auto = false;

export function render(container) {
    void draw(container);
}

export function stop() {
    clearInterval(timer);
    timer = null;
}

async function draw(container) {
    const query = new URLSearchParams({ lines: String(lines) });
    if (selected.size > 0) query.set("units", [...selected].join(","));
    const { ok, data } = await api(`/api/logs?${query.toString()}`);

    const output = el("pre", { class: "log", text: ok ? data.lines.join("\n") : (data.detail ?? "読めませんでした") });

    if (!ok) {
        // ⚠️ よくあるのは systemd-journal グループに入っていないケース。理由をそのまま出す
        toast(data.detail ?? "ログを読めませんでした", "bad");
    }

    const unitBoxes = (data.available ?? []).map(unit => {
        const box = el("input", {
            type: "checkbox",
            checked: selected.size === 0 || selected.has(unit),
            onchange: event => {
                if (event.currentTarget.checked) selected.add(unit);
                else selected.delete(unit);
                // 全部チェックなら「絞らない」と同じ
                if (selected.size === (data.available ?? []).length) selected.clear();
                void draw(container);
            },
        });
        return el("label", { class: "row" }, [box, el("span", { class: "mono", text: unit })]);
    });

    const lineSelect = el(
        "select",
        {
            onchange: event => {
                lines = Number(event.currentTarget.value);
                void draw(container);
            },
        },
        [50, 100, 200, 500].map(n =>
            el("option", { value: String(n), selected: n === lines, text: `${n} 行` }),
        ),
    );

    const autoBox = el("input", {
        type: "checkbox",
        checked: auto,
        onchange: event => {
            auto = event.currentTarget.checked;
            clearInterval(timer);
            if (auto) {
                timer = setInterval(() => {
                    if (document.visibilityState === "visible") void draw(container);
                }, 5000);
            }
        },
    });

    replace(
        container,
        card(
            el("h2", { text: "ログ" }),
            notice(
                "",
                "秘密は伏せてから表示しています",
                "メッシュのパスワード・暗号鍵・Matter の登録コードは伏せてあります（行そのものは残しています）。そのまま他人に見せても大丈夫です。",
            ),
            ...unitBoxes,
            el("div", { class: "row wrap" }, [
                lineSelect,
                el("label", { class: "row" }, [autoBox, el("span", { text: "5 秒ごとに更新" })]),
                el("button", { class: "small ghost", text: "更新", onclick: () => void draw(container) }),
            ]),
        ),
        card(output),
    );

    // 最新が見えるように末尾へ
    output.scrollTop = output.scrollHeight;
}
