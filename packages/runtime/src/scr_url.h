/* scriptc runtime — WHATWG URL and URLSearchParams (scr_url.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_URL_H
#define SCR_URL_H

#include "scr_exception.h"

/* ── WHATWG URL (scr_url.c) ──────────────────────────────────────────
 * A mutable, refcounted URL value with selected component setters. The
 * parser covers the WHATWG algorithm's common ground exactly (see
 * scr_url.c's header comment for the covered surface and the documented
 * divergences: no IDNA, no IPv6, opaque paths verbatim).
 *
 * scr_url_new THROWS a catchable TypeError ("Invalid URL") through the
 * exception cell on unparsable input and returns NULL; the getters never
 * throw (borrowed receiver, +1 string). scr_url_to_path / _str_to_path
 * throw Node's fileURLToPath TypeErrors (non-file scheme, encoded '/',
 * non-empty host); scr_url_from_path resolves against the cwd and never
 * throws. Compiler-emitted pending checks follow every throwing call. */
typedef struct ScrUrl ScrUrl;

ScrUrl *scr_url_new(ScrStr *input); /* +1, or throws */
ScrUrl *scr_url_new_base(ScrStr *input, ScrStr *base); /* +1, or throws */
bool scr_url_can_parse(ScrStr *input);
bool scr_url_can_parse_base(ScrStr *input, ScrStr *base);
ScrDyn *scr_url_parse(ScrStr *input); /* +1 native URL or null; invalid URLs do not throw */
ScrDyn *scr_url_parse_base(ScrStr *input, ScrStr *base);
ScrUrl *scr_url_retain(ScrUrl *u);
void scr_url_release(ScrUrl *u);
void *scr_url_retain_v(void *p);
void scr_url_release_v(void *p);
ScrStr *scr_url_protocol(ScrUrl *u); /* +1 "https:" */
ScrStr *scr_url_origin(ScrUrl *u);   /* +1 "https://host" or "null" */
ScrStr *scr_url_username(ScrUrl *u); /* +1 encoded username, possibly empty */
ScrStr *scr_url_password(ScrUrl *u); /* +1 encoded password, possibly empty */
ScrStr *scr_url_host(ScrUrl *u);     /* +1 "host[:port]" (defaults stripped) */
ScrStr *scr_url_hostname(ScrUrl *u); /* +1 port-less host ("" when none) */
ScrStr *scr_url_port(ScrUrl *u);     /* +1 "" or normalized non-default port */
ScrStr *scr_url_pathname(ScrUrl *u); /* +1 */
ScrStr *scr_url_href(ScrUrl *u);     /* +1; also toString() */
void scr_url_set(ScrUrl *u, ScrStr *field, ScrStr *value); /* borrowed; href may throw */
bool scr_url_set_component(ScrUrl *u, ScrStr *field, ScrStr *value); /* borrowed; false for ignored writes */
void scr_url_set_checked(ScrUrl *u, ScrStr *field, const ScrDyn *value); /* borrowed; conversion may throw */
/* url.urlToHttpOptions: Node's null-prototype options object for a URL.
 * The checked-dynamic form throws ERR_INVALID_ARG_TYPE for a primitive or
 * null and has no lowering for an object that is not a URL. Borrowed; +1,
 * or NULL with the error pending. */
ScrDyn *scr_url_to_http_options(ScrUrl *u);
/* UTS #46 ToASCII for the host parser: NULL until scr_url_idna_install
 * (scr_idna.c, emitted at startup by programs that use URLs) sets it. */
extern ScrStr *(*scr_url_host_to_ascii)(const char *p, size_t n);
void scr_url_idna_install(void);
ScrDyn *scr_url_to_http_options_dyn(const ScrDyn *value);
/* node:url's legacy surface (scr_url_legacy.c — linked with the regex,
 * querystring and dyn-async units). url.parse() answers a checked-dynamic
 * Url instance; format() accepts a Url-shaped object, a string, or a
 * native URL (with its options bag); resolve() takes two strings. `warn`
 * emits DEP0169 once per process (false at node_modules call sites).
 * domainToASCII/Unicode take the argument and whether it was omitted
 * (ERR_MISSING_ARGS). All borrow; +1, or NULL with Node's error pending. */
ScrDyn *scr_url_legacy_parse(const ScrDyn *url, const ScrDyn *parse_query, const ScrDyn *slashes,
                             bool warn);
ScrStr *scr_url_legacy_format(const ScrDyn *object, const ScrDyn *options, bool warn);
ScrStr *scr_url_legacy_resolve(const ScrDyn *from, const ScrDyn *to, bool warn);
ScrStr *scr_url_domain_to_ascii(const ScrDyn *domain, bool missing);
/* node:punycode (scr_url.c): punycode.js 2.1.0's encode/decode, toASCII/
 * toUnicode (mapDomain over RFC 3490 separators) and ucs2.decode (UTF-16
 * code points as an f64 array). Borrowed input; +1, or NULL with the
 * module's RangeError pending. */
ScrStr *scr_punycode_decode(const ScrStr *input);
ScrStr *scr_punycode_encode(const ScrStr *input);
ScrStr *scr_punycode_to_ascii(const ScrStr *input);
ScrStr *scr_punycode_to_unicode(const ScrStr *input);
ScrArr *scr_punycode_ucs2_decode(const ScrStr *input);
ScrStr *scr_url_domain_to_unicode(const ScrDyn *domain, bool missing);
ScrStr *scr_url_to_path(ScrUrl *u);      /* +1, or throws */
/* scr_url_to_path as a value: the path string, or the error it would throw
 * (+1 dyn, never throws). */
ScrDyn *scr_url_to_path_value(ScrUrl *u);
ScrStr *scr_url_str_to_path(ScrStr *s);  /* +1, or throws */
ScrUrl *scr_url_from_path(ScrStr *path); /* +1; throws on win32 UNC malformations only */
ScrUrl *scr_url_from_path_platform(ScrStr *path, bool windows); /* +1; explicit options.windows */
/* The bridge pair's win32 arms as direct entry points (the public pair
 * selects by TARGET at compile time — Node's isWindows): the host-side
 * differential tests exercise the Windows behavior from any platform,
 * like Node's { windows: true } options on fileURLToPath/pathToFileURL. */
ScrStr *scr_url_to_path_w32(ScrUrl *u);      /* +1, or throws */
ScrUrl *scr_url_from_path_w32(ScrStr *path); /* +1, or throws */

/* ── URLSearchParams (scr_url.c) ─────────────────────────────────────
 * A refcounted, MUTABLE ordered list of decoded (name, value) pairs —
 * the WHATWG application/x-www-form-urlencoded surface. Standalone
 * (scr_sp_new/parse/copy/from_pairs) or the LIVE view of a URL's query
 * (scr_url_search_params — cached on the URL so every read answers the
 * same identity, and every list mutation re-serializes into the URL's
 * query: href reflects immediately; an emptied list drops the '?').
 * Parsing/serialization match Node exactly: '+' is space, %XX
 * decodes (malformed escapes verbatim, decoded bytes UTF-8-scrubbed to
 * U+FFFD), serialization keeps [A-Za-z0-9*\-._], space → '+', uppercase
 * %XX otherwise. sort() is stable, by UTF-16 code units. Only
 * scr_sp_from_pairs throws (ERR_INVALID_TUPLE on a non-[name, value]
 * row); everything else never does. */
typedef struct ScrSearchParams ScrSearchParams;

ScrSearchParams *scr_sp_new(void);              /* +1 empty list */
ScrSearchParams *scr_sp_parse(ScrStr *init);    /* +1; strips ONE leading '?' */
ScrSearchParams *scr_sp_copy(ScrSearchParams *src); /* +1 snapshot */
ScrSearchParams *scr_sp_from_pairs(ScrArr *pairs);  /* +1, or throws (string[][] rows) */
/* The record-literal init desugar: append (name, value), answer sp +1. */
ScrSearchParams *scr_sp_with(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
ScrSearchParams *scr_sp_retain(ScrSearchParams *sp);
void scr_sp_release(ScrSearchParams *sp);
void *scr_sp_retain_v(void *p);
void scr_sp_release_v(void *p);
ScrSearchParams *scr_url_search_params(ScrUrl *u); /* +1 live cached view */
ScrStr *scr_url_search(ScrUrl *u);                 /* +1 "?..." or "" */
ScrStr *scr_url_hash(ScrUrl *u);                   /* +1 "#..." or "" */
void scr_sp_append(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_set(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_delete(ScrSearchParams *sp, ScrStr *name);
void scr_sp_delete_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
ScrStr *scr_sp_get(ScrSearchParams *sp, ScrStr *name);     /* +1 first value, or NULL */
ScrArr *scr_sp_get_all(ScrSearchParams *sp, ScrStr *name); /* +1 string[] */
bool scr_sp_has(ScrSearchParams *sp, ScrStr *name);
bool scr_sp_has_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value);
void scr_sp_sort(ScrSearchParams *sp);
double scr_sp_size(ScrSearchParams *sp);
ScrStr *scr_sp_to_string(ScrSearchParams *sp); /* +1 urlencoded serialization */
/* Index-walk iteration (the compiler's for-of/forEach desugar re-reads
 * scr_sp_size each pass — live, like the spec's index-based iterator). */
ScrStr *scr_sp_key_at(ScrSearchParams *sp, double i); /* +1; "" out of range */
ScrStr *scr_sp_val_at(ScrSearchParams *sp, double i); /* +1; "" out of range */

#endif /* SCR_URL_H */
