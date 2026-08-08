/*
 * OdelicCrypto.h — ODELIC / Pairlink メッシュの暗号処理。
 *
 * 根拠: docs/02-protocol.md C21-2 / C22 / C23。libnative-lib.so の逆アセンブルから
 *       完全に再現され、実機 HCI ログとバイト単位で一致することが確認されている。
 *
 *   鍵 = HOMEID とパスワードを 1 バイトずつ交互に並べ、後半 8 バイトに固定文字列。
 *     LOGINKEY … PERIPHERAL_LOGIN の復号とログイン応答の暗号化
 *     EVENTKEY … 器具からのデータ応答（PDU タイプ 0x06）の暗号化/復号
 *
 * AES は標準の AES-128-ECB（ESP32 の mbedtls を使用）。
 */
#pragma once
#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

namespace odelic {

// 鍵長は AES-128 なので 16 バイト固定。
static const size_t KEY_LEN = 16;

// HOMEID(4) + パスワード(4) から LOGINKEY / EVENTKEY を作る（C21-2）。
void makeKeys(const uint8_t homeid[4], const uint8_t password[4],
              uint8_t loginKey[16], uint8_t eventKey[16]);

// AES-128-ECB。len は 16 の倍数。in と out は重なっていてもよい。
void aesEcbEncrypt(const uint8_t key[16], const uint8_t* in, uint8_t* out, size_t len);
void aesEcbDecrypt(const uint8_t key[16], const uint8_t* in, uint8_t* out, size_t len);

// PERIPHERAL_LOGIN（`01 19` の後ろ 16 バイト）を LOGINKEY で復号し、
// HOMEID を照合したうえで XOR ホワイトニング鍵（4 バイト）を取り出す（C23-1）。
//   復号結果 = [HOMEID 4][linkKey 4][PKCS#7 08×8]
// homeid が一致すれば true を返し linkKey に 4 バイトを書く。長さ違い/不一致は false。
bool parseLogin(const uint8_t loginKey[16], const uint8_t homeid[4],
                const uint8_t body[16], uint8_t linkKey[4]);

// PERIPHERAL_LOGIN への応答 PDU を作る（C23-2）。out は 18 バイト。
//   02 19 + AES_ECB_encrypt(LOGINKEY, HOMEID(4) + パスワード(4) + linkKey(4) + 04×4)
void makeLoginResponse(const uint8_t loginKey[16], const uint8_t homeid[4],
                       const uint8_t password[4], const uint8_t linkKey[4],
                       uint8_t out[18]);

// 器具からの暗号化 PDU（タイプ 0x06）を平文 PDU（タイプ 0x03）に戻す（C23-3）。
//   1. ヘッダ 6 バイトはそのまま。raw[6..] を linkKey で XOR（周期 4）
//   2. AES_ECB_decrypt(EVENTKEY, raw[6..])
//   3. 復号結果の最終バイト = PKCS#7 パディング長（1〜16 でなければ復号失敗）
//   4. 平文 = 0x03 + raw[1..5] + 本体（パディング除去）
// 成功なら平文の長さを返し out に書く。失敗なら -1。out は rawLen バイトあれば足りる。
int decryptPdu(const uint8_t* raw, size_t rawLen, const uint8_t eventKey[16],
               const uint8_t linkKey[4], uint8_t* out, size_t outCap);

// 平文 PDU（タイプ 0x03）を暗号化 PDU（タイプ 0x06）にする（C23-5）。復号の逆順。
//   1. 本体 = pdu[6..] に PKCS#7（16 の倍数。既に倍数なら 0x10 を 16 個）
//   2. AES_ECB_encrypt(EVENTKEY, 本体)
//   3. linkKey（周期 4）で XOR ホワイトニング
//   4. 0x06 + pdu[1..5] + それ
// 成功なら暗号化 PDU の長さを返す。out は pdu の長さ + 16 あれば足りる。
int encryptPdu(const uint8_t* pdu, size_t pduLen, const uint8_t eventKey[16],
               const uint8_t linkKey[4], uint8_t* out, size_t outCap);

}  // namespace odelic
