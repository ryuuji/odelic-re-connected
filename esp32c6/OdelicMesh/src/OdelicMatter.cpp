#include "OdelicMatter.h"

namespace odelic {

static int clampi(int v, int lo, int hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static long lroundpos(double x) {
  return (long)(x + 0.5);
}

uint8_t nightDeviceToLevel(int deviceValue) {
  return (uint8_t)clampi(3 - deviceValue, 0, 2);
}

uint8_t nightLevelToDevice(int level) {
  return (uint8_t)clampi(3 - level, 1, 3);
}

int nightBandTop(int nightBandPercent, bool nightLight) {
  int pct = clampi(nightBandPercent, 0, 90);
  if (!nightLight || pct <= 0) return 0;
  int top = (MATTER_LEVEL_MAX * pct) / 100;  // floor
  // 常夜灯 3 段と主灯 20 段のどちらも潰さない範囲に収める。
  return clampi(top, NIGHT_STEPS, MATTER_LEVEL_MAX - MAIN_STEPS);
}

LightTarget matterLevelToTarget(int level, int nightBandPercent, bool nightLight) {
  int lv = clampi(level, MATTER_LEVEL_MIN, MATTER_LEVEL_MAX);
  int top = nightBandTop(nightBandPercent, nightLight);
  LightTarget t{};

  if (lv <= top && top > 0) {
    // 常夜灯の帯を 3 等分。n = 0 が最も暗い。
    int n = clampi((int)( ( (lv * NIGHT_STEPS) + top - 1) / top ) - 1, 0, NIGHT_STEPS - 1);
    t.night = true;
    t.nightLevel = nightDeviceToLevel(n + 1);  // n=0,1,2 → 器具値 1,2,3 → level 2,1,0
    t.bright = 0;
    return t;
  }

  int span = MATTER_LEVEL_MAX - (top + 1);  // 主灯の帯の幅
  int r = span <= 0 ? 0
                    : clampi((int)lroundpos(((double)(lv - (top + 1)) * (MAIN_STEPS - 1)) / span),
                             0, MAIN_STEPS - 1);
  t.night = false;
  t.nightLevel = 0;
  t.bright = (uint8_t)((r + 1) * 5);
  return t;
}

int targetToMatterLevel(const LightTarget& t, int nightBandPercent, bool nightLight) {
  int top = nightBandTop(nightBandPercent, nightLight);

  if (t.night) {
    if (top == 0) return MATTER_LEVEL_MIN;  // 常夜灯非対応の器具に常夜灯状態が来た
    int n = nightLevelToDevice(t.nightLevel) - 1;  // 0..2
    int lo = (n * top) / NIGHT_STEPS + 1;
    int hi = ((n + 1) * top) / NIGHT_STEPS;
    return clampi((lo + hi) / 2, MATTER_LEVEL_MIN, top);
  }

  int bright = clampi(((t.bright + 2) / 5) * 5, 5, 100);
  int r = bright / 5 - 1;  // 0..19
  int span = MATTER_LEVEL_MAX - (top + 1);
  return clampi(top + 1 + (int)lroundpos(((double)r * span) / (MAIN_STEPS - 1)),
                MATTER_LEVEL_MIN, MATTER_LEVEL_MAX);
}

// ------------------------------------------------------------------ 色温度

int kelvinToMireds(int kelvin) {
  if (kelvin <= 0) return 0;
  return (int)lroundpos(1000000.0 / kelvin);
}

static int physMinMireds(int minK, int maxK) {
  return kelvinToMireds(minK > maxK ? minK : maxK);  // 最も高いケルビン
}
static int physMaxMireds(int minK, int maxK) {
  return kelvinToMireds(minK < maxK ? minK : maxK);  // 最も低いケルビン
}

int colorPercentToMireds(int percent, int minKelvin, int maxKelvin) {
  int lo = physMinMireds(minKelvin, maxKelvin);
  int hi = physMaxMireds(minKelvin, maxKelvin);
  int pct = clampi(percent, 0, 100);
  // 既定: 0% = minKelvin = mired 上限側。
  double t = 1.0 - pct / 100.0;
  return clampi((int)lroundpos(lo + t * (hi - lo)), lo, hi);
}

int miredsToColorPercent(int mireds, int minKelvin, int maxKelvin) {
  int lo = physMinMireds(minKelvin, maxKelvin);
  int hi = physMaxMireds(minKelvin, maxKelvin);
  if (hi == lo) return 0;
  int m = clampi(mireds, lo, hi);
  double t = (double)(m - lo) / (hi - lo);
  double pct = (1.0 - t) * 100.0;
  int p = (int)lroundpos(pct / 5.0) * 5;  // ★ 5% 刻みに丸める
  return clampi(p, 0, 100);
}

}  // namespace odelic
