/* node:http2 — REAL HTTP/2 over the net loop: the h2c (cleartext,
 * prior-knowledge) server and client sessions the Node suite's http2
 * family exercises, with an RFC 7540 frame codec and an RFC 7541 HPACK
 * codec written here (nothing vendored).
 *
 * ── Design note ──────────────────────────────────────────────────────
 *
 * Layering. One ScrH2Session per TCP connection, attached as the
 * socket's native reader (the scr_http.c parser-seam precedent): every
 * read(2) chunk feeds the frame reassembly buffer, complete frames
 * dispatch to the per-stream state machines, and outbound frames go
 * through scr_net_sock_write_native. The server side hangs a refcounted
 * ScrH2SrvCtx off the net server (native-conn + http_ctx alias, exactly
 * the ScrHttpSrvCtx shape — the ctx's leading `proto` tag keeps the two
 * parser families apart on the shared alias slot); the client side dials
 * scr_net_connect and installs the same reader.
 *
 * HPACK. The decoder is COMPLETE (static + dynamic table, all literal
 * forms, size updates, Huffman — peers index and Huffman-code at will;
 * Node's encoder does both). The encoder is deliberately minimal and
 * RFC-valid: indexed for exact static-table matches, literal WITHOUT
 * indexing otherwise (indexed name when the static table has it), no
 * Huffman, no dynamic insertions — the peer's decoder state machine
 * never depends on choices we don't make.
 *
 * Flow control. Both windows are tracked on send (DATA splits to
 * min(stream window, connection window, peer max frame); the remainder
 * buffers until WINDOW_UPDATE/SETTINGS reopen it) and replenished
 * eagerly on receive (a WINDOW_UPDATE pair — stream + connection — goes
 * out per DATA frame, so the peer never stalls).
 *
 * Events, Node-shaped. 'stream'/'response'/'data' fire inline at frame
 * dispatch (macrotask position, like every net callback); 'end' fires
 * when END_STREAM has arrived, the recv queue is drained, and the
 * stream is FLOWING (a 'data' listener or resume() — Node's paused-mode
 * holdback); stream 'close' and session lifecycle emits are DEFERRED to
 * the unit's sweep (scr_net_set_proto_sweep — the scr_http.c emit-queue
 * pattern), one pass after the work that flagged them. A stream closing
 * with a nonzero code fires 'error' (ERR_HTTP2_STREAM_ERROR, Node's
 * message) before its 'close'; rstCode carries the code either way.
 *
 * Ownership. The socket owns its session (+1 through native_ctx); the
 * session holds the socket (+1, dropped when the socket reports closed
 * — that break is what unwinds the pair) and every OPEN stream (+1,
 * dropped at stream settlement); a stream holds its session (+1 for its
 * whole life — safe: the session's stream ref drops first). Listener
 * lists drop at settlement (the cycle story shared with scr_net.c), and
 * an atexit cleanup drains the emit queue so the RC audit stays clean.
 *
 * The differential harness pattern is scr_net.c's: fixtures bind port 0,
 * report `PORT <n>` on stderr, and a Node driver (or the program's own
 * in-process h2 client — the Node-suite shape) does the talking. */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void scr_h2_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── HPACK tables (RFC 7541 Appendices A and B, generated) ───────────── */

typedef struct {
  uint32_t code;
  uint8_t len;
} ScrH2Huff;

typedef struct {
  const char *name;
  const char *value;
} ScrH2StaticEntry;

static const ScrH2Huff SCR_H2_HUFF[257] = {
  {0x1ff8u, 13}, {0x7fffd8u, 23}, {0xfffffe2u, 28}, {0xfffffe3u, 28},
  {0xfffffe4u, 28}, {0xfffffe5u, 28}, {0xfffffe6u, 28}, {0xfffffe7u, 28},
  {0xfffffe8u, 28}, {0xffffeau, 24}, {0x3ffffffcu, 30}, {0xfffffe9u, 28},
  {0xfffffeau, 28}, {0x3ffffffdu, 30}, {0xfffffebu, 28}, {0xfffffecu, 28},
  {0xfffffedu, 28}, {0xfffffeeu, 28}, {0xfffffefu, 28}, {0xffffff0u, 28},
  {0xffffff1u, 28}, {0xffffff2u, 28}, {0x3ffffffeu, 30}, {0xffffff3u, 28},
  {0xffffff4u, 28}, {0xffffff5u, 28}, {0xffffff6u, 28}, {0xffffff7u, 28},
  {0xffffff8u, 28}, {0xffffff9u, 28}, {0xffffffau, 28}, {0xffffffbu, 28},
  {0x14u, 6}, {0x3f8u, 10}, {0x3f9u, 10}, {0xffau, 12},
  {0x1ff9u, 13}, {0x15u, 6}, {0xf8u, 8}, {0x7fau, 11},
  {0x3fau, 10}, {0x3fbu, 10}, {0xf9u, 8}, {0x7fbu, 11},
  {0xfau, 8}, {0x16u, 6}, {0x17u, 6}, {0x18u, 6},
  {0x0u, 5}, {0x1u, 5}, {0x2u, 5}, {0x19u, 6},
  {0x1au, 6}, {0x1bu, 6}, {0x1cu, 6}, {0x1du, 6},
  {0x1eu, 6}, {0x1fu, 6}, {0x5cu, 7}, {0xfbu, 8},
  {0x7ffcu, 15}, {0x20u, 6}, {0xffbu, 12}, {0x3fcu, 10},
  {0x1ffau, 13}, {0x21u, 6}, {0x5du, 7}, {0x5eu, 7},
  {0x5fu, 7}, {0x60u, 7}, {0x61u, 7}, {0x62u, 7},
  {0x63u, 7}, {0x64u, 7}, {0x65u, 7}, {0x66u, 7},
  {0x67u, 7}, {0x68u, 7}, {0x69u, 7}, {0x6au, 7},
  {0x6bu, 7}, {0x6cu, 7}, {0x6du, 7}, {0x6eu, 7},
  {0x6fu, 7}, {0x70u, 7}, {0x71u, 7}, {0x72u, 7},
  {0xfcu, 8}, {0x73u, 7}, {0xfdu, 8}, {0x1ffbu, 13},
  {0x7fff0u, 19}, {0x1ffcu, 13}, {0x3ffcu, 14}, {0x22u, 6},
  {0x7ffdu, 15}, {0x3u, 5}, {0x23u, 6}, {0x4u, 5},
  {0x24u, 6}, {0x5u, 5}, {0x25u, 6}, {0x26u, 6},
  {0x27u, 6}, {0x6u, 5}, {0x74u, 7}, {0x75u, 7},
  {0x28u, 6}, {0x29u, 6}, {0x2au, 6}, {0x7u, 5},
  {0x2bu, 6}, {0x76u, 7}, {0x2cu, 6}, {0x8u, 5},
  {0x9u, 5}, {0x2du, 6}, {0x77u, 7}, {0x78u, 7},
  {0x79u, 7}, {0x7au, 7}, {0x7bu, 7}, {0x7ffeu, 15},
  {0x7fcu, 11}, {0x3ffdu, 14}, {0x1ffdu, 13}, {0xffffffcu, 28},
  {0xfffe6u, 20}, {0x3fffd2u, 22}, {0xfffe7u, 20}, {0xfffe8u, 20},
  {0x3fffd3u, 22}, {0x3fffd4u, 22}, {0x3fffd5u, 22}, {0x7fffd9u, 23},
  {0x3fffd6u, 22}, {0x7fffdau, 23}, {0x7fffdbu, 23}, {0x7fffdcu, 23},
  {0x7fffddu, 23}, {0x7fffdeu, 23}, {0xffffebu, 24}, {0x7fffdfu, 23},
  {0xffffecu, 24}, {0xffffedu, 24}, {0x3fffd7u, 22}, {0x7fffe0u, 23},
  {0xffffeeu, 24}, {0x7fffe1u, 23}, {0x7fffe2u, 23}, {0x7fffe3u, 23},
  {0x7fffe4u, 23}, {0x1fffdcu, 21}, {0x3fffd8u, 22}, {0x7fffe5u, 23},
  {0x3fffd9u, 22}, {0x7fffe6u, 23}, {0x7fffe7u, 23}, {0xffffefu, 24},
  {0x3fffdau, 22}, {0x1fffddu, 21}, {0xfffe9u, 20}, {0x3fffdbu, 22},
  {0x3fffdcu, 22}, {0x7fffe8u, 23}, {0x7fffe9u, 23}, {0x1fffdeu, 21},
  {0x7fffeau, 23}, {0x3fffddu, 22}, {0x3fffdeu, 22}, {0xfffff0u, 24},
  {0x1fffdfu, 21}, {0x3fffdfu, 22}, {0x7fffebu, 23}, {0x7fffecu, 23},
  {0x1fffe0u, 21}, {0x1fffe1u, 21}, {0x3fffe0u, 22}, {0x1fffe2u, 21},
  {0x7fffedu, 23}, {0x3fffe1u, 22}, {0x7fffeeu, 23}, {0x7fffefu, 23},
  {0xfffeau, 20}, {0x3fffe2u, 22}, {0x3fffe3u, 22}, {0x3fffe4u, 22},
  {0x7ffff0u, 23}, {0x3fffe5u, 22}, {0x3fffe6u, 22}, {0x7ffff1u, 23},
  {0x3ffffe0u, 26}, {0x3ffffe1u, 26}, {0xfffebu, 20}, {0x7fff1u, 19},
  {0x3fffe7u, 22}, {0x7ffff2u, 23}, {0x3fffe8u, 22}, {0x1ffffecu, 25},
  {0x3ffffe2u, 26}, {0x3ffffe3u, 26}, {0x3ffffe4u, 26}, {0x7ffffdeu, 27},
  {0x7ffffdfu, 27}, {0x3ffffe5u, 26}, {0xfffff1u, 24}, {0x1ffffedu, 25},
  {0x7fff2u, 19}, {0x1fffe3u, 21}, {0x3ffffe6u, 26}, {0x7ffffe0u, 27},
  {0x7ffffe1u, 27}, {0x3ffffe7u, 26}, {0x7ffffe2u, 27}, {0xfffff2u, 24},
  {0x1fffe4u, 21}, {0x1fffe5u, 21}, {0x3ffffe8u, 26}, {0x3ffffe9u, 26},
  {0xffffffdu, 28}, {0x7ffffe3u, 27}, {0x7ffffe4u, 27}, {0x7ffffe5u, 27},
  {0xfffecu, 20}, {0xfffff3u, 24}, {0xfffedu, 20}, {0x1fffe6u, 21},
  {0x3fffe9u, 22}, {0x1fffe7u, 21}, {0x1fffe8u, 21}, {0x7ffff3u, 23},
  {0x3fffeau, 22}, {0x3fffebu, 22}, {0x1ffffeeu, 25}, {0x1ffffefu, 25},
  {0xfffff4u, 24}, {0xfffff5u, 24}, {0x3ffffeau, 26}, {0x7ffff4u, 23},
  {0x3ffffebu, 26}, {0x7ffffe6u, 27}, {0x3ffffecu, 26}, {0x3ffffedu, 26},
  {0x7ffffe7u, 27}, {0x7ffffe8u, 27}, {0x7ffffe9u, 27}, {0x7ffffeau, 27},
  {0x7ffffebu, 27}, {0xffffffeu, 28}, {0x7ffffecu, 27}, {0x7ffffedu, 27},
  {0x7ffffeeu, 27}, {0x7ffffefu, 27}, {0x7fffff0u, 27}, {0x3ffffeeu, 26},
  {0x3fffffffu, 30},
};

static const ScrH2StaticEntry SCR_H2_STATIC[61] = {
  {":authority", ""},
  {":method", "GET"},
  {":method", "POST"},
  {":path", "/"},
  {":path", "/index.html"},
  {":scheme", "http"},
  {":scheme", "https"},
  {":status", "200"},
  {":status", "204"},
  {":status", "206"},
  {":status", "304"},
  {":status", "400"},
  {":status", "404"},
  {":status", "500"},
  {"accept-charset", ""},
  {"accept-encoding", "gzip, deflate"},
  {"accept-language", ""},
  {"accept-ranges", ""},
  {"accept", ""},
  {"access-control-allow-origin", ""},
  {"age", ""},
  {"allow", ""},
  {"authorization", ""},
  {"cache-control", ""},
  {"content-disposition", ""},
  {"content-encoding", ""},
  {"content-language", ""},
  {"content-length", ""},
  {"content-location", ""},
  {"content-range", ""},
  {"content-type", ""},
  {"cookie", ""},
  {"date", ""},
  {"etag", ""},
  {"expect", ""},
  {"expires", ""},
  {"from", ""},
  {"host", ""},
  {"if-match", ""},
  {"if-modified-since", ""},
  {"if-none-match", ""},
  {"if-range", ""},
  {"if-unmodified-since", ""},
  {"last-modified", ""},
  {"link", ""},
  {"location", ""},
  {"max-forwards", ""},
  {"proxy-authenticate", ""},
  {"proxy-authorization", ""},
  {"range", ""},
  {"referer", ""},
  {"refresh", ""},
  {"retry-after", ""},
  {"server", ""},
  {"set-cookie", ""},
  {"strict-transport-security", ""},
  {"transfer-encoding", ""},
  {"user-agent", ""},
  {"vary", ""},
  {"via", ""},
  {"www-authenticate", ""},
};

/* ── Huffman decoding (bit-walk over a tree built once) ──────────────── */

typedef struct ScrH2HuffNode {
  struct ScrH2HuffNode *child[2];
  int sym; /* -1 = interior */
} ScrH2HuffNode;

static ScrH2HuffNode *scr_h2_huff_root = NULL;

static ScrH2HuffNode *scr_h2_huff_node(void) {
  ScrH2HuffNode *n = calloc(1, sizeof *n);
  if (!n) scr_h2_oom();
  n->sym = -1;
  return n;
}

static void scr_h2_huff_init(void) {
  if (scr_h2_huff_root) return;
  scr_h2_huff_root = scr_h2_huff_node();
  for (int s = 0; s < 257; s++) {
    ScrH2HuffNode *n = scr_h2_huff_root;
    for (int b = SCR_H2_HUFF[s].len - 1; b >= 0; b--) {
      int bit = (SCR_H2_HUFF[s].code >> b) & 1;
      if (!n->child[bit]) n->child[bit] = scr_h2_huff_node();
      n = n->child[bit];
    }
    n->sym = s;
  }
}

/* Decode `n` Huffman bytes into a malloc'd buffer (*out, *out_len).
 * False on EOS-in-string or a truncated non-padding tail. */
static bool scr_h2_huff_decode(const uint8_t *p, size_t n, char **out, size_t *out_len) {
  scr_h2_huff_init();
  size_t cap = n * 2 + 8;
  char *buf = malloc(cap);
  if (!buf) scr_h2_oom();
  size_t len = 0;
  ScrH2HuffNode *node = scr_h2_huff_root;
  int depth = 0; /* bits since the last emitted symbol (padding check) */
  for (size_t i = 0; i < n; i++) {
    for (int b = 7; b >= 0; b--) {
      int bit = (p[i] >> b) & 1;
      node = node->child[bit];
      depth++;
      if (!node) { free(buf); return false; }
      if (node->sym >= 0) {
        if (node->sym == 256) { free(buf); return false; } /* EOS in string */
        if (len == cap) {
          cap *= 2;
          buf = realloc(buf, cap);
          if (!buf) scr_h2_oom();
        }
        buf[len++] = (char)node->sym;
        node = scr_h2_huff_root;
        depth = 0;
      }
    }
  }
  /* Padding must be a prefix of EOS (all-ones), at most 7 bits: the
   * walk from the root must not have consumed 8+ bits, and every
   * consumed bit must have been 1 — the all-ones path from the root. */
  if (depth > 7) { free(buf); return false; }
  ScrH2HuffNode *ones = scr_h2_huff_root;
  for (int i = 0; i < depth; i++) ones = ones->child[1];
  if (node != ones) { free(buf); return false; }
  *out = buf;
  *out_len = len;
  return true;
}

/* ── HPACK decoder (RFC 7541) ────────────────────────────────────────── */

typedef struct {
  char *name;
  size_t name_len;
  char *value;
  size_t value_len;
} ScrH2TableEntry;

/* The dynamic table: a ring of entries, newest at (head-1). Size
 * accounting per RFC 7541 §4.1 (32 bytes overhead per entry). */
typedef struct {
  ScrH2TableEntry *e;
  size_t cap;   /* ring capacity (entries) */
  size_t head;  /* next insert slot */
  size_t n;     /* live entries */
  size_t size;  /* octets per §4.1 */
  size_t max;   /* current max (SETTINGS value, lowered by updates) */
  size_t settings_max; /* the SETTINGS_HEADER_TABLE_SIZE ceiling */
} ScrH2Dyntab;

static void scr_h2_dyntab_init(ScrH2Dyntab *t) {
  memset(t, 0, sizeof *t);
  t->max = 4096;
  t->settings_max = 4096;
}

static void scr_h2_dyntab_evict(ScrH2Dyntab *t, size_t need) {
  while (t->n > 0 && t->size + need > t->max) {
    size_t oldest = (t->head + t->cap - t->n) % t->cap;
    ScrH2TableEntry *e = &t->e[oldest];
    t->size -= e->name_len + e->value_len + 32;
    free(e->name);
    free(e->value);
    t->n--;
  }
}

static void scr_h2_dyntab_add(ScrH2Dyntab *t, const char *name, size_t name_len,
                               const char *value, size_t value_len) {
  size_t need = name_len + value_len + 32;
  scr_h2_dyntab_evict(t, need);
  if (need > t->max) return; /* larger than the table: evicts all, adds nothing */
  if (t->n == t->cap) {
    size_t ncap = t->cap ? t->cap * 2 : 16;
    ScrH2TableEntry *ne = malloc(ncap * sizeof *ne);
    if (!ne) scr_h2_oom();
    /* re-lay the ring oldest-first */
    for (size_t i = 0; i < t->n; i++) {
      size_t idx = (t->head + t->cap - t->n + i) % t->cap;
      ne[i] = t->e[idx];
    }
    free(t->e);
    t->e = ne;
    t->cap = ncap;
    t->head = t->n;
  }
  ScrH2TableEntry *e = &t->e[t->head];
  e->name = malloc(name_len + 1);
  e->value = malloc(value_len + 1);
  if (!e->name || !e->value) scr_h2_oom();
  memcpy(e->name, name, name_len);
  e->name[name_len] = 0;
  memcpy(e->value, value, value_len);
  e->value[value_len] = 0;
  e->name_len = name_len;
  e->value_len = value_len;
  t->head = (t->head + 1) % t->cap;
  t->n++;
  t->size += need;
}

static void scr_h2_dyntab_free(ScrH2Dyntab *t) {
  for (size_t i = 0; i < t->n; i++) {
    size_t idx = (t->head + t->cap - t->n + i) % t->cap;
    free(t->e[idx].name);
    free(t->e[idx].value);
  }
  free(t->e);
  memset(t, 0, sizeof *t);
}

/* index 1..61 static, 62.. dynamic (newest first). False = bad index. */
static bool scr_h2_table_lookup(const ScrH2Dyntab *t, uint64_t idx,
                                 const char **name, size_t *name_len,
                                 const char **value, size_t *value_len) {
  if (idx >= 1 && idx <= 61) {
    const ScrH2StaticEntry *e = &SCR_H2_STATIC[idx - 1];
    *name = e->name;
    *name_len = strlen(e->name);
    *value = e->value;
    *value_len = strlen(e->value);
    return true;
  }
  if (idx >= 62 && idx - 62 < t->n) {
    size_t back = (size_t)(idx - 62); /* 0 = newest */
    size_t slot = (t->head + t->cap - 1 - back) % t->cap;
    const ScrH2TableEntry *e = &t->e[slot];
    *name = e->name;
    *name_len = e->name_len;
    *value = e->value;
    *value_len = e->value_len;
    return true;
  }
  return false;
}

/* §5.1 integer decode. False on truncation/overflow. */
static bool scr_h2_int_decode(const uint8_t **pp, const uint8_t *end, int prefix_bits,
                               uint64_t *out) {
  if (*pp >= end) return false;
  uint64_t max_prefix = (1u << prefix_bits) - 1;
  uint64_t v = **pp & max_prefix;
  (*pp)++;
  if (v < max_prefix) {
    *out = v;
    return true;
  }
  int shift = 0;
  for (;;) {
    if (*pp >= end || shift > 56) return false;
    uint8_t b = **pp;
    (*pp)++;
    v += (uint64_t)(b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) == 0) break;
  }
  *out = v;
  return true;
}

/* §5.2 string literal: length-prefixed, optionally Huffman. The result
 * is always a fresh malloc'd buffer the caller frees. */
static bool scr_h2_str_decode(const uint8_t **pp, const uint8_t *end,
                               char **out, size_t *out_len) {
  if (*pp >= end) return false;
  bool huff = (**pp & 0x80) != 0;
  uint64_t len;
  if (!scr_h2_int_decode(pp, end, 7, &len)) return false;
  if ((uint64_t)(end - *pp) < len) return false;
  if (huff) {
    if (!scr_h2_huff_decode(*pp, (size_t)len, out, out_len)) return false;
  } else {
    char *buf = malloc((size_t)len + 1);
    if (!buf) scr_h2_oom();
    memcpy(buf, *pp, (size_t)len);
    buf[len] = 0;
    *out = buf;
    *out_len = (size_t)len;
  }
  *pp += len;
  return true;
}

/* One decoded header list: parallel ScrStr arrays (the ScrHttpReq header
 * storage shape — names arrive lowercase on a valid h2 wire). */
typedef struct {
  ScrStr **names;  /* each +1 */
  ScrStr **values; /* each +1 */
  size_t n, cap;
} ScrH2Headers;

static void scr_h2_headers_push(ScrH2Headers *h, ScrStr *name /*moves*/, ScrStr *value /*moves*/) {
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 8;
    h->names = realloc(h->names, h->cap * sizeof *h->names);
    h->values = realloc(h->values, h->cap * sizeof *h->values);
    if (!h->names || !h->values) scr_h2_oom();
  }
  h->names[h->n] = name;
  h->values[h->n] = value;
  h->n++;
}

static void scr_h2_headers_free(ScrH2Headers *h) {
  for (size_t i = 0; i < h->n; i++) {
    scr_str_release(h->names[i]);
    scr_str_release(h->values[i]);
  }
  free(h->names);
  free(h->values);
  memset(h, 0, sizeof *h);
}

/* Decode a complete header block into `out`. False = COMPRESSION_ERROR. */
static bool scr_h2_hpack_decode(ScrH2Dyntab *t, const uint8_t *p, size_t n, ScrH2Headers *out) {
  const uint8_t *end = p + n;
  while (p < end) {
    uint8_t b = *p;
    if (b & 0x80) {
      /* §6.1 indexed */
      uint64_t idx;
      if (!scr_h2_int_decode(&p, end, 7, &idx)) return false;
      const char *nm, *vl;
      size_t nl, vll;
      if (idx == 0 || !scr_h2_table_lookup(t, idx, &nm, &nl, &vl, &vll)) return false;
      scr_h2_headers_push(out, scr_str_new(nm, nl), scr_str_new(vl, vll));
      continue;
    }
    if ((b & 0xe0) == 0x20) {
      /* §6.3 dynamic table size update */
      uint64_t sz;
      if (!scr_h2_int_decode(&p, end, 5, &sz)) return false;
      if (sz > t->settings_max) return false;
      t->max = (size_t)sz;
      scr_h2_dyntab_evict(t, 0);
      continue;
    }
    /* §6.2 literals: incremental (01xxxxxx, 6-bit name index), without
     * indexing (0000xxxx), never indexed (0001xxxx) — 4-bit name index. */
    bool incremental = (b & 0xc0) == 0x40;
    int prefix = incremental ? 6 : 4;
    uint64_t idx;
    if (!scr_h2_int_decode(&p, end, prefix, &idx)) return false;
    char *name;
    size_t name_len;
    bool name_owned = false;
    if (idx == 0) {
      if (!scr_h2_str_decode(&p, end, &name, &name_len)) return false;
      name_owned = true;
    } else {
      const char *nm, *vl;
      size_t nl, vll;
      if (!scr_h2_table_lookup(t, idx, &nm, &nl, &vl, &vll)) return false;
      name = (char *)nm;
      name_len = nl;
    }
    char *value;
    size_t value_len;
    if (!scr_h2_str_decode(&p, end, &value, &value_len)) {
      if (name_owned) free(name);
      return false;
    }
    if (incremental) scr_h2_dyntab_add(t, name, name_len, value, value_len);
    scr_h2_headers_push(out, scr_str_new(name, name_len), scr_str_new(value, value_len));
    if (name_owned) free(name);
    free(value);
  }
  return true;
}

/* ── HPACK encoder (static-match + literal-without-indexing) ─────────── */

typedef struct {
  char *data;
  size_t len, cap;
} ScrH2Buf;

static void scr_h2_buf_reserve(ScrH2Buf *b, size_t extra) {
  if (b->len + extra <= b->cap) return;
  size_t ncap = b->cap ? b->cap : 256;
  while (ncap < b->len + extra) ncap *= 2;
  b->data = realloc(b->data, ncap);
  if (!b->data) scr_h2_oom();
  b->cap = ncap;
}

static void scr_h2_buf_put(ScrH2Buf *b, const void *p, size_t n) {
  scr_h2_buf_reserve(b, n);
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void scr_h2_buf_u8(ScrH2Buf *b, uint8_t v) { scr_h2_buf_put(b, &v, 1); }

static void scr_h2_int_encode(ScrH2Buf *b, uint8_t first_bits, int prefix_bits, uint64_t v) {
  uint64_t max_prefix = (1u << prefix_bits) - 1;
  if (v < max_prefix) {
    scr_h2_buf_u8(b, (uint8_t)(first_bits | v));
    return;
  }
  scr_h2_buf_u8(b, (uint8_t)(first_bits | max_prefix));
  v -= max_prefix;
  while (v >= 128) {
    scr_h2_buf_u8(b, (uint8_t)(v % 128 + 128));
    v /= 128;
  }
  scr_h2_buf_u8(b, (uint8_t)v);
}

static void scr_h2_str_encode(ScrH2Buf *b, const char *s, size_t n) {
  scr_h2_int_encode(b, 0x00, 7, n); /* no Huffman bit */
  scr_h2_buf_put(b, s, n);
}

/* Encode one header. Exact static match → indexed; static name match →
 * literal-without-indexing with indexed name; else both literal. */
static void scr_h2_hpack_encode(ScrH2Buf *b, const char *name, size_t name_len,
                                 const char *value, size_t value_len) {
  int name_idx = 0;
  for (int i = 0; i < 61; i++) {
    const ScrH2StaticEntry *e = &SCR_H2_STATIC[i];
    if (strlen(e->name) != name_len || memcmp(e->name, name, name_len) != 0) continue;
    if (name_idx == 0) name_idx = i + 1;
    if (strlen(e->value) == value_len && memcmp(e->value, value, value_len) == 0) {
      scr_h2_int_encode(b, 0x80, 7, (uint64_t)(i + 1));
      return;
    }
  }
  scr_h2_int_encode(b, 0x00, 4, (uint64_t)name_idx);
  if (name_idx == 0) scr_h2_str_encode(b, name, name_len);
  scr_h2_str_encode(b, value, value_len);
}

/* ── frames (RFC 7540 §4, §6) ────────────────────────────────────────── */

enum {
  SCR_H2_F_DATA = 0x0,
  SCR_H2_F_HEADERS = 0x1,
  SCR_H2_F_PRIORITY = 0x2,
  SCR_H2_F_RST_STREAM = 0x3,
  SCR_H2_F_SETTINGS = 0x4,
  SCR_H2_F_PUSH_PROMISE = 0x5,
  SCR_H2_F_PING = 0x6,
  SCR_H2_F_GOAWAY = 0x7,
  SCR_H2_F_WINDOW_UPDATE = 0x8,
  SCR_H2_F_CONTINUATION = 0x9,
};

enum {
  SCR_H2_FLAG_END_STREAM = 0x1,  /* DATA, HEADERS */
  SCR_H2_FLAG_ACK = 0x1,         /* SETTINGS, PING */
  SCR_H2_FLAG_END_HEADERS = 0x4, /* HEADERS, PUSH_PROMISE, CONTINUATION */
  SCR_H2_FLAG_PADDED = 0x8,      /* DATA, HEADERS, PUSH_PROMISE */
  SCR_H2_FLAG_PRIORITY = 0x20,   /* HEADERS */
};

/* NGHTTP2 error-code names (RST_STREAM / GOAWAY codes 0..13) — the
 * ERR_HTTP2_STREAM_ERROR message vocabulary. */
static const char *const SCR_H2_CODE_NAMES[] = {
  "NGHTTP2_NO_ERROR", "NGHTTP2_PROTOCOL_ERROR", "NGHTTP2_INTERNAL_ERROR",
  "NGHTTP2_FLOW_CONTROL_ERROR", "NGHTTP2_SETTINGS_TIMEOUT", "NGHTTP2_STREAM_CLOSED",
  "NGHTTP2_FRAME_SIZE_ERROR", "NGHTTP2_REFUSED_STREAM", "NGHTTP2_CANCEL",
  "NGHTTP2_COMPRESSION_ERROR", "NGHTTP2_CONNECT_ERROR", "NGHTTP2_ENHANCE_YOUR_CALM",
  "NGHTTP2_INADEQUATE_SECURITY", "NGHTTP2_HTTP_1_1_REQUIRED",
};

static const char *scr_h2_code_name(uint32_t code) {
  if (code < sizeof SCR_H2_CODE_NAMES / sizeof *SCR_H2_CODE_NAMES) {
    return SCR_H2_CODE_NAMES[code];
  }
  return NULL;
}

static const char SCR_H2_PREFACE[24] = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

enum {
  SCR_H2_DEFAULT_WINDOW = 65535,
  SCR_H2_DEFAULT_MAX_FRAME = 16384,
};

/* ── the handles ─────────────────────────────────────────────────────── */

/* Stream state: the RFC machine collapsed to what the API observes. */
enum {
  SCR_H2_S_OPEN = 0,
  SCR_H2_S_CLOSED_LOCAL = 1,  /* END_STREAM sent */
  SCR_H2_S_CLOSED_REMOTE = 2, /* END_STREAM received */
  SCR_H2_S_CLOSED = 3,
};

typedef struct ScrH2Chunk {
  struct ScrH2Chunk *next;
  size_t len;
  char data[];
} ScrH2Chunk;

struct ScrH2Stream {
  size_t rc;
  int32_t id;
  int state;
  bool destroyed;
  bool aborted;         /* remote quit before END_STREAM */
  uint32_t rst_code;    /* stream.rstCode — set by either side's RST */
  bool rst_sent, rst_recv;
  bool respond_sent;    /* server: respond() ran */
  bool want_end;        /* end() called; END_STREAM rides the last flush */
  bool end_recv;        /* END_STREAM arrived */
  bool end_emitted;
  bool close_queued, close_emitted;
  bool err_code_queued; /* a nonzero-code 'error' rides the close sweep */
  bool flowing;         /* a 'data' listener or resume(); pause() clears */
  bool had_data;        /* a nonempty DATA frame arrived (the empty-body
                         * 'end' rule: nothing to consume — Node emits
                         * 'end' without a reader) */
  bool enc_utf8;        /* setEncoding('utf8') */
  struct ScrH2Session *sess; /* +1 for the stream's whole life */
  /* the compat pair (Http2ServerRequest/Response over this stream), +1
   * each; the settle releases both — that break unwinds the stream↔res
   * ownership cycle (res holds the stream through the ops vtable) */
  ScrHttpReq *compat_req;
  ScrHttpRes *compat_res;
  /* recv queue (paused-mode buffering), one node per DATA frame */
  ScrH2Chunk *rq_head, *rq_tail;
  /* send buffer for window-blocked bytes */
  ScrH2Buf wbuf;
  int64_t send_window;
  ScrNetLs data_ls, end_ls, close_ls, err_ls, resp_ls, aborted_ls, ready_ls,
      trailers_ls, wanttrailers_ls, push_ls, frameerr_ls;
};

/* The server-side ctx (the ScrHttpSrvCtx shape; `proto` FIRST — the
 * http_ctx alias slot is shared with scr_http.c's parser family). */
typedef struct ScrH2SrvCtx {
  int proto; /* SCR_NET_PROTO_H2 */
  size_t rc;
  ScrNetLs stream_ls;
  ScrNetLs session_ls;
  ScrNetLs request_ls; /* the compat (req, res) listeners — createServer's
                         * eager handler and server.on("request", ...) */
  ScrNetLs connect_ls; /* traditional/RFC 8441 CONNECT (req, res) listeners */
  ScrNetLs session_error_ls; /* server 'sessionError' (err, session) */
  void *http1_ctx;     /* borrowed: owned by the TLS wrapper's inner hook */
  bool enable_connect_protocol;
} ScrH2SrvCtx;

/* The SETTINGS the API observes (session.localSettings/remoteSettings —
 * Node's record shape; maxHeaderSize aliases maxHeaderListSize). */
typedef struct {
  uint32_t header_table_size;
  bool enable_push;
  uint32_t initial_window_size;
  uint32_t max_frame_size;
  uint32_t max_concurrent_streams;
  uint32_t max_header_list_size;
  bool enable_connect_protocol;
} ScrH2Settings;

static void scr_h2_settings_defaults(ScrH2Settings *s) {
  s->header_table_size = 4096;
  s->enable_push = true;
  s->initial_window_size = 65535;
  s->max_frame_size = 16384;
  s->max_concurrent_streams = 0xffffffffu;
  s->max_header_list_size = 65535;
  s->enable_connect_protocol = false;
}

struct ScrH2Session {
  size_t rc;
  bool client;
  bool destroyed;
  bool closed;          /* close() called (graceful GOAWAY) */
  bool close_queued, close_emitted;
  bool connect_queued;  /* client 'connect' emit pending */
  bool preface_done;    /* server: magic received; client: always true */
  bool goaway_sent, goaway_recv;
  uint32_t goaway_code;
  ScrNetSocket *sock;   /* +1; dropped (NULLed) when the socket closes */
  ScrH2SrvCtx *srv;     /* +1; NULL on client sessions */
  /* frame reassembly */
  char *rbuf;
  size_t rlen, rcap;
  /* an in-flight header block (HEADERS + CONTINUATIONs) */
  ScrH2Buf hblock;
  int32_t hblock_stream;
  uint8_t hblock_flags;
  bool hblock_active;
  /* HPACK */
  ScrH2Dyntab dec_table;
  /* client: the :authority default (host[:port] from the connect URL) */
  char *authority;
  size_t authority_len;
  /* streams (live vector, each +1) */
  ScrH2Stream **streams;
  size_t nstreams, streams_cap;
  int32_t next_stream_id;      /* client request ids: 1, 3, 5, ... */
  int32_t last_recv_stream_id; /* the GOAWAY last-stream answer */
  /* flow control + peer settings */
  int64_t send_window;
  uint32_t peer_max_frame;
  uint32_t peer_init_window;
  /* the API-visible settings records + the in-flight local ack */
  ScrH2Settings local_settings, remote_settings;
  bool pending_settings_ack;
  bool error_emitted;
  ScrNetLs stream_ls, close_ls, err_ls, connect_ls, goaway_ls,
      remote_settings_ls, local_settings_ls;
};

/* ── refcounts + the RC audit ────────────────────────────────────────── */

#ifdef SCR_RC_AUDIT
static long scr_h2_sessions_live = 0;
static long scr_h2_streams_live = 0;
long scr_http2_live_count(void) { return scr_h2_sessions_live + scr_h2_streams_live; }
#endif

ScrH2Session *scr_http2_session_retain(ScrH2Session *s) {
  if (s && s->rc != SIZE_MAX) s->rc++;
  return s;
}

static void scr_h2_session_free(ScrH2Session *s);

void scr_http2_session_release(ScrH2Session *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) scr_h2_session_free(s);
}

void *scr_http2_session_retain_v(void *p) { return scr_http2_session_retain(p); }
void scr_http2_session_release_v(void *p) { scr_http2_session_release(p); }

ScrH2Stream *scr_http2_stream_retain(ScrH2Stream *st) {
  if (st && st->rc != SIZE_MAX) st->rc++;
  return st;
}

static void scr_h2_stream_free(ScrH2Stream *st);

void scr_http2_stream_release(ScrH2Stream *st) {
  if (!st || st->rc == SIZE_MAX) return;
  if (--st->rc == 0) scr_h2_stream_free(st);
}

void *scr_http2_stream_retain_v(void *p) { return scr_http2_stream_retain(p); }
void scr_http2_stream_release_v(void *p) { scr_http2_stream_release(p); }

static ScrH2SrvCtx *scr_h2_srv_ctx_retain(ScrH2SrvCtx *ctx) {
  ctx->rc++;
  return ctx;
}

static void scr_h2_srv_ctx_release(ScrH2SrvCtx *ctx) {
  if (--ctx->rc > 0) return;
  scr_net_ls_drop(&ctx->stream_ls);
  scr_net_ls_drop(&ctx->session_ls);
  scr_net_ls_drop(&ctx->request_ls);
  scr_net_ls_drop(&ctx->connect_ls);
  scr_net_ls_drop(&ctx->session_error_ls);
  free(ctx);
}

static void scr_h2_stream_drop_lists(ScrH2Stream *st) {
  scr_net_ls_drop(&st->data_ls);
  scr_net_ls_drop(&st->end_ls);
  scr_net_ls_drop(&st->close_ls);
  scr_net_ls_drop(&st->err_ls);
  scr_net_ls_drop(&st->resp_ls);
  scr_net_ls_drop(&st->aborted_ls);
  scr_net_ls_drop(&st->ready_ls);
  scr_net_ls_drop(&st->trailers_ls);
  scr_net_ls_drop(&st->wanttrailers_ls);
  scr_net_ls_drop(&st->push_ls);
  scr_net_ls_drop(&st->frameerr_ls);
}

static void scr_h2_stream_free(ScrH2Stream *st) {
  scr_h2_stream_drop_lists(st);
  scr_http_req_release(st->compat_req);
  scr_http_res_release(st->compat_res);
  ScrH2Chunk *c = st->rq_head;
  while (c) {
    ScrH2Chunk *next = c->next;
    free(c);
    c = next;
  }
  free(st->wbuf.data);
  scr_http2_session_release(st->sess);
  free(st);
#ifdef SCR_RC_AUDIT
  scr_h2_streams_live--;
#endif
}

static void scr_h2_session_drop_lists(ScrH2Session *s) {
  scr_net_ls_drop(&s->stream_ls);
  scr_net_ls_drop(&s->close_ls);
  scr_net_ls_drop(&s->err_ls);
  scr_net_ls_drop(&s->connect_ls);
  scr_net_ls_drop(&s->goaway_ls);
  scr_net_ls_drop(&s->remote_settings_ls);
  scr_net_ls_drop(&s->local_settings_ls);
}

static void scr_h2_session_free(ScrH2Session *s) {
  scr_h2_session_drop_lists(s);
  for (size_t i = 0; i < s->nstreams; i++) scr_http2_stream_release(s->streams[i]);
  free(s->streams);
  free(s->rbuf);
  free(s->hblock.data);
  free(s->authority);
  scr_h2_dyntab_free(&s->dec_table);
  if (s->srv) scr_h2_srv_ctx_release(s->srv);
  if (s->sock) scr_net_sock_release(s->sock);
  free(s);
#ifdef SCR_RC_AUDIT
  scr_h2_sessions_live--;
#endif
}

/* ── the deferred-emit queue (the scr_http.c pattern) ────────────────── */

enum {
  SCR_H2_EMIT_STREAM_CLOSE,    /* 'error' (nonzero code) then 'close' */
  SCR_H2_EMIT_SESSION_CLOSE,   /* session 'close' */
  SCR_H2_EMIT_SESSION_CONNECT, /* client 'connect' */
  SCR_H2_EMIT_SERVER_SESSION,  /* server 'session' (h is the session) */
  SCR_H2_EMIT_STREAM_DRAIN,    /* deliver buffered data (+ maybe 'end') */
};

typedef struct {
  int kind;
  void *h; /* +1, typed by kind */
} ScrH2Emit;

static ScrH2Emit *scr_h2_emits = NULL;
static size_t scr_h2_emits_head = 0, scr_h2_emits_len = 0, scr_h2_emits_cap = 0;
static bool scr_h2_exiting = false;

static void scr_h2_emit_release(ScrH2Emit *e) {
  switch (e->kind) {
  case SCR_H2_EMIT_STREAM_CLOSE:
  case SCR_H2_EMIT_STREAM_DRAIN:
    scr_http2_stream_release((ScrH2Stream *)e->h);
    break;
  default:
    scr_http2_session_release((ScrH2Session *)e->h);
    break;
  }
}

static void scr_h2_emit_push(int kind, void *h /*moves +1*/) {
  if (scr_h2_exiting) {
    ScrH2Emit e = { kind, h };
    scr_h2_emit_release(&e);
    return;
  }
  if (scr_h2_emits_len == scr_h2_emits_cap) {
    if (scr_h2_emits_head > 0) {
      memmove(scr_h2_emits, scr_h2_emits + scr_h2_emits_head,
              (scr_h2_emits_len - scr_h2_emits_head) * sizeof *scr_h2_emits);
      scr_h2_emits_len -= scr_h2_emits_head;
      scr_h2_emits_head = 0;
    }
    if (scr_h2_emits_len == scr_h2_emits_cap) {
      scr_h2_emits_cap = scr_h2_emits_cap ? scr_h2_emits_cap * 2 : 8;
      scr_h2_emits = realloc(scr_h2_emits, scr_h2_emits_cap * sizeof *scr_h2_emits);
      if (!scr_h2_emits) scr_h2_oom();
    }
  }
  scr_h2_emits[scr_h2_emits_len].kind = kind;
  scr_h2_emits[scr_h2_emits_len].h = h;
  scr_h2_emits_len++;
}

/* ── frame send ──────────────────────────────────────────────────────── */

static bool scr_h2_sock_alive(ScrH2Session *s) {
  return s->sock != NULL && !scr_net_sock_destroyed(s->sock);
}

static void scr_h2_send_frame(ScrH2Session *s, uint8_t type, uint8_t flags,
                               int32_t stream_id, const void *payload, size_t n) {
  if (!scr_h2_sock_alive(s)) return;
  uint8_t head[9];
  head[0] = (uint8_t)(n >> 16);
  head[1] = (uint8_t)(n >> 8);
  head[2] = (uint8_t)n;
  head[3] = type;
  head[4] = flags;
  head[5] = (uint8_t)((uint32_t)stream_id >> 24) & 0x7f;
  head[6] = (uint8_t)((uint32_t)stream_id >> 16);
  head[7] = (uint8_t)((uint32_t)stream_id >> 8);
  head[8] = (uint8_t)stream_id;
  scr_net_sock_write_native(s->sock, (const char *)head, 9);
  if (n > 0) scr_net_sock_write_native(s->sock, payload, n);
}

static void scr_h2_send_settings(ScrH2Session *s) {
  /* Defaults on the wire — except the CLIENT's enablePush, which Node
   * pins to 0 (clients never accept pushes; localSettings reads false). */
  if (s->client) {
    static const uint8_t no_push[6] = { 0x0, 0x2, 0, 0, 0, 0 };
    scr_h2_send_frame(s, SCR_H2_F_SETTINGS, 0, 0, no_push, 6);
    return;
  }
  if (s->local_settings.enable_connect_protocol) {
    static const uint8_t enable_connect[6] = { 0x0, 0x8, 0, 0, 0, 1 };
    scr_h2_send_frame(s, SCR_H2_F_SETTINGS, 0, 0, enable_connect, 6);
    return;
  }
  scr_h2_send_frame(s, SCR_H2_F_SETTINGS, 0, 0, NULL, 0);
}

static void scr_h2_send_settings_ack(ScrH2Session *s) {
  scr_h2_send_frame(s, SCR_H2_F_SETTINGS, SCR_H2_FLAG_ACK, 0, NULL, 0);
}

static void scr_h2_send_rst(ScrH2Session *s, int32_t stream_id, uint32_t code) {
  uint8_t p[4] = { (uint8_t)(code >> 24), (uint8_t)(code >> 16), (uint8_t)(code >> 8), (uint8_t)code };
  scr_h2_send_frame(s, SCR_H2_F_RST_STREAM, 0, stream_id, p, 4);
}

static void scr_h2_send_window_update(ScrH2Session *s, int32_t stream_id, uint32_t inc) {
  uint8_t p[4] = { (uint8_t)(inc >> 24) & 0x7f, (uint8_t)(inc >> 16), (uint8_t)(inc >> 8), (uint8_t)inc };
  scr_h2_send_frame(s, SCR_H2_F_WINDOW_UPDATE, 0, stream_id, p, 4);
}

static void scr_h2_send_goaway(ScrH2Session *s, uint32_t code) {
  if (s->goaway_sent) return;
  s->goaway_sent = true;
  uint32_t last = (uint32_t)s->last_recv_stream_id;
  uint8_t p[8] = {
    (uint8_t)(last >> 24) & 0x7f, (uint8_t)(last >> 16), (uint8_t)(last >> 8), (uint8_t)last,
    (uint8_t)(code >> 24), (uint8_t)(code >> 16), (uint8_t)(code >> 8), (uint8_t)code,
  };
  scr_h2_send_frame(s, SCR_H2_F_GOAWAY, 0, 0, p, 8);
}

/* A header block as HEADERS (+ CONTINUATIONs past the peer's max frame). */
static void scr_h2_send_headers(ScrH2Session *s, int32_t stream_id, const ScrH2Buf *block,
                                 bool end_stream) {
  size_t max = s->peer_max_frame ? s->peer_max_frame : SCR_H2_DEFAULT_MAX_FRAME;
  size_t off = 0;
  bool first = true;
  do {
    size_t n = block->len - off;
    if (n > max) n = max;
    uint8_t type = first ? SCR_H2_F_HEADERS : SCR_H2_F_CONTINUATION;
    uint8_t flags = 0;
    if (first && end_stream) flags |= SCR_H2_FLAG_END_STREAM;
    if (off + n == block->len) flags |= SCR_H2_FLAG_END_HEADERS;
    scr_h2_send_frame(s, type, flags, stream_id, block->data + off, n);
    off += n;
    first = false;
  } while (off < block->len);
}

/* ── stream bookkeeping ──────────────────────────────────────────────── */

static ScrH2Stream *scr_h2_find_stream(ScrH2Session *s, int32_t id) {
  for (size_t i = 0; i < s->nstreams; i++) {
    if (s->streams[i]->id == id) return s->streams[i];
  }
  return NULL;
}

static ScrH2Stream *scr_h2_stream_new(ScrH2Session *sess, int32_t id) {
  ScrH2Stream *st = calloc(1, sizeof *st);
  if (!st) scr_h2_oom();
  st->rc = 1;
  st->id = id;
  st->sess = scr_http2_session_retain(sess);
  st->send_window = sess->peer_init_window ? (int64_t)sess->peer_init_window : SCR_H2_DEFAULT_WINDOW;
#ifdef SCR_RC_AUDIT
  scr_h2_streams_live++;
#endif
  if (sess->nstreams == sess->streams_cap) {
    sess->streams_cap = sess->streams_cap ? sess->streams_cap * 2 : 8;
    sess->streams = realloc(sess->streams, sess->streams_cap * sizeof *sess->streams);
    if (!sess->streams) scr_h2_oom();
  }
  sess->streams[sess->nstreams++] = scr_http2_stream_retain(st);
  return st;
}

/* Drop the session's ref on a settled stream (its 'close' is queued or
 * emitted — the vector entry is what kept it discoverable by id). */
static void scr_h2_session_forget_stream(ScrH2Session *s, ScrH2Stream *st) {
  for (size_t i = 0; i < s->nstreams; i++) {
    if (s->streams[i] == st) {
      memmove(s->streams + i, s->streams + i + 1, (s->nstreams - i - 1) * sizeof *s->streams);
      s->nstreams--;
      scr_http2_stream_release(st);
      return;
    }
  }
}

static void scr_h2_session_maybe_finish_close(ScrH2Session *s);

/* Queue the stream's 'close' (idempotent) and forget it session-side. */
static void scr_h2_stream_settle(ScrH2Stream *st) {
  if (st->close_queued || st->close_emitted) return;
  st->close_queued = true;
  st->state = SCR_H2_S_CLOSED;
  /* the compat pair settles with the stream: req 'aborted' fires NOW for
   * abnormal teardowns, res/req 'close' ride scr_http.c's emit queue
   * (res before req — the http/1 drop order), and BOTH refs release —
   * the break that unwinds the stream↔res ownership cycle */
  if (st->compat_req != NULL || st->compat_res != NULL) {
    ScrHttpReq *req = st->compat_req;
    ScrHttpRes *res = st->compat_res;
    st->compat_req = NULL;
    st->compat_res = NULL;
    if (req != NULL && st->aborted) scr_http_h2_req_aborted(req);
    if (res != NULL) scr_http_h2_res_close(res);
    if (req != NULL) scr_http_h2_req_close(req);
    scr_http_res_release(res);
    scr_http_req_release(req);
  }
  scr_h2_emit_push(SCR_H2_EMIT_STREAM_CLOSE, scr_http2_stream_retain(st));
  ScrH2Session *sess = st->sess;
  scr_h2_session_forget_stream(sess, st);
  scr_h2_session_maybe_finish_close(sess);
}

/* ── data receive: paused-mode queue + flowing delivery ──────────────── */

static void scr_h2_stream_rq_push(ScrH2Stream *st, const char *data, size_t n) {
  ScrH2Chunk *c = malloc(sizeof *c + n);
  if (!c) scr_h2_oom();
  c->next = NULL;
  c->len = n;
  memcpy(c->data, data, n);
  if (st->rq_tail) st->rq_tail->next = c;
  else st->rq_head = c;
  st->rq_tail = c;
}

static void scr_h2_stream_fire_data(ScrH2Stream *st, const char *data, size_t n) {
  if (st->data_ls.n == 0) return;
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(chunk->data, data, n);
  ScrNetL *snap;
  size_t nl = scr_net_ls_snapshot(&st->data_ls, &snap);
  scr_dyn_this_push(st, SCR_DYNH_H2_STREAM);
  scr_dyn_chunk_enc(st->enc_utf8);
  for (size_t i = 0; i < nl; i++) {
    if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, chunk);
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_chunk_enc(false);
  scr_dyn_this_pop();
  free(snap);
  scr_bytes_release(chunk);
}

static void scr_h2_stream_maybe_emit_end(ScrH2Stream *st) {
  if (st->end_emitted || !st->end_recv || st->rq_head != NULL) return;
  /* FLOWING is Node's consumption gate — except an EMPTY body, which has
   * nothing to consume: Node emits 'end' there without a reader. */
  if (!st->flowing && st->had_data) return;
  if (st->destroyed) return;
  st->end_emitted = true;
  scr_net_fire0_this(&st->end_ls, st, SCR_DYNH_H2_STREAM);
  if (scr_exc_pending()) return;
  /* fully done? both halves closed → settle */
  if (st->state == SCR_H2_S_CLOSED_REMOTE || st->state == SCR_H2_S_CLOSED) {
    /* our half must be done too before the close */
    if (st->want_end && st->wbuf.len == 0) scr_h2_stream_settle(st);
    else if (st->state == SCR_H2_S_CLOSED) scr_h2_stream_settle(st);
  }
}

/* Drain the paused-mode queue into 'data' listeners (flowing only). */
static void scr_h2_stream_drain(ScrH2Stream *st) {
  while (st->flowing && st->rq_head) {
    ScrH2Chunk *c = st->rq_head;
    st->rq_head = c->next;
    if (!st->rq_head) st->rq_tail = NULL;
    scr_h2_stream_fire_data(st, c->data, c->len);
    free(c);
    if (scr_exc_pending()) return;
  }
  scr_h2_stream_maybe_emit_end(st);
}

static void scr_h2_stream_queue_drain(ScrH2Stream *st) {
  scr_h2_emit_push(SCR_H2_EMIT_STREAM_DRAIN, scr_http2_stream_retain(st));
}

/* ── the sweep (deferred emits) ──────────────────────────────────────── */

static bool scr_h2_proto_pending(void) { return scr_h2_emits_head < scr_h2_emits_len; }

static void scr_h2_proto_sweep(void) {
  while (scr_h2_emits_head < scr_h2_emits_len) {
    ScrH2Emit e = scr_h2_emits[scr_h2_emits_head++];
    switch (e.kind) {
    case SCR_H2_EMIT_STREAM_CLOSE: {
      ScrH2Stream *st = (ScrH2Stream *)e.h;
      if (!st->close_emitted) {
        st->close_emitted = true;
        /* Nonzero codes error first — except NO_ERROR and CANCEL (Node's
         * rule on both the closing and the receiving side). */
        uint32_t code = st->rst_code;
        if (code != 0 && code != 8 && !scr_exc_pending()) {
          const char *name = scr_h2_code_name(code);
          char msg[80];
          int n = name != NULL
              ? snprintf(msg, sizeof msg, "Stream closed with error code %s", name)
              : snprintf(msg, sizeof msg, "Stream closed with error code %" PRIu32, code);
          ScrStr *m = scr_str_new(msg, (size_t)n);
          scr_net_fire_err_this(&st->err_ls, m, st, SCR_DYNH_H2_STREAM);
          scr_str_release(m);
        }
        if (!scr_exc_pending()) {
          scr_net_fire0_this(&st->close_ls, st, SCR_DYNH_H2_STREAM);
        }
        scr_h2_stream_drop_lists(st);
      }
      break;
    }
    case SCR_H2_EMIT_STREAM_DRAIN:
      scr_h2_stream_drain((ScrH2Stream *)e.h);
      break;
    case SCR_H2_EMIT_SESSION_CLOSE: {
      ScrH2Session *s = (ScrH2Session *)e.h;
      if (!s->close_emitted) {
        s->close_emitted = true;
        scr_net_fire0_this(&s->close_ls, s, SCR_DYNH_H2_SESSION);
        scr_h2_session_drop_lists(s);
      }
      break;
    }
    case SCR_H2_EMIT_SESSION_CONNECT: {
      ScrH2Session *s = (ScrH2Session *)e.h;
      if (!s->destroyed) {
        /* (session, socket) through the registered adapters — fire0's
         * zero-arg shape would starve the (session, socket) listeners. */
        ScrNetL *snap;
        size_t n = scr_net_ls_snapshot(&s->connect_ls, &snap);
        scr_dyn_this_push(s, SCR_DYNH_H2_SESSION);
        for (size_t i = 0; i < n; i++) {
          if (!scr_exc_pending()) {
            ScrNetSocket *sock = s->sock ? scr_net_sock_retain(s->sock) : NULL;
            ((ScrH2ConnectFn)snap[i].fn)(snap[i].cb, scr_http2_session_retain(s), sock);
          }
          scr_closure_release(snap[i].cb);
        }
        scr_dyn_this_pop();
        free(snap);
        scr_net_ls_drop(&s->connect_ls); /* fires once */
      }
      break;
    }
    case SCR_H2_EMIT_SERVER_SESSION: {
      ScrH2Session *s = (ScrH2Session *)e.h;
      if (!s->destroyed && s->srv) {
        ScrNetL *snap;
        size_t n = scr_net_ls_snapshot(&s->srv->session_ls, &snap);
        ScrNetServer *server = s->sock ? scr_net_sock_server(s->sock) : NULL;
        scr_dyn_this_push(server, SCR_DYNH_NET_SERVER);
        for (size_t i = 0; i < n; i++) {
          if (!scr_exc_pending()) {
            ((void (*)(ScrClosure *, ScrH2Session *))snap[i].fn)(snap[i].cb, scr_http2_session_retain(s));
          }
          scr_closure_release(snap[i].cb);
        }
        scr_dyn_this_pop();
        free(snap);
      }
      break;
    }
    }
    scr_h2_emit_release(&e);
    if (scr_exc_pending()) return;
  }
  scr_h2_emits_head = scr_h2_emits_len = 0;
}

static void scr_h2_cleanup_atexit(void) {
  scr_h2_exiting = true;
  while (scr_h2_emits_head < scr_h2_emits_len) {
    ScrH2Emit e = scr_h2_emits[scr_h2_emits_head++];
    scr_h2_emit_release(&e);
  }
  free(scr_h2_emits);
  scr_h2_emits = NULL;
  scr_h2_emits_head = scr_h2_emits_len = scr_h2_emits_cap = 0;
}

static const ScrHttpH2Ops scr_h2_compat_ops;
static void scr_h2_request_hook(void *ctx, ScrClosure *cb, void *fn, bool once);
static void scr_h2_connect_hook(void *ctx, ScrClosure *cb, void *h1_fn, void *h2_fn, bool once);
static void scr_h2_upgrade_hook(void *ctx, ScrClosure *cb, void *fn, bool once);

static void scr_http2_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  atexit(scr_h2_cleanup_atexit);
  scr_net_set_proto_sweep(&scr_h2_proto_pending, &scr_h2_proto_sweep);
  /* the compat seam: scr_http.c routes h2-backed responses through the
   * ops vtable and h2-tagged 'request' registrations through the hook */
  scr_http_set_h2_ops(&scr_h2_compat_ops);
  scr_http_set_h2_request_hook(&scr_h2_request_hook);
  scr_http_set_h2_connect_hook(&scr_h2_connect_hook);
  scr_http_set_h2_upgrade_hook(&scr_h2_upgrade_hook);
}

/* ── session lifecycle ───────────────────────────────────────────────── */

static void scr_h2_session_queue_close(ScrH2Session *s) {
  if (s->close_queued || s->close_emitted) return;
  s->close_queued = true;
  scr_h2_emit_push(SCR_H2_EMIT_SESSION_CLOSE, scr_http2_session_retain(s));
}

/* A graceful close whose last stream just drained: end the write half —
 * the peer answers FIN, the socket closes, the session settles. */
static void scr_h2_session_maybe_finish_close(ScrH2Session *s) {
  if (!s->closed || s->destroyed || s->nstreams > 0) return;
  if (scr_h2_sock_alive(s)) scr_net_sock_end(s->sock);
}

static bool scr_h2_stream_local_closed(ScrH2Stream *st);

/* Settle every live stream at session teardown: a stream whose WRITABLE
 * side is still open aborted (Node's 'aborted' rule — an abnormal end
 * with the local half unfinished; a request/response that already sent
 * END_STREAM settles quietly). */
static void scr_h2_session_abort_streams(ScrH2Session *s) {
  while (s->nstreams > 0) {
    ScrH2Stream *st = scr_http2_stream_retain(s->streams[0]);
    if (!scr_h2_stream_local_closed(st) && !st->want_end &&
        !st->rst_recv && !st->rst_sent && !st->destroyed) {
      st->aborted = true;
      scr_net_fire0_this(&st->aborted_ls, st, SCR_DYNH_H2_STREAM);
    }
    scr_h2_stream_settle(st); /* forgets it from the vector */
    scr_http2_stream_release(st);
    if (scr_exc_pending()) return;
  }
}

static void scr_h2_session_fail(ScrH2Session *s, const char *text) {
  if (s->error_emitted) return;
  s->error_emitted = true;
  ScrStr *msg = scr_str_new(text, strlen(text));
  if (s->srv != NULL && s->srv->session_error_ls.n > 0) {
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&s->srv->session_error_ls, &snap);
    ScrNetServer *server = s->sock ? scr_net_sock_server(s->sock) : NULL;
    scr_dyn_this_push(server, SCR_DYNH_NET_SERVER);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((ScrH2SessionErrorFn)snap[i].fn)(snap[i].cb, msg,
                                          scr_http2_session_retain(s));
      }
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_this_pop();
    free(snap);
  }
  if (!scr_exc_pending() && s->err_ls.n > 0) {
    scr_net_fire_err_this(&s->err_ls, msg, s, SCR_DYNH_H2_SESSION);
  }
  scr_str_release(msg);
}

void scr_http2_session_destroy(ScrH2Session *s) {
  if (s->destroyed) return;
  s->destroyed = true;
  scr_h2_session_abort_streams(s);
  scr_h2_session_queue_close(s);
  if (scr_h2_sock_alive(s)) scr_net_sock_destroy(s->sock);
}

void scr_http2_session_close(ScrH2Session *s, ScrClosure *cb /*moves, nullable*/) {
  if (cb) scr_net_ls_add(&s->close_ls, cb, NULL, true);
  if (s->closed || s->destroyed) return;
  s->closed = true;
  scr_h2_send_goaway(s, 0 /* NGHTTP2_NO_ERROR */);
  scr_h2_session_maybe_finish_close(s);
}

/* ── the socket-facing callbacks (native reader) ─────────────────────── */

static void scr_h2_dispatch_headers(ScrH2Session *s, int32_t stream_id, uint8_t flags,
                                     ScrH2Headers *h);
static void scr_h2_stream_flush(ScrH2Stream *st);
static void scr_h2_compat_dispatch(ScrH2Session *s, ScrH2Stream *st, const ScrH2Headers *h,
                                    bool end_stream, ScrNetLs *listeners);

/* The settings record the API observes (Node's key order; maxHeaderSize
 * aliases maxHeaderListSize; customSettings not modeled — empty). +1. */
static ScrDyn *scr_h2_settings_dom(const ScrH2Settings *st) {
  ScrDyn *obj = scr_dyn_new_obj();
  scr_dyn_obj_set(obj, "headerTableSize", 15, scr_dyn_new_num((double)st->header_table_size));
  scr_dyn_obj_set(obj, "enablePush", 10, scr_dyn_new_bool(st->enable_push));
  scr_dyn_obj_set(obj, "initialWindowSize", 17, scr_dyn_new_num((double)st->initial_window_size));
  scr_dyn_obj_set(obj, "maxFrameSize", 12, scr_dyn_new_num((double)st->max_frame_size));
  scr_dyn_obj_set(obj, "maxConcurrentStreams", 20, scr_dyn_new_num((double)st->max_concurrent_streams));
  scr_dyn_obj_set(obj, "maxHeaderListSize", 17, scr_dyn_new_num((double)st->max_header_list_size));
  scr_dyn_obj_set(obj, "maxHeaderSize", 13, scr_dyn_new_num((double)st->max_header_list_size));
  scr_dyn_obj_set(obj, "enableConnectProtocol", 21, scr_dyn_new_bool(st->enable_connect_protocol));
  scr_dyn_obj_set(obj, "customSettings", 14, scr_dyn_new_obj());
  return obj;
}

/* Fire a settings-payload list: each entry's fn is (cb, settings +1). */
static void scr_h2_fire_settings(ScrNetLs *ls, ScrH2Session *s, const ScrH2Settings *st) {
  if (ls->n == 0) return;
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(ls, &snap);
  scr_dyn_this_push(s, SCR_DYNH_H2_SESSION);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ((ScrH2SettingsFn)snap[i].fn)(snap[i].cb, scr_h2_settings_dom(st));
    }
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

/* One complete frame. Returns false when the session tore down. */
static bool scr_h2_on_frame(ScrH2Session *s, uint8_t type, uint8_t flags, int32_t stream_id,
                             const uint8_t *p, size_t n) {
  /* An open header block admits only its CONTINUATIONs. */
  if (s->hblock_active && type != SCR_H2_F_CONTINUATION) {
    goto proto_err;
  }
  switch (type) {
  case SCR_H2_F_HEADERS: {
    if (flags & SCR_H2_FLAG_PADDED) {
      if (n < 1) goto proto_err;
      uint8_t pad = p[0];
      if ((size_t)pad + 1 > n) goto proto_err;
      p += 1;
      n -= 1 + pad;
    }
    if (flags & SCR_H2_FLAG_PRIORITY) {
      if (n < 5) goto proto_err;
      p += 5;
      n -= 5;
    }
    s->hblock.len = 0;
    scr_h2_buf_put(&s->hblock, p, n);
    s->hblock_stream = stream_id;
    s->hblock_flags = flags;
    if (flags & SCR_H2_FLAG_END_HEADERS) {
      ScrH2Headers h = {0};
      bool ok = scr_h2_hpack_decode(&s->dec_table, (const uint8_t *)s->hblock.data, s->hblock.len, &h);
      s->hblock.len = 0;
      if (!ok) {
        scr_h2_headers_free(&h);
        goto proto_err;
      }
      scr_h2_dispatch_headers(s, stream_id, s->hblock_flags, &h);
      scr_h2_headers_free(&h);
    } else {
      s->hblock_active = true;
    }
    break;
  }
  case SCR_H2_F_CONTINUATION: {
    if (!s->hblock_active || stream_id != s->hblock_stream) goto proto_err;
    scr_h2_buf_put(&s->hblock, p, n);
    if (flags & SCR_H2_FLAG_END_HEADERS) {
      s->hblock_active = false;
      ScrH2Headers h = {0};
      bool ok = scr_h2_hpack_decode(&s->dec_table, (const uint8_t *)s->hblock.data, s->hblock.len, &h);
      s->hblock.len = 0;
      if (!ok) {
        scr_h2_headers_free(&h);
        goto proto_err;
      }
      scr_h2_dispatch_headers(s, stream_id, s->hblock_flags, &h);
      scr_h2_headers_free(&h);
    }
    break;
  }
  case SCR_H2_F_DATA: {
    if (flags & SCR_H2_FLAG_PADDED) {
      if (n < 1) goto proto_err;
      uint8_t pad = p[0];
      if ((size_t)pad + 1 > n) goto proto_err;
      p += 1;
      n -= 1 + pad;
    }
    /* eager replenish: the peer's view of both windows stays full */
    if (n > 0) {
      scr_h2_send_window_update(s, 0, (uint32_t)n);
      scr_h2_send_window_update(s, stream_id, (uint32_t)n);
    }
    ScrH2Stream *st = scr_h2_find_stream(s, stream_id);
    if (!st || st->destroyed) break; /* late DATA on a gone stream: drop */
    if (st->compat_req != NULL) {
      /* the compat req owns the READ side: DATA feeds req 'data',
       * END_STREAM fires req 'end' — the stream's own queue stays empty */
      if (n > 0) {
        scr_http_h2_req_data(st->compat_req, (const char *)p, n);
        if (scr_exc_pending()) return false;
      }
      if (flags & SCR_H2_FLAG_END_STREAM) {
        st->end_recv = true;
        st->end_emitted = true;
        st->state = st->state == SCR_H2_S_CLOSED_LOCAL ? SCR_H2_S_CLOSED : SCR_H2_S_CLOSED_REMOTE;
        scr_http_h2_req_end(st->compat_req);
        if (scr_exc_pending()) return false;
        if (st->state == SCR_H2_S_CLOSED) scr_h2_stream_settle(st);
      }
      break;
    }
    if (n > 0) {
      st->had_data = true;
      if (st->flowing && st->rq_head == NULL) {
        scr_h2_stream_fire_data(st, (const char *)p, n);
        if (scr_exc_pending()) return false;
      } else {
        scr_h2_stream_rq_push(st, (const char *)p, n);
        if (st->flowing) scr_h2_stream_queue_drain(st);
      }
    }
    if (flags & SCR_H2_FLAG_END_STREAM) {
      st->end_recv = true;
      st->state = st->state == SCR_H2_S_CLOSED_LOCAL ? SCR_H2_S_CLOSED : SCR_H2_S_CLOSED_REMOTE;
      scr_h2_stream_maybe_emit_end(st);
      if (scr_exc_pending()) return false;
      if (st->state == SCR_H2_S_CLOSED && st->end_emitted) scr_h2_stream_settle(st);
    }
    break;
  }
  case SCR_H2_F_SETTINGS: {
    if (flags & SCR_H2_FLAG_ACK) {
      s->pending_settings_ack = false;
      scr_h2_fire_settings(&s->local_settings_ls, s, &s->local_settings);
      if (scr_exc_pending()) return false;
      break;
    }
    for (size_t off = 0; off + 6 <= n; off += 6) {
      uint16_t id = (uint16_t)((p[off] << 8) | p[off + 1]);
      uint32_t v = ((uint32_t)p[off + 2] << 24) | ((uint32_t)p[off + 3] << 16) |
                   ((uint32_t)p[off + 4] << 8) | p[off + 5];
      if (id == 0x4) {
        /* INITIAL_WINDOW_SIZE: adjust every open stream by the delta */
        int64_t delta = (int64_t)v - (int64_t)(s->peer_init_window ? s->peer_init_window : SCR_H2_DEFAULT_WINDOW);
        s->peer_init_window = v;
        s->remote_settings.initial_window_size = v;
        for (size_t i = 0; i < s->nstreams; i++) {
          s->streams[i]->send_window += delta;
          if (delta > 0) scr_h2_stream_flush(s->streams[i]);
        }
      } else if (id == 0x5) {
        s->peer_max_frame = v;
        s->remote_settings.max_frame_size = v;
      } else if (id == 0x1) {
        s->remote_settings.header_table_size = v;
      } else if (id == 0x2) {
        s->remote_settings.enable_push = v != 0;
      } else if (id == 0x3) {
        s->remote_settings.max_concurrent_streams = v;
      } else if (id == 0x6) {
        s->remote_settings.max_header_list_size = v;
      } else if (id == 0x8) {
        s->remote_settings.enable_connect_protocol = v != 0;
      }
      /* HEADER_TABLE_SIZE (0x1) governs OUR encoder's dynamic table — it
       * never indexes, so any ceiling is honored; the rest are recorded
       * for the remoteSettings read (MAX_CONCURRENT_STREAMS backpressure
       * is not modeled). */
    }
    scr_h2_send_settings_ack(s);
    scr_h2_fire_settings(&s->remote_settings_ls, s, &s->remote_settings);
    if (scr_exc_pending()) return false;
    break;
  }
  case SCR_H2_F_PING: {
    if (!(flags & SCR_H2_FLAG_ACK) && n == 8) {
      scr_h2_send_frame(s, SCR_H2_F_PING, SCR_H2_FLAG_ACK, 0, p, 8);
    }
    break;
  }
  case SCR_H2_F_WINDOW_UPDATE: {
    if (n != 4) goto proto_err;
    uint32_t inc = (((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]) & 0x7fffffff;
    if (stream_id == 0) {
      s->send_window += inc;
      for (size_t i = 0; i < s->nstreams && !scr_exc_pending(); i++) {
        scr_h2_stream_flush(s->streams[i]);
      }
    } else {
      ScrH2Stream *st = scr_h2_find_stream(s, stream_id);
      if (st) {
        st->send_window += inc;
        scr_h2_stream_flush(st);
      }
    }
    break;
  }
  case SCR_H2_F_RST_STREAM: {
    if (n != 4) goto proto_err;
    uint32_t code = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
    ScrH2Stream *st = scr_h2_find_stream(s, stream_id);
    if (st && !st->destroyed) {
      st->rst_recv = true;
      st->rst_code = code;
      st->destroyed = true;
      scr_h2_stream_settle(st);
    }
    break;
  }
  case SCR_H2_F_GOAWAY: {
    if (n < 8) goto proto_err;
    uint32_t code = ((uint32_t)p[4] << 24) | ((uint32_t)p[5] << 16) | ((uint32_t)p[6] << 8) | p[7];
    s->goaway_recv = true;
    s->goaway_code = code;
    {
      ScrNetL *snap;
      size_t nl = scr_net_ls_snapshot(&s->goaway_ls, &snap);
      int32_t last = (int32_t)((((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]) & 0x7fffffff);
      scr_dyn_this_push(s, SCR_DYNH_H2_SESSION);
      for (size_t i = 0; i < nl; i++) {
        if (!scr_exc_pending()) {
          ((void (*)(ScrClosure *, double, double))snap[i].fn)(snap[i].cb, (double)code, (double)last);
        }
        scr_closure_release(snap[i].cb);
      }
      scr_dyn_this_pop();
      free(snap);
      if (scr_exc_pending()) return false;
    }
    if (code != 0) {
      /* an error GOAWAY tears the session down NOW */
      scr_http2_session_destroy(s);
      return false;
    }
    /* NO_ERROR: no new streams; the session winds down as streams drain */
    s->closed = true;
    scr_h2_session_maybe_finish_close(s);
    break;
  }
  case SCR_H2_F_PUSH_PROMISE: {
    /* The promised header block still updates HPACK state (decode it),
     * then the promise is refused — push is not modeled yet. */
    if (flags & SCR_H2_FLAG_PADDED) {
      if (n < 1) goto proto_err;
      uint8_t pad = p[0];
      if ((size_t)pad + 1 > n) goto proto_err;
      p += 1;
      n -= 1 + pad;
    }
    if (n < 4) goto proto_err;
    int32_t promised = (int32_t)((((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]) & 0x7fffffff);
    /* M1 restriction: a promise split across CONTINUATION frames is not
     * reassembled — Node's promises fit one frame in practice. */
    if (!(flags & SCR_H2_FLAG_END_HEADERS)) goto proto_err;
    ScrH2Headers h = {0};
    bool ok = scr_h2_hpack_decode(&s->dec_table, p + 4, n - 4, &h);
    scr_h2_headers_free(&h);
    if (!ok) goto proto_err;
    scr_h2_send_rst(s, promised, 7 /* NGHTTP2_REFUSED_STREAM */);
    break;
  }
  default:
    break; /* PRIORITY, ALTSVC, ORIGIN, unknown: ignored */
  }
  return true;
proto_err:
  scr_h2_send_goaway(s, 1 /* NGHTTP2_PROTOCOL_ERROR */);
  scr_h2_session_fail(s, "Protocol error");
  scr_http2_session_destroy(s);
  return false;
}

static void scr_h2_on_data(void *ctx, const char *buf, size_t n) {
  ScrH2Session *s = ctx;
  if (s->destroyed) return;
  /* append to the reassembly buffer */
  if (s->rlen + n > s->rcap) {
    size_t ncap = s->rcap ? s->rcap : 4096;
    while (ncap < s->rlen + n) ncap *= 2;
    s->rbuf = realloc(s->rbuf, ncap);
    if (!s->rbuf) scr_h2_oom();
    s->rcap = ncap;
  }
  memcpy(s->rbuf + s->rlen, buf, n);
  s->rlen += n;
  size_t off = 0;
  scr_http2_session_retain(s); /* callbacks may drop every other ref */
  if (!s->client && !s->preface_done) {
    if (s->rlen - off < 24) goto done;
    if (memcmp(s->rbuf + off, SCR_H2_PREFACE, 24) != 0) {
      scr_h2_session_fail(s, "Protocol error");
      scr_http2_session_destroy(s);
      goto done;
    }
    s->preface_done = true;
    off += 24;
  }
  while (!s->destroyed && s->rlen - off >= 9) {
    const uint8_t *h = (const uint8_t *)s->rbuf + off;
    size_t len = ((size_t)h[0] << 16) | ((size_t)h[1] << 8) | h[2];
    if (s->rlen - off < 9 + len) break;
    uint8_t type = h[3];
    uint8_t flags = h[4];
    int32_t stream_id = (int32_t)((((uint32_t)h[5] << 24) | ((uint32_t)h[6] << 16) |
                                   ((uint32_t)h[7] << 8) | h[8]) & 0x7fffffff);
    if (stream_id > s->last_recv_stream_id &&
        (s->client ? (stream_id % 2 == 0) : (stream_id % 2 == 1))) {
      s->last_recv_stream_id = stream_id;
    }
    off += 9;
    if (!scr_h2_on_frame(s, type, flags, stream_id, (const uint8_t *)s->rbuf + off, len)) {
      off += len;
      break;
    }
    off += len;
    if (scr_exc_pending()) break;
  }
done:
  if (off > 0 && off < s->rlen) memmove(s->rbuf, s->rbuf + off, s->rlen - off);
  s->rlen -= off < s->rlen ? off : s->rlen;
  scr_http2_session_release(s);
}

static void scr_h2_on_eof(void *ctx) {
  ScrH2Session *s = ctx;
  if (s->destroyed) return;
  /* The peer is done sending. After a graceful GOAWAY exchange this is
   * the normal wind-down; streams still open aborted. */
  scr_h2_session_abort_streams(s);
}

static void scr_h2_on_closed(void *ctx) {
  ScrH2Session *s = ctx;
  s->destroyed = true;
  scr_h2_session_abort_streams(s);
  scr_h2_session_queue_close(s);
  if (s->sock) {
    /* break the socket↔session cycle (the socket still owns the ctx) */
    scr_net_sock_release(s->sock);
    s->sock = NULL;
  }
}

static bool scr_h2_on_err(void *ctx, ScrStr *msg) {
  ScrH2Session *s = ctx;
  if (s->err_ls.n == 0 && (s->srv == NULL || s->srv->session_error_ls.n == 0)) {
    return false; /* the socket's error story applies */
  }
  scr_h2_session_fail(s, (const char *)msg->data);
  return true;
}

static void scr_h2_session_ctx_free(void *ctx) { scr_http2_session_release(ctx); }

static ScrH2Session *scr_h2_session_new(bool client) {
  scr_http2_install();
  ScrH2Session *s = calloc(1, sizeof *s);
  if (!s) scr_h2_oom();
  s->rc = 1;
  s->client = client;
  s->preface_done = client; /* clients never RECEIVE the magic */
  s->next_stream_id = 1;
  s->send_window = SCR_H2_DEFAULT_WINDOW;
  s->peer_max_frame = SCR_H2_DEFAULT_MAX_FRAME;
  s->peer_init_window = SCR_H2_DEFAULT_WINDOW;
  scr_h2_settings_defaults(&s->local_settings);
  scr_h2_settings_defaults(&s->remote_settings);
  if (client) s->local_settings.enable_push = false; /* Node pins client push off */
  scr_h2_dyntab_init(&s->dec_table);
#ifdef SCR_RC_AUDIT
  scr_h2_sessions_live++;
#endif
  return s;
}

/* ── stream send path ────────────────────────────────────────────────── */

static bool scr_h2_stream_local_closed(ScrH2Stream *st) {
  return st->state == SCR_H2_S_CLOSED_LOCAL || st->state == SCR_H2_S_CLOSED;
}

static void scr_h2_stream_mark_local_closed(ScrH2Stream *st) {
  st->state = st->state == SCR_H2_S_CLOSED_REMOTE || st->state == SCR_H2_S_CLOSED
      ? SCR_H2_S_CLOSED
      : SCR_H2_S_CLOSED_LOCAL;
}

/* Flush window-permitting bytes; the END_STREAM rides the flush that
 * empties the buffer (an empty DATA frame when end() found it empty). */
static void scr_h2_stream_flush(ScrH2Stream *st) {
  ScrH2Session *s = st->sess;
  if (st->destroyed || scr_h2_stream_local_closed(st) || !scr_h2_sock_alive(s)) return;
  size_t max_frame = s->peer_max_frame ? s->peer_max_frame : SCR_H2_DEFAULT_MAX_FRAME;
  size_t off = 0;
  while (off < st->wbuf.len) {
    int64_t window = st->send_window < s->send_window ? st->send_window : s->send_window;
    if (window <= 0) break;
    size_t n = st->wbuf.len - off;
    if (n > (size_t)window) n = (size_t)window;
    if (n > max_frame) n = max_frame;
    bool last = off + n == st->wbuf.len;
    uint8_t flags = last && st->want_end ? SCR_H2_FLAG_END_STREAM : 0;
    scr_h2_send_frame(s, SCR_H2_F_DATA, flags, st->id, st->wbuf.data + off, n);
    st->send_window -= (int64_t)n;
    s->send_window -= (int64_t)n;
    off += n;
    if (flags & SCR_H2_FLAG_END_STREAM) scr_h2_stream_mark_local_closed(st);
  }
  if (off > 0) {
    memmove(st->wbuf.data, st->wbuf.data + off, st->wbuf.len - off);
    st->wbuf.len -= off;
  }
  if (st->wbuf.len == 0 && st->want_end && !scr_h2_stream_local_closed(st)) {
    scr_h2_send_frame(s, SCR_H2_F_DATA, SCR_H2_FLAG_END_STREAM, st->id, NULL, 0);
    scr_h2_stream_mark_local_closed(st);
  }
  /* both halves done (and the read side fully delivered) → settle */
  if (st->state == SCR_H2_S_CLOSED && (st->end_emitted || !st->end_recv)) {
    scr_h2_stream_settle(st);
  }
}

static void scr_h2_stream_send(ScrH2Stream *st, const char *data, size_t n) {
  if (st->destroyed || scr_h2_stream_local_closed(st)) return;
  scr_h2_buf_put(&st->wbuf, data, n);
  scr_h2_stream_flush(st);
}

/* ── the outgoing header-list builder ────────────────────────────────── */

/* Encode one `name: value` with the NAME lowercased on the wire (h2
 * requires lowercase header names). */
static void scr_h2_encode_header_lower(ScrH2Buf *b, const char *name, size_t name_len,
                                        const char *value, size_t value_len) {
  bool lower_ok = true;
  for (size_t k = 0; k < name_len && lower_ok; k++) {
    lower_ok = !(name[k] >= 'A' && name[k] <= 'Z');
  }
  if (lower_ok) {
    scr_h2_hpack_encode(b, name, name_len, value, value_len);
    return;
  }
  char *low = malloc(name_len);
  if (!low) scr_h2_oom();
  for (size_t k = 0; k < name_len; k++) {
    char c = name[k];
    low[k] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
  }
  scr_h2_hpack_encode(b, low, name_len, value, value_len);
  free(low);
}

/* Append `name: value` unless the name is a pseudo-header (those are
 * placed by the caller in canonical positions). `pairs` is the lowered
 * flat [name, value, ...] ScrArr (borrowed, nullable). */
static void scr_h2_encode_regulars(ScrH2Buf *b, ScrArr *pairs) {
  if (!pairs) return;
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *name = scr_arr_get_ref(pairs, (double)i);
    ScrStr *value = scr_arr_get_ref(pairs, (double)(i + 1));
    if (name->len > 0 && name->data[0] != ':') {
      scr_h2_encode_header_lower(b, name->data, name->len, value->data, value->len);
    }
    scr_str_release(name);
    scr_str_release(value);
  }
}

/* The implicit date header (Node's auto date on respond). */
static void scr_h2_encode_date(ScrH2Buf *b) {
  char date[40];
  time_t now = time(NULL);
  struct tm g;
#ifdef _WIN32
  gmtime_s(&g, &now);
#else
  gmtime_r(&now, &g);
#endif
  size_t n = strftime(date, sizeof date, "%a, %d %b %Y %H:%M:%S GMT", &g);
  scr_h2_hpack_encode(b, "date", 4, date, n);
}

/* The pseudo-header value in `pairs`, +1 (NULL when absent). */
static ScrStr *scr_h2_pairs_pseudo(ScrArr *pairs, const char *name) {
  if (!pairs) return NULL;
  size_t want = strlen(name);
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *nm = scr_arr_get_ref(pairs, (double)i);
    bool hit = nm->len == want && memcmp(nm->data, name, want) == 0;
    scr_str_release(nm);
    if (hit) return scr_arr_get_ref(pairs, (double)(i + 1));
  }
  return NULL;
}

/* ── stream API (respond / write / end / close / destroy / events) ───── */

void scr_http2_stream_respond(ScrH2Stream *st, ScrArr *pairs /*borrowed, nullable*/,
                               bool end_stream) {
  ScrH2Session *s = st->sess;
  if (st->destroyed || st->respond_sent || !scr_h2_sock_alive(s)) return;
  st->respond_sent = true;
  ScrH2Buf block = {0};
  ScrStr *status = scr_h2_pairs_pseudo(pairs, ":status");
  scr_h2_hpack_encode(&block, ":status", 7, status ? status->data : "200", status ? status->len : 3);
  if (status) scr_str_release(status);
  scr_h2_encode_regulars(&block, pairs);
  /* Node's auto date header (last unless the caller provided one) */
  ScrStr *own_date = scr_h2_pairs_pseudo(pairs, "date");
  if (own_date) {
    scr_str_release(own_date);
  } else {
    scr_h2_encode_date(&block);
  }
  scr_h2_send_headers(s, st->id, &block, end_stream);
  free(block.data);
  if (end_stream) {
    scr_h2_stream_mark_local_closed(st);
    if (st->state == SCR_H2_S_CLOSED && (st->end_emitted || !st->end_recv)) {
      scr_h2_stream_settle(st);
    }
  }
}

void scr_http2_stream_write_str(ScrH2Stream *st, ScrStr *data /*borrowed*/) {
  scr_h2_stream_send(st, data->data, data->len);
}

void scr_http2_stream_write_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/) {
  scr_h2_stream_send(st, (const char *)data->data, (size_t)data->len);
}

void scr_http2_stream_end(ScrH2Stream *st) {
  if (st->destroyed || st->want_end || scr_h2_stream_local_closed(st)) return;
  st->want_end = true;
  scr_h2_stream_flush(st);
}

void scr_http2_stream_end_str(ScrH2Stream *st, ScrStr *data /*borrowed*/) {
  if (st->destroyed || st->want_end || scr_h2_stream_local_closed(st)) return;
  scr_h2_buf_put(&st->wbuf, data->data, data->len);
  st->want_end = true;
  scr_h2_stream_flush(st);
}

void scr_http2_stream_end_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/) {
  if (st->destroyed || st->want_end || scr_h2_stream_local_closed(st)) return;
  scr_h2_buf_put(&st->wbuf, (const char *)data->data, (size_t)data->len);
  st->want_end = true;
  scr_h2_stream_flush(st);
}

void scr_http2_stream_close(ScrH2Stream *st, double code, ScrClosure *cb /*moves, nullable*/) {
  if (cb) scr_net_ls_add(&st->close_ls, cb, NULL, true);
  if (st->destroyed || st->close_queued || st->close_emitted) return;
  uint32_t c = code >= 0 && code <= 0xffffffff ? (uint32_t)code : 0;
  st->rst_code = c;
  st->rst_sent = true;
  st->destroyed = true;
  if (st->state != SCR_H2_S_CLOSED && scr_h2_sock_alive(st->sess)) {
    scr_h2_send_rst(st->sess, st->id, c);
  }
  scr_h2_stream_settle(st);
}

void scr_http2_stream_destroy(ScrH2Stream *st) {
  if (st->destroyed || st->close_emitted) return;
  st->rst_sent = true;
  st->destroyed = true;
  if (st->state != SCR_H2_S_CLOSED && scr_h2_sock_alive(st->sess)) {
    scr_h2_send_rst(st->sess, st->id, 0 /* NGHTTP2_NO_ERROR */);
  }
  scr_h2_stream_settle(st);
}

void scr_http2_stream_set_encoding(ScrH2Stream *st, ScrStr *enc /*borrowed*/) {
  /* ascii/latin1 deliver through the same string window as utf8 (the
   * suite's bodies are ASCII; SEMANTICS.md notes the residue) */
  if ((enc->len == 4 && memcmp(enc->data, "utf8", 4) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "utf-8", 5) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "ascii", 5) == 0) ||
      (enc->len == 6 && memcmp(enc->data, "latin1", 6) == 0)) {
    st->enc_utf8 = true;
    return;
  }
  char msg[96];
  int n = snprintf(msg, sizeof msg, "Unknown encoding: %.*s", (int)(enc->len > 40 ? 40 : enc->len), enc->data);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_UNKNOWN_ENCODING");
}

/* The chaining spelling (`client.request(h).setEncoding(enc)`): same
 * write, answers the receiver +1. */
ScrH2Stream *scr_http2_stream_set_encoding_ret(ScrH2Stream *st, ScrStr *enc /*borrowed*/) {
  scr_http2_stream_set_encoding(st, enc);
  return scr_http2_stream_retain(st);
}

void scr_http2_stream_resume(ScrH2Stream *st) {
  if (st->flowing) return;
  st->flowing = true;
  if (st->rq_head || (st->end_recv && !st->end_emitted)) scr_h2_stream_queue_drain(st);
}

void scr_http2_stream_pause(ScrH2Stream *st) { st->flowing = false; }

void scr_http2_stream_on_data(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once) {
  if (st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->data_ls, cb, (void *)fn, once);
  if (!st->flowing) {
    st->flowing = true;
    if (st->rq_head || (st->end_recv && !st->end_emitted)) scr_h2_stream_queue_drain(st);
  }
}

/* Zero-payload stream events; 'end' arms the drain when it already
 * happened (a late listener still sees Node's ordering guarantees). */
void scr_http2_stream_on_end(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once) {
  if (st->end_emitted || st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->end_ls, cb, NULL, once);
}

void scr_http2_stream_on_close(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once) {
  if (st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->close_ls, cb, NULL, once);
}

void scr_http2_stream_on_aborted(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once) {
  if (st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->aborted_ls, cb, NULL, once);
}

void scr_http2_stream_on_error(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->err_ls, cb, (void *)fn, once);
}

/* 'response' (client): the emitted adapter receives the raw payload
 * (pairs, status, flags) and builds the headers record program-side. */
void scr_http2_stream_on_response(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrH2RespFn fn, bool once) {
  if (st->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&st->resp_ls, cb, (void *)fn, once);
}

double scr_http2_stream_id(ScrH2Stream *st) { return (double)st->id; }
double scr_http2_stream_rst_code(ScrH2Stream *st) { return (double)st->rst_code; }
bool scr_http2_stream_destroyed(ScrH2Stream *st) { return st->destroyed; }
bool scr_http2_stream_closed(ScrH2Stream *st) { return st->close_queued || st->close_emitted; }
bool scr_http2_stream_aborted(ScrH2Stream *st) { return st->aborted; }
bool scr_http2_stream_pending(ScrH2Stream *st) { return false; /* streams send at request() */ }

ScrH2Session *scr_http2_stream_session(ScrH2Stream *st) {
  return scr_http2_session_retain(st->sess);
}

/* ── headers dispatch (both roles) ───────────────────────────────────── */

static ScrArr *scr_h2_headers_pairs(const ScrH2Headers *h, bool skip_status, double *status_out) {
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, h->n * 2);
  for (size_t i = 0; i < h->n; i++) {
    ScrStr *name = h->names[i];
    if (skip_status && name->len == 7 && memcmp(name->data, ":status", 7) == 0) {
      if (status_out) {
        double v = 0;
        for (size_t k = 0; k < h->values[i]->len; k++) {
          char c = h->values[i]->data[k];
          if (c < '0' || c > '9') break;
          v = v * 10 + (c - '0');
        }
        *status_out = v;
      }
      continue;
    }
    scr_arr_push_ref(pairs, scr_str_retain(name));
    scr_arr_push_ref(pairs, scr_str_retain(h->values[i]));
  }
  return pairs;
}

/* Fire a 'stream'-shaped list: (stream +1, pairs +1, flags) per entry. */
static void scr_h2_fire_stream_list(ScrNetLs *ls, ScrH2Stream *st, ScrArr *pairs /*borrowed*/,
                                     double flags, void *self, ScrDynHandleTag tag) {
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(ls, &snap);
  scr_dyn_this_push(self, tag);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ((ScrH2StreamFn)snap[i].fn)(snap[i].cb, scr_http2_stream_retain(st), scr_arr_retain(pairs), flags);
    }
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

static void scr_h2_dispatch_headers(ScrH2Session *s, int32_t stream_id, uint8_t flags,
                                     ScrH2Headers *h) {
  bool end_stream = (flags & SCR_H2_FLAG_END_STREAM) != 0;
  double fl = (double)(flags & (SCR_H2_FLAG_END_STREAM | SCR_H2_FLAG_END_HEADERS));
  if (!s->client) {
    if (stream_id % 2 == 0) return; /* server streams are client-initiated (odd) */
    ScrH2Stream *st = scr_h2_find_stream(s, stream_id);
    if (st != NULL) return; /* trailers: not modeled yet */
    if (s->closed || s->goaway_sent) {
      scr_h2_send_rst(s, stream_id, 7 /* NGHTTP2_REFUSED_STREAM */);
      return;
    }
    st = scr_h2_stream_new(s, stream_id);
    if (end_stream) {
      st->end_recv = true;
      st->state = SCR_H2_S_CLOSED_REMOTE;
    }
    bool connect_request = false;
    for (size_t i = 0; i < h->n; i++) {
      ScrStr *name = h->names[i];
      ScrStr *value = h->values[i];
      if (name->len == 7 && memcmp(name->data, ":method", 7) == 0 &&
          value->len == 7 && memcmp(value->data, "CONNECT", 7) == 0) {
        connect_request = true;
      }
    }
    ScrArr *pairs = scr_h2_headers_pairs(h, false, NULL);
    ScrNetServer *server = s->sock ? scr_net_sock_server(s->sock) : NULL;
    if (s->srv) scr_h2_fire_stream_list(&s->srv->stream_ls, st, pairs, fl, server, SCR_DYNH_NET_SERVER);
    if (!scr_exc_pending()) {
      scr_h2_fire_stream_list(&s->stream_ls, st, pairs, fl, s, SCR_DYNH_H2_SESSION);
    }
    scr_arr_release(pairs);
    /* The stream events precede their compatibility event, Node's order.
     * Both traditional and extended CONNECT emit 'connect', never
     * 'request'; ordinary methods retain the request path. */
    if (!scr_exc_pending() && s->srv != NULL && !st->destroyed) {
      ScrNetLs *listeners = connect_request ? &s->srv->connect_ls : &s->srv->request_ls;
      if (scr_net_ls_has_live(listeners)) scr_h2_compat_dispatch(s, st, h, end_stream, listeners);
    }
    scr_http2_stream_release(st);
    return;
  }
  /* client: response headers on a stream this session opened */
  ScrH2Stream *st = scr_h2_find_stream(s, stream_id);
  if (!st || st->destroyed) return;
  if (end_stream) {
    st->end_recv = true;
    st->state = scr_h2_stream_local_closed(st) ? SCR_H2_S_CLOSED : SCR_H2_S_CLOSED_REMOTE;
  }
  double status = 0;
  ScrArr *pairs = scr_h2_headers_pairs(h, true, &status);
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(&st->resp_ls, &snap);
  scr_dyn_this_push(st, SCR_DYNH_H2_STREAM);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ((ScrH2RespFn)snap[i].fn)(snap[i].cb, scr_arr_retain(pairs), status, fl);
    }
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
  scr_arr_release(pairs);
  if (scr_exc_pending()) return;
  if (end_stream) {
    scr_h2_stream_maybe_emit_end(st);
    if (scr_exc_pending()) return;
    if (st->state == SCR_H2_S_CLOSED && st->end_emitted) scr_h2_stream_settle(st);
  }
}

/* ── the compat layer (Http2ServerRequest/Http2ServerResponse) ─────────
 *
 * Node's http1-style API over h2 streams: the (req, res) pair ARE
 * scr_http.c's handles — the http/1 surface is the API template — and
 * this unit is the transport (HEADERS/DATA frames through the ops
 * vtable scr_http.c routes h2-backed responses through). A stream with
 * a compat req bound hands its READ side to the req (DATA frames feed
 * req 'data', END_STREAM fires req 'end'); settle releases the pair. */

static void scr_h2_compat_respond(void *p, double status, ScrStr *const *names,
                                   ScrStr *const *values, size_t nheaders, bool add_date) {
  ScrH2Stream *st = (ScrH2Stream *)p;
  ScrH2Session *s = st->sess;
  if (st->destroyed || st->respond_sent || !scr_h2_sock_alive(s)) return;
  st->respond_sent = true;
  ScrH2Buf block = {0};
  char stbuf[16];
  int stn = snprintf(stbuf, sizeof stbuf, "%d", (int)status);
  scr_h2_hpack_encode(&block, ":status", 7, stbuf, (size_t)stn);
  bool have_date = false;
  for (size_t i = 0; i < nheaders; i++) {
    const ScrStr *name = names[i];
    /* connection-specific headers never go on an h2 wire (Node's compat
     * drops them with a warning; the drop is the load-bearing half) */
    static const char *const conn_specific[] = {
      "connection", "keep-alive", "proxy-connection", "transfer-encoding",
      "upgrade", "http2-settings", NULL,
    };
    bool skip = false;
    for (size_t k = 0; conn_specific[k] != NULL && !skip; k++) {
      size_t cl = strlen(conn_specific[k]);
      if (name->len == cl) {
        bool eq = true;
        for (size_t j = 0; j < cl && eq; j++) {
          char c = name->data[j];
          if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
          eq = c == conn_specific[k][j];
        }
        skip = eq;
      }
    }
    if (skip) continue;
    if (name->len == 4) {
      bool is_date = true;
      for (size_t j = 0; j < 4 && is_date; j++) {
        char c = name->data[j];
        if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
        is_date = c == "date"[j];
      }
      if (is_date) have_date = true;
    }
    scr_h2_encode_header_lower(&block, name->data, name->len, values[i]->data, values[i]->len);
  }
  if (add_date && !have_date) scr_h2_encode_date(&block);
  scr_h2_send_headers(s, st->id, &block, false);
  free(block.data);
}

static void scr_h2_compat_write(void *p, const char *data, size_t n) {
  scr_h2_stream_send((ScrH2Stream *)p, data, n);
}

static void scr_h2_compat_end(void *p, const char *data, size_t n) {
  ScrH2Stream *st = (ScrH2Stream *)p;
  if (st->destroyed || st->want_end || scr_h2_stream_local_closed(st)) return;
  if (n > 0) scr_h2_buf_put(&st->wbuf, data, n);
  st->want_end = true;
  scr_h2_stream_flush(st);
}

static void scr_h2_compat_destroy(void *p) { scr_http2_stream_destroy((ScrH2Stream *)p); }

static const ScrHttpH2Ops scr_h2_compat_ops = {
  &scr_http2_stream_retain_v,
  &scr_http2_stream_release_v,
  &scr_h2_compat_respond,
  &scr_h2_compat_write,
  &scr_h2_compat_end,
  &scr_h2_compat_destroy,
};

/* server.on("request", ...) routed here by scr_http.c when the server's
 * ctx carries the h2 proto tag (the compat registration seam). */
static void scr_h2_request_hook(void *ctx, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrH2SrvCtx *srv = (ScrH2SrvCtx *)ctx;
  ScrNetOnce *shared_once = srv->http1_ctx != NULL && once ? scr_net_once_new() : NULL;
  if (srv->http1_ctx != NULL) {
    scr_http1_ctx_on_request(srv->http1_ctx, scr_closure_retain(cb), (ScrHttpReqFn)fn, once,
                             shared_once != NULL ? scr_net_once_retain(shared_once) : NULL);
  }
  if (shared_once != NULL) {
    scr_net_ls_add_shared_once(&srv->request_ls, cb, fn, shared_once);
  } else {
    scr_net_ls_add(&srv->request_ls, cb, fn, once);
  }
}

static void scr_h2_connect_hook(void *ctx, ScrClosure *cb /*moves*/,
                                void *h1_fn, void *h2_fn, bool once) {
  ScrH2SrvCtx *srv = (ScrH2SrvCtx *)ctx;
  bool have_h1 = srv->http1_ctx != NULL;
  bool have_h2 = h2_fn != NULL;
  ScrNetOnce *shared_once = have_h1 && have_h2 && once ? scr_net_once_new() : NULL;
  if (!have_h1 && !have_h2) {
    scr_closure_release(cb);
    return;
  }
  if (have_h1 && !have_h2) {
    scr_http1_ctx_on_connect(srv->http1_ctx, cb, (ScrHttpUpgradeFn)h1_fn, once, NULL);
    return;
  }
  if (srv->http1_ctx != NULL) {
    scr_http1_ctx_on_connect(srv->http1_ctx, scr_closure_retain(cb),
                             (ScrHttpUpgradeFn)h1_fn, once,
                             shared_once != NULL ? scr_net_once_retain(shared_once) : NULL);
  }
  if (shared_once != NULL) {
    scr_net_ls_add_shared_once(&srv->connect_ls, cb, h2_fn, shared_once);
  } else {
    scr_net_ls_add(&srv->connect_ls, cb, h2_fn, once);
  }
}

static void scr_h2_upgrade_hook(void *ctx, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrH2SrvCtx *srv = (ScrH2SrvCtx *)ctx;
  if (srv->http1_ctx != NULL) {
    scr_http1_ctx_on_upgrade(srv->http1_ctx, cb, (ScrHttpUpgradeFn)fn, once);
  } else {
    scr_closure_release(cb);
  }
}

/* Build the (req, res) pair over a fresh server stream and fire the
 * 'request' listeners (this = the net server, the http/1 shape). */
static void scr_h2_compat_dispatch(ScrH2Session *s, ScrH2Stream *st, const ScrH2Headers *h,
                                    bool end_stream, ScrNetLs *listeners) {
  ScrHttpReq *req = scr_http_h2_req_new(s->sock, st);
  for (size_t i = 0; i < h->n; i++) {
    ScrStr *name = h->names[i];
    ScrStr *value = h->values[i];
    if (name->len == 7 && memcmp(name->data, ":method", 7) == 0) {
      scr_http_h2_req_line(req, value, NULL);
    } else if (name->len == 5 && memcmp(name->data, ":path", 5) == 0) {
      scr_http_h2_req_line(req, NULL, value);
    }
    /* EVERY pair — pseudo-headers included — lands in req.headers
     * (Node's compat shape: req.headers[':path'] answers). */
    scr_http_h2_req_header(req, name, value);
  }
  ScrHttpRes *res = scr_http_h2_res_new(s->sock, st);
  scr_http_res_set_req(res, req); /* res.req — the compat pair's backref */
  st->compat_req = scr_http_req_retain(req);
  st->compat_res = scr_http_res_retain(res);
  /* the req owns the READ side: the stream's own 'end' bookkeeping is
   * already satisfied (settle conditions see a delivered read side) */
  if (end_stream) st->end_emitted = true;
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(listeners, &snap);
  ScrNetServer *server = s->sock ? scr_net_sock_server(s->sock) : NULL;
  scr_dyn_this_push(server, SCR_DYNH_NET_SERVER);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ((ScrHttpReqFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(req), scr_http_res_retain(res));
    }
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
  /* a body-less request ends NOW — the handler's synchronous listeners
   * see 'end' right after it returns, the http/1 parser's order */
  if (!scr_exc_pending() && end_stream) scr_http_h2_req_end(req);
  scr_http_req_release(req);
  scr_http_res_release(res);
}

/* ── the h2c server ──────────────────────────────────────────────────── */

static void scr_h2_srv_ctx_free_v(void *p) { scr_h2_srv_ctx_release((ScrH2SrvCtx *)p); }

static void scr_h2_srv_ctx_settle(void *p) {
  ScrH2SrvCtx *ctx = (ScrH2SrvCtx *)p;
  scr_net_ls_drop(&ctx->stream_ls);
  scr_net_ls_drop(&ctx->session_ls);
  scr_net_ls_drop(&ctx->request_ls);
  scr_net_ls_drop(&ctx->connect_ls);
  scr_net_ls_drop(&ctx->session_error_ls);
  if (ctx->http1_ctx != NULL) scr_http1_ctx_settle(ctx->http1_ctx);
}

static void scr_h2_on_connection(void *ctx, ScrNetSocket *sock) {
  ScrH2SrvCtx *srv = (ScrH2SrvCtx *)ctx;
  ScrH2Session *sess = scr_h2_session_new(false);
  sess->srv = scr_h2_srv_ctx_retain(srv);
  sess->sock = scr_net_sock_retain(sock);
  sess->next_stream_id = 2; /* server-initiated ids are even (push, unused) */
  sess->local_settings.enable_connect_protocol = srv->enable_connect_protocol;
  scr_net_sock_set_native_reader(sock, &scr_h2_on_data, &scr_h2_on_eof, &scr_h2_on_closed,
                                  sess, &scr_h2_session_ctx_free);
  scr_net_sock_set_native_events(sock, NULL, &scr_h2_on_err);
  scr_h2_send_settings(sess);
  scr_h2_emit_push(SCR_H2_EMIT_SERVER_SESSION, scr_http2_session_retain(sess));
}

ScrNetServer *scr_http2_create_server(void) {
  scr_http2_install();
  ScrNetServer *s = scr_net_create_server(NULL, NULL);
  ScrH2SrvCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_h2_oom();
  ctx->proto = SCR_NET_PROTO_H2;
  ctx->rc = 1;
  scr_net_server_set_native_conn(s, &scr_h2_on_connection, ctx, &scr_h2_srv_ctx_free_v);
  scr_net_server_set_http_ctx(s, ctx);
  scr_net_server_set_proto_settle(s, &scr_h2_srv_ctx_settle);
  return s;
}

/* http2.createServer(handler): the eager (req, res) handler is the first
 * compat 'request' listener — Node's exact route (server.on("request")
 * appends through the scr_http.c hook). */
ScrNetServer *scr_http2_create_server_req(ScrClosure *handler /*moves*/, ScrHttpReqFn fn) {
  ScrNetServer *s = scr_http2_create_server();
  ScrH2SrvCtx *ctx = (ScrH2SrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx != NULL && ctx->proto == SCR_NET_PROTO_H2) {
    scr_net_ls_add(&ctx->request_ls, handler, (void *)fn, false);
  } else {
    scr_closure_release(handler);
  }
  return s;
}

/* http2.createSecureServer({ cert, key }) — the REAL h2-over-TLS server:
 * the same h2c session machinery behind an mbedTLS handshake whose ALPN
 * advertises h2 alone. scr_tls.c owns the transport (the engine installs
 * per accepted socket) and calls back into scr_h2_on_connection at
 * establishment, so everything after the handshake is protocol-identical
 * to the h2c server — 'stream'/'session' listeners, multiplexing, flow
 * control, RST semantics. An http/1.1-only client fails the handshake
 * with no_application_protocol (Node's h2-only split); a no-ALPN client
 * tears down at establishment (Node parks it as 'unknownProtocol' and
 * destroys at the timeout — this surface destroys now). */
ScrNetServer *scr_http2_create_secure_server(const char *cert, size_t cert_len,
                                               const char *key, size_t key_len,
                                               bool enable_connect_protocol) {
  scr_http2_install();
  ScrNetServer *s = scr_net_create_server(NULL, NULL);
  ScrH2SrvCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_h2_oom();
  ctx->proto = SCR_NET_PROTO_H2;
  ctx->rc = 1;
  ctx->enable_connect_protocol = enable_connect_protocol;
  scr_net_server_set_http_ctx(s, ctx); /* borrowed alias: 'stream'/'session' registration */
  scr_net_server_set_proto_settle(s, &scr_h2_srv_ctx_settle);
  /* the TLS wrap owns the ctx reference (+1 moved in) and dispatches
   * established h2 connections back into scr_h2_on_connection */
  scr_tls_server_wrap_h2(s, cert, cert_len, key, key_len, &scr_h2_on_connection, ctx,
                          &scr_h2_srv_ctx_free_v, NULL, NULL);
  return s;
}

ScrNetServer *scr_http2_create_secure_server_allow_http1(
    const char *cert, size_t cert_len, const char *key, size_t key_len,
    ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn,
    ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn,
    bool enable_connect_protocol) {
  scr_http2_install();
  ScrNetServer *s = scr_http_create_server(NULL, NULL);
  void *http1_ctx = scr_net_server_get_http_ctx(s);
  ScrH2SrvCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_h2_oom();
  ctx->proto = SCR_NET_PROTO_H2;
  ctx->rc = 1;
  ctx->http1_ctx = http1_ctx;
  ctx->enable_connect_protocol = enable_connect_protocol;
  scr_net_server_set_http_ctx(s, ctx);
  scr_net_server_set_proto_settle(s, &scr_h2_srv_ctx_settle);
  if (handler != NULL) scr_h2_request_hook(ctx, handler, (void *)fn, false);
  scr_tls_server_wrap_h2(s, cert, cert_len, key, key_len, &scr_h2_on_connection, ctx,
                          &scr_h2_srv_ctx_free_v, sni_cb, sni_answer_fn);
  return s;
}

/* The h2 ctx behind a net server handle; NULL when the server is not an
 * h2c server (the proto tag keeps scr_http.c's parser family apart). */
static ScrH2SrvCtx *scr_h2_server_ctx(ScrNetServer *s) {
  ScrH2SrvCtx *ctx = (ScrH2SrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx == NULL || ctx->proto != SCR_NET_PROTO_H2) return NULL;
  return ctx;
}

/* createSecureServer(options, handler): the eager COMPAT handler is the
 * first 'request' listener over the ALPN=h2 server — the
 * create_server_req route, secured. */
ScrNetServer *scr_http2_create_secure_server_req(const char *cert, size_t cert_len,
                                                   const char *key, size_t key_len,
                                                   ScrClosure *handler /*moves, nullable*/,
                                                   ScrHttpReqFn fn,
                                                   bool enable_connect_protocol) {
  ScrNetServer *s = scr_http2_create_secure_server(cert, cert_len, key, key_len,
                                                    enable_connect_protocol);
  if (handler != NULL) {
    ScrH2SrvCtx *ctx = scr_h2_server_ctx(s);
    if (ctx != NULL) scr_net_ls_add(&ctx->request_ls, handler, (void *)fn, false);
    else scr_closure_release(handler);
  }
  return s;
}

/* createSecureServer with a RUNTIME options record (the divergence-66
 * stance): allowHTTP1 picks the flavor — truthy is the https/HTTP-1.1
 * compatibility server, absent or falsy the ALPN=h2 server — cert/key
 * ride the shared TLS server walk (scr_tls.c: out-of-bounds members
 * throw the catchable runtime fence), and the h2 session-tuning keys
 * drop exactly like the literal walk ignores them. NULL + pending
 * exception when the walk fences. */
ScrNetServer *scr_http2_create_secure_server_dyn(const ScrDyn *opts /*borrowed*/,
                                                  ScrClosure *handler /*moves, nullable*/,
                                                  ScrHttpReqFn fn) {
  bool allow_http1 = false;
  if (opts != NULL && opts->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < opts->v.obj.len; i++) {
      if (strcmp(opts->v.obj.entries[i].key, "allowHTTP1") == 0) {
        allow_http1 = scr_dyn_truthy(opts->v.obj.entries[i].value);
      }
    }
  }
  ScrBytes *cert, *key;
  if (!scr_tls_srv_opts_walk(opts, "http2.createSecureServer", &cert, &key)) {
    scr_closure_release(handler);
    return NULL;
  }
  ScrNetServer *s = allow_http1
      ? scr_https_create_server((const char *)cert->data, cert->len,
                                 (const char *)key->data, key->len, handler, fn)
      : scr_http2_create_secure_server_req((const char *)cert->data, cert->len,
                                            (const char *)key->data, key->len, handler, fn,
                                            false);
  scr_bytes_release(cert);
  scr_bytes_release(key);
  return s;
}

void scr_http2_server_on_stream(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn,
                                 bool once) {
  ScrH2SrvCtx *ctx = scr_h2_server_ctx(s);
  if (ctx == NULL || scr_net_server_settled(s)) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->stream_ls, cb, (void *)fn, once);
}

void scr_http2_server_on_session(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2SessionFn fn,
                                  bool once) {
  ScrH2SrvCtx *ctx = scr_h2_server_ctx(s);
  if (ctx == NULL || scr_net_server_settled(s)) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->session_ls, cb, (void *)fn, once);
}

/* ── the h2c client (http2.connect) ──────────────────────────────────── */

static void scr_h2_on_established(void *ctx) {
  ScrH2Session *s = ctx;
  if (!s->destroyed && !s->connect_queued) {
    s->connect_queued = true;
    scr_h2_emit_push(SCR_H2_EMIT_SESSION_CONNECT, scr_http2_session_retain(s));
  }
}

/* http2.connect(authority[, listener]): an http authority dials h2c
 * prior knowledge — the preface and SETTINGS go out immediately (the
 * socket buffers until the dial lands). An httpS authority dials the
 * TLS client transport with ALPN ["h2"] (scr_tls.c — linked whenever
 * this unit is): the same preface/SETTINGS buffer through the handshake
 * and everything after establishment is protocol-identical. `ca`
 * replaces the client trust anchors (len 0 = none) and
 * reject_unauthorized false disables the verify gate — the local-CA
 * self-connect shapes. Throws catchably on unparsable input. */
ScrH2Session *scr_http2_connect(ScrStr *url /*borrowed*/, bool reject_unauthorized,
                                 const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                 ScrClosure *cb /*moves, nullable*/, ScrH2ConnectFn fn) {
  const char *p = url->data;
  const char *sep = strstr(p, "://");
  if (sep == NULL || url->len == 0) {
    if (cb) scr_closure_release(cb);
    char msg[128];
    int n = snprintf(msg, sizeof msg, "Invalid URL: %.*s", (int)(url->len > 80 ? 80 : url->len), p);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_URL");
    return NULL;
  }
  size_t scheme_len = (size_t)(sep - p);
  bool secure = scheme_len == 5 && memcmp(p, "https", 5) == 0;
  if (!secure && !(scheme_len == 4 && memcmp(p, "http", 4) == 0)) {
    if (cb) scr_closure_release(cb);
    char msg[128];
    int n = snprintf(msg, sizeof msg, "Protocol \"%.*s:\" not supported. Expected \"http:\"",
                     (int)(scheme_len > 40 ? 40 : scheme_len), p);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_PROTOCOL");
    return NULL;
  }
  const char *host = sep + 3;
  const char *end = p + url->len;
  const char *host_end = host;
  while (host_end < end && *host_end != ':' && *host_end != '/') host_end++;
  double default_port = secure ? 443 : 80;
  double port = default_port;
  if (host_end < end && *host_end == ':') {
    port = 0;
    for (const char *q = host_end + 1; q < end && *q >= '0' && *q <= '9'; q++) {
      port = port * 10 + (*q - '0');
    }
  }
  ScrH2Session *s = scr_h2_session_new(true);
  /* :authority — host[:port], the port elided when it is the default */
  size_t hlen = (size_t)(host_end - host);
  ScrH2Buf auth = {0};
  scr_h2_buf_put(&auth, host, hlen);
  if (port != default_port) {
    char pbuf[16];
    int n = snprintf(pbuf, sizeof pbuf, ":%d", (int)port);
    scr_h2_buf_put(&auth, pbuf, (size_t)n);
  }
  scr_h2_buf_u8(&auth, 0); /* NUL-terminate; len tracks the text */
  auth.len--;
  /* stash the authority in the session's hblock buf slot? No — its own
   * field: reuse rbuf? Neither: a dedicated malloc. */
  ScrStr *host_str = scr_str_new(host, hlen);
  /* Resolve for the dial only (the http client's rule): the TLS wrap below
   * takes host_str, the NAME, because that is what SNI and verification
   * must see. */
  ScrStr *dial_addr = scr_net_blocking_lookup(host_str);
  ScrNetSocket *sock = scr_net_connect(port, dial_addr, NULL);
  scr_str_release(dial_addr);
  if (secure) scr_tls_h2_client_wrap(sock, host_str, reject_unauthorized, ca, ca_len);
  scr_str_release(host_str);
  s->sock = sock; /* scr_net_connect returned +1 — the session takes it */
  s->authority = auth.data;
  s->authority_len = auth.len;
  if (cb) scr_net_ls_add(&s->connect_ls, cb, (void *)fn, true);
  scr_net_sock_set_native_reader(sock, &scr_h2_on_data, &scr_h2_on_eof, &scr_h2_on_closed,
                                  s, &scr_h2_session_ctx_free);
  scr_net_sock_set_native_events(sock, NULL, &scr_h2_on_err);
  scr_net_sock_set_native_established(sock, &scr_h2_on_established);
  scr_net_sock_write_native(sock, SCR_H2_PREFACE, 24);
  scr_h2_send_settings(s);
  /* TWO owners now: the socket's native ctx and the returned handle. */
  return scr_http2_session_retain(s);
}

/* client.request(headers?, { endStream? }): sends HEADERS now (requests
 * before the dial lands ride the socket's write buffer). end_stream:
 * -1 = default (END_STREAM iff the method carries no payload), 0/1
 * explicit. Returns the stream +1. */
ScrH2Stream *scr_http2_session_request(ScrH2Session *s, ScrArr *pairs /*borrowed, nullable*/,
                                        double end_stream) {
  if (s->destroyed || s->closed || !s->client) {
    scr_throw_error_msg_code(SCR_ERR_ERROR, "New streams cannot be created after the session has been destroyed",
                             63, "ERR_HTTP2_INVALID_SESSION");
    return NULL;
  }
  ScrH2Stream *st = scr_h2_stream_new(s, s->next_stream_id);
  s->next_stream_id += 2;
  ScrStr *method = scr_h2_pairs_pseudo(pairs, ":method");
  ScrStr *path = scr_h2_pairs_pseudo(pairs, ":path");
  ScrStr *scheme = scr_h2_pairs_pseudo(pairs, ":scheme");
  ScrStr *authority = scr_h2_pairs_pseudo(pairs, ":authority");
  ScrH2Buf block = {0};
  scr_h2_hpack_encode(&block, ":method", 7, method ? method->data : "GET", method ? method->len : 3);
  if (authority) {
    scr_h2_hpack_encode(&block, ":authority", 10, authority->data, authority->len);
  } else {
    scr_h2_hpack_encode(&block, ":authority", 10, s->authority ? s->authority : "", s->authority_len);
  }
  /* the default :scheme follows the transport — https over TLS sessions
   * (Node derives it from the connect authority the same way) */
  const char *dscheme = s->sock != NULL && scr_net_sock_encrypted(s->sock) ? "https" : "http";
  scr_h2_hpack_encode(&block, ":scheme", 7, scheme ? scheme->data : dscheme,
                      scheme ? scheme->len : strlen(dscheme));
  scr_h2_hpack_encode(&block, ":path", 5, path ? path->data : "/", path ? path->len : 1);
  scr_h2_encode_regulars(&block, pairs);
  bool end;
  if (end_stream < 0) {
    /* Node's payload-meaningless default: GET/HEAD/DELETE end at HEADERS */
    end = method == NULL ||
          (method->len == 3 && memcmp(method->data, "GET", 3) == 0) ||
          (method->len == 4 && memcmp(method->data, "HEAD", 4) == 0) ||
          (method->len == 6 && memcmp(method->data, "DELETE", 6) == 0);
  } else {
    end = end_stream > 0;
  }
  if (method) scr_str_release(method);
  if (path) scr_str_release(path);
  if (scheme) scr_str_release(scheme);
  if (authority) scr_str_release(authority);
  scr_h2_send_headers(s, st->id, &block, end);
  free(block.data);
  if (end) scr_h2_stream_mark_local_closed(st);
  return st; /* the create ref moves out; the session's vector holds its own */
}

/* ── session events + props ──────────────────────────────────────────── */

void scr_http2_session_on_close(ScrH2Session *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->close_ls, cb, NULL, once);
}

void scr_http2_session_on_error(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->err_ls, cb, (void *)fn, once);
}

void scr_http2_server_on_session_error(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                        ScrH2SessionErrorFn fn, bool once) {
  ScrH2SrvCtx *ctx = scr_h2_server_ctx(s);
  if (ctx == NULL || scr_net_server_settled(s)) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->session_error_ls, cb, (void *)fn, once);
}

void scr_http2_session_error_thunk0(ScrClosure *cb, ScrStr *msg, ScrH2Session *session) {
  (void)msg;
  scr_http2_session_release(session);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_http2_session_error_thunk1(ScrClosure *cb, ScrStr *msg, ScrH2Session *session) {
  scr_http2_session_release(session);
  ScrError *err = scr_error_new(0, msg);
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, err);
}

void scr_http2_session_error_thunk2(ScrClosure *cb, ScrStr *msg, ScrH2Session *session) {
  ScrError *err = scr_error_new(0, msg);
  ((void (*)(ScrClosure *, ScrError *, ScrH2Session *))cb->fn)(cb, err, session);
}

void scr_http2_session_on_connect(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2ConnectFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->connect_ls, cb, (void *)fn, once);
}

void scr_http2_session_on_stream(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->stream_ls, cb, (void *)fn, once);
}

void scr_http2_session_on_goaway(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2GoawayFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->goaway_ls, cb, (void *)fn, once);
}

/* ── the settings surface ────────────────────────────────────────────── */

/* session.settings(settings[, cb]): the recognized keys update the local
 * record and go on a SETTINGS frame NOW; the callback (if any) fires on
 * the peer's ACK alongside the 'localSettings' listeners. Values are
 * applied as given (Node's ERR_HTTP2_INVALID_SETTING_VALUE validation is
 * not modeled — SEMANTICS.md). */
void scr_http2_session_settings(ScrH2Session *s, const ScrDyn *settings /*borrowed, nullable*/,
                                 ScrClosure *cb /*moves, nullable*/, ScrH2SettingsFn cbfn) {
  if (cb != NULL) scr_net_ls_add(&s->local_settings_ls, cb, (void *)cbfn, true);
  uint8_t payload[7 * 6];
  size_t n = 0;
  if (settings != NULL && settings->kind == SCR_DYN_OBJ) {
    static const struct { const char *key; uint16_t id; bool boolean; } keys[] = {
      { "headerTableSize", 0x1, false },
      { "enablePush", 0x2, true },
      { "maxConcurrentStreams", 0x3, false },
      { "initialWindowSize", 0x4, false },
      { "maxFrameSize", 0x5, false },
      { "maxHeaderListSize", 0x6, false },
      { "enableConnectProtocol", 0x8, true },
    };
    for (size_t k = 0; k < sizeof keys / sizeof *keys; k++) {
      const ScrDyn *v = scr_dyn_obj_get(settings, keys[k].key, strlen(keys[k].key));
      if (v == NULL) continue;
      uint32_t value;
      if (keys[k].boolean) {
        value = scr_dyn_truthy(v) ? 1 : 0;
      } else if (v->kind == SCR_DYN_NUM) {
        value = v->v.num < 0 ? 0 : v->v.num > 4294967295.0 ? 0xffffffffu : (uint32_t)v->v.num;
      } else {
        continue;
      }
      switch (keys[k].id) {
      case 0x1: s->local_settings.header_table_size = value; break;
      case 0x2: s->local_settings.enable_push = value != 0; break;
      case 0x3: s->local_settings.max_concurrent_streams = value; break;
      case 0x4: s->local_settings.initial_window_size = value; break;
      case 0x5: s->local_settings.max_frame_size = value; break;
      case 0x6: s->local_settings.max_header_list_size = value; break;
      case 0x8: s->local_settings.enable_connect_protocol = value != 0; break;
      }
      payload[n] = (uint8_t)(keys[k].id >> 8);
      payload[n + 1] = (uint8_t)keys[k].id;
      payload[n + 2] = (uint8_t)(value >> 24);
      payload[n + 3] = (uint8_t)(value >> 16);
      payload[n + 4] = (uint8_t)(value >> 8);
      payload[n + 5] = (uint8_t)value;
      n += 6;
    }
  }
  s->pending_settings_ack = true;
  scr_h2_send_frame(s, SCR_H2_F_SETTINGS, 0, 0, payload, n);
}

void scr_http2_session_on_settings(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2SettingsFn fn,
                                    bool once, bool local) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(local ? &s->local_settings_ls : &s->remote_settings_ls, cb, (void *)fn, once);
}

ScrDyn *scr_http2_session_settings_get(ScrH2Session *s, bool local) {
  return scr_h2_settings_dom(local ? &s->local_settings : &s->remote_settings);
}

bool scr_http2_session_pending_settings_ack(ScrH2Session *s) { return s->pending_settings_ack; }

/* http2.getDefaultSettings() — the constant defaults record. +1. */
ScrDyn *scr_http2_get_default_settings(void) {
  ScrH2Settings d;
  scr_h2_settings_defaults(&d);
  return scr_h2_settings_dom(&d);
}

/* The fixed passthrough for emitted settings adapters, and the zero-arg
 * flavor session.settings(_, cb) callbacks ride. */
void scr_http2_settings_thunk(ScrClosure *cb, ScrDyn *settings) {
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, settings);
}

void scr_http2_settings_thunk0(ScrClosure *cb, ScrDyn *settings) {
  scr_dyn_release(settings);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* The typed lane's DYN spellings (session receivers with mustCall-style
 * callbacks): the raw dyn function crosses the lib boundary and fires
 * through the same runtime-built listener closures the dyn handle ops
 * use — Node's exact payload shapes. */
static void scr_h2_dyn_fire_settings(ScrClosure *cb, ScrDyn *settings /*+1*/);
static void scr_h2_dyn_fire_settings_cb(ScrClosure *cb, ScrDyn *settings /*+1*/);

void scr_http2_session_settings_dyncb(ScrH2Session *s, const ScrDyn *settings /*borrowed*/,
                                       const ScrDyn *cb /*borrowed*/) {
  scr_dyn_check_listener(cb, "callback");
  if (scr_exc_pending()) return;
  scr_http2_session_settings(s, settings,
                             scr_dyn_listener_closure_fn(cb, (void *)&scr_h2_dyn_fire_settings_cb),
                             (ScrH2SettingsFn)&scr_h2_dyn_fire_settings_cb);
}

void scr_http2_session_on_settings_dyn(ScrH2Session *s, const ScrDyn *cb /*borrowed*/,
                                        bool once, bool local) {
  scr_dyn_check_listener(cb, "listener");
  if (scr_exc_pending()) return;
  scr_http2_session_on_settings(s, scr_dyn_listener_closure_fn(cb, (void *)&scr_h2_dyn_fire_settings),
                                 (ScrH2SettingsFn)&scr_h2_dyn_fire_settings, once, local);
}

bool scr_http2_session_closed(ScrH2Session *s) { return s->closed; }
bool scr_http2_session_destroyed(ScrH2Session *s) { return s->destroyed; }
bool scr_http2_session_encrypted(ScrH2Session *s) {
  return s->sock != NULL && scr_net_sock_encrypted(s->sock); /* true on the TLS arm */
}
double scr_http2_session_type(ScrH2Session *s) { return s->client ? 1 : 0; }

ScrStr *scr_http2_session_alpn(ScrH2Session *s) {
  /* TLS sessions negotiated h2; cleartext sessions answer Node's h2c */
  return scr_http2_session_encrypted(s) ? scr_str_new("h2", 2) : scr_str_new("h2c", 3);
}

ScrNetSocket *scr_http2_session_socket(ScrH2Session *s) {
  return s->sock ? scr_net_sock_retain(s->sock) : NULL;
}

/* ── the emitted-adapter thunks ──────────────────────────────────────── */

/* 'stream'/'session'-shaped payloads pass through whole; the EMITTED
 * adapter closure owns arity (it releases what it drops) and builds the
 * headers record from the pairs. */
void scr_http2_stream_thunk(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags) {
  ((void (*)(ScrClosure *, ScrH2Stream *, ScrArr *, double))cb->fn)(cb, st, pairs, flags);
}

void scr_http2_resp_thunk(ScrClosure *cb, ScrArr *pairs, double status, double flags) {
  ((void (*)(ScrClosure *, ScrArr *, double, double))cb->fn)(cb, pairs, status, flags);
}

void scr_http2_session_thunk(ScrClosure *cb, ScrH2Session *sess) {
  ((void (*)(ScrClosure *, ScrH2Session *))cb->fn)(cb, sess);
}

void scr_http2_session_thunk0(ScrClosure *cb, ScrH2Session *sess) {
  scr_http2_session_release(sess);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* The 'connect' adapters: (session, socket), and every shorter prefix.
 * Both arrive +1 (socket may be NULL after teardown); unused ones
 * release here. */
void scr_http2_connect_thunk2(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock) {
  ((void (*)(ScrClosure *, ScrH2Session *, ScrNetSocket *))cb->fn)(cb, sess, sock);
}

void scr_http2_connect_thunk1(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock) {
  if (sock) scr_net_sock_release(sock);
  ((void (*)(ScrClosure *, ScrH2Session *))cb->fn)(cb, sess);
}

void scr_http2_connect_thunk0(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock) {
  if (sock) scr_net_sock_release(sock);
  scr_http2_session_release(sess);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_http2_goaway_thunk2(ScrClosure *cb, double code, double last) {
  ((void (*)(ScrClosure *, double, double))cb->fn)(cb, code, last);
}

void scr_http2_goaway_thunk1(ScrClosure *cb, double code, double last) {
  (void)last;
  ((void (*)(ScrClosure *, double))cb->fn)(cb, code);
}

void scr_http2_goaway_thunk0(ScrClosure *cb, double code, double last) {
  (void)code;
  (void)last;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* ── the checked-dynamic handle surface (SCR_DYNH_H2_SESSION/STREAM) ───
 *
 * Boxed h2 handles reaching dynamic code (a mustCall-wrapped listener's
 * parameter, or a handle stored in an untyped binding) dispatch their
 * members here, the scr_http.c req/res ops precedent: `.on(...)` wires a
 * runtime-built listener closure over the dyn callback, header events
 * build a dyn headers object from the pairs, method calls decode dyn
 * args onto the static entry points, and property reads box the scalar
 * answers. Real-but-unmodeled members throw the loud ladder; names the
 * surface never had throw Node's "<x> is not a function". */

static ScrDyn *scr_h2_pairs_to_dom(ScrArr *pairs /*borrowed*/, double status) {
  ScrDyn *obj = scr_dyn_new_obj();
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *name = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
    ScrStr *value = (ScrStr *)scr_arr_get_ref(pairs, (double)(i + 1));
    if (!scr_dyn_obj_get(obj, name->data, name->len)) {
      scr_dyn_obj_set(obj, name->data, name->len, scr_dyn_new_str(value));
    }
    scr_str_release(name);
    scr_str_release(value);
  }
  if (status > 0) {
    scr_dyn_obj_set(obj, ":status", 7, scr_dyn_new_num(status));
  }
  return obj;
}

/* Header event fire thunks (the tuple this unit alone can box). */
static void scr_h2_dyn_fire_stream(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *hstream = scr_dyn_new_handle(st, SCR_DYNH_H2_STREAM);
  ScrDyn *hdrs = scr_h2_pairs_to_dom(pairs, 0);
  ScrDyn *fl = scr_dyn_new_num(flags);
  ScrDyn *args[3] = { hstream, hdrs, fl };
  ScrDyn *r = scr_dyn_call(fn, args, 3, "listener");
  scr_dyn_release(r);
  scr_dyn_release(fl);
  scr_dyn_release(hdrs);
  scr_dyn_release(hstream);
  scr_dyn_release(fn);
  scr_http2_stream_release(st);
  scr_arr_release(pairs);
}

static void scr_h2_dyn_fire_resp(ScrClosure *cb, ScrArr *pairs, double status, double flags) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *hdrs = scr_h2_pairs_to_dom(pairs, status);
  ScrDyn *fl = scr_dyn_new_num(flags);
  ScrDyn *args[2] = { hdrs, fl };
  ScrDyn *r = scr_dyn_call(fn, args, 2, "listener");
  scr_dyn_release(r);
  scr_dyn_release(fl);
  scr_dyn_release(hdrs);
  scr_dyn_release(fn);
  scr_arr_release(pairs);
}

static void scr_h2_dyn_fire_connect(ScrClosure *cb, ScrH2Session *s, ScrNetSocket *sock) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *hs = scr_dyn_new_handle(s, SCR_DYNH_H2_SESSION);
  ScrDyn *hsock = sock ? scr_dyn_new_handle(sock, SCR_DYNH_NET_SOCKET) : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *args[2] = { hs, hsock };
  ScrDyn *r = scr_dyn_call(fn, args, 2, "listener");
  scr_dyn_release(r);
  scr_dyn_release(hsock);
  scr_dyn_release(hs);
  scr_dyn_release(fn);
  scr_http2_session_release(s);
  if (sock) scr_net_sock_release(sock);
}

static void scr_h2_dyn_fire_settings(ScrClosure *cb, ScrDyn *settings /*+1*/) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *args[1] = { settings };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(fn);
  scr_dyn_release(settings);
}

/* The settings(obj, cb) CALLBACK shape: (err = null, settings, duration). */
static void scr_h2_dyn_fire_settings_cb(ScrClosure *cb, ScrDyn *settings /*+1*/) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *err = scr_dyn_new_null();
  ScrDyn *dur = scr_dyn_new_num(0);
  ScrDyn *args[3] = { err, settings, dur };
  ScrDyn *r = scr_dyn_call(fn, args, 3, "listener");
  scr_dyn_release(r);
  scr_dyn_release(dur);
  scr_dyn_release(err);
  scr_dyn_release(fn);
  scr_dyn_release(settings);
}

static void scr_h2_dyn_fire_goaway(ScrClosure *cb, double code, double last) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *a0 = scr_dyn_new_num(code);
  ScrDyn *a1 = scr_dyn_new_num(last);
  ScrDyn *args[2] = { a0, a1 };
  ScrDyn *r = scr_dyn_call(fn, args, 2, "listener");
  scr_dyn_release(r);
  scr_dyn_release(a1);
  scr_dyn_release(a0);
  scr_dyn_release(fn);
}

/* Flatten a dyn headers object into the flat pairs array (numbers via
 * String(n); the :status/:method/... pseudo-headers pass through). */
static ScrArr *scr_h2_dom_to_pairs(const ScrDyn *headers) {
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, headers->v.obj.len * 2);
  for (size_t i = 0; i < headers->v.obj.len; i++) {
    const ScrDynEntry *e = &headers->v.obj.entries[i];
    const ScrDyn *v = e->value;
    ScrStr *vs;
    if (v->kind == SCR_DYN_STR) vs = scr_str_retain(v->v.str);
    else if (v->kind == SCR_DYN_NUM) vs = scr_f64_to_scrstr(v->v.num);
    else continue; /* undefined/null header: dropped, Node's stance */
    scr_arr_push_ref(pairs, scr_str_new(e->key, e->key_len));
    scr_arr_push_ref(pairs, vs);
  }
  return pairs;
}

/* endStream from a dyn options object ({ endStream: true }); default d. */
static bool scr_h2_dyn_end_opt(const ScrDyn *opts, bool dflt) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return dflt;
  const ScrDyn *e = scr_dyn_obj_get(opts, "endStream", 9);
  if (e == NULL) return dflt;
  return e->kind == SCR_DYN_BOOL ? e->v.b : dflt;
}

static void scr_h2_dyn_not_a_fn(const char *what) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
}

/* ── stream ops ──────────────────────────────────────────────────────── */

static ScrDyn *scr_h2_dynh_stream_invoke(void *h, ScrDyn *self, const char *method,
                                          ScrDyn *const *args, size_t argc, const char *what) {
  ScrH2Stream *st = (ScrH2Stream *)h;
  if (strcmp(method, "respond") == 0) {
    ScrArr *pairs = argc > 0 && args[0]->kind == SCR_DYN_OBJ ? scr_h2_dom_to_pairs(args[0]) : NULL;
    bool end = scr_h2_dyn_end_opt(argc > 1 ? args[1] : NULL, false);
    scr_http2_stream_respond(st, pairs, end);
    if (pairs) scr_arr_release(pairs);
    return scr_dyn_undefined();
  }
  if (strcmp(method, "write") == 0 || strcmp(method, "end") == 0) {
    bool end = method[0] == 'e';
    const ScrDyn *data = argc > 0 ? args[0] : NULL;
    if (data && data->kind == SCR_DYN_STR) {
      if (end) scr_http2_stream_end_str(st, data->v.str);
      else scr_http2_stream_write_str(st, data->v.str);
    } else if (data && data->kind == SCR_DYN_BYTES) {
      if (end) scr_http2_stream_end_bytes(st, data->v.bytes);
      else scr_http2_stream_write_bytes(st, data->v.bytes);
    } else if (end) {
      scr_http2_stream_end(st);
    }
    return scr_dyn_undefined();
  }
  if (strcmp(method, "close") == 0) {
    double code = argc > 0 && args[0]->kind == SCR_DYN_NUM ? args[0]->v.num : 0;
    ScrClosure *cb = argc > 1 && args[1]->kind == SCR_DYN_FUNC ? scr_dyn_listener_closure0(args[1]) : NULL;
    scr_http2_stream_close(st, code, cb);
    return scr_dyn_undefined();
  }
  if (strcmp(method, "destroy") == 0) { scr_http2_stream_destroy(st); return scr_dyn_undefined(); }
  if (strcmp(method, "setEncoding") == 0) {
    if (argc > 0 && args[0]->kind == SCR_DYN_STR) scr_http2_stream_set_encoding(st, args[0]->v.str);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "resume") == 0) { scr_http2_stream_resume(st); return scr_dyn_retain(self); }
  if (strcmp(method, "pause") == 0) { scr_http2_stream_pause(st); return scr_dyn_retain(self); }
  if (strcmp(method, "on") == 0 || strcmp(method, "once") == 0 || strcmp(method, "addListener") == 0) {
    bool once = method[0] == 'o' && method[1] == 'n' && method[2] == 'c';
    if (argc < 2 || args[0]->kind != SCR_DYN_STR) { scr_dyn_check_listener(argc > 1 ? args[1] : scr_dyn_undefined(), "listener"); return NULL; }
    scr_dyn_check_listener(args[1], "listener");
    const char *ev = args[0]->v.str->data;
    if (strcmp(ev, "data") == 0) {
      scr_http2_stream_on_data(st, scr_dyn_listener_closure_data(args[1]), (ScrNetDataFn)&scr_dyn_listener_fire_data, once);
    } else if (strcmp(ev, "end") == 0) {
      scr_http2_stream_on_end(st, scr_dyn_listener_closure0(args[1]), once);
    } else if (strcmp(ev, "close") == 0) {
      scr_http2_stream_on_close(st, scr_dyn_listener_closure0(args[1]), once);
    } else if (strcmp(ev, "aborted") == 0) {
      scr_http2_stream_on_aborted(st, scr_dyn_listener_closure0(args[1]), once);
    } else if (strcmp(ev, "error") == 0) {
      scr_http2_stream_on_error(st, scr_dyn_listener_closure_err(args[1]), (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (strcmp(ev, "response") == 0) {
      scr_http2_stream_on_response(st, scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_resp), (ScrH2RespFn)&scr_h2_dyn_fire_resp, once);
    } else if (strcmp(ev, "push") == 0 || strcmp(ev, "headers") == 0 || strcmp(ev, "trailers") == 0 ||
               strcmp(ev, "frameError") == 0 || strcmp(ev, "ready") == 0 || strcmp(ev, "timeout") == 0 ||
               strcmp(ev, "wantTrailers") == 0 || strcmp(ev, "drain") == 0 || strcmp(ev, "finish") == 0) {
      /* modeled elsewhere or inert here: accept the registration, never fire */
    } else {
      char msg[128];
      int n = snprintf(msg, sizeof msg, "listening for '%s' on an Http2Stream is not supported yet", ev);
      scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  scr_h2_dyn_not_a_fn(what);
  return NULL;
}

static ScrDyn *scr_h2_dynh_stream_get(void *h, const char *key, size_t key_len) {
  ScrH2Stream *st = (ScrH2Stream *)h;
  (void)key_len;
  if (strcmp(key, "id") == 0) return scr_dyn_new_num(scr_http2_stream_id(st));
  if (strcmp(key, "rstCode") == 0) return scr_dyn_new_num(scr_http2_stream_rst_code(st));
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_http2_stream_destroyed(st));
  if (strcmp(key, "closed") == 0) return scr_dyn_new_bool(scr_http2_stream_closed(st));
  if (strcmp(key, "aborted") == 0) return scr_dyn_new_bool(scr_http2_stream_aborted(st));
  if (strcmp(key, "pending") == 0) return scr_dyn_new_bool(scr_http2_stream_pending(st));
  if (strcmp(key, "session") == 0) return scr_dyn_new_handle(st->sess, SCR_DYNH_H2_SESSION);
  return NULL;
}

static bool scr_h2_dynh_stream_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false;
}

/* ── session ops ─────────────────────────────────────────────────────── */

static ScrDyn *scr_h2_dynh_session_invoke(void *h, ScrDyn *self, const char *method,
                                           ScrDyn *const *args, size_t argc, const char *what) {
  ScrH2Session *s = (ScrH2Session *)h;
  if (strcmp(method, "request") == 0) {
    ScrArr *pairs = argc > 0 && args[0]->kind == SCR_DYN_OBJ ? scr_h2_dom_to_pairs(args[0]) : NULL;
    double end = -1;
    if (argc > 1 && args[1]->kind == SCR_DYN_OBJ) {
      const ScrDyn *e = scr_dyn_obj_get(args[1], "endStream", 9);
      if (e && e->kind == SCR_DYN_BOOL) end = e->v.b ? 1 : 0;
    }
    ScrH2Stream *st = scr_http2_session_request(s, pairs, end);
    if (pairs) scr_arr_release(pairs);
    if (st == NULL) return NULL; /* pending exception */
    ScrDyn *d = scr_dyn_new_handle(st, SCR_DYNH_H2_STREAM);
    scr_http2_stream_release(st); /* the box holds its own +1 */
    return d;
  }
  if (strcmp(method, "close") == 0) {
    ScrClosure *cb = argc > 0 && args[0]->kind == SCR_DYN_FUNC ? scr_dyn_listener_closure0(args[0]) : NULL;
    scr_http2_session_close(s, cb);
    return scr_dyn_undefined();
  }
  if (strcmp(method, "destroy") == 0) { scr_http2_session_destroy(s); return scr_dyn_undefined(); }
  if (strcmp(method, "on") == 0 || strcmp(method, "once") == 0 || strcmp(method, "addListener") == 0) {
    bool once = method[0] == 'o' && method[1] == 'n' && method[2] == 'c';
    if (argc < 2 || args[0]->kind != SCR_DYN_STR) { scr_dyn_check_listener(argc > 1 ? args[1] : scr_dyn_undefined(), "listener"); return NULL; }
    scr_dyn_check_listener(args[1], "listener");
    const char *ev = args[0]->v.str->data;
    if (strcmp(ev, "close") == 0) {
      scr_http2_session_on_close(s, scr_dyn_listener_closure0(args[1]), once);
    } else if (strcmp(ev, "error") == 0) {
      scr_http2_session_on_error(s, scr_dyn_listener_closure_err(args[1]), (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (strcmp(ev, "connect") == 0) {
      scr_http2_session_on_connect(s, scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_connect), (ScrH2ConnectFn)&scr_h2_dyn_fire_connect, once);
    } else if (strcmp(ev, "stream") == 0) {
      scr_http2_session_on_stream(s, scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_stream), (ScrH2StreamFn)&scr_h2_dyn_fire_stream, once);
    } else if (strcmp(ev, "goaway") == 0) {
      scr_http2_session_on_goaway(s, scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_goaway), (ScrH2GoawayFn)&scr_h2_dyn_fire_goaway, once);
    } else if (strcmp(ev, "localSettings") == 0 || strcmp(ev, "remoteSettings") == 0) {
      scr_http2_session_on_settings(s, scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_settings), (ScrH2SettingsFn)&scr_h2_dyn_fire_settings, once, ev[0] == 'l');
    } else if (strcmp(ev, "ping") == 0 || strcmp(ev, "frameError") == 0 || strcmp(ev, "timeout") == 0) {
      /* inert here: accept, never fire */
    } else {
      char msg[128];
      int n = snprintf(msg, sizeof msg, "listening for '%s' on an Http2Session is not supported yet", ev);
      scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "settings") == 0) {
    const ScrDyn *settings = argc > 0 && args[0]->kind == SCR_DYN_OBJ ? args[0] : NULL;
    ScrClosure *cb = argc > 1 && args[1]->kind == SCR_DYN_FUNC
        ? scr_dyn_listener_closure_fn(args[1], (void *)&scr_h2_dyn_fire_settings_cb)
        : NULL;
    scr_http2_session_settings(s, settings, cb, (ScrH2SettingsFn)&scr_h2_dyn_fire_settings_cb);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setTimeout") == 0 || strcmp(method, "ref") == 0 || strcmp(method, "unref") == 0 ||
      strcmp(method, "goaway") == 0 || strcmp(method, "ping") == 0) {
    /* accepted no-ops / not-yet-modeled tuning — return this */
    return scr_dyn_retain(self);
  }
  scr_h2_dyn_not_a_fn(what);
  return NULL;
}

static ScrDyn *scr_h2_dynh_session_get(void *h, const char *key, size_t key_len) {
  ScrH2Session *s = (ScrH2Session *)h;
  (void)key_len;
  if (strcmp(key, "closed") == 0) return scr_dyn_new_bool(scr_http2_session_closed(s));
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_http2_session_destroyed(s));
  if (strcmp(key, "encrypted") == 0) return scr_dyn_new_bool(scr_http2_session_encrypted(s));
  if (strcmp(key, "type") == 0) return scr_dyn_new_num(scr_http2_session_type(s));
  if (strcmp(key, "alpnProtocol") == 0) {
    ScrStr *a = scr_http2_session_alpn(s);
    ScrDyn *d = scr_dyn_new_str(a);
    scr_str_release(a);
    return d;
  }
  if (strcmp(key, "pendingSettingsAck") == 0) {
    return scr_dyn_new_bool(scr_http2_session_pending_settings_ack(s));
  }
  if (strcmp(key, "localSettings") == 0) return scr_http2_session_settings_get(s, true);
  if (strcmp(key, "remoteSettings") == 0) return scr_http2_session_settings_get(s, false);
  if (strcmp(key, "socket") == 0) {
    ScrNetSocket *sock = scr_http2_session_socket(s);
    if (sock == NULL) return NULL;
    ScrDyn *d = scr_dyn_new_handle(sock, SCR_DYNH_NET_SOCKET);
    scr_net_sock_release(sock);
    return d;
  }
  return NULL;
}

static bool scr_h2_dynh_session_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false;
}

static const ScrDynHandleOps scr_h2_dynh_stream_ops = {
  "Http2Stream", &scr_http2_stream_retain_v, &scr_http2_stream_release_v,
  &scr_h2_dynh_stream_invoke, &scr_h2_dynh_stream_get, &scr_h2_dynh_stream_set, NULL,
};

static const ScrDynHandleOps scr_h2_dynh_session_ops = {
  "Http2Session", &scr_http2_session_retain_v, &scr_http2_session_release_v,
  &scr_h2_dynh_session_invoke, &scr_h2_dynh_session_get, &scr_h2_dynh_session_set, NULL,
};

void scr_http2_dyn_install(void) {
  scr_dyn_handle_install(SCR_DYNH_H2_STREAM, &scr_h2_dynh_stream_ops);
  scr_dyn_handle_install(SCR_DYNH_H2_SESSION, &scr_h2_dynh_session_ops);
}
