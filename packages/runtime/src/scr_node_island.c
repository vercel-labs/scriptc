/* Node islands: Node.js loaded into the process on first use (scope-B
 * milestone NI-1). This translation unit links only into programs whose
 * IR calls into Node (the `nodeIsland` runtime feature), with the
 * SCR_NODE_ISLANDS build of scr_async.c; every other program links
 * neither, byte for byte. libnode itself is never linked: the first call
 * dlopens the bridge library of a libnode pack (scr_node_bridge.h), which
 * links libnode, so a run that never calls into Node never maps it.
 *
 * Locating Node. The pack directory is SCRIPTC_LIBNODE when set (an
 * absolute path), else the path recorded at build time; a recorded path
 * that starts with `$ORIGIN/` resolves against the directory of the
 * running executable (the `beside` packaging, and the hook for shipping
 * Node with the program). A process with elevated privileges ignores
 * SCRIPTC_LIBNODE and refuses `$ORIGIN/`. No search path is used. The
 * bridge must speak SCR_NODE_BRIDGE_ABI and link the Node version recorded
 * at build time; anything else is a fatal error at first use, never a
 * silent use of another Node.
 *
 * Calls. A call serializes its arguments as JSON, enters JavaScript through
 * the bridge (a callback scope, so ticks and microtasks drain when it
 * returns) and parses the outcome: the result's JSON copy, or the copied
 * error (see scr_node_island_host.cjs). An asynchronous call registers its
 * promise first, because the bridge may settle it before returning. Until
 * NI-3 hosts the runtime's queues on Node's libuv, the runtime's loop drives
 * Node's: the loop slot keeps the program alive while Node has ref'd work,
 * sleeps on its backend fd up to its next timer, and runs one non-blocking
 * turn of it per loop turn.
 *
 * Node's stack. V8 fixes an isolate's stack limit where it is created, and
 * calls into Node can come from any async fiber (512 KB stacks without a
 * guard page) or from the main stack. Every entry into Node therefore runs
 * on one dedicated stack of NI_STACK bytes with a guard page, reached by a
 * context switch; the runtime's own stack guard follows it there. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)
#include "scr_node_island_host.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <ucontext.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/auxv.h>
#endif

#ifdef __APPLE__
#define NI_BRIDGE_FILE "libscr_node_bridge.dylib"
#else
#define NI_BRIDGE_FILE "libscr_node_bridge.so"
#endif

typedef struct {
  uint32_t id;
  ScrPromise *promise; /* owned */
} NiPending;

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define NI_ASAN 1
void __sanitizer_start_switch_fiber(void **fake_stack_save, const void *bottom, size_t size);
void __sanitizer_finish_switch_fiber(void *fake_stack_save, const void **bottom_old,
                                     size_t *size_old);
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
#endif
#endif

#define NI_STACK ((size_t)64 * 1024 * 1024)
#define NI_GUARD ((size_t)64 * 1024)

static const char *ni_libnode = NULL;      /* recorded pack directory */
static const char *ni_node_version = NULL; /* recorded Node version */
static const ScrNodeBridge *ni_bridge = NULL;
static char ni_dir[4096];
static uint32_t ni_next_id = 1;
static NiPending *ni_pending = NULL;
static size_t ni_npending = 0, ni_pending_cap = 0;

void scr_node_island_install(const char *libnode, const char *node_version) {
  ni_libnode = libnode;
  ni_node_version = node_version;
}

SCR_COLD static void ni_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* `len` bytes as a NUL-terminated malloc'd copy. */
static char *ni_cstr_of(const char *bytes, size_t len) {
  char *copy = malloc(len + 1);
  if (copy == NULL) ni_oom();
  memcpy(copy, bytes, len);
  copy[len] = '\0';
  return copy;
}

SCR_COLD static void ni_fatal(const char *message) {
  fflush(stdout);
  fputs(message, stderr);
  fflush(stderr);
  _Exit(1);
}

/* True when the process runs with elevated privileges (setuid, setgid or
 * file capabilities). The pack directory then comes only from an absolute
 * path recorded at build time, as the dynamic linker ignores
 * LD_LIBRARY_PATH and $ORIGIN for such processes. */
static bool ni_secure(void) {
#if defined(__APPLE__)
  return issetugid() != 0;
#elif defined(__linux__)
  return getauxval(AT_SECURE) != 0;
#else
  return false;
#endif
}

/* The pack directory: SCRIPTC_LIBNODE, else the recorded path with a
 * leading `$ORIGIN/` resolved against the executable's own directory.
 * Both must resolve to absolute paths. */
static const char *ni_pack_dir(void) {
  bool secure = ni_secure();
  const char *override = secure ? NULL : getenv("SCRIPTC_LIBNODE");
  if (override != NULL && override[0] != '\0' && override[0] != '/')
    ni_fatal("scriptc: SCRIPTC_LIBNODE must be an absolute path to a libnode pack directory\n");
  const char *dir = override != NULL && override[0] != '\0' ? override : ni_libnode;
  if (dir == NULL || dir[0] == '\0')
    ni_fatal("scriptc: this program calls into Node.js (@scriptc/node), but no libnode pack was "
             "recorded at build time; set SCRIPTC_LIBNODE to a pack directory\n");
  static const char origin[] = "$ORIGIN/";
  int written;
  if (dir != override && strncmp(dir, origin, sizeof origin - 1) == 0) {
    if (secure)
      ni_fatal("scriptc: a program running with elevated privileges cannot load a libnode pack "
               "beside its executable; build it with an absolute SCRIPTC_LIBNODE\n");
    ScrStr *self = scr_process_exec_path();
    size_t len = self->len;
    while (len > 0 && self->data[len - 1] != '/') len--;
    if (len == 0 || self->data[0] != '/') {
      scr_str_release(self);
      ni_fatal("scriptc: cannot locate this program's executable to find its libnode pack\n");
    }
    written = snprintf(ni_dir, sizeof ni_dir, "%.*s%s", (int)len, self->data,
                       dir + sizeof origin - 1);
    scr_str_release(self);
  } else {
    written = snprintf(ni_dir, sizeof ni_dir, "%s", dir);
  }
  if (written < 0 || (size_t)written >= sizeof ni_dir)
    ni_fatal("scriptc: the libnode pack path is too long\n");
  return ni_dir;
}

/* ── the island module tree ───────────────────────────────────────────── */

/* The JavaScript the program's calls load (node-islands/modules.ts), named
 * by a manifest of relative paths with their sizes and SHA-256 digests, plus
 * the links between package directories. Before Node loads anything, the
 * tree is made available at one directory, and every file is checked against
 * the manifest:
 * - beside the executable (`--libnode=beside`), at the recorded `$ORIGIN/`
 *   path, checked on every start;
 * - otherwise from the executable itself, extracted once into
 *   $XDG_CACHE_HOME/scriptc/node-islands/<manifest digest>/ (or
 *   ~/.cache/...), checked on every start; when that directory cannot be
 *   used, into a private directory under $TMPDIR removed at exit.
 * Directories are created 0700 and owned by the process's user; no link is
 * followed below the cache directory. A process with elevated privileges
 * refuses the tree, as it refuses SCRIPTC_LIBNODE. A call names its module
 * by its path relative to the tree. */
static const char *ni_manifest = NULL;
static size_t ni_manifest_len = 0;
static const unsigned char *ni_modules = NULL;
static size_t ni_modules_len = 0;
static const char *ni_modules_location = NULL;
/* The tree's directory at run time; "/" when the calls load only Node's
 * built-in modules. */
static char ni_root[4096] = "/";

void scr_node_island_install_modules(const char *manifest, size_t manifest_len,
                                     const unsigned char *data, size_t data_len,
                                     const char *location) {
  ni_manifest = manifest;
  ni_manifest_len = manifest_len;
  ni_modules = data;
  ni_modules_len = data_len;
  ni_modules_location = location;
}

/* SHA-256 (FIPS 180-4), for the manifest's digests. */
typedef struct {
  uint32_t h[8];
  uint64_t bytes;
  unsigned char tail[64];
  size_t tail_len;
} NiSha256;

static const uint32_t ni_sha256_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static uint32_t ni_rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

static void ni_sha256_block(uint32_t h[8], const unsigned char *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
           ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ni_rotr(w[i - 15], 7) ^ ni_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ni_rotr(w[i - 2], 17) ^ ni_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = k + (ni_rotr(e, 6) ^ ni_rotr(e, 11) ^ ni_rotr(e, 25)) + ((e & f) ^ (~e & g)) +
                  ni_sha256_k[i] + w[i];
    uint32_t t2 = (ni_rotr(a, 2) ^ ni_rotr(a, 13) ^ ni_rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    k = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += k;
}

static void ni_sha256_init(NiSha256 *s) {
  static const uint32_t initial[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(s->h, initial, sizeof initial);
  s->bytes = 0;
  s->tail_len = 0;
}

static void ni_sha256_update(NiSha256 *s, const unsigned char *data, size_t len) {
  s->bytes += len;
  while (len > 0) {
    if (s->tail_len == 0 && len >= 64) {
      ni_sha256_block(s->h, data);
      data += 64;
      len -= 64;
      continue;
    }
    size_t take = 64 - s->tail_len < len ? 64 - s->tail_len : len;
    memcpy(s->tail + s->tail_len, data, take);
    s->tail_len += take;
    data += take;
    len -= take;
    if (s->tail_len == 64) {
      ni_sha256_block(s->h, s->tail);
      s->tail_len = 0;
    }
  }
}

static void ni_sha256_final(NiSha256 *s, unsigned char out[32]) {
  uint64_t bits = s->bytes * 8;
  unsigned char pad[72] = {0x80};
  size_t padding = (s->tail_len < 56 ? 56 : 120) - s->tail_len;
  for (int i = 0; i < 8; i++) pad[padding + i] = (unsigned char)(bits >> (56 - 8 * i));
  ni_sha256_update(s, pad, padding + 8);
  for (int i = 0; i < 8; i++)
    for (int b = 0; b < 4; b++) out[i * 4 + b] = (unsigned char)(s->h[i] >> (24 - 8 * b));
}

typedef struct {
  char *path;
  size_t size;
  unsigned char sha256[32];
  size_t offset; /* into ni_modules */
} NiFile;

typedef struct {
  char *path, *target;
} NiLink;

static NiFile *ni_files = NULL;
static size_t ni_nfiles = 0;
static NiLink *ni_links = NULL;
static size_t ni_nlinks = 0;

SCR_COLD static void ni_bad_manifest(void) {
  ni_fatal("scriptc: this program's Node island module manifest is malformed\n");
}

static char *ni_dup_str(const ScrDyn *d) {
  if (d == NULL || d->kind != SCR_DYN_STR) ni_bad_manifest();
  if (memchr(d->v.str->data, '\0', d->v.str->len) != NULL) ni_bad_manifest();
  return ni_cstr_of(d->v.str->data, d->v.str->len);
}

/* A relative path inside the tree: no leading `/`, no empty, `.` or `..`
 * component. */
static bool ni_relative_inside(const char *path) {
  if (path[0] == '\0' || path[0] == '/') return false;
  for (const char *p = path;;) {
    const char *slash = strchr(p, '/');
    size_t n = slash != NULL ? (size_t)(slash - p) : strlen(p);
    if (n == 0 || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) return false;
    if (slash == NULL) return true;
    p = slash + 1;
  }
}

/* A link target that, read from the link's directory, stays inside the
 * tree. */
static bool ni_link_inside(const char *link, const char *target) {
  if (target[0] == '\0' || target[0] == '/') return false;
  long depth = 0;
  for (const char *p = link; (p = strchr(p, '/')) != NULL; p++) depth++;
  for (const char *p = target;;) {
    const char *slash = strchr(p, '/');
    size_t n = slash != NULL ? (size_t)(slash - p) : strlen(p);
    if (n == 2 && p[0] == '.' && p[1] == '.') {
      if (--depth < 0) return false;
    } else if (n == 0 || !(n == 1 && p[0] == '.')) {
      if (n == 0) return false;
      depth++;
    }
    if (slash == NULL) return true;
    p = slash + 1;
  }
}

static int ni_hex(char c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}

static void ni_parse_manifest(void) {
  ScrStr *text = scr_str_new(ni_manifest, ni_manifest_len);
  ScrDyn *body = scr_json_parse(text);
  scr_str_release(text);
  if (body == NULL || body->kind != SCR_DYN_OBJ) ni_bad_manifest();
  ScrDyn *files = scr_dyn_obj_get(body, "files", 5);
  ScrDyn *links = scr_dyn_obj_get(body, "links", 5);
  if (files == NULL || files->kind != SCR_DYN_ARR || links == NULL || links->kind != SCR_DYN_ARR)
    ni_bad_manifest();
  ni_nfiles = (size_t)scr_dyn_arr_len(files);
  ni_nlinks = (size_t)scr_dyn_arr_len(links);
  ni_files = calloc(ni_nfiles + 1, sizeof *ni_files);
  ni_links = calloc(ni_nlinks + 1, sizeof *ni_links);
  if (ni_files == NULL || ni_links == NULL) ni_oom();
  size_t offset = 0;
  for (size_t i = 0; i < ni_nfiles; i++) {
    ScrDyn *entry = scr_dyn_arr_at(files, (double)i);
    if (entry->kind != SCR_DYN_ARR || scr_dyn_arr_len(entry) != 3) ni_bad_manifest();
    ScrDyn *path = scr_dyn_arr_at(entry, 0), *size = scr_dyn_arr_at(entry, 1),
           *digest = scr_dyn_arr_at(entry, 2);
    NiFile *f = &ni_files[i];
    f->path = ni_dup_str(path);
    if (!ni_relative_inside(f->path) || size->kind != SCR_DYN_NUM || size->v.num < 0 ||
        digest->kind != SCR_DYN_STR || digest->v.str->len != 64)
      ni_bad_manifest();
    f->size = (size_t)size->v.num;
    for (int b = 0; b < 32; b++) {
      int hi = ni_hex(digest->v.str->data[b * 2]), lo = ni_hex(digest->v.str->data[b * 2 + 1]);
      if (hi < 0 || lo < 0) ni_bad_manifest();
      f->sha256[b] = (unsigned char)(hi * 16 + lo);
    }
    f->offset = offset;
    offset += f->size;
    scr_dyn_release(path);
    scr_dyn_release(size);
    scr_dyn_release(digest);
    scr_dyn_release(entry);
  }
  if (ni_modules != NULL && offset != ni_modules_len) ni_bad_manifest();
  for (size_t i = 0; i < ni_nlinks; i++) {
    ScrDyn *entry = scr_dyn_arr_at(links, (double)i);
    if (entry->kind != SCR_DYN_ARR || scr_dyn_arr_len(entry) != 2) ni_bad_manifest();
    ScrDyn *path = scr_dyn_arr_at(entry, 0), *target = scr_dyn_arr_at(entry, 1);
    ni_links[i].path = ni_dup_str(path);
    ni_links[i].target = ni_dup_str(target);
    if (!ni_relative_inside(ni_links[i].path) ||
        !ni_link_inside(ni_links[i].path, ni_links[i].target))
      ni_bad_manifest();
    scr_dyn_release(path);
    scr_dyn_release(target);
    scr_dyn_release(entry);
  }
  scr_dyn_release(body);
}

/* The directory `name` in `dirfd`, never through a link; created 0700 when
 * `create` and absent. -1 when it cannot be opened. */
static int ni_dir_at(int dirfd, const char *name, bool create) {
  if (create && mkdirat(dirfd, name, 0700) != 0 && errno != EEXIST) return -1;
  return openat(dirfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

/* The parent directory of the relative `path` below `rootfd` (its last
 * component is left in *base), opened component by component without
 * following links; created when `create`. -1 when it cannot be opened. */
static int ni_parent_at(int rootfd, const char *path, bool create, const char **base) {
  int fd = dup(rootfd);
  const char *p = path;
  for (const char *slash; fd >= 0 && (slash = strchr(p, '/')) != NULL; p = slash + 1) {
    char component[256];
    size_t n = (size_t)(slash - p);
    if (n >= sizeof component) {
      close(fd);
      return -1;
    }
    memcpy(component, p, n);
    component[n] = '\0';
    int next = ni_dir_at(fd, component, create);
    close(fd);
    fd = next;
  }
  *base = p;
  return fd;
}

/* A directory this process may trust: owned by its user, writable by no
 * one else. */
static bool ni_private_dir(int fd) {
  struct stat st;
  return fd >= 0 && fstat(fd, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == geteuid() &&
         (st.st_mode & 022) == 0;
}

static bool ni_digest_matches(const unsigned char *data, size_t len,
                              const unsigned char expected[32]) {
  NiSha256 s;
  unsigned char got[32];
  ni_sha256_init(&s);
  ni_sha256_update(&s, data, len);
  ni_sha256_final(&s, got);
  return memcmp(got, expected, 32) == 0;
}

/* Whether the tree below `rootfd` holds exactly the manifest's files (by
 * size and digest) and links. */
static bool ni_tree_matches(int rootfd) {
  for (size_t i = 0; i < ni_nfiles; i++) {
    const char *base;
    int dirfd = ni_parent_at(rootfd, ni_files[i].path, false, &base);
    if (dirfd < 0) return false;
    int fd = openat(dirfd, base, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    close(dirfd);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ||
        (size_t)st.st_size != ni_files[i].size) {
      if (fd >= 0) close(fd);
      return false;
    }
    NiSha256 s;
    ni_sha256_init(&s);
    unsigned char buffer[65536];
    size_t total = 0;
    for (;;) {
      ssize_t n = read(fd, buffer, sizeof buffer);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) break;
      ni_sha256_update(&s, buffer, (size_t)n);
      total += (size_t)n;
    }
    close(fd);
    unsigned char got[32];
    ni_sha256_final(&s, got);
    if (total != ni_files[i].size || memcmp(got, ni_files[i].sha256, 32) != 0) return false;
  }
  for (size_t i = 0; i < ni_nlinks; i++) {
    const char *base;
    int dirfd = ni_parent_at(rootfd, ni_links[i].path, false, &base);
    if (dirfd < 0) return false;
    char target[4096];
    ssize_t n = readlinkat(dirfd, base, target, sizeof target - 1);
    close(dirfd);
    if (n < 0) return false;
    target[n] = '\0';
    if (strcmp(target, ni_links[i].target) != 0) return false;
  }
  return true;
}

/* Writes the executable's tree below `rootfd` (an empty directory). */
static bool ni_extract(int rootfd) {
  for (size_t i = 0; i < ni_nfiles; i++) {
    const unsigned char *data = ni_modules + ni_files[i].offset;
    if (!ni_digest_matches(data, ni_files[i].size, ni_files[i].sha256)) return false;
    const char *base;
    int dirfd = ni_parent_at(rootfd, ni_files[i].path, true, &base);
    if (dirfd < 0) return false;
    int fd = openat(dirfd, base, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    close(dirfd);
    if (fd < 0) return false;
    size_t done = 0;
    while (done < ni_files[i].size) {
      ssize_t n = write(fd, data + done, ni_files[i].size - done);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) break;
      done += (size_t)n;
    }
    if (close(fd) != 0 || done != ni_files[i].size) return false;
  }
  for (size_t i = 0; i < ni_nlinks; i++) {
    const char *base;
    int dirfd = ni_parent_at(rootfd, ni_links[i].path, true, &base);
    if (dirfd < 0) return false;
    int status = symlinkat(ni_links[i].target, dirfd, base);
    close(dirfd);
    if (status != 0) return false;
  }
  return true;
}

/* Removes everything below `dirfd` and closes it, never following links. */
static void ni_remove_below(int dirfd) {
  DIR *dir = fdopendir(dirfd);
  if (dir == NULL) {
    close(dirfd);
    return;
  }
  for (struct dirent *e; (e = readdir(dir)) != NULL;) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    int sub = openat(dirfd, e->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (sub >= 0) {
      ni_remove_below(sub);
      (void)unlinkat(dirfd, e->d_name, AT_REMOVEDIR);
    } else {
      (void)unlinkat(dirfd, e->d_name, 0);
    }
  }
  closedir(dir);
}


static char ni_temp_root[4096] = "";

static void ni_remove_temp_root(void) {
  int fd = open(ni_temp_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0) ni_remove_below(fd);
  (void)rmdir(ni_temp_root);
}

static bool ni_set_root(const char *a, const char *b, const char *c) {
  int n = snprintf(ni_root, sizeof ni_root, "%s%s%s", a, b, c);
  return n > 0 && (size_t)n < sizeof ni_root;
}

/* The tree in the cache directory, extracted there when absent. */
static bool ni_cached_root(const char *digest) {
  const char *xdg = getenv("XDG_CACHE_HOME");
  const char *home = getenv("HOME");
  char base[4096];
  int n;
  if (xdg != NULL && xdg[0] == '/')
    n = snprintf(base, sizeof base, "%s", xdg);
  else if (home != NULL && home[0] == '/')
    n = snprintf(base, sizeof base, "%s/.cache", home);
  else
    return false;
  if (n <= 0 || (size_t)n >= sizeof base) return false;
  (void)mkdir(base, 0700);
  int basefd = open(base, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (basefd < 0) return false;
  int scriptc = ni_dir_at(basefd, "scriptc", true);
  close(basefd);
  int islands = ni_private_dir(scriptc) ? ni_dir_at(scriptc, "node-islands", true) : -1;
  if (scriptc >= 0) close(scriptc);
  if (!ni_private_dir(islands)) {
    if (islands >= 0) close(islands);
    return false;
  }
  bool ok = false;
  int tree = ni_dir_at(islands, digest, false);
  if (tree < 0 && errno == ENOENT) {
    /* Extract into a fresh sibling, then move it into place. */
    char staging[128];
    snprintf(staging, sizeof staging, "%s.%ld.tmp", digest, (long)getpid());
    int fd = ni_dir_at(islands, staging, true);
    if (ni_private_dir(fd) && ni_extract(fd) && ni_tree_matches(fd) &&
        renameat(islands, staging, islands, digest) == 0) {
      close(fd);
      tree = ni_dir_at(islands, digest, false);
    } else {
      if (fd >= 0) ni_remove_below(fd);
      (void)unlinkat(islands, staging, AT_REMOVEDIR);
      tree = ni_dir_at(islands, digest, false); /* another process may have placed it */
    }
  }
  if (ni_private_dir(tree) && ni_tree_matches(tree))
    ok = ni_set_root(base, "/scriptc/node-islands/", digest);
  if (tree >= 0) close(tree);
  close(islands);
  return ok;
}

/* The tree in a private directory of this run, removed at exit. */
static bool ni_temporary_root(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || tmp[0] != '/') tmp = "/tmp";
  int n = snprintf(ni_temp_root, sizeof ni_temp_root, "%s/scriptc-node-islands-XXXXXX", tmp);
  if (n <= 0 || (size_t)n >= sizeof ni_temp_root || mkdtemp(ni_temp_root) == NULL) return false;
  scr_atexit(ni_remove_temp_root);
  int fd = open(ni_temp_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  bool ok = ni_private_dir(fd) && ni_extract(fd) && ni_tree_matches(fd);
  if (fd >= 0) close(fd);
  return ok && ni_set_root(ni_temp_root, "", "");
}

/* Makes the tree available and sets ni_root; fatal when it cannot. */
static void ni_open_modules(void) {
  if (ni_manifest == NULL) return; /* only built-in modules */
  if (ni_secure())
    ni_fatal("scriptc: a program running with elevated privileges cannot load Node island "
             "modules\n");
  ni_parse_manifest();
  if (ni_modules_location != NULL && ni_modules_location[0] != '\0') {
    static const char origin[] = "$ORIGIN/";
    if (strncmp(ni_modules_location, origin, sizeof origin - 1) != 0) ni_bad_manifest();
    ScrStr *self = scr_process_exec_path();
    size_t len = self->len;
    while (len > 0 && self->data[len - 1] != '/') len--;
    bool absolute = len > 0 && self->data[0] == '/';
    char dir[4096];
    int n = snprintf(dir, sizeof dir, "%.*s", (int)len, self->data);
    scr_str_release(self);
    if (!absolute || n <= 0 || (size_t)n >= sizeof dir ||
        !ni_set_root(dir, ni_modules_location + sizeof origin - 1, ""))
      ni_fatal("scriptc: cannot locate this program's Node island modules\n");
    int fd = open(ni_root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    bool ok = fd >= 0 && ni_tree_matches(fd);
    if (fd >= 0) close(fd);
    if (!ok) {
      char message[8192];
      snprintf(message, sizeof message,
               "scriptc: the Node island modules at %s do not match this program\n", ni_root);
      ni_fatal(message);
    }
    return;
  }
  NiSha256 s;
  unsigned char digest[32];
  ni_sha256_init(&s);
  ni_sha256_update(&s, (const unsigned char *)ni_manifest, ni_manifest_len);
  ni_sha256_final(&s, digest);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  if (ni_modules == NULL && ni_nfiles > 0) ni_bad_manifest();
  if (!ni_cached_root(hex) && !ni_temporary_root())
    ni_fatal("scriptc: cannot write this program's Node island modules to a private directory\n");
}

/* The calling module's path inside the tree: `<root>/<relative path>`. */
static char *ni_caller_path(const ScrStr *relative) {
  size_t root = strlen(ni_root);
  bool slash = root > 0 && ni_root[root - 1] == '/';
  char *path = malloc(root + 1 + relative->len + 1);
  if (path == NULL) ni_oom();
  memcpy(path, ni_root, root);
  if (!slash) path[root++] = '/';
  memcpy(path + root, relative->data, relative->len);
  path[root + relative->len] = '\0';
  return path;
}

/* The bootstrap: the tree root for the host's resolution guard, then the
 * host script. +1 malloc'd. */
static char *ni_bootstrap(void) {
  size_t host = strlen(scr_node_island_host_js);
  size_t cap = 64 + strlen(ni_root) * 6 + host;
  char *out = malloc(cap);
  if (out == NULL) ni_oom();
  size_t n = (size_t)snprintf(out, cap, "globalThis.__scriptcNodeIslandRoot = \"");
  for (const char *p = ni_root; *p != '\0'; p++) {
    unsigned char c = (unsigned char)*p;
    if (c == '"' || c == '\\')
      n += (size_t)snprintf(out + n, cap - n, "\\%c", c);
    else if (c < 0x20)
      n += (size_t)snprintf(out + n, cap - n, "\\u%04x", c);
    else
      out[n++] = (char)c;
  }
  n += (size_t)snprintf(out + n, cap - n, "\";\n");
  memcpy(out + n, scr_node_island_host_js, host + 1);
  return out;
}

/* ── outcomes ─────────────────────────────────────────────────────────── */

/* The result of an "R" outcome: its JSON copy, or undefined. +1, or NULL
 * with a parse error pending. */
static ScrDyn *ni_result(const char *json, size_t len) {
  if (len == 0) return scr_dyn_undefined();
  ScrStr *text = scr_str_new(json, len);
  ScrDyn *value = scr_json_parse(text);
  scr_str_release(text);
  return value;
}

/* Leaves the copied error of a "T" outcome pending. */
static void ni_throw(const char *json, size_t len) {
  ScrStr *text = scr_str_new(json, len);
  ScrDyn *body = scr_json_parse(text);
  scr_str_release(text);
  if (body == NULL) return; /* the parse error is pending */
  ScrDyn *error = scr_dyn_obj_get(body, "error", 5);
  if (error != NULL && error->kind == SCR_DYN_OBJ) {
    ScrDyn *kind = scr_dyn_obj_get(error, "kind", 4);
    ScrDyn *message = scr_dyn_obj_get(error, "message", 7);
    ScrDyn *code = scr_dyn_obj_get(error, "code", 4);
    ScrStr *empty = scr_str_new("", 0);
    scr_throw_node_coded(kind != NULL && kind->kind == SCR_DYN_NUM ? kind->v.num : 0,
                         code != NULL && code->kind == SCR_DYN_STR ? code->v.str : empty,
                         message != NULL && message->kind == SCR_DYN_STR ? message->v.str : empty);
    scr_str_release(empty);
    scr_dyn_release(body);
    return;
  }
  ScrDyn *value = scr_dyn_obj_get(body, "value", 5);
  scr_dyn_throw(scr_dyn_retain(value != NULL ? value : scr_dyn_undefined()));
  scr_dyn_release(body);
}

/* An outcome as a value (+1), or NULL with its error pending. */
static ScrDyn *ni_outcome(const char *outcome, size_t len) {
  if (len > 0 && outcome[0] == 'R') return ni_result(outcome + 1, len - 1);
  if (len > 0 && outcome[0] == 'T') ni_throw(outcome + 1, len - 1);
  else ni_fatal("scriptc: malformed outcome from the libnode bridge\n");
  return NULL;
}

/* ── the host side of the bridge ──────────────────────────────────────── */

static void ni_settle(uint32_t id, const char *outcome, size_t len) {
  for (size_t i = 0; i < ni_npending; i++) {
    if (ni_pending[i].id != id) continue;
    ScrPromise *p = ni_pending[i].promise;
    ni_pending[i] = ni_pending[--ni_npending];
    ScrDyn *value = ni_outcome(outcome, len);
    if (value != NULL)
      scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_promise_reject_pending(p); /* no-op unless an error is pending */
    scr_promise_release(p);
    return;
  }
}

static void ni_exit(int code) {
  scr_process_exit((double)code);
  /* A code process.exit refuses: exit 1 rather than continue half-way. */
  ni_fatal("");
}

/* The start of Node's stack for callers on it (V8's stack-scan bound). */
static uintptr_t ni_stack_start(void);

static const ScrNodeBridgeHost ni_host = {&ni_settle, &ni_exit, &ni_stack_start};

/* ── the loop slot ────────────────────────────────────────────────────── */

static bool ni_alive(void) { return ni_bridge->alive() != 0; }
static void ni_pump_job(void *p);
static void ni_stop_job(void *p);
static void ni_on_node_stack(void (*job)(void *), void *arg);
static void ni_pump(void) { ni_on_node_stack(ni_pump_job, NULL); }
static int ni_backend_fd(void) { return ni_bridge->backend_fd(); }
static int ni_backend_timeout(void) { return ni_bridge->backend_timeout(); }
typedef struct {
  int code;
} NiFinish;
static void ni_finish_job(void *p);

/* At exit, after the program's own exit work: Node's process ends with
 * the program's code ('beforeExit', then 'exit'), and Node stops. A code
 * Node's process changed (process.exitCode in Node) is the program's. */
static void ni_stop_atexit(void) {
  int code = (int)scr_process_exit_code_or_zero();
  NiFinish finish = {code};
  /* Node writes to the same stdout. */
  fflush(stdout);
  ni_on_node_stack(ni_finish_job, &finish);
  ni_on_node_stack(ni_stop_job, NULL);
  if (finish.code != code) {
    fflush(NULL);
    if (ni_temp_root[0] != '\0') ni_remove_temp_root();
    _Exit(finish.code & 0xff);
  }
}

/* ── Node's stack ─────────────────────────────────────────────────────── */

static char *ni_stack = NULL; /* the mapping; usable above NI_GUARD */
static ucontext_t ni_node_ctx, ni_caller_ctx;
static bool ni_on_stack = false;
static void (*ni_job)(void *) = NULL;
static void *ni_job_arg = NULL;
#ifdef NI_ASAN
static void *ni_node_fake = NULL;
static const void *ni_caller_bottom = NULL;
static size_t ni_caller_size = 0;
#endif

static void ni_trampoline(void) {
  for (;;) {
#ifdef NI_ASAN
    __sanitizer_finish_switch_fiber(ni_node_fake, &ni_caller_bottom, &ni_caller_size);
#endif
    ni_job(ni_job_arg);
#ifdef NI_ASAN
    __sanitizer_start_switch_fiber(&ni_node_fake, ni_caller_bottom, ni_caller_size);
#endif
    swapcontext(&ni_node_ctx, &ni_caller_ctx);
  }
}

static uintptr_t ni_stack_start(void) {
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  return ni_stack != NULL && sp >= (uintptr_t)ni_stack && sp < (uintptr_t)ni_stack + NI_STACK
             ? (uintptr_t)ni_stack + NI_STACK
             : 0;
}

/* Runs job(arg) on Node's stack (directly when already there). */
static void ni_on_node_stack(void (*job)(void *), void *arg) {
  if (ni_on_stack) {
    job(arg);
    return;
  }
  if (ni_stack == NULL) {
    ni_stack = mmap(NULL, NI_STACK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (ni_stack == MAP_FAILED) ni_oom();
    (void)mprotect(ni_stack, NI_GUARD, PROT_NONE);
#ifdef NI_ASAN
    if (__lsan_register_root_region) __lsan_register_root_region(ni_stack, NI_STACK);
#endif
    if (getcontext(&ni_node_ctx) != 0) scr_trap("scriptc: getcontext failed\n");
    ni_node_ctx.uc_stack.ss_sp = ni_stack + NI_GUARD;
    ni_node_ctx.uc_stack.ss_size = NI_STACK - NI_GUARD;
    ni_node_ctx.uc_link = NULL;
    makecontext(&ni_node_ctx, ni_trampoline, 0);
  }
  ni_job = job;
  ni_job_arg = arg;
  ni_on_stack = true;
  uintptr_t guard = scr_stack_guard;
  SCR_STACK_GUARD_SET(scr_stack_guard_for((uintptr_t)(ni_stack + NI_GUARD), NI_STACK - NI_GUARD));
#ifdef NI_ASAN
  void *caller_fake = NULL;
  __sanitizer_start_switch_fiber(&caller_fake, ni_stack + NI_GUARD, NI_STACK - NI_GUARD);
#endif
  swapcontext(&ni_caller_ctx, &ni_node_ctx);
#ifdef NI_ASAN
  const void *bottom;
  size_t size;
  __sanitizer_finish_switch_fiber(caller_fake, &bottom, &size);
#endif
  SCR_STACK_GUARD_SET(guard);
  ni_on_stack = false;
}

typedef struct {
  const char *bootstrap, *argv0;
  char *error;
} NiStart;

static void ni_start_job(void *p) {
  NiStart *a = p;
  /* JavaScript may use Node's stack down to a reserve above its guard page
   * (native frames below V8's limit, the runtime's stack guard). */
  uintptr_t limit = (uintptr_t)(ni_stack + NI_GUARD) + NI_STACK / 8;
  a->error = ni_bridge->start(&ni_host, a->bootstrap, a->argv0, limit);
}

typedef struct {
  uint32_t id;
  int sync;
  const char *file, *specifier, *name, *args;
  size_t args_len, len;
  char *outcome;
} NiCall;

static void ni_call_job(void *p) {
  NiCall *a = p;
  a->outcome =
      ni_bridge->call(a->id, a->sync, a->file, a->specifier, a->name, a->args, a->args_len, &a->len);
}

static void ni_pump_job(void *p) {
  (void)p;
  ni_bridge->pump();
}

static void ni_stop_job(void *p) {
  (void)p;
  ni_bridge->stop();
}

static void ni_finish_job(void *p) {
  NiFinish *a = p;
  a->code = ni_bridge->finish(a->code);
}

/* ── loading Node ─────────────────────────────────────────────────────── */

static void ni_start(void) {
  if (ni_bridge != NULL) return;
  const char *dir = ni_pack_dir();
  ni_open_modules();
  char path[4352];
  int written = snprintf(path, sizeof path, "%s/%s", dir, NI_BRIDGE_FILE);
  if (written < 0 || (size_t)written >= sizeof path)
    ni_fatal("scriptc: the libnode pack path is too long\n");
  /* RTLD_GLOBAL: native addons resolve napi_* and node::* from the global
   * namespace. The executable exports no symbols libnode could bind to. */
  void *library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (library == NULL) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: cannot load Node.js for this program's Node islands: %s\n", dlerror());
    ni_fatal(message);
  }
  const ScrNodeBridge *(*entry)(void) =
      (const ScrNodeBridge *(*)(void))dlsym(library, SCR_NODE_BRIDGE_ENTRY);
  const ScrNodeBridge *bridge = entry != NULL ? entry() : NULL;
  if (bridge == NULL || bridge->abi != SCR_NODE_BRIDGE_ABI) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: the libnode pack at %s has an incompatible bridge (ABI %u; this program "
             "needs %u)\n",
             dir, bridge != NULL ? bridge->abi : 0u, SCR_NODE_BRIDGE_ABI);
    ni_fatal(message);
  }
  if (ni_node_version != NULL && ni_node_version[0] != '\0' &&
      strcmp(bridge->node_version, ni_node_version) != 0) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: this program's Node islands need libnode %s; found %s (NODE_MODULE_VERSION "
             "%u) at %s\n",
             ni_node_version, bridge->node_version, bridge->module_version, dir);
    ni_fatal(message);
  }
  ScrStr *self = scr_process_exec_path();
  char argv0[4096];
  snprintf(argv0, sizeof argv0, "%.*s", (int)self->len, self->data);
  scr_str_release(self);
  /* Flush first: Node writes to the same stdout. */
  fflush(stdout);
  ni_bridge = bridge;
  char *bootstrap = ni_bootstrap();
  NiStart start = {bootstrap, argv0, NULL};
  ni_on_node_stack(ni_start_job, &start);
  free(bootstrap);
  char *error = start.error;
  if (error != NULL) {
    char message[8192];
    snprintf(message, sizeof message, "scriptc: cannot start Node.js from %s: %s\n", dir, error);
    bridge->release(error);
    ni_fatal(message);
  }
  scr_atexit(ni_stop_atexit);
  scr_loop_set_node_island(&ni_alive, &ni_pump, &ni_backend_fd, &ni_backend_timeout);
}

/* ── calls ────────────────────────────────────────────────────────────── */

/* The JSON text of the argument array (+1 dyn string), or NULL with the
 * copy's error pending. */
static ScrDyn *ni_args_json(ScrDyn *args) {
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *json = scr_json_stringify_replacer(args, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  if (json != NULL && !scr_exc_pending() && json->kind == SCR_DYN_STR) return json;
  scr_dyn_release(json);
  return NULL;
}

/* A borrowed ScrStr as a NUL-terminated copy for the bridge. */
static char *ni_cstr(const ScrStr *s) { return ni_cstr_of(s->data, s->len); }

static char *ni_call(uint32_t id, bool sync, ScrStr *file, ScrStr *specifier, ScrStr *name,
                     ScrDyn *json, size_t *len) {
  char *f = ni_caller_path(file), *s = ni_cstr(specifier), *n = ni_cstr(name);
  NiCall call = {id, sync ? 1 : 0, f, s, n, json->v.str->data, json->v.str->len, 0, NULL};
  ni_on_node_stack(ni_call_job, &call);
  char *outcome = call.outcome;
  *len = call.len;
  free(f);
  free(s);
  free(n);
  return outcome;
}

/* Node runs on the main thread only: its isolate is entered under the
 * Locker the starting thread holds, and the loader's state and Node's
 * stack are process-wide. A call from a worker thread throws an Error. */
static bool ni_main_thread(void) {
  if (scr_context_is_main()) return true;
  ScrStr *code = scr_str_new("", 0);
  static const char text[] =
      "Node islands run on the main thread only; this call came from a worker thread";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  scr_throw_node_coded(0, code, message);
  scr_str_release(message);
  scr_str_release(code);
  return false;
}

ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  if (!ni_main_thread()) return NULL;
  ScrDyn *json = ni_args_json(args);
  if (json == NULL) return NULL;
  ni_start();
  size_t len = 0;
  char *outcome = ni_call(0, true, file, specifier, name, json, &len);
  scr_dyn_release(json);
  if (outcome == NULL) ni_fatal("scriptc: the libnode bridge answered no outcome\n");
  ScrDyn *result = ni_outcome(outcome, len);
  ni_bridge->release(outcome);
  return result;
}

ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  ScrPromise *p = scr_promise_new();
  if (!ni_main_thread()) {
    scr_promise_reject_pending(p);
    return p;
  }
  ScrDyn *json = ni_args_json(args);
  if (json == NULL) {
    scr_promise_reject_pending(p);
    return p;
  }
  ni_start();
  if (ni_npending == ni_pending_cap) {
    size_t cap = ni_pending_cap ? ni_pending_cap * 2 : 8;
    NiPending *grown = realloc(ni_pending, cap * sizeof *grown);
    if (grown == NULL) ni_oom();
    ni_pending = grown;
    ni_pending_cap = cap;
  }
  uint32_t id = ni_next_id++;
  if (ni_next_id == 0) ni_next_id = 1;
  ni_pending[ni_npending].id = id;
  ni_pending[ni_npending].promise = scr_promise_retain(p);
  ni_npending++;
  size_t len = 0;
  char *outcome = ni_call(id, false, file, specifier, name, json, &len);
  scr_dyn_release(json);
  if (outcome != NULL) ni_bridge->release(outcome);
  return p;
}

#else /* _WIN32 || __wasi__ */

/* Node islands need a libnode pack, which these targets do not have: the
 * compiler refuses them there, so these entry points only report that. */
void scr_node_island_install(const char *libnode, const char *node_version) {
  (void)libnode;
  (void)node_version;
}

void scr_node_island_install_modules(const char *manifest, size_t manifest_len,
                                     const unsigned char *data, size_t data_len,
                                     const char *location) {
  (void)manifest;
  (void)manifest_len;
  (void)data;
  (void)data_len;
  (void)location;
}

SCR_COLD static void ni_unsupported(void) {
  fputs("scriptc: Node islands are not supported on this target\n", stderr);
  fflush(stderr);
  _Exit(1);
}

ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  (void)file;
  (void)specifier;
  (void)name;
  (void)args;
  ni_unsupported();
  return NULL;
}

ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  (void)file;
  (void)specifier;
  (void)name;
  (void)args;
  ni_unsupported();
  return NULL;
}

#endif
