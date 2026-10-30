/* Node islands: deferred evaluation (scope-B milestone NI-7). Linked with
 * the other island units into programs whose IR reaches Node.
 *
 * A statically imported island module the build admitted for deferral
 * (frontend/lowering/lower-node-island.ts: the static effect gate plus the
 * build-time probe in libnode) does not load at its import position. Its
 * %init calls scr_node_island_defer(path, snapshot) instead, which:
 *
 *   1. checks the boot guards without loading Node: the identity (size and
 *      mtime) of the libnode pack's bridge and library this run would load,
 *      and of every file of the module's closure. A snapshot taken with one
 *      libnode or one install of the package never applies to another: any
 *      mismatch loads the module here, eagerly, at its position;
 *   2. otherwise builds stubs from the interface snapshot: one island handle
 *      (a ScrNodeRef with no bridge id, scr_node_island_handle.c) per object
 *      the probe saw, deduplicated by the probe's object identity, so two
 *      exports of the same function are one stub. Before Node starts, the
 *      snapshot answers `typeof`, `name`/`length` of functions, primitive
 *      constants and the members it recorded, and `instanceof` against an
 *      ordinary class (false for every native value: no island object can
 *      exist yet).
 *
 * Every other use needs Node. Starting it (for any reason) runs the hook
 * below before the operation that needed it: every deferred module
 * evaluates, in import order, and each stub is reconciled with its real
 * value: the stub's ref takes over the value's bridge id, so the program's
 * stub boxes and every later crossing of the value are the same handle and
 * `===` holds (identity reconciliation). A module that throws when it
 * finally loads raises its error at each use of its stubs.
 *
 * Snapshot format (one record per line; <len>:<bytes> strings):
 *   G <len>:<path> <size> <mtime-ns>   guard file ("@name": in the pack)
 *   O <oid> <flags> <plain-class>      an object (SCR_NVF_* flags)
 *   K <oid> <len>:<key> <value>        a data member of object <oid>
 *   R <oid>                            the module's value
 *   E <len>:<key> <0|1> <len>:<value>  an env key the load read (absent: 0)
 *   T <fd> <0|1>                       the isTTY state the load read
 *   M <component>                      per-module mode (NI-7b): see below
 * where <value> is o<oid>, u, l, t, f, n<number> or s<len>:<bytes>. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(_WIN32) && !defined(__wasi__)

SCR_COLD static void nb_oom(void) { scr_trap("scriptc: out of memory\n"); }

typedef struct {
  const char *key;
  size_t key_len;
  char kind; /* o u l t f n s */
  uint32_t oid;
  double num;
  const char *str;
  size_t str_len;
} NbMember;

struct NbModule;

typedef struct NbStub {
  uint32_t oid;
  uint32_t flags;
  bool plain;
  ScrDyn *box; /* +1 */
  NbMember *members;
  size_t nmembers, members_cap;
  struct NbModule *module; /* the module whose value reaches it first */
  uint32_t parent;         /* 0: the module's value */
  const char *key;         /* its member name in the parent */
  size_t key_len;
  ScrCaught *error; /* why it could not be reconciled */
} NbStub;

typedef struct {
  const char *key, *value;
  size_t key_len, value_len;
  bool present;
} NbEnv;

typedef struct NbModule {
  char *path;
  uint32_t component; /* per-module mode: modules evaluated together */
  bool done;
  NbEnv *env;
  size_t nenv;
  char *snapshot; /* owns the strings the stubs point into */
  uint32_t root;
  uint32_t *order; /* stubs to reconcile after the root, parents first */
  size_t norder;
  ScrCaught *error; /* the module's load error */
} NbModule;

static NbStub **nb_stubs = NULL; /* by oid */
static size_t nb_stubs_cap = 0;
static NbModule **nb_modules = NULL;
static size_t nb_nmodules = 0, nb_modules_cap = 0;
static bool nb_installed = false;
/* Per-module mode (NI-7b, `M` records): Node starting does not evaluate
 * every deferred module; each component evaluates on the first use of one
 * of its stubs. The build chooses it only when every static island import
 * is deferred, none mutates builtin state and no island module loads at a
 * call site, so nothing but these stubs can reach the modules' objects. */
static bool nb_lazy = false;
static int nb_trace = -1;

static bool nb_tracing(void) {
  if (nb_trace < 0) {
    const char *t = getenv("SCRIPTC_NODE_ISLANDS_TRACE");
    nb_trace = t != NULL && strstr(t, "boot") != NULL;
  }
  return nb_trace == 1;
}

static NbStub *nb_stub(uint32_t oid) { return oid < nb_stubs_cap ? nb_stubs[oid] : NULL; }

/* ── parsing ──────────────────────────────────────────────────────────── */

typedef struct {
  const char *p, *end;
  bool bad;
} NbCursor;

static void nb_space(NbCursor *c) {
  if (c->p < c->end && *c->p == ' ') c->p++;
}

static uint64_t nb_uint(NbCursor *c) {
  nb_space(c);
  uint64_t v = 0;
  const char *start = c->p;
  while (c->p < c->end && *c->p >= '0' && *c->p <= '9') v = v * 10 + (uint64_t)(*c->p++ - '0');
  if (c->p == start) c->bad = true;
  return v;
}

static const char *nb_str(NbCursor *c, size_t *len) {
  uint64_t n = nb_uint(c);
  if (c->bad || c->p >= c->end || *c->p != ':' || (uint64_t)(c->end - c->p - 1) < n) {
    c->bad = true;
    *len = 0;
    return "";
  }
  c->p++;
  const char *s = c->p;
  c->p += n;
  *len = (size_t)n;
  return s;
}

static void nb_line_end(NbCursor *c) {
  while (c->p < c->end && *c->p != '\n') c->p++;
  if (c->p < c->end) c->p++;
}

/* ── guards ───────────────────────────────────────────────────────────── */

typedef struct {
  char *path;
  bool ok;
} NbGuardMemo;

static NbGuardMemo *nb_memo = NULL;
static size_t nb_nmemo = 0, nb_memo_cap = 0;

/* Whether the file still has the recorded size and mtime. */
static bool nb_guard(const char *path, size_t len, uint64_t size, uint64_t mtime_ns) {
  char full[4352];
  if (len > 0 && path[0] == '@')
    snprintf(full, sizeof full, "%s/%.*s", scr_ni_pack_dir(), (int)(len - 1), path + 1);
  else
    snprintf(full, sizeof full, "%.*s", (int)len, path);
  for (size_t i = 0; i < nb_nmemo; i++)
    if (strcmp(nb_memo[i].path, full) == 0) return nb_memo[i].ok;
  struct stat st;
  bool ok = false;
  if (stat(full, &st) == 0) {
#if defined(__APPLE__)
    uint64_t m = (uint64_t)st.st_mtimespec.tv_sec * 1000000000u + (uint64_t)st.st_mtimespec.tv_nsec;
#else
    uint64_t m = (uint64_t)st.st_mtim.tv_sec * 1000000000u + (uint64_t)st.st_mtim.tv_nsec;
#endif
    ok = (uint64_t)st.st_size == size && m == mtime_ns;
  }
  if (!ok && nb_tracing()) fprintf(stderr, "[node-islands] boot guard failed: %s\n", full);
  if (nb_nmemo == nb_memo_cap) {
    size_t cap = nb_memo_cap ? nb_memo_cap * 2 : 16;
    NbGuardMemo *grown = realloc(nb_memo, cap * sizeof *grown);
    if (grown == NULL) nb_oom();
    nb_memo = grown;
    nb_memo_cap = cap;
  }
  nb_memo[nb_nmemo].path = strdup(full);
  if (nb_memo[nb_nmemo].path == NULL) nb_oom();
  nb_memo[nb_nmemo++].ok = ok;
  return ok;
}

/* ── materialization (Node started) ──────────────────────────────────── */

static ScrCaught *nb_changed(const NbModule *m) {
  char message[4400];
  snprintf(message, sizeof message,
           "scriptc: the Node island module %s no longer matches its build-time interface snapshot",
           m->path);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  return scr_exc_take();
}

/* A NUL-terminated copy (the snapshot's strings are length-delimited). */
static char *nb_cstr(const char *s, size_t n) {
  char *c = malloc(n + 1);
  if (c == NULL) nb_oom();
  memcpy(c, s, n);
  c[n] = '\0';
  return c;
}

static bool nb_env_matches(const NbEnv *e) {
  char *key = nb_cstr(e->key, e->key_len);
  const char *now = getenv(key);
  free(key);
  if (!e->present) return now == NULL;
  return now != NULL && strlen(now) == e->value_len && memcmp(now, e->value, e->value_len) == 0;
}

/* The module evaluates against the environment it saw at its import
 * position (the boot guard checked those values then): keys the program
 * changed since are set back for the evaluation and restored after it. */
static void nb_env_swap(NbModule *m, char **saved, bool restore) {
  for (size_t i = 0; i < m->nenv; i++) {
    NbEnv *e = &m->env[i];
    char *key = nb_cstr(e->key, e->key_len);
    if (!restore) {
      const char *now = getenv(key);
      saved[i] = now != NULL ? strdup(now) : NULL;
      if (!nb_env_matches(e)) {
        if (e->present) {
          char *v = nb_cstr(e->value, e->value_len);
          setenv(key, v, 1);
          free(v);
        } else {
          unsetenv(key);
        }
      }
    } else {
      if (saved[i] != NULL) setenv(key, saved[i], 1);
      else unsetenv(key);
      free(saved[i]);
    }
    free(key);
  }
}

static void nb_materialize(NbModule *m) {
  if (m->done) return;
  m->done = true;
  if (nb_tracing()) fprintf(stderr, "[node-islands] evaluating deferred %s\n", m->path);
  char **saved = m->nenv > 0 ? calloc(m->nenv, sizeof *saved) : NULL;
  if (m->nenv > 0 && saved == NULL) nb_oom();
  nb_env_swap(m, saved, false);
  ScrStr *path = scr_str_new(m->path, strlen(m->path));
  ScrDyn *real = scr_ni_require(path);
  scr_str_release(path);
  nb_env_swap(m, saved, true);
  free(saved);
  if (real == NULL) {
    m->error = scr_exc_take();
    return;
  }
  NbStub *root = nb_stub(m->root);
  bool ok = scr_ni_stub_reconcile(root->box, real);
  scr_dyn_release(real);
  if (!ok) {
    m->error = nb_changed(m);
    return;
  }
  /* Only stubs the program holds (their box has a reference besides this
   * table's), and their parents, need their real values: a stub nobody
   * took has no identity to keep, and reading its value would run getters
   * the eager program never runs. Parents precede children in `order`. */
  bool *needed = m->norder > 0 ? calloc(m->norder, sizeof *needed) : NULL;
  if (m->norder > 0 && needed == NULL) nb_oom();
  for (size_t i = m->norder; i-- > 0;) {
    NbStub *s = nb_stub(m->order[i]);
    if (s->box->rc > 1) needed[i] = true;
    if (!needed[i]) continue;
    for (size_t j = 0; j < i; j++)
      if (m->order[j] == s->parent) needed[j] = true;
  }
  for (size_t i = 0; i < m->norder; i++) {
    NbStub *s = nb_stub(m->order[i]);
    NbStub *parent = nb_stub(s->parent);
    if (!needed[i]) continue;
    if (scr_ni_stub_of(s->box) == NULL) continue; /* reached through an earlier module */
    if (parent->error != NULL || scr_ni_stub_of(parent->box) != NULL) {
      s->error = scr_caught_retain(parent->error != NULL ? parent->error : m->error);
      continue;
    }
    ScrDyn *value = scr_ni_get_str(parent->box, s->key, s->key_len);
    if (value == NULL) {
      s->error = scr_exc_take();
      continue;
    }
    if (!scr_ni_stub_reconcile(s->box, value)) s->error = nb_changed(m);
    scr_dyn_release(value);
  }
  free(needed);
}

static void nb_started(void) {
  if (nb_lazy) return; /* each component evaluates on first use */
  if (nb_tracing() && nb_nmodules > 0)
    fprintf(stderr, "[node-islands] Node started: evaluating %zu deferred module(s)\n", nb_nmodules);
  for (size_t i = 0; i < nb_nmodules; i++) nb_materialize(nb_modules[i]);
}

void scr_ni_boot_materialize(void *stub) {
  NbModule *owner = ((NbStub *)stub)->module;
  for (size_t i = 0; i < nb_nmodules; i++) {
    NbModule *m = nb_modules[i];
    if (m == owner || (owner->component != 0 && m->component == owner->component))
      nb_materialize(m);
  }
}

void scr_ni_boot_stub_failed(void *stub) {
  NbStub *s = stub;
  ScrCaught *error = s->error != NULL ? s->error : s->module->error;
  if (error != NULL) {
    scr_rethrow(error);
    return;
  }
  ScrCaught *changed = nb_changed(s->module);
  s->error = changed;
  scr_rethrow(changed);
}

/* ── snapshot answers before Node starts ─────────────────────────────── */

ScrDyn *scr_ni_boot_member(void *stub, const char *key, size_t len) {
  NbStub *s = stub;
  for (size_t i = 0; i < s->nmembers; i++) {
    NbMember *m = &s->members[i];
    if (m->key_len != len || memcmp(m->key, key, len) != 0) continue;
    switch (m->kind) {
    case 'o': {
      NbStub *target = nb_stub(m->oid);
      return target != NULL ? scr_dyn_retain(target->box) : NULL;
    }
    case 'u': return scr_dyn_retain(scr_dyn_undefined());
    case 'l': return scr_dyn_new_null();
    case 't': return scr_dyn_new_bool(true);
    case 'f': return scr_dyn_new_bool(false);
    case 'n': return scr_dyn_new_num(m->num);
    case 's': {
      ScrStr *str = scr_str_new(m->str, m->str_len);
      ScrDyn *d = scr_dyn_new_str(str);
      scr_str_release(str);
      return d;
    }
    default: return NULL;
    }
  }
  return NULL;
}

bool scr_ni_boot_plain_class(void *stub) { return ((NbStub *)stub)->plain; }

/* Whether the snapshot still describes the stub's value: its module has
 * not evaluated. Before Node starts nothing has; in per-module mode, a
 * component's objects are unreachable to any code until it evaluates. */
bool scr_ni_boot_snapshot_valid(void *stub) {
  NbStub *s = stub;
  return !s->module->done && (nb_lazy || scr_ni_bridge_loaded() == NULL);
}

/* ── nodeIsland.defer ─────────────────────────────────────────────────── */

static void nb_cleanup(void) {
  for (size_t i = 0; i < nb_stubs_cap; i++) {
    NbStub *s = nb_stubs[i];
    if (s == NULL) continue;
    scr_dyn_release(s->box);
    if (s->error != NULL) scr_caught_release(s->error);
    free(s->members);
    free(s);
  }
  free(nb_stubs);
  nb_stubs = NULL;
  nb_stubs_cap = 0;
  for (size_t i = 0; i < nb_nmodules; i++) {
    NbModule *m = nb_modules[i];
    if (m->error != NULL) scr_caught_release(m->error);
    free(m->order);
    free(m->env);
    free(m->snapshot);
    free(m->path);
    free(m);
  }
  free(nb_modules);
  nb_modules = NULL;
  nb_nmodules = 0;
}

static void nb_install(void) {
  if (nb_installed) return;
  nb_installed = true;
  scr_ni_handles_install(); /* stub boxes use the island handle tag */
  scr_ni_started_hook = nb_started;
  scr_atexit(nb_cleanup);
}

static ScrDyn *nb_eager(ScrStr *path, const char *why) {
  if (nb_tracing())
    fprintf(stderr, "[node-islands] evaluating %.*s eagerly: %s\n", (int)path->len, path->data, why);
  return scr_ni_require(path);
}

static NbStub *nb_new_stub(uint32_t oid, uint32_t flags, bool plain, NbModule *m) {
  if (oid >= nb_stubs_cap) {
    size_t cap = nb_stubs_cap ? nb_stubs_cap : 64;
    while (cap <= oid) cap *= 2;
    NbStub **grown = realloc(nb_stubs, cap * sizeof *grown);
    if (grown == NULL) nb_oom();
    memset(grown + nb_stubs_cap, 0, (cap - nb_stubs_cap) * sizeof *grown);
    nb_stubs = grown;
    nb_stubs_cap = cap;
  }
  NbStub *s = calloc(1, sizeof *s);
  if (s == NULL) nb_oom();
  s->oid = oid;
  s->flags = flags;
  s->plain = plain;
  s->module = m;
  s->box = scr_ni_stub_new(flags, s);
  nb_stubs[oid] = s;
  return s;
}

ScrDyn *scr_node_island_defer(ScrStr *path, ScrStr *snapshot) {
  /* Pass 1: the guards, and the mode. */
  NbCursor c = {snapshot->data, snapshot->data + snapshot->len, false};
  bool lazy = false;
  while (c.p < c.end && !c.bad) {
    char tag = *c.p++;
    if (tag == 'M') lazy = true;
    nb_line_end(&c);
  }
  /* In per-module mode a module can stay deferred while Node runs. */
  if (!lazy && scr_ni_bridge_loaded() != NULL) return nb_eager(path, "Node is already running");
  nb_install();
  c = (NbCursor){snapshot->data, snapshot->data + snapshot->len, false};
  while (c.p < c.end && !c.bad) {
    char tag = *c.p++;
    if (tag == 'E') {
      NbEnv e = {0};
      e.key = nb_str(&c, &e.key_len);
      e.present = nb_uint(&c) != 0;
      e.value = nb_str(&c, &e.value_len);
      if (c.bad) break;
      if (!nb_env_matches(&e)) {
        if (nb_tracing())
          fprintf(stderr, "[node-islands] boot guard failed: env %.*s\n", (int)e.key_len, e.key);
        return nb_eager(path, "a boot guard failed");
      }
    } else if (tag == 'T') {
      int fd = (int)nb_uint(&c);
      bool was = nb_uint(&c) != 0;
      if (c.bad) break;
      if ((isatty(fd) == 1) != was) {
        if (nb_tracing()) fprintf(stderr, "[node-islands] boot guard failed: isatty(%d)\n", fd);
        return nb_eager(path, "a boot guard failed");
      }
    } else if (tag == 'G') {
      size_t len;
      const char *file = nb_str(&c, &len);
      uint64_t size = nb_uint(&c);
      uint64_t mtime = nb_uint(&c);
      if (c.bad) break;
      if (!nb_guard(file, len, size, mtime)) return nb_eager(path, "a boot guard failed");
    }
    nb_line_end(&c);
  }
  if (c.bad) return nb_eager(path, "malformed snapshot");
  /* Pass 2: the stubs. The module owns a copy of the snapshot text, which
   * the members' keys and strings point into. */
  NbModule *m = calloc(1, sizeof *m);
  if (m == NULL) nb_oom();
  m->path = malloc(path->len + 1);
  m->snapshot = malloc(snapshot->len + 1);
  if (m->path == NULL || m->snapshot == NULL) nb_oom();
  memcpy(m->path, path->data, path->len);
  m->path[path->len] = '\0';
  memcpy(m->snapshot, snapshot->data, snapshot->len);
  m->snapshot[snapshot->len] = '\0';
  c = (NbCursor){m->snapshot, m->snapshot + snapshot->len, false};
  while (c.p < c.end && !c.bad) {
    char tag = *c.p++;
    if (tag == 'O') {
      uint32_t oid = (uint32_t)nb_uint(&c);
      uint32_t flags = (uint32_t)nb_uint(&c);
      bool plain = nb_uint(&c) != 0;
      if (!c.bad && nb_stub(oid) == NULL) nb_new_stub(oid, flags, plain, m);
    } else if (tag == 'K') {
      uint32_t oid = (uint32_t)nb_uint(&c);
      NbMember mem = {0};
      mem.key = nb_str(&c, &mem.key_len);
      nb_space(&c);
      if (c.p >= c.end) c.bad = true;
      if (c.bad) break;
      mem.kind = *c.p++;
      if (mem.kind == 'o') {
        mem.oid = (uint32_t)nb_uint(&c);
      } else if (mem.kind == 'n') {
        char num[64];
        size_t n = 0;
        while (c.p < c.end && *c.p != '\n' && n + 1 < sizeof num) num[n++] = *c.p++;
        num[n] = '\0';
        mem.num = strtod(num, NULL);
      } else if (mem.kind == 's') {
        mem.str = nb_str(&c, &mem.str_len);
      }
      NbStub *s = nb_stub(oid);
      /* Members of objects an earlier module already described stay. */
      if (!c.bad && s != NULL && s->module == m) {
        if (s->nmembers == s->members_cap) {
          size_t cap = s->members_cap ? s->members_cap * 2 : 4;
          NbMember *grown = realloc(s->members, cap * sizeof *grown);
          if (grown == NULL) nb_oom();
          s->members = grown;
          s->members_cap = cap;
        }
        s->members[s->nmembers++] = mem;
      }
    } else if (tag == 'R') {
      m->root = (uint32_t)nb_uint(&c);
    } else if (tag == 'M') {
      m->component = (uint32_t)nb_uint(&c);
      nb_lazy = true;
    } else if (tag == 'E') {
      NbEnv e = {0};
      e.key = nb_str(&c, &e.key_len);
      e.present = nb_uint(&c) != 0;
      e.value = nb_str(&c, &e.value_len);
      if (!c.bad) {
        NbEnv *grown = realloc(m->env, (m->nenv + 1) * sizeof *grown);
        if (grown == NULL) nb_oom();
        m->env = grown;
        m->env[m->nenv++] = e;
      }
    }
    nb_line_end(&c);
  }
  NbStub *root = nb_stub(m->root);
  if (c.bad || root == NULL) {
    free(m->env);
    free(m->snapshot);
    free(m->path);
    free(m);
    return nb_eager(path, "malformed snapshot");
  }
  /* Reconciliation order: breadth first from the module's value, so each
   * stub's parent is real before the stub's own member read. */
  size_t cap = 8;
  m->order = malloc(cap * sizeof *m->order);
  if (m->order == NULL) nb_oom();
  for (size_t head = 0, at = (size_t)-1;; head++) {
    NbStub *p = at == (size_t)-1 ? root : nb_stub(m->order[at]);
    for (size_t i = 0; i < p->nmembers; i++) {
      NbMember *mem = &p->members[i];
      if (mem->kind != 'o') continue;
      NbStub *child = nb_stub(mem->oid);
      if (child == NULL || child == root || child->module != m || child->key != NULL) continue;
      child->parent = p->oid;
      child->key = mem->key;
      child->key_len = mem->key_len;
      if (m->norder == cap) {
        cap *= 2;
        uint32_t *grown = realloc(m->order, cap * sizeof *grown);
        if (grown == NULL) nb_oom();
        m->order = grown;
      }
      m->order[m->norder++] = child->oid;
    }
    (void)head;
    at = at == (size_t)-1 ? 0 : at + 1;
    if (at >= m->norder) break;
  }
  if (nb_nmodules == nb_modules_cap) {
    size_t mcap = nb_modules_cap ? nb_modules_cap * 2 : 4;
    NbModule **grown = realloc(nb_modules, mcap * sizeof *grown);
    if (grown == NULL) nb_oom();
    nb_modules = grown;
    nb_modules_cap = mcap;
  }
  nb_modules[nb_nmodules++] = m;
  if (nb_tracing()) fprintf(stderr, "[node-islands] deferred %s\n", m->path);
  return scr_dyn_retain(root->box);
}

#else

ScrDyn *scr_node_island_defer(ScrStr *path, ScrStr *snapshot) {
  (void)snapshot;
  return scr_ni_require(path);
}

#endif /* !_WIN32 && !__wasi__ */
