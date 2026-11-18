/* Shared-backed spkac inputs. A worker-enabled binary may be handed a
 * Certificate call whose spkac argument is a view of SharedArrayBuffer
 * storage, which another thread can rewrite while the method parses it, so
 * each of the three SPKAC methods takes a local snapshot before parsing
 * (SCR_BYTES_SNAPSHOT). The method owns one reference to the argument it
 * received, and the snapshot's cleanup owns the copy: releasing the working
 * variable after the macro rebound it to the copy frees the copy twice and
 * leaks the argument's reference. Built with ASan and the RC audit, which
 * report the second free and the leak. */
#undef NDEBUG
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "../src/scr_pki.c"

#ifdef SCR_RC_AUDIT
long scr_bytes_live_count(void);
#endif

/* A 2048-bit RSA spkac signing md5WithRSA, its challenge
 * "this-is-a-challenge". */
static const char SPKAC[] =
    "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE3RoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";

static const char CHALLENGE[] = "this-is-a-challenge";

/* The bytes `text` as SharedArrayBuffer storage, as the argument
 * normalization of a shared view produces. */
static ScrBytes *shared_bytes(const char *text, size_t len) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len) memcpy(bytes->data, text, len);
  scr_bytes_make_shared(bytes);
  return bytes;
}

/* A shared-backed argument value, holding the only reference to the
 * storage owner. */
static ScrDyn *shared_argument(const char *text, size_t len) {
  ScrBytes *base = shared_bytes(text, len);
  ScrDyn *value = scr_dyn_new_bytes(base);
  scr_bytes_release(base);
  return value;
}

int main(void) {
  ScrDyn *encoding = scr_dyn_undefined();
#ifdef SCR_RC_AUDIT
  long before = scr_bytes_live_count();
#endif

  ScrDyn *spkac = shared_argument(SPKAC, sizeof SPKAC - 1);
  assert(scr_crypto_spkac_verify(spkac, encoding));
  ScrBytes *challenge = scr_crypto_spkac_challenge(spkac, encoding);
  assert(challenge && challenge->len == sizeof CHALLENGE - 1 &&
         memcmp(challenge->data, CHALLENGE, sizeof CHALLENGE - 1) == 0);
  scr_bytes_release(challenge);
  ScrBytes *key = scr_crypto_spkac_public_key(spkac, encoding);
  static const char pem_head[] = "-----BEGIN PUBLIC KEY-----";
  assert(key && key->len > sizeof pem_head - 1 &&
         memcmp(key->data, pem_head, sizeof pem_head - 1) == 0);
  scr_bytes_release(key);

  /* Text no decoder accepts takes the same snapshot and the same release. */
  ScrDyn *garbage = shared_argument("not*base64!", 11);
  assert(!scr_crypto_spkac_verify(garbage, encoding));
  ScrBytes *empty = scr_crypto_spkac_challenge(garbage, encoding);
  assert(empty && empty->len == 0);
  scr_bytes_release(empty);
  ScrBytes *empty_key = scr_crypto_spkac_public_key(garbage, encoding);
  assert(empty_key && empty_key->len == 0);
  scr_bytes_release(empty_key);

  scr_dyn_release(garbage);
  scr_dyn_release(spkac);
#ifdef SCR_RC_AUDIT
  assert(scr_bytes_live_count() == before);
#endif
  printf("spkac shared input checks passed\n");
  return 0;
}
