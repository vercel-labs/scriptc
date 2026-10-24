/* X509Certificate fields (raw, subject, issuer, subjectAltName,
 * infoAccess, serialNumber, fingerprint256, fingerprint512, ca,
 * signatureAlgorithm, signatureAlgorithmOid), linked only into programs
 * that read them (the x509 runtime feature). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Copies of scr_lib.c's PEM front half and DER header reader for the
 * X509Certificate members it keeps, so that unit is unchanged for
 * programs that do not read these fields. */

/* PEM armor → DER (or raw-DER passthrough), the shared front half of
 * every X509Certificate member. On success `*der`/`*der_len` hold the
 * certificate bytes and `*decoded` the malloc'd base64 buffer to free
 * (NULL for raw-DER input); unparseable input throws Node's exact PEM
 * error and answers false with the exception pending. */
static bool scr_x509_der(const uint8_t *in, size_t n, const uint8_t **der, size_t *der_len,
                          uint8_t **decoded) {
  static const char begin[] = "-----BEGIN CERTIFICATE-----";
  static const char end[] = "-----END CERTIFICATE-----";
  *der = NULL;
  *der_len = 0;
  *decoded = NULL;
  /* PEM: base64-decode the armor's body. */
  const uint8_t *b = NULL;
  /* OpenSSL's PEM reader looks for the armor at the start of a line. */
  for (size_t i = 0; i + sizeof begin - 1 <= n; i++) {
    if ((i == 0 || in[i - 1] == '\n') && memcmp(in + i, begin, sizeof begin - 1) == 0) {
      b = in + i + sizeof begin - 1;
      break;
    }
  }
  if (b != NULL) {
    const uint8_t *stop = in + n;
    for (const uint8_t *p = b; p + sizeof end - 1 <= in + n; p++) {
      if (memcmp(p, end, sizeof end - 1) == 0) {
        stop = p;
        break;
      }
    }
    uint8_t *out = malloc(((size_t)(stop - b) / 4 + 1) * 3 + 3);
    if (!out) {
      scr_trap("scriptc: out of memory\n");
    }
    size_t o = 0;
    unsigned acc = 0;
    int have = 0;
    for (const uint8_t *p = b; p < stop; p++) {
      int v;
      uint8_t c = *p;
      if (c >= 'A' && c <= 'Z') v = c - 'A';
      else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
      else if (c >= '0' && c <= '9') v = c - '0' + 52;
      else if (c == '+') v = 62;
      else if (c == '/') v = 63;
      else continue; /* whitespace, '=' */
      acc = (acc << 6) | (unsigned)v;
      if (++have == 4) {
        out[o++] = (uint8_t)(acc >> 16);
        out[o++] = (uint8_t)(acc >> 8);
        out[o++] = (uint8_t)acc;
        acc = 0;
        have = 0;
      }
    }
    if (have == 2) out[o++] = (uint8_t)(acc >> 4);
    else if (have == 3) {
      out[o++] = (uint8_t)(acc >> 10);
      out[o++] = (uint8_t)(acc >> 2);
    }
    *decoded = out;
    *der = out;
    *der_len = o;
    return true;
  }
  if (n > 0 && in[0] == 0x30) {
    /* Raw DER: the certificate SEQUENCE, without bytes after it, as
     * d2i_X509 reads it. */
    *der = in;
    *der_len = n;
    if (n >= 2) {
      size_t len = in[1], head = 2;
      if (len & 0x80) {
        size_t k = len & 0x7f;
        len = 0;
        head = 2 + k;
        for (size_t i = 0; i < k && k <= 4 && head <= n; i++) len = (len << 8) | in[2 + i];
        if (k == 0 || k > 4) head = n + 1;
      }
      if (head <= n && len <= n - head) *der_len = head + len;
    }
    return true;
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR,
                            "error:0480006C:PEM routines::no start line",
                            42, "ERR_OSSL_PEM_NO_START_LINE");
  return false; /* exception pending */
}

/* Reads one DER TL header at p (before end): tag to *tag, content length
 * to *len, and answers the content pointer (NULL on malformed/overlong). */
static const uint8_t *scr_der_tl(const uint8_t *p, const uint8_t *end, uint8_t *tag, size_t *len) {
  if (p == NULL || end - p < 2) return NULL;
  *tag = p[0];
  uint8_t l0 = p[1];
  const uint8_t *content = p + 2;
  size_t l;
  if (l0 < 0x80) {
    l = l0;
  } else {
    size_t nb = l0 & 0x7f;
    if (nb == 0 || nb > sizeof(size_t) || end - content < (ptrdiff_t)nb) return NULL;
    l = 0;
    for (size_t i = 0; i < nb; i++) l = (l << 8) | content[i];
    content += nb;
  }
  if ((size_t)(end - content) < l) return NULL;
  *tag = p[0];
  *len = l;
  return content;
}

/* ── X509Certificate fields over the DER ─────────────────────────────────
 *
 * `raw` decodes the constructor's input once (scr_x509_der); every other
 * field reads those DER bytes. The walks follow RFC 5280's Certificate ::=
 * SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue } and
 * render each value as Node does: names through X509_NAME_print_ex (one
 * attribute per line, RFC 2253 escaping), alternative names and access
 * descriptions through Node's PrintGeneralName, the serial number through
 * BN_bn2hex. A field whose part of the certificate is missing or malformed
 * answers Node's value for an absent part. */

typedef struct {
  char *data;
  size_t len, cap;
} ScrX509Buf;

static void scr_x509_put(ScrX509Buf *b, const void *p, size_t n) {
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap * 2 : 128;
    while (cap < b->len + n) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void scr_x509_puts(ScrX509Buf *b, const char *s) { scr_x509_put(b, s, strlen(s)); }

static void scr_x509_putc(ScrX509Buf *b, char c) { scr_x509_put(b, &c, 1); }

static ScrStr *scr_x509_buf_str(ScrX509Buf *b) {
  ScrStr *s = scr_str_new(b->data ? b->data : "", b->len);
  free(b->data);
  return s;
}

/* The DER of a certificate field's input (raw or the bytes constructor
 * input). */
#define SCR_X509_DER(bytes) \
  ((const uint8_t *)(bytes)->data), ((bytes)->len * scr_bytes_elem_size((bytes)->elem))

typedef struct {
  const uint8_t *tbs, *tbs_end; /* tbsCertificate contents */
  const uint8_t *sig_alg;       /* outer signatureAlgorithm contents */
  size_t sig_alg_len;
  const uint8_t *serial;        /* serialNumber contents */
  size_t serial_len;
  const uint8_t *issuer, *subject; /* Name contents */
  size_t issuer_len, subject_len;
  const uint8_t *validity;      /* Validity contents */
  size_t validity_len;
  const uint8_t *exts;          /* Extensions SEQUENCE contents, or NULL */
  size_t exts_len;
  const uint8_t *spki;          /* SubjectPublicKeyInfo contents, or NULL */
  size_t spki_len;
  const uint8_t *spki_tlv;      /* the whole SubjectPublicKeyInfo DER */
  size_t spki_tlv_len;
} ScrX509Parts;

/* Splits the certificate into the parts the fields read; false when the
 * outer structure does not parse. */
static bool scr_x509_parts(const uint8_t *der, size_t n, ScrX509Parts *out) {
  memset(out, 0, sizeof *out);
  const uint8_t *end = der + n;
  uint8_t tag;
  size_t len;
  const uint8_t *cert = scr_der_tl(der, end, &tag, &len);
  if (!cert || tag != 0x30) return false;
  const uint8_t *cert_end = cert + len;
  const uint8_t *tbs = scr_der_tl(cert, cert_end, &tag, &len);
  if (!tbs || tag != 0x30) return false;
  out->tbs = tbs;
  out->tbs_end = tbs + len;
  const uint8_t *alg = scr_der_tl(tbs + len, cert_end, &tag, &len);
  if (alg && tag == 0x30) {
    out->sig_alg = alg;
    out->sig_alg_len = len;
  }
  const uint8_t *p = tbs;
  const uint8_t *c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (c && tag == 0xA0) { /* [0] version */
    p = c + len;
    c = scr_der_tl(p, out->tbs_end, &tag, &len);
  }
  if (!c || tag != 0x02) return true;
  out->serial = c;
  out->serial_len = len;
  p = c + len;
  /* signature AlgorithmIdentifier */
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c) return true;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->issuer = c;
  out->issuer_len = len;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->validity = c;
  out->validity_len = len;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (!c || tag != 0x30) return true;
  out->subject = c;
  out->subject_len = len;
  p = c + len;
  c = scr_der_tl(p, out->tbs_end, &tag, &len);
  if (c && tag == 0x30) {
    out->spki = c;
    out->spki_len = len;
    out->spki_tlv = p;
    out->spki_tlv_len = (size_t)(c + len - p);
  }
  /* subjectPublicKeyInfo, then the optional [1] [2] unique IDs and [3]
   * extensions */
  while (p < out->tbs_end) {
    c = scr_der_tl(p, out->tbs_end, &tag, &len);
    if (!c) break;
    if (tag == 0xA3) {
      const uint8_t *seq = scr_der_tl(c, c + len, &tag, &len);
      if (seq && tag == 0x30) {
        out->exts = seq;
        out->exts_len = len;
      }
      break;
    }
    p = c + len;
  }
  return true;
}

/* Finds the extension with the DER-encoded OID `oid` (contents only):
 * its extnValue contents, or NULL. */
static const uint8_t *scr_x509_ext(const ScrX509Parts *parts, const uint8_t *oid, size_t oid_len,
                                   size_t *value_len) {
  if (!parts->exts) return NULL;
  const uint8_t *p = parts->exts;
  const uint8_t *end = parts->exts + parts->exts_len;
  uint8_t tag;
  size_t len;
  while (p < end) {
    const uint8_t *ext = scr_der_tl(p, end, &tag, &len);
    if (!ext || tag != 0x30) return NULL;
    const uint8_t *ext_end = ext + len;
    p = ext_end;
    const uint8_t *id = scr_der_tl(ext, ext_end, &tag, &len);
    if (!id || tag != 0x06) continue;
    bool match = len == oid_len && memcmp(id, oid, len) == 0;
    const uint8_t *q = id + len;
    const uint8_t *v = scr_der_tl(q, ext_end, &tag, &len);
    if (v && tag == 0x01) { /* critical */
      q = v + len;
      v = scr_der_tl(q, ext_end, &tag, &len);
    }
    if (match && v && tag == 0x04) {
      *value_len = len;
      return v;
    }
  }
  return NULL;
}

/* An OID's dotted text (OBJ_obj2txt with no_name). */
static void scr_x509_oid_dotted(ScrX509Buf *b, const uint8_t *oid, size_t n) {
  char tmp[24];
  uint64_t v = 0;
  bool first = true;
  for (size_t i = 0; i < n; i++) {
    v = (v << 7) | (oid[i] & 0x7f);
    if (oid[i] & 0x80) continue;
    if (first) {
      unsigned top = v < 40 ? 0 : v < 80 ? 1 : 2;
      snprintf(tmp, sizeof tmp, "%u.%llu", top, (unsigned long long)(v - top * 40));
      first = false;
    } else {
      snprintf(tmp, sizeof tmp, ".%llu", (unsigned long long)v);
    }
    scr_x509_puts(b, tmp);
    v = 0;
  }
}

typedef struct {
  const char *oid; /* dotted */
  const char *name;
} ScrX509OidName;

/* OpenSSL's short names for the attribute types names use (XN_FLAG_FN_SN). */
static const ScrX509OidName scr_x509_attr_names[] = {
    {"2.5.4.3", "CN"},
    {"2.5.4.4", "SN"},
    {"2.5.4.5", "serialNumber"},
    {"2.5.4.6", "C"},
    {"2.5.4.7", "L"},
    {"2.5.4.8", "ST"},
    {"2.5.4.9", "street"},
    {"2.5.4.10", "O"},
    {"2.5.4.11", "OU"},
    {"2.5.4.12", "title"},
    {"2.5.4.13", "description"},
    {"2.5.4.15", "businessCategory"},
    {"2.5.4.16", "postalAddress"},
    {"2.5.4.17", "postalCode"},
    {"2.5.4.18", "postOfficeBox"},
    {"2.5.4.20", "telephoneNumber"},
    {"2.5.4.41", "name"},
    {"2.5.4.42", "GN"},
    {"2.5.4.43", "initials"},
    {"2.5.4.44", "generationQualifier"},
    {"2.5.4.45", "x500UniqueIdentifier"},
    {"2.5.4.46", "dnQualifier"},
    {"2.5.4.65", "pseudonym"},
    {"2.5.4.72", "role"},
    {"2.5.4.97", "organizationIdentifier"},
    {"1.2.840.113549.1.9.1", "emailAddress"},
    {"1.2.840.113549.1.9.2", "unstructuredName"},
    {"0.9.2342.19200300.100.1.1", "UID"},
    {"0.9.2342.19200300.100.1.25", "DC"},
    {"1.3.6.1.4.1.311.60.2.1.1", "jurisdictionL"},
    {"1.3.6.1.4.1.311.60.2.1.2", "jurisdictionST"},
    {"1.3.6.1.4.1.311.60.2.1.3", "jurisdictionC"},
};

/* OpenSSL's long names for the signature algorithms certificates use. */
static const ScrX509OidName scr_x509_sig_names[] = {
    {"1.2.840.113549.1.1.4", "md5WithRSAEncryption"},
    {"1.2.840.113549.1.1.5", "sha1WithRSAEncryption"},
    {"1.2.840.113549.1.1.10", "rsassaPss"},
    {"1.2.840.113549.1.1.11", "sha256WithRSAEncryption"},
    {"1.2.840.113549.1.1.12", "sha384WithRSAEncryption"},
    {"1.2.840.113549.1.1.13", "sha512WithRSAEncryption"},
    {"1.2.840.113549.1.1.14", "sha224WithRSAEncryption"},
    {"1.2.840.10045.4.1", "ecdsa-with-SHA1"},
    {"1.2.840.10045.4.3.1", "ecdsa-with-SHA224"},
    {"1.2.840.10045.4.3.2", "ecdsa-with-SHA256"},
    {"1.2.840.10045.4.3.3", "ecdsa-with-SHA384"},
    {"1.2.840.10045.4.3.4", "ecdsa-with-SHA512"},
    {"1.2.840.10040.4.3", "dsaWithSHA1"},
    {"2.16.840.1.101.3.4.3.1", "dsa_with_SHA224"},
    {"2.16.840.1.101.3.4.3.2", "dsa_with_SHA256"},
    {"1.3.101.112", "ED25519"},
    {"1.3.101.113", "ED448"},
};

/* OpenSSL's long names for the access methods infoAccess prints. */
static const ScrX509OidName scr_x509_access_names[] = {
    {"1.3.6.1.5.5.7.48.1", "OCSP"},
    {"1.3.6.1.5.5.7.48.2", "CA Issuers"},
    {"1.3.6.1.5.5.7.48.3", "AD Time Stamping"},
    {"1.3.6.1.5.5.7.48.5", "CA Repository"},
};

/* Appends the table name of an OID, or its dotted text; answers whether
 * the table named it. */
static bool scr_x509_oid_name(ScrX509Buf *b, const uint8_t *oid, size_t n,
                              const ScrX509OidName *table, size_t count) {
  ScrX509Buf dotted = {0};
  scr_x509_oid_dotted(&dotted, oid, n);
  for (size_t i = 0; i < count; i++) {
    if (strlen(table[i].oid) == dotted.len && memcmp(table[i].oid, dotted.data, dotted.len) == 0) {
      scr_x509_puts(b, table[i].name);
      free(dotted.data);
      return true;
    }
  }
  scr_x509_put(b, dotted.data, dotted.len);
  free(dotted.data);
  return false;
}

/* Appends one code point as UTF-8. */
static void scr_x509_put_utf8(ScrX509Buf *b, uint32_t c) {
  char u[4];
  size_t n;
  if (c < 0x80) {
    u[0] = (char)c;
    n = 1;
  } else if (c < 0x800) {
    u[0] = (char)(0xC0 | (c >> 6));
    u[1] = (char)(0x80 | (c & 0x3F));
    n = 2;
  } else if (c < 0x10000) {
    u[0] = (char)(0xE0 | (c >> 12));
    u[1] = (char)(0x80 | ((c >> 6) & 0x3F));
    u[2] = (char)(0x80 | (c & 0x3F));
    n = 3;
  } else {
    u[0] = (char)(0xF0 | (c >> 18));
    u[1] = (char)(0x80 | ((c >> 12) & 0x3F));
    u[2] = (char)(0x80 | ((c >> 6) & 0x3F));
    u[3] = (char)(0x80 | (c & 0x3F));
    n = 4;
  }
  scr_x509_put(b, u, n);
}

/* An attribute value as UTF-8 bytes (ASN1_STRFLGS_UTF8_CONVERT): a
 * UTF8String as stored, BMPString and UniversalString decoded, every other
 * type read as Latin-1. */
static void scr_x509_value_utf8(ScrX509Buf *out, uint8_t tag, const uint8_t *v, size_t n) {
  if (tag == 0x0C) {
    scr_x509_put(out, v, n);
  } else if (tag == 0x1E) {
    for (size_t i = 0; i + 1 < n; i += 2) scr_x509_put_utf8(out, ((uint32_t)v[i] << 8) | v[i + 1]);
  } else if (tag == 0x1C) {
    for (size_t i = 0; i + 3 < n; i += 4)
      scr_x509_put_utf8(out, ((uint32_t)v[i] << 24) | ((uint32_t)v[i + 1] << 16) |
                                 ((uint32_t)v[i + 2] << 8) | v[i + 3]);
  } else {
    for (size_t i = 0; i < n; i++) scr_x509_put_utf8(out, v[i]);
  }
}

/* Appends a value with ASN1_STRFLGS_ESC_2253 escaping: the characters
 * `"+,;<>\` get a backslash, as do a leading '#' or space and a trailing
 * space; with `esc_ctrl`, control characters print as \XX. Bytes above
 * 0x7f pass through. */
static void scr_x509_put_escaped(ScrX509Buf *b, const uint8_t *s, size_t n, bool esc_ctrl) {
  static const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < n; i++) {
    uint8_t c = s[i];
    bool first = i == 0;
    bool last = i + 1 == n;
    if (c == '"' || c == '+' || c == ',' || c == ';' || c == '<' || c == '>' || c == '\\' ||
        (first && (c == '#' || c == ' ')) || (last && c == ' ')) {
      scr_x509_putc(b, '\\');
      scr_x509_putc(b, (char)c);
    } else if (esc_ctrl && (c < 0x20 || c == 0x7f)) {
      char e[3] = {'\\', hex[c >> 4], hex[c & 0x0f]};
      scr_x509_put(b, e, 3);
    } else {
      scr_x509_putc(b, (char)c);
    }
  }
}

/* Prints a Name. `multiline` is Node's subject/issuer form (attributes in
 * order, one RDN per line, ESC_CTRL); otherwise the RFC 2253 form DirName
 * alternative names use (RDNs reversed and comma-separated, unknown
 * attribute types dumped as #hex of the value's DER). RDNs with several
 * attributes join them with " + " or "+". */
static void scr_x509_name_print(ScrX509Buf *b, const uint8_t *name, size_t n, bool multiline) {
  const uint8_t *end = name + n;
  const uint8_t *rdns[64];
  size_t rdn_lens[64];
  size_t count = 0;
  uint8_t tag;
  size_t len;
  for (const uint8_t *p = name; p < end && count < 64;) {
    const uint8_t *set = scr_der_tl(p, end, &tag, &len);
    if (!set || tag != 0x31) break;
    rdns[count] = set;
    rdn_lens[count++] = len;
    p = set + len;
  }
  for (size_t k = 0; k < count; k++) {
    size_t r = multiline ? k : count - 1 - k;
    if (k > 0) scr_x509_puts(b, multiline ? "\n" : ",");
    const uint8_t *set_end = rdns[r] + rdn_lens[r];
    bool first_attr = true;
    for (const uint8_t *q = rdns[r]; q < set_end;) {
      const uint8_t *atv = scr_der_tl(q, set_end, &tag, &len);
      if (!atv || tag != 0x30) break;
      const uint8_t *atv_end = atv + len;
      q = atv_end;
      const uint8_t *oid = scr_der_tl(atv, atv_end, &tag, &len);
      if (!oid || tag != 0x06) continue;
      size_t oid_len = len;
      const uint8_t *value_tl = oid + len;
      uint8_t vtag;
      size_t vlen;
      const uint8_t *value = scr_der_tl(value_tl, atv_end, &vtag, &vlen);
      if (!value) continue;
      if (!first_attr) scr_x509_puts(b, multiline ? " + " : "+");
      first_attr = false;
      bool known = scr_x509_oid_name(b, oid, oid_len, scr_x509_attr_names,
                                     sizeof scr_x509_attr_names / sizeof scr_x509_attr_names[0]);
      scr_x509_putc(b, '=');
      if (!multiline && !known) {
        static const char hex[] = "0123456789ABCDEF";
        scr_x509_putc(b, '#');
        for (const uint8_t *d = value_tl; d < value + vlen; d++) {
          scr_x509_putc(b, hex[*d >> 4]);
          scr_x509_putc(b, hex[*d & 0x0f]);
        }
        continue;
      }
      ScrX509Buf text = {0};
      scr_x509_value_utf8(&text, vtag, value, vlen);
      scr_x509_put_escaped(b, (const uint8_t *)text.data, text.len, multiline);
      free(text.data);
    }
  }
}

/* Node's PrintAltName: a name with none of `"\,'` and only printable
 * characters (in UTF-8 names, only non-control bytes) prints as is;
 * otherwise it prints as a JSON string, `prefix:` inside the quotes, with
 * `\\`, `\"` and \u00XX for commas, control characters and (outside
 * UTF-8 names) bytes above 0x7e. */
static void scr_x509_put_alt_name(ScrX509Buf *b, const uint8_t *s, size_t n, bool utf8,
                                  const char *prefix) {
  bool safe = true;
  for (size_t i = 0; i < n && safe; i++) {
    uint8_t c = s[i];
    if (c == '"' || c == '\\' || c == ',' || c == '\'') safe = false;
    else if (utf8 ? (c < ' ' || c == 0x7f) : (c < ' ' || c > '~')) safe = false;
  }
  if (safe) {
    if (prefix) {
      scr_x509_puts(b, prefix);
      scr_x509_putc(b, ':');
    }
    scr_x509_put(b, s, n);
    return;
  }
  static const char hex[] = "0123456789abcdef";
  scr_x509_putc(b, '"');
  if (prefix) {
    scr_x509_puts(b, prefix);
    scr_x509_putc(b, ':');
  }
  for (size_t i = 0; i < n; i++) {
    uint8_t c = s[i];
    if (c == '\\') {
      scr_x509_puts(b, "\\\\");
    } else if (c == '"') {
      scr_x509_puts(b, "\\\"");
    } else if ((c >= ' ' && c != ',' && c <= '~') || (utf8 && (c & 0x80))) {
      scr_x509_putc(b, (char)c);
    } else {
      char u[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 0x0f]};
      scr_x509_put(b, u, 6);
    }
  }
  scr_x509_putc(b, '"');
}

static const uint8_t SCR_X509_OID_UPN[] = {0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x14, 0x02, 0x03};
static const uint8_t SCR_X509_OID_XMPP[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x05};
static const uint8_t SCR_X509_OID_SRV[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x07};
static const uint8_t SCR_X509_OID_NAI[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x08};
static const uint8_t SCR_X509_OID_SMTP_UTF8[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x08, 0x09};

/* Node's PrintGeneralName for one GeneralName element (tag and contents). */
static void scr_x509_general_name(ScrX509Buf *b, uint8_t tag, const uint8_t *v, size_t n) {
  switch (tag) {
    case 0x81: /* rfc822Name */
      scr_x509_puts(b, "email:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x82: /* dNSName */
      scr_x509_puts(b, "DNS:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x86: /* uniformResourceIdentifier */
      scr_x509_puts(b, "URI:");
      scr_x509_put_alt_name(b, v, n, false, NULL);
      return;
    case 0x87: { /* iPAddress */
      char tmp[48];
      scr_x509_puts(b, "IP Address:");
      if (n == 4) {
        snprintf(tmp, sizeof tmp, "%d.%d.%d.%d", v[0], v[1], v[2], v[3]);
        scr_x509_puts(b, tmp);
      } else if (n == 16) {
        for (unsigned j = 0; j < 8; j++) {
          snprintf(tmp, sizeof tmp, j == 0 ? "%X" : ":%X", (unsigned)((v[2 * j] << 8) | v[2 * j + 1]));
          scr_x509_puts(b, tmp);
        }
      } else {
        snprintf(tmp, sizeof tmp, "<invalid length=%zu>", n);
        scr_x509_puts(b, tmp);
      }
      return;
    }
    case 0x88: /* registeredID */
      scr_x509_puts(b, "Registered ID:");
      scr_x509_oid_dotted(b, v, n);
      return;
    case 0xA4: { /* directoryName: [4] EXPLICIT Name */
      uint8_t ntag;
      size_t nlen;
      const uint8_t *name = scr_der_tl(v, v + n, &ntag, &nlen);
      ScrX509Buf text = {0};
      if (name && ntag == 0x30) scr_x509_name_print(&text, name, nlen, false);
      scr_x509_puts(b, "DirName:");
      scr_x509_put_alt_name(b, (const uint8_t *)(text.data ? text.data : ""), text.len, true, NULL);
      free(text.data);
      return;
    }
    case 0xA0: { /* otherName: type-id OID, [0] EXPLICIT value */
      uint8_t t;
      size_t len;
      const uint8_t *end = v + n;
      const uint8_t *oid = scr_der_tl(v, end, &t, &len);
      const char *prefix = NULL;
      bool unicode = true;
      if (oid && t == 0x06) {
#define SCR_X509_OID_IS(o) (len == sizeof(o) && memcmp(oid, (o), sizeof(o)) == 0)
        if (SCR_X509_OID_IS(SCR_X509_OID_SMTP_UTF8)) prefix = "SmtpUTF8Mailbox";
        else if (SCR_X509_OID_IS(SCR_X509_OID_XMPP)) prefix = "XmppAddr";
        else if (SCR_X509_OID_IS(SCR_X509_OID_SRV)) {
          prefix = "SRVName";
          unicode = false;
        } else if (SCR_X509_OID_IS(SCR_X509_OID_UPN)) prefix = "UPN";
        else if (SCR_X509_OID_IS(SCR_X509_OID_NAI)) prefix = "NAIRealm";
#undef SCR_X509_OID_IS
      }
      const uint8_t *value = NULL;
      size_t value_len = 0;
      uint8_t vtag = 0;
      if (oid && prefix) {
        const uint8_t *wrap = scr_der_tl(oid + len, end, &t, &len);
        if (wrap && t == 0xA0) value = scr_der_tl(wrap, wrap + len, &vtag, &value_len);
      }
      if (!value || vtag != (unicode ? 0x0C : 0x16)) {
        scr_x509_puts(b, "othername:<unsupported>");
      } else {
        scr_x509_puts(b, "othername:");
        scr_x509_put_alt_name(b, value, value_len, unicode, prefix);
      }
      return;
    }
    case 0xA3:
      scr_x509_puts(b, "X400Name:<unsupported>");
      return;
    case 0xA5:
      scr_x509_puts(b, "EdiPartyName:<unsupported>");
      return;
    default:
      return;
  }
}

/* The DER contents of the TBSCertificate parts, or an empty string when
 * the certificate does not parse. */
static ScrStr *scr_x509_name_field(ScrBytes *der, bool subject) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  if (scr_x509_parts(SCR_X509_DER(der), &parts)) {
    const uint8_t *name = subject ? parts.subject : parts.issuer;
    if (name) scr_x509_name_print(&b, name, subject ? parts.subject_len : parts.issuer_len, true);
  }
  return scr_x509_buf_str(&b);
}

/* new X509Certificate(data).raw: the certificate's DER as a fresh Buffer.
 * Unparseable input throws Node's PEM error (exception pending, NULL). */
static ScrBytes *scr_x509_raw(const uint8_t *in, size_t n) {
  const uint8_t *der;
  size_t der_len;
  uint8_t *decoded;
  if (!scr_x509_der(in, n, &der, &der_len, &decoded)) return NULL;
  ScrBytes *out = scr_buffer_alloc_unsafe_slow((double)der_len);
  memcpy(out->data, der, der_len);
  free(decoded);
  return out;
}

ScrBytes *scr_crypto_x509_raw(ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_x509_raw(SCR_X509_DER(data));
}

/* raw of a certificate whose DER a TLS handshake delivered: a copy, with
 * no search for PEM armor that its extensions could carry. */
ScrBytes *scr_crypto_x509_raw_der(ScrBytes *der) {
  SCR_BYTES_SNAPSHOT(der);
  size_t n = (size_t)scr_bytes_byte_len(der);
  ScrBytes *out = scr_buffer_alloc_unsafe_slow((double)n);
  memcpy(out->data, der->data, n);
  return out;
}

ScrBytes *scr_crypto_x509_raw_str(ScrStr *pem) {
  return scr_x509_raw((const uint8_t *)pem->data, pem->len);
}

ScrStr *scr_crypto_x509_subject(ScrBytes *der) { return scr_x509_name_field(der, true); }

ScrStr *scr_crypto_x509_issuer(ScrBytes *der) { return scr_x509_name_field(der, false); }

static const uint8_t SCR_X509_OID_SAN[] = {0x55, 0x1D, 0x11};
static const uint8_t SCR_X509_OID_BASIC_CONSTRAINTS[] = {0x55, 0x1D, 0x13};
static const uint8_t SCR_X509_OID_KEY_USAGE[] = {0x55, 0x1D, 0x0F};
static const uint8_t SCR_X509_OID_AIA[] = {0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01};

/* subjectAltName: the GeneralNames joined with ", "; an empty string when
 * the certificate has no subjectAltName extension (Node's undefined). */
ScrStr *scr_crypto_x509_subject_alt_name(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  size_t n;
  const uint8_t *ext = scr_x509_parts(SCR_X509_DER(der), &parts)
                           ? scr_x509_ext(&parts, SCR_X509_OID_SAN, sizeof SCR_X509_OID_SAN, &n)
                           : NULL;
  uint8_t tag;
  size_t len;
  const uint8_t *names = ext ? scr_der_tl(ext, ext + n, &tag, &len) : NULL;
  if (names && tag == 0x30) {
    const uint8_t *end = names + len;
    bool first = true;
    for (const uint8_t *p = names; p < end;) {
      const uint8_t *v = scr_der_tl(p, end, &tag, &len);
      if (!v) break;
      if (!first) scr_x509_puts(&b, ", ");
      first = false;
      scr_x509_general_name(&b, tag, v, len);
      p = v + len;
    }
  }
  return scr_x509_buf_str(&b);
}

/* infoAccess: one "<method> - <GeneralName>" line per AccessDescription;
 * an empty string when the extension is absent (Node's undefined). */
ScrStr *scr_crypto_x509_info_access(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  size_t n;
  const uint8_t *ext = scr_x509_parts(SCR_X509_DER(der), &parts)
                           ? scr_x509_ext(&parts, SCR_X509_OID_AIA, sizeof SCR_X509_OID_AIA, &n)
                           : NULL;
  uint8_t tag;
  size_t len;
  const uint8_t *descs = ext ? scr_der_tl(ext, ext + n, &tag, &len) : NULL;
  if (descs && tag == 0x30) {
    const uint8_t *end = descs + len;
    bool first = true;
    for (const uint8_t *p = descs; p < end;) {
      const uint8_t *desc = scr_der_tl(p, end, &tag, &len);
      if (!desc || tag != 0x30) break;
      const uint8_t *desc_end = desc + len;
      p = desc_end;
      const uint8_t *method = scr_der_tl(desc, desc_end, &tag, &len);
      if (!method || tag != 0x06) continue;
      if (!first) scr_x509_putc(&b, '\n');
      first = false;
      scr_x509_oid_name(&b, method, len, scr_x509_access_names,
                        sizeof scr_x509_access_names / sizeof scr_x509_access_names[0]);
      scr_x509_puts(&b, " - ");
      const uint8_t *location = scr_der_tl(method + len, desc_end, &tag, &len);
      if (location) scr_x509_general_name(&b, tag, location, len);
    }
  }
  return scr_x509_buf_str(&b);
}

/* serialNumber: BN_bn2hex of the INTEGER ("0" for zero, whole bytes in
 * uppercase hex without leading zero bytes, '-' before a negative). */
ScrStr *scr_crypto_x509_serial_number(ScrBytes *der) {
  ScrX509Parts parts;
  ScrX509Buf b = {0};
  if (scr_x509_parts(SCR_X509_DER(der), &parts) && parts.serial_len > 0) {
    static const char hex[] = "0123456789ABCDEF";
    size_t n = parts.serial_len;
    uint8_t *mag = malloc(n);
    if (!mag) scr_trap("scriptc: out of memory\n");
    memcpy(mag, parts.serial, n);
    bool neg = (mag[0] & 0x80) != 0;
    if (neg) { /* two's complement magnitude */
      for (size_t i = 0; i < n; i++) mag[i] = (uint8_t)~mag[i];
      for (size_t i = n; i-- > 0;) {
        if (++mag[i] != 0) break;
      }
    }
    size_t i = 0;
    while (i < n && mag[i] == 0) i++;
    if (i == n) {
      scr_x509_putc(&b, '0');
    } else {
      if (neg) scr_x509_putc(&b, '-');
      for (; i < n; i++) {
        scr_x509_putc(&b, hex[mag[i] >> 4]);
        scr_x509_putc(&b, hex[mag[i] & 0x0f]);
      }
    }
    free(mag);
  }
  return scr_x509_buf_str(&b);
}

static ScrStr *scr_x509_fingerprint_alg(ScrBytes *der, const char *alg) {
  unsigned char digest[64];
  size_t dn = scr_crypto_digest_raw(alg, SCR_X509_DER(der), digest);
  static const char hex[] = "0123456789ABCDEF";
  char buf[192];
  size_t o = 0;
  for (size_t i = 0; i < dn; i++) {
    if (i > 0) buf[o++] = ':';
    buf[o++] = hex[digest[i] >> 4];
    buf[o++] = hex[digest[i] & 0x0f];
  }
  return scr_str_new(buf, o);
}

ScrStr *scr_crypto_x509_fingerprint256(ScrBytes *der) {
  return scr_x509_fingerprint_alg(der, "sha256");
}

ScrStr *scr_crypto_x509_fingerprint512(ScrBytes *der) {
  return scr_x509_fingerprint_alg(der, "sha512");
}

/* ca: X509_check_ca() == 1 — basicConstraints with cA TRUE, and a
 * keyUsage extension, when present, that allows keyCertSign. */
bool scr_crypto_x509_ca(ScrBytes *der) {
  ScrX509Parts parts;
  if (!scr_x509_parts(SCR_X509_DER(der), &parts)) return false;
  uint8_t tag;
  size_t len, n;
  const uint8_t *ku = scr_x509_ext(&parts, SCR_X509_OID_KEY_USAGE, sizeof SCR_X509_OID_KEY_USAGE, &n);
  if (ku) {
    const uint8_t *bits = scr_der_tl(ku, ku + n, &tag, &len);
    if (!bits || tag != 0x03 || len < 2 || (bits[1] & 0x04) == 0) return false;
  }
  const uint8_t *bc = scr_x509_ext(&parts, SCR_X509_OID_BASIC_CONSTRAINTS,
                                   sizeof SCR_X509_OID_BASIC_CONSTRAINTS, &n);
  if (!bc) return false;
  const uint8_t *seq = scr_der_tl(bc, bc + n, &tag, &len);
  if (!seq || tag != 0x30) return false;
  const uint8_t *flag = scr_der_tl(seq, seq + len, &tag, &len);
  return flag && tag == 0x01 && len == 1 && flag[0] != 0;
}

/* The signature AlgorithmIdentifier's OID contents, or NULL. */
static const uint8_t *scr_x509_sig_oid(ScrBytes *der, size_t *n) {
  ScrX509Parts parts;
  if (!scr_x509_parts(SCR_X509_DER(der), &parts) || !parts.sig_alg) return NULL;
  uint8_t tag;
  const uint8_t *oid = scr_der_tl(parts.sig_alg, parts.sig_alg + parts.sig_alg_len, &tag, n);
  return oid && tag == 0x06 ? oid : NULL;
}

/* signatureAlgorithm: OpenSSL's long name for the signature algorithm; an
 * empty string for an algorithm OpenSSL does not name (Node's
 * undefined). */
ScrStr *scr_crypto_x509_signature_algorithm(ScrBytes *der) {
  size_t n;
  const uint8_t *oid = scr_x509_sig_oid(der, &n);
  ScrX509Buf b = {0};
  if (oid && !scr_x509_oid_name(&b, oid, n, scr_x509_sig_names,
                                sizeof scr_x509_sig_names / sizeof scr_x509_sig_names[0]))
    b.len = 0;
  return scr_x509_buf_str(&b);
}

/* signatureAlgorithmOid: the signature algorithm's dotted OID. */
ScrStr *scr_crypto_x509_signature_algorithm_oid(ScrBytes *der) {
  size_t n;
  const uint8_t *oid = scr_x509_sig_oid(der, &n);
  ScrX509Buf b = {0};
  if (oid) scr_x509_oid_dotted(&b, oid, n);
  return scr_x509_buf_str(&b);
}

/* toString() and toJSON(): PEM_write_bio_X509's armor over the DER, 64
 * base64 characters a line. */
ScrStr *scr_crypto_x509_pem(ScrBytes *der) {
  static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint8_t *d = (const uint8_t *)der->data;
  size_t n = der->len * scr_bytes_elem_size(der->elem);
  ScrX509Buf b = {0};
  scr_x509_puts(&b, "-----BEGIN CERTIFICATE-----\n");
  size_t col = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)d[i] << 16;
    if (i + 1 < n) v |= (uint32_t)d[i + 1] << 8;
    if (i + 2 < n) v |= d[i + 2];
    char q[4] = {digits[(v >> 18) & 63], digits[(v >> 12) & 63], i + 1 < n ? digits[(v >> 6) & 63] : '=',
                 i + 2 < n ? digits[v & 63] : '='};
    for (int k = 0; k < 4; k++) {
      scr_x509_putc(&b, q[k]);
      if (++col == 64) {
        scr_x509_putc(&b, '\n');
        col = 0;
      }
    }
  }
  if (col) scr_x509_putc(&b, '\n');
  scr_x509_puts(&b, "-----END CERTIFICATE-----\n");
  return scr_x509_buf_str(&b);
}

/* ── checkHost, checkEmail and checkIP ───────────────────────────────── */

/* X509_CHECK_FLAG_* as Node's getFlags sets them. */
enum {
  SCR_X509_ALWAYS_CHECK_SUBJECT = 0x1,
  SCR_X509_NO_WILDCARDS = 0x2,
  SCR_X509_NO_PARTIAL_WILDCARDS = 0x4,
  SCR_X509_MULTI_LABEL_WILDCARDS = 0x8,
  SCR_X509_SINGLE_LABEL_SUBDOMAINS = 0x10,
  SCR_X509_NEVER_CHECK_SUBJECT = 0x20,
};

/* Node's getFlags(options): validateObject, then the subject string and
 * the four booleans, in Node's order. -1 with the error pending. */
static int scr_x509_check_flags(const ScrDyn *options) {
  if (options == NULL || options->kind == SCR_DYN_UNDEF) return 0;
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize((ScrDyn *)options);
    if (!value) return -1;
    int flags = scr_x509_check_flags(value);
    scr_dyn_release(value);
    return flags;
  }
  if (options->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return -1;
  }
  const ScrDyn *subject = scr_dyn_obj_get(options, "subject", 7);
  static const char *const bool_names[] = {"wildcards", "partialWildcards", "multiLabelWildcards",
                                           "singleLabelSubdomains"};
  static const bool bool_defaults[] = {true, true, false, false};
  bool values[4];
  if (subject != NULL && subject->kind != SCR_DYN_UNDEF && subject->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("options.subject", "of type string", subject);
    return -1;
  }
  for (size_t i = 0; i < 4; i++) {
    const ScrDyn *v = scr_dyn_obj_get(options, bool_names[i], strlen(bool_names[i]));
    if (v == NULL || v->kind == SCR_DYN_UNDEF) {
      values[i] = bool_defaults[i];
      continue;
    }
    if (v->kind != SCR_DYN_BOOL) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", bool_names[i]);
      scr_dyn_prop_type_fail(name, "of type boolean", v);
      return -1;
    }
    values[i] = v->v.b;
  }
  int flags = 0;
  if (subject != NULL && subject->kind == SCR_DYN_STR) {
    const ScrStr *s = subject->v.str;
    if (s->len == 6 && memcmp(s->data, "always", 6) == 0) flags |= SCR_X509_ALWAYS_CHECK_SUBJECT;
    else if (s->len == 5 && memcmp(s->data, "never", 5) == 0) flags |= SCR_X509_NEVER_CHECK_SUBJECT;
    else if (!(s->len == 7 && memcmp(s->data, "default", 7) == 0)) {
      scr_dyn_arg_value_fail("options.subject", NULL, subject);
      return -1;
    }
  }
  if (!values[0]) flags |= SCR_X509_NO_WILDCARDS;
  if (!values[1]) flags |= SCR_X509_NO_PARTIAL_WILDCARDS;
  if (values[2]) flags |= SCR_X509_MULTI_LABEL_WILDCARDS;
  if (values[3]) flags |= SCR_X509_SINGLE_LABEL_SUBDOMAINS;
  return flags;
}

static bool scr_x509_ieq(const uint8_t *a, const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint8_t x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x = (uint8_t)(x + 32);
    if (y >= 'A' && y <= 'Z') y = (uint8_t)(y + 32);
    if (x != y) return false;
  }
  return true;
}

/* OpenSSL's equal_nocase after skip_prefix: a host that starts with '.'
 * compares with the name's equal-length suffix when the characters
 * skipped hold no NUL (and, under singleLabelSubdomains, no dot). */
static bool scr_x509_host_equal(const uint8_t *pattern, size_t plen, const uint8_t *host,
                                size_t hlen, int flags) {
  if (hlen > 1 && host[0] == '.') {
    const uint8_t *p = pattern;
    size_t n = plen;
    while (n > hlen && *p) {
      if ((flags & SCR_X509_SINGLE_LABEL_SUBDOMAINS) && *p == '.') break;
      p++;
      n--;
    }
    if (n == hlen) {
      pattern = p;
      plen = n;
    }
  }
  return plen == hlen && memchr(pattern, 0, plen) == NULL && scr_x509_ieq(pattern, host, hlen);
}

static bool scr_x509_label_char(uint8_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

/* OpenSSL's valid_star: the '*' of a wildcard pattern, or NULL when the
 * pattern is not a valid wildcard (the star outside the first label, in
 * an IDNA label, partial when partial wildcards are off, or fewer than two
 * labels after it). */
static const uint8_t *scr_x509_valid_star(const uint8_t *p, size_t len, int flags) {
  const uint8_t *star = NULL;
  int dots = 0;
  bool atstart = true, idna = false, first = true;
  for (size_t i = 0; i < len; i++) {
    if (p[i] == '*') {
      bool atend = i == len - 1 || p[i + 1] == '.';
      if (star != NULL || !first || idna) return NULL;
      if ((flags & SCR_X509_NO_PARTIAL_WILDCARDS) && (!atstart || !atend)) return NULL;
      if (!atstart && !atend) return NULL;
      star = &p[i];
      atstart = false;
    } else if (p[i] == '.') {
      if (atstart) return NULL;
      idna = false;
      dots++;
      atstart = true;
      first = false;
    } else if (p[i] == '-' || scr_x509_label_char(p[i])) {
      if (atstart && len - i >= 4 && scr_x509_ieq(&p[i], (const uint8_t *)"xn--", 4)) idna = true;
      atstart = false;
    } else {
      return NULL;
    }
  }
  if (star == NULL || dots < 2 || atstart) return NULL;
  return star;
}

/* OpenSSL's wildcard_match: prefix and suffix around the star match the
 * host case-insensitively, the star covers at least one character, never
 * a dot unless multi-label wildcards are on, and never an IDNA label. */
static bool scr_x509_wildcard_match(const uint8_t *prefix, size_t prefix_len,
                                    const uint8_t *suffix, size_t suffix_len,
                                    const uint8_t *host, size_t hlen, int flags) {
  if (hlen < prefix_len + suffix_len) return false;
  if (!scr_x509_ieq(prefix, host, prefix_len)) return false;
  const uint8_t *wild_start = host + prefix_len;
  const uint8_t *wild_end = host + hlen - suffix_len;
  if (!scr_x509_ieq(wild_end, suffix, suffix_len)) return false;
  if (prefix_len == 0 && suffix_len > 0 && *suffix == '.') {
    if (wild_start == wild_end) return false;
    if (wild_end - wild_start > 4 && scr_x509_ieq(wild_start, (const uint8_t *)"xn--", 4))
      return false;
  }
  bool allow_multi = (flags & SCR_X509_MULTI_LABEL_WILDCARDS) != 0;
  for (const uint8_t *p = wild_start; p != wild_end; p++) {
    if (!scr_x509_label_char(*p) && *p != '-' && !(*p == '.' && allow_multi)) return false;
  }
  return true;
}

static bool scr_x509_host_match(const uint8_t *pattern, size_t plen, const uint8_t *host,
                                size_t hlen, int flags) {
  /* a host that starts with '.' matches a wildcard only as a suffix */
  if (!(flags & SCR_X509_NO_WILDCARDS) && !(hlen > 1 && host[0] == '.')) {
    const uint8_t *star = scr_x509_valid_star(pattern, plen, flags);
    if (star != NULL)
      return scr_x509_wildcard_match(pattern, (size_t)(star - pattern), star + 1,
                                     plen - (size_t)(star - pattern) - 1, host, hlen, flags);
  }
  return scr_x509_host_equal(pattern, plen, host, hlen, flags);
}

/* OpenSSL's equal_email: the local part as is, the domain case-
 * insensitively. */
static bool scr_x509_email_match(const uint8_t *pattern, size_t plen, const uint8_t *email,
                                 size_t elen) {
  if (plen != elen || memchr(pattern, 0, plen) != NULL) return false;
  size_t at = elen;
  while (at > 0 && email[at - 1] != '@') at--;
  if (at == 0) return scr_x509_ieq(pattern, email, elen);
  return memcmp(pattern, email, at) == 0 && scr_x509_ieq(pattern + at, email + at, elen - at);
}

enum { SCR_X509_GEN_EMAIL = 0x81, SCR_X509_GEN_DNS = 0x82, SCR_X509_GEN_IP = 0x87 };

/* do_x509_check over the subjectAltName entries of one type, then the
 * subject's CN (hosts) or emailAddress (emails) entries when the flags
 * allow. Writes the matching certificate name into *out. */
static bool scr_x509_check(ScrBytes *der, uint8_t gen, const uint8_t *chk, size_t chk_len,
                           int flags, ScrX509Buf *out) {
  ScrX509Parts parts;
  if (!scr_x509_parts(SCR_X509_DER(der), &parts)) return false;
  bool san_present = false;
  size_t n;
  const uint8_t *ext = scr_x509_ext(&parts, SCR_X509_OID_SAN, sizeof SCR_X509_OID_SAN, &n);
  uint8_t tag;
  size_t len;
  const uint8_t *names = ext ? scr_der_tl(ext, ext + n, &tag, &len) : NULL;
  if (names && tag == 0x30) {
    const uint8_t *end = names + len;
    for (const uint8_t *p = names; p < end;) {
      const uint8_t *v = scr_der_tl(p, end, &tag, &len);
      if (!v) break;
      p = v + len;
      if (tag != gen) continue;
      san_present = true;
      bool hit = gen == SCR_X509_GEN_IP    ? len == chk_len && memcmp(v, chk, len) == 0
                 : gen == SCR_X509_GEN_DNS ? scr_x509_host_match(v, len, chk, chk_len, flags)
                                           : scr_x509_email_match(v, len, chk, chk_len);
      if (hit) {
        scr_x509_put(out, v, len);
        return true;
      }
    }
  }
  if (gen == SCR_X509_GEN_IP || (flags & SCR_X509_NEVER_CHECK_SUBJECT) ||
      (san_present && !(flags & SCR_X509_ALWAYS_CHECK_SUBJECT)) || !parts.subject)
    return false;
  /* the subject's CN (2.5.4.3) or emailAddress (1.2.840.113549.1.9.1) */
  static const uint8_t cn[] = {0x55, 0x04, 0x03};
  static const uint8_t email[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x01};
  const uint8_t *want = gen == SCR_X509_GEN_DNS ? cn : email;
  size_t want_len = gen == SCR_X509_GEN_DNS ? sizeof cn : sizeof email;
  const uint8_t *end = parts.subject + parts.subject_len;
  for (const uint8_t *p = parts.subject; p < end;) {
    const uint8_t *set = scr_der_tl(p, end, &tag, &len);
    if (!set || tag != 0x31) break;
    const uint8_t *set_end = set + len;
    p = set_end;
    for (const uint8_t *q = set; q < set_end;) {
      const uint8_t *atv = scr_der_tl(q, set_end, &tag, &len);
      if (!atv || tag != 0x30) break;
      const uint8_t *atv_end = atv + len;
      q = atv_end;
      const uint8_t *oid = scr_der_tl(atv, atv_end, &tag, &len);
      if (!oid || tag != 0x06 || len != want_len || memcmp(oid, want, len) != 0) continue;
      uint8_t vtag;
      size_t vlen;
      const uint8_t *value = scr_der_tl(oid + len, atv_end, &vtag, &vlen);
      if (!value) continue;
      ScrX509Buf text = {0};
      scr_x509_value_utf8(&text, vtag, value, vlen);
      bool hit = gen == SCR_X509_GEN_DNS
                     ? scr_x509_host_match((const uint8_t *)text.data, text.len, chk, chk_len, flags)
                     : scr_x509_email_match((const uint8_t *)text.data, text.len, chk, chk_len);
      if (hit) scr_x509_put(out, text.data, text.len);
      free(text.data);
      if (hit) return true;
    }
  }
  return false;
}

/* x509.checkHost(name[, options]) and x509.checkEmail(email[, options]):
 * the certificate name that matched (checkHost) or the argument
 * (checkEmail), "" for none (Node's undefined), or NULL with the
 * validation error pending. */
static ScrStr *scr_x509_check_name(ScrBytes *der, const ScrDyn *value, const ScrDyn *options,
                                   const char *arg, uint8_t gen) {
  if (value->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail(arg, "of type string", value);
    return NULL;
  }
  int flags = scr_x509_check_flags(options);
  if (flags < 0) return NULL;
  ScrX509Buf b = {0};
  const ScrStr *s = value->v.str;
  bool hit = s->len > 0 && scr_x509_check(der, gen, (const uint8_t *)s->data, s->len, flags, &b);
  if (hit && gen == SCR_X509_GEN_EMAIL) {
    /* checkEmail answers its argument (X509_check_email reports no name) */
    free(b.data);
    return scr_str_retain((ScrStr *)s);
  }
  return scr_x509_buf_str(&b);
}

ScrStr *scr_crypto_x509_check_host(ScrBytes *der, ScrDyn *name, ScrDyn *options) {
  return scr_x509_check_name(der, name, options, "name", SCR_X509_GEN_DNS);
}

ScrStr *scr_crypto_x509_check_email(ScrBytes *der, ScrDyn *email, ScrDyn *options) {
  return scr_x509_check_name(der, email, options, "email", SCR_X509_GEN_EMAIL);
}

/* inet_pton's IPv4 form, which Node's checkIP parses: four decimal parts,
 * each at most 255, without leading zeros. */
static bool scr_x509_ipv4(const char *s, size_t n, uint8_t out[4]) {
  size_t part = 0, i = 0;
  while (part < 4) {
    if (i >= n || s[i] < '0' || s[i] > '9') return false;
    unsigned v = 0;
    size_t digits = 0;
    if (s[i] == '0' && i + 1 < n && s[i + 1] >= '0' && s[i + 1] <= '9') return false;
    while (i < n && s[i] >= '0' && s[i] <= '9') {
      v = v * 10 + (unsigned)(s[i++] - '0');
      if (++digits > 3 || v > 255) return false;
    }
    out[part++] = (uint8_t)v;
    if (part < 4) {
      if (i >= n || s[i] != '.') return false;
      i++;
    }
  }
  return i == n;
}

/* inet_pton's IPv6 form: hex groups with at most one "::", and an IPv4
 * address in place of the last two groups. */
static bool scr_x509_ipv6(const char *s, size_t n, uint8_t out[16]) {
  uint8_t head[16], tail[16];
  size_t head_len = 0, tail_len = 0;
  bool compressed = false;
  size_t i = 0;
  if (n >= 2 && s[0] == ':' && s[1] == ':') {
    compressed = true;
    i = 2;
    if (i == n) {
      memset(out, 0, 16);
      return true;
    }
  } else if (n > 0 && s[0] == ':') {
    return false;
  }
  while (i < n) {
    uint8_t *dst = compressed ? tail : head;
    size_t *dst_len = compressed ? &tail_len : &head_len;
    /* an IPv4 tail */
    const char *dot = memchr(s + i, '.', n - i);
    const char *colon = memchr(s + i, ':', n - i);
    if (dot != NULL && colon == NULL) {
      if (*dst_len + 4 > 16 || !scr_x509_ipv4(s + i, n - i, dst + *dst_len)) return false;
      *dst_len += 4;
      i = n;
      break;
    }
    unsigned v = 0;
    size_t digits = 0;
    while (i < n && s[i] != ':') {
      char c = s[i++];
      unsigned d = c >= '0' && c <= '9'   ? (unsigned)(c - '0')
                   : c >= 'a' && c <= 'f' ? (unsigned)(c - 'a' + 10)
                   : c >= 'A' && c <= 'F' ? (unsigned)(c - 'A' + 10)
                                          : 16;
      if (d == 16 || ++digits > 4) return false;
      v = (v << 4) | d;
    }
    if (digits == 0 || *dst_len + 2 > 16) return false;
    dst[(*dst_len)++] = (uint8_t)(v >> 8);
    dst[(*dst_len)++] = (uint8_t)v;
    if (i == n) break;
    i++; /* ':' */
    if (i < n && s[i] == ':') {
      if (compressed) return false;
      compressed = true;
      i++;
      if (i == n) break;
    } else if (i == n) {
      return false;
    }
  }
  if (compressed) {
    if (head_len + tail_len > 14) return false;
  } else if (head_len != 16) {
    return false;
  }
  memset(out, 0, 16);
  memcpy(out, head, head_len);
  memcpy(out + 16 - tail_len, tail, tail_len);
  return true;
}

/* x509.checkIP(ip[, options]): the argument itself when an iPAddress
 * alternative name equals it, "" for none, NULL with the error pending.
 * The options are validated like checkHost's and have no effect. */
ScrStr *scr_crypto_x509_check_ip(ScrBytes *der, ScrDyn *ip, ScrDyn *options) {
  if (ip->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("ip", "of type string", ip);
    return NULL;
  }
  if (scr_x509_check_flags(options) < 0) return NULL;
  const ScrStr *s = ip->v.str;
  uint8_t addr[16];
  size_t addr_len = 0;
  if (memchr(s->data, ':', s->len) != NULL) {
    if (scr_x509_ipv6(s->data, s->len, addr)) addr_len = 16;
  } else if (scr_x509_ipv4(s->data, s->len, addr)) {
    addr_len = 4;
  }
  if (addr_len == 0) {
    static const char msg[] = "Invalid name";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  ScrX509Buf b = {0};
  if (scr_x509_check(der, SCR_X509_GEN_IP, addr, addr_len, 0, &b)) {
    free(b.data);
    return scr_str_retain((ScrStr *)s);
  }
  return scr_x509_buf_str(&b);
}

/* ── checkIssued ──────────────────────────────────────────────────────── */

/* The string types OpenSSL canonicalizes before comparing names
 * (ASN1_MASK_CANON). */
static bool scr_x509_canon_type(uint8_t tag) {
  return tag == 0x0C || tag == 0x1E || tag == 0x1C || tag == 0x13 || tag == 0x14 || tag == 0x16 ||
         tag == 0x1A;
}

static bool scr_x509_space(uint8_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}

/* asn1_string_canon: UTF-8, leading and trailing whitespace dropped,
 * inner runs of whitespace as one space, ASCII in lower case. */
static void scr_x509_canon(ScrX509Buf *out, uint8_t tag, const uint8_t *v, size_t n) {
  ScrX509Buf text = {0};
  scr_x509_value_utf8(&text, tag, v, n);
  const uint8_t *p = (const uint8_t *)text.data;
  size_t len = text.len;
  while (len > 0 && scr_x509_space(*p)) p++, len--;
  while (len > 0 && scr_x509_space(p[len - 1])) len--;
  for (size_t i = 0; i < len; i++) {
    uint8_t c = p[i];
    if (scr_x509_space(c)) {
      scr_x509_putc(out, ' ');
      while (i + 1 < len && scr_x509_space(p[i + 1])) i++;
    } else {
      scr_x509_putc(out, (char)(c >= 'A' && c <= 'Z' ? c + 32 : c));
    }
  }
  free(text.data);
}

/* One Name as comparable text: per RDN, each attribute's OID and its
 * canonical value (or raw DER for non-string types), with separators that
 * keep the RDN grouping. */
static void scr_x509_name_canon(ScrX509Buf *out, const uint8_t *name, size_t n) {
  const uint8_t *end = name + n;
  uint8_t tag;
  size_t len;
  for (const uint8_t *p = name; p < end;) {
    const uint8_t *set = scr_der_tl(p, end, &tag, &len);
    if (!set || tag != 0x31) break;
    const uint8_t *set_end = set + len;
    p = set_end;
    scr_x509_putc(out, '\x01');
    for (const uint8_t *q = set; q < set_end;) {
      const uint8_t *atv = scr_der_tl(q, set_end, &tag, &len);
      if (!atv || tag != 0x30) break;
      const uint8_t *atv_end = atv + len;
      q = atv_end;
      const uint8_t *oid = scr_der_tl(atv, atv_end, &tag, &len);
      if (!oid || tag != 0x06) continue;
      scr_x509_putc(out, '\x02');
      scr_x509_put(out, oid, len);
      uint8_t vtag;
      size_t vlen;
      const uint8_t *value_tl = oid + len;
      const uint8_t *value = scr_der_tl(value_tl, atv_end, &vtag, &vlen);
      if (!value) continue;
      scr_x509_putc(out, '\x03');
      if (scr_x509_canon_type(vtag)) scr_x509_canon(out, vtag, value, vlen);
      else scr_x509_put(out, value_tl, (size_t)(value + vlen - value_tl));
    }
  }
}

static bool scr_x509_name_eq(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) {
  ScrX509Buf x = {0}, y = {0};
  scr_x509_name_canon(&x, a, an);
  scr_x509_name_canon(&y, b, bn);
  bool eq = x.len == y.len && (x.len == 0 || memcmp(x.data, y.data, x.len) == 0);
  free(x.data);
  free(y.data);
  return eq;
}

static const uint8_t SCR_X509_OID_SKID[] = {0x55, 0x1D, 0x0E};
static const uint8_t SCR_X509_OID_AKID[] = {0x55, 0x1D, 0x23};

/* The public key algorithm a signature algorithm needs: 1 RSA, 2 EC,
 * 3 Ed25519, 4 Ed448, 0 unknown. */
static int scr_x509_sig_key_kind(const uint8_t *oid, size_t n) {
  static const uint8_t rsa_prefix[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01};
  static const uint8_t ecdsa_prefix[] = {0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04};
  if (n == sizeof rsa_prefix + 1 && memcmp(oid, rsa_prefix, sizeof rsa_prefix) == 0) {
    uint8_t last = oid[sizeof rsa_prefix];
    return last == 4 || last == 5 || (last >= 10 && last <= 14) ? 1 : 0;
  }
  if (n >= sizeof ecdsa_prefix + 1 && memcmp(oid, ecdsa_prefix, sizeof ecdsa_prefix) == 0)
    return 2;
  if (n == 3 && oid[0] == 0x2B && oid[1] == 0x65 && oid[2] == 0x70) return 3;
  if (n == 3 && oid[0] == 0x2B && oid[1] == 0x65 && oid[2] == 0x71) return 4;
  return 0;
}

/* The kind (as above) of a SubjectPublicKeyInfo's algorithm. */
static int scr_x509_spki_kind(const ScrX509Parts *parts) {
  if (!parts->spki) return 0;
  uint8_t tag;
  size_t len;
  const uint8_t *alg = scr_der_tl(parts->spki, parts->spki + parts->spki_len, &tag, &len);
  if (!alg || tag != 0x30) return 0;
  const uint8_t *oid = scr_der_tl(alg, alg + len, &tag, &len);
  if (!oid || tag != 0x06) return 0;
  static const uint8_t rsa[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01};
  static const uint8_t pss[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A};
  static const uint8_t ec[] = {0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01};
  if ((len == sizeof rsa && memcmp(oid, rsa, len) == 0) ||
      (len == sizeof pss && memcmp(oid, pss, len) == 0))
    return 1;
  if (len == sizeof ec && memcmp(oid, ec, len) == 0) return 2;
  if (len == 3 && oid[0] == 0x2B && oid[1] == 0x65 && oid[2] == 0x70) return 3;
  if (len == 3 && oid[0] == 0x2B && oid[1] == 0x65 && oid[2] == 0x71) return 4;
  return 0;
}

/* X509_check_akid: the subject's authorityKeyIdentifier against the
 * issuer's subjectKeyIdentifier, serial number and issuer name. */
static bool scr_x509_akid_ok(const ScrX509Parts *issuer, const ScrX509Parts *subject) {
  size_t n;
  const uint8_t *akid = scr_x509_ext(subject, SCR_X509_OID_AKID, sizeof SCR_X509_OID_AKID, &n);
  if (!akid) return true;
  uint8_t tag;
  size_t len;
  const uint8_t *seq = scr_der_tl(akid, akid + n, &tag, &len);
  if (!seq || tag != 0x30) return true;
  const uint8_t *end = seq + len;
  for (const uint8_t *p = seq; p < end;) {
    const uint8_t *v = scr_der_tl(p, end, &tag, &len);
    if (!v) break;
    p = v + len;
    if (tag == 0x80) { /* keyIdentifier */
      size_t sn;
      const uint8_t *skid = scr_x509_ext(issuer, SCR_X509_OID_SKID, sizeof SCR_X509_OID_SKID, &sn);
      uint8_t stag;
      size_t slen;
      const uint8_t *id = skid ? scr_der_tl(skid, skid + sn, &stag, &slen) : NULL;
      if (id && stag == 0x04 && (slen != len || memcmp(id, v, len) != 0)) return false;
    } else if (tag == 0x82) { /* authorityCertSerialNumber */
      if (issuer->serial && (issuer->serial_len != len || memcmp(issuer->serial, v, len) != 0))
        return false;
    } else if (tag == 0xA1 && issuer->issuer) { /* authorityCertIssuer */
      bool found = false;
      const uint8_t *names_end = v + len;
      for (const uint8_t *q = v; q < names_end && !found;) {
        uint8_t gtag;
        size_t glen;
        const uint8_t *g = scr_der_tl(q, names_end, &gtag, &glen);
        if (!g) break;
        q = g + glen;
        if (gtag != 0xA4) continue;
        uint8_t ntag;
        size_t nlen;
        const uint8_t *name = scr_der_tl(g, g + glen, &ntag, &nlen);
        if (name && ntag == 0x30 && scr_x509_name_eq(name, nlen, issuer->issuer, issuer->issuer_len))
          found = true;
      }
      if (!found) return false;
    }
  }
  return true;
}

/* x509.checkIssued(otherCert): X509_check_issued(otherCert, x509) — the
 * names match, the authority key identifier fits, the signature algorithm
 * suits the issuer's key, and the issuer's keyUsage, when present, allows
 * certificate signing. */
bool scr_crypto_x509_check_issued(ScrBytes *der, ScrBytes *issuer_der) {
  ScrX509Parts subject, issuer;
  if (!scr_x509_parts(SCR_X509_DER(der), &subject) ||
      !scr_x509_parts(SCR_X509_DER(issuer_der), &issuer))
    return false;
  if (!subject.issuer || !issuer.subject ||
      !scr_x509_name_eq(issuer.subject, issuer.subject_len, subject.issuer, subject.issuer_len))
    return false;
  if (!scr_x509_akid_ok(&issuer, &subject)) return false;
  uint8_t tag;
  size_t len;
  const uint8_t *sig_oid = subject.sig_alg
                               ? scr_der_tl(subject.sig_alg, subject.sig_alg + subject.sig_alg_len,
                                            &tag, &len)
                               : NULL;
  if (!sig_oid || tag != 0x06) return false;
  int need = scr_x509_sig_key_kind(sig_oid, len);
  if (need == 0 || need != scr_x509_spki_kind(&issuer)) return false;
  size_t n;
  const uint8_t *ku = scr_x509_ext(&issuer, SCR_X509_OID_KEY_USAGE, sizeof SCR_X509_OID_KEY_USAGE, &n);
  if (ku) {
    const uint8_t *bits = scr_der_tl(ku, ku + n, &tag, &len);
    if (!bits || tag != 0x03 || len < 2 || (bits[1] & 0x04) == 0) return false;
  }
  return true;
}

/* ── toLegacyObject ───────────────────────────────────────────────────── */

static ScrDyn *scr_x509_dyn_text(const char *s, size_t n) {
  ScrStr *str = scr_str_new(s, n);
  ScrDyn *d = scr_dyn_new_str(str);
  scr_str_release(str);
  return d;
}

/* A fresh Buffer holding n bytes. */
static ScrDyn *scr_x509_dyn_buffer(const uint8_t *p, size_t n) {
  ScrBytes *b = scr_buffer_alloc_unsafe_slow((double)n);
  if (n) memcpy(b->data, p, n);
  ScrDyn *d = scr_dyn_new_bytes(b);
  scr_bytes_release(b);
  return d;
}

/* A Name as Node's legacy object: one property per attribute, keyed by
 * OpenSSL's short name (the dotted OID otherwise), its value the UTF-8
 * text; a repeated key collects its values in an array. */
static ScrDyn *scr_x509_name_object(const uint8_t *name, size_t n) {
  ScrDyn *obj = scr_dyn_new_obj_null_proto();
  const uint8_t *end = name + n;
  uint8_t tag;
  size_t len;
  for (const uint8_t *p = name; p < end;) {
    const uint8_t *set = scr_der_tl(p, end, &tag, &len);
    if (!set || tag != 0x31) break;
    const uint8_t *set_end = set + len;
    p = set_end;
    for (const uint8_t *q = set; q < set_end;) {
      const uint8_t *atv = scr_der_tl(q, set_end, &tag, &len);
      if (!atv || tag != 0x30) break;
      const uint8_t *atv_end = atv + len;
      q = atv_end;
      const uint8_t *oid = scr_der_tl(atv, atv_end, &tag, &len);
      if (!oid || tag != 0x06) continue;
      size_t oid_len = len;
      uint8_t vtag;
      size_t vlen;
      const uint8_t *value = scr_der_tl(oid + len, atv_end, &vtag, &vlen);
      if (!value) continue;
      ScrX509Buf key = {0}, text = {0};
      scr_x509_oid_name(&key, oid, oid_len, scr_x509_attr_names,
                        sizeof scr_x509_attr_names / sizeof scr_x509_attr_names[0]);
      scr_x509_value_utf8(&text, vtag, value, vlen);
      ScrDyn *v = scr_x509_dyn_text(text.data ? text.data : "", text.len);
      const ScrDyn *prior = scr_dyn_obj_get(obj, key.data, key.len);
      if (prior == NULL) {
        scr_dyn_obj_set(obj, key.data, key.len, v);
      } else if (prior->kind == SCR_DYN_ARR) {
        scr_dyn_arr_push((ScrDyn *)prior, v);
      } else {
        ScrDyn *arr = scr_dyn_new_arr();
        scr_dyn_arr_push(arr, scr_dyn_retain((ScrDyn *)prior));
        scr_dyn_arr_push(arr, v);
        scr_dyn_obj_set(obj, key.data, key.len, arr);
      }
      free(key.data);
      free(text.data);
    }
  }
  return obj;
}

/* The JSON string literal at s (a quoted alternative name), decoded. */
static void scr_x509_json_unquote(ScrX509Buf *out, const char *s, size_t n) {
  for (size_t i = 1; i < n; i++) {
    char c = s[i];
    if (c == '"') return;
    if (c != '\\' || i + 1 >= n) {
      scr_x509_putc(out, c);
      continue;
    }
    c = s[++i];
    if (c == 'u' && i + 4 < n) {
      unsigned v = 0;
      for (int k = 1; k <= 4; k++) {
        char h = s[i + k];
        v = v * 16 + (unsigned)(h <= '9' ? h - '0' : (h | 0x20) - 'a' + 10);
      }
      scr_x509_put_utf8(out, v);
      i += 4;
    } else {
      scr_x509_putc(out, c == 'n' ? '\n' : c == 't' ? '\t' : c);
    }
  }
}

/* Node's legacy infoAccess: the infoAccess lines split at their first
 * colon into "<method> - <type>" keys, each holding its values in an
 * array (a quoted value is JSON-decoded). */
static ScrDyn *scr_x509_info_access_object(ScrBytes *der) {
  ScrStr *text = scr_crypto_x509_info_access(der);
  if (text->len == 0) {
    scr_str_release(text);
    return scr_dyn_undefined();
  }
  ScrDyn *obj = scr_dyn_new_obj_null_proto();
  const char *s = text->data;
  size_t n = text->len;
  for (size_t start = 0; start < n;) {
    size_t eol = start;
    while (eol < n && s[eol] != '\n') eol++;
    size_t colon = start;
    while (colon < eol && s[colon] != ':') colon++;
    if (colon < eol) {
      const char *val = s + colon + 1;
      size_t val_len = eol - colon - 1;
      ScrX509Buf v = {0};
      if (val_len > 0 && val[0] == '"') scr_x509_json_unquote(&v, val, val_len);
      else scr_x509_put(&v, val, val_len);
      ScrDyn *item = scr_x509_dyn_text(v.data ? v.data : "", v.len);
      free(v.data);
      const ScrDyn *prior = scr_dyn_obj_get(obj, s + start, colon - start);
      if (prior != NULL && prior->kind == SCR_DYN_ARR) {
        scr_dyn_arr_push((ScrDyn *)prior, item);
      } else {
        ScrDyn *arr = scr_dyn_new_arr();
        scr_dyn_arr_push(arr, item);
        scr_dyn_obj_set(obj, s + start, colon - start, arr);
      }
    }
    start = eol + 1;
  }
  scr_str_release(text);
  return obj;
}

/* Hex of a big-endian magnitude: BN_bn2hex (whole bytes, upper case, no
 * leading zero bytes) or, with `lower_trim`, %llx-style text. */
static void scr_x509_put_hex(ScrX509Buf *b, const uint8_t *p, size_t n, bool lower_trim) {
  const char *hex = lower_trim ? "0123456789abcdef" : "0123456789ABCDEF";
  while (n > 0 && *p == 0) p++, n--;
  if (n == 0) {
    scr_x509_putc(b, '0');
    return;
  }
  for (size_t i = 0; i < n; i++) {
    if (!(lower_trim && i == 0 && (p[i] >> 4) == 0)) scr_x509_putc(b, hex[p[i] >> 4]);
    scr_x509_putc(b, hex[p[i] & 0x0f]);
  }
}

typedef struct {
  const char *oid;
  const char *name;
  const char *nist;
  int bits;
} ScrX509Curve;

static const ScrX509Curve scr_x509_curves[] = {
    {"1.2.840.10045.3.1.1", "prime192v1", "P-192", 192},
    {"1.3.132.0.33", "secp224r1", "P-224", 224},
    {"1.2.840.10045.3.1.7", "prime256v1", "P-256", 256},
    {"1.3.132.0.34", "secp384r1", "P-384", 384},
    {"1.3.132.0.35", "secp521r1", "P-521", 521},
    {"1.3.132.0.31", "secp192k1", NULL, 192},
    {"1.3.132.0.32", "secp224k1", NULL, 225},
    {"1.3.132.0.10", "secp256k1", NULL, 256},
    {"1.3.36.3.3.2.8.1.1.7", "brainpoolP256r1", NULL, 256},
    {"1.3.36.3.3.2.8.1.1.11", "brainpoolP384r1", NULL, 384},
    {"1.3.36.3.3.2.8.1.1.13", "brainpoolP512r1", NULL, 512},
};

/* The public key members of the legacy object: modulus, exponent,
 * pubkey, bits, asn1Curve and nistCurve (each undefined where the key
 * type has none). */
static void scr_x509_key_fields(const ScrX509Parts *parts, ScrDyn *slots[6]) {
  for (int i = 0; i < 6; i++) slots[i] = scr_dyn_undefined();
  if (!parts->spki) return;
  int kind = scr_x509_spki_kind(parts);
  uint8_t tag;
  size_t len;
  const uint8_t *spki_end = parts->spki + parts->spki_len;
  const uint8_t *alg = scr_der_tl(parts->spki, spki_end, &tag, &len);
  if (!alg || tag != 0x30) return;
  const uint8_t *alg_end = alg + len;
  const uint8_t *oid = scr_der_tl(alg, alg_end, &tag, &len);
  if (!oid) return;
  const uint8_t *params = oid + len;
  uint8_t ptag;
  size_t plen;
  const uint8_t *param = scr_der_tl(params, alg_end, &ptag, &plen);
  const uint8_t *bits = scr_der_tl(alg_end, spki_end, &tag, &len);
  if (!bits || tag != 0x03 || len < 1) return;
  const uint8_t *key = bits + 1;
  size_t key_len = len - 1;
  static const uint8_t rsa_oid[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01};
  bool rsa = kind == 1 && (size_t)(params - oid) == sizeof rsa_oid &&
             memcmp(oid, rsa_oid, sizeof rsa_oid) == 0;
  if (rsa) {
    const uint8_t *seq = scr_der_tl(key, key + key_len, &tag, &len);
    if (!seq || tag != 0x30) return;
    const uint8_t *seq_end = seq + len;
    size_t nlen, elen;
    const uint8_t *nmod = scr_der_tl(seq, seq_end, &tag, &nlen);
    if (!nmod || tag != 0x02) return;
    const uint8_t *nexp = scr_der_tl(nmod + nlen, seq_end, &tag, &elen);
    if (!nexp || tag != 0x02) return;
    ScrX509Buf m = {0}, e = {0};
    scr_x509_put_hex(&m, nmod, nlen, false);
    scr_x509_puts(&e, "0x");
    scr_x509_put_hex(&e, nexp, elen, true);
    slots[0] = scr_x509_dyn_text(m.data, m.len);
    slots[1] = scr_x509_dyn_text(e.data, e.len);
    free(m.data);
    free(e.data);
    slots[2] = scr_x509_dyn_buffer(parts->spki_tlv, parts->spki_tlv_len);
    size_t i = 0;
    while (i < nlen && nmod[i] == 0) i++;
    int nbits = 0;
    if (i < nlen) {
      nbits = (int)((nlen - i - 1) * 8);
      for (uint8_t top = nmod[i]; top; top >>= 1) nbits++;
    }
    slots[3] = scr_dyn_new_num(nbits);
    return;
  }
  if (kind == 2 && param && ptag == 0x06) {
    ScrX509Buf dotted = {0};
    scr_x509_oid_dotted(&dotted, param, plen);
    for (size_t c = 0; c < sizeof scr_x509_curves / sizeof scr_x509_curves[0]; c++) {
      const ScrX509Curve *curve = &scr_x509_curves[c];
      if (strlen(curve->oid) != dotted.len || memcmp(curve->oid, dotted.data, dotted.len) != 0)
        continue;
      slots[2] = scr_x509_dyn_buffer(key, key_len);
      slots[3] = scr_dyn_new_num(curve->bits);
      slots[4] = scr_x509_dyn_text(curve->name, strlen(curve->name));
      if (curve->nist) slots[5] = scr_x509_dyn_text(curve->nist, strlen(curve->nist));
      break;
    }
    free(dotted.data);
  }
}

static const uint8_t SCR_X509_OID_EKU[] = {0x55, 0x1D, 0x25};

/* x509.toLegacyObject(): Node's X509ToObject, member order included. */
ScrDyn *scr_crypto_x509_legacy_object(ScrBytes *der) {
  ScrX509Parts parts;
  ScrDyn *obj = scr_dyn_new_obj();
  bool ok = scr_x509_parts(SCR_X509_DER(der), &parts);
  if (!ok) memset(&parts, 0, sizeof parts);
  scr_dyn_obj_set(obj, "subject", 7,
                  parts.subject ? scr_x509_name_object(parts.subject, parts.subject_len)
                                : scr_dyn_new_obj_null_proto());
  scr_dyn_obj_set(obj, "issuer", 6,
                  parts.issuer ? scr_x509_name_object(parts.issuer, parts.issuer_len)
                               : scr_dyn_new_obj_null_proto());
  ScrStr *san = scr_crypto_x509_subject_alt_name(der);
  scr_dyn_obj_set(obj, "subjectaltname", 14, san->len ? scr_dyn_new_str(san) : scr_dyn_undefined());
  scr_str_release(san);
  scr_dyn_obj_set(obj, "infoAccess", 10, scr_x509_info_access_object(der));
  scr_dyn_obj_set(obj, "ca", 2, scr_dyn_new_bool(scr_crypto_x509_ca(der)));
  ScrDyn *key[6];
  scr_x509_key_fields(&parts, key);
  scr_dyn_obj_set(obj, "modulus", 7, key[0]);
  scr_dyn_obj_set(obj, "exponent", 8, key[1]);
  scr_dyn_obj_set(obj, "pubkey", 6, key[2]);
  scr_dyn_obj_set(obj, "bits", 4, key[3]);
  static const struct {
    const char *key;
    ScrStr *(*field)(ScrBytes *);
  } texts[] = {
      {"valid_from", scr_crypto_x509_valid_from},
      {"valid_to", scr_crypto_x509_valid_to},
      {"fingerprint", scr_crypto_x509_fingerprint},
      {"fingerprint256", scr_crypto_x509_fingerprint256},
      {"fingerprint512", scr_crypto_x509_fingerprint512},
  };
  for (size_t i = 0; i < sizeof texts / sizeof texts[0]; i++) {
    ScrStr *s = texts[i].field(der);
    scr_dyn_obj_set(obj, texts[i].key, strlen(texts[i].key), scr_dyn_new_str(s));
    scr_str_release(s);
  }
  size_t n;
  const uint8_t *eku = ok ? scr_x509_ext(&parts, SCR_X509_OID_EKU, sizeof SCR_X509_OID_EKU, &n) : NULL;
  uint8_t tag;
  size_t len;
  const uint8_t *purposes = eku ? scr_der_tl(eku, eku + n, &tag, &len) : NULL;
  if (purposes && tag == 0x30) {
    ScrDyn *arr = scr_dyn_new_arr();
    const uint8_t *end = purposes + len;
    for (const uint8_t *p = purposes; p < end;) {
      const uint8_t *oid = scr_der_tl(p, end, &tag, &len);
      if (!oid) break;
      p = oid + len;
      if (tag != 0x06) continue;
      ScrX509Buf dotted = {0};
      scr_x509_oid_dotted(&dotted, oid, len);
      scr_dyn_arr_push(arr, scr_x509_dyn_text(dotted.data, dotted.len));
      free(dotted.data);
    }
    scr_dyn_obj_set(obj, "ext_key_usage", 13, arr);
  } else {
    scr_dyn_obj_set(obj, "ext_key_usage", 13, scr_dyn_undefined());
  }
  ScrStr *serial = scr_crypto_x509_serial_number(der);
  scr_dyn_obj_set(obj, "serialNumber", 12, scr_dyn_new_str(serial));
  scr_str_release(serial);
  {
    ScrBytes *view = der;
    SCR_BYTES_SNAPSHOT(view);
    scr_dyn_obj_set(obj, "raw", 3, scr_x509_dyn_buffer(SCR_X509_DER(view)));
  }
  scr_dyn_obj_set(obj, "asn1Curve", 9, key[4]);
  scr_dyn_obj_set(obj, "nistCurve", 9, key[5]);
  return obj;
}
