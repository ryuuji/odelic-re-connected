/**
 * ブリッジ本体。Aggregator と器具エンドポイントの動的増減、送信の合成、状態の取り込み。
 *
 * ## 送信の一本化
 *
 * デバウンスは**ブリッジに一本化**してある。器具ごとに持つと、Google Home が
 * 複数エンドポイントへ同時に投げたときに合成の機会を逃す。1 本にまとめることで
 * 「全器具が同じ指示なら `target=all` を 1 通」（docs/07-matter.md §7-3）が自然に書ける。
 *
 * ## ⚠️ Matter の invoke に失敗を返せないことについて
 *
 * 属性変化（`currentLevel$Changed` など）に反応する設計なので、matter.js は
 * **こちらが odelicd を叩く前に invoke へ Success を返している**。つまり
 * 「送ったが収束しなかった」を invoke の失敗として返す方法がない。
 *
 * 代わりに次の 2 つで正直さを保つ（docs/analysis/03-instability.md の P4）。
 *
 * 1. 失敗したら属性を**器具の実状態へ引き戻す**（Google Home の表示が元に戻る）
 * 2. 状態が分からない器具は `Reachable = false` にする
 *
 * invoke そのものを失敗させるにはクラスタのコマンドハンドラを個別に上書きする必要があり、
 * `Move` / `Step` の意味論まで自前で持つことになる。まずは上の 2 つで運用する。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { DeviceCommissioner } from "@matter/protocol";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { QrCode } from "@matter/types/schema";

import { capabilityOf } from "@odelic/common";
import {
    type Config,
    colorScaleOf,
    isUnknownMac,
    lightScaleOf,
    normalizeMac,
} from "./config.js";
import { Fixture, type PendingCommand, describeCommand, sameCommand } from "./fixture.js";
import { type CommandOutcome, OdelicClient, type OdelicInfo, type OdelicTarget } from "./odelicd.js";
import {
    type Roster,
    displayNameOf,
    loadRoster,
    remove as removeFromRoster,
    rosterPath,
    saveRoster,
    setDisplayName,
    upsert,
} from "./roster.js";

/** Matter の BasicInformation に出す識別子。⚠️ serialNumber と uniqueId は別の値にする。 */
const BRIDGE_SERIAL = "odelic-matter-bridge";
const BRIDGE_UNIQUE_ID = "odelicmatterbridge01";
export const BRIDGE_VERSION = "0.1.0";
const BRIDGE_SOFTWARE_VERSION = 1;

/** `/metrics` を引く間隔（ポーリング何回ごと）。absent はゆっくり変わる */
const ABSENT_CHECK_EVERY = 10;

/**
 * 取りこぼしを見つけたときに追加で打つ状態要求の回数と間隔。
 *
 * ⭐ odelicd は **3 回連続**の取りこぼしで `absent` を立てる。定期要求
 * （`statusRefreshSec`）だけに任せると 3 周期＝数分かかるので、1 回目の取りこぼしを
 * 見つけた時点でこちらから追い打ちをかけて streak を完成させる。
 *
 * ⚠️ 間隔は odelicd の `probe_window_ms`（RTT p90 × 4・下限 500 ms）より長くする。
 * 短いと前の要求の窓が閉じておらず、取りこぼしとして記録されない。
 */
const FAST_PROBES = 2;
const FAST_PROBE_GAP_MS = 900;

/** 同じ器具に追い打ちをかける最短間隔（ms）。ログと BLE を無駄に増やさないため */
const FAST_PROBE_COOLDOWN_MS = 20_000;

export interface BridgeOptions {
    config: Config;
    log?: (msg: string) => void;
}

export class Bridge {
    private readonly cfg: Config;
    private readonly log: (msg: string) => void;
    private readonly client: OdelicClient;
    private readonly fixtures = new Map<string, Fixture>();
    /** 器具が最後に `GET /info` に現れた時刻（ms）。撤去の猶予判定に使う */
    private readonly lastPresent = new Map<string, number>();
    /**
     * テスト用フック。ノードをオンラインにする直前の器具数を通知する。
     *
     * ⚠️ ここが 0 だと Google Home が毎回「デバイスが追加されました」通知を出す。
     */
    onOnlineForTest: ((fixtureCount: number) => void) | undefined;

    private server!: ServerNode;
    private aggregator!: Endpoint<AggregatorEndpoint>;

    private debounceTimer: NodeJS.Timeout | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private statusTimer: NodeJS.Timeout | undefined;
    private sendChain: Promise<void> = Promise.resolve();
    private lastInfo: OdelicInfo | null = null;
    private probedForIdentity = false;
    private stopping = false;
    /** odelicd に届かない状態が続くときにログを埋めないための記憶 */
    private odelicdDown = false;
    /**
     * ⭐ 電源が落ちている器具（odelicd の `metrics.delivery[].absent`）。
     *
     * ⚠️ odelicd は器具を `devices` から削除しないので、`/info` に居ることは
     * 生きている証拠にならない。これが無いと**通電が切れた器具が
     * 「最後の状態でオンライン」のまま残る**。
     */
    private absent = new Set<string>();
    /** `/metrics` は毎回引く必要がない（absent は 3 回の取りこぼしで決まる） */
    private pollTick = 0;
    /** `GET /events` の続きを読む位置（unix 秒） */
    private lastEventTs = 0;
    /**
     * 最後にコマンドの結果を反映し終えた時刻（ms）。
     *
     * ⚠️ **これより前に取得した `/info` は古い**（コマンドが器具に効く前の状態）。
     * 適用すると**操作直後に一瞬値が戻る**（テストが 6 回に 2 回落ちて気づいた）。
     */
    private lastSettleAt = 0;
    /**
     * コマンドを送った回数。⭐ **飛行中の `/info` を無効化するために使う。**
     *
     * ⚠️ 取得を始めた時点では最新でも、その後にコマンドを送れば**古い情報になる**。
     * それを適用すると `wanted` が巻き戻り、次の書き戻しで
     * 「ユーザーが設定した値」が段の代表値に書き換えられてしまう（診断ログで確定）。
     */
    private cmdEpoch = 0;
    /** 器具ごとの追い打ち最終時刻。連打を防ぐ */
    private readonly lastFastProbe = new Map<string, number>();
    /**
     * ⭐ 一度見つけた器具の名簿（永続化）。
     *
     * ⚠️ odelicd は器具一覧をメモリにしか持たず、**壁スイッチで消えている器具は
     * 再発見されない**。名簿が無いと、そういう器具のエンドポイントを復元できず、
     * `endpoint.delete()` で `uniqueId` まで失って Google Home の設定が飛ぶ。
     */
    private roster: Roster = { version: 1, fixtures: [] };
    private readonly rosterFile: string;
    /**
     * commissioning が完了した時刻（ms）。
     *
     * ⚠️⚠️ **直後にブリッジを再起動すると Nest ハブが配下の器具を失う**（docs/07 M6-6）。
     * 設定ページからの再起動要求をここで弾く。
     */
    private commissionedAt: number | null = null;
    /**
     * 追加登録の受付が閉じる時刻（ms）。設定ページに残り時間を出すために覚えている。
     *
     * ⚠️ **自分で開けたときしか分からない。**ブリッジを再起動したり、他の経路で
     * 開かれたりすると `null` のまま（そのときは残り時間を出さず「受付中」とだけ言う）。
     */
    private commissioningWindowUntil: number | null = null;
    /** ⚠️ 期限を自分で切るためのタイマー。`allowBasicCommissioning()` は勝手に閉じない */
    private commissioningWindowTimer: ReturnType<typeof setTimeout> | null = null;
    /** 設定ページからの再起動要求を受けたときに呼ぶ。既定は `process.exit(0)`（systemd が上げ直す） */
    onRestartRequest: (() => void) | undefined;
    private startedAt = Date.now();

    constructor(opts: BridgeOptions) {
        this.cfg = opts.config;
        this.log = opts.log ?? (msg => console.log(msg));
        this.rosterFile = rosterPath(this.cfg.matter.storagePath);
        this.client = new OdelicClient({
            baseUrl: this.cfg.odelicd,
            waitMs: this.cfg.waitMs,
            log: msg => this.log(msg),
        });
    }

    // ------------------------------------------------------------ 起動

    async start(): Promise<void> {
        const m = this.cfg.matter;

        this.server = await ServerNode.create({
            id: "odelic-bridge",
            network: { port: m.port },
            commissioning: { passcode: m.passcode, discriminator: m.discriminator },
            productDescription: {
                name: m.productName,
                deviceType: AggregatorEndpoint.deviceType,
            },
            basicInformation: {
                vendorName: m.vendorName,
                vendorId: VendorId(m.vendorId),
                productName: m.productName,
                productLabel: m.productName,
                productId: m.productId,
                nodeLabel: m.productName,
                // ⚠️ uniqueId と serialNumber は別の値でなければならない（Matter 仕様）
                serialNumber: BRIDGE_SERIAL,
                uniqueId: BRIDGE_UNIQUE_ID,
                hardwareVersion: 1,
                hardwareVersionString: "raspberry-pi-3",
                softwareVersion: BRIDGE_SOFTWARE_VERSION,
                softwareVersionString: BRIDGE_VERSION,
            },
        });

        this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
        await this.server.add(this.aggregator);

        // ⭐⭐ **オンラインになる前に**名簿から器具を復元する。
        //    後から足すと、Google Home が「器具 0 台」を読んだ直後に器具が現れるため
        //    **毎回の再起動で「デバイスが追加されました」通知が飛ぶ**（実機で確認）。
        await this.restoreFromRoster();

        this.onOnlineForTest?.(this.fixtures.size);
        await this.server.start();
        this.reportCommissioning();

        this.server.events.commissioning.commissioned.on(() => {
            // ⚠️ ここから 10 分は設定ページからの再起動を断る（M6-6）
            this.commissionedAt = Date.now();
            this.log("★ commissioning 完了。Google Home から操作できます");
            this.log("  ⚠️ しばらくブリッジを再起動しないでください（Nest ハブが器具を失います）");
        });
        this.server.events.commissioning.decommissioned.on(() => {
            this.log("[!] decommission されました。再度 commissioning が必要です");
            this.reportCommissioning();
        });

        // 現況を取り込む。その後は pollMs 間隔。
        // ⚠️ setInterval で await しないと**ポーリングが重なって**属性の書き戻しが
        //    交錯する（統合テストで実際に踏んだ）。必ず 1 周終えてから次を積む
        await this.poll();
        this.scheduleNextPoll();

        if (this.cfg.statusRefreshSec > 0) {
            const ms = this.cfg.statusRefreshSec * 1000;
            this.log(
                `壁スイッチ追従のため ${this.cfg.statusRefreshSec} 秒ごとに状態要求を送ります` +
                    `（⚠️ BLE を 1 通使う。接続ログの採取中は statusRefreshSec を 0 にしてください）`,
            );
            this.statusTimer = setInterval(() => void this.client.requestStatus(), ms);
        } else {
            this.log("statusRefreshSec = 0。BLE は操作のときだけ使います（壁スイッチの変更は追従しません）");
        }
    }

    /**
     * 名簿にある器具のエンドポイントを作る。
     *
     * この時点では odelicd の状態を知らないので `Reachable = false`。
     * 実際に見えたら `reconcile()` が状態を入れて `Reachable = true` にする。
     */
    private async restoreFromRoster(): Promise<void> {
        this.roster = loadRoster(this.rosterFile, msg => this.log(`[!] ${msg}`));
        if (this.roster.fixtures.length === 0) return;

        for (const entry of this.roster.fixtures) {
            const override = this.cfg.fixtures[entry.mac] ?? {};
            const cap = capabilityOf(entry.productCode, override);
            if (!cap.isLight) continue;
            // ⚠️ server.start() 前なので endpoint.set() は使えない。
            //    Reachable はコンストラクタで false にする
            const fixture = await this.createFixture(entry.mac, this.nameFor(entry.mac), cap, entry.product, entry.version, false);
            this.log(`◇ 名簿から復元: ${fixture.describe()}（まだ odelicd から見えていません）`);
        }
    }

    /** エンドポイントを 1 個作って Aggregator に付ける。 */
    private async createFixture(
        mac: string,
        name: string | undefined,
        cap: ReturnType<typeof capabilityOf>,
        product: string,
        version: string,
        initialReachable = true,
    ): Promise<Fixture> {
        const fixture = new Fixture({
            mac,
            name,
            capability: cap,
            scale: lightScaleOf(this.cfg, cap.nightLight),
            colorScale: colorScaleOf(this.cfg),
            product,
            version,
            initialReachable,
            onDesiredChange: f => this.scheduleFlush(f),
            log: msg => this.log(msg),
        });
        await this.aggregator.add(fixture.endpoint);
        fixture.subscribe();
        this.fixtures.set(fixture.mac, fixture);
        return fixture;
    }

    /** ポーリングを 1 周ずつ直列に回す。 */
    private scheduleNextPoll(): void {
        if (this.stopping) return;
        this.pollTimer = setTimeout(() => {
            void this.poll()
                .catch(e => this.log(`[!] ポーリングで例外: ${e instanceof Error ? e.message : String(e)}`))
                .finally(() => this.scheduleNextPoll());
        }, Math.max(50, this.cfg.pollMs));
    }

    private reportCommissioning(): void {
        const c = this.server.state.commissioning;
        if (c.commissioned) {
            this.log("既に commissioning 済みです（フェアリング情報は保存済み）");
            return;
        }
        const { manualPairingCode, qrPairingCode } = c.pairingCodes;
        this.log("");
        this.log("=== Matter commissioning ===");
        this.log(`  手入力コード : ${manualPairingCode}`);
        this.log(`  QR ペイロード: ${qrPairingCode}`);
        this.log(`  VID/PID      : 0x${this.cfg.matter.vendorId.toString(16)}/0x${this.cfg.matter.productId.toString(16)}`);
        this.log("");
        this.log("  ⚠️ テスト VID を使う場合、Google Home Developer Console に");
        this.log("     Matter integration を登録していないと commissioning を拒否されます");
        this.log("  ⚠️ BLE は使いません（オンネットワーク commissioning）。");
        this.log("     Pi と Google スピーカーが同一 LAN で IPv6 / mDNS が通ることが前提です");
        this.log("");
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.statusTimer) clearInterval(this.statusTimer);
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        await this.sendChain.catch(() => {});
        await this.server?.close();
    }

    // ------------------------------------------------------- 状態の取り込み

    /** `GET /info` を読んでエンドポイントと属性を合わせる。⭐ BLE を使わない。 */
    private async poll(): Promise<void> {
        if (this.stopping) return;
        // ⚠️ 取得を始めた時点の情報を覚えておく。
        //    コマンドの反映より前／取得中にコマンドを送った場合は捨てる
        const fetchedAt = Date.now();
        const epoch = this.cmdEpoch;
        const info = await this.client.info();
        if (info === null) {
            // odelicd に届かない。何も断定しない（P4）
            if (!this.odelicdDown) {
                this.odelicdDown = true;
                this.log(
                    `[!] odelicd に届きません（${await this.client.describeReachability()}）。` +
                        "全器具を Reachable = false にして待ちます",
                );
            }
            for (const f of this.fixtures.values()) await f.setReachable(false);
            return;
        }
        if (this.odelicdDown) {
            this.odelicdDown = false;
            this.log("odelicd に再接続しました");
        }
        // ⚠️ コマンドの反映より前に取得した情報、または取得中にコマンドを送った場合は古い。
        //    適用すると値が一瞬戻り、ユーザーが設定した値が代表値に書き換えられる
        if (fetchedAt < this.lastSettleAt || epoch !== this.cmdEpoch) return;
        this.lastInfo = info;

        // ⭐ 取りこぼしを 1 回目で捕まえて追い打ちをかける（検知を数分から数秒に縮める）
        const sawMiss = await this.checkMisses();

        // ⭐ 通電が切れた器具を拾う。absent は 3 回の取りこぼしで決まるので毎回は要らないが、
        //    取りこぼしを見つけた直後は即座に確認する
        if (sawMiss || this.pollTick++ % ABSENT_CHECK_EVERY === 0) {
            await this.refreshAbsent();
        }
        await this.reconcile(info);
        await this.probeIdentityIfNeeded(info);
    }

    /** `/metrics` の `absent` を取り込み、変化をログに出す。⭐ BLE を使わない。 */
    private async refreshAbsent(): Promise<void> {
        const absent = await this.client.absentKeys();
        if (absent === null) return;
        for (const key of absent) {
            if (!this.absent.has(key)) this.log(`[!] 器具 ${key} が応答しません（通電が切れた可能性）`);
        }
        for (const key of this.absent) {
            if (!absent.has(key)) this.log(`器具 ${key} が復帰しました`);
        }
        this.absent = absent;
    }

    /**
     * `miss` イベントを見て、疑わしい器具に追加の状態要求を打つ。
     *
     * ⭐ odelicd は 3 回連続の取りこぼしで `absent` を立てる。定期要求だけに任せると
     * `statusRefreshSec × 3`（既定なら約 1 分半〜3 分）かかるので、
     * **1 回目の取りこぼしを見つけた時点で追い打ちをかけて数秒で確定させる。**
     *
     * ⚠️ `GET /events` 自体は BLE を使わない。追い打ちの状態要求だけが 1 通ずつ使う。
     * 既に `absent` と分かっている器具には打たない（無駄）。
     *
     * @returns 追い打ちを打ったか（打ったなら呼び出し側が `absent` を即確認する）
     */
    private async checkMisses(): Promise<boolean> {
        const res = await this.client.events(this.lastEventTs, "miss");
        if (res === null) return false;
        const first = this.lastEventTs === 0;
        this.lastEventTs = res.now;
        // 初回は過去の履歴を全部拾ってしまうので、位置合わせだけして何もしない
        if (first) return false;

        const now = Date.now();
        const suspects = new Set<string>();
        for (const e of res.events) {
            const key = e.vaddr?.toUpperCase();
            if (key === undefined || this.absent.has(key)) continue;
            if (now - (this.lastFastProbe.get(key) ?? 0) < FAST_PROBE_COOLDOWN_MS) continue;
            suspects.add(key);
        }
        if (suspects.size === 0) return false;

        for (const key of suspects) {
            this.lastFastProbe.set(key, now);
            this.log(`器具 ${key} が状態要求に応答しませんでした。確認のため追加で問い合わせます`);
        }
        // ⚠️ 直列に打つ。odelicd は in-flight を 1 本に制限しているので、
        //    間隔を空けないと前の要求の窓が閉じず取りこぼしとして記録されない
        for (let i = 0; i < FAST_PROBES; i++) {
            for (const key of suspects) {
                await this.client.requestStatus(`dev:${key}`);
            }
            await new Promise(r => setTimeout(r, FAST_PROBE_GAP_MS));
        }
        return true;
    }

    /**
     * 器具の一覧に合わせてエンドポイントを増減し、属性を更新する。
     *
     * ⚠️ 同一性は **MAC** で取る。vAddr は変わり得るので使わない（docs/07-matter.md §7-4）。
     */
    private async reconcile(info: OdelicInfo): Promise<void> {
        const now = Date.now();
        const seen = new Set<string>();

        for (const device of info.devices) {
            const mac = normalizeMac(device.mac);
            if (isUnknownMac(mac)) continue; // MAC 未取得。エンドポイントを作れない

            const override = this.cfg.fixtures[mac] ?? {};
            const cap = capabilityOf(device.product_code, override);
            if (!cap.isLight) {
                // ⭐ センサー等をライトとして出さない
                if (!this.lastPresent.has(mac)) {
                    this.log(`− Matter に出しません: ${mac} ${device.product} — ${cap.reason}`);
                    this.lastPresent.set(mac, now);
                }
                continue;
            }

            seen.add(mac);
            this.lastPresent.set(mac, now);

            let fixture = this.fixtures.get(mac);
            if (fixture === undefined) {
                fixture = await this.createFixture(mac, this.nameFor(mac), cap, device.product, device.version);
                this.log(`＋ Matter に追加: ${fixture.describe()} — ${cap.reason}`);
            }
            fixture.groupId = device.group_id;
            fixture.lastSeen = device.last_seen;

            // ⭐ 名簿に記録する。次回の起動でエンドポイントを復元できるようにする
            if (upsert(this.roster, {
                mac,
                product: device.product,
                productCode: device.product_code,
                version: device.version,
            }, new Date())) {
                saveRoster(this.rosterFile, this.roster, msg => this.log(`[!] ${msg}`));
            }
            // ⭐ 通電が切れている器具は「状態不明」として扱う（P4: 嘘をつかない）
            const alive = info.connected && !this.absent.has(device.key.toUpperCase());
            await fixture.applyFromDevice(device, alive);
        }

        // 見えなくなった器具。すぐ消さず Reachable = false にして猶予を置く
        for (const [mac, fixture] of [...this.fixtures]) {
            if (seen.has(mac)) continue;
            await fixture.setReachable(false);
            // ⚠️ 既定（missingGraceSec = 0）では**撤去しない**。
            //    `endpoint.delete()` は永続データを消すので uniqueId が変わり、
            //    Google Home からは別デバイスになって部屋割り・名前・自動化が失われる。
            //    壁スイッチで消えている器具は odelicd から見えないのが通常状態なので、
            //    「見えない」を撤去の理由にしてはいけない
            if (this.cfg.missingGraceSec <= 0) continue;
            const since = now - (this.lastPresent.get(mac) ?? now);
            if (since > this.cfg.missingGraceSec * 1000) {
                this.log(`− Matter から撤去: ${fixture.name} (${mac}) — ${Math.round(since / 1000)} 秒見えていない`);
                await fixture.endpoint.delete();
                this.fixtures.delete(mac);
                this.lastPresent.delete(mac);
            }
        }
    }

    /**
     * MAC や製品コードが埋まっていない器具があるときだけ Ping / 探索を投げる。
     *
     * ⚠️ **BLE を 2 通使う。**odelicd は参加時に自分で探索するので、
     * 通常はここに来ない（= 定常運用で BLE を増やさない）。
     */
    private async probeIdentityIfNeeded(info: OdelicInfo): Promise<void> {
        if (this.probedForIdentity || !info.connected || !info.joined) return;

        const missingMac = info.devices.some(d => isUnknownMac(d.mac));
        const missingProduct = info.devices.some(d => d.product_code === null);
        const noDevices = info.devices.length === 0;
        if (!missingMac && !missingProduct && !noDevices) return;

        this.probedForIdentity = true;
        this.log("器具の MAC / 製品コードが不足しているので Ping と探索を 1 回投げます（⚠️ BLE を 2 通使う）");
        await this.client.ping();
        await this.client.discover();
    }

    // --------------------------------------------------------- 送信の合成

    private scheduleFlush(_fixture: Fixture): void {
        if (this.stopping) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.enqueue(() => this.flush());
        }, Math.max(0, this.cfg.debounceMs));
    }

    /** 送信は必ず直列化する。並行させると順序が入れ替わって最後の指示が負ける */
    private enqueue(task: () => Promise<void>): void {
        this.sendChain = this.sendChain.then(task).catch(e => {
            this.log(`[!] 送信中に例外: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    private async flush(): Promise<void> {
        const pending: Array<{ fixture: Fixture; cmd: PendingCommand }> = [];
        for (const fixture of this.fixtures.values()) {
            const cmd = fixture.resolveCommand();
            // ⭐ 触られた印を「送信中」に移す。送り終えるまでポーリングに上書きさせない
            fixture.beginSend();
            if (cmd !== null) pending.push({ fixture, cmd });
        }
        if (pending.length === 0) return;

        // §7-3: 全器具が同じ指示なら 1 通にまとめる
        const first = pending[0]!;
        const canCoalesce =
            this.cfg.coalesceAll &&
            pending.length > 1 &&
            pending.length === this.fixtures.size &&
            pending.every(p => sameCommand(p.cmd, first.cmd));

        if (canCoalesce) {
            this.log(`→ 全 ${pending.length} 台を 1 通で: ${describeCommand(first.cmd)}`);
            const outcome = await this.send("all", first.cmd);
            await this.settle(outcome, pending.map(p => p.fixture));
            return;
        }

        for (const { fixture, cmd } of pending) {
            if (fixture.vaddrKey === "") {
                this.log(`[!] ${fixture.name}: vAddr が未取得なので送れません`);
                await this.revert([fixture]);
                continue;
            }
            this.log(`→ ${fixture.name}: ${describeCommand(cmd)}`);
            const outcome = await this.send(`dev:${fixture.vaddrKey}`, cmd);
            await this.settle(outcome, [fixture]);
        }
    }

    private send(target: OdelicTarget, cmd: PendingCommand): Promise<CommandOutcome> {
        // ⭐ 飛行中の `/info` をここで無効化する
        this.cmdEpoch++;
        switch (cmd.kind) {
            case "off":
                return this.client.setOn(target, false);
            case "on":
                return this.client.setOn(target, true);
            case "level":
                return this.client.setLevel(target, cmd.bright, cmd.color);
            case "night":
                return this.client.setNight(target, cmd.level);
        }
    }

    /**
     * 送信結果を Matter 側に反映する。
     *
     * ⭐ 成功時は応答に入っている最新状態をそのまま使う（次のポーリングを待たない）。
     * 失敗時は**器具の実状態へ引き戻す**。Google Home の表示が勝手に残らないようにする。
     */
    private async settle(outcome: CommandOutcome, fixtures: Fixture[]): Promise<void> {
        const info = outcome.info ?? this.lastInfo;
        // 送信が終わったので、以降は器具の状態で属性を更新してよい
        for (const f of fixtures) f.endSend();

        if (outcome.ok) {
            if (info !== null) await this.applyInfoTo(info, fixtures);
            this.lastSettleAt = Date.now();
            return;
        }

        const why =
            outcome.reason === "queued"
                ? "器具に繋がっていないので odelicd のキューに入りました"
                : outcome.reason === "timeout"
                  ? "送りましたが器具がその状態になったことを確認できませんでした"
                  : outcome.reason === "unreachable"
                    ? "odelicd に届きません"
                    : "odelicd が拒否しました";
        this.log(`[!] ${fixtures.map(f => f.name).join(" / ")}: ${why}（${outcome.detail}）`);

        if (info !== null) await this.applyInfoTo(info, fixtures, true);
        else for (const f of fixtures) await f.setReachable(false);
        this.lastSettleAt = Date.now();
    }

    private async applyInfoTo(info: OdelicInfo, fixtures: Fixture[], revert = false): Promise<void> {
        const byMac = new Map(info.devices.map(d => [normalizeMac(d.mac), d] as const));
        for (const fixture of fixtures) {
            const device = byMac.get(fixture.mac);
            if (device === undefined) {
                await fixture.setReachable(false);
                continue;
            }
            if (revert) await fixture.revertTo(device, info.connected);
            else await fixture.applyFromDevice(device, info.connected);
        }
    }

    private async revert(fixtures: Fixture[]): Promise<void> {
        if (this.lastInfo === null) return;
        await this.applyInfoTo(this.lastInfo, fixtures, true);
    }

    // ------------------------------------------------------------ 診断

    /** ログ用。現在の構成を 1 行ずつ返す。 */
    describe(): string[] {
        const out = [`Matter ノード 1 個 / 器具 ${this.fixtures.size} 台`];
        for (const f of this.fixtures.values()) out.push(`  ${f.describe()}`);
        return out;
    }

    /** テストと診断のために、いま odelicd から見えている状態を返す。 */
    get info(): OdelicInfo | null {
        return this.lastInfo;
    }

    /** 対象を持つ器具を取り出す（診断用）。 */
    fixtureOf(mac: string): Fixture | undefined {
        return this.fixtures.get(normalizeMac(mac));
    }

    // ------------------------------------------------------------ 管理 API
    //
    // ⚠️ 呼び出し元は `admin.ts`（127.0.0.1 限定）だけ。認証は `odelic-web` 側で済ませてある。

    /**
     * 表示名の決まり方。
     *
     * ⭐ `displayName`（設定ページ） > `config.json` の `name` > MAC からの既定名
     *
     * ⚠️ 一度でも設定ページで名前を付けると `config.json` の `name` は効かなくなる
     * （名簿のほうが「後から人が決めた値」なので優先する）。
     */
    private nameFor(mac: string): string | undefined {
        const key = normalizeMac(mac);
        const fromRoster = displayNameOf(this.roster, key);
        const fromConfig = this.cfg.fixtures[key]?.name;
        if (fromRoster !== undefined && fromConfig !== undefined && fromRoster !== fromConfig) {
            this.log(`器具 ${key} の名前は設定ページの「${fromRoster}」を使います（config.json の「${fromConfig}」より優先）`);
        }
        return fromRoster ?? fromConfig;
    }

    /** 設定ページに出す全体像。 */
    adminState(): AdminState {
        return {
            version: BRIDGE_VERSION,
            uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
            odelicdReachable: !this.odelicdDown && this.lastInfo !== null,
            fixtures: [...this.fixtures.values()].map(f => ({
                mac: f.mac,
                name: f.name,
                named: displayNameOf(this.roster, f.mac) !== undefined || this.cfg.fixtures[f.mac]?.name !== undefined,
                product: this.roster.fixtures.find(r => r.mac === f.mac)?.product ?? "不明",
                productCode: f.capability.isLight ? (this.roster.fixtures.find(r => r.mac === f.mac)?.productCode ?? null) : null,
                version: this.roster.fixtures.find(r => r.mac === f.mac)?.version ?? "",
                nightLight: f.capability.nightLight,
                deviceType: f.capability.kind,
                reason: f.capability.reason,
                reachable: f.isReachable,
                // ⚠️ 名簿にはあるが odelicd から見えていない（壁スイッチで消えている等）
                inRosterOnly: !(this.lastInfo?.devices ?? []).some(d => normalizeMac(d.mac) === f.mac),
                endpointId: f.endpointId,
            })),
            commissioning: this.commissioningInfo(),
        };
    }

    /** Matter への参加状況。⚠️ QR は matter.js が持っている文字ブロックをそのまま返す。 */
    commissioningInfo(): AdminCommissioning {
        const c = this.server.state.commissioning;
        const fabrics = Object.values(c.fabrics ?? {}).map(f => ({
            index: Number(f.fabricIndex),
            label: f.label,
            vendorId: Number(f.rootVendorId),
        }));
        const windowOpen = this.commissioningWindowOpen();
        // ⭐ 閉じたら残り時間を忘れる（ペアリングが成立すると窓は勝手に閉じる）
        if (!windowOpen) this.commissioningWindowUntil = null;
        /*
         * ⭐ **commissioning 済みでも、追加登録の受付中はコードを出す。**
         *    相手のアプリ（Apple Home / Alexa）に QR か手入力コードを渡す必要があり、
         *    Basic Commissioning Window は**同じ passcode** を使うので元のコードがそのまま効く。
         * ⚠️ 受付していないときは出さない。今は使えないコードを見せても混乱するだけで、
         *    画面を覗かれたときに渡すものを増やすだけ損。
         */
        const codes = !c.commissioned || windowOpen ? c.pairingCodes : null;
        return {
            commissioned: c.commissioned,
            manualPairingCode: codes?.manualPairingCode ?? null,
            qrPairingCode: codes?.qrPairingCode ?? null,
            // ⭐ QR エンコーダを新たに入れない。matter.js の QrCode がそのまま使える
            qrText: codes === undefined || codes === null ? null : QrCode.get(codes.qrPairingCode),
            fabrics,
            windowOpen,
            // ⚠️ 自分で開けたときしか分からない（ブリッジ再起動後や他から開かれたときは null）
            windowRemainingSec:
                windowOpen && this.commissioningWindowUntil !== null
                    ? Math.max(0, Math.round((this.commissioningWindowUntil - Date.now()) / 1000))
                    : null,
            commissionedAt: this.commissionedAt === null ? null : new Date(this.commissionedAt).toISOString(),
        };
    }

    private commissioningWindowOpen(): boolean {
        // ⭐ 自分で開けたぶん。⚠️ こちらはクラスタの属性に出ない（下の openCommissioning 参照）
        if (this.commissioningWindowUntil !== null && Date.now() < this.commissioningWindowUntil) return true;
        try {
            // 他の管理者が Matter 経由で開けたぶんはここに出る。0 = WindowNotOpen
            const status = (this.server.state as { administratorCommissioning?: { windowStatus?: number } })
                .administratorCommissioning?.windowStatus;
            return status !== undefined && status !== 0;
        } catch {
            return false;
        }
    }

    /**
     * 追加フェアリング（multi-admin）の窓を開く。
     *
     * ⭐ Apple Home や Alexa を足すときに使う。既定の passcode を使う
     * 「Basic Commissioning Window」なので、表示している手入力コードがそのまま使える。
     */
    async openCommissioning(seconds: number): Promise<void> {
        if (this.commissioningWindowOpen()) throw new Error("すでに追加の登録を受け付けています");
        // ⭐⭐ `DeviceCommissioner` を直接使う。
        //
        // ⚠️⚠️ **`AdministratorCommissioningServer.openBasicCommissioningWindow()` は使えない。**
        //    あれは Matter のコマンドハンドラで、中で `assertRemoteActor()` を通すので
        //    ローカル（この管理 API）から呼ぶと
        //    "This operation requires an authenticated remote session" で落ちる。
        //    しかも**タイマーを起動したあとに落ちる**ので、内部だけ「開いている」状態が残り、
        //    2 回目に "A commissioning window is already opened" が出る（実機で踏んだ）。
        //
        // ⚠️ 代わりにこちらを使うと `AdministratorCommissioning` の `windowStatus` 属性は
        //    更新されない（他の管理者からは「開いている」と見えない）。
        //    ペアリング自体（PASE の受付）は動くので、この用途では問題にしない。
        const commissioner = this.server.env.get(DeviceCommissioner);
        await commissioner.allowBasicCommissioning(() => {
            // ペアリングが成立した／終わったときに呼ばれる
            this.clearCommissioningWindow();
            this.log("追加登録が終わりました（受付を閉じます）");
        });
        this.commissioningWindowUntil = Date.now() + seconds * 1000;
        // ⚠️⚠️ **期限は自分で切る。**`allowBasicCommissioning()` にタイムアウトは無いので、
        //    これを忘れると受付が開きっぱなしになる（誰でも登録できる状態が続く）
        this.commissioningWindowTimer = setTimeout(() => {
            this.log("追加登録の受付が時間切れになりました");
            void this.closeCommissioning().catch(e => this.log(`[!] 受付を閉じられません: ${String(e)}`));
        }, seconds * 1000);
        this.commissioningWindowTimer.unref?.();
        this.log(`追加登録の受付を開きました（${seconds} 秒・multi-admin）`);
    }

    /** 追加登録の受付をやめる。⭐ 開いていなくても安全に呼べる。 */
    async closeCommissioning(): Promise<void> {
        this.clearCommissioningWindow();
        await this.server.env.get(DeviceCommissioner).endCommissioning();
        this.log("追加登録の受付を終了しました");
    }

    private clearCommissioningWindow(): void {
        if (this.commissioningWindowTimer !== null) {
            clearTimeout(this.commissioningWindowTimer);
            this.commissioningWindowTimer = null;
        }
        this.commissioningWindowUntil = null;
    }

    /** 器具名を変える。⭐ 再起動は不要。⚠️ Google Home 側の名前は変わらない（M6）。 */
    async renameFixture(mac: string, name: string): Promise<{ ok: boolean; detail: string }> {
        const key = normalizeMac(mac);
        const trimmed = name.trim();
        if (trimmed === "") return { ok: false, detail: "名前が空です" };
        if (setDisplayName(this.roster, key, trimmed, new Date())) {
            saveRoster(this.rosterFile, this.roster, msg => this.log(`[!] ${msg}`));
        }
        const fixture = this.fixtures.get(key);
        // ⚠️ まだエンドポイントが無い器具（見えたことがない）にも名前は付けられる。
        //    次に現れたときに反映される
        if (fixture !== undefined) await fixture.setName(trimmed);
        return { ok: true, detail: fixture === undefined ? "保存しました（この器具はまだ見えていません）" : "変更しました" };
    }

    /**
     * 器具を名簿から外す。
     *
     * ⚠️⚠️ **破壊的。**`endpoint.delete()` は永続データを消すので `uniqueId` が変わり、
     * Google Home からは**別デバイス**になって部屋割り・名前・自動化が失われる。
     * 器具を本当に撤去したときだけ使う。
     */
    async removeFixture(mac: string): Promise<{ ok: boolean; detail: string }> {
        const key = normalizeMac(mac);
        const fixture = this.fixtures.get(key);
        const inRoster = removeFromRoster(this.roster, key);
        if (inRoster) saveRoster(this.rosterFile, this.roster, msg => this.log(`[!] ${msg}`));
        if (fixture !== undefined) {
            await fixture.endpoint.delete();
            this.fixtures.delete(key);
            this.lastPresent.delete(key);
        }
        if (!inRoster && fixture === undefined) return { ok: false, detail: "その器具は名簿にありません" };
        this.log(`− 器具を撤去: ${key}（⚠️ Google Home からは別デバイス扱いになります）`);
        return { ok: true, detail: "撤去しました。Google Home 側でも削除してください" };
    }

    /** 設定ページに出す設定（公開してよいものだけ）。 */
    adminSettings(): AdminSettings {
        return {
            nightBandPercent: this.cfg.nightBandPercent,
            colorTempMinKelvin: this.cfg.colorTempMinKelvin,
            colorTempMaxKelvin: this.cfg.colorTempMaxKelvin,
            colorTempInverted: this.cfg.colorTempInverted,
            statusRefreshSec: this.cfg.statusRefreshSec,
            waitMs: this.cfg.waitMs,
            debounceMs: this.cfg.debounceMs,
            coalesceAll: this.cfg.coalesceAll,
        };
    }

    /**
     * 設定を更新する。
     *
     * ⚠️ **反映に再起動が要る項目がある。**明るさの段や色温度の換算は
     * エンドポイント生成時に焼き込まれるので、変えても既存のエンドポイントには効かない。
     * どれが再起動待ちかを返して UI に出す（黙って効かないのが一番困る）。
     */
    updateSettings(patch: Partial<AdminSettings>): { ok: boolean; detail: string; needsRestart: string[] } {
        const needsRestart: string[] = [];
        /** ⚠️ エンドポイント生成時に焼き込まれる項目 */
        const RESTART_KEYS = new Set(["nightBandPercent", "colorTempMinKelvin", "colorTempMaxKelvin", "colorTempInverted"]);

        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            const k = key as keyof AdminSettings;
            if (this.cfg[k] === value) continue;
            (this.cfg as unknown as Record<string, unknown>)[k] = value;
            if (RESTART_KEYS.has(key)) needsRestart.push(key);
        }

        // ⭐ 定期の状態要求だけは即座に効かせられる
        if (patch.statusRefreshSec !== undefined) this.rescheduleStatusRefresh();

        const saved = this.saveSettings();
        return {
            ok: saved.ok,
            detail: saved.ok
                ? needsRestart.length === 0
                    ? "保存しました"
                    : `保存しました（${needsRestart.join(" / ")} はブリッジの再起動で反映されます）`
                : saved.detail,
            needsRestart,
        };
    }

    /**
     * 変更した設定を保存する。
     *
     * ⚠️ `config.json` はコメント付きで配っている（書き戻すとコメントが消える）ので、
     * ⭐ **設定ページからの変更は名簿と同じ場所（`<storagePath>/settings.json`）に置く。**
     * 起動時に `config.json` の上へ重ねる。
     */
    private saveSettings(): { ok: boolean; detail: string } {
        try {
            writeFileSync(
                settingsPath(this.cfg.matter.storagePath),
                `${JSON.stringify(this.adminSettings(), null, 2)}\n`,
                "utf8",
            );
            return { ok: true, detail: "" };
        } catch (e) {
            const detail = `設定を保存できません: ${e instanceof Error ? e.message : String(e)}`;
            this.log(`[!] ${detail}`);
            return { ok: false, detail };
        }
    }

    private rescheduleStatusRefresh(): void {
        if (this.statusTimer !== undefined) clearInterval(this.statusTimer);
        this.statusTimer = undefined;
        if (this.cfg.statusRefreshSec > 0) {
            this.statusTimer = setInterval(() => void this.client.requestStatus(), this.cfg.statusRefreshSec * 1000);
            this.log(`定期の状態要求を ${this.cfg.statusRefreshSec} 秒間隔にしました`);
        } else {
            this.log("定期の状態要求を止めました（壁スイッチの変更は追従しません）");
        }
    }

    /**
     * 設定ページからの再起動。
     *
     * ⚠️⚠️ **commissioning 直後は断る。**Nest ハブが配下の器具を失う既知の不具合を踏む
     * （docs/07 M6-6・実機で確認済み）。落ち着いてからなら問題なく復帰する。
     */
    requestRestart(): { ok: boolean; detail: string } {
        if (this.commissionedAt !== null) {
            const elapsed = Date.now() - this.commissionedAt;
            if (elapsed < RESTART_BLOCK_AFTER_COMMISSION_MS) {
                const wait = Math.ceil((RESTART_BLOCK_AFTER_COMMISSION_MS - elapsed) / 60_000);
                return {
                    ok: false,
                    detail:
                        `commissioning の直後です。あと約 ${wait} 分お待ちください` +
                        "（今再起動すると Nest ハブが配下の器具を見失います）",
                };
            }
        }
        this.log("設定ページから再起動を要求されました。終了します（systemd が起動し直します）");
        const restart = this.onRestartRequest ?? (() => process.exit(0));
        // ⚠️ 応答を返してから落ちる。同期で exit すると UI が「届かなかった」と誤解する
        setTimeout(restart, 250);
        return { ok: true, detail: "再起動します（数秒で戻ります）" };
    }

    /**
     * ⚠️⚠️ フェアリング情報を消して未 commissioning に戻す。**取り返しがつかない。**
     *
     * Google Home / Apple Home 側からもデバイスを削除する必要がある。
     */
    async factoryReset(): Promise<{ ok: boolean; detail: string }> {
        this.log("[!] フェアリング情報の破棄を要求されました");
        await this.server.erase();
        this.commissionedAt = null;
        this.log("[!] 破棄しました。再度 commissioning が必要です");
        return { ok: true, detail: "破棄しました。Google Home 側でもデバイスを削除してください" };
    }
}

/** ⚠️ commissioning 後この時間は再起動を断る（docs/07 M6-6）。 */
const RESTART_BLOCK_AFTER_COMMISSION_MS = 10 * 60_000;

/** 設定ページからの設定変更の保存先。⚠️ config.json のコメントを守るため別ファイルにする。 */
export function settingsPath(storagePath: string): string {
    return join(storagePath, "settings.json");
}

/**
 * 設定ページで保存した設定を `config.json` の上に重ねる。
 *
 * ⚠️ 無ければ何もしない（初回起動）。壊れていても起動は止めない。
 */
export function applySavedSettings(cfg: Config, warn: (msg: string) => void = () => {}): string[] {
    const path = settingsPath(cfg.matter.storagePath);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            warn(`設定ページの保存内容を読めません（config.json だけで動きます）: ${path}`);
        }
        return [];
    }
    if (typeof raw !== "object" || raw === null) return [];
    const applied: string[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!(key in cfg)) continue;
        const current = (cfg as unknown as Record<string, unknown>)[key];
        if (typeof current !== typeof value) continue;
        if (current === value) continue;
        (cfg as unknown as Record<string, unknown>)[key] = value;
        applied.push(`${key}=${String(value)}`);
    }
    return applied;
}

export interface AdminFixture {
    mac: string;
    name: string;
    named: boolean;
    product: string;
    productCode: number | null;
    version: string;
    nightLight: boolean;
    deviceType: string;
    reason: string;
    reachable: boolean;
    inRosterOnly: boolean;
    endpointId: string;
}

export interface AdminCommissioning {
    commissioned: boolean;
    manualPairingCode: string | null;
    qrPairingCode: string | null;
    qrText: string | null;
    fabrics: Array<{ index: number; label: string; vendorId: number }>;
    windowOpen: boolean;
    /** 受付が閉じるまでの秒数。⚠️ 分からないことがある（`null`） */
    windowRemainingSec: number | null;
    commissionedAt: string | null;
}

export interface AdminState {
    version: string;
    uptimeSec: number;
    odelicdReachable: boolean;
    fixtures: AdminFixture[];
    commissioning: AdminCommissioning;
}

export interface AdminSettings {
    nightBandPercent: number;
    colorTempMinKelvin: number;
    colorTempMaxKelvin: number;
    colorTempInverted: boolean;
    statusRefreshSec: number;
    waitMs: number;
    debounceMs: number;
    coalesceAll: boolean;
}
