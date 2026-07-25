/**
 * 器具 1 台 = Matter エンドポイント 1 個。
 *
 * ## 設計の要点
 *
 * - ⭐ **コマンドではなく属性変化に反応する。**`MoveToLevel` / `Move` / `Step` /
 *   `MoveToLevelWithOnOff` を個別に実装せず、`currentLevel$Changed` などを購読すれば
 *   全部同じ経路で拾える。matter.js が遷移の途中値も属性に書くので、
 *   デバウンス（ブリッジ側）で**最終値だけ**が送られる。docs C33-5 の「1 操作 = 1 通」。
 * - ⚠️ **エコー抑止が要る。**器具の状態を属性に書き戻すときも `$Changed` が飛ぶので、
 *   そのまま送信すると無限ループになる。**「器具の状態としてこちらが書いた値」との
 *   値比較**だけで止める（フラグ方式は非同期のタイミングで取りこぼす）。
 * - ⚠️ **`endpoint.state` を後から読まない。**イベントで届いた値を意図の正とする。
 *   詳細は `wanted` / `intentSeq` のコメントと docs/07-matter.md の M9。
 * - ⭐ 未接続・状態未取得は `Reachable = false` で表す。Matter が用意している
 *   「分からない」の表現で、docs/03-instability.md の P4（嘘をつかない）と一致する。
 */

import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControl } from "@matter/main/clusters/color-control";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";

import type { Capability } from "./capability.js";
import { defaultFixtureName, macToEndpointId, normalizeMac } from "./config.js";
import type { OdelicDevice } from "./odelicd.js";
import {
    type ColorScale,
    type LightScale,
    type MatterLightState,
    MATTER_LEVEL_MAX,
    MATTER_LEVEL_MIN,
    colorPercentToMireds,
    deviceStateToMatter,
    matterLevelToTarget,
    miredsToColorPercent,
    physicalMaxMireds,
    physicalMinMireds,
    targetToMatterLevel,
} from "./mapping.js";

/** odelicd に送る 1 操作。 */
export type PendingCommand =
    | { kind: "off" }
    /** ⭐ 器具が記憶していた明るさに戻す（`37 37`）。Matter の On と意味が完全に一致する */
    | { kind: "on" }
    | { kind: "level"; bright: number; color: number }
    | { kind: "night"; level: 0 | 1 | 2 };

export function sameCommand(a: PendingCommand, b: PendingCommand): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "level" && b.kind === "level") return a.bright === b.bright && a.color === b.color;
    if (a.kind === "night" && b.kind === "night") return a.level === b.level;
    return true;
}

export function describeCommand(c: PendingCommand): string {
    switch (c.kind) {
        case "off":
            return "消灯";
        case "on":
            return "点灯（記憶値）";
        case "level":
            return `明るさ ${c.bright}% / 色温度 ${c.color}%`;
        case "night":
            return `常夜灯 レベル ${c.level}`;
    }
}

type TouchedField = "onOff" | "level" | "mireds";

export interface FixtureOptions {
    mac: string;
    name?: string;
    capability: Capability;
    scale: LightScale;
    colorScale: ColorScale;
    product: string;
    version: string;
    /** Matter 側で値が変わったときに呼ぶ。ブリッジがデバウンスして送信する */
    onDesiredChange: (fixture: Fixture) => void;
    log?: (msg: string) => void;
    /**
     * `Reachable` の初期値（既定 true）。
     *
     * ⚠️ 名簿から復元した器具は「まだ odelicd から見えていない」ので false で作る。
     * `server.start()` の**前**にエンドポイントを足す必要があり、その時点では
     * `endpoint.set()` が使えないので、コンストラクタで渡す。
     */
    initialReachable?: boolean;
}

/**
 * matter.js のエンドポイントは デバイスタイプごとに別の型になる。
 * ここだけ `any` で受けて、外には型の付いた操作しか出さない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLightEndpoint = any;

export class Fixture {
    readonly mac: string;
    readonly endpointId: string;
    readonly name: string;
    readonly capability: Capability;
    readonly endpoint: AnyLightEndpoint;

    /** odelicd への宛先。vAddr は変わり得るのでポーリングごとに更新する */
    vaddrKey: string;
    groupId: number | null = null;
    lastSeen = 0;

    private readonly scale: LightScale;
    private readonly colorScale: ColorScale;
    private readonly onDesiredChange: (fixture: Fixture) => void;
    private readonly logFn: (msg: string) => void;

    /**
     * ⭐ エコー抑止の基準値。「器具の状態はこうだ」と Matter に伝えた値。
     *
     * `$Changed` の値がこれと同じなら、それは自分の書き戻しか、
     * すでに器具がその状態になっているかのどちらかで、**どちらでも送る必要がない**。
     *
     * ⚠️ 「書き戻し中フラグ」方式にしてはいけない。書き戻しの `await` 中に本物の
     * コントローラ操作が来ると取りこぼす（統合テストで実際に踏んだ）。
     * 値の比較なら非同期のタイミングに依存しない。
     */
    private applied: { onOff: boolean | null; level: number | null; mireds: number | null } = {
        onOff: null,
        level: null,
        mireds: null,
    };
    /** このバッチで Matter 側から触られたフィールド（まだ送っていない） */
    private touched = new Set<TouchedField>();
    /**
     * 送信中のフィールド。
     *
     * ⚠️ `touched` と合わせて「器具の状態で上書きしてはいけないフィールド」になる。
     * これが無いと、**ポーリングの書き戻しが送信前のユーザー指示を消してしまう**
     * （Google Home で 80% にした直後にポーリングが古い 30% へ引き戻し、
     * デバウンス満了時にその 30% が送られる）。統合テストで実際に踏んだ。
     */
    private inFlight = new Set<TouchedField>();
    /** 色温度の望み値（%）。`/level` は明るさと色温度を必ず一緒に送るため常に持つ */
    private colorPercent = 50;
    private reachable: boolean;
    /**
     * ⭐ Matter 側の「望み」。**`$Changed` で届いた値をそのまま持つ。**
     *
     * ⚠️ `endpoint.state` を後から読んではいけない。ポーリングの書き戻し
     * （`endpoint.set()`）が飛行中にコントローラの書き込みが来ると、後着の書き戻しが
     * それを上書きして、**古い値をコマンドとして送ってしまう**（統合テストで実際に踏んだ）。
     * イベントで届いた値こそがユーザーの意図なので、それを正とする。
     */
    private wanted: { onOff: boolean; level: number; mireds: number | null };
    /**
     * Matter 側の意図が更新された回数。
     *
     * ⚠️ 書き戻しの計算を始めてから `endpoint.set()` するまでの間にユーザー操作が
     * 入ったら、その書き戻しは**捨てる**。捨てないと、古い器具状態が遅れて着弾し、
     * さらにそれが「新しいユーザー操作」として再解釈されて古い値が送信される
     * （Pi 実機の遅さで初めて出た。速いマシンでは再現しなかった）。
     */
    private intentSeq = 0;
    /** 書き戻しを 1 本ずつ直列に流す（ポーリングと送信後の反映が重なるため） */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(opts: FixtureOptions) {
        this.mac = normalizeMac(opts.mac);
        this.endpointId = macToEndpointId(this.mac);
        this.name = opts.name ?? defaultFixtureName(this.mac);
        this.capability = opts.capability;
        this.scale = opts.scale;
        this.colorScale = opts.colorScale;
        this.onDesiredChange = opts.onDesiredChange;
        this.logFn = opts.log ?? (() => {});
        this.vaddrKey = "";
        this.reachable = opts.initialReachable ?? true;
        this.wanted = {
            onOff: false,
            level: MATTER_LEVEL_MAX,
            mireds: opts.capability.kind === "colorTemperature" ? colorPercentToMireds(50, opts.colorScale) : null,
        };

        const bridged = {
            nodeLabel: this.name.slice(0, 32),
            productName: opts.product.slice(0, 32),
            productLabel: opts.product.slice(0, 64),
            serialNumber: this.mac,
            reachable: opts.initialReachable ?? true,
            // `uniqueId`（0x12）と `reachable`（0x11）は必須属性。
            // ⭐ `uniqueId` は **matter.js が未指定なら自動生成して永続化する**（"FN" 品質）ので
            //    こちらでは指定しない（指定しても matter.js の生成値が優先される）。
            //    ⚠️ ストレージ（/var/lib/odelic-matter）を消すと再生成される点だけ注意。
        };

        if (this.capability.kind === "colorTemperature") {
            this.endpoint = new Endpoint(ColorTemperatureLightDevice.with(BridgedDeviceBasicInformationServer), {
                id: this.endpointId,
                bridgedDeviceBasicInformation: bridged,
                levelControl: {
                    minLevel: MATTER_LEVEL_MIN,
                    maxLevel: MATTER_LEVEL_MAX,
                    currentLevel: MATTER_LEVEL_MAX,
                },
                colorControl: {
                    // ⚠️ colorMode / enhancedColorMode は必須属性。設定しないと
                    //    エンドポイントの初期化が Conformance "M" で失敗する
                    colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
                    enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,
                    colorTempPhysicalMinMireds: physicalMinMireds(this.colorScale),
                    colorTempPhysicalMaxMireds: physicalMaxMireds(this.colorScale),
                    coupleColorTempToLevelMinMireds: physicalMinMireds(this.colorScale),
                    colorTemperatureMireds: colorPercentToMireds(50, this.colorScale),
                    startUpColorTemperatureMireds: null,
                },
            });
        } else {
            this.endpoint = new Endpoint(DimmableLightDevice.with(BridgedDeviceBasicInformationServer), {
                id: this.endpointId,
                bridgedDeviceBasicInformation: bridged,
                levelControl: {
                    minLevel: MATTER_LEVEL_MIN,
                    maxLevel: MATTER_LEVEL_MAX,
                    currentLevel: MATTER_LEVEL_MAX,
                },
            });
        }
    }

    /** 属性の変化を購読する。エンドポイントをブリッジに add した後に呼ぶ。 */
    subscribe(): void {
        const ep = this.endpoint;

        ep.events.onOff.onOff$Changed.on((value: boolean) => this.noteChange("onOff", value));
        ep.events.levelControl.currentLevel$Changed.on((value: number | null) => this.noteChange("level", value));
        if (this.capability.kind === "colorTemperature") {
            ep.events.colorControl.colorTemperatureMireds$Changed.on((value: number | null) =>
                this.noteChange("mireds", value),
            );
        }

        ep.events.identify.startIdentifying.on(() => this.logFn(`${this.name}: identify 開始（点滅させる手段はない）`));
        ep.events.identify.stopIdentifying.on(() => this.logFn(`${this.name}: identify 終了`));
    }

    private noteChange(field: TouchedField, value: number | boolean | null): void {
        // 器具の状態としてこちらが書いた値と同じ → 送る意味がない（エコー抑止）
        if (this.applied[field] !== null && this.applied[field] === value) return;

        // ⭐ イベントの値をそのまま「望み」として記録する（`endpoint.state` は後から読まない）
        if (field === "onOff" && typeof value === "boolean") this.wanted.onOff = value;
        if (field === "level" && typeof value === "number") this.wanted.level = value;
        if (field === "mireds" && typeof value === "number") {
            this.wanted.mireds = value;
            this.colorPercent = miredsToColorPercent(value, this.colorScale);
        }
        this.touched.add(field);
        this.intentSeq++;
        this.logFn(`  ${this.name}: Matter 側で ${field} = ${String(value)} に変わった`);
        this.onDesiredChange(this);
    }

    /**
     * 送るべきコマンドを決める。何も触られていなければ `null`。
     *
     * - 消灯が望まれていれば常に `/off`（同じバッチの明るさ変化は無視する）
     * - 点灯に変わっただけ（明るさは触られていない）なら `/on` で器具の記憶値に戻す
     * - 明るさが触られていれば `/level` か `/night`
     * - ⚠️ 常夜灯中に色温度だけ触られた場合は**何も送らない**。
     *   常夜灯に色温度は無く、勝手に主灯を点けるべきでもない（次の点灯時に反映される）
     */
    resolveCommand(): PendingCommand | null {
        if (this.touched.size === 0) return null;
        const touched = this.touched;
        const { onOff, level } = this.wanted;

        if (!onOff) return { kind: "off" };

        const target = matterLevelToTarget(level, this.scale);

        if (!touched.has("level") && !touched.has("mireds")) {
            // ON だけが押された。
            // ⭐ Matter の On は「消灯前の CurrentLevel に戻す」意味なので、
            //    その位置が常夜灯の帯なら**常夜灯を復元する**。
            // ⚠️ protocol の ON（`37 37`）は**主灯の記憶値しか戻さない**ので、
            //    ここで /on を送ると常夜灯だったのに主灯が点いてしまう。
            if (target.kind === "night") return { kind: "night", level: target.level };
            return { kind: "on" };
        }

        if (target.kind === "night") {
            if (!touched.has("level")) {
                // 常夜灯中の色温度変更。望み値だけ覚えて送らない
                return null;
            }
            return { kind: "night", level: target.level };
        }

        return { kind: "level", bright: target.bright, color: this.colorPercent };
    }

    /**
     * コマンドを送り出す直前に呼ぶ。触られた印を「送信中」に移す。
     *
     * ⭐ 送信中も器具の状態で上書きしない。送り終える（`endSend`）まで
     * Matter 側の表示はユーザーの指示のままにする。
     */
    beginSend(): void {
        for (const f of this.touched) this.inFlight.add(f);
        this.touched.clear();
    }

    /** 送信が終わった（成否は問わない）。以降は器具の状態で上書きしてよい。 */
    endSend(): void {
        this.inFlight.clear();
    }

    /** 器具の状態で上書きしてはいけないフィールドか。 */
    private isPinned(field: TouchedField): boolean {
        return this.touched.has(field) || this.inFlight.has(field);
    }

    /**
     * 器具の実状態を Matter の属性に書き戻す。
     *
     * ⚠️ ここでの書き込みが `$Changed` を飛ばすので、必ず `applying` で囲む。
     */
    applyFromDevice(device: OdelicDevice, connected: boolean): Promise<void> {
        // ⚠️ 書き戻しは 1 本ずつ。ポーリングと送信後の反映が重なると属性が交錯する
        const next = this.writeChain.then(
            () => this.doApplyFromDevice(device, connected),
            () => this.doApplyFromDevice(device, connected),
        );
        this.writeChain = next.catch(() => {});
        return next;
    }

    private async doApplyFromDevice(device: OdelicDevice, connected: boolean): Promise<void> {
        const seq = this.intentSeq;
        this.vaddrKey = device.key;
        this.groupId = device.group_id;
        this.lastSeen = device.last_seen;

        // ⚠️ 送信待ち・送信中のときは器具の色温度で上書きしてはいけない。
        //    `colorPercent` は「次に送る色温度」なので、上書きすると
        //    **ユーザーが今指定した色温度が消え、1 つ前の値が送られる**
        //    （実機ログで発覚: 294 mired = 35% の指示に対して 65% を送っていた）
        if (device.color !== null && !this.isPinned("mireds")) this.colorPercent = device.color;

        const want = deviceStateToMatter(
            { on: device.on, bright: device.bright, color: device.color, night: device.night },
            this.scale,
            this.colorScale,
        );

        // ⭐ 状態が一度も取れていない器具は「不明」として扱う。適当な値を見せない（P4）
        const known = device.on !== null || (device.night !== null && device.night > 0);
        await this.setReachable(connected && known);

        const patch: Record<string, Record<string, unknown>> = {};

        // ⚠️ 送信待ち・送信中のフィールドは触らない。ユーザーの指示を消してしまう
        if (!this.isPinned("onOff")) {
            // ⚠️ 基準値はパッチの有無に関わらず**必ず**更新する。「パッチを当てたときだけ」に
            //    すると基準値が古くなり、本物のコントローラ操作を誤って抑止する
            this.applied.onOff = want.onOff;
            if (want.onOff !== null) {
                this.wanted.onOff = want.onOff;
                if (want.onOff !== this.endpoint.state.onOff.onOff) patch.onOff = { onOff: want.onOff };
            }
        }
        if (!this.isPinned("level")) {
            this.applied.level = want.level;
            if (want.level !== null) {
                this.wanted.level = want.level;
                if (want.level !== this.endpoint.state.levelControl.currentLevel) {
                    patch.levelControl = { currentLevel: want.level };
                }
            }
        }
        if (this.capability.kind === "colorTemperature" && !this.isPinned("mireds")) {
            this.applied.mireds = want.mireds;
            if (want.mireds !== null) {
                this.wanted.mireds = want.mireds;
                if (want.mireds !== this.endpoint.state.colorControl.colorTemperatureMireds) {
                    patch.colorControl = { colorTemperatureMireds: want.mireds };
                }
            }
        }

        // ⚠️ 書き込む直前にもう一度確認する。ここまでの `await` の間に
        //    コントローラの操作が来ていたら、そのフィールドは書かない（表示のちらつき対策）
        if (this.isPinned("onOff")) delete patch.onOff;
        if (this.isPinned("level")) delete patch.levelControl;
        if (this.isPinned("mireds")) delete patch.colorControl;

        if (Object.keys(patch).length === 0) return;

        // ⚠️ 計算中にユーザー操作が入っていたら書き戻しを丸ごと捨てる。
        //    古い状態を遅れて書き込むと、それが新しい操作として再解釈されてしまう
        if (this.intentSeq !== seq) {
            this.logFn(`  ${this.name}: 書き戻しを破棄（途中でユーザー操作が入った）`);
            return;
        }
        // ⭐ ブリッジ内部の Matter 属性を外から見る唯一の窓なので残しておく。
        //    実状態が変わったときだけ出るので量は多くない
        this.logFn(`  ${this.name}: Matter へ反映 ${this.describeState(want)}`);
        await this.endpoint.set(patch);
    }

    /** ⭐ 「今この器具の状態が分かっているか」を Matter に伝える。 */
    async setReachable(reachable: boolean): Promise<void> {
        if (this.reachable === reachable) return;
        this.reachable = reachable;
        await this.endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
        this.logFn(`${this.name}: Reachable = ${reachable}`);
    }

    /**
     * 送信が失敗したときに Matter 側の属性を器具の実状態へ引き戻す。
     *
     * ⚠️ これをしないと Google Home が「消えているのに ON 表示」のままになる。
     * ⚠️ 引き戻しで生じる `$Changed` を再送信につなげないよう、触られた印を消す。
     */
    async revertTo(device: OdelicDevice, connected: boolean): Promise<void> {
        // ⚠️ 先に印を消す。消さないと `applyFromDevice` が「ユーザーの指示」として
        //    守ってしまい、引き戻しが一切効かない
        this.touched.clear();
        this.inFlight.clear();
        await this.applyFromDevice(device, connected);
    }

    /** 書き戻す値を人が読める形にする。1 軸マッピングの効き方がこれで確認できる。 */
    private describeState(want: MatterLightState): string {
        if (want.onOff === null) return "状態不明（Reachable = false）";
        if (!want.onOff) return "OnOff=off";
        if (want.level === null) return "OnOff=on（明るさは不明）";
        const t = matterLevelToTarget(want.level, this.scale);
        const what = t.kind === "night" ? `常夜灯 レベル ${t.level}` : `主灯 ${t.bright}%`;
        const ct = want.mireds === null ? "" : ` / ${want.mireds} mired`;
        return `OnOff=on level=${want.level}（= ${what}）${ct}`;
    }

    /** ログ用の 1 行。 */
    describe(): string {
        const nl = this.capability.nightLight ? "常夜灯あり" : "常夜灯なし";
        const lv = targetToMatterLevel({ kind: "main", bright: 100 }, this.scale);
        return `${this.name} (${this.mac}) ${this.capability.kind} / ${nl} / 最大 level ${lv}`;
    }
}
