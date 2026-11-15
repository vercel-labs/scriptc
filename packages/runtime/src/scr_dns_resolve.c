/* node:dns's stub resolver (scr_dns_resolve.c) — LINK-GATED: compiled into
 * the binary only when the IR uses it (the dnsResolve runtime feature), so
 * programs that never call dns.resolve*, dns.reverse, dns.setServers or
 * dns.Resolver keep their exact executables.
 *
 * lib/internal/dns/{callback_resolver,promises,utils}.js's surface over the
 * checked-dynamic argument forms: every resolve* / reverse binding sends one
 * UDP query (RD=1) to the resolver's servers — the module defaults, or a
 * Resolver's own — following c-ares's retry ladder (each server, `tries`
 * times), with a per-attempt timeout, a CNAME-free stub parse of the answer
 * section, and a TCP retry when the response asks for it (TC). The
 * binding's name is the error's syscall ("queryA", "getHostByAddr", ...),
 * exactly as Node's DNSException carries it. Errors are the checked-dynamic
 * view of a plain Error: `errno` (undefined), `code`, `syscall` and
 * `hostname`, message "<syscall> <CODE> <hostname>".
 *
 * The loop share rides the dgram unit's poller (scr_dgram.c's exported
 * primitives): each live query holds the loop, its descriptor and its
 * timeout timer are watched there, and its result is delivered on the dgram
 * pending queue, so the ordering against callbacks and timers is the same
 * one every other dns delivery has. Resolver state (servers, timeout,
 * tries, local address) lives in the handle; dns.setServers replaces the
 * module default resolver the module-level functions are bound to, the
 * promise module's setServers replaces only its own. */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#define SCR_DNSQ_CLOSE(fd) closesocket(fd)
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#define SCR_DNSQ_CLOSE(fd) close(fd)
#endif

/* ── the resolver handle ─────────────────────────────────────────────── */

#define SCR_DNSQ_NAME_MAX 512

typedef struct {
  int family; /* 4 or 6 */
  char host[64];
  unsigned port;
} ScrDnsServer;

typedef struct {
  ScrDnsServer *items;
  size_t n, cap;
} ScrDnsServerList;

typedef struct ScrDnsResolver {
  size_t rc;
  bool promises; /* built by dns/promises' Resolver */
  int timeout;   /* ms per attempt; -1 = c-ares's default */
  int tries;     /* attempts per server */
  unsigned max_timeout; /* ms for the whole query; 0 = no cap */
  ScrDnsServerList servers;
  char local_v4[64];
  char local_v6[64];
  unsigned gen; /* cancel() bumps: older queries settle ECANCELLED */
} ScrDnsResolver;

static ScrDnsResolver *scr_dnsr_new(bool promises);
static void scr_dnsr_free(ScrDnsResolver *r);
static void scr_dnsq_system_servers(ScrDnsServerList *list);
static void scr_dnsq_server_list_free(ScrDnsServerList *list);
static ScrDyn *scr_dnsq_hosts_reverse(const char *text, int family);
static void scr_dnsq_deliver_now(ScrDyn *callback, ScrPromise *promise, ScrDyn *result);

static void *scr_dnsr_retain(void *h) {
  ScrDnsResolver *r = h;
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

static void scr_dnsr_release(void *h) {
  ScrDnsResolver *r = h;
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) scr_dnsr_free(r);
}

/* A resolver starts from the system's nameservers (c-ares reads them for a
 * new channel, and getServers() reports them) and from c-ares's defaults for
 * the timeouts (no per-try timeout, four tries, no whole-query cap). */
static ScrDnsResolver *scr_dnsr_new(bool promises) {
  ScrDnsResolver *r = calloc(1, sizeof *r);
  if (r == NULL) scr_trap("scriptc: out of memory\n");
  r->rc = 1;
  r->promises = promises;
  r->timeout = -1;
  r->tries = 4;
  r->max_timeout = 0;
  scr_dnsq_system_servers(&r->servers);
  return r;
}

static void scr_dnsr_free(ScrDnsResolver *r) {
  scr_dnsq_server_list_free(&r->servers);
  free(r);
}

/* The resolver a handle holds, or NULL with ERR_INVALID_THIS pending. The
 * two tags are the callback module's Resolver and dns/promises' — one
 * representation, one class each (`new p.Resolver() instanceof
 * dns.Resolver` is false). */
static ScrDnsResolver *scr_dnsq_handle(const ScrDyn *recv) {
  if (recv != NULL && recv->kind == SCR_DYN_HANDLE &&
      (recv->v.handle.tag == SCR_DYNH_DNS_RESOLVER || recv->v.handle.tag == SCR_DYNH_DNS_RESOLVER_PROMISES))
    return recv->v.handle.ptr;
  scr_throw_error_msg_code(SCR_ERR_TYPE, "Illegal invocation", 18, "ERR_INVALID_THIS");
  return NULL;
}

/* ── small helpers ───────────────────────────────────────────────────── */

static ScrDyn *scr_dnsq_str_dyn(const char *s, size_t n) {
  /* scr_dyn_new_str retains, so the new string's own reference is released
   * here; the box carries it from then on. */
  ScrStr *str = scr_str_new(s, n);
  ScrDyn *d = scr_dyn_new_str(str);
  scr_str_release(str);
  return d;
}

static ScrDyn *scr_dnsq_cstr_dyn(const char *s) { return scr_dnsq_str_dyn(s, strlen(s)); }

/* The number as Node's "Received" tail renders it. */
static const char *scr_dnsq_num_received(double v, char out[48]) {
  size_t n = scr_num_received(v, out);
  out[n] = '\0';
  return out;
}

static bool scr_dnsq_is_int(double v) {
  return v == v && v > -1e300 && v < 1e300 && (double)(long long)v == v;
}

static void scr_dnsq_close_fd(int fd) {
  if (fd < 0) return;
  scr_dgram_poll_close(fd); /* forget-then-close */
}

/* ── addresses ───────────────────────────────────────────────────────── */

/* isIP: a dotted quad or an IPv6 literal, which may carry one %zone. */
static int scr_dnsq_ip_version(const char *s, size_t len) {
  char tmp[64];
  unsigned char buf[16];
  if (len == 0 || len >= sizeof tmp || memchr(s, '\0', len) != NULL) return 0;
  memcpy(tmp, s, len);
  tmp[len] = '\0';
  if (inet_pton(AF_INET, tmp, buf) == 1) return 4;
  if (inet_pton(AF_INET6, tmp, buf) == 1) return 6;
  char *pct = memchr(tmp, '%', len);
  if (pct != NULL && pct != tmp) {
    size_t zone = len - (size_t)(pct - tmp) - 1;
    if (zone > 0 && memchr(pct + 1, '%', zone) == NULL) {
      *pct = '\0';
      if (inet_pton(AF_INET6, tmp, buf) == 1) return 6;
    }
  }
  return 0;
}

/* The address as c-ares stores and reports it: inet_ntop's text, without
 * the zone (getServers drops it too). */
static bool scr_dnsq_canon_host(int family, const char *host, size_t hlen, char out[64]) {
  char tmp[80];
  if (hlen == 0 || hlen >= sizeof tmp || memchr(host, '\0', hlen) != NULL) return false;
  memcpy(tmp, host, hlen);
  tmp[hlen] = '\0';
  size_t alen = hlen;
  if (family == 6) {
    char *pct = memchr(tmp, '%', hlen);
    if (pct != NULL && pct != tmp) alen = (size_t)(pct - tmp);
  }
  tmp[alen] = '\0';
  unsigned char bin[16];
  int af = family == 4 ? AF_INET : AF_INET6;
  if (inet_pton(af, tmp, bin) != 1) return false;
  return inet_ntop(af, bin, out, 64) != NULL;
}

static bool scr_dnsq_sockaddr(const ScrDnsServer *s, struct sockaddr_storage *ss, socklen_t *len) {
  memset(ss, 0, sizeof *ss);
  if (s->family == 4) {
    struct sockaddr_in *in = (struct sockaddr_in *)ss;
    in->sin_family = AF_INET;
    in->sin_port = htons((unsigned short)s->port);
    if (inet_pton(AF_INET, s->host, &in->sin_addr) != 1) return false;
    *len = sizeof *in;
    return true;
  }
  struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)ss;
  in6->sin6_family = AF_INET6;
  in6->sin6_port = htons((unsigned short)s->port);
  if (inet_pton(AF_INET6, s->host, &in6->sin6_addr) != 1) return false;
  *len = sizeof *in6;
  return true;
}

static void scr_dnsq_server_append(ScrDnsServerList *list, int family, const char *host, size_t hlen,
                                   unsigned port) {
  char canon[64];
  if (!scr_dnsq_canon_host(family, host, hlen, canon)) return;
  hlen = strlen(canon);
  host = canon;
  /* A channel keeps one entry per address and port (c-ares's own list):
   * a repeat leaves the earlier position alone. */
  for (size_t i = 0; i < list->n; i++) {
    const ScrDnsServer *s = &list->items[i];
    if (s->family == family && s->port == port && strlen(s->host) == hlen && memcmp(s->host, host, hlen) == 0)
      return;
  }
  if (list->n == list->cap) {
    size_t cap = list->cap ? list->cap * 2 : 4;
    ScrDnsServer *items = realloc(list->items, cap * sizeof *items);
    if (items == NULL) scr_trap("scriptc: out of memory\n");
    list->items = items;
    list->cap = cap;
  }
  ScrDnsServer *s = &list->items[list->n++];
  s->family = family;
  memcpy(s->host, host, hlen);
  s->host[hlen] = '\0';
  s->port = port;
}

static void scr_dnsq_server_list_free(ScrDnsServerList *list) {
  free(list->items);
  list->items = NULL;
  list->n = list->cap = 0;
}

/* The system's nameservers (c-ares reads resolv.conf at channel creation;
 * 127.0.0.1 when there is nothing to read, c-ares's own fallback). */
static void scr_dnsq_system_servers(ScrDnsServerList *list) {
#ifndef _WIN32
  FILE *f = fopen("/etc/resolv.conf", "re");
  if (f != NULL) {
    char line[512];
    while (fgets(line, sizeof line, f) != NULL) {
      char *p = line;
      while (*p == ' ' || *p == '\t') p++;
      if (strncmp(p, "nameserver", 10) != 0) continue;
      p += 10;
      while (*p == ' ' || *p == '\t') p++;
      char *end = p;
      while (*end != '\0' && *end != '\n' && *end != '\r' && *end != ' ' && *end != '\t') end++;
      size_t len = (size_t)(end - p);
      int family = scr_dnsq_ip_version(p, len);
      if (family != 0) scr_dnsq_server_append(list, family, p, len, 53);
    }
    fclose(f);
  }
#endif
  if (list->n == 0) scr_dnsq_server_append(list, 4, "127.0.0.1", 9, 53);
}

/* getServers()'s strings: the port is dropped when it is 53, and an IPv6
 * literal is bracketed only when a port is shown. */
static ScrDyn *scr_dnsq_servers_dyn(const ScrDnsServerList *list) {
  ScrDyn *arr = scr_dyn_new_arr();
  for (size_t i = 0; i < list->n; i++) {
    const ScrDnsServer *s = &list->items[i];
    char text[128];
    int len;
    if (s->port == 53) {
      len = snprintf(text, sizeof text, "%s", s->host);
    } else if (s->family == 6) {
      len = snprintf(text, sizeof text, "[%s]:%u", s->host, s->port);
    } else {
      len = snprintf(text, sizeof text, "%s:%u", s->host, s->port);
    }
    if (len < 0) len = 0;
    scr_dyn_arr_push(arr, scr_dnsq_str_dyn(text, (size_t)(len < (int)sizeof text ? len : (int)sizeof text - 1)));
  }
  return arr;
}

/* ── the module default resolvers ────────────────────────────────────── */

/* dns.setServers replaces the resolver the callback module's functions are
 * bound to (and the promise module's, when it has been loaded — binding
 * both is what Node does in that case); dns/promises' setServers replaces
 * only its own. Two pointers model that. */
static ScrDnsResolver *scr_dnsq_default_cb;   /* +1 while set */
static ScrDnsResolver *scr_dnsq_default_p;    /* +1 while set */

static ScrDnsResolver *scr_dnsq_default(bool promises) {
  ScrDnsResolver **slot = promises ? &scr_dnsq_default_p : &scr_dnsq_default_cb;
  if (*slot == NULL) *slot = scr_dnsr_new(promises);
  return *slot;
}

static ScrDyn *scr_dnsq_module_servers(bool promises) {
  ScrDnsResolver *r = scr_dnsq_default(promises);
  return scr_dnsq_servers_dyn(&r->servers);
}

/* ── errors ──────────────────────────────────────────────────────────── */

/* Node's DNSException: a plain Error whose own fields are errno
 * (undefined), code, syscall and, when the query had a name, hostname; the
 * message is "<syscall> <code> <hostname>", and "<syscall> <code>" for the
 * empty name (the hostname part and field are dropped). */
static ScrDyn *scr_dnsq_error(const char *code, const char *syscall, const ScrStr *host) {
  bool named = host != NULL && host->len > 0;
  size_t hostlen = named ? host->len : 0;
  const char *hostdata = named ? host->data : "";
  char small[128];
  size_t need = strlen(syscall) + strlen(code) + hostlen + (named ? 4 : 2);
  char *msg = need <= sizeof small ? small : malloc(need);
  if (msg == NULL) scr_trap("scriptc: out of memory\n");
  int len = named ? snprintf(msg, need, "%s %s %.*s", syscall, code, (int)hostlen, hostdata)
                  : snprintf(msg, need, "%s %s", syscall, code);
  ScrStr *m = scr_str_new(msg, len > 0 ? (size_t)len : 0);
  if (msg != small) free(msg);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  /* Node's DNSException defines `errno` as an own field holding undefined
   * (its getters assign all four), so the key order is errno, code,
   * syscall, hostname. */
  e->errno_undefined = true;
  scr_error_set_prop(e, "syscall", 7, scr_dnsq_cstr_dyn(syscall));
  if (named) scr_error_set_prop(e, "hostname", 8, scr_dyn_new_str((ScrStr *)host));
  ScrDyn *d = scr_dyn_from_error(e);
  scr_error_release(e);
  return d;
}

/* ── wire names ──────────────────────────────────────────────────────── */

/* c-ares's presentation escaping for a name read out of a message
 * (ares_fetch_dnsname_into_buf): non-printable bytes as \DDD, and the
 * reserved characters " . ; \ ( ) @ $ prefixed with a backslash. */
static bool scr_dnsq_reservedch(unsigned char c) {
  return c == '"' || c == '.' || c == ';' || c == '\\' || c == '(' || c == ')' || c == '@' ||
         c == '$';
}

/* Reads a (possibly compressed) name at *off, answering the dotted text in
 * a fresh malloc'd string and advancing *off past the name at its original
 * position. c-ares's rules for a name in a message: pointers only ever
 * point backwards (at most 128 jumps), and the presentation form stays
 * within 255 bytes. NULL on a malformed packet. */
static char *scr_dnsq_read_name(const unsigned char *buf, size_t len, size_t *off, size_t depth) {
  (void)depth;
  char out[SCR_DNSQ_NAME_MAX];
  size_t on = 0;
  size_t at = *off;
  size_t start = *off; /* the lowest position the name has read from */
  bool jumped = false;
  size_t jumps = 0;
  size_t name_len = 0; /* presentation length: label bytes plus separators */
  size_t nlabels = 0;
  for (;;) {
    if (at >= len) return NULL;
    unsigned c = buf[at];
    if ((c & 0xc0) == 0xc0) {
      if (at + 1 >= len) return NULL;
      size_t ptr = ((size_t)(c & 0x3f) << 8) | buf[at + 1];
      if (!jumped) *off = at + 2;
      jumped = true;
      if (ptr >= start || ptr >= len) return NULL; /* forward pointers are invalid */
      if (++jumps > 128) return NULL;
      at = ptr;
      if (at < start) start = at;
      continue;
    }
    if ((c & 0xc0) != 0) return NULL;
    at++;
    if (c == 0) {
      if (!jumped) *off = at;
      break;
    }
    if (at + c > len) return NULL;
    if (nlabels > 0) {
      if (on + 1 >= sizeof out) return NULL;
      out[on++] = '.';
      name_len++;
    }
    nlabels++;
    name_len += c;
    if (name_len > 255) return NULL;
    for (unsigned i = 0; i < c; i++) {
      unsigned char b = buf[at + i];
      if (b < 0x20 || b > 0x7e) {
        if (on + 4 >= sizeof out) return NULL;
        out[on++] = '\\';
        out[on++] = (char)('0' + b / 100);
        out[on++] = (char)('0' + (b % 100) / 10);
        out[on++] = (char)('0' + b % 10);
        continue;
      }
      if (scr_dnsq_reservedch(b)) {
        if (on + 1 >= sizeof out) return NULL;
        out[on++] = '\\';
      }
      if (on + 1 >= sizeof out) return NULL;
      out[on++] = (char)b;
    }
    at += c;
  }
  char *s = malloc(on + 1);
  if (s == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(s, out, on);
  s[on] = '\0';
  return s;
}

/* c-ares's hostname character set (ares_is_hostnamech): letters, digits and
 * - _ / * . — the query name may hold nothing else. */
static bool scr_dnsq_hostnamech(unsigned char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
         c == '.' || c == '_' || c == '/' || c == '*';
}

/* Encodes the hostname as a QNAME the way c-ares does for a query name:
 * ada's ToASCII first (Node's cares_wrap.cc conversion), then c-ares's
 * ares_split_dns_name over that C string — `\DDD` and `\c` escapes, the
 * hostname character set, a trailing empty label dropped, and every label
 * 1-63 bytes, at most 255 presentation bytes. A NUL byte ends the name
 * (c-ares copies the string with ares_strcpy). Answers the length written,
 * or 0 with *bad set. */
static size_t scr_dnsq_encode_name(const ScrStr *name, unsigned char *out, size_t cap, bool *bad) {
  ScrStr *ascii = scr_idna_to_ascii(name->data, name->len);
  const unsigned char *data = (const unsigned char *)ascii->data;
  size_t len = strlen(ascii->data);
  /* Labels in a scratch list: each is at most 63 bytes, and the whole name
   * at most 255 presentation bytes, so this bounds the parse. */
  unsigned char labels[256 * 64];
  size_t label_at[256];
  size_t nlabels = 0;
  size_t used = 0;
  bool ok = true;
  size_t at = 0;
  label_at[0] = 0;
  nlabels = 1;
  while (at < len && ok) {
    unsigned char c = data[at++];
    if (c == '.') {
      if (nlabels >= 256) {
        ok = false;
        break;
      }
      label_at[nlabels] = used;
      nlabels++;
      continue;
    }
    if (c == '\\') {
      if (at >= len) {
        ok = false;
        break;
      }
      c = data[at++];
      if (c >= '0' && c <= '9') {
        unsigned val = (unsigned)(c - '0');
        for (int i = 0; i < 2; i++) {
          if (at >= len || data[at] < '0' || data[at] > '9') {
            ok = false;
            break;
          }
          val = val * 10 + (unsigned)(data[at++] - '0');
        }
        if (!ok || val > 255 || !scr_dnsq_hostnamech((unsigned char)val)) {
          ok = false;
          break;
        }
        c = (unsigned char)val;
      } else if (!scr_dnsq_hostnamech(c)) {
        ok = false;
        break;
      }
    } else if (!scr_dnsq_hostnamech(c)) {
      ok = false;
      break;
    }
    if (used >= sizeof labels) {
      ok = false;
      break;
    }
    labels[used++] = c;
  }
  if (ok) {
    /* The trailing empty label goes, and a name of one empty label ("." or
     * ".."-free input that was empty) becomes the root. */
    size_t last = nlabels - 1;
    if (used == label_at[last]) {
      nlabels--;
      if (nlabels == 1 && used == label_at[0]) nlabels = 0;
    }
    size_t total = 0;
    for (size_t i = 0; i < nlabels; i++) {
      size_t end = i + 1 < nlabels ? label_at[i + 1] : used;
      size_t n = end - label_at[i];
      /* No 0-length labels, none over 63 bytes. */
      if (n == 0 || n > 63) {
        ok = false;
        break;
      }
      total += n;
    }
    if (ok && nlabels > 0 && total + nlabels - 1 > 255) ok = false;
  }
  size_t n = 0;
  if (ok) {
    for (size_t i = 0; i < nlabels; i++) {
      size_t end = i + 1 < nlabels ? label_at[i + 1] : used;
      size_t ln = end - label_at[i];
      if (n + 1 + ln + 1 > cap) {
        ok = false;
        break;
      }
      out[n++] = (unsigned char)ln;
      memcpy(out + n, labels + label_at[i], ln);
      n += ln;
    }
  }
  scr_str_release(ascii);
  if (!ok) {
    *bad = true;
    return 0;
  }
  out[n++] = 0;
  return n;
}

/* ── the query ───────────────────────────────────────────────────────── */

typedef struct ScrDnsqLive {
  struct ScrDnsqLive *next;
} ScrDnsqLive;

typedef struct ScrDnsRR {
  int type;      /* 0 for an answer that is kept only for its position */
  unsigned idx;  /* position in the reply's answer section */
  unsigned ttl;
  char *target;  /* CNAME/NS/PTR/MX exchange/SRV name/NAPTR replacement/A-AAAA text */
  char *target2; /* SOA rname */
  char *str1, *str2, *str3; /* NAPTR flags/service/regexp; CAA tag */
  size_t str1_len, str2_len, str3_len;
  char *blob; /* TXT rdata, TLSA data, CAA value */
  size_t blob_len;
  unsigned u1, u2, u3, u4, u5, u6, u7; /* priority/weight/port/order/preference; SOA serial..minttl */
} ScrDnsRR;

typedef struct ScrDnsRRs {
  ScrDnsRR *items;
  size_t n, cap;
} ScrDnsRRs;

typedef struct ScrDnsqQuery {
  struct ScrDnsqQuery *next, *prev; /* the live list */
  ScrDnsResolver *r;                /* retained */
  char binding[32];                 /* the c-ares entry ("queryA", ...) */
  ScrStr *host;                     /* +1: the name the question puts on the wire */
  ScrStr *err_host;                 /* +1: the name an error reports (reverse: the address) */
  bool ttl;
  bool promise;
  bool typed; /* the callback's result parameter is not checked-dynamic */
  ScrDyn *callback;                 /* +1, callback form */
  ScrPromise *promise_handle;       /* +1, promise form */
  unsigned gen;
  int qtype;
  unsigned char id[2];
  /* The wire-encoded question name the packet carries: a response is only
   * this query's answer when its question matches these bytes (and the type
   * and class below), so a packet that merely guessed the transaction id
   * cannot settle the query. */
  unsigned char qname[SCR_DNSQ_NAME_MAX];
  size_t qname_len;
  unsigned char *pkt;
  size_t pkt_len;
  int fd;     /* -1 when none */
  bool tcp;
  bool connecting;
  unsigned char *rbuf; /* TCP: the accumulated stream */
  size_t rlen, rcap;
  size_t want;      /* TCP: the frame's payload length, valid once have_len */
  bool have_len;    /* TCP: the two-byte length prefix has been read */
  int attempt;
  /* Whether the LAST failed attempt was a UDP port-unreachable. c-ares
   * requeues to the next server after one, and the error a query ends with
   * is the one its last failed attempt recorded: ECONNREFUSED after a
   * port-unreachable, ETIMEOUT after an expired attempt. */
  bool last_refused;
  bool done;
} ScrDnsqQuery;

static ScrDnsqQuery *scr_dnsq_live; /* doubly linked, in start order */

/* A transaction id from the system CSPRNG. A counter (a fresh process always
 * starts at the same value) lets an off-path sender predict the answer it
 * has to spoof once it guesses the ephemeral port; c-ares draws random ids
 * for the same reason.
 *
 * Only the id's randomness matters, not its uniqueness across queries: every
 * query owns a socket — scr_dnsq_start_attempt creates one, binds it to an
 * ephemeral port and connects it to the server — and its responses are read
 * from that descriptor and matched against that query's own id. A packet on
 * another query's socket is never compared with this one, so two queries may
 * carry the same id without ambiguity — and allocation is a single draw that
 * always finishes, however many queries are outstanding. */
static void scr_dnsq_pick_id(ScrDnsqQuery *q) {
  arc4random_buf(q->id, sizeof q->id);
}

enum {
  T_A = 1,
  T_NS = 2,
  T_CNAME = 5,
  T_SOA = 6,
  T_PTR = 12,
  T_MX = 15,
  T_TXT = 16,
  T_AAAA = 28,
  T_SRV = 33,
  T_NAPTR = 35,
  T_TLSA = 52,
  T_ANY = 255,
  T_CAA = 257,
};

static const struct {
  const char *binding;
  const char *method;
  int type;
} scr_dnsq_bindings[] = {
    {"queryAny", "resolveAny", T_ANY},   {"queryA", "resolve4", T_A},
    {"queryAaaa", "resolve6", T_AAAA},   {"queryCaa", "resolveCaa", T_CAA},
    {"queryCname", "resolveCname", T_CNAME}, {"queryMx", "resolveMx", T_MX},
    {"queryNs", "resolveNs", T_NS},      {"queryTlsa", "resolveTlsa", T_TLSA},
    {"queryTxt", "resolveTxt", T_TXT},   {"querySrv", "resolveSrv", T_SRV},
    {"queryPtr", "resolvePtr", T_PTR},   {"queryNaptr", "resolveNaptr", T_NAPTR},
    {"querySoa", "resolveSoa", T_SOA},   {"getHostByAddr", "reverse", T_PTR},
};

static bool scr_dnsq_binding_type(const ScrStr *binding, int *type) {
  for (size_t i = 0; i < sizeof scr_dnsq_bindings / sizeof scr_dnsq_bindings[0]; i++) {
    size_t n = strlen(scr_dnsq_bindings[i].binding);
    if (binding->len == n && memcmp(binding->data, scr_dnsq_bindings[i].binding, n) == 0) {
      *type = scr_dnsq_bindings[i].type;
      return true;
    }
  }
  return false;
}

static const char *scr_dnsq_binding_name(const ScrStr *binding, char *buf, size_t cap) {
  if (binding->len >= cap) return "queryA";
  memcpy(buf, binding->data, binding->len);
  buf[binding->len] = '\0';
  return buf;
}

/* ── result construction ─────────────────────────────────────────────── */

static void scr_dnsq_rr_free(ScrDnsRR *rr) {
  free(rr->target);
  free(rr->target2);
  free(rr->str1);
  free(rr->str2);
  free(rr->str3);
  free(rr->blob);
  memset(rr, 0, sizeof *rr);
}

static void scr_dnsq_rrs_free(ScrDnsRRs *list) {
  for (size_t i = 0; i < list->n; i++) scr_dnsq_rr_free(&list->items[i]);
  free(list->items);
  list->items = NULL;
  list->n = list->cap = 0;
}

static ScrDnsRR *scr_dnsq_rr_push(ScrDnsRRs *list) {
  if (list->n == list->cap) {
    size_t cap = list->cap ? list->cap * 2 : 8;
    ScrDnsRR *items = realloc(list->items, cap * sizeof *items);
    if (items == NULL) scr_trap("scriptc: out of memory\n");
    list->items = items;
    list->cap = cap;
  }
  ScrDnsRR *rr = &list->items[list->n++];
  memset(rr, 0, sizeof *rr);
  return rr;
}

static void scr_dnsq_obj_num(ScrDyn *o, const char *key, double v) {
  scr_dyn_obj_set(o, key, strlen(key), scr_dyn_new_num(v));
}

static void scr_dnsq_obj_str(ScrDyn *o, const char *key, const char *s) {
  scr_dyn_obj_set(o, key, strlen(key), scr_dnsq_cstr_dyn(s ? s : ""));
}

/* The user-facing value for one record of `qtype` (Node's per-traits
 * parsing; the TTL option only reshapes A/AAAA, callback_resolver.js's
 * onresolve). `ttl_cap` is the shortest CNAME TTL of the reply, or a
 * negative number when there is none: Node's c-ares path caps a resolved
 * address's TTL at it, so a chain does not outlive its first link. */
static ScrDyn *scr_dnsq_rr_value(const ScrDnsRR *rr, int qtype, bool ttl_option, double ttl_cap, bool any) {
  switch (qtype) {
    case T_A:
    case T_AAAA: {
      if (any) {
        ScrDyn *o = scr_dyn_new_obj();
        scr_dnsq_obj_str(o, "address", rr->target);
        scr_dnsq_obj_num(o, "ttl", (double)rr->ttl);
        scr_dnsq_obj_str(o, "type", qtype == T_A ? "A" : "AAAA");
        return o;
      }
      if (ttl_option) {
        ScrDyn *o = scr_dyn_new_obj();
        scr_dnsq_obj_str(o, "address", rr->target);
        double ttl = (double)rr->ttl;
        if (ttl_cap >= 0 && ttl_cap < ttl) ttl = ttl_cap;
        scr_dnsq_obj_num(o, "ttl", ttl);
        return o;
      }
      return scr_dnsq_cstr_dyn(rr->target);
    }
    case T_CNAME:
    case T_NS:
    case T_PTR: {
      if (!any) return scr_dnsq_cstr_dyn(rr->target);
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "value", rr->target);
      scr_dnsq_obj_str(o, "type", qtype == T_CNAME ? "CNAME" : qtype == T_NS ? "NS" : "PTR");
      return o;
    }
    case T_MX: {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "exchange", rr->target);
      scr_dnsq_obj_num(o, "priority", (double)rr->u1);
      scr_dnsq_obj_str(o, "type", "MX");
      return o;
    }
    case T_SRV: {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "name", rr->target);
      scr_dnsq_obj_num(o, "port", (double)rr->u3);
      scr_dnsq_obj_num(o, "priority", (double)rr->u1);
      scr_dnsq_obj_num(o, "weight", (double)rr->u2);
      scr_dnsq_obj_str(o, "type", "SRV");
      return o;
    }
    case T_TXT: {
      ScrDyn *entries = scr_dyn_new_arr();
      size_t at = 0;
      while (at < rr->blob_len) {
        size_t n = (unsigned char)rr->blob[at++];
        if (at + n > rr->blob_len) n = rr->blob_len - at;
        scr_dyn_arr_push(entries, scr_dnsq_str_dyn(rr->blob + at, n));
        at += n;
      }
      if (!any) return entries;
      ScrDyn *o = scr_dyn_new_obj();
      scr_dyn_obj_set(o, "entries", 7, entries);
      scr_dnsq_obj_str(o, "type", "TXT");
      return o;
    }
    case T_NAPTR: {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "flags", rr->str1);
      scr_dnsq_obj_str(o, "service", rr->str2);
      scr_dnsq_obj_str(o, "regexp", rr->str3);
      scr_dnsq_obj_str(o, "replacement", rr->target);
      scr_dnsq_obj_num(o, "order", (double)rr->u1);
      scr_dnsq_obj_num(o, "preference", (double)rr->u2);
      /* The non-ANY traits leave an own `type` whose value is undefined. */
      scr_dyn_obj_set(o, "type", 4, any ? scr_dnsq_cstr_dyn("NAPTR") : scr_dyn_undefined());
      return o;
    }
    case T_SOA: {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "nsname", rr->target);
      scr_dnsq_obj_str(o, "hostmaster", rr->target2);
      scr_dnsq_obj_num(o, "serial", (double)rr->u1);
      scr_dnsq_obj_num(o, "refresh", (double)rr->u2);
      scr_dnsq_obj_num(o, "retry", (double)rr->u3);
      scr_dnsq_obj_num(o, "expire", (double)rr->u4);
      scr_dnsq_obj_num(o, "minttl", (double)rr->u5);
      scr_dyn_obj_set(o, "type", 4, any ? scr_dnsq_cstr_dyn("SOA") : scr_dyn_undefined());
      return o;
    }
    case T_CAA: {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_num(o, "critical", (double)rr->u1);
      scr_dnsq_obj_str(o, "type", "CAA");
      if (rr->str1 != NULL)
        scr_dyn_obj_set(o, rr->str1, rr->str1_len, scr_dnsq_str_dyn(rr->blob, rr->blob_len));
      return o;
    }
    case T_TLSA: {
      /* Node hands back an ArrayBuffer, and no `type` key in either form. */
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_num(o, "certUsage", (double)rr->u1);
      scr_dnsq_obj_num(o, "selector", (double)rr->u2);
      scr_dnsq_obj_num(o, "match", (double)rr->u3);
      ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)rr->blob_len);
      if (rr->blob_len > 0) scr_bytes_write(bytes, 0, rr->blob, rr->blob_len);
      ScrDyn *data = scr_array_buffer_from_bytes(bytes);
      scr_bytes_release(bytes);
      scr_dyn_obj_set(o, "data", 4, data);
      return o;
    }
    default:
      return scr_dyn_undefined();
  }
}

/* ── the response parser ─────────────────────────────────────────────── */

#define SCR_DNSQ_RCODE(status) ((status) == 1 ? "EFORMERR" \
    : (status) == 2 ? "ESERVFAIL" \
    : (status) == 3 ? "ENOTFOUND" \
    : (status) == 4 ? "ENOTIMP" \
    : (status) == 5 ? "EREFUSED" \
    : "EBADRESP")

typedef struct {
  int status;       /* 0 = ok, else the DNS code string chosen by the caller */
  bool truncated;
  ScrDnsRRs rrs;
  char *question;   /* the first question's name, as the reply spells it */
} ScrDnsqParsed;

static bool scr_dnsq_rd_u16(const unsigned char *buf, size_t len, size_t *off, unsigned *out) {
  if (*off + 2 > len) return false;
  *out = ((unsigned)buf[*off] << 8) | buf[*off + 1];
  *off += 2;
  return true;
}

static bool scr_dnsq_rd_u32(const unsigned char *buf, size_t len, size_t *off, unsigned *out) {
  if (*off + 4 > len) return false;
  *out = ((unsigned)buf[*off] << 24) | ((unsigned)buf[*off + 1] << 16) | ((unsigned)buf[*off + 2] << 8) |
         buf[*off + 3];
  *off += 4;
  return true;
}

static char *scr_dnsq_strdup(const char *s) {
  size_t n = strlen(s);
  char *p = malloc(n + 1);
  if (p == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(p, s, n + 1);
  return p;
}

static char *scr_dnsq_memdup(const unsigned char *s, size_t n) {
  char *p = malloc(n + 1);
  if (p == NULL) scr_trap("scriptc: out of memory\n");
  if (n > 0) memcpy(p, s, n);
  p[n] = '\0';
  return p;
}

/* Parses one answer RR's rdata into rr. Answers false on a malformed
 * packet. */
static bool scr_dnsq_parse_rdata(const unsigned char *buf, size_t len, size_t *off, unsigned rdlen, ScrDnsRR *rr) {
  size_t at = *off;
  size_t end = at + rdlen;
  if (end > len) return false;
  switch (rr->type) {
    case T_A: {
      if (rdlen != 4) return false;
      char text[INET_ADDRSTRLEN];
      if (inet_ntop(AF_INET, buf + at, text, sizeof text) == NULL) return false;
      rr->target = scr_dnsq_strdup(text);
      break;
    }
    case T_AAAA: {
      if (rdlen != 16) return false;
      char text[INET6_ADDRSTRLEN];
      if (inet_ntop(AF_INET6, buf + at, text, sizeof text) == NULL) return false;
      rr->target = scr_dnsq_strdup(text);
      break;
    }
    case T_CNAME:
    case T_NS:
    case T_PTR:
      rr->target = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target == NULL) return false;
      break;
    case T_MX: {
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u1)) return false;
      rr->target = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target == NULL) return false;
      break;
    }
    case T_TXT:
      if (rdlen == 0) return false;
      rr->blob = scr_dnsq_memdup(buf + at, rdlen);
      rr->blob_len = rdlen;
      at = end;
      break;
    case T_SOA:
      rr->target = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target == NULL) return false;
      rr->target2 = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target2 == NULL) return false;
      if (!scr_dnsq_rd_u32(buf, len, &at, &rr->u1)) return false;
      if (!scr_dnsq_rd_u32(buf, len, &at, &rr->u2)) return false;
      if (!scr_dnsq_rd_u32(buf, len, &at, &rr->u3)) return false;
      if (!scr_dnsq_rd_u32(buf, len, &at, &rr->u4)) return false;
      if (!scr_dnsq_rd_u32(buf, len, &at, &rr->u5)) return false;
      break;
    case T_SRV:
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u1)) return false;
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u2)) return false;
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u3)) return false;
      rr->target = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target == NULL) return false;
      break;
    case T_NAPTR: {
      /* order, preference, then three character-strings (flags, service,
       * regexp) and the replacement name. */
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u1)) return false;
      if (!scr_dnsq_rd_u16(buf, len, &at, &rr->u2)) return false;
      char **strs[3] = {&rr->str1, &rr->str2, &rr->str3};
      size_t *lens[3] = {&rr->str1_len, &rr->str2_len, &rr->str3_len};
      for (int i = 0; i < 3; i++) {
        if (at >= end) return false;
        unsigned n = buf[at++];
        if (at + n > end) return false;
        *strs[i] = scr_dnsq_memdup(buf + at, n);
        *lens[i] = n;
        at += n;
      }
      rr->target = scr_dnsq_read_name(buf, len, &at, 0);
      if (rr->target == NULL) return false;
      break;
    }
    case T_CAA: {
      if (rdlen < 2) return false;
      rr->u1 = buf[at];
      unsigned taglen = buf[at + 1];
      at += 2;
      if (at + taglen > end) return false;
      rr->str1 = scr_dnsq_memdup(buf + at, taglen);
      rr->str1_len = taglen;
      at += taglen;
      rr->blob = scr_dnsq_memdup(buf + at, end - at);
      rr->blob_len = end - at;
      break;
    }
    case T_TLSA:
      /* c-ares rejects a TLSA record with no certificate data, and a reply
       * holding one is EBADRESP whatever was asked. */
      if (rdlen < 4) return false;
      rr->u1 = buf[at];
      rr->u2 = buf[at + 1];
      rr->u3 = buf[at + 2];
      rr->blob = scr_dnsq_memdup(buf + at + 3, rdlen - 3);
      rr->blob_len = rdlen - 3;
      break;
    default:
      break; /* unmodeled: skipped (rdata ignored) */
  }
  *off = end;
  return true;
}

static void scr_dnsq_parsed_free(ScrDnsqParsed *parsed) {
  scr_dnsq_rrs_free(&parsed->rrs);
  free(parsed->question);
  parsed->question = NULL;
}

/* Parses a reply into its answer records. The whole packet is validated,
 * whatever the query type: c-ares parses every record of the message, so a
 * malformed rdata anywhere makes the reply EBADRESP (a TLSA with empty
 * certificate data included). */
static bool scr_dnsq_parse(const unsigned char *buf, size_t len, int qtype, ScrDnsqParsed *out) {
  memset(out, 0, sizeof *out);
  if (len < 12) return false;
  unsigned flags = ((unsigned)buf[2] << 8) | buf[3];
  if ((flags & 0x8000) == 0) return false; /* not a response */
  out->truncated = (flags & 0x0200) != 0;
  unsigned status = flags & 0x000f;
  if (status != 0) {
    out->status = status;
    return true;
  }
  unsigned qdcount, ancount, nscount, arcount;
  size_t off = 4;
  if (!scr_dnsq_rd_u16(buf, len, &off, &qdcount) || !scr_dnsq_rd_u16(buf, len, &off, &ancount) ||
      !scr_dnsq_rd_u16(buf, len, &off, &nscount) || !scr_dnsq_rd_u16(buf, len, &off, &arcount)) {
    scr_dnsq_parsed_free(out);
    return false;
  }
  off = 12;
  for (unsigned i = 0; i < qdcount; i++) {
    char *name = scr_dnsq_read_name(buf, len, &off, 0);
    if (name == NULL || off + 4 > len) {
      free(name);
      scr_dnsq_parsed_free(out);
      return false;
    }
    if (i == 0) out->question = name;
    else free(name);
    off += 4;
  }
  for (unsigned i = 0; i < ancount; i++) {
    char *owner = scr_dnsq_read_name(buf, len, &off, 0);
    if (owner == NULL) {
      scr_dnsq_parsed_free(out);
      return false;
    }
    free(owner);
    unsigned type, cls, ttl, rdlen;
    if (!scr_dnsq_rd_u16(buf, len, &off, &type) || !scr_dnsq_rd_u16(buf, len, &off, &cls) ||
        !scr_dnsq_rd_u32(buf, len, &off, &ttl) || !scr_dnsq_rd_u16(buf, len, &off, &rdlen)) {
      scr_dnsq_parsed_free(out);
      return false;
    }
    bool modeled = type == T_A || type == T_AAAA || type == T_CNAME || type == T_NS || type == T_PTR ||
                   type == T_MX || type == T_TXT || type == T_SOA || type == T_SRV || type == T_NAPTR ||
                   type == T_CAA || type == T_TLSA;
    if (cls == 1 && modeled) {
      ScrDnsRR *rr = scr_dnsq_rr_push(&out->rrs);
      rr->type = (int)type;
      rr->idx = i;
      rr->ttl = ttl;
      if (!scr_dnsq_parse_rdata(buf, len, &off, rdlen, rr)) {
        scr_dnsq_parsed_free(out);
        return false;
      }
    } else {
      if ((size_t)rdlen > len || off > len - rdlen) {
        scr_dnsq_parsed_free(out);
        return false;
      }
      off += rdlen;
      /* ANY keeps a placeholder so a reply of answers we do not model still
       * yields [] rather than ENODATA. */
      if (qtype == T_ANY) {
        ScrDnsRR *rr = scr_dnsq_rr_push(&out->rrs);
        rr->idx = i;
      }
    }
  }
  /* The authority and additional sections are not used, but c-ares parses
   * them too, so a malformed record there still fails the reply. */
  for (unsigned i = 0; i < nscount + arcount; i++) {
    char *owner = scr_dnsq_read_name(buf, len, &off, 0);
    if (owner == NULL) {
      scr_dnsq_parsed_free(out);
      return false;
    }
    free(owner);
    unsigned type, cls, ttl, rdlen;
    if (!scr_dnsq_rd_u16(buf, len, &off, &type) || !scr_dnsq_rd_u16(buf, len, &off, &cls) ||
        !scr_dnsq_rd_u32(buf, len, &off, &ttl) || !scr_dnsq_rd_u16(buf, len, &off, &rdlen) ||
        (size_t)rdlen > len || off > len - rdlen) {
      scr_dnsq_parsed_free(out);
      return false;
    }
    off += rdlen;
  }
  return true;
}

/* The result value for a parsed response, or NULL with *code set to the
 * DNS-derived error code. Each family follows the c-ares parser Node's
 * traits call, which is what decides [] versus ENODATA. */
static ScrDyn *scr_dnsq_build_result(const ScrDnsqParsed *parsed, int qtype, bool ttl_option, const char **code) {
  if (parsed->status != 0) {
    *code = SCR_DNSQ_RCODE(parsed->status);
    return NULL;
  }
  if (parsed->rrs.n == 0) {
    /* Every parser reports an empty answer section as ENODATA before it
     * looks at record types, even the SOA one (which is EBADRESP only for a
     * non-empty answer that holds no SOA). */
    *code = "ENODATA";
    return NULL;
  }

  bool has_cname = false, has_a = false;
  const ScrDnsRR *first_cname = NULL;
  double cname_ttl = -1;
  for (size_t i = 0; i < parsed->rrs.n; i++) {
    const ScrDnsRR *rr = &parsed->rrs.items[i];
    if (rr->type == T_CNAME) {
      if (!has_cname) first_cname = rr;
      has_cname = true;
      if (cname_ttl < 0 || (double)rr->ttl < cname_ttl) cname_ttl = (double)rr->ttl;
    } else if (rr->type == T_A) {
      has_a = true;
    }
  }

  if (qtype == T_ANY) {
    /* Node's AnyTraits::Parse: address group, AAAA, MX, NS, TXT, SRV, PTR,
     * NAPTR, the first SOA, TLSA at (length before this stage + answer
     * index), then CAA. */
    ScrDyn *arr = scr_dyn_new_arr();
    if (has_cname) {
      ScrDyn *o = scr_dyn_new_obj();
      scr_dnsq_obj_str(o, "value", first_cname->target);
      scr_dnsq_obj_str(o, "type", "CNAME");
      scr_dyn_arr_push(arr, o);
    } else {
      for (size_t i = 0; i < parsed->rrs.n; i++) {
        const ScrDnsRR *rr = &parsed->rrs.items[i];
        if (rr->type == T_A) scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, T_A, false, -1, true));
      }
    }
    static const int stages[] = {T_AAAA, T_MX, T_NS, T_TXT, T_SRV, T_PTR, T_NAPTR};
    for (size_t g = 0; g < sizeof stages / sizeof stages[0]; g++) {
      for (size_t i = 0; i < parsed->rrs.n; i++) {
        const ScrDnsRR *rr = &parsed->rrs.items[i];
        if (rr->type == stages[g]) scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, stages[g], false, -1, true));
      }
    }
    for (size_t i = 0; i < parsed->rrs.n; i++) {
      const ScrDnsRR *rr = &parsed->rrs.items[i];
      if (rr->type == T_SOA) {
        scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, T_SOA, false, -1, true));
        break;
      }
    }
    /* A TLSA entry lands at the stage offset plus its answer index, so the
     * positions other answers held become holes. */
    size_t tlsa_span = 0;
    for (size_t i = 0; i < parsed->rrs.n; i++)
      if (parsed->rrs.items[i].type == T_TLSA && (size_t)parsed->rrs.items[i].idx + 1 > tlsa_span)
        tlsa_span = (size_t)parsed->rrs.items[i].idx + 1;
    for (size_t k = 0; k < tlsa_span; k++) {
      const ScrDnsRR *hit = NULL;
      for (size_t i = 0; i < parsed->rrs.n && hit == NULL; i++)
        if (parsed->rrs.items[i].type == T_TLSA && parsed->rrs.items[i].idx == k) hit = &parsed->rrs.items[i];
      if (hit != NULL) {
        scr_dyn_arr_push(arr, scr_dnsq_rr_value(hit, T_TLSA, false, -1, true));
      } else {
        scr_dyn_arr_push_hole(arr);
      }
    }
    for (size_t i = 0; i < parsed->rrs.n; i++) {
      const ScrDnsRR *rr = &parsed->rrs.items[i];
      if (rr->type == T_CAA) scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, T_CAA, false, -1, true));
    }
    return arr;
  }

  switch (qtype) {
    case T_SOA:
      for (size_t i = 0; i < parsed->rrs.n; i++)
        if (parsed->rrs.items[i].type == T_SOA)
          return scr_dnsq_rr_value(&parsed->rrs.items[i], T_SOA, ttl_option, -1, false);
      *code = "EBADRESP";
      return NULL;
    case T_CNAME:
      if (has_cname) {
        ScrDyn *arr = scr_dyn_new_arr();
        scr_dyn_arr_push(arr, scr_dnsq_cstr_dyn(first_cname->target));
        return arr;
      }
      /* ares_parse_a_reply answers with the question name when the reply
       * holds addresses but no CNAME. */
      if (has_a) {
        ScrDyn *arr = scr_dyn_new_arr();
        scr_dyn_arr_push(arr, scr_dnsq_cstr_dyn(parsed->question != NULL ? parsed->question : ""));
        return arr;
      }
      *code = "ENODATA";
      return NULL;
    case T_A:
    case T_AAAA: {
      size_t matched = 0;
      for (size_t i = 0; i < parsed->rrs.n; i++)
        if (parsed->rrs.items[i].type == qtype) matched++;
      if (matched == 0) {
        /* A CNAME makes the reply an alias rather than a miss. */
        if (has_cname) return scr_dyn_new_arr();
        *code = "ENODATA";
        return NULL;
      }
      ScrDyn *arr = scr_dyn_new_arr();
      size_t index = 0;
      for (size_t i = 0; i < parsed->rrs.n; i++) {
        const ScrDnsRR *rr = &parsed->rrs.items[i];
        if (rr->type != qtype) continue;
        if (!ttl_option) {
          scr_dyn_arr_push(arr, scr_dnsq_cstr_dyn(rr->target));
        } else if (index < 256) {
          scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, qtype, true, cname_ttl, false));
        } else {
          /* The TTL side array holds 256 entries; past it onresolve reads
           * undefined. */
          ScrDyn *o = scr_dyn_new_obj();
          scr_dnsq_obj_str(o, "address", rr->target);
          scr_dyn_obj_set(o, "ttl", 3, scr_dyn_undefined());
          scr_dyn_arr_push(arr, o);
        }
        index++;
      }
      return arr;
    }
    default: {
      /* NS and PTR are ENODATA without a record of their type; MX, TXT,
       * SRV, NAPTR, TLSA and CAA parse to an empty array. The answer is
       * counted first so the ENODATA path allocates nothing to leak. */
      size_t matched = 0;
      for (size_t i = 0; i < parsed->rrs.n; i++)
        if (parsed->rrs.items[i].type == qtype) matched++;
      if (matched == 0 && (qtype == T_NS || qtype == T_PTR)) {
        *code = "ENODATA";
        return NULL;
      }
      ScrDyn *arr = scr_dyn_new_arr();
      for (size_t i = 0; i < parsed->rrs.n; i++) {
        const ScrDnsRR *rr = &parsed->rrs.items[i];
        if (rr->type == qtype) scr_dyn_arr_push(arr, scr_dnsq_rr_value(rr, qtype, ttl_option, -1, false));
      }
      return arr;
    }
  }
}

/* ── delivery ────────────────────────────────────────────────────────── */

static ScrDyn *scr_dnsq_promise_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(clo->caps[0]);
  if (argc > 0 && !scr_dyn_is_nullish(args[0])) {
    scr_dyn_throw(scr_dyn_retain(args[0]));
    scr_promise_reject_pending(p);
  } else {
    ScrDyn *value = argc > 1 ? scr_dyn_retain(args[1]) : scr_dyn_undefined();
    scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  }
  scr_promise_release(p);
  return scr_dyn_undefined();
}

static void scr_dnsq_deliver(ScrDnsqQuery *q, ScrDyn *err /* +1, consumed */, ScrDyn *result /* +1, consumed */) {
  ScrDyn *call = scr_dyn_new_arr();
  if (q->promise) {
    ScrClosure *clo = scr_closure_new((void *)&scr_dnsq_promise_settle, 1);
    ScrBox *box = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, NULL);
    scr_box_set_ref(box, scr_promise_retain(q->promise_handle));
    clo->caps[0] = box;
    scr_dyn_arr_push(call, scr_dyn_new_func(clo, scr_dnsq_promise_settle, 2, "", ""));
  } else {
    scr_dyn_arr_push(call, scr_dyn_retain(q->callback));
    /* Node's onresolve answers a failure with callback(err) alone and a
     * result with callback(null, result): the arity is part of the
     * behavior a callback can observe. A checked thunk cannot hold the
     * absent argument (see scr_dnsq_callback_checked), so the query hands
     * it the placeholder instead. */
    scr_dyn_arr_push(call, err);
    if (err->kind == SCR_DYN_NULL || result->kind != SCR_DYN_UNDEF) scr_dyn_arr_push(call, result);
    else scr_dyn_release(result);
    scr_dns_deliver_dyn(call);
    return;
  }
  scr_dyn_arr_push(call, err);
  scr_dyn_arr_push(call, result);
  scr_dns_deliver_dyn(call);
}

/* The second argument a typed callback needs when Node passes none (its
 * first parameter is typed, so an undefined would not cross): an empty
 * array for the list results, and a zeroed SoaRecord. */
static ScrDyn *scr_dnsq_placeholder(int qtype) {
  if (qtype == T_SOA) {
    ScrDyn *o = scr_dyn_new_obj();
    scr_dnsq_obj_str(o, "nsname", "");
    scr_dnsq_obj_str(o, "hostmaster", "");
    scr_dnsq_obj_num(o, "serial", 0);
    scr_dnsq_obj_num(o, "refresh", 0);
    scr_dnsq_obj_num(o, "retry", 0);
    scr_dnsq_obj_num(o, "expire", 0);
    scr_dnsq_obj_num(o, "minttl", 0);
    scr_dnsq_obj_str(o, "type", "SOA");
    return o;
  }
  return scr_dyn_new_arr();
}

static void scr_dnsq_unlink(ScrDnsqQuery *q) {
  if (q->prev) q->prev->next = q->next;
  else scr_dnsq_live = q->next;
  if (q->next) q->next->prev = q->prev;
  q->next = q->prev = NULL;
}

static void scr_dnsq_finish(ScrDnsqQuery *q, const char *code, ScrDyn *result /* +1 or NULL */) {
  if (q->done) return;
  q->done = true;
  scr_dgram_poll_timer_cancel(q);
  scr_dnsq_close_fd(q->fd);
  q->fd = -1;
  scr_dnsq_unlink(q);
  ScrDyn *err;
  ScrDyn *value;
  if (code != NULL) {
    /* A reverse lookup with no PTR record reports ENOTFOUND, not ENODATA. */
    if (strcmp(code, "ENODATA") == 0 && strcmp(q->binding, "getHostByAddr") == 0) code = "ENOTFOUND";
    err = scr_dnsq_error(code, q->binding, q->err_host);
    value = q->promise || !q->typed ? scr_dyn_undefined() : scr_dnsq_placeholder(q->qtype);
  } else {
    err = scr_dyn_new_null();
    value = result != NULL ? result : scr_dyn_undefined();
  }
  scr_dnsq_deliver(q, err, value);
  scr_dnsr_release(q->r);
  scr_str_release(q->host);
  scr_str_release(q->err_host);
  scr_dyn_release(q->callback);
  scr_promise_release(q->promise_handle);
  free(q->pkt);
  free(q->rbuf);
  free(q);
}

/* ── the query's attempts ────────────────────────────────────────────── */

static int scr_dnsq_attempt_timeout(const ScrDnsResolver *r) {
  if (r->timeout > 0) return r->timeout;
  return 5000; /* c-ares's default per-try timeout */
}

static bool scr_dnsq_set_nonblock(int fd) {
#ifdef _WIN32
  u_long on = 1;
  return ioctlsocket(fd, FIONBIO, &on) == 0;
#else
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return false;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

/* setLocalAddress bound the query sockets: the address of the server's
 * family, when one was given ("::1" in the ipv4 slot counts as the v6
 * one). False when the kernel refuses the bind: c-ares fails the query
 * with ECONNREFUSED rather than sending from another source, which is what
 * Node reports when the configured source is not on the host. */
static bool scr_dnsq_bind_local(int fd, const ScrDnsResolver *r, int family) {
  const char *local = family == 4 ? r->local_v4 : r->local_v6;
  if (local[0] == '\0') return true;
  struct sockaddr_storage ss;
  socklen_t slen;
  memset(&ss, 0, sizeof ss);
  if (family == 4) {
    struct sockaddr_in *in = (struct sockaddr_in *)&ss;
    in->sin_family = AF_INET;
    if (inet_pton(AF_INET, local, &in->sin_addr) != 1) return true;
    slen = (socklen_t)sizeof *in;
  } else {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)&ss;
    in6->sin6_family = AF_INET6;
    if (inet_pton(AF_INET6, local, &in6->sin6_addr) != 1) return true;
    slen = (socklen_t)sizeof *in6;
  }
  return bind(fd, (struct sockaddr *)&ss, slen) == 0;
}

static void scr_dnsq_arm_timer(ScrDnsqQuery *q) {
  (void)scr_dgram_poll_timer(q, (double)scr_dnsq_attempt_timeout(q->r), q);
}

/* Starts one attempt: UDP to servers[attempt % n], the TCP retry when the
 * response asked for it. */
static void scr_dnsq_start_attempt(ScrDnsqQuery *q) {
  ScrDnsResolver *r = q->r;
  size_t nservers = r->servers.n;
  if (nservers == 0) {
    /* setServers([]) leaves the channel with nowhere to send: c-ares answers
     * an error code outside Node's table, which it spells this way. */
    scr_dnsq_finish(q, "UNKNOWN_ARES_ERROR", NULL);
    return;
  }
  if (q->attempt >= r->tries * (int)nservers) {
    scr_dnsq_finish(q, q->last_refused ? "ECONNREFUSED" : "ETIMEOUT", NULL);
    return;
  }
  const ScrDnsServer *server = &r->servers.items[(size_t)q->attempt % nservers];
  struct sockaddr_storage ss;
  socklen_t slen = 0;
  if (!scr_dnsq_sockaddr(server, &ss, &slen)) {
    q->attempt++;
    scr_dnsq_start_attempt(q);
    return;
  }
  if (q->tcp) {
    /* A fresh connection: nothing of an earlier frame carries over. */
    q->rlen = 0;
    q->want = 0;
    q->have_len = false;
    int fd = socket(ss.ss_family, SOCK_STREAM, 0);
    if (fd < 0) {
      q->attempt++;
      scr_dnsq_start_attempt(q);
      return;
    }
    scr_dnsq_set_nonblock(fd);
    if (!scr_dnsq_bind_local(fd, r, server->family)) {
      scr_dnsq_close_fd(fd);
      scr_dnsq_finish(q, "ECONNREFUSED", NULL);
      return;
    }
    q->fd = fd;
    int rc = connect(fd, (struct sockaddr *)&ss, slen);
    if (rc != 0) {
#ifdef _WIN32
      int err = WSAGetLastError();
      if (err != WSAEWOULDBLOCK && err != WSAEINPROGRESS) {
#else
      if (errno != EINPROGRESS && errno != EAGAIN) {
#endif
        scr_dnsq_close_fd(fd);
        q->fd = -1;
        q->tcp = false;
        q->attempt++;
        scr_dnsq_start_attempt(q);
        return;
      }
    }
    q->connecting = true;
    scr_dgram_poll_write(fd, q, true);
    scr_dnsq_arm_timer(q);
    return;
  }
  int fd = socket(ss.ss_family, SOCK_DGRAM, 0);
  if (fd < 0) {
    q->attempt++;
    scr_dnsq_start_attempt(q);
    return;
  }
  scr_dnsq_set_nonblock(fd);
  if (!scr_dnsq_bind_local(fd, r, server->family)) {
    scr_dnsq_close_fd(fd);
    scr_dnsq_finish(q, "ECONNREFUSED", NULL);
    return;
  }
  q->fd = fd;
  (void)connect(fd, (struct sockaddr *)&ss, slen); /* connected UDP: ICMP errors surface */
  ssize_t sent = send(fd, (const char *)q->pkt, q->pkt_len, 0);
  if (sent < 0) {
#ifdef _WIN32
    int err = WSAGetLastError();
    if (err == WSAECONNREFUSED) {
#else
    if (errno == ECONNREFUSED) {
#endif
      scr_dnsq_close_fd(fd);
      q->fd = -1;
      q->attempt++;
      scr_dnsq_start_attempt(q);
      return;
    }
  }
  scr_dgram_poll_read(fd, q, true);
  scr_dnsq_arm_timer(q);
}

/* One response message. Returns true when the query settled. */
static void scr_dnsq_response(ScrDnsqQuery *q, const unsigned char *buf, size_t len) {
  ScrDnsqParsed parsed;
  if (!scr_dnsq_parse(buf, len, q->qtype, &parsed)) {
    scr_dnsq_finish(q, "EBADRESP", NULL);
    return;
  }
  if (parsed.truncated && !q->tcp) {
    scr_dnsq_parsed_free(&parsed);
    scr_dnsq_close_fd(q->fd);
    q->fd = -1;
    q->tcp = true;
    scr_dnsq_start_attempt(q); /* same attempt, TCP */
    return;
  }
  const char *code = NULL;
  ScrDyn *result = scr_dnsq_build_result(&parsed, q->qtype, q->ttl, &code);
  scr_dnsq_parsed_free(&parsed);
  if (result == NULL) {
    scr_dnsq_finish(q, code, NULL);
    return;
  }
  scr_dnsq_finish(q, NULL, result);
}

/* Whether a packet answers the outstanding query: the response bit, the
 * QUERY opcode, exactly one question, and that question's encoded name,
 * type and class matching the request. Anything else is not this query's
 * answer and is ignored — accepting it would let an off-path sender who
 * guesses the transaction id (and the ephemeral port) hand the program a
 * forged answer. */
static bool scr_dnsq_matches(const ScrDnsqQuery *q, const unsigned char *buf, size_t len) {
  if (len < 12) return false;
  if (buf[0] != q->id[0] || buf[1] != q->id[1]) return false;
  if ((buf[2] & 0x80) == 0) return false; /* QR: a response */
  if ((buf[2] & 0x78) != 0) return false; /* opcode 0: a standard query */
  unsigned qd = ((unsigned)buf[4] << 8) | buf[5];
  /* A truncated answer may carry no question at all; its TC bit only moves
   * the query to TCP, where the answer is read and validated again. */
  if (qd == 0 && (buf[2] & 0x02) != 0) return true;
  if (qd != 1 || q->qname_len == 0) return false;
  /* The question is the name this query sent, echoed uncompressed. */
  size_t at = 12, wire = 0;
  for (;;) {
    if (at >= len) return false;
    unsigned label = buf[at];
    if (label == 0) {
      wire = at + 1 - 12;
      break;
    }
    if ((label & 0xc0) != 0) return false; /* a pointer: not our echo */
    if (at + 1 + label > len) return false;
    at += 1 + label;
  }
  if (wire != q->qname_len) return false;
  /* DNS names compare case-insensitively. */
  for (size_t i = 0; i < wire; i++) {
    unsigned a = buf[12 + i], b = q->qname[i];
    if (a >= 'A' && a <= 'Z') a += 32;
    if (b >= 'A' && b <= 'Z') b += 32;
    if (a != b) return false;
  }
  size_t tail = 12 + wire;
  if (tail + 4 > len) return false;
  unsigned qtype = ((unsigned)buf[tail] << 8) | buf[tail + 1];
  unsigned qclass = ((unsigned)buf[tail + 2] << 8) | buf[tail + 3];
  return qtype == (unsigned)q->qtype && qclass == 1; /* IN */
}

static void scr_dnsq_udp_ready(ScrDnsqQuery *q) {
  unsigned char buf[4096];
  for (;;) {
    ssize_t n = recv(q->fd, (char *)buf, sizeof buf, 0);
    if (n < 0) {
#ifdef _WIN32
      int err = WSAGetLastError();
      if (err == WSAECONNREFUSED) {
#else
      if (errno == ECONNREFUSED) {
#endif
        /* c-ares treats a port-unreachable as that server failing and
         * requeues the query for the next configured server. The query
         * records this attempt's error, which is the one it answers with
         * when its tries run out. */
        scr_dnsq_close_fd(q->fd);
        q->fd = -1;
        q->last_refused = true;
        q->attempt++;
        scr_dnsq_start_attempt(q);
        return;
      }
      return; /* EAGAIN and friends: wait for the next readiness */
    }
    if (n == 0) return;
    if (!scr_dnsq_matches(q, buf, (size_t)n)) continue; /* not this query's answer */
    scr_dnsq_response(q, buf, (size_t)n);
    return;
  }
}

static void scr_dnsq_tcp_send(ScrDnsqQuery *q) {
  q->connecting = false;
  int err = 0;
  socklen_t elen = sizeof err;
  if (getsockopt(q->fd, SOL_SOCKET, SO_ERROR, (char *)&err, &elen) != 0 || err != 0) {
    scr_dnsq_close_fd(q->fd);
    q->fd = -1;
    q->tcp = false;
    q->attempt++;
    scr_dnsq_start_attempt(q);
    return;
  }
  unsigned char *out = malloc(q->pkt_len + 2);
  if (out == NULL) scr_trap("scriptc: out of memory\n");
  out[0] = (unsigned char)(q->pkt_len >> 8);
  out[1] = (unsigned char)(q->pkt_len & 0xff);
  memcpy(out + 2, q->pkt, q->pkt_len);
  size_t off = 0;
  while (off < q->pkt_len + 2) {
    ssize_t n = send(q->fd, (const char *)out + off, q->pkt_len + 2 - off, 0);
    if (n < 0) {
#ifdef _WIN32
      int e = WSAGetLastError();
      if (e == WSAEWOULDBLOCK) break;
#else
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
#endif
      free(out);
      scr_dnsq_close_fd(q->fd);
      q->fd = -1;
      q->tcp = false;
      q->attempt++;
      scr_dnsq_start_attempt(q);
      return;
    }
    off += (size_t)n;
  }
  free(out);
  scr_dgram_poll_write(q->fd, q, false);
  scr_dgram_poll_read(q->fd, q, true);
}

/* A frame carries a two-byte length prefix and that many payload bytes. The
 * buffer is sized to the advertised frame and never grows past it, so a
 * responder cannot make the query accumulate memory; a frame shorter than
 * the DNS header is a protocol error (an empty frame would otherwise read as
 * "length not known yet" and leave the buffer growing with the stream).
 * Reads per readiness callback are bounded; the poller is level-triggered
 * and calls back while the socket has more. */
enum { SCR_DNSQ_TCP_READS = 16, SCR_DNSQ_TCP_FIRST = 4096, SCR_DNSQ_HDR = 12 };

static void scr_dnsq_tcp_read(ScrDnsqQuery *q) {
  for (int reads = 0; reads < SCR_DNSQ_TCP_READS; reads++) {
    if (!q->have_len && q->rlen >= 2) {
      q->want = ((size_t)q->rbuf[0] << 8) | q->rbuf[1];
      if (q->want < SCR_DNSQ_HDR) {
        scr_dnsq_finish(q, "EBADRESP", NULL);
        return;
      }
      q->have_len = true;
    }
    if (q->have_len && q->rlen >= q->want + 2) {
      /* The peer is the configured server, but the frame it answered with
       * must still be this query's response: a stream that carries
       * somebody else's answer is a bad response, not a result. */
      if (!scr_dnsq_matches(q, q->rbuf + 2, q->want)) {
        scr_dnsq_finish(q, "EBADRESP", NULL);
        return;
      }
      scr_dnsq_response(q, q->rbuf + 2, q->want);
      return;
    }
    size_t cap = q->have_len ? q->want + 2 : SCR_DNSQ_TCP_FIRST;
    if (q->rlen == q->rcap) {
      if (q->rcap >= cap) return; /* full: the frame itself is due next call */
      unsigned char *buf = realloc(q->rbuf, cap);
      if (buf == NULL) scr_trap("scriptc: out of memory\n");
      q->rbuf = buf;
      q->rcap = cap;
    }
    size_t room = q->rcap - q->rlen < cap - q->rlen ? q->rcap - q->rlen : cap - q->rlen;
    ssize_t n = recv(q->fd, (char *)q->rbuf + q->rlen, room, 0);
    if (n < 0) {
#ifdef _WIN32
      int e = WSAGetLastError();
      if (e == WSAEWOULDBLOCK) return;
#else
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
#endif
      scr_dnsq_finish(q, "ECONNREFUSED", NULL);
      return;
    }
    if (n == 0) {
      scr_dnsq_finish(q, "EOF", NULL);
      return;
    }
    q->rlen += (size_t)n;
  }
}

static void scr_dnsq_event(void *udata, unsigned events) {
  ScrDnsqQuery *q = (ScrDnsqQuery *)udata;
  if (q->done) return;
  if (events & SCRP_TIMER) {
    scr_dnsq_close_fd(q->fd);
    q->fd = -1;
    q->tcp = false;
    q->rlen = 0;
    q->want = 0;
    q->have_len = false;
    q->last_refused = false;
    q->attempt++;
    scr_dnsq_start_attempt(q);
    return;
  }
  if (q->fd < 0) return;
  if (q->tcp) {
    if (q->connecting) {
      if (!(events & SCRP_WRITABLE)) return;
      scr_dnsq_tcp_send(q);
      return;
    }
    if (events & (SCRP_READABLE | SCRP_WRITABLE)) scr_dnsq_tcp_read(q);
    return;
  }
  if (events & SCRP_READABLE) scr_dnsq_udp_ready(q);
}

/* ── query construction ──────────────────────────────────────────────── */

enum { SCR_DNSQ_QUEUED, SCR_DNSQ_SETTLED, SCR_DNSQ_INVALID };

/* Queues one query. reverse parses its address first (an invalid one is
 * reported by the caller before anything is queued) and answers from the
 * hosts file without a query when an entry matches; `err_name` is the name
 * a later error reports. */
static int scr_dnsq_start(ScrDnsResolver *r, const ScrStr *binding, const ScrDyn *name, const ScrDyn *options,
                          bool ttl, bool typed, ScrDyn *callback /* +1 or NULL */,
                          ScrPromise *promise /* +1 or NULL */) {
  char bbuf[32];
  int type = T_A;
  if (!scr_dnsq_binding_type(binding, &type)) type = T_A;
  const char *bname = scr_dnsq_binding_name(binding, bbuf, sizeof bbuf);
  const ScrStr *err_name = (const ScrStr *)name->v.str;
  ScrStr *ptrname = NULL;
  if (strcmp(bname, "getHostByAddr") == 0) {
    char tmp[80];
    unsigned char a[16];
    int fam = scr_dnsq_ip_version(err_name->data, err_name->len);
    if (fam == 0 && err_name->len >= 2 && err_name->data[err_name->len - 1] == '%') {
      /* c-ares also takes an empty zone on the reverse path ("fe80::1%"),
       * which isIP and setServers reject; only IPv6 can carry one. */
      int base = scr_dnsq_ip_version(err_name->data, err_name->len - 1);
      if (base == 6) fam = base;
    }
    bool ok = fam != 0 && err_name->len < sizeof tmp;
    size_t alen = err_name->len;
    if (ok && fam == 6) {
      /* A zone is not part of the address: Node encodes and looks up the
       * address without it. */
      const char *pct = memchr(err_name->data, '%', err_name->len);
      if (pct != NULL && pct != err_name->data) alen = (size_t)(pct - err_name->data);
    }
    if (ok) {
      memcpy(tmp, err_name->data, alen);
      tmp[alen] = '\0';
      ok = inet_pton(fam == 4 ? AF_INET : AF_INET6, tmp, a) == 1;
    }
    if (!ok) {
      /* Nothing is queued, so the caller's retained callback or promise
       * comes back to it here; the caller throws instead. */
      if (callback != NULL) scr_dyn_release(callback);
      if (promise != NULL) scr_promise_release(promise);
      return SCR_DNSQ_INVALID;
    }
    char text[128];
    if (fam == 4) {
      snprintf(text, sizeof text, "%u.%u.%u.%u.in-addr.arpa", a[3], a[2], a[1], a[0]);
    } else {
      char hex[96];
      size_t hn = 0;
      for (int i = 15; i >= 0; i--) hn += (size_t)snprintf(hex + hn, sizeof hex - hn, "%x.%x.", a[i] & 0xf, a[i] >> 4);
      snprintf(text, sizeof text, "%sip6.arpa", hex);
    }
    ScrDyn *names = scr_dnsq_hosts_reverse(tmp, fam);
    if (names != NULL) {
      scr_dnsq_deliver_now(callback, promise, names);
      return SCR_DNSQ_SETTLED;
    }
    ptrname = scr_str_new(text, strlen(text));
  }
  ScrDnsqQuery *q = calloc(1, sizeof *q);
  if (q == NULL) scr_trap("scriptc: out of memory\n");
  q->r = (ScrDnsResolver *)scr_dnsr_retain(r);
  snprintf(q->binding, sizeof q->binding, "%s", bname);
  q->host = scr_str_retain(ptrname != NULL ? ptrname : (ScrStr *)name->v.str);
  q->err_host = scr_str_retain((ScrStr *)err_name);
  if (ptrname != NULL) scr_str_release(ptrname);
  q->ttl = ttl;
  q->typed = typed;
  q->promise = promise != NULL;
  q->callback = callback;
  q->promise_handle = promise;
  q->gen = r->gen;
  q->qtype = type;
  q->fd = -1;
  (void)options;
  /* The question name, encoded before the packet is sized: ada's ToASCII
   * can make the wire name longer than the UTF-8 the caller passed
   * (ü.test is 6 bytes and xn--tda.test is 12), so sizing from the input
   * would cut a valid name into EBADNAME. */
  bool bad = false;
  unsigned char qname[SCR_DNSQ_NAME_MAX];
  size_t n = scr_dnsq_encode_name(q->host, qname, sizeof qname, &bad);
  /* The question packet. */
  size_t cap = 12 + n + 4;
  q->pkt = malloc(cap);
  if (q->pkt == NULL) scr_trap("scriptc: out of memory\n");
  scr_dnsq_pick_id(q);
  memset(q->pkt, 0, 12);
  q->pkt[0] = q->id[0];
  q->pkt[1] = q->id[1];
  q->pkt[2] = 0x01; /* RD */
  q->pkt[4] = 0x00;
  q->pkt[5] = 0x01; /* QDCOUNT */
  if (!bad) {
    memcpy(q->pkt + 12, qname, n);
    memcpy(q->qname, qname, n);
  }
  q->qname_len = bad ? 0 : n;
  /* link */
  q->prev = NULL;
  q->next = scr_dnsq_live;
  if (scr_dnsq_live) scr_dnsq_live->prev = q;
  scr_dnsq_live = q;
  if (bad) {
    /* c-ares refuses the name before any packet leaves; the error reaches
     * the callback (or rejects the promise) through the same queue. */
    scr_dnsq_finish(q, "EBADNAME", NULL);
    return SCR_DNSQ_QUEUED;
  }
  q->pkt_len = 12 + n + 4;
  q->pkt[12 + n] = (unsigned char)(type >> 8);
  q->pkt[12 + n + 1] = (unsigned char)(type & 0xff);
  q->pkt[12 + n + 2] = 0x00;
  q->pkt[12 + n + 3] = 0x01;
  scr_dgram_poll_ready();
  scr_dnsq_start_attempt(q);
  return SCR_DNSQ_QUEUED;
}

/* ── argument checks (lib/internal/dns/callback_resolver.js) ─────────── */

/* An absent argument is the undefined value: Node's message names it, and
 * the handle's invoke passes NULL where the call had no argument. */
static const ScrDyn *scr_dnsq_arg_or_undef(const ScrDyn *v) {
  return v != NULL ? v : scr_dyn_undefined();
}

static bool scr_dnsq_validate_name(const ScrDyn *name) {
  if (name == NULL || name->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("name", "of type string", scr_dnsq_arg_or_undef(name));
    return false;
  }
  return true;
}

static bool scr_dnsq_validate_callback(const ScrDyn *callback) {
  if (callback == NULL || callback->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("callback", "of type function", scr_dnsq_arg_or_undef(callback));
    return false;
  }
  return true;
}

static bool scr_dnsq_ttl_of(const ScrDyn *options) {
  if (options == NULL || scr_dyn_is_nullish(options)) return false;
  if (options->kind != SCR_DYN_OBJ) return false;
  const ScrDyn *v = scr_dyn_obj_get(options, "ttl", 3);
  return v != NULL && scr_dyn_truthy(v);
}

/* Node's resolveMap keys (lib/internal/dns/utils.js). */
static const struct {
  const char *rrtype;
  const char *binding;
} scr_dnsq_resolve_map[] = {
    {"ANY", "queryAny"},   {"A", "queryA"},      {"AAAA", "queryAaaa"}, {"CAA", "queryCaa"},
    {"CNAME", "queryCname"}, {"MX", "queryMx"},   {"NS", "queryNs"},     {"TLSA", "queryTlsa"},
    {"TXT", "queryTxt"},   {"SRV", "querySrv"},  {"PTR", "queryPtr"},   {"NAPTR", "queryNaptr"},
    {"SOA", "querySoa"},
};

static const char *scr_dnsq_resolve_lookup(const ScrStr *rrtype) {
  for (size_t i = 0; i < sizeof scr_dnsq_resolve_map / sizeof scr_dnsq_resolve_map[0]; i++) {
    size_t n = strlen(scr_dnsq_resolve_map[i].rrtype);
    if (rrtype->len == n && memcmp(rrtype->data, scr_dnsq_resolve_map[i].rrtype, n) == 0)
      return scr_dnsq_resolve_map[i].binding;
  }
  return NULL;
}

/* resolve's rrtype → c-ares binding, with Node's validation for the two
 * forms: the callback form takes a function in the rrtype slot as the
 * callback (an A query), and the promise form validates rrtype before the
 * hostname, and never passes options. NULL answers with the exception
 * pending. */
static const char *scr_dnsq_rr_of(const ScrDyn *rrtype, bool promises, const ScrDyn **cb_io) {
  if (promises) {
    if (rrtype != NULL && rrtype->kind != SCR_DYN_UNDEF) {
      if (rrtype->kind != SCR_DYN_STR) {
        scr_dyn_arg_type_fail("rrtype", "of type string", rrtype);
        return NULL;
      }
      const char *binding = scr_dnsq_resolve_lookup(rrtype->v.str);
      if (binding == NULL) scr_dyn_arg_value_fail("rrtype", NULL, rrtype);
      return binding;
    }
    return "queryA";
  }
  if (rrtype != NULL && rrtype->kind == SCR_DYN_STR) {
    const char *binding = scr_dnsq_resolve_lookup(rrtype->v.str);
    if (binding == NULL) scr_dyn_arg_value_fail("rrtype", NULL, rrtype);
    return binding;
  }
  if (rrtype != NULL && rrtype->kind == SCR_DYN_FUNC) {
    *cb_io = rrtype;
    return "queryA";
  }
  scr_dyn_arg_type_fail("rrtype", "of type string", rrtype);
  return NULL;
}

/* The binding as the ScrStr the entry points take (a fresh string, +1). */
static ScrStr *scr_dnsq_binding_str(const char *binding) { return scr_str_new(binding, strlen(binding)); }

/* ── public entry points ─────────────────────────────────────────────── */

/* c-ares answers gethostbyaddr from the hosts file before it queries DNS.
 * Returns the names of the matching line after the first one (hostent's
 * aliases, which is what Node reports), or NULL when no line matches. */
/* The next blank-separated token of a hosts line (strtok_r is POSIX; the
 * units build as C11). Answers NULL at the end. */
static char *scr_dnsq_next_token(char **cursor) {
  char *p = *cursor;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (*p == '\0') {
    *cursor = p;
    return NULL;
  }
  char *token = p;
  while (*p != '\0' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
  if (*p != '\0') *p++ = '\0';
  *cursor = p;
  return token;
}

static ScrDyn *scr_dnsq_hosts_reverse(const char *text, int family) {
  unsigned char want[16];
  if (inet_pton(family == 4 ? AF_INET : AF_INET6, text, want) != 1) return NULL;
  size_t want_len = family == 4 ? 4 : 16;
#ifdef _WIN32
  char path[512];
  const char *root = getenv("SystemRoot");
  snprintf(path, sizeof path, "%s\\System32\\drivers\\etc\\hosts", root != NULL ? root : "C:\\Windows");
#else
  const char *path = "/etc/hosts";
#endif
  FILE *f = fopen(path, "r");
  if (f == NULL) return NULL;
  ScrDyn *names = NULL;
  char line[1024];
  while (names == NULL && fgets(line, sizeof line, f) != NULL) {
    char *hash = strchr(line, '#');
    if (hash != NULL) *hash = '\0';
    char *cursor = line;
    char *token = scr_dnsq_next_token(&cursor);
    if (token == NULL) continue;
    unsigned char got[16];
    if (inet_pton(family == 4 ? AF_INET : AF_INET6, token, got) != 1) continue;
    if (memcmp(got, want, want_len) != 0) continue;
    ScrDyn *list = scr_dyn_new_arr();
    bool first = true;
    while ((token = scr_dnsq_next_token(&cursor)) != NULL) {
      if (first) {
        first = false;
        continue;
      }
      scr_dyn_arr_push(list, scr_dnsq_cstr_dyn(token));
    }
    names = list;
  }
  fclose(f);
  return names;
}

/* Delivers a result that never touched the network (the hosts file path). */
static void scr_dnsq_deliver_now(ScrDyn *callback /* +1, consumed */, ScrPromise *promise /* +1, consumed */,
                                 ScrDyn *result /* +1, consumed */) {
  ScrDnsqQuery q;
  memset(&q, 0, sizeof q);
  q.promise = promise != NULL;
  q.callback = callback;
  q.promise_handle = promise;
  scr_dnsq_deliver(&q, scr_dyn_new_null(), result);
  scr_dyn_release(callback);
  scr_promise_release(promise);
}

/* The tail shared by every callback-form query: name/callback checks, then
 * the query (or the c-ares synchronous error for reverse's address). */
/* The module functions' arguments arrive from a libCall slot: a static
 * string, array or record the compiler passes by reference is a capsule
 * (SCR_DYN_TYPED_REF), so the entries below read its materialized view.
 * *owned receives the view the caller must release, or NULL. */
static const ScrDyn *scr_dnsq_arg_read(const ScrDyn *v, ScrDyn **owned) {
  *owned = NULL;
  if (v != NULL && v->kind == SCR_DYN_TYPED_REF) *owned = scr_dyn_typed_ref_materialize(v);
  return *owned != NULL ? *owned : v;
}

static void scr_dnsq_query_chk(ScrDnsResolver *r, const ScrStr *binding, const ScrDyn *name,
                               const ScrDyn *options, const ScrDyn *callback, bool typed) {
  ScrDyn *name_owned, *options_owned;
  const ScrDyn *name_view = scr_dnsq_arg_read(name, &name_owned);
  const ScrDyn *options_view = scr_dnsq_arg_read(options, &options_owned);
  char bbuf[32];
  const char *bname = scr_dnsq_binding_name(binding, bbuf, sizeof bbuf);
  if (!scr_dnsq_validate_name(name_view)) goto done;
  if (!scr_dnsq_validate_callback(callback)) goto done;
  {
    int status = scr_dnsq_start(r, binding, name_view, options_view, scr_dnsq_ttl_of(options_view), typed,
                                scr_dyn_retain((ScrDyn *)callback), NULL);
    if (status == SCR_DNSQ_INVALID) {
      /* c-ares parses the address before it queues anything; a bad one throws
       * out of the call. The throw unwinds without running the cleanup below,
       * so the materialized views go first. */
      ScrDyn *err = scr_dnsq_error("EINVAL", bname, name_view->v.str);
      if (name_owned != NULL) scr_dyn_release(name_owned);
      if (options_owned != NULL) scr_dyn_release(options_owned);
      scr_dyn_throw(err);
    }
  }
done:
  if (name_owned != NULL) scr_dyn_release(name_owned);
  if (options_owned != NULL) scr_dyn_release(options_owned);
}

void scr_dns_resolve_chk(const ScrStr *binding, const ScrDyn *name, const ScrDyn *options, const ScrDyn *callback,
                         bool typed) {
  ScrDnsResolver *r = scr_dnsq_default(false);
  /* The module functions take (name, [options,] callback). */
  const ScrDyn *cb = callback;
  const ScrDyn *opts = options;
  if (cb == NULL || cb->kind == SCR_DYN_UNDEF) {
    /* two-argument form: the options slot was the callback */
    cb = options;
    opts = NULL;
  }
  scr_dnsq_query_chk(r, binding, name, opts, cb, typed);
}

/* The promise forms' shared tail: the name check, then the query (or
 * c-ares's synchronous EINVAL for reverse's address). */
static ScrPromise *scr_dnsq_promise_start(ScrDnsResolver *r, const ScrStr *binding, const ScrDyn *name,
                                          const ScrDyn *options) {
  ScrDyn *name_owned, *options_owned;
  const ScrDyn *name_view = scr_dnsq_arg_read(name, &name_owned);
  const ScrDyn *options_view = scr_dnsq_arg_read(options, &options_owned);
  if (!scr_dnsq_validate_name(name_view)) {
    if (name_owned != NULL) scr_dyn_release(name_owned);
    if (options_owned != NULL) scr_dyn_release(options_owned);
    return NULL;
  }
  ScrPromise *p = scr_promise_new();
  if (scr_dnsq_start(r, binding, name_view, options_view, scr_dnsq_ttl_of(options_view), false, NULL,
                     scr_promise_retain(p)) == SCR_DNSQ_INVALID) {
    char bbuf[32];
    const char *bname = scr_dnsq_binding_name(binding, bbuf, sizeof bbuf);
    ScrDyn *err = scr_dnsq_error("EINVAL", bname, name_view->v.str);
    /* The callback form throws c-ares's synchronous EINVAL out of the
     * call, but the promise forms report it the way lib/internal/dns/
     * promises.js does: the promise rejects. scr_dnsq_start consumed its
     * retained promise; the argument views go, then the rejection is
     * moved into `p` and the promise is returned. */
    if (name_owned != NULL) scr_dyn_release(name_owned);
    if (options_owned != NULL) scr_dyn_release(options_owned);
    scr_dyn_throw(err);
    scr_promise_reject_pending(p);
    return p;
  }
  if (name_owned != NULL) scr_dyn_release(name_owned);
  if (options_owned != NULL) scr_dyn_release(options_owned);
  return p;
}

ScrPromise *scr_dns_resolve_promise(const ScrStr *binding, const ScrDyn *name, const ScrDyn *options) {
  return scr_dnsq_promise_start(scr_dnsq_default(true), binding, name, options);
}

/* ── Resolver construction ───────────────────────────────────────────── */

static bool scr_dnsq_int32(const ScrDyn *v, const char *name, double min, double max) {
  if (v == NULL || v->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail(name, "of type number", v);
    return false;
  }
  double d = v->v.num;
  if (!scr_dnsq_is_int(d)) {
    char msg[320], rec[48];
    snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
             scr_dnsq_num_received(d, rec));
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, strlen(msg), "ERR_OUT_OF_RANGE");
    return false;
  }
  if (d < min || d > max) {
    char msg[320], rec[48], mstr[32], xstr[32];
    snprintf(mstr, sizeof mstr, "%.0f", min);
    snprintf(xstr, sizeof xstr, "%.0f", max);
    snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be >= %s && <= %s. Received %s", name,
             mstr, xstr, scr_dnsq_num_received(d, rec));
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, strlen(msg), "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

static ScrDyn *scr_dns_resolver_new_plain(const ScrDyn *options, bool promises);

ScrDyn *scr_dns_resolver_new(const ScrDyn *options, bool promises) {
  ScrDyn *view;
  const ScrDyn *read = scr_dnsq_arg_read(options, &view);
  ScrDyn *handle = scr_dns_resolver_new_plain(read, promises);
  if (view != NULL) scr_dyn_release(view);
  return handle;
}

static ScrDyn *scr_dns_resolver_new_plain(const ScrDyn *options, bool promises) {
  /* { ...options } — only an object contributes members. */
  const ScrDyn *o = options != NULL && options->kind == SCR_DYN_OBJ ? options : NULL;
  const ScrDyn *timeout = o ? scr_dyn_obj_get(o, "timeout", 7) : NULL;
  const ScrDyn *tries = o ? scr_dyn_obj_get(o, "tries", 5) : NULL;
  const ScrDyn *max_timeout = o ? scr_dyn_obj_get(o, "maxTimeout", 10) : NULL;
  double t = -1, tr = 4, mt = 0;
  if (timeout != NULL && timeout->kind != SCR_DYN_UNDEF) {
    if (!scr_dnsq_int32(timeout, "options.timeout", -1, 2147483647)) return NULL;
    t = timeout->v.num + 0; /* -0 → +0 */
  }
  if (tries != NULL && tries->kind != SCR_DYN_UNDEF) {
    if (!scr_dnsq_int32(tries, "options.tries", 1, 2147483647)) return NULL;
    tr = tries->v.num;
  }
  if (max_timeout != NULL && max_timeout->kind != SCR_DYN_UNDEF) {
    if (!scr_dnsq_int32(max_timeout, "options.maxTimeout", 0, 4294967295.0)) return NULL;
    mt = max_timeout->v.num;
  }
  ScrDnsResolver *r = scr_dnsr_new(promises);
  r->timeout = (int)t;
  r->tries = (int)tr;
  r->max_timeout = (unsigned)mt;
  ScrDyn *handle = scr_dyn_new_handle(r, promises ? SCR_DYNH_DNS_RESOLVER_PROMISES : SCR_DYNH_DNS_RESOLVER);
  scr_dnsr_release(r); /* the handle's reference is the only one */
  return handle;
}

/* ── servers / local address ─────────────────────────────────────────── */

static void scr_dnsq_validate_string(const char *name, const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_STR) scr_dyn_arg_type_fail(name, "of type string", scr_dnsq_arg_or_undef(v));
}

static void scr_dnsq_port_fail(double port) {
  char detail[256], msg[320];
  ScrDyn tmp;
  memset(&tmp, 0, sizeof tmp);
  tmp.kind = SCR_DYN_NUM;
  tmp.v.num = port;
  const char *d = scr_dyn_specific_type(&tmp, detail, sizeof detail);
  snprintf(msg, sizeof msg, "Port should be >= 0 and < 65536. Received %s.", d);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, strlen(msg), "ERR_SOCKET_BAD_PORT");
}

/* setServers' port: parseInt(digits) || 53, then Node's validatePort. */
static bool scr_dnsq_port_parse(const char *s, size_t n, unsigned *out) {
  double port = 0;
  for (size_t i = 0; i < n; i++) port = port * 10 + (double)(s[i] - '0');
  if (!(port >= 0 && port <= 65535)) {
    scr_dnsq_port_fail(port);
    return false;
  }
  *out = port == 0 ? 53 : (unsigned)port; /* "|| IANA_DNS_PORT" */
  return true;
}

/* ERR_INVALID_IP_ADDRESS: "Invalid IP address: <serv>". */
static void scr_dnsq_invalid_ip_fail(const ScrStr *serv) {
  size_t n = serv->len + 24;
  char *msg = malloc(n);
  if (msg == NULL) scr_trap("scriptc: out of memory\n");
  int len = snprintf(msg, n, "Invalid IP address: %.*s", (int)serv->len, serv->data);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, len < 0 ? 0 : (size_t)len, "ERR_INVALID_IP_ADDRESS");
  free(msg);
}

/* ResolverBase#setServers: a bare literal gets port 53, a bracketed IPv6
 * takes an optional ":port", anything else splits as "host:port". Holes are
 * skipped the way forEach skips them, and a bad entry throws without the
 * resolver being touched. The list is filled in order, duplicates dropped. */
static bool scr_dnsq_servers_parse_plain(const ScrDyn *servers, ScrDnsServerList *list);

static bool scr_dnsq_servers_parse(const ScrDyn *servers, ScrDnsServerList *list) {
  ScrDyn *view;
  const ScrDyn *read = scr_dnsq_arg_read(servers, &view);
  bool ok = scr_dnsq_servers_parse_plain(read, list);
  if (view != NULL) scr_dyn_release(view);
  /* A rejected configuration keeps none of the prefix it had parsed: every
   * setter abandons the list, and the applications that feed it
   * request-provided addresses would accumulate that memory on each
   * refusal. */
  if (!ok) scr_dnsq_server_list_free(list);
  return ok;
}

static bool scr_dnsq_servers_parse_plain(const ScrDyn *servers, ScrDnsServerList *list) {
  memset(list, 0, sizeof *list);
  if (servers == NULL || servers->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("servers", "an instance of Array", servers);
    return false;
  }
  double len = scr_dyn_arr_len(servers);
  for (double i = 0; i < len; i++) {
    if (!scr_dyn_arr_has_index(servers, (size_t)i)) continue;
    ScrDyn *serv = scr_dyn_arr_at(servers, i);
    char index_name[32];
    snprintf(index_name, sizeof index_name, "servers[%.0f]", i);
    if (serv == NULL || serv->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail(index_name, "of type string", serv);
      scr_dyn_release(serv);
      return false;
    }
    const char *s = serv->v.str->data;
    size_t slen = serv->v.str->len;
    int version = scr_dnsq_ip_version(s, slen);
    if (version != 0) {
      scr_dnsq_server_append(list, version, s, slen, 53);
      scr_dyn_release(serv);
      continue;
    }
    /* IPv6RE = /^\[([^[\]]*)\]/ — a bracketed IPv6 literal. */
    size_t close = slen;
    if (slen >= 3 && s[0] == '[') {
      close = 1;
      while (close < slen && s[close] != ']' && s[close] != '[') close++;
      if (close >= slen || s[close] != ']') close = slen;
    }
    if (close < slen) {
      int v6 = scr_dnsq_ip_version(s + 1, close - 1);
      if (v6 != 0) {
        /* port = parseInt(serv.replace(addrSplitRE, '$2')) || 53 */
        size_t at = slen;
        while (at > close + 1 && s[at - 1] >= '0' && s[at - 1] <= '9') at--;
        unsigned port = 53;
        if (at < slen && at > close + 1 && s[at - 1] == ':' &&
            !scr_dnsq_port_parse(s + at, slen - at, &port)) {
          scr_dyn_release(serv);
          return false;
        }
        scr_dnsq_server_append(list, v6, s + 1, close - 1, port);
        scr_dyn_release(serv);
        continue;
      }
    }
    /* addrSplitRE = /(^.+?)(?::(\d+))?$/ */
    size_t at = slen;
    while (at > 0 && s[at - 1] >= '0' && s[at - 1] <= '9') at--;
    bool has_port = at < slen && at > 0 && s[at - 1] == ':';
    size_t hlen = has_port ? at - 1 : slen;
    int hv = scr_dnsq_ip_version(s, hlen);
    if (hv != 0) {
      unsigned port = 53;
      if (has_port && !scr_dnsq_port_parse(s + at, slen - at, &port)) {
        scr_dyn_release(serv);
        return false;
      }
      scr_dnsq_server_append(list, hv, s, hlen, port);
      scr_dyn_release(serv);
      continue;
    }
    scr_dnsq_invalid_ip_fail(serv->v.str);
    scr_dyn_release(serv);
    return false;
  }
  return true;
}

/* Swaps a parsed list in for the resolver's servers. */
static void scr_dnsq_resolver_servers_set(ScrDnsResolver *r, ScrDnsServerList *list) {
  scr_dnsq_server_list_free(&r->servers);
  r->servers = *list;
  memset(list, 0, sizeof *list);
}

/* A parsed list's own copy (two resolvers can share one setServers call). */
static ScrDnsServerList scr_dnsq_server_list_copy(const ScrDnsServerList *list) {
  ScrDnsServerList copy;
  memset(&copy, 0, sizeof copy);
  if (list->n == 0) return copy;
  copy.items = malloc(list->n * sizeof *copy.items);
  if (copy.items == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(copy.items, list->items, list->n * sizeof *copy.items);
  copy.n = copy.cap = list->n;
  return copy;
}

/* dns.setServers(servers): Node builds one Resolver and binds both modules'
 * functions to it (lib/dns.js rebinds module.exports and dns/promises), so
 * one list answers both. Queries already in flight keep their own attempt,
 * so replacing the lists in place is not observable. */
void scr_dns_set_servers(const ScrDyn *servers) {
  ScrDnsServerList list;
  if (!scr_dnsq_servers_parse(servers, &list)) return;
  ScrDnsServerList copy = scr_dnsq_server_list_copy(&list);
  scr_dnsq_resolver_servers_set(scr_dnsq_default(false), &list);
  scr_dnsq_resolver_servers_set(scr_dnsq_default(true), &copy);
  scr_dnsq_server_list_free(&copy);
}

/* dns/promises.setServers(servers): only that module's default changes. */
void scr_dns_promises_set_servers(const ScrDyn *servers) {
  ScrDnsServerList list;
  if (!scr_dnsq_servers_parse(servers, &list)) return;
  scr_dnsq_resolver_servers_set(scr_dnsq_default(true), &list);
  scr_dnsq_server_list_free(&list);
}

/* setServers on one resolver: the list parses completely before it
 * replaces anything. */
static void scr_dnsq_set_servers_on(ScrDnsResolver *r, const ScrDyn *servers) {
  ScrDnsServerList list;
  if (!scr_dnsq_servers_parse(servers, &list)) return;
  scr_dnsq_resolver_servers_set(r, &list);
  scr_dnsq_server_list_free(&list);
}

/* dns.getServers()/dns/promises.getServers(), and the hook the dgram unit
 * installs for them: the module default's servers, never empty. */
ScrDyn *scr_dns_get_servers_default(bool promises) { return scr_dnsq_module_servers(promises); }

/* setLocalAddress(ipv4[, ipv6]): both slots hold an address of either
 * family (the language sorts them, as c-ares does), so the pair can name at
 * most one of each. The handle rejects an address it cannot parse with
 * ERR_INVALID_ARG_VALUE "Invalid IP address." */
static void scr_dnsq_set_local_address_on(ScrDnsResolver *r, const ScrDyn *ipv4, const ScrDyn *ipv6) {
  scr_dnsq_validate_string("ipv4", ipv4);
  if (scr_exc_pending()) return;
  bool has6 = ipv6 != NULL && ipv6->kind != SCR_DYN_UNDEF;
  if (has6) {
    scr_dnsq_validate_string("ipv6", ipv6);
    if (scr_exc_pending()) return;
  }
  const ScrStr *a = ipv4->v.str;
  const ScrStr *b = has6 ? ipv6->v.str : NULL;
  int fa = a->len > 0 && memchr(a->data, '\0', a->len) == NULL ? scr_dnsq_ip_version(a->data, a->len) : 0;
  int fb = b == NULL ? 0 : (b->len > 0 && memchr(b->data, '\0', b->len) == NULL
                                ? scr_dnsq_ip_version(b->data, b->len)
                                : 0);
  if (fa == 0 || (b != NULL && fb == 0)) {
    static const char msg[] = "Invalid IP address.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_VALUE");
    return;
  }
  if (b != NULL && fa == fb) {
    static const char v4msg[] = "Cannot specify two IPv4 addresses.";
    static const char v6msg[] = "Cannot specify two IPv6 addresses.";
    if (fa == 4)
      scr_throw_error_msg_code(SCR_ERR_TYPE, v4msg, sizeof v4msg - 1, "ERR_INVALID_ARG_VALUE");
    else
      scr_throw_error_msg_code(SCR_ERR_TYPE, v6msg, sizeof v6msg - 1, "ERR_INVALID_ARG_VALUE");
    return;
  }
  r->local_v4[0] = '\0';
  r->local_v6[0] = '\0';
  const char *texts[2] = {a->data, b != NULL ? b->data : NULL};
  size_t lens[2] = {a->len, b != NULL ? b->len : 0};
  int fams[2] = {fa, fb};
  for (int i = 0; i < 2; i++) {
    if (texts[i] == NULL) continue;
    char *dst = fams[i] == 4 ? r->local_v4 : r->local_v6;
    memcpy(dst, texts[i], lens[i]);
    dst[lens[i]] = '\0';
  }
}

/* ── cancel ──────────────────────────────────────────────────────────── */

/* ResolverBase#cancel: every live query of this resolver settles
 * ECANCELLED (the ones started after the call are unaffected). */
static void scr_dnsq_cancel(ScrDnsResolver *r) {
  r->gen++;
  for (ScrDnsqQuery *q = scr_dnsq_live; q != NULL;) {
    ScrDnsqQuery *next = q->next;
    if (q->r == r && q->gen != r->gen) scr_dnsq_finish(q, "ECANCELLED", NULL);
    q = next;
  }
}

/* ── resolve() ───────────────────────────────────────────────────────── */

/* A callback written in statically typed code crosses the checked-dynamic
 * boundary as a checked thunk: its signature (`func(<param>,<param>)=>…`)
 * keeps the declared parameter types, and a parameter that is not `dyn`
 * cannot hold the undefined Node passes on failure. Such a callback gets
 * the same placeholder a statically typed dns call supplies — an empty
 * array or a zeroed SoaRecord — where a callback written in untyped code
 * (dyn parameters, or no signature at all) gets Node's one-argument call. */
static bool scr_dnsq_callback_checked(const ScrDyn *cb) {
  if (cb == NULL || cb->kind != SCR_DYN_FUNC || cb->v.fn.sig == NULL) return false;
  const char *sig = cb->v.fn.sig;
  if (strncmp(sig, "func(", 5) != 0) return false;
  const char *param = sig + 5;
  if (strncmp(param, "dyn", 3) != 0 && strncmp(param, "...", 3) != 0) return true;
  if (param[3] != ',') return false; /* one parameter: nothing to place */
  param += 4;
  return strncmp(param, "dyn", 3) != 0 && strncmp(param, "...", 3) != 0;
}

/* The callback form's tail: Node's `(name, [options,] callback)` shuffle
 * (a two-argument call's options slot held the callback). */
static void scr_dnsq_call_form(ScrDnsResolver *r, const ScrStr *binding, const ScrDyn *name, const ScrDyn *a1,
                               const ScrDyn *a2, bool typed) {
  const ScrDyn *cb = a2;
  const ScrDyn *opts = a1;
  if (cb == NULL || cb->kind == SCR_DYN_UNDEF) {
    cb = a1;
    opts = NULL;
  }
  scr_dnsq_query_chk(r, binding, name, opts, cb, typed);
}

/* resolve(hostname, rrtype[, callback]) shared by the module functions
 * and the Resolver methods: the rrtype picks the binding, then the query.
 * Answers +1 (the boxed promise for the promise form, undefined
 * otherwise), or NULL with the exception pending. */
static ScrDyn *scr_dnsq_resolve_into(ScrDnsResolver *r, const ScrDyn *name, const ScrDyn *rrtype,
                                     const ScrDyn *callback, bool typed, bool promises) {
  ScrDyn *rr_owned;
  const ScrDyn *rr_view = scr_dnsq_arg_read(rrtype, &rr_owned);
  const ScrDyn *cb = callback;
  const char *binding = scr_dnsq_rr_of(rr_view, promises, &cb);
  if (rr_owned != NULL) scr_dyn_release(rr_owned);
  if (binding == NULL) return NULL;
  ScrStr *b = scr_dnsq_binding_str(binding);
  if (promises) {
    ScrPromise *p = scr_dnsq_promise_start(r, b, name, NULL);
    scr_str_release(b);
    if (p == NULL) return NULL;
    ScrDyn *box = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return box;
  }
  scr_dnsq_query_chk(r, b, name, NULL, cb, typed);
  scr_str_release(b);
  return scr_dyn_undefined();
}

void scr_dns_resolve_rr_chk(const ScrDyn *name, const ScrDyn *rrtype, const ScrDyn *callback, bool typed) {
  ScrDyn *value = scr_dnsq_resolve_into(scr_dnsq_default(false), name, rrtype, callback, typed, false);
  if (value != NULL) scr_dyn_release(value);
}

ScrPromise *scr_dns_resolve_rr_promise(const ScrDyn *name, const ScrDyn *rrtype) {
  ScrDyn *rr_owned;
  const ScrDyn *rr_view = scr_dnsq_arg_read(rrtype, &rr_owned);
  const ScrDyn *cb = NULL;
  const char *binding = scr_dnsq_rr_of(rr_view, true, &cb);
  if (rr_owned != NULL) scr_dyn_release(rr_owned);
  if (binding == NULL) return NULL;
  ScrStr *b = scr_dnsq_binding_str(binding);
  ScrPromise *p = scr_dnsq_promise_start(scr_dnsq_default(true), b, name, NULL);
  scr_str_release(b);
  return p;
}

/* ── the Resolver handle ─────────────────────────────────────────────── */

/* The method name's binding, over the same table the errors' syscall
 * comes from (reverse is c-ares's getHostByAddr). */
static const char *scr_dnsq_method_binding(const char *method, size_t len) {
  for (size_t i = 0; i < sizeof scr_dnsq_bindings / sizeof scr_dnsq_bindings[0]; i++) {
    size_t n = strlen(scr_dnsq_bindings[i].method);
    if (len == n && memcmp(method, scr_dnsq_bindings[i].method, n) == 0) return scr_dnsq_bindings[i].binding;
  }
  return NULL;
}

static void scr_dnsq_not_a_function(const char *what) {
  char msg[192];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  if (n < 0) n = 0;
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n < sizeof msg ? (size_t)n : sizeof msg - 1);
}

/* dns.Resolver.prototype.<method> for a receiver of the checked-dynamic
 * tree: the same entry points the static calls take, over dyn arguments.
 * The promise methods answer a boxed promise; the callback methods start
 * the query and answer undefined. */
static ScrDyn *scr_dnsq_resolver_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                        size_t argc, const char *what) {
  ScrDnsResolver *r = h;
  (void)self;
  size_t len = strlen(method);
  const ScrDyn *name = argc > 0 ? args[0] : NULL;
  const ScrDyn *a1 = argc > 1 ? args[1] : NULL;
  const ScrDyn *a2 = argc > 2 ? args[2] : NULL;
  if (len == 6 && memcmp(method, "cancel", 6) == 0) {
    scr_dnsq_cancel(r);
    return scr_dyn_undefined();
  }
  if (len == 10 && memcmp(method, "getServers", 10) == 0) return scr_dnsq_servers_dyn(&r->servers);
  if (len == 10 && memcmp(method, "setServers", 10) == 0) {
    scr_dnsq_set_servers_on(r, name);
    return scr_exc_pending() ? NULL : scr_dyn_undefined();
  }
  if (len == 15 && memcmp(method, "setLocalAddress", 15) == 0) {
    scr_dnsq_set_local_address_on(r, name, a1);
    return scr_exc_pending() ? NULL : scr_dyn_undefined();
  }
  if (len == 7 && memcmp(method, "resolve", 7) == 0) {
    /* resolve(name, rrtype, callback) or resolve(name, callback): the
     * callback is whichever slot holds the function. */
    const ScrDyn *cb = a2;
    if (cb == NULL || (cb->kind != SCR_DYN_FUNC && cb->kind != SCR_DYN_UNDEF)) cb = a1;
    return scr_dnsq_resolve_into(r, name, a1, a2, scr_dnsq_callback_checked(cb), r->promises);
  }
  const char *binding = scr_dnsq_method_binding(method, len);
  if (binding == NULL) {
    scr_dnsq_not_a_function(what);
    return NULL;
  }
  ScrStr *b = scr_dnsq_binding_str(binding);
  if (r->promises) {
    ScrPromise *p = scr_dnsq_promise_start(r, b, name, a1);
    scr_str_release(b);
    if (p == NULL) return NULL;
    ScrDyn *box = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return box;
  }
  scr_dnsq_call_form(r, b, name, a1, a2, scr_dnsq_callback_checked(a2 != NULL && a2->kind == SCR_DYN_FUNC ? a2 : a1));
  scr_str_release(b);
  return scr_exc_pending() ? NULL : scr_dyn_undefined();
}

static ScrDyn *scr_dnsq_resolver_get(void *h, const char *key, size_t len) {
  (void)h;
  (void)key;
  (void)len;
  return NULL;
}

/* The TypeError a method value raises on another receiver: Node reads the
 * binding off an absent `_handle`, so the message names it. */
#define SCR_DNSQ_THIS_FAIL(binding) "Cannot read properties of undefined (reading '" binding "')"

static const ScrDynHandleMethod scr_dnsq_resolver_methods[] = {
    {.name = "resolveAny", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryAny")},
    {.name = "resolve4", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryA")},
    {.name = "resolve6", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryAaaa")},
    {.name = "resolveCaa", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryCaa")},
    {.name = "resolveCname", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryCname")},
    {.name = "resolveMx", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryMx")},
    {.name = "resolveNs", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryNs")},
    {.name = "resolveTlsa", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryTlsa")},
    {.name = "resolveTxt", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryTxt")},
    {.name = "resolveSrv", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("querySrv")},
    {.name = "resolvePtr", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryPtr")},
    {.name = "resolveNaptr", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("queryNaptr")},
    {.name = "resolveSoa", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("querySoa")},
    {.name = "reverse", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("getHostByAddr")},
    {.name = "resolve", .length = 3, .invalid_this = SCR_DNSQ_THIS_FAIL("queryA")},
    /* ResolverBase's members (Node's Resolver extends it): the channel's own
     * state, so the wrong-`this` messages name what each reads. */
    {.name = "cancel", .length = 0, .invalid_this = SCR_DNSQ_THIS_FAIL("cancel")},
    {.name = "getServers", .length = 0, .invalid_this = SCR_DNSQ_THIS_FAIL("getServers")},
    {.name = "setServers", .length = 1, .invalid_this = "this[kSetServersInternal] is not a function"},
    {.name = "setLocalAddress", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("setLocalAddress")},
    {.name = NULL},
};

/* dns/promises' Resolver: the same methods, each answering a promise
 * (wrong receivers reject rather than throw — the class's rejects). */
static const ScrDynHandleMethod scr_dnsq_promises_resolver_methods[] = {
    {.name = "resolveAny", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryAny")},
    {.name = "resolve4", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryA")},
    {.name = "resolve6", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryAaaa")},
    {.name = "resolveCaa", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryCaa")},
    {.name = "resolveCname", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryCname")},
    {.name = "resolveMx", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryMx")},
    {.name = "resolveNs", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryNs")},
    {.name = "resolveTlsa", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryTlsa")},
    {.name = "resolveTxt", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryTxt")},
    {.name = "resolveSrv", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("querySrv")},
    {.name = "resolvePtr", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryPtr")},
    {.name = "resolveNaptr", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryNaptr")},
    {.name = "resolveSoa", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("querySoa")},
    {.name = "reverse", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("getHostByAddr")},
    {.name = "resolve", .length = 2, .rejects = true, .invalid_this = SCR_DNSQ_THIS_FAIL("queryA")},
    /* The channel's own members are not promises: a wrong receiver throws,
     * as it does through dns' Resolver. */
    {.name = "cancel", .length = 0, .invalid_this = SCR_DNSQ_THIS_FAIL("cancel")},
    {.name = "getServers", .length = 0, .invalid_this = SCR_DNSQ_THIS_FAIL("getServers")},
    {.name = "setServers", .length = 1, .invalid_this = "this[kSetServersInternal] is not a function"},
    {.name = "setLocalAddress", .length = 2, .invalid_this = SCR_DNSQ_THIS_FAIL("setLocalAddress")},
    {.name = NULL},
};

#undef SCR_DNSQ_THIS_FAIL

/* Node's Resolver owns the query methods and inherits cancel/getServers/
 * setServers/setLocalAddress from ResolverBase; the handle's one prototype
 * carries both sets, the queries first as Node's own properties list them. */
static const char *const scr_dnsq_resolver_order[] = {
    "resolveAny", "resolve4",    "resolve6",   "resolveCaa",     "resolveCname", "resolveMx",
    "resolveNs",  "resolveTlsa", "resolveTxt", "resolveSrv",     "resolvePtr",   "resolveNaptr",
    "resolveSoa", "reverse",     "resolve",    "cancel",         "getServers",   "setServers",
    "setLocalAddress", NULL,
};

static const ScrDynHandleOps scr_dnsq_resolver_ops = {
    .cls = "Resolver",
    .retain = scr_dnsr_retain,
    .release = scr_dnsr_release,
    .invoke = scr_dnsq_resolver_invoke,
    .get = scr_dnsq_resolver_get,
    .methods = scr_dnsq_resolver_methods,
};

static const ScrDynHandleOps scr_dnsq_promises_resolver_ops = {
    .cls = "Resolver",
    .retain = scr_dnsr_retain,
    .release = scr_dnsr_release,
    .invoke = scr_dnsq_resolver_invoke,
    .get = scr_dnsq_resolver_get,
    .methods = scr_dnsq_promises_resolver_methods,
};

static ScrDyn *scr_dnsq_construct_cb(ScrDyn *const *args, size_t argc) {
  return scr_dns_resolver_new(argc > 0 ? args[0] : NULL, false);
}

static ScrDyn *scr_dnsq_construct_promises(ScrDyn *const *args, size_t argc) {
  return scr_dns_resolver_new(argc > 0 ? args[0] : NULL, true);
}

static const ScrDynHandleClass scr_dnsq_resolver_class = {
    .name = "Resolver",
    .length = 0,
    .construct = scr_dnsq_construct_cb,
    .order = scr_dnsq_resolver_order,
};

static const ScrDynHandleClass scr_dnsq_promises_resolver_class = {
    .name = "Resolver",
    .length = 0,
    .construct = scr_dnsq_construct_promises,
    .order = scr_dnsq_resolver_order,
};

bool scr_dns_resolver_is(const ScrDyn *v, bool promises) {
  if (v == NULL || v->kind != SCR_DYN_HANDLE) return false;
  return v->v.handle.tag == (promises ? SCR_DYNH_DNS_RESOLVER_PROMISES : SCR_DYNH_DNS_RESOLVER);
}

/* ── the loop's share ────────────────────────────────────────────────── */

static bool scr_dnsq_pending(void) { return scr_dnsq_live != NULL; }

static bool scr_dnsq_owns(void *udata) {
  for (ScrDnsqQuery *q = scr_dnsq_live; q != NULL; q = q->next)
    if ((void *)q == udata) return true;
  return false;
}

/* Process exit: queries still live are dropped without delivery (their
 * callbacks never run — the loop ends here, as Node's does). */
static void scr_dnsq_cleanup(void) {
  ScrDnsqQuery *q = scr_dnsq_live;
  scr_dnsq_live = NULL;
  while (q != NULL) {
    ScrDnsqQuery *next = q->next;
    scr_dgram_poll_timer_cancel(q);
    scr_dnsq_close_fd(q->fd);
    scr_dnsr_release(q->r);
    scr_str_release(q->host);
    scr_str_release(q->err_host);
    scr_dyn_release(q->callback);
    scr_promise_release(q->promise_handle);
    free(q->pkt);
    free(q->rbuf);
    free(q);
    q = next;
  }
}

static const ScrDnsqHooks scr_dnsq_hook_table = {
    .pending = scr_dnsq_pending,
    .owns = scr_dnsq_owns,
    .event = scr_dnsq_event,
    .cleanup = scr_dnsq_cleanup,
};

/* Emitted by main() exactly when this unit is linked (RUNTIME_UNITS'
 * dnsResolve row): the dgram unit's loop hooks, the servers hook behind
 * dns.getServers(), and the two Resolver classes. */
void scr_dns_resolve_install(void) {
  scr_dnsq_hooks = &scr_dnsq_hook_table;
  scr_dns_servers_hook = scr_dns_get_servers_default;
  scr_dyn_handle_class_install(SCR_DYNH_DNS_RESOLVER, &scr_dnsq_resolver_ops, &scr_dnsq_resolver_class);
  scr_dyn_handle_class_install(SCR_DYNH_DNS_RESOLVER_PROMISES, &scr_dnsq_promises_resolver_ops,
                               &scr_dnsq_promises_resolver_class);
}
