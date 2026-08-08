#include "OdelicCrypto.h"

#include <string.h>

#include "mbedtls/aes.h"

namespace odelic {

void makeKeys(const uint8_t homeid[4], const uint8_t password[4],
              uint8_t loginKey[16], uint8_t eventKey[16]) {
  // HOMEID とパスワードを 1 バイトずつ交互に（C21-2）。
  const uint8_t inter[8] = {
      homeid[0], password[0], homeid[1], password[1],
      homeid[2], password[2], homeid[3], password[3],
  };
  memcpy(loginKey, inter, 8);
  memcpy(loginKey + 8, "LOGINKEY", 8);
  memcpy(eventKey, inter, 8);
  memcpy(eventKey + 8, "EVENTKEY", 8);
}

void aesEcbEncrypt(const uint8_t key[16], const uint8_t* in, uint8_t* out, size_t len) {
  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_enc(&ctx, key, 128);
  for (size_t i = 0; i < len; i += 16) {
    mbedtls_aes_crypt_ecb(&ctx, MBEDTLS_AES_ENCRYPT, in + i, out + i);
  }
  mbedtls_aes_free(&ctx);
}

void aesEcbDecrypt(const uint8_t key[16], const uint8_t* in, uint8_t* out, size_t len) {
  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_dec(&ctx, key, 128);
  for (size_t i = 0; i < len; i += 16) {
    mbedtls_aes_crypt_ecb(&ctx, MBEDTLS_AES_DECRYPT, in + i, out + i);
  }
  mbedtls_aes_free(&ctx);
}

bool parseLogin(const uint8_t loginKey[16], const uint8_t homeid[4],
                const uint8_t body[16], uint8_t linkKey[4]) {
  uint8_t pt[16];
  aesEcbDecrypt(loginKey, body, pt, 16);
  if (memcmp(pt, homeid, 4) != 0) return false;  // HOMEID 照合（= 認証）
  memcpy(linkKey, pt + 4, 4);
  return true;
}

void makeLoginResponse(const uint8_t loginKey[16], const uint8_t homeid[4],
                       const uint8_t password[4], const uint8_t linkKey[4],
                       uint8_t out[18]) {
  uint8_t block[16];
  memcpy(block + 0, homeid, 4);
  memcpy(block + 4, password, 4);
  memcpy(block + 8, linkKey, 4);
  memset(block + 12, 0x04, 4);  // PKCS#7（残り 4 バイト）
  out[0] = 0x02;                // RESPONSE
  out[1] = 0x19;                // PERIPHERAL_LOGIN
  aesEcbEncrypt(loginKey, block, out + 2, 16);
}

int decryptPdu(const uint8_t* raw, size_t rawLen, const uint8_t eventKey[16],
               const uint8_t linkKey[4], uint8_t* out, size_t outCap) {
  if (rawLen < 6 + 16 || (rawLen - 6) % 16 != 0) return -1;
  const size_t bodyLen = rawLen - 6;
  uint8_t buf[128];
  if (bodyLen > sizeof(buf)) return -1;
  // XOR ホワイトニング（周期 4）を外してから AES 復号。
  for (size_t i = 0; i < bodyLen; i++) buf[i] = raw[6 + i] ^ linkKey[i % 4];
  uint8_t body[128];
  aesEcbDecrypt(eventKey, buf, body, bodyLen);
  const uint8_t pad = body[bodyLen - 1];
  if (pad == 0 || pad > 0x10 || pad > bodyLen) return -1;  // 復号失敗の判定（C23-3）
  const size_t plainBody = bodyLen - pad;
  const size_t total = 6 + plainBody;
  if (total > outCap) return -1;
  out[0] = 0x03;                 // DATA_EVENT
  memcpy(out + 1, raw + 1, 5);   // dst(4) + channel(1)
  memcpy(out + 6, body, plainBody);
  return (int)total;
}

int encryptPdu(const uint8_t* pdu, size_t pduLen, const uint8_t eventKey[16],
               const uint8_t linkKey[4], uint8_t* out, size_t outCap) {
  if (pduLen < 6) return -1;
  const size_t bodyLen = pduLen - 6;
  const size_t pad = 16 - (bodyLen % 16);  // 0 にはならない（倍数なら 16）
  const size_t padded = bodyLen + pad;
  uint8_t body[128];
  if (padded > sizeof(body)) return -1;
  memcpy(body, pdu + 6, bodyLen);
  memset(body + bodyLen, (int)pad, pad);  // PKCS#7
  uint8_t ct[128];
  aesEcbEncrypt(eventKey, body, ct, padded);
  const size_t total = 6 + padded;
  if (total > outCap) return -1;
  out[0] = 0x06;                 // ENCRYPTED
  memcpy(out + 1, pdu + 1, 5);   // dst(4) + channel(1)
  for (size_t i = 0; i < padded; i++) out[6 + i] = ct[i] ^ linkKey[i % 4];
  return (int)total;
}

}  // namespace odelic
