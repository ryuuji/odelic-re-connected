#!/usr/bin/env python3
"""BlueZ のアドバタイズ登録がどの条件で通るかを機械的に切り分ける。

`Failed to add advertisement: Invalid Parameters (0x0d)` の原因を特定するための
使い捨て診断スクリプト。プロパティの組み合わせを 1 つずつ試して結果を出す。

    sudo python3 adv_probe.py
"""

from __future__ import annotations

import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
LE_ADV_MGR_IFACE = "org.bluez.LEAdvertisingManager1"
LE_ADV_IFACE = "org.bluez.LEAdvertisement1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

# docs/02-protocol.md C17-3 の ADV_PHONE ペイロード
PAYLOAD = bytes([0xC0, 0xFF, 0x05, 0xFF, 0x26, 0x00, 0x00, 0xB8, 0x27, 0xEB, 0xFF, 0x16, 0x47])


def mfg(company: int, payload: bytes):
    return dbus.Dictionary(
        {dbus.UInt16(company): dbus.Array(payload, signature="y")}, signature="qv"
    )


class Adv(dbus.service.Object):
    def __init__(self, bus, index: int, props: dict):
        self.path = f"/jp/calil/probe/adv{index}"
        self.props = props
        super().__init__(bus, self.path)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADV_IFACE:
            raise dbus.exceptions.DBusException("org.bluez.Error.InvalidArguments")
        return self.props

    @dbus.service.method(LE_ADV_IFACE, in_signature="", out_signature="")
    def Release(self):
        pass


def find_adapter(bus) -> str:
    om = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
    for path, ifaces in om.GetManagedObjects().items():
        if LE_ADV_MGR_IFACE in ifaces:
            return path
    raise RuntimeError("LEAdvertisingManager1 を持つアダプタがありません")


CASES = [
    ("1. Type のみ", {"Type": dbus.String("peripheral")}),
    (
        "2. Type + LocalName",
        {"Type": dbus.String("peripheral"), "LocalName": dbus.String("odelic-pi")},
    ),
    (
        "3. Type + MfgData(CompanyID=0x0000)  ★ 本命",
        {"Type": dbus.String("peripheral"), "ManufacturerData": mfg(0x0000, PAYLOAD)},
    ),
    (
        "4. Type + MfgData(CompanyID=0xFFFF)  ← 0x0000 が原因かの切り分け",
        {"Type": dbus.String("peripheral"), "ManufacturerData": mfg(0xFFFF, PAYLOAD)},
    ),
    (
        "5. Type + MfgData(0x0000) + Discoverable",
        {
            "Type": dbus.String("peripheral"),
            "ManufacturerData": mfg(0x0000, PAYLOAD),
            "Discoverable": dbus.Boolean(True),
        },
    ),
    (
        "6. Type + MfgData(0x0000) + Includes=[]",
        {
            "Type": dbus.String("peripheral"),
            "ManufacturerData": mfg(0x0000, PAYLOAD),
            "Includes": dbus.Array([], signature="s"),
        },
    ),
    (
        "7. broadcast + MfgData(0x0000)",
        {"Type": dbus.String("broadcast"), "ManufacturerData": mfg(0x0000, PAYLOAD)},
    ),
    (
        "8. Type + MfgData(0x0000, 3バイトだけ) ← 長さが原因かの切り分け",
        {"Type": dbus.String("peripheral"), "ManufacturerData": mfg(0x0000, PAYLOAD[:3])},
    ),
]


def main() -> int:
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path = find_adapter(bus)
    print(f"アダプタ: {adapter_path}")

    props = dbus.Interface(bus.get_object(BLUEZ, adapter_path), DBUS_PROP_IFACE)
    props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))
    for name in ("Powered", "Connectable", "Discoverable"):
        try:
            print(f"  {name} = {props.Get(ADAPTER_IFACE, name)}")
        except Exception as e:
            print(f"  {name} : 取得できません（{e.__class__.__name__}）")

    mgr = dbus.Interface(bus.get_object(BLUEZ, adapter_path), LE_ADV_MGR_IFACE)
    try:
        print(f"  SupportedInstances = {props.Get(LE_ADV_MGR_IFACE, 'SupportedInstances')}")
        print(f"  ActiveInstances    = {props.Get(LE_ADV_MGR_IFACE, 'ActiveInstances')}")
        inc = props.Get(LE_ADV_MGR_IFACE, "SupportedIncludes")
        print(f"  SupportedIncludes  = {[str(x) for x in inc]}")
    except Exception as e:
        print(f"  マネージャのプロパティ取得に失敗: {e}")

    print()
    loop = GLib.MainLoop()
    results: list[tuple[str, str]] = []
    objs = []

    def run_case(i: int):
        if i >= len(CASES):
            loop.quit()
            return
        label, p = CASES[i]
        adv = Adv(bus, i, p)
        objs.append(adv)

        def ok():
            results.append((label, "✅ 登録成功"))
            try:
                mgr.UnregisterAdvertisement(adv.path)
            except Exception:
                pass
            adv.remove_from_connection()
            GLib.timeout_add(400, lambda: (run_case(i + 1), False)[1])

        def err(e):
            msg = str(e).replace("org.bluez.Error.", "")
            results.append((label, f"❌ {msg}"))
            adv.remove_from_connection()
            GLib.timeout_add(400, lambda: (run_case(i + 1), False)[1])

        mgr.RegisterAdvertisement(adv.path, {}, reply_handler=ok, error_handler=err)

    GLib.timeout_add(200, lambda: (run_case(0), False)[1])
    GLib.timeout_add_seconds(60, lambda: (loop.quit(), False)[1])
    loop.run()

    print("=== 結果 ===")
    for label, res in results:
        print(f"  {res}  {label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
