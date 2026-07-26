/**
 * 画面の切り替え。⭐ ルータもフレームワークも使わない（タブが 5 つあるだけ）。
 */

import { toast } from "./api.js";
import * as lights from "./lights.js";
import * as logs from "./logs.js";
import * as matter from "./matter.js";
import * as settings from "./settings.js";
import * as status from "./status.js";

const VIEWS = { lights, status, settings, matter, logs };
const DEFAULT_TAB = "lights";

let currentTab = null;

function show(tab) {
    if (!(tab in VIEWS)) tab = DEFAULT_TAB;
    if (tab === currentTab) return;

    // ⚠️ 前の画面のタイマーを必ず止める。止めないとタブを行き来するたびに
    //    ポーリングが増えていく（Pi 3 に無駄な負荷をかける）
    if (currentTab !== null) VIEWS[currentTab].stop?.();

    for (const [name] of Object.entries(VIEWS)) {
        document.getElementById(`tab-${name}`).hidden = name !== tab;
    }
    for (const button of document.querySelectorAll("#tabs button")) {
        if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    }

    currentTab = tab;
    VIEWS[tab].render(document.getElementById(`tab-${tab}`));
}

for (const button of document.querySelectorAll("#tabs button")) {
    button.addEventListener("click", () => {
        location.hash = button.dataset.tab;
    });
}

window.addEventListener("hashchange", () => show(location.hash.slice(1)));

// ⚠️ タブを離れている間はポーリングを止める（スマホの電池と Pi の負荷のため）
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentTab !== null) {
        VIEWS[currentTab].render(document.getElementById(`tab-${currentTab}`));
    }
});

window.addEventListener("unhandledrejection", event => {
    // ⚠️ 握り潰さない。何が起きたか分からないのが一番困る
    toast(String(event.reason?.message ?? event.reason), "bad");
});

show(location.hash.slice(1) || DEFAULT_TAB);
