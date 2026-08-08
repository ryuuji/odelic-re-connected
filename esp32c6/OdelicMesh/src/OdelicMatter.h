/*
 * OdelicMatter.h — Matter の属性値と ODELIC の内部値を相互変換する純関数。
 *
 * 根拠: docs/07-matter.md と matter/src/mapping.ts / common/src/ladder.ts の移植。
 *
 * ⭐ 器具は連続値を持たず「主灯 20 段（5〜100% の 5% 刻み）＋ 常夜灯 3 段」しかない。
 *    常夜灯は主灯の最小値より暗く、両者は排他（点けると主灯が消える・C24-5）。
 *    したがって物理的な明るさは 1 本の連続軸になり、Matter の LevelControl
 *    （CurrentLevel 1〜254）1 本に畳める。軸の下端が常夜灯、その上が主灯。
 */
#pragma once
#include <stdint.h>

namespace odelic {

// Matter LevelControl の値域（仕様どおり 1〜254。0 は無効値）。
static const int MATTER_LEVEL_MIN = 1;
static const int MATTER_LEVEL_MAX = 254;

// 段数（プロトコル由来の事実）。
static const int MAIN_STEPS = 20;   // 主灯 5, 10, … 100%
static const int NIGHT_STEPS = 3;   // 常夜灯 器具値 1/2/3（3 が最も明るい）

// 明るさ軸の 1 点。消灯は OnOff クラスタの仕事なのでここには含めない。
struct LightTarget {
  bool night;        // true = 常夜灯、false = 主灯
  uint8_t nightLevel;  // 常夜灯のとき: コマンドの level（0 が最も明るい・0〜2）
  uint8_t bright;      // 主灯のとき: 明るさ %（5〜100、5 刻み）
};

// 器具の常夜灯値（1〜3）→ コマンドの level（0〜2）。C24-6 で反転する。
uint8_t nightDeviceToLevel(int deviceValue);
// コマンドの level（0〜2）→ 器具値（3〜1）。
uint8_t nightLevelToDevice(int level);

// 常夜灯に割り当てる Matter level の上限。nightLight=false なら 0（軸全体が主灯）。
int nightBandTop(int nightBandPercent, bool nightLight);

// Matter の CurrentLevel（1〜254）を実際に送る指示へ落とす。
LightTarget matterLevelToTarget(int level, int nightBandPercent = 30, bool nightLight = true);
// 指示を Matter の CurrentLevel に戻す（常夜灯は帯の中央を返す）。
int targetToMatterLevel(const LightTarget& t, int nightBandPercent = 30, bool nightLight = true);

// ------------------------------------------------------------------ 色温度

// ケルビン ⇄ mired（ミレッド = 100 万 / ケルビン）。
int kelvinToMireds(int kelvin);

// ODELIC の color（0〜100%）→ Matter の ColorTemperatureMireds。
// 既定: 0% = minKelvin（電球色 2700K）= mired 上限側 / 100% = maxKelvin（6500K）。
int colorPercentToMireds(int percent, int minKelvin = 2700, int maxKelvin = 6500);
// Matter の mired → ODELIC の color（0〜100%）。★ 5% 刻みに丸める（器具は 21 段）。
int miredsToColorPercent(int mireds, int minKelvin = 2700, int maxKelvin = 6500);

}  // namespace odelic
