/* The key and signature core of scr_pki.c, for the WebCrypto layer
 * (scr_webcrypto_pki.c) and the Ed25519 unit (scr_ed25519.c). Keys are
 * reference-counted RSA keys, EC keys on P-256, P-384, P-521 or secp256k1,
 * or Ed25519 keys. Functions answering NULL or false set no error unless
 * they say so; byte results are +1. */
#ifndef SCR_PKI_H
#define SCR_PKI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct SpKey ScrPkiKey;

/* Throws an error of `kind` (with `code`, or none for NULL) whose message
 * is the printf format's whole output, at any length. */
void scr_pki_throw_fmt(int kind, const char *code, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

/* The Ed25519 arithmetic (scr_ed25519.c), installed at startup in
 * programs that name Ed25519; NULL otherwise. Keys are the 32-byte seed
 * and the 32-byte encoded public point. */
typedef struct {
  void (*public_key)(uint8_t pub[32], const uint8_t seed[32]);
  void (*sign)(uint8_t sig[64], const uint8_t seed[32], const uint8_t pub[32], const uint8_t *m, size_t n);
  bool (*verify)(const uint8_t pub[32], const uint8_t *m, size_t n, const uint8_t sig[64]);
} ScrPkiEd25519;
extern const ScrPkiEd25519 *scr_pki_ed25519;

/* Whether the Ed25519 arithmetic is linked; false with a coded SC2020
 * error pending otherwise. */
bool scr_pki_ed25519_ready(void);

ScrPkiKey *scr_pki_key_retain(ScrPkiKey *key);
void scr_pki_key_release(ScrPkiKey *key);
bool scr_pki_key_is_private(const ScrPkiKey *key);
bool scr_pki_key_is_rsa(const ScrPkiKey *key);
bool scr_pki_key_is_ed25519(const ScrPkiKey *key);
/* The EC key's JWK curve name ("P-256", ...), or NULL for RSA keys. */
const char *scr_pki_key_curve(const ScrPkiKey *key);
/* The RSA modulus length in bits. */
size_t scr_pki_key_bits(const ScrPkiKey *key);
/* The RSA public exponent's big-endian bytes, without leading zeros. */
ScrBytes *scr_pki_key_exponent(const ScrPkiKey *key);

/* A key from SubjectPublicKeyInfo (public) or PKCS#8 (private) DER. */
ScrPkiKey *scr_pki_key_parse_der(const uint8_t *der, size_t len, bool private_key);
/* A key from a JWK object (borrowed; a plain object). */
ScrPkiKey *scr_pki_key_from_jwk(const ScrDyn *jwk, bool private_key);
/* A public EC key from an uncompressed or compressed point. */
ScrPkiKey *scr_pki_key_from_point(const char *curve, const uint8_t *point, size_t len);
ScrPkiKey *scr_pki_key_public_of(ScrPkiKey *key);
ScrPkiKey *scr_pki_generate_rsa(unsigned bits, uint64_t exponent);
ScrPkiKey *scr_pki_generate_ec(const char *curve);
/* NULL with a coded SC2020 error pending when the program does not link
 * the Ed25519 unit. */
ScrPkiKey *scr_pki_generate_ed25519(void);
/* A public Ed25519 key from its 32-byte encoding. */
ScrPkiKey *scr_pki_key_from_ed25519_raw(const uint8_t *raw, size_t len);
/* The Ed25519 public key's 32-byte encoding. */
ScrBytes *scr_pki_export_ed25519_raw(ScrPkiKey *key);

/* SubjectPublicKeyInfo (public keys) or PKCS#8 (private keys) DER. */
ScrBytes *scr_pki_export_der(ScrPkiKey *key);
/* The EC public key's uncompressed point. */
ScrBytes *scr_pki_export_point(ScrPkiKey *key);
/* The JWK members in Node's order (kty, n, e, ... or kty, x, y, crv, d),
 * +1. */
ScrDyn *scr_pki_export_jwk(ScrPkiKey *key);

/* Signs `data` with the digest named by its WebCrypto name ("SHA-256"):
 * RSA PKCS#1 v1.5 (pss false), RSA-PSS with `salt` bytes, or ECDSA as
 * IEEE P1363 r || s. Ed25519 keys sign the message itself (hash
 * ignored). */
ScrBytes *scr_pki_sign(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                       size_t len);
bool scr_pki_verify(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                    size_t len, const uint8_t *signature, size_t signature_len);

#endif
