/* scriptc runtime — node:crypto (scr_lib.c, scr_crypto_async.c) and the
 * WebCrypto HMAC slice (scr_webcrypto.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_CRYPTO_H
#define SCR_CRYPTO_H

#include "scr_lib.h"

/* ── node:crypto (scr_lib.c) ─────────────────────────────────────────
 * Randomness plus the incremental MD5/SHA-1/SHA-256 Hash/Hmac and PBKDF2
 * utility slice. The composed string-producing paths remain fast paths;
 * first-class handles and Buffer results use the same digest core. */
ScrStr *scr_crypto_random_uuid(void);
ScrStr *scr_crypto_random_string(double n, ScrStr *enc); /* +1, or throws */
/* The fused createHash chain and crypto.hash. Strings hash their UTF-8
 * bytes; byte values hash their raw storage. Unknown runtime algorithms
 * preserve each Node API's distinct error message, class, and code. */
ScrStr *scr_crypto_hash_digest_str(ScrStr *alg, ScrStr *data, ScrStr *enc);
ScrStr *scr_crypto_hash_digest_bytes(ScrStr *alg, ScrBytes *data, ScrStr *enc);
typedef struct ScrCryptoHash ScrCryptoHash;
ScrCryptoHash *scr_crypto_hash_new(ScrStr *alg);
ScrDyn *scr_crypto_native(void);
/* The crypto global as a value: scr_crypto_native's object with the Crypto
 * methods (scr_webcrypto_object.c, linked with the webcrypto feature). */
ScrDyn *scr_webcrypto_object(void);
ScrCryptoHash *scr_crypto_hmac_new_str(ScrStr *alg, ScrStr *key);
ScrCryptoHash *scr_crypto_hmac_new_bytes(ScrStr *alg, ScrBytes *key);
ScrCryptoHash *scr_crypto_hash_retain(ScrCryptoHash *h);
void scr_crypto_hash_release(ScrCryptoHash *h);
void *scr_crypto_hash_retain_v(void *p);
void scr_crypto_hash_release_v(void *p);
/* A Hash or Hmac boxed as a checked-dynamic handle (+1; retains h). The
 * emitted to-dyn conversion calls it, and it installs the handle ops on
 * first use, so programs that never box a Hash do not link them. */
ScrDyn *scr_crypto_hash_to_dyn(ScrCryptoHash *h);
ScrCryptoHash *scr_crypto_hash_update_str(ScrCryptoHash *h, ScrStr *data);
ScrCryptoHash *scr_crypto_hash_update_bytes(ScrCryptoHash *h, ScrBytes *data);
ScrCryptoHash *scr_crypto_hash_copy(ScrCryptoHash *h);
ScrStr *scr_crypto_hash_digest_string(ScrCryptoHash *h, ScrStr *enc);
ScrBytes *scr_crypto_hash_digest_buffer(ScrCryptoHash *h);
/* The option and any-value forms of createHash, copy, update, digest and
 * crypto.hash, with Node 24.22's validation and errors. */
ScrCryptoHash *scr_crypto_hash_new_opts(ScrStr *alg, ScrDyn *options);
ScrCryptoHash *scr_crypto_hash_copy_opts(ScrCryptoHash *h, ScrDyn *options);
ScrCryptoHash *scr_crypto_hmac_new_dyn(ScrStr *alg, ScrDyn *key, ScrDyn *options);
ScrCryptoHash *scr_crypto_hash_update_enc(ScrCryptoHash *h, ScrStr *data, ScrStr *enc);
ScrCryptoHash *scr_crypto_hash_update_dyn(ScrCryptoHash *h, ScrDyn *data, ScrDyn *enc);
ScrDyn *scr_crypto_hash_digest_dyn(ScrCryptoHash *h, ScrDyn *enc);
ScrDyn *scr_crypto_hash_oneshot(ScrStr *alg, ScrDyn *input, ScrDyn *options);
bool scr_crypto_timing_safe_equal(ScrBytes *left, ScrBytes *right);
bool scr_crypto_timing_safe_equal_dyn(ScrDyn *left, ScrDyn *right);
ScrBytes *scr_crypto_random_fill(ScrBytes *bytes, double offset, double size);
ScrBytes *scr_crypto_random_fill_rest(ScrBytes *bytes, double offset);
double scr_crypto_random_int(double min, double max);
double scr_crypto_random_int_max(double max);
ScrDyn *scr_crypto_random_fill_sync_dyn(ScrDyn *buf, ScrDyn *offset, ScrDyn *size);
/* crypto.getRandomValues over a view (returned +1) or any value (the
 * value itself, +1); NULL with Node's DOMException pending. */
ScrBytes *scr_crypto_get_random_values(ScrBytes *view);
ScrDyn *scr_crypto_get_random_values_dyn(ScrDyn *value);
double scr_crypto_random_fill_args(ScrBytes *view, bool typed_array, double offset, double size,
                                   int form);
void scr_crypto_random_int_refill(void);
bool scr_crypto_random_int_check(double min, double max, bool min_given, double *range);
bool scr_crypto_random_int_try(double min, double range, double *out);
ScrStr *scr_crypto_random_uuid_opts(ScrDyn *options);
ScrStr *scr_crypto_random_uuid_v7(ScrDyn *options);
/* Hash and Hmac values as streams: the value's Transform (+1, created on
 * first use; scr_stream.c) and the steps it runs (scr_lib.c). */
ScrStream *scr_crypto_hash_stream(ScrCryptoHash *hash);
void *scr_crypto_hash_stream_get(ScrCryptoHash *hash);
void scr_crypto_hash_stream_set(ScrCryptoHash *hash, void *stream, void (*release)(void *),
                                ScrBox *box);
void scr_crypto_hash_stream_detach(void *hash);
void scr_crypto_hash_stream_close(ScrCryptoHash *hash);
bool scr_crypto_hash_stream_usable(const ScrCryptoHash *hash);
bool scr_crypto_hash_is_hmac(const ScrCryptoHash *hash);
void scr_crypto_hash_stream_hold(ScrCryptoHash *hash);
void scr_crypto_hash_stream_unhold(ScrCryptoHash *hash);
ScrStream *scr_crypto_hash_stream_piped(ScrCryptoHash *hash);
bool scr_crypto_hash_stream_write(ScrCryptoHash *hash, ScrBytes *chunk);
ScrBytes *scr_crypto_hash_stream_flush(ScrCryptoHash *hash);
/* Secret KeyObjects (scr_lib.c). */
ScrDyn *scr_crypto_create_secret_key(ScrDyn *key, ScrDyn *encoding);
ScrDyn *scr_crypto_generate_key_sync(ScrDyn *type, ScrDyn *options);
ScrBytes *scr_crypto_key_object_input(ScrDyn *key);
bool scr_crypto_is_key_object(const ScrDyn *value);
/* Throws Node's ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE for a private or public
 * KeyObject used as a secret key. scr_pki.c, which makes those keys,
 * installs it with them, so its messages stay out of other programs. */
extern void (*scr_crypto_reject_asymmetric_secret)(const ScrDyn *key);
const unsigned char *scr_key_object_bytes(const ScrDyn *value, size_t *len);
/* crypto.createCipheriv (decrypt false) and crypto.createDecipheriv
 * (decrypt true) over checked-dynamic arguments (scr_cipher.c, linked
 * with the vendored mbedTLS archive). +1 handle, or NULL with Node's
 * error pending. */
ScrDyn *scr_crypto_cipher_new(bool decrypt, ScrDyn *cipher, ScrDyn *key, ScrDyn *iv, ScrDyn *options);
/* crypto.createECDH(curveName) and ECDH.convertKey(key, curve,
 * inputEncoding, outputEncoding, format) over checked-dynamic arguments
 * (scr_ecdh.c, linked with the vendored mbedTLS archive). +1 ECDH handle
 * or result, or NULL with Node's error pending. */
ScrDyn *scr_crypto_ecdh_new(ScrDyn *curve);
ScrDyn *scr_crypto_ecdh_convert_key(ScrDyn *key, ScrDyn *curve, ScrDyn *in_enc, ScrDyn *out_enc, ScrDyn *format);
/* crypto.createDiffieHellman(sizeOrKey, keyEncoding, generator,
 * generatorEncoding) and crypto.getDiffieHellman(groupName) over
 * checked-dynamic arguments (scr_dh.c, linked with the vendored mbedTLS
 * archive). +1 DiffieHellman or DiffieHellmanGroup handle, or NULL with
 * Node's error pending. */
ScrDyn *scr_crypto_dh_new(ScrDyn *size_or_key, ScrDyn *key_encoding, ScrDyn *generator, ScrDyn *generator_encoding);
ScrDyn *scr_crypto_dh_group_new(ScrDyn *name);
/* crypto.getCipherInfo(nameOrNid, options) (scr_cipher_info.c): the info
 * object or undefined (+1), or NULL with Node's argument error pending. */
ScrDyn *scr_crypto_get_cipher_info(ScrDyn *name_or_nid, ScrDyn *options);
/* crypto.checkPrimeSync, checkPrime, generatePrimeSync and generatePrime
 * (scr_dh.c): checked-dynamic arguments, borrowed; the sync forms answer
 * +1 or NULL with the error pending. The callbacks receive undefined as
 * the error, as Node passes it, or null when `null_error`. */
ScrDyn *scr_crypto_check_prime_sync(ScrDyn *candidate, ScrDyn *options);
void scr_crypto_check_prime_async(ScrDyn *candidate, ScrDyn *options, ScrDyn *callback, bool null_error);
ScrDyn *scr_crypto_generate_prime_sync(ScrDyn *size, ScrDyn *options);
void scr_crypto_generate_prime_async(ScrDyn *size, ScrDyn *options, ScrDyn *callback, bool null_error);
ScrBytes *scr_crypto_pbkdf2(ScrBytes *password, ScrBytes *salt,
                            double iterations, double keylen, ScrStr *digest);
ScrBytes *scr_crypto_pbkdf2_job(ScrBytes *password, ScrBytes *salt, double iterations,
                                double keylen, ScrStr *digest, const char **failure);
ScrBytes *scr_crypto_hkdf_bytes(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                                ScrBytes *info, double keylen);
ScrDyn *scr_crypto_hkdf(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                       ScrBytes *info, double keylen);
ScrBytes *scr_crypto_scrypt(ScrBytes *password, ScrBytes *salt, double keylen, ScrDyn *options);
ScrBytes *scr_crypto_scrypt_derive(ScrBytes *password, ScrBytes *salt, double keylen,
                                  double n, double r, double p, double maxmem);
typedef void (*ScrCryptoBytesFn)(ScrClosure *cb, ScrError *error /* borrowed */, ScrBytes *value /* moves */);
void scr_crypto_defer_bytes(ScrBytes *value /* moves */, ScrError *error /* moves */, ScrClosure *cb /* moves */,
                            ScrCryptoBytesFn fn);
void scr_crypto_defer_dyn(ScrDyn *value /* moves */, ScrError *error /* moves */, ScrClosure *cb /* moves */,
                          ScrCryptoBytesFn fn);
/* randomFill and randomInt with callbacks (scr_crypto_async.c). `form` is
 * randomFill's argument count before the callback. */
void scr_crypto_random_fill_async(ScrBytes *buf, double offset, double size, double form,
                                  ScrClosure *cb, ScrCryptoBytesFn fn);
void scr_crypto_random_fill_async_dyn(ScrDyn *buf, ScrDyn *offset, ScrDyn *size, double form,
                                      ScrClosure *cb, ScrCryptoBytesFn fn);
void scr_crypto_generate_key_async(ScrDyn *type, ScrDyn *options, ScrClosure *cb,
                                   ScrCryptoBytesFn fn);
typedef void (*ScrCryptoIntFn)(ScrClosure *cb, double value);
void scr_crypto_random_int_async(double min, double max, double min_given, ScrClosure *cb,
                                 ScrCryptoIntFn fn);
void scr_crypto_random_bytes_async(double size, ScrClosure *cb /* moves */,
                                   ScrCryptoBytesFn fn);
void scr_crypto_pbkdf2_async(ScrBytes *password, ScrBytes *salt,
                             double iterations, double keylen, ScrStr *digest,
                             ScrClosure *cb /* moves */, ScrCryptoBytesFn fn);
void scr_crypto_hkdf_async(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                           ScrBytes *info, double keylen, ScrClosure *cb, ScrCryptoBytesFn fn);
void scr_crypto_scrypt_async(ScrBytes *password, ScrBytes *salt, double keylen,
                             ScrDyn *options, ScrClosure *cb, ScrCryptoBytesFn fn);
/* util.promisify over the callback forms: scr_crypto_promise_callback
 * returns a callback closure (+1) that owns the promise, and the settle
 * adapters fulfill it with the value as a Buffer or view (_bytes), a
 * checked-dynamic Buffer, view or ArrayBuffer, a checked-dynamic value
 * (_dyn), or a number, or reject it with the callback's error. After the
 * callback form returns, scr_crypto_promise_reject_thrown moves a pending
 * argument error into the promise as its rejection. */
typedef struct ScrPromise ScrPromise;
ScrClosure *scr_crypto_promise_callback(ScrPromise *promise);
void scr_crypto_promise_reject_thrown(ScrPromise *promise);
void scr_crypto_promise_settle_bytes(ScrClosure *cb, ScrError *error, ScrBytes *value);
void scr_crypto_promise_settle_buffer_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value);
void scr_crypto_promise_settle_view_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value);
void scr_crypto_promise_settle_array_buffer(ScrClosure *cb, ScrError *error, ScrBytes *value);
void scr_crypto_promise_settle_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value);
void scr_crypto_promise_settle_number(ScrClosure *cb, double value);
void scr_crypto_promise_settle_number_dyn(ScrClosure *cb, double value);

/* The digest primitives beyond MD5/SHA-1/SHA-2 (scr_hash.c). Each final
 * reads a copy of its context. */
typedef struct ScrKeccakCtx {
  uint64_t s[25];
  unsigned char buf[200];
  size_t rate; /* bytes absorbed per permutation */
  size_t len;  /* buffered bytes */
  unsigned char pad; /* domain bits: 0x06 SHA-3, 0x01 Keccak, 0x1f SHAKE, 0x04 KECCAK-KMAC */
} ScrKeccakCtx;
void scr_keccak_init(ScrKeccakCtx *ctx, size_t rate, unsigned char pad);
void scr_keccak_update(ScrKeccakCtx *ctx, const unsigned char *data, size_t len);
void scr_keccak_final(const ScrKeccakCtx *ctx, unsigned char *out, size_t len);
typedef struct ScrRipemd160Ctx {
  uint32_t h[5];
  uint64_t bytes;
  unsigned char buf[64];
  size_t len;
} ScrRipemd160Ctx;
void scr_ripemd160_init(ScrRipemd160Ctx *ctx);
void scr_ripemd160_update(ScrRipemd160Ctx *ctx, const unsigned char *data, size_t len);
void scr_ripemd160_final(const ScrRipemd160Ctx *ctx, unsigned char out[20]);
typedef struct ScrBlake2bCtx {
  uint64_t h[8];
  uint64_t t[2];
  unsigned char buf[128];
  size_t len;
} ScrBlake2bCtx;
void scr_blake2b_init(ScrBlake2bCtx *ctx);
void scr_blake2b_update(ScrBlake2bCtx *ctx, const unsigned char *data, size_t len);
void scr_blake2b_final(const ScrBlake2bCtx *ctx, unsigned char out[64]);
typedef struct ScrBlake2sCtx {
  uint32_t h[8];
  uint32_t t[2];
  unsigned char buf[64];
  size_t len;
} ScrBlake2sCtx;
void scr_blake2s_init(ScrBlake2sCtx *ctx);
void scr_blake2s_update(ScrBlake2sCtx *ctx, const unsigned char *data, size_t len);
void scr_blake2s_final(const ScrBlake2sCtx *ctx, unsigned char out[32]);
typedef struct ScrSm3Ctx {
  uint32_t h[8];
  uint64_t bytes;
  unsigned char buf[64];
  size_t len;
} ScrSm3Ctx;
void scr_sm3_init(ScrSm3Ctx *ctx);
void scr_sm3_update(ScrSm3Ctx *ctx, const unsigned char *data, size_t len);
void scr_sm3_final(const ScrSm3Ctx *ctx, unsigned char out[32]);

size_t scr_crypto_digest_raw(const char *alg, const unsigned char *data, size_t len,
                             unsigned char out[64]);
size_t scr_crypto_hmac_raw(const char *alg, const unsigned char *key, size_t keylen,
                           const unsigned char *data, size_t len, unsigned char out[64]);
/* ── WebCrypto (scr_webcrypto.c) ─────────────────────────────────────
 * crypto.subtle.importKey (HMAC, AES, PBKDF2 and HKDF keys, raw and jwk),
 * generateKey and exportKey (HMAC and AES keys), sign and verify (HMAC)
 * and digest (SHA-1/SHA-2) over node:crypto's digest core. Each takes the
 * call's argument vector as one dyn array (borrowed) and answers a +1
 * promise that every argument or validation failure rejects with Node's
 * TypeError or DOMException; algorithms and formats outside the slice
 * reject with a coded SC2020 Error. importKey and exportKey settle at
 * once with a CryptoKey handle, an ArrayBuffer or a JWK object;
 * generateKey fulfills with a CryptoKey, sign and digest with an
 * ArrayBuffer and verify with a boolean on a later loop turn.
 * scr_webcrypto_is_crypto_key answers `value instanceof CryptoKey`. */
ScrPromise *scr_webcrypto_import_key(ScrDyn *args);
ScrPromise *scr_webcrypto_generate_key(ScrDyn *args);
ScrPromise *scr_webcrypto_export_key(ScrDyn *args);
ScrPromise *scr_webcrypto_sign(ScrDyn *args);
ScrPromise *scr_webcrypto_verify(ScrDyn *args);
ScrPromise *scr_webcrypto_digest(ScrDyn *args);
/* encrypt and decrypt (scr_webcrypto_aes.c, linked with the cipher
 * feature's mbedTLS archive) run scr_webcrypto_cipher with the AES cipher
 * as `aes`, which answers the +1 output bytes or NULL when the operation
 * fails. encrypt and decrypt fulfill with an ArrayBuffer, or reject with
 * a job failure, on a later loop turn. */
typedef struct {
  const unsigned char *iv; /* the IV, or the CTR counter block */
  size_t iv_len;
  const unsigned char *aad;
  size_t aad_len;
  size_t tag_len; /* bytes */
  unsigned counter_bits;
} ScrWebCryptoAesParams;
typedef ScrBytes *(*ScrWebCryptoAesFn)(const char *name, bool decrypt, const unsigned char *key,
                                       size_t key_len, const ScrWebCryptoAesParams *params,
                                       const unsigned char *in, size_t len);
ScrPromise *scr_webcrypto_cipher(ScrDyn *args, bool decrypt, ScrWebCryptoAesFn aes);
ScrPromise *scr_webcrypto_encrypt(ScrDyn *args);
ScrPromise *scr_webcrypto_decrypt(ScrDyn *args);
/* wrapKey and unwrapKey run the same way (AES-KW wrapping, or the AES
 * ciphers): wrapKey fulfills with an ArrayBuffer and unwrapKey with a
 * CryptoKey on a later loop turn. */
ScrPromise *scr_webcrypto_wrap(ScrDyn *args, ScrWebCryptoAesFn aes);
ScrPromise *scr_webcrypto_unwrap(ScrDyn *args, ScrWebCryptoAesFn aes);
ScrPromise *scr_webcrypto_wrap_key(ScrDyn *args);
ScrPromise *scr_webcrypto_unwrap_key(ScrDyn *args);
/* deriveBits and deriveKey (PBKDF2 and HKDF) over node:crypto's KDF core:
 * deriveBits fulfills with an ArrayBuffer (at once for a zero length) and
 * deriveKey with a CryptoKey of the derived key type, on a later loop
 * turn. */
ScrPromise *scr_webcrypto_derive_bits(ScrDyn *args);
ScrPromise *scr_webcrypto_derive_key(ScrDyn *args);
bool scr_webcrypto_is_crypto_key(const ScrDyn *value);

/* The composed `new crypto.X509Certificate(data).fingerprint` read (the
 * handle never materializes): the SHA-1 of the DER, uppercase
 * colon-separated — PEM or raw-DER input; anything else throws Node's
 * ERR_OSSL_PEM_NO_START_LINE Error. Borrowed; +1 (may throw). */
ScrStr *scr_crypto_x509_fingerprint(ScrBytes *data);
ScrStr *scr_crypto_x509_fingerprint_str(ScrStr *pem);
/* The Validity window in Node's ASN1_TIME_print shape ("Jul  1 00:00:00
 * 2026 GMT"); same PEM contract as the fingerprint pair. */
ScrStr *scr_crypto_x509_valid_from(ScrBytes *data);
ScrStr *scr_crypto_x509_valid_from_str(ScrStr *pem);
ScrStr *scr_crypto_x509_valid_to(ScrBytes *data);
ScrStr *scr_crypto_x509_valid_to_str(ScrStr *pem);
/* Asymmetric keys and signatures (scr_pki.c, the pki unit). Arguments
 * borrowed; results +1, or NULL with the error pending. */
ScrDyn *scr_crypto_create_private_key(ScrDyn *key);
ScrDyn *scr_crypto_create_public_key(ScrDyn *key);
ScrDyn *scr_crypto_generate_key_pair_sync(ScrDyn *type, ScrDyn *options);
void scr_crypto_generate_key_pair_async(ScrDyn *type, ScrDyn *options, ScrDyn *callback);
ScrDyn *scr_crypto_sign_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key);
ScrDyn *scr_crypto_verify_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature);
/* crypto.diffieHellman(options[, callback]): the shared secret, or undefined
 * with the callback, which receives it in a later macrotask. */
ScrDyn *scr_crypto_diffie_hellman(ScrDyn *options, ScrDyn *callback);
ScrDyn *scr_crypto_create_sign(ScrDyn *algorithm);
ScrDyn *scr_crypto_create_verify(ScrDyn *algorithm);
bool scr_crypto_is_asymmetric_key(const ScrDyn *value);
const char *scr_crypto_asymmetric_key_type(const ScrDyn *value);
/* X509Certificate fields (scr_x509.c): raw decodes the constructor's input (+1 Buffer,
 * or NULL with Node's PEM error pending); the others read that DER
 * (borrowed) and never throw. subjectAltName, infoAccess and
 * signatureAlgorithm answer "" where Node answers undefined. */
ScrBytes *scr_crypto_x509_raw(ScrBytes *data);
ScrBytes *scr_crypto_x509_raw_der(ScrBytes *der);
ScrBytes *scr_crypto_x509_raw_str(ScrStr *pem);
ScrStr *scr_crypto_x509_subject(ScrBytes *der);
ScrStr *scr_crypto_x509_issuer(ScrBytes *der);
ScrStr *scr_crypto_x509_subject_alt_name(ScrBytes *der);
ScrStr *scr_crypto_x509_info_access(ScrBytes *der);
ScrStr *scr_crypto_x509_serial_number(ScrBytes *der);
ScrStr *scr_crypto_x509_fingerprint256(ScrBytes *der);
ScrStr *scr_crypto_x509_fingerprint512(ScrBytes *der);
bool scr_crypto_x509_ca(ScrBytes *der);
ScrStr *scr_crypto_x509_signature_algorithm(ScrBytes *der);
ScrStr *scr_crypto_x509_signature_algorithm_oid(ScrBytes *der);
ScrStr *scr_crypto_x509_pem(ScrBytes *der);
/* X509Certificate methods over the DER (borrowed). checkHost, checkEmail
 * and checkIP answer the matching name ("" for none, Node's undefined) or
 * NULL with Node's argument error pending (scr_x509.c). publicKey, verify
 * and checkPrivateKey read keys (scr_pki.c): publicKey is +1 or NULL, and
 * the two checks answer false with the error pending when they throw. */
ScrStr *scr_crypto_x509_check_host(ScrBytes *der, ScrDyn *name, ScrDyn *options);
ScrStr *scr_crypto_x509_check_email(ScrBytes *der, ScrDyn *email, ScrDyn *options);
ScrStr *scr_crypto_x509_check_ip(ScrBytes *der, ScrDyn *ip, ScrDyn *options);
bool scr_crypto_x509_check_issued(ScrBytes *der, ScrBytes *issuer_der);
ScrDyn *scr_crypto_x509_legacy_object(ScrBytes *der);
ScrDyn *scr_crypto_x509_public_key(ScrBytes *der);
bool scr_crypto_x509_verify(ScrBytes *der, ScrDyn *key);
bool scr_crypto_x509_check_private_key(ScrBytes *der, ScrDyn *key);

#endif /* SCR_CRYPTO_H */
