/* Node islands: native Date, URL and URLSearchParams objects across the
 * boundary. Links into every program that has Node islands (the three
 * classes live in units every program links).
 *
 * An island's receivers test what they are handed: date-fns asks
 * `value instanceof Date` and Object.prototype.toString, node:http and
 * fetch ask for a real URL, util.inspect and structuredClone read internal
 * slots. So a native Date or URL crosses as a twin
 * (scr_node_island_export.c): the island holds a real Date or URL of its
 * own realm, made from the native object's state, and the native object
 * crosses back as itself.
 *
 * Both classes are mutable on both sides (Date#setTime and the fifteen
 * other setters, URL#href and the nine component setters, and the URL's
 * live searchParams), and neither side can be told when the other writes.
 * Each class therefore only says what its state is, a value both sides
 * read alike: a Date's time value, a URL's href. The export table makes
 * the object and its twin equal whenever control passes from one side to
 * the other (push and pull there), so every read on either side sees the
 * last write on either side. A URL's searchParams needs nothing of its
 * own: it is part of the href on both sides.
 *
 * What does not follow the object: a property the island adds to its twin
 * (the native object has no place for it), and the twin's prototype if
 * island code changes it. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_island.h"
#include "scr_url_internal.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

SCR_COLD static void niv_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* The island told a state of a kind the class does not have. */
SCR_COLD static void niv_refuse(const char *cls, const char *kind) {
  char message[160];
  int len = snprintf(message, sizeof message,
                     "scriptc: the twin of a native %s in a Node island told a state that is not %s", cls,
                     kind);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)len);
}

/* ── Date: the time value ─────────────────────────────────────────────── */

typedef struct {
  double ms; /* what the twin has */
} NivDate;

static void *niv_date_attach(uint32_t id, void *object) {
  (void)id;
  NivDate *a = malloc(sizeof *a);
  if (a == NULL) niv_oom();
  a->ms = ((const ScrDate *)object)->ms;
  return a;
}

static ScrDyn *niv_date_state(void *object, void *attachment) {
  double ms = ((const ScrDate *)object)->ms;
  ((NivDate *)attachment)->ms = ms;
  return scr_dyn_new_num(ms);
}

/* Bit for bit: an invalid Date is NaN on both sides and is not a change. */
static bool niv_date_moved(void *object, void *attachment) {
  return memcmp(&((const ScrDate *)object)->ms, &((const NivDate *)attachment)->ms, sizeof(double)) != 0;
}

static void niv_date_hear(void *object, const char *event, ScrDyn *value) {
  if (strcmp(event, "state") != 0) return;
  if (value->kind != SCR_DYN_NUM) {
    niv_refuse("Date", "a time value");
    return;
  }
  /* The island's Date clipped it already: a time value or NaN. */
  ((ScrDate *)object)->ms = value->v.num;
}

static ScrNiTwinClass niv_date = {
    .tag = SCR_DYNH_DATE,
    .name = "Date",
    .attach = niv_date_attach,
    .detach = free,
    .hear = niv_date_hear,
    .state = niv_date_state,
    .moved = niv_date_moved,
};

/* ── URL: the href ────────────────────────────────────────────────────── */

/* The parts the twin's href was serialized from, held so that none of
 * their addresses can come back as another string: equal pointers are an
 * unchanged URL without serializing it. */
enum { NIV_URL_PARTS = 7 };
typedef struct {
  ScrStr *parts[NIV_URL_PARTS];
  bool has_authority;
  ScrStr *href; /* what the twin has */
} NivUrl;

static void niv_url_parts(const ScrUrl *u, ScrStr *parts[NIV_URL_PARTS]) {
  parts[0] = u->scheme;
  parts[1] = u->userinfo;
  parts[2] = u->host;
  parts[3] = u->port;
  parts[4] = u->path;
  parts[5] = u->query;
  parts[6] = u->fragment;
}

static void niv_url_keep(NivUrl *a, const ScrUrl *u) {
  ScrStr *now[NIV_URL_PARTS];
  niv_url_parts(u, now);
  for (int i = 0; i < NIV_URL_PARTS; i++) {
    scr_str_retain(now[i]);
    if (a->parts[i] != NULL) scr_str_release(a->parts[i]);
    a->parts[i] = now[i];
  }
  a->has_authority = u->has_authority;
}

static void *niv_url_attach(uint32_t id, void *object) {
  (void)id;
  NivUrl *a = calloc(1, sizeof *a);
  if (a == NULL) niv_oom();
  ScrUrl *u = object;
  niv_url_keep(a, u);
  a->href = scr_url_href(u);
  return a;
}

static void niv_url_detach(void *attachment) {
  NivUrl *a = attachment;
  for (int i = 0; i < NIV_URL_PARTS; i++) scr_str_release(a->parts[i]);
  scr_str_release(a->href);
  free(a);
}

static ScrDyn *niv_url_state(void *object, void *attachment) {
  NivUrl *a = attachment;
  ScrUrl *u = object;
  niv_url_keep(a, u);
  scr_str_release(a->href);
  a->href = scr_url_href(u);
  return scr_dyn_new_str(a->href);
}

static bool niv_url_moved(void *object, void *attachment) {
  NivUrl *a = attachment;
  ScrUrl *u = object;
  ScrStr *now[NIV_URL_PARTS];
  niv_url_parts(u, now);
  bool same = a->has_authority == u->has_authority;
  for (int i = 0; same && i < NIV_URL_PARTS; i++) same = now[i] == a->parts[i];
  if (same) return false;
  /* A setter that wrote an equal value made new strings for the same href. */
  ScrStr *href = scr_url_href(u);
  bool moved = href->len != a->href->len || memcmp(href->data, a->href->data, href->len) != 0;
  scr_str_release(href);
  if (!moved) niv_url_keep(a, u);
  return moved;
}

static void niv_url_hear(void *object, const char *event, ScrDyn *value) {
  if (strcmp(event, "state") != 0) return;
  if (value->kind != SCR_DYN_STR) {
    niv_refuse("URL", "an href");
    return;
  }
  /* Throws the native parser's TypeError for an href it does not accept. */
  ScrStr *field = scr_str_new("href", 4);
  scr_url_set((ScrUrl *)object, field, value->v.str);
  scr_str_release(field);
}

/* The URL's live searchParams view, which holds the URL. */
static void *niv_url_part(void *object) { return ((ScrUrl *)object)->sp_cache; }

static ScrNiTwinClass niv_url = {
    .tag = SCR_DYNH_URL,
    .name = "URL",
    .part = niv_url_part,
    .attach = niv_url_attach,
    .detach = niv_url_detach,
    .hear = niv_url_hear,
    .state = niv_url_state,
    .moved = niv_url_moved,
    .refuses = true,
};

/* ── URLSearchParams: the serialized list ─────────────────────────────
 * Its state is its serialization, which both sides parse back to the same
 * pairs. A list that is the live searchParams of a URL is part of that URL
 * on both sides: its twin is the searchParams object of its URL's twin, so
 * `url.searchParams` is one object in the island however it got there, and
 * a write through either object shows in the other on both sides. */

typedef struct {
  ScrStr *text; /* the serialization the twin has */
} NisParams;

static void *nis_attach(uint32_t id, void *object) {
  (void)id;
  NisParams *a = malloc(sizeof *a);
  if (a == NULL) niv_oom();
  a->text = scr_sp_to_string(object);
  return a;
}

static void nis_detach(void *attachment) {
  NisParams *a = attachment;
  scr_str_release(a->text);
  free(a);
}

static ScrDyn *nis_state(void *object, void *attachment) {
  NisParams *a = attachment;
  scr_str_release(a->text);
  a->text = scr_sp_to_string(object);
  return scr_dyn_new_str(a->text);
}

static bool nis_moved(void *object, void *attachment) {
  NisParams *a = attachment;
  ScrStr *now = scr_sp_to_string(object);
  bool moved = now->len != a->text->len || memcmp(now->data, a->text->data, now->len) != 0;
  scr_str_release(now);
  return moved;
}

/* The island's list changed: this list takes its pairs, in order. Every
 * step is the class's own mutator, so a URL that owns the list follows. */
static void nis_hear(void *object, const char *event, ScrDyn *value) {
  if (strcmp(event, "state") != 0) return;
  if (value->kind != SCR_DYN_STR) {
    static const char message[] =
        "scriptc: the twin of a native URLSearchParams in a Node island told a state that is not a "
        "serialized list";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return;
  }
  ScrSearchParams *sp = object;
  ScrSearchParams *next = scr_sp_parse(value->v.str);
  while (scr_sp_size(sp) > 0) {
    ScrStr *name = scr_sp_key_at(sp, 0);
    scr_sp_delete(sp, name);
    scr_str_release(name);
  }
  double n = scr_sp_size(next);
  for (double i = 0; i < n; i++) {
    ScrStr *name = scr_sp_key_at(next, i), *val = scr_sp_val_at(next, i);
    scr_sp_append(sp, name, val);
    scr_str_release(name);
    scr_str_release(val);
  }
  scr_sp_release(next);
}

static void *nis_owner(void *object, ScrDyn **box) {
  ScrUrl *owner = scr_sp_owner(object);
  if (box != NULL) *box = owner != NULL ? scr_dyn_native_url(owner) : NULL;
  return owner;
}

static ScrNiTwinClass nis_params = {
    .tag = SCR_DYNH_SEARCH_PARAMS,
    .name = "URLSearchParams",
    .attach = nis_attach,
    .detach = nis_detach,
    .hear = nis_hear,
    .state = nis_state,
    .moved = nis_moved,
    .owner = nis_owner,
};

__attribute__((constructor)) static void niv_install(void) {
  scr_ni_twin_register(&niv_date);
  scr_ni_twin_register(&niv_url);
  scr_ni_twin_register(&nis_params);
}

#endif /* !_WIN32 && !__wasi__ */
