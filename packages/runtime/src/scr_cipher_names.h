/* crypto.getCiphers() on Node 24.22 (OpenSSL 3.5), the names a cipher
 * option can give. The cipher and pki units each include it: names
 * without an implementation there throw a coded SC2020 error instead of
 * Node's ERR_CRYPTO_UNKNOWN_CIPHER. */
#ifndef SCR_CIPHER_NAMES_H
#define SCR_CIPHER_NAMES_H

#define SCR_CIPHER_KNOWN_NAMES \
  "aes-128-cbc", "aes-128-cbc-cts", "aes-128-ccm", "aes-128-cfb", "aes-128-cfb1", "aes-128-cfb8", \
  "aes-128-ctr", "aes-128-ecb", "aes-128-gcm", "aes-128-gcm-siv", "aes-128-ocb", "aes-128-ofb", \
  "aes-128-siv", "aes-128-wrap", "aes-128-wrap-inv", "aes-128-wrap-pad", "aes-128-wrap-pad-inv", \
  "aes-128-xts", "aes-192-cbc", "aes-192-cbc-cts", "aes-192-ccm", "aes-192-cfb", "aes-192-cfb1", \
  "aes-192-cfb8", "aes-192-ctr", "aes-192-ecb", "aes-192-gcm", "aes-192-gcm-siv", "aes-192-ocb", \
  "aes-192-ofb", "aes-192-siv", "aes-192-wrap", "aes-192-wrap-inv", "aes-192-wrap-pad", \
  "aes-192-wrap-pad-inv", "aes-256-cbc", "aes-256-cbc-cts", "aes-256-ccm", "aes-256-cfb", \
  "aes-256-cfb1", "aes-256-cfb8", "aes-256-ctr", "aes-256-ecb", "aes-256-gcm", "aes-256-gcm-siv", \
  "aes-256-ocb", "aes-256-ofb", "aes-256-siv", "aes-256-wrap", "aes-256-wrap-inv", \
  "aes-256-wrap-pad", "aes-256-wrap-pad-inv", "aes-256-xts", "aes128", "aes128-wrap", \
  "aes128-wrap-inv", "aes128-wrap-pad", "aes128-wrap-pad-inv", "aes192", "aes192-wrap", \
  "aes192-wrap-inv", "aes192-wrap-pad", "aes192-wrap-pad-inv", "aes256", "aes256-wrap", \
  "aes256-wrap-inv", "aes256-wrap-pad", "aes256-wrap-pad-inv", "aria-128-cbc", "aria-128-ccm", \
  "aria-128-cfb", "aria-128-cfb1", "aria-128-cfb8", "aria-128-ctr", "aria-128-ecb", "aria-128-gcm", \
  "aria-128-ofb", "aria-192-cbc", "aria-192-ccm", "aria-192-cfb", "aria-192-cfb1", "aria-192-cfb8", \
  "aria-192-ctr", "aria-192-ecb", "aria-192-gcm", "aria-192-ofb", "aria-256-cbc", "aria-256-ccm", \
  "aria-256-cfb", "aria-256-cfb1", "aria-256-cfb8", "aria-256-ctr", "aria-256-ecb", "aria-256-gcm", \
  "aria-256-ofb", "aria128", "aria192", "aria256", "camellia-128-cbc", "camellia-128-cbc-cts", \
  "camellia-128-cfb", "camellia-128-cfb1", "camellia-128-cfb8", "camellia-128-ctr", \
  "camellia-128-ecb", "camellia-128-ofb", "camellia-192-cbc", "camellia-192-cbc-cts", \
  "camellia-192-cfb", "camellia-192-cfb1", "camellia-192-cfb8", "camellia-192-ctr", \
  "camellia-192-ecb", "camellia-192-ofb", "camellia-256-cbc", "camellia-256-cbc-cts", \
  "camellia-256-cfb", "camellia-256-cfb1", "camellia-256-cfb8", "camellia-256-ctr", \
  "camellia-256-ecb", "camellia-256-ofb", "camellia128", "camellia192", "camellia256", "chacha20", \
  "chacha20-poly1305", "des-ede", "des-ede-cbc", "des-ede-cfb", "des-ede-ecb", "des-ede-ofb", \
  "des-ede3", "des-ede3-cbc", "des-ede3-cfb", "des-ede3-cfb1", "des-ede3-cfb8", "des-ede3-ecb", \
  "des-ede3-ofb", "des3", "des3-wrap", "id-aes128-ccm", "id-aes128-gcm", "id-aes128-wrap", \
  "id-aes128-wrap-pad", "id-aes192-ccm", "id-aes192-gcm", "id-aes192-wrap", "id-aes192-wrap-pad", \
  "id-aes256-ccm", "id-aes256-gcm", "id-aes256-wrap", "id-aes256-wrap-pad", \
  "id-smime-alg-cms3deswrap", "sm4", "sm4-cbc", "sm4-ccm", "sm4-cfb", "sm4-cfb128", "sm4-ctr", \
  "sm4-ecb", "sm4-gcm", "sm4-ofb", "sm4-ofb128", "sm4-xts",

/* The ciphers OpenSSL 3 keeps in its legacy provider, which Node 24 does
 * not load, with their IV lengths: OpenSSL knows their names, and using
 * them fails with its "unsupported" error. */
#define SCR_CIPHER_LEGACY_ENTRIES \
  {"des", 8}, {"des-cbc", 8}, {"des-ecb", 0}, {"des-cfb", 8}, {"des-cfb1", 8}, {"des-cfb8", 8}, \
  {"des-ofb", 8}, {"desx", 8}, {"desx-cbc", 8}, {"bf", 8}, {"bf-cbc", 8}, {"bf-ecb", 0}, \
  {"bf-cfb", 8}, {"bf-ofb", 8}, {"blowfish", 8}, {"cast", 8}, {"cast-cbc", 8}, {"cast5-cbc", 8}, \
  {"cast5-ecb", 0}, {"cast5-cfb", 8}, {"cast5-ofb", 8}, {"rc2", 8}, {"rc2-cbc", 8}, {"rc2-ecb", 0}, \
  {"rc2-cfb", 8}, {"rc2-ofb", 8}, {"rc2-40-cbc", 8}, {"rc2-64-cbc", 8}, {"rc4", 0}, {"rc4-40", 0}, \
  {"rc4-hmac-md5", 0}, {"seed", 16}, {"seed-cbc", 16}, {"seed-ecb", 0}, {"seed-cfb", 16}, \
  {"seed-ofb", 16}, {"idea", 8}, {"idea-cbc", 8}, {"idea-ecb", 0}, {"idea-cfb", 8}, {"idea-ofb", 8},

/* The OID texts OpenSSL's providers register as cipher aliases, with the
 * name each fetches (crypto.getCipherInfo(oid).name on Node 24.22). */
#define SCR_CIPHER_OID_ALIASES \
  {"2.16.840.1.101.3.4.1.1", "aes-128-ecb"}, {"2.16.840.1.101.3.4.1.2", "aes-128-cbc"}, \
  {"2.16.840.1.101.3.4.1.3", "aes-128-ofb"}, {"2.16.840.1.101.3.4.1.4", "aes-128-cfb"}, \
  {"2.16.840.1.101.3.4.1.5", "id-aes128-wrap"}, {"2.16.840.1.101.3.4.1.6", "id-aes128-gcm"}, \
  {"2.16.840.1.101.3.4.1.7", "id-aes128-ccm"}, {"2.16.840.1.101.3.4.1.8", "id-aes128-wrap-pad"}, \
  {"2.16.840.1.101.3.4.1.21", "aes-192-ecb"}, {"2.16.840.1.101.3.4.1.22", "aes-192-cbc"}, \
  {"2.16.840.1.101.3.4.1.23", "aes-192-ofb"}, {"2.16.840.1.101.3.4.1.24", "aes-192-cfb"}, \
  {"2.16.840.1.101.3.4.1.25", "id-aes192-wrap"}, {"2.16.840.1.101.3.4.1.26", "id-aes192-gcm"}, \
  {"2.16.840.1.101.3.4.1.27", "id-aes192-ccm"}, {"2.16.840.1.101.3.4.1.28", "id-aes192-wrap-pad"}, \
  {"2.16.840.1.101.3.4.1.41", "aes-256-ecb"}, {"2.16.840.1.101.3.4.1.42", "aes-256-cbc"}, \
  {"2.16.840.1.101.3.4.1.43", "aes-256-ofb"}, {"2.16.840.1.101.3.4.1.44", "aes-256-cfb"}, \
  {"2.16.840.1.101.3.4.1.45", "id-aes256-wrap"}, {"2.16.840.1.101.3.4.1.46", "id-aes256-gcm"}, \
  {"2.16.840.1.101.3.4.1.47", "id-aes256-ccm"}, {"2.16.840.1.101.3.4.1.48", "id-aes256-wrap-pad"}, \
  {"1.2.410.200046.1.1.1", "aria-128-ecb"}, {"1.2.410.200046.1.1.2", "aria-128-cbc"}, \
  {"1.2.410.200046.1.1.3", "aria-128-cfb"}, {"1.2.410.200046.1.1.4", "aria-128-ofb"}, \
  {"1.2.410.200046.1.1.5", "aria-128-ctr"}, {"1.2.410.200046.1.1.6", "aria-192-ecb"}, \
  {"1.2.410.200046.1.1.7", "aria-192-cbc"}, {"1.2.410.200046.1.1.8", "aria-192-cfb"}, \
  {"1.2.410.200046.1.1.9", "aria-192-ofb"}, {"1.2.410.200046.1.1.10", "aria-192-ctr"}, \
  {"1.2.410.200046.1.1.11", "aria-256-ecb"}, {"1.2.410.200046.1.1.12", "aria-256-cbc"}, \
  {"1.2.410.200046.1.1.13", "aria-256-cfb"}, {"1.2.410.200046.1.1.14", "aria-256-ofb"}, \
  {"1.2.410.200046.1.1.15", "aria-256-ctr"}, {"1.2.410.200046.1.1.34", "aria-128-gcm"}, \
  {"1.2.410.200046.1.1.35", "aria-192-gcm"}, {"1.2.410.200046.1.1.36", "aria-256-gcm"}, \
  {"1.2.410.200046.1.1.37", "aria-128-ccm"}, {"1.2.410.200046.1.1.38", "aria-192-ccm"}, \
  {"1.2.410.200046.1.1.39", "aria-256-ccm"}, {"0.3.4401.5.3.1.9.1", "camellia-128-ecb"}, \
  {"0.3.4401.5.3.1.9.3", "camellia-128-ofb"}, {"0.3.4401.5.3.1.9.4", "camellia-128-cfb"}, \
  {"0.3.4401.5.3.1.9.9", "camellia-128-ctr"}, {"0.3.4401.5.3.1.9.21", "camellia-192-ecb"}, \
  {"0.3.4401.5.3.1.9.23", "camellia-192-ofb"}, {"0.3.4401.5.3.1.9.24", "camellia-192-cfb"}, \
  {"0.3.4401.5.3.1.9.29", "camellia-192-ctr"}, {"0.3.4401.5.3.1.9.41", "camellia-256-ecb"}, \
  {"0.3.4401.5.3.1.9.43", "camellia-256-ofb"}, {"0.3.4401.5.3.1.9.44", "camellia-256-cfb"}, \
  {"0.3.4401.5.3.1.9.49", "camellia-256-ctr"}, {"1.2.156.10197.1.104.1", "sm4-ecb"}, \
  {"1.2.156.10197.1.104.2", "sm4-cbc"}, {"1.2.156.10197.1.104.3", "sm4-ofb"}, \
  {"1.2.156.10197.1.104.4", "sm4-cfb"}, {"1.2.156.10197.1.104.7", "sm4-ctr"}, \
  {"1.2.156.10197.1.104.8", "sm4-gcm"}, {"1.2.156.10197.1.104.9", "sm4-ccm"}, \
  {"1.2.156.10197.1.104.10", "sm4-xts"}, {"1.2.392.200011.61.1.1.1.2", "camellia-128-cbc"}, \
  {"1.2.392.200011.61.1.1.1.3", "camellia-192-cbc"}, \
  {"1.2.392.200011.61.1.1.1.4", "camellia-256-cbc"}, {"1.2.840.113549.3.2", "rc2-cbc"}, \
  {"1.2.840.113549.3.4", "rc4"}, {"1.2.840.113549.3.7", "des-ede3-cbc"}, \
  {"1.2.840.113549.1.9.16.3.6", "id-smime-alg-cms3deswrap"}, {"1.3.14.3.2.6", "des-ecb"}, \
  {"1.3.14.3.2.7", "des-cbc"}, {"1.3.14.3.2.8", "des-ofb"}, {"1.3.14.3.2.9", "des-cfb"}, \
  {"1.3.14.3.2.17", "des-ede"}, {"1.3.111.2.1619.0.1.1", "aes-128-xts"}, \
  {"1.3.111.2.1619.0.1.2", "aes-256-xts"}, {"1.3.6.1.4.1.3029.1.2", "bf-cbc"}, \
  {"1.3.6.1.4.1.188.7.1.1.2", "idea-cbc"}, {"1.2.410.200004.1.3", "seed-ecb"}, \
  {"1.2.410.200004.1.4", "seed-cbc"}, {"1.2.410.200004.1.5", "seed-cfb"}, \
  {"1.2.410.200004.1.6", "seed-ofb"}, {"1.2.840.113533.7.66.10", "cast5-cbc"},

#endif
