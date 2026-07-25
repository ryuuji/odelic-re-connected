#!/usr/bin/env python3
"""接続中の器具の GATT データベースを列挙して、読めるものだけ読む（非破壊）。

Pi は Peripheral だが、同じ ACL リンク上で GATT クライアントにもなれる。
BlueZ が既にサービス解決済みなので D-Bus から取れる。
"""
import sys

import dbus

BLUEZ = "org.bluez"
OM = "org.freedesktop.DBus.ObjectManager"
PROP = "org.freedesktop.DBus.Properties"

UUID_NAMES = {
    "00002a00": "Device Name",
    "00002a01": "Appearance",
    "00002a04": "Peripheral Preferred Conn Params",
    "00002a05": "Service Changed",
    "00002a19": "Battery Level",
    "00002a23": "System ID",
    "00002a24": "Model Number",
    "00002a25": "Serial Number",
    "00002a26": "Firmware Revision",
    "00002a27": "Hardware Revision",
    "00002a28": "Software Revision",
    "00002a29": "Manufacturer Name",
    "00001800": "Generic Access",
    "00001801": "Generic Attribute",
    "0000180a": "Device Information",
    "0000180f": "Battery Service",
    "0000ffd0": "Pairlink Mesh (FFD0)",
    "0000ffd1": "  → Write (FFD1)",
    "0000ffd2": "  → Notify (FFD2)",
    "0000ff00": "ベンダー独自 FF00",
    "9e5d1e47": "★ Cypress WICED OTA (secure)",
    "ae5d1e47": "★ Cypress WICED OTA",
}


def name_of(uuid: str) -> str:
    return UUID_NAMES.get(uuid[:8].lower(), "")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    bus = dbus.SystemBus()
    objs = dbus.Interface(bus.get_object(BLUEZ, "/"), OM).GetManagedObjects()

    devices = sorted(p for p, i in objs.items() if "org.bluez.Device1" in i)
    for dev in devices:
        di = objs[dev]["org.bluez.Device1"]
        if not di.get("Connected"):
            continue
        print(f"\n===== 器具 {di.get('Address')} "
              f"（{di.get('Name', '名前なし')}）=====")
        print(f"  ServicesResolved={di.get('ServicesResolved')} "
              f"AddressType={di.get('AddressType')}")

        for sp in sorted(p for p in objs if p.startswith(dev + "/service")):
            if "org.bluez.GattService1" not in objs[sp]:
                continue
            su = str(objs[sp]["org.bluez.GattService1"]["UUID"])
            print(f"\n  [Service] {su}  {name_of(su)}")
            for cp in sorted(p for p in objs if p.startswith(sp + "/char")):
                ci = objs[cp].get("org.bluez.GattCharacteristic1")
                if not ci:
                    continue
                cu = str(ci["UUID"])
                flags = ",".join(str(f) for f in ci.get("Flags", []))
                line = f"    {cu}  [{flags}]  {name_of(cu)}"
                val = ""
                if "read" in flags:
                    try:
                        raw = bytes(
                            dbus.Interface(bus.get_object(BLUEZ, cp),
                                           "org.bluez.GattCharacteristic1")
                            .ReadValue({})
                        )
                        txt = "".join(chr(b) if 32 <= b < 127 else "." for b in raw)
                        val = f"\n        値: {raw.hex(' ').upper()}  |{txt}|"
                    except Exception as e:
                        val = f"\n        （読めない: {str(e)[:60]}）"
                print(line + val)
    return 0


if __name__ == "__main__":
    sys.exit(main())
