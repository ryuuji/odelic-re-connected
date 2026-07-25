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
 * 代わりに次の 2 つで正直さを保つ（docs/03-instability.md の P4）。
 *
 * 1. 失敗したら属性を**器具の実状態へ引き戻す**（Google Home の表示が元に戻る）
 * 2. 状態が分からない器具は `Reachable = false` にする
 *
 * invoke そのものを失敗させるにはクラスタのコマンドハンドラを個別に上書きする必要があり、
 * `Move` / `Step` の意味論まで自前で持つことになる。まずは上の 2 つで運用する。
 */

import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import { capabilityOf } from "./capability.js";
import {
    type Config,
    colorScaleOf,
    isUnknownMac,
    lightScaleOf,
    normalizeMac,
} from "./config.js";
import { Fixture, type PendingCommand, describeCommand, sameCommand } from "./fixture.js";
import { type CommandOutcome, OdelicClient, type OdelicInfo, type OdelicTarget } from "./odelicd.js";

/** Matter の BasicInformation に出す識別子。⚠️ serialNumber と uniqueId は別の値にする。 */
const BRIDGE_SERIAL = "odelic-matter-bridge";
const BRIDGE_UNIQUE_ID = "odelicmatterbridge01";
export const BRIDGE_VERSION = "0.1.0";
const BRIDGE_SOFTWARE_VERSION = 1;

/** `/metrics` を引く間隔（ポーリング何回ごと）。absent はゆっくり変わる */
const ABSENT_CHECK_EVERY = 10;

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

    constructor(opts: BridgeOptions) {
        this.cfg = opts.config;
        this.log = opts.log ?? (msg => console.log(msg));
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

        await this.server.start();
        this.reportCommissioning();

        this.server.events.commissioning.commissioned.on(() => {
            this.log("★ commissioning 完了。Google Home から操作できます");
        });
        this.server.events.commissioning.decommissioned.on(() => {
            this.log("[!] decommission されました。再度 commissioning が必要です");
            this.reportCommissioning();
        });

        // 最初の 1 回はすぐ、その後は pollMs 間隔。
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
        this.lastInfo = info;

        // ⭐ 通電が切れた器具を拾う。absent は 3 回の取りこぼしで決まるので毎回は要らない
        if (this.pollTick++ % ABSENT_CHECK_EVERY === 0) {
            const absent = await this.client.absentKeys();
            if (absent !== null) {
                for (const key of absent) {
                    if (!this.absent.has(key)) this.log(`[!] 器具 ${key} が応答しません（通電が切れた可能性）`);
                }
                for (const key of this.absent) {
                    if (!absent.has(key)) this.log(`器具 ${key} が復帰しました`);
                }
                this.absent = absent;
            }
        }
        await this.reconcile(info);
        await this.probeIdentityIfNeeded(info);
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
                fixture = new Fixture({
                    mac,
                    name: override.name,
                    capability: cap,
                    scale: lightScaleOf(this.cfg, cap.nightLight),
                    colorScale: colorScaleOf(this.cfg),
                    product: device.product,
                    version: device.version,
                    onDesiredChange: f => this.scheduleFlush(f),
                    log: msg => this.log(msg),
                });
                await this.aggregator.add(fixture.endpoint);
                fixture.subscribe();
                this.fixtures.set(mac, fixture);
                this.log(`＋ Matter に追加: ${fixture.describe()} — ${cap.reason}`);
            }
            // ⭐ 通電が切れている器具は「状態不明」として扱う（P4: 嘘をつかない）
            const alive = info.connected && !this.absent.has(device.key.toUpperCase());
            await fixture.applyFromDevice(device, alive);
        }

        // 見えなくなった器具。すぐ消さず Reachable = false にして猶予を置く
        for (const [mac, fixture] of [...this.fixtures]) {
            if (seen.has(mac)) continue;
            await fixture.setReachable(false);
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
}
