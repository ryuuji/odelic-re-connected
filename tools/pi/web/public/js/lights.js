/**
 * 照明の操作画面（既定のタブ）。
 *
 * ## ⭐ 明るさは 1 本のスライダー
 *
 * 器具は連続値を持たない。**常夜灯 3 段 + 主灯 20 段**しかなく、両者は排他なので
 * 物理的な明るさは 1 本の軸になる（docs/07 M3）。段の一覧と現在位置は
 * サーバが `@odelic/common` の `ladder()` で計算して渡してくる。
 *
 * ```
 * 消灯 | 常夜灯（暗・中・明） | 主灯 5% 10% … 100%
 *   0  |   1    2    3        |  4  …            23
 * ```
 *
 * ⭐⭐ **その軸をスライダーの帯にそのまま描く。**⚠️ グラデーションにはしない。
 * 段の数だけべた塗りを並べる（`bandedTrack()`）。なめらかに塗ると、
 * **器具に無い中間値があるように見える**（P4: 実際より細かく見せない）。
 * 段の定義はサーバから来た `rungs` を数えるだけで、ここには持たない。
 *
 * ## ⚠️⚠️ 中間値を連射しない
 *
 * 純正アプリは明るさスライダーで**約 143 ms 間隔で 16 通**送っていた（docs C28）。
 * ここでは `input` ではラベルだけ更新し、**送信は `change`（指を離したとき）**にする。
 *
 * ## ⚠️ 分からないものは分からないと出す（P4）
 *
 * 通電が切れている器具（`absent`）は状態を信用できないので、
 * 段を表示せず操作も無効にする。
 */

import { ago, api, card, debounce, el, loading, notice, replace, svg, toast } from "./api.js";

/** 直近の状態。⚠️ 操作中は再描画で入力を奪わないように使う */
let current = null;
/** ユーザーがスライダーを掴んでいる間は再描画しない */
let interacting = false;
let refreshTimer = null;

export function render(container) {
    if (current === null) replace(container, card(loading("照明の状態を読み込み中")));
    void refresh(container);
    // ⭐ 5 秒ごとに追従する。⚠️ GET /info は BLE を使わないので器具に負荷はかからない
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (!interacting && document.visibilityState === "visible") void refresh(container);
    }, 5000);
}

export function stop() {
    clearInterval(refreshTimer);
    refreshTimer = null;
}

async function refresh(container) {
    const { ok, data } = await api("/api/state");
    if (!ok) {
        replace(container, card(notice("bad", "状態を取得できませんでした", "しばらくしてから開き直してください。")));
        return;
    }
    current = data;
    draw(container);
}

function draw(container) {
    const state = current;
    updateConnPill(state);

    const nodes = [];
    if (state.unavailableReason !== null && state.unavailableReason !== undefined) {
        nodes.push(notice("warn", "照明を操作できません", state.unavailableReason));
    }
    if (!state.bridge.reachable) {
        // ⭐ ブリッジが落ちていても照明は操作できる。そう明記する
        nodes.push(
            notice(
                "",
                "器具の名前を既定名で表示しています",
                "Matter ブリッジに繋がっていないためです。照明の操作には影響しません。",
            ),
        );
    }

    if (state.fixtures.length > 1) nodes.push(allCard(state, container));
    for (const f of state.fixtures) nodes.push(fixtureCard(f, state, container));

    if (state.fixtures.length === 0) {
        nodes.push(card(el("p", { class: "muted", text: "操作できる器具がありません。" })));
    }

    nodes.push(syncBar(state, container));
    replace(container, ...nodes);
}

function updateConnPill(state) {
    const pill = document.getElementById("conn");
    if (pill === null) return;
    if (!state.odelicdReachable) {
        pill.textContent = "操作不可";
        pill.className = "pill bad";
    } else if (!state.connected) {
        pill.textContent = "接続待ち";
        pill.className = "pill warn";
    } else {
        pill.textContent = `${state.fixtures.length} 台 接続中`;
        pill.className = "pill good";
    }
}

/**
 * 一番下の行。左に「いつの状態か」、右に同期ボタン。
 *
 * ## ⭐ 更新時刻は 1 か所にまとめる
 *
 * 器具ごとのカードに出すと、同じような相対時刻が何行も並んで名前より目立つ。
 * ⚠️ **いちばん古いものを出す。**平均や最新だと「1 台だけ遅れている」を隠してしまう。
 *
 * ⚠️ 応答していない器具は数に入れない。入れると常に巨大な値になり、
 * 生きている器具の鮮度が読めなくなる（その器具のカードには別途警告を出している）。
 *
 * ## ⭐ ボタンはアイコンだけ
 *
 * 普段は自動で追従しているので、押すのは壁スイッチで変えた直後くらい。
 * ⚠️ アイコンだけにするなら `aria-label` と `title` を必ず付ける
 *    （読み上げと、意味が分からなかったときの逃げ道）。
 * ⭐ 押している間は回す。**押せたことが分かる手段がないと、もう一度押される。**
 */
function syncBar(state, container) {
    const times = state.fixtures.filter(f => f.online && f.stateUpdatedAt).map(f => f.stateUpdatedAt);
    const oldest = times.length === 0 ? null : Math.min(...times);
    const label = "最新のステータスを同期";
    const button = el("button", {
        class: "icon-button",
        "aria-label": label,
        title: label,
        onclick: async event => {
            // ⚠️ currentTarget は await のあと null になる。先に掴んでおく
            const node = event.currentTarget;
            node.disabled = true;
            node.classList.add("busy");
            const { data } = await api("/api/lights/refresh", { method: "POST" });
            toast(data.detail ?? "問い合わせました");
            setTimeout(() => void refresh(container), 1200);
        },
    });
    button.append(
        // 円を一周する矢印（Feather の rotate-cw と同じ形）
        svg("svg", {
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "aria-hidden": "true",
            focusable: "false",
        }, [
            svg("polyline", { points: "23 4 23 10 17 10" }),
            svg("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }),
        ]),
    );
    return el("div", { class: "tab-foot" }, [
        el("span", { class: "muted grow", text: oldest === null ? "" : `状態の更新: ${ago(oldest)}` }),
        button,
    ]);
}

/** 「すべて」カード。⭐ `target=all` の 1 通で送るので BLE を無駄にしない。 */
function allCard(state, container) {
    const usable = state.fixtures.some(f => f.online);
    const live = state.fixtures.filter(f => f.online);
    // 全部点いている / 全部消えている のときだけ状態を断定する（P4: 混在で嘘をつかない）
    const allOn = live.length > 0 && live.every(f => f.rungIndex !== null);
    const allOff = live.length > 0 && live.every(f => f.rungIndex === null);
    const { value, mixed } = allSliderValue(state);
    const cct = allColorValue(state);

    const node = card(
        el("div", { class: "row between" }, [
            el("span", { class: "name grow", text: `すべての照明（${state.fixtures.length} 台）` }),
            usable
                ? powerToggle("all", container, {
                      // 全部点いている / 全部消えている のときだけ断定する（P4）
                      on: allOn ? true : allOff ? false : null,
                      label: "すべての照明の電源",
                  })
                : el("span", { class: "pill warn", text: "操作できません" }),
        ]),
        el("div", { class: "controls" }, [
            // ⚠️ 段の添字は「つまみの位置 − 1」。0（消灯）は「段が無い」なので null
            dimmerRow("all", state.allRungs, value === 0 ? null : value - 1, usable, container, null, {
                mixed,
            }),
            // ⚠️ 調色できる器具が 1 台も無ければ出さない。⚠️ 点いている器具が無いときは操作させない
            //    （消灯中に色温度だけ送ると点灯してしまう）
            cct === null
                ? null
                : colorRow("all", cct.value, cct.usable, container, { mixed: cct.mixed }),
        ]),
    );
    node.classList.add("all-card");
    return node;
}

/**
 * 「すべて」カードの色温度。
 *
 * ⚠️ 調色に対応する器具が 1 台も無ければ `null`（つまみ自体を出さない）。
 * ⚠️ **点いている器具が 1 台も無ければ操作させない。**消灯中に色温度だけ送ると
 *    点灯してしまう（サーバも 409 で断る）。
 * ⭐ 値は平均。ばらついていればそう出す（P4: 揃っているように見せない）。
 */
function allColorValue(state) {
    const tunable = state.fixtures.filter(f => f.capability.kind === "colorTemperature");
    if (tunable.length === 0) return null;
    const live = tunable.filter(f => f.online && f.on === true);
    const known = live.filter(f => f.color !== null && f.color !== undefined).map(f => f.color);
    if (known.length === 0) return { value: 50, mixed: false, usable: live.length > 0 };
    const mixed = known.some(v => v !== known[0]);
    // ⚠️ 器具は 5 の倍数しか受け付けない。平均もその刻みに丸めておく
    const avg = Math.round(known.reduce((a, b) => a + b, 0) / known.length / 5) * 5;
    return { value: avg, mixed, usable: live.length > 0 };
}

/**
 * 「すべて」カードのつまみの位置。
 *
 * ⚠️ **前はここが常に 0 だった**ので、動かして送るたびにつまみが左端へ飛び戻っていた。
 * ⭐ 各器具の位置を「すべて」の軸に写して平均する。
 *
 * ⚠️ 器具ごとに段の構成が違うことがある（常夜灯の有無）。**添字をそのまま使わない。**
 *    段の中身（`bright` / `level`）で対応付ける。
 * ⚠️ 値がばらついているときは平均を出すが、**そう書く**（P4: 揃っているように見せない）。
 */
function allSliderValue(state) {
    const live = state.fixtures.filter(f => f.online);
    if (live.length === 0) return { value: 0, mixed: false };
    const values = live.map(f => positionOnAllAxis(f, state.allRungs));
    // 写せない器具が 1 台でもあれば位置を作らない（それらしい値をでっち上げない）
    if (values.some(v => v === null)) return { value: 0, mixed: true };
    const mixed = values.some(v => v !== values[0]);
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return { value: avg, mixed };
}

/** 器具の現在の段を「すべて」の軸の位置（0 = 消灯）に写す。写せなければ `null`。 */
function positionOnAllAxis(f, allRungs) {
    if (f.rungIndex === null) return 0;
    const rung = f.rungs[f.rungIndex];
    if (rung === undefined) return null;
    const i = allRungs.findIndex(r =>
        r.kind !== rung.kind
            ? false
            : rung.kind === "main"
              ? r.bright === rung.bright
              : r.level === rung.level,
    );
    if (i >= 0) return i + 1;
    // ⚠️ 1 台でも常夜灯に対応しない器具が混ざると allRungs に常夜灯の段が無い。
    //    常夜灯の器具は「いちばん暗い段」に寄せる（軸の下端という意味は合っている）
    return rung.kind === "night" ? 1 : null;
}

/**
 * 器具 1 台のカード。
 *
 * ⭐ **3 つの塊に分ける。**混ざっていると何がどれの情報か分からない。
 *
 * | 塊 | 中身 |
 * | --- | --- |
 * | 見出し | ランプ・名前・今の状態 |
 * | 操作（`.controls`） | オン/オフ・明るさ・色温度。⭐ **各つまみの「上」に名前と値** |
 *
 * ⚠️ **MAC と製品コードはここに出さない。**操作したい人には要らない情報で、
 * 出すと名前より目立ってしまう。必要なときは「状態」タブと「設定」タブにある。
 *
 * ⚠️ **「いつの状態か」もここに出さない。**カードごとに同じような相対時刻が並ぶと
 * 名前より目立つ。⭐ タブの一番下に**いちばん古いもの 1 つ**だけ出す（`syncBar`）。
 * ただし**応答していない器具の警告はカードに残す**（その 1 台の話なので）。
 */
function fixtureCard(f, state, container) {
    const target = `dev:${f.key}`;
    const lit = f.online && f.rungIndex !== null;

    const node = card(
        el("div", { class: "row between" }, [
            el("span", { class: "name grow", text: f.name }),
            f.online
                ? powerToggle(target, container, { on: f.rungIndex !== null, label: `${f.name}の電源` })
                : statusPill(f),
        ]),
        el("div", { class: "controls" }, [
            dimmerRow(target, f.rungs, f.rungIndex, f.online, container, f),
            f.capability.kind === "colorTemperature"
                ? colorRow(target, f.color ?? 50, f.online && f.on === true, container)
                : null,
        ]),
        // ⚠️ 応答していないことは「その 1 台の話」なのでカードに残す
        f.online
            ? null
            : el("div", {
                  class: "card-foot muted",
                  text: "この照明器具は応答していません。表示している状態は当てになりません。",
              }),
    );
    node.classList.add("fixture");
    if (lit) node.classList.add("is-on");
    if (!f.online) node.classList.add("is-offline");
    return node;
}

/**
 * 状態が分からないときのピル。
 *
 * ⭐ 分かっているときは**トグルが状態を兼ねる**ので、これは出さない。
 * ⚠️ 分からないのにトグルを出してはいけない。オフの位置に見えて嘘になる（P4）。
 */
function statusPill(f) {
    return f.absent
        ? el("span", { class: "pill bad", text: "応答なし" })
        : el("span", { class: "pill warn", text: "不明" });
}

/**
 * 電源トグル。⭐ **状態表示と操作を 1 つにまとめてある。**
 *
 * 「点灯」ピルと「オン / オフ」ボタンを別々に置くと、同じことを 2 か所で言うことになり、
 * 見出しの行も操作の行も混み合う。トグルなら位置がそのまま状態になる。
 *
 * ⚠️ **状態が分からないときは呼ばない。**オフの位置に置くと嘘になる（P4）。
 *    呼び出し側で `statusPill()` に切り替えること。
 *
 * @param opts.on `true` 点灯 / `false` 消灯 / `null` ばらついている（「すべて」カード）
 */
function powerToggle(target, container, opts) {
    const mixed = opts.on === null;
    const button = el("button", {
        class: mixed ? "toggle is-mixed" : "toggle",
        role: "switch",
        // ⭐ ばらついているときは「全部オンではない」ので false が正しい。押すと全部オンになる
        "aria-checked": opts.on === true ? "true" : "false",
        "aria-label": mixed ? `${opts.label}（いまはばらついています）` : opts.label,
        title: mixed ? "ばらついています。押すとすべてオンになります" : undefined,
        onclick: event =>
            send(event, container, "/api/lights/power", { target, on: opts.on !== true }),
    });
    button.append(el("span", { class: "toggle-track" }, [el("span", { class: "toggle-knob" })]));
    return button;
}

// ------------------------------------------------------------------ 帯

/**
 * 位置ごとの**べた塗り**を並べた帯を作る。
 *
 * ## ⭐ なぜグラデーションをやめたのか
 *
 * 器具は連続値を持たない。**常夜灯 3 段 + 主灯 20 段しかない**（docs C15-9 / C24）。
 * なめらかに塗ると、無い中間値があるように見える。段の数だけべた塗りを並べれば、
 * ⭐ **軸の目盛りがそのまま見える**（P4: 実際より細かく見せない）。
 *
 * ## ⚠️ つまみの端の寄り
 *
 * つまみの中心は左右の端で `thumb/2` ぶん内側に入る。帯の境目も同じだけ寄せないと、
 * **端の段でつまみが自分の帯からずれる**。`calc()` で厳密に合わせる。
 * ⚠️ つまみの大きさは CSS が持っている（`--thumb-size`）。ここに数値を書き写さない。
 *
 * @param colors 位置 0〜N の色（`colors[i]` が段 `i` の色）
 */
function bandedTrack(colors) {
    const last = colors.length - 1;
    if (last <= 0) return colors[0] ?? "transparent";
    const at = f =>
        `calc(var(--thumb-size) / 2 + ${f.toFixed(5)} * (100% - var(--thumb-size)))`;
    const stops = [];
    colors.forEach((c, i) => {
        stops.push(`${c} ${i === 0 ? "0" : at((i - 0.5) / last)}`);
        stops.push(`${c} ${i === last ? "100%" : at((i + 0.5) / last)}`);
    });
    return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * 光の色の見本。⭐ 「見かけの明るさ 0〜1」から色を引く。
 *
 * ⚠️ 器具の % をそのまま明るさに使わない。常夜灯は主灯 5% よりずっと暗いので、
 * 同じ軸に並べると常夜灯 3 段が潰れる。下端を広げて 3 段が見分けられるようにしてある。
 */
const RAMP = [
    [0.0, [24, 18, 11]], // いちばん暗い光
    [0.14, [110, 64, 12]], // 常夜灯の上端
    [0.32, [168, 98, 14]],
    [0.62, [242, 183, 5]],
    [1.0, [255, 246, 219]], // 主灯 100%
];

/**
 * 消灯の色。⭐ **帯から外して固定してある。**
 *
 * 消灯は「いちばん暗い光」ではなく**光っていない**という別の状態なので、
 * 帯の続きの色にすると 1 段目の常夜灯と地続きに見えて落ち着かない。
 *
 * ⚠️ カードの地より**暗く**すること。地より明るいと、暗いテーマで左端に
 * 明るい帯が浮いて見える（一度そうなった）。
 */
const OFF_COLOR = "rgb(13 11 8)";

function rampColor(b) {
    const t = Math.min(1, Math.max(0, b));
    for (let i = 1; i < RAMP.length; i++) {
        const [hi, cHi] = RAMP[i];
        if (t > hi && i < RAMP.length - 1) continue;
        const [lo, cLo] = RAMP[i - 1];
        const k = hi === lo ? 0 : (t - lo) / (hi - lo);
        const mix = cLo.map((v, j) => Math.round(v + (cHi[j] - v) * k));
        return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
    }
    return "rgb(36 26 16)";
}

/** 明るさの帯。位置 0 が消灯、そこから段が 1 つずつ並ぶ。 */
function dimTrack(rungs) {
    const nights = rungs.filter(r => r.kind === "night").length;
    const colors = [OFF_COLOR];
    rungs.forEach((r, i) => {
        if (r.kind === "night") {
            // ⭐ 常夜灯は 3 段しかないので、下端 0.04〜0.14 に均等に置いて見分けを付ける
            const k = nights <= 1 ? 1 : i / (nights - 1);
            colors.push(rampColor(0.04 + 0.1 * k));
        } else {
            // ⚠️ 主灯の下端（5%）は常夜灯の上端よりはっきり明るい。段差が出るようにする
            colors.push(rampColor(0.3 + 0.7 * ((r.bright ?? 5) / 100)));
        }
    });
    return bandedTrack(colors);
}

/** 色温度の帯。⚠️ 器具は 5 刻みしか受け付けないので、こちらも 21 段のべた塗り。 */
function colorTrack() {
    const colors = [];
    for (let p = 0; p <= 100; p += 5) {
        const k = p / 100;
        // 電球色 #ffb45c → 昼光色 #dae7ff
        const mix = [255 + (218 - 255) * k, 180 + (231 - 180) * k, 92 + (255 - 92) * k];
        colors.push(`rgb(${Math.round(mix[0])} ${Math.round(mix[1])} ${Math.round(mix[2])})`);
    }
    return bandedTrack(colors);
}

/**
 * つまみ 1 本ぶんの塊。⭐ **見出し（名前と今の値）を上、つまみを下**にする。
 *
 * ⚠️ 下に置くと、その値が**次のつまみの見出し**に見えてしまう
 *    （明るさの下に出した値が「色温度」の直上に来る）。
 */
function control(labelText, valueNode, slider, track) {
    return el("div", { class: "control" }, [
        el("div", { class: "control-head" }, [el("span", { text: labelText }), valueNode]),
        // ⚠️ 溝は自前の要素で描く（UA の疑似要素に塗らせない・CSS の `.slider-track` 参照）。
        //    `--track` は包みに置く。中の `.slider-track` へ継承される
        // ⚠️ `:has()` に頼らず印を付ける（古い端末でも確実に効かせるため）
        el(
            "div",
            {
                class: slider.disabled ? "slider-wrap is-disabled" : "slider-wrap",
                style: { "--track": track },
            },
            [el("span", { class: "slider-track", "aria-hidden": "true" }), slider],
        ),
    ]);
}

/**
 * 明るさスライダー。
 *
 * ⚠️ 値は「段の添字 + 1」。`0` を消灯にすることで、電源とつながった 1 本の軸になる。
 *
 * ⭐ 帯は `dimTrack()` が段ごとのべた塗りで作る（グラデーションにしない）。
 *
 * @param opts.mixed 器具ごとに値がばらついている（「すべて」カードで平均を出したとき）
 */
function dimmerRow(target, rungs, rungIndex, enabled, container, fixture, opts = {}) {
    const max = rungs.length;
    const value = rungIndex === null || rungIndex === undefined ? 0 : rungIndex + 1;

    // ⚠️ 平均を出したことを隠さない（P4: 揃っているように見せない）
    const initial = opts.mixed === true ? `${labelFor(rungs, value)}（ばらつきあり）` : labelFor(rungs, value);
    const label = el("span", { class: "value", text: initial });

    const send200 = debounce((slider, ev) => {
        void sendRung(ev, container, target, Number(slider.value) - 1, fixture);
    }, 200);

    const slider = el("input", {
        type: "range",
        class: "slider",
        min: 0,
        max,
        step: 1,
        value,
        disabled: !enabled,
        "aria-label": "明るさ",
        // ⭐ 動かしている間はラベルだけ。送らない
        //    （掴んだ時点で「ばらつきあり」は消える。これから 1 つの値に揃えるので）
        oninput: event => {
            interacting = true;
            label.textContent = labelFor(rungs, Number(event.currentTarget.value));
        },
        // ⚠️⚠️ 送信は指を離したときだけ（中間値を連射しない・docs C28）
        onchange: event => send200(event.currentTarget, event),
        onpointerdown: () => {
            interacting = true;
        },
    });

    return control("明るさ", label, slider, dimTrack(rungs));
}

/** 段を人が読める形に。⭐ 主灯には「主灯」を付ける（％だけだと何の％か分からない）。 */
function rungText(rung) {
    return rung.kind === "main" ? `主灯 ${rung.label}` : rung.label;
}

function labelFor(rungs, value) {
    if (value <= 0) return "消灯";
    const rung = rungs[value - 1];
    return rung === undefined ? "—" : rungText(rung);
}

/**
 * 色温度スライダー。
 *
 * ⚠️ 消灯中は操作させない。`/level` は色温度だけでも**点灯させてしまう**
 *    （サーバも 409 で断る）。
 *
 * @param opts.mixed 器具ごとに値がばらついている（「すべて」カード）
 */
function colorRow(target, value, enabled, container, opts = {}) {
    const initial = opts.mixed === true ? `${kelvinLabel(value)}（ばらつきあり）` : kelvinLabel(value);
    const label = el("span", { class: "value", text: initial });

    const send200 = debounce(v => {
        void send(null, container, "/api/lights/color", { target, color: v });
    }, 200);

    const slider = el("input", {
        type: "range",
        class: "slider",
        min: 0,
        max: 100,
        step: 5,
        value,
        disabled: !enabled,
        "aria-label": "色温度",
        oninput: event => {
            interacting = true;
            label.textContent = kelvinLabel(Number(event.currentTarget.value));
        },
        onchange: event => send200(Number(event.currentTarget.value)),
        onpointerdown: () => {
            interacting = true;
        },
    });

    // ⚠️ 使えない理由をラベルに足さない。溝が色を失っていること自体が
    //    「いまは選べない」の合図になっている（CSS の `.slider-wrap.is-disabled`）
    return control("色温度", label, slider, colorTrack());
}

/** ⚠️ 実際のケルビン値はブリッジの設定次第。ここでは向きだけ示す。 */
function kelvinLabel(percent) {
    if (percent <= 0) return "電球色";
    if (percent >= 100) return "昼光色";
    if (percent <= 25) return `電球色寄り ${percent}%`;
    if (percent >= 75) return `昼光色寄り ${percent}%`;
    return `中間 ${percent}%`;
}

async function sendRung(event, container, target, rung, fixture) {
    // ⚠️⚠️ 明るさと色温度は必ず一緒に送る（プロトコルが 1 コマンドで両方運ぶ）。
    //     いま画面に出ている色温度を添えないと、器具側で意図しない値に上書きされる
    const body = { target, rung };
    if (fixture !== null && fixture.color !== null && fixture.color !== undefined) {
        body.color = fixture.color;
    }
    await send(event, container, "/api/lights/rung", body);
}

async function send(event, container, path, body) {
    // ⚠️ `currentTarget` は dispatch が終わると null になる。await より前に掴む
    const button = event?.currentTarget;
    if (button !== undefined && button !== null && button.tagName === "BUTTON") button.disabled = true;
    try {
        const { ok, data } = await api(path, { method: "POST", body });
        // ⭐ 応答に最新の状態が入っている。次のポーリングを待たずに描き直す
        if (data.state !== undefined && data.state !== null) current = data.state;
        interacting = false;
        draw(container);
        // ⚠️ 「送った」と「効いた」を混ぜない。サーバの言葉をそのまま出す
        if (!ok) toast(data.detail ?? "失敗しました", "bad");
    } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "bad");
    }
}
