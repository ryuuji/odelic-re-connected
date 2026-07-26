/**
 * サーバとのやり取りと、画面部品の共通部分。
 *
 * ⚠️ CSP が `script-src 'self'` なので**インラインの onclick は使えない**。
 * すべて `addEventListener` で付ける。
 */

/**
 * API を叩く。
 *
 * ⚠️ 変更系には `X-Odelic-Request` を必ず付ける（サーバが CSRF 対策で要求する）。
 * ⚠️ 401 が返ったらログイン画面へ送る（セッション切れ）。
 */
export async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
        method,
        headers: {
            "X-Odelic-Request": "1",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) {
        location.href = "/login";
        throw new Error("ログインしてください");
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return { status: res.status, ok: res.ok, data: data ?? {} };
}

/**
 * 画面下に短く出す通知。⭐ 失敗はここに正直に出す（黙って握り潰さない）。
 *
 * ⚠️ `hidden` を付け直してから外す。連続で出したときにアニメーションが走らないと
 *    「同じものが出たまま」に見えて、押せたのか分からない。
 */
export function toast(message, kind = "") {
    const node = document.getElementById("toast");
    if (node === null) return;
    node.textContent = message;
    node.className = kind;
    node.hidden = true;
    void node.offsetWidth; // ⚠️ ここで reflow させないと 2 回目のアニメーションが走らない
    node.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(
        () => {
            node.hidden = true;
        },
        kind === "bad" ? 6000 : 3000,
    );
}

/** 要素を作る小さなヘルパ（`innerHTML` を使わないため）。 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "style") for (const [p, pv] of Object.entries(v)) node.style.setProperty(p, pv);
        else if (typeof v === "boolean") node[k] = v;
        else node.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
}

/**
 * SVG の要素を作る。
 *
 * ⚠️ `document.createElement("svg")` では**動かない**（名前空間が違うので
 * HTML の未知要素になり、何も描かれない）。`createElementNS` が要る。
 */
export function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        node.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        node.append(c);
    }
    return node;
}

/** 中身を差し替える。 */
export function replace(container, ...nodes) {
    container.replaceChildren(...nodes.filter(Boolean));
}

export function card(...children) {
    return el("div", { class: "card" }, children);
}

/**
 * 注意書き。
 *
 * ⚠️ **画面の日本語に `⚠️` / `⭐` を混ぜない。**コードコメントの流儀を UI に持ち込むと、
 * どれが本当に危ないのか区別が付かなくなる。強さは色と左罫で示し、
 * ⭐ **見出し（何が起きるか）と本文（なぜか）を分ける**。
 *
 * @param kind `""` / `"warn"` / `"bad"` / `"good"`
 * @param title 見出し。`null` なら本文だけ
 */
export function notice(kind, title, body) {
    return el("p", { class: kind === "" ? "notice" : `notice ${kind}` }, [
        title === null || title === undefined ? null : el("strong", { text: title }),
        body === null || body === undefined ? null : document.createTextNode(body),
    ]);
}

/** 読み込み中。⭐ 派手にしない（すぐ差し替わるので）。 */
export function loading(text = "読み込み中") {
    return el("p", { class: "loading", text });
}

/** 秒数を人が読める形に。 */
export function humanDuration(sec) {
    if (sec === null || sec === undefined) return "—";
    const s = Math.round(sec);
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    const h = Math.floor(s / 3600);
    return `${h} 時間 ${Math.floor((s % 3600) / 60)} 分`;
}

/** unix 秒 → 「◯ 秒前」。 */
export function ago(unixSec) {
    if (!unixSec) return "—";
    const diff = Date.now() / 1000 - unixSec;
    if (diff < 0) return "たった今";
    return `${humanDuration(diff)}前`;
}

export function num(v, digits = 0) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

/**
 * 連続した呼び出しをまとめる。
 *
 * ⚠️⚠️ **明るさスライダーの中間値を連射しないために要る。**
 * 公式アプリは約 143 ms 間隔で 16 通も送っていた（docs C28）。
 */
export function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
