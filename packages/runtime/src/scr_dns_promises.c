/* node:dns/promises — lookup(hostname[, options]) and lookupService(address,
 * port) as promises over scr_dgram.c's callback forms. LINK-GATED: compiled
 * into the binary only when the IR uses the promise forms (the dnsPromises
 * runtime feature), so callback-only and dns-free programs keep their exact
 * executables. This unit uses only scr_dgram.c's public surface.
 *
 * lookup follows lib/internal/dns/promises.js: its argument checks are
 * stricter than the callback form's (family is a number only) and throw
 * synchronously, before any promise exists (a NUL byte in the hostname
 * throws first, as in the callback form). An empty hostname (with the
 * shared DEP0118 warning) and an IP literal settle at once, as Node resolves
 * them inside the promise executor; other names resolve through the
 * callback form's getaddrinfo and deliveries, with normalized options.
 * lookup fulfills with { address, family } (an array of them for all:
 * true), lookupService with { hostname, service }; failures reject with the
 * callback forms' errors. */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#endif

/* caps[0]: the destination promise. */
static ScrPromise *scr_dnsp_promise_of(ScrClosure *clo) {
  return (ScrPromise *)scr_box_get_ref(clo->caps[0]);
}

static void scr_dnsp_fulfill(ScrPromise *p, ScrDyn *value /* moves */) {
  scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

/* A callback whose first argument is an error rejects the promise with it. */
static bool scr_dnsp_rejects(ScrPromise *p, ScrDyn *const *args, size_t argc) {
  if (argc == 0 || args[0]->kind == SCR_DYN_NULL || args[0]->kind == SCR_DYN_UNDEF) return false;
  scr_dyn_throw(scr_dyn_retain(args[0]));
  scr_promise_reject_pending(p);
  return true;
}

static ScrDyn *scr_dnsp_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? scr_dyn_retain(args[i]) : scr_dyn_undefined();
}

static ScrDyn *scr_dnsp_pair(const char *a, size_t alen, ScrDyn *av, const char *b, size_t blen,
                             ScrDyn *bv) {
  ScrDyn *entry = scr_dyn_new_obj();
  scr_dyn_obj_set(entry, a, alen, av);
  scr_dyn_obj_set(entry, b, blen, bv);
  return entry;
}

/* (err, address, family) -> { address, family } */
static ScrDyn *scr_dnsp_one_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrPromise *p = scr_dnsp_promise_of(clo);
  if (!scr_dnsp_rejects(p, args, argc)) {
    scr_dnsp_fulfill(p, scr_dnsp_pair("address", 7, scr_dnsp_arg(args, argc, 1), "family", 6,
                                      scr_dnsp_arg(args, argc, 2)));
  }
  scr_promise_release(p);
  return scr_dyn_undefined();
}

/* (err, addresses) -> addresses */
static ScrDyn *scr_dnsp_all_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrPromise *p = scr_dnsp_promise_of(clo);
  if (!scr_dnsp_rejects(p, args, argc)) scr_dnsp_fulfill(p, scr_dnsp_arg(args, argc, 1));
  scr_promise_release(p);
  return scr_dyn_undefined();
}

/* (err, hostname, service) -> { hostname, service } */
static ScrDyn *scr_dnsp_service_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrPromise *p = scr_dnsp_promise_of(clo);
  if (!scr_dnsp_rejects(p, args, argc)) {
    scr_dnsp_fulfill(p, scr_dnsp_pair("hostname", 8, scr_dnsp_arg(args, argc, 1), "service", 7,
                                      scr_dnsp_arg(args, argc, 2)));
  }
  scr_promise_release(p);
  return scr_dyn_undefined();
}

/* The empty-hostname path only needs the callback form's DEP0118 warning. */
static ScrDyn *scr_dnsp_ignore(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  return scr_dyn_undefined();
}

static ScrDyn *scr_dnsp_callback(ScrPromise *p, ScrDynThunk thunk, uint32_t arity) {
  ScrClosure *clo = scr_closure_new((void *)thunk, 1);
  ScrBox *box = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, NULL);
  scr_box_set_ref(box, scr_promise_retain(p)); /* the box owns this reference */
  clo->caps[0] = box;
  return scr_dyn_new_func(clo, thunk, arity, "", "");
}

static bool scr_dnsp_given(const ScrDyn *v) {
  return v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL;
}

static const char *const scr_dnsp_orders[] = { "verbatim", "ipv4first", "ipv6first" };

static int scr_dnsp_order_of(const ScrDyn *v) {
  if (v->kind != SCR_DYN_STR) return -1;
  for (int i = 0; i < 3; i++) {
    size_t n = strlen(scr_dnsp_orders[i]);
    if (v->v.str->len == n && memcmp(v->v.str->data, scr_dnsp_orders[i], n) == 0) return i;
  }
  return -1;
}

static int scr_dnsp_default_order(void) {
  ScrStr *name = scr_dns_get_default_result_order();
  ScrDyn *d = scr_dyn_new_str(name);
  scr_str_release(name);
  int order = scr_dnsp_order_of(d);
  scr_dyn_release(d);
  return order < 0 ? 0 : order;
}

/* 4 or 6 for an IP literal (net.isIP), 0 otherwise. */
static double scr_dnsp_literal_family(const ScrStr *h) {
  unsigned char buf[16];
  char tmp[64];
  if (h->len == 0 || h->len >= sizeof tmp) return 0;
  memcpy(tmp, h->data, h->len);
  tmp[h->len] = '\0';
  if (inet_pton(AF_INET, tmp, buf) == 1) return 4;
  if (strchr(tmp, ':') != NULL) {
    char *pct = strchr(tmp, '%');
    if (pct) *pct = '\0';
    if (inet_pton(AF_INET6, tmp, buf) == 1) return 6;
  }
  return 0;
}

/* validateStringWithoutNullBytes(hostname, 'hostname'): the callback
 * form's error. False with it pending. */
static bool scr_dnsp_host_without_nul(const ScrStr *host) {
  if (memchr(host->data, '\0', host->len) == NULL) return true;
  ScrStr *shown = scr_str_inspect_quoted((ScrStr *)host, true);
  ScrJsonBuf msg;
  scr_jb_init(&msg);
  scr_jb_puts(&msg, "The argument 'hostname' must be a string without null bytes. Received ");
  scr_jb_put_str(&msg, shown);
  scr_str_release(shown);
  ScrStr *text = scr_jb_finish(&msg);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(text);
  return false;
}

/* lookup's options, validated as lib/internal/dns/promises.js validates
 * them. False with the argument error pending. */
static bool scr_dnsp_options(const ScrDyn *opts, double *family, bool *all, int *order) {
  if (opts->kind == SCR_DYN_NUM) {
    double f = opts->v.num;
    if (f != 0 && f != 4 && f != 6) {
      scr_dyn_arg_value_fail("family", "must be one of: 0, 4, 6", opts);
      return false;
    }
    *family = f + 0.0; /* Node coerces -0 to +0 */
    return true;
  }
  if (opts->kind != SCR_DYN_UNDEF && opts->kind != SCR_DYN_OBJ && opts->kind != SCR_DYN_NULL) {
    scr_dyn_arg_type_fail("options", "of type object or integer", opts);
    return false;
  }
  if (opts->kind != SCR_DYN_OBJ) return true;
  const ScrDyn *v = scr_dyn_obj_get(opts, "hints", 5);
  if (scr_dnsp_given(v)) {
    if (v->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.hints", "of type number", v);
      return false;
    }
    if (v->v.num != 0) {
      scr_throw_error_msg_code(SCR_ERR_ERROR, "dns.lookup hints are not supported yet", 38, "SC2020");
      return false;
    }
  }
  v = scr_dyn_obj_get(opts, "family", 6);
  if (scr_dnsp_given(v)) {
    if (v->kind != SCR_DYN_NUM || (v->v.num != 0 && v->v.num != 4 && v->v.num != 6)) {
      scr_dyn_arg_value_fail("options.family", "must be one of: 0, 4, 6", v);
      return false;
    }
    *family = v->v.num + 0.0;
  }
  v = scr_dyn_obj_get(opts, "all", 3);
  if (scr_dnsp_given(v)) {
    if (v->kind != SCR_DYN_BOOL) {
      scr_dyn_prop_type_fail("options.all", "of type boolean", v);
      return false;
    }
    *all = v->v.b;
  }
  v = scr_dyn_obj_get(opts, "verbatim", 8);
  if (scr_dnsp_given(v)) {
    if (v->kind != SCR_DYN_BOOL) {
      scr_dyn_prop_type_fail("options.verbatim", "of type boolean", v);
      return false;
    }
    *order = v->v.b ? 0 : 1;
  }
  v = scr_dyn_obj_get(opts, "order", 5);
  if (scr_dnsp_given(v)) {
    int o = scr_dnsp_order_of(v);
    if (o < 0) {
      scr_dyn_arg_value_fail("options.order", "must be one of: 'verbatim', 'ipv4first', 'ipv6first'",
                             v);
      return false;
    }
    *order = o;
  }
  return true;
}

/* The callback form's options for a validated promise lookup. +1 dyn. */
static ScrDyn *scr_dnsp_normalized(double family, bool all, int order) {
  ScrDyn *o = scr_dyn_new_obj();
  scr_dyn_obj_set(o, "family", 6, scr_dyn_new_num(family));
  scr_dyn_obj_set(o, "all", 3, scr_dyn_new_bool(all));
  const char *name = scr_dnsp_orders[order];
  ScrStr *s = scr_str_new(name, strlen(name));
  scr_dyn_obj_set(o, "order", 5, scr_dyn_new_str(s));
  scr_str_release(s);
  return o;
}

static ScrPromise *scr_dnsp_lookup(const ScrDyn *hostname, const ScrDyn *opts) {
  bool host_given = scr_dyn_truthy(hostname);
  if (host_given && hostname->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("hostname", "of type string", hostname);
    return NULL;
  }
  if (host_given && !scr_dnsp_host_without_nul(hostname->v.str)) return NULL;
  double family = 0;
  bool all = false;
  int order = scr_dnsp_default_order();
  if (!scr_dnsp_options(opts, &family, &all, &order)) return NULL;
  ScrPromise *p = scr_promise_new();
  if (!host_given) {
    /* The callback form emits the shared DEP0118 warning; its own answer
     * goes to a callback that ignores it. */
    ScrDyn *normalized = scr_dnsp_normalized(family, all, order);
    ScrDyn *ignore = scr_dyn_new_func(scr_closure_new((void *)scr_dnsp_ignore, 0), scr_dnsp_ignore,
                                      0, "", "");
    scr_dns_lookup_dyn(hostname, normalized, ignore, false);
    scr_dyn_release(ignore);
    scr_dyn_release(normalized);
    if (all) {
      scr_dnsp_fulfill(p, scr_dyn_new_arr());
    } else {
      scr_dnsp_fulfill(p, scr_dnsp_pair("address", 7, scr_dyn_new_null(), "family", 6,
                                        scr_dyn_new_num(family == 6 ? 6 : 4)));
    }
    return p;
  }
  const ScrStr *host = hostname->v.str;
  double literal = scr_dnsp_literal_family(host);
  if (literal != 0) {
    ScrDyn *entry = scr_dnsp_pair("address", 7, scr_dyn_new_str((ScrStr *)host), "family", 6,
                                  scr_dyn_new_num(literal));
    if (all) {
      ScrDyn *list = scr_dyn_new_arr();
      scr_dyn_arr_push(list, entry);
      entry = list;
    }
    scr_dnsp_fulfill(p, entry);
    return p;
  }
  ScrDyn *cb = scr_dnsp_callback(p, all ? scr_dnsp_all_settle : scr_dnsp_one_settle, all ? 2 : 3);
  {
    ScrDyn *normalized = scr_dnsp_normalized(family, all, order);
    scr_dns_lookup_dyn(hostname, normalized, cb, false);
    scr_dyn_release(normalized);
  }
  scr_dyn_release(cb);
  if (scr_exc_pending()) {
    scr_promise_release(p);
    return NULL;
  }
  return p;
}

ScrPromise *scr_dns_promises_lookup(const ScrDyn *hostname, const ScrDyn *options) {
  if (options->kind != SCR_DYN_TYPED_REF) return scr_dnsp_lookup(hostname, options);
  /* a typed options record arrives by reference */
  ScrDyn *view = scr_dyn_typed_ref_materialize(options);
  ScrPromise *p = scr_exc_pending() ? NULL : scr_dnsp_lookup(hostname, view);
  scr_dyn_release(view);
  return p;
}

ScrPromise *scr_dns_promises_lookup_service(const ScrDyn *address, const ScrDyn *port) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *cb = scr_dnsp_callback(p, scr_dnsp_service_settle, 3);
  scr_dns_lookup_service(address, port, cb, false);
  scr_dyn_release(cb);
  if (scr_exc_pending()) {
    scr_promise_release(p);
    return NULL;
  }
  return p;
}
