#!/bin/bash
# libnative-lib.so を dlopen して復号関数を呼ぶための下準備（案 J）。
#
# .so は Android bionic のシンボルを "LIBC" バージョン名で要求する。
# glibc の "GLIBC_2.xx" とは別なので、必要関数を自前実装し "LIBC" バージョン
# ノードを付けたスタブを作って DT_NEEDED の soname すべてに割り当てる。
#
# ⚠️ memcpy 等は自前ループで実装する。glibc の memcpy を呼ぶと、
#    バージョンスクリプトで公開した自分自身に解決されて無限再帰 → segfault する。

set -eu

WORK=/tmp/odelic-decrypt
mkdir -p "$WORK"

cat > "$WORK/stub.c" <<'EOF'
#include <stdarg.h>
typedef unsigned long size_t;

int __android_log_print(int p, const char *t, const char *f, ...) {
    (void)p; (void)t; (void)f; return 0;
}

/* ★ 自前実装。glibc を呼ばない（無限再帰を避ける）*/
void *memcpy(void *d, const void *s, size_t n) {
    unsigned char *a = d; const unsigned char *b = s;
    while (n--) *a++ = *b++;
    return d;
}
void *memset(void *d, int c, size_t n) {
    unsigned char *a = d;
    while (n--) *a++ = (unsigned char)c;
    return d;
}
int memcmp(const void *x, const void *y, size_t n) {
    const unsigned char *a = x, *b = y;
    while (n--) { if (*a != *b) return *a - *b; a++; b++; }
    return 0;
}
/* rand は今回の AES 経路では使われない。決定的な値で十分 */
static unsigned long _seed = 1;
int rand(void) { _seed = _seed * 1103515245 + 12345; return (int)((_seed >> 16) & 0x7fff); }

/* スタックカナリア。TLS レイアウトの差で誤発火しうるので握りつぶす */
void __stack_chk_fail(void) { }
int  __cxa_atexit(void (*f)(void*), void *a, void *d) { (void)f;(void)a;(void)d; return 0; }
void __cxa_finalize(void *d) { (void)d; }
EOF

cat > "$WORK/stub.map" <<'EOF'
LIBC {
  global:
    __android_log_print;
    memcpy; memset; memcmp; rand;
    __stack_chk_fail; __cxa_atexit; __cxa_finalize;
  local: *;
};
EOF

command -v cc >/dev/null || sudo apt-get install -y gcc

# -fno-builtin: コンパイラが memcpy 等を組み込みに置換しないように
cc -shared -fPIC -fno-builtin -Wl,--version-script="$WORK/stub.map" \
   -o "$WORK/libstub.so" "$WORK/stub.c"
echo "スタブ作成（LIBC バージョン付き・自前 mem 実装）"

for name in liblog.so libc.so libm.so libdl.so; do
    ln -sf "$WORK/libstub.so" "$WORK/$name"
done
for real in /usr/lib/aarch64-linux-gnu/libstdc++.so.6 /lib/aarch64-linux-gnu/libstdc++.so.6; do
    [ -e "$real" ] && ln -sf "$real" "$WORK/libstdc++.so" && break
done

export LD_LIBRARY_PATH="$WORK:${LD_LIBRARY_PATH:-}"
echo "=== decrypt_probe.py 実行 ==="
python3 /tmp/decrypt_probe.py
