/* fs.Stats values as checked-dynamic values (SCR_DYNH_STATS). A Stats is an
 * immutable snapshot the fs unit owns (scr_lib.c); the handle holds it by
 * reference, so a Stats stored in an untyped slot, or held at a structural
 * type that names some of its members (`{ isDirectory(): boolean }`), is
 * the same object wherever it is read, and its members answer from the
 * snapshot through the entry points the typed lowering calls. A unit of its
 * own so programs that keep every Stats typed link none of it
 * (native-toolchain gating: the statsDyn runtime feature). */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <string.h>

/* The numeric members, in the order Node's Stats constructor assigns them
 * (the order util.inspect and Object.keys list them in). */
typedef struct {
  const char *name;
  double (*read)(ScrStats *);
} ScrStatsDynNumber;

static const ScrStatsDynNumber scr_stats_dyn_numbers[] = {
    {"dev", scr_stats_dev},
    {"mode", scr_stats_mode},
    {"nlink", scr_stats_nlink},
    {"uid", scr_stats_uid},
    {"gid", scr_stats_gid},
    {"rdev", scr_stats_rdev},
    {"blksize", scr_stats_blksize},
    {"ino", scr_stats_ino},
    {"size", scr_stats_size},
    {"blocks", scr_stats_blocks},
    {"atimeMs", scr_stats_atime_ms},
    {"mtimeMs", scr_stats_mtime_ms},
    {"ctimeMs", scr_stats_ctime_ms},
    {"birthtimeMs", scr_stats_birthtime_ms},
    {NULL, NULL},
};

/* The Date members: the time value the typed read answers. */
static const ScrStatsDynNumber scr_stats_dyn_dates[] = {
    {"atime", scr_stats_atime},
    {"mtime", scr_stats_mtime},
    {"ctime", scr_stats_ctime},
    {"birthtime", scr_stats_birthtime},
    {NULL, NULL},
};

typedef struct {
  const char *name;
  bool (*test)(ScrStats *);
} ScrStatsDynTest;

static const ScrStatsDynTest scr_stats_dyn_tests[] = {
    {"isDirectory", scr_stats_is_dir},
    {"isFile", scr_stats_is_file},
    {"isSymbolicLink", scr_stats_is_symlink},
    {"isBlockDevice", scr_stats_is_block_device},
    {"isCharacterDevice", scr_stats_is_character_device},
    {"isFIFO", scr_stats_is_fifo},
    {"isSocket", scr_stats_is_socket},
    {NULL, NULL},
};

static ScrDyn *scr_stats_dyn_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                    size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  for (const ScrStatsDynTest *t = scr_stats_dyn_tests; t->name; t++)
    if (strcmp(method, t->name) == 0) return scr_dyn_new_bool(t->test(h));
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_stats_dyn_get(void *h, const char *key, size_t len) {
  for (const ScrStatsDynNumber *n = scr_stats_dyn_numbers; n->name; n++)
    if (strlen(n->name) == len && memcmp(key, n->name, len) == 0)
      return scr_dyn_new_num(n->read(h));
  for (const ScrStatsDynNumber *d = scr_stats_dyn_dates; d->name; d++)
    if (strlen(d->name) == len && memcmp(key, d->name, len) == 0)
      return scr_dyn_native_date_from_ms(d->read(h));
  return NULL;
}

/* A Stats is a snapshot: the typed lowering has no member writes, and a
 * write kept in the box alone would be lost with the box. */
static bool scr_stats_dyn_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

/* util.inspect prints `Stats { dev: …, …, birthtimeMs: … }`: the numeric
 * members. Node defines the four Date members on first read, so a Stats
 * nobody read a Date from lists none. */
static ScrDyn *scr_stats_dyn_inspect_view(void *h) {
  ScrDyn *view = scr_dyn_new_obj();
  for (const ScrStatsDynNumber *n = scr_stats_dyn_numbers; n->name; n++)
    scr_dyn_obj_set(view, n->name, strlen(n->name), scr_dyn_new_num(n->read(h)));
  return view;
}

static const ScrDynHandleMethod scr_stats_dyn_methods[] = {
    {.name = "isDirectory", .length = 0},
    {.name = "isFile", .length = 0},
    {.name = "isSymbolicLink", .length = 0},
    {.name = "isBlockDevice", .length = 0},
    {.name = "isCharacterDevice", .length = 0},
    {.name = "isFIFO", .length = 0},
    {.name = "isSocket", .length = 0},
    {.name = NULL},
};

static const ScrDynHandleOps scr_stats_dyn_ops = {
    .cls = "Stats",
    .retain = scr_stats_retain_v,
    .release = scr_stats_release_v,
    .invoke = scr_stats_dyn_invoke,
    .get = scr_stats_dyn_get,
    .set = scr_stats_dyn_set,
    .inspect_view = scr_stats_dyn_inspect_view,
    .methods = scr_stats_dyn_methods,
};

ScrDyn *scr_stats_to_dyn(ScrStats *s) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_STATS, &scr_stats_dyn_ops);
  }
  return scr_dyn_new_handle(s, SCR_DYNH_STATS);
}
