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
 * promise first, because the bridge may settle it before returning.
 *
 * One loop (scope-B NI-3). Right after Node starts, scr_loop_host moves the
 * runtime's pending ticks, promise jobs, timers and immediates onto Node's
 * queues and from then on schedules them there, and the bridge watches the
 * runtime's I/O on Node's libuv loop: there is one loop and one set of
 * queues, so the jobs of both sides interleave as in Node. Calls into
 * JavaScript do not drain queues themselves; the runtime's checkpoints do
 * (the bridge's `checkpoint`, and Node's own after every callback it
 * dispatches).
 *
 * Process state is shared, not mirrored: island listeners for signals and
 * 'exit' join the runtime's registries (scr_events.c) at their position,
 * so the runtime keeps owning every signal disposition; the listeners of
 * the events Node raises itself (uncaughtException, unhandledRejection,
 * warning) are all on Node's `process`, native ones included, and
 * process.exitCode is Node's property, which native code reads and writes
 * (scr_node_island_events.c); Node's process.exit runs the runtime's exit
 * sequence.
 *
 * Node's stack. V8 fixes an isolate's stack limit where it is created, and
 * calls into Node can come from any async fiber (512 KB stacks without a
 * guard page) or from the main stack. Every entry into Node from outside
 * it runs on one dedicated stack of NI_STACK bytes with a guard page,
 * reached by a context switch; the runtime's own stack guard follows it
 * there. Node's loop runs there too once it hosts the runtime's queues, so
 * a runtime job it dispatches may resume an async fiber that calls into
 * Node again from the fiber's stack: the bridge sets V8's limit for the
 * stack each entry comes from (ni_stack_limit). */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_events.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdatomic.h>
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
#include <sys/statvfs.h>
#include <time.h>
#include <ucontext.h>
#include <pthread.h>
#include <time.h>
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
  /* The call, kept until it settles: it is made once more when its module
   * did not load for a file the installed tree had lost (ni_settle). */
  ScrStr *file, *specifier, *name; /* owned */
  ScrDyn *json;                    /* owned */
  size_t repairs; /* files the process had put back when the call was made */
  bool repeated;
} NiPending;

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define NI_ASAN 1
void __sanitizer_start_switch_fiber(void **fake_stack_save, const void *bottom, size_t size);
void __sanitizer_finish_switch_fiber(void *fake_stack_save, const void **bottom_old,
                                     size_t *size_old);
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
void __asan_unpoison_memory_region(void const volatile *addr, size_t size);

/* LeakSanitizer's report at exit, with Node loaded: Node keeps its root
 * certificate stores (the bundled roots, the system's with
 * NODE_USE_SYSTEM_CA, the extra ones of NODE_EXTRA_CA_CERTS) for the
 * process's life and never frees them, and OpenSSL keeps the compression
 * methods it loads with its default library context. Only those loaders
 * are suppressed; a leak anywhere else, in libnode or in the program,
 * still reports. */
__attribute__((used)) const char *__lsan_default_suppressions(void) {
  return "leak:node::crypto::LoadCACertificates\n"
         "leak:node::crypto::GetBundledRootCertificates\n"
         "leak:node::crypto::LoadSystemCACertificates\n"
         "leak:node::crypto::GetExtraCACertificates\n"
         "leak:ossl_load_builtin_compressions\n";
}

/* Without the table of suppressions used, which LeakSanitizer otherwise
 * prints to stderr at every exit (LSAN_OPTIONS still overrides it). */
__attribute__((used)) const char *__lsan_default_options(void) { return "print_suppressions=0"; }
#endif
#endif

#define NI_STACK ((size_t)64 * 1024 * 1024)
#define NI_GUARD ((size_t)64 * 1024)

static const char *ni_libnode = NULL;      /* recorded pack directory */
static const char *ni_node_version = NULL; /* recorded Node version */
static const ScrNodeBridge *ni_bridge = NULL;
/* Node's start completed on the island's thread (ni_start's tail). */
static atomic_bool ni_started;
static char ni_dir[4096];
static uint32_t ni_next_id = 1;
static NiPending *ni_pending = NULL;
static size_t ni_npending = 0, ni_pending_cap = 0;

void scr_node_island_install(const char *libnode, const char *node_version) {
  /* The entry of every script thread records the same constants. The
   * island's thread did before any other thread existed, and it reads them
   * while a worker starts: a worker's entry writes nothing. */
  if (!scr_ni_main_thread()) return;
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
  scr_stdout_settle();
  fflush(stdout);
  fputs(message, stderr);
  fflush(stderr);
  _Exit(1);
}

/* SCRIPTC_NODE_ISLANDS_TRACE=boot: what starting Node does, on stderr. */
static bool ni_tracing(void) {
  static int tracing = -1;
  if (tracing < 0) {
    const char *trace = getenv("SCRIPTC_NODE_ISLANDS_TRACE");
    tracing = trace != NULL && strstr(trace, "boot") != NULL;
  }
  return tracing == 1;
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
 * the links between package directories, and the tree's name (the digest
 * the build took of the files and links). Before Node loads anything, the
 * tree is made available at one directory, and every file is checked against
 * the manifest:
 * - beside the executable (`--libnode=beside`), at the recorded `$ORIGIN/`
 *   path, checked on every start;
 * - otherwise from the executable itself, extracted once into
 *   $XDG_CACHE_HOME/scriptc/node-islands/<manifest digest>/ (or
 *   ~/.cache/...), checked on every start; when that directory cannot be
 *   used, into a private directory under $TMPDIR removed at exit.
 * Node's compile cache for the tree sits beside it in the same directory
 * (see "Node's compile cache" below).
 * Directories are created 0700 and owned by the process's user; no link is
 * followed below the cache directory. A process with elevated privileges
 * refuses the tree, as it refuses SCRIPTC_LIBNODE. A call names its module
 * by its path relative to the tree.
 *
 * What a start does. An installed tree is used as it is: the start reads
 * the tree's name, which the build took and wrote first in the manifest
 * (ni_read_tree_name), opens the directory of that name and checks that it
 * is the user's own. No work grows with the number or size of the files a
 * program ships, and the manifest is parsed only to install or repair.
 * - Install: the tree is extracted into a staging directory beside its
 *   place (every write checked), flushed to disk (ni_flush) and then
 *   renamed to its name. A directory of that name therefore held every
 *   byte when it appeared, also after a power loss. The bytes are the
 *   executable's own, so they are not hashed again on their way out.
 * - Repair: when Node fails to find a file of the tree (a tool removed it),
 *   the error reaches the program through scr_node_island_handle.c, which
 *   asks for scr_ni_tree_repair: every file the manifest lists and the
 *   tree lacks is written back from the executable's bytes, one line on
 *   stderr says so, and a module load is repeated once.
 * - A file someone modified is used as it is, as a file under node_modules
 *   is. Code running as the same user can replace the executable too, so
 *   no check here would be a boundary against it.
 * - Beside the executable the build writes the tree's name next to the
 *   modules directory (`<modules>.tree`). A start compares it; when it is
 *   absent or names another tree (a modules directory left from another
 *   build), the content is hashed against the manifest and a tree that
 *   differs is refused. */
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
  if (!scr_ni_main_thread()) return; /* as scr_node_island_install */
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

/* The tree's name: 64 hexadecimal digits, the SHA-256 the build took of
 * the manifest's files and links (node-islands/modules.ts). Empty when the
 * manifest carries none; the runtime then hashes the manifest itself. */
static char ni_tree_name[65] = "";

static bool ni_tree_name_set(const char *hex, size_t len) {
  if (len != 64) return false;
  for (size_t i = 0; i < 64; i++)
    if (ni_hex(hex[i]) < 0) return false;
  memcpy(ni_tree_name, hex, 64);
  ni_tree_name[64] = '\0';
  return true;
}

/* ── the manifest as the build writes it ──────────────────────────────────
 * `{"tree":"<name>","files":[["<path>",<size>,"<sha256>"],...],"links":
 * [["<path>","<target>"],...]}`, without white space, read in one pass
 * straight into the file and link tables: a program ships thousands of
 * files, and every start that loads Node reads this. Any other JSON text
 * (white space, another key order, a string with an escape: a path with a
 * quote, a backslash or a control character) is left to the JSON parser
 * (ni_manifest_ready), which accepts the same documents. */
typedef struct {
  const char *p, *end;
  char *names; /* where the next string is copied, NUL-terminated */
} NiScan;

static bool ni_scan_lit(NiScan *s, const char *lit) {
  size_t n = strlen(lit);
  if ((size_t)(s->end - s->p) < n || memcmp(s->p, lit, n) != 0) return false;
  s->p += n;
  return true;
}

/* A string without escapes: the copy, or NULL. */
static char *ni_scan_str(NiScan *s, size_t *len) {
  if (s->p >= s->end || *s->p != '"') return NULL;
  const char *start = ++s->p;
  while (s->p < s->end && *s->p != '"') {
    unsigned char c = (unsigned char)*s->p;
    if (c == '\\' || c < 0x20) return NULL;
    s->p++;
  }
  if (s->p >= s->end) return NULL;
  *len = (size_t)(s->p++ - start);
  char *copy = s->names;
  memcpy(copy, start, *len);
  copy[*len] = '\0';
  s->names += *len + 1;
  return copy;
}

/* At most how many elements the array of arrays at the cursor has: its
 * opening brackets up to the `]]` that ends it. */
static size_t ni_scan_count(const NiScan *s) {
  size_t n = 0;
  bool in_string = false;
  for (const char *p = s->p; p < s->end; p++) {
    if (*p == '"') in_string = !in_string;
    else if (!in_string && *p == '[') n++;
    else if (!in_string && *p == ']' && p + 1 < s->end && p[1] == ']') break;
  }
  return n;
}

static bool ni_scan_manifest(void) {
  char *names = malloc(ni_manifest_len + 1);
  if (names == NULL) ni_oom();
  NiScan s = {ni_manifest, ni_manifest + ni_manifest_len, names};
  NiFile *files = NULL;
  NiLink *links = NULL;
  size_t nfiles = 0, nlinks = 0, offset = 0, len;
  bool ok = ni_scan_lit(&s, "{\"tree\":");
  char *tree = ok ? ni_scan_str(&s, &len) : NULL;
  ok = tree != NULL && len == 64 && ni_scan_lit(&s, ",\"files\":[");
  size_t capacity = ok ? ni_scan_count(&s) : 0;
  if (ok) {
    files = calloc(capacity + 1, sizeof *files);
    if (files == NULL) ni_oom();
  }
  while (ok && s.p < s.end && *s.p == '[' && nfiles < capacity) {
    NiFile *f = &files[nfiles];
    s.p++;
    f->path = ni_scan_str(&s, &len);
    ok = f->path != NULL && ni_relative_inside(f->path) && ni_scan_lit(&s, ",");
    size_t size = 0, digits = 0;
    for (; ok && s.p < s.end && *s.p >= '0' && *s.p <= '9' && digits < 18; s.p++, digits++)
      size = size * 10 + (size_t)(*s.p - '0');
    char *digest = ok && digits > 0 && ni_scan_lit(&s, ",") ? ni_scan_str(&s, &len) : NULL;
    ok = digest != NULL && len == 64 && ni_scan_lit(&s, "]");
    for (int b = 0; ok && b < 32; b++) {
      int hi = ni_hex(digest[b * 2]), lo = ni_hex(digest[b * 2 + 1]);
      ok = hi >= 0 && lo >= 0;
      f->sha256[b] = (unsigned char)(hi * 16 + lo);
    }
    if (!ok) break;
    f->size = size;
    f->offset = offset;
    offset += size;
    nfiles++;
    if (s.p < s.end && *s.p == ',') s.p++;
  }
  ok = ok && ni_scan_lit(&s, "],\"links\":[");
  capacity = ok ? ni_scan_count(&s) : 0;
  if (ok) {
    links = calloc(capacity + 1, sizeof *links);
    if (links == NULL) ni_oom();
  }
  while (ok && s.p < s.end && *s.p == '[' && nlinks < capacity) {
    NiLink *l = &links[nlinks];
    s.p++;
    l->path = ni_scan_str(&s, &len);
    ok = l->path != NULL && ni_scan_lit(&s, ",");
    l->target = ok ? ni_scan_str(&s, &len) : NULL;
    ok = l->target != NULL && ni_scan_lit(&s, "]") && ni_relative_inside(l->path) &&
         ni_link_inside(l->path, l->target);
    if (!ok) break;
    nlinks++;
    if (s.p < s.end && *s.p == ',') s.p++;
  }
  ok = ok && ni_scan_lit(&s, "]}") && s.p == s.end &&
       (ni_modules == NULL || offset == ni_modules_len) && ni_tree_name_set(tree, 64);
  if (!ok) {
    free(files);
    free(links);
    free(names);
    return false;
  }
  ni_files = files;
  ni_nfiles = nfiles;
  ni_links = links;
  ni_nlinks = nlinks;
  return true;
}

/* The tree's name without reading the tables: the manifest's first field
 * as the build writes it. A manifest in another form is parsed, and one
 * without a name is hashed, as trees were named before the build took the
 * digest. */
static void ni_manifest_ready(void);
static void ni_read_tree_name(void) {
  static const char head[] = "{\"tree\":\"";
  size_t n = sizeof head - 1;
  if (ni_tree_name[0] != '\0') return;
  if (ni_manifest_len > n + 65 && memcmp(ni_manifest, head, n) == 0 &&
      ni_manifest[n + 64] == '"' && ni_tree_name_set(ni_manifest + n, 64))
    return;
  ni_manifest_ready();
  if (ni_tree_name[0] != '\0') return;
  NiSha256 s;
  unsigned char digest[32];
  ni_sha256_init(&s);
  ni_sha256_update(&s, (const unsigned char *)ni_manifest, ni_manifest_len);
  ni_sha256_final(&s, digest);
  for (int i = 0; i < 32; i++) snprintf(ni_tree_name + i * 2, 3, "%02x", digest[i]);
}

/* The file and link tables, read from the manifest on first need: a start
 * that finds the tree installed never needs them. */
static void ni_manifest_ready(void) {
  static bool ready = false;
  if (ready) return;
  ready = true;
  if (ni_scan_manifest()) return;
  ScrStr *text = scr_str_new(ni_manifest, ni_manifest_len);
  ScrDyn *body = scr_json_parse(text);
  scr_str_release(text);
  if (body == NULL || body->kind != SCR_DYN_OBJ) ni_bad_manifest();
  ScrDyn *tree = scr_dyn_obj_get(body, "tree", 4);
  if (tree != NULL &&
      (tree->kind != SCR_DYN_STR || !ni_tree_name_set(tree->v.str->data, tree->v.str->len)))
    ni_bad_manifest();
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

/* The directories on the way to one file of the tree, kept open while the
 * next file lies below them. The manifest lists files sorted by path, so a
 * pass over it opens each directory once instead of once per file below
 * it. No link is followed. */
#define NI_WALK_DEPTH 64
typedef struct {
  int rootfd;
  int fds[NI_WALK_DEPTH];
  size_t ends[NI_WALK_DEPTH]; /* in `path`: the offset of the `/` after each open directory */
  size_t depth;
  const char *path; /* the file whose directories are open */
} NiWalk;

static void ni_walk_begin(NiWalk *w, int rootfd) {
  w->rootfd = rootfd;
  w->depth = 0;
  w->path = NULL;
}

static void ni_walk_end(NiWalk *w) {
  while (w->depth > 0) close(w->fds[--w->depth]);
}

/* The open parent directory of the relative `path` (its last component is
 * left in *base), created when `create`; -1 when it cannot be opened. The
 * descriptor stays the walk's. */
static int ni_walk_parent(NiWalk *w, const char *path, bool create, const char **base) {
  size_t keep = 0;
  while (keep < w->depth && strncmp(path, w->path, w->ends[keep]) == 0 &&
         path[w->ends[keep]] == '/')
    keep++;
  while (w->depth > keep) close(w->fds[--w->depth]);
  w->path = path;
  const char *p = path + (keep > 0 ? w->ends[keep - 1] + 1 : 0);
  for (const char *slash; (slash = strchr(p, '/')) != NULL; p = slash + 1) {
    char component[256];
    size_t n = (size_t)(slash - p);
    if (n >= sizeof component || w->depth == NI_WALK_DEPTH) return -1;
    memcpy(component, p, n);
    component[n] = '\0';
    int fd = ni_dir_at(w->depth > 0 ? w->fds[w->depth - 1] : w->rootfd, component, create);
    if (fd < 0) return -1;
    w->fds[w->depth] = fd;
    w->ends[w->depth] = (size_t)(slash - path);
    w->depth++;
  }
  *base = p;
  return w->depth > 0 ? w->fds[w->depth - 1] : w->rootfd;
}

/* Whether the tree below `rootfd` has the manifest's links. */
static bool ni_links_match(int rootfd) {
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

/* Whether the tree below `rootfd` holds exactly the manifest's files (by
 * size and digest) and links: the check of a tree the build placed beside
 * the executable when its name file does not vouch for it. */
static bool ni_tree_matches(int rootfd) {
  if (ni_tracing())
    fprintf(stderr, "[node-islands] hashing the module tree (%zu files)\n", ni_nfiles);
  NiWalk walk;
  ni_walk_begin(&walk, rootfd);
  bool ok = true;
  for (size_t i = 0; i < ni_nfiles && ok; i++) {
    const char *base;
    int dirfd = ni_walk_parent(&walk, ni_files[i].path, false, &base);
    int fd = dirfd < 0 ? -1 : openat(dirfd, base, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ||
        (size_t)st.st_size != ni_files[i].size) {
      if (fd >= 0) close(fd);
      ok = false;
      break;
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
    ok = total == ni_files[i].size && memcmp(got, ni_files[i].sha256, 32) == 0;
  }
  ni_walk_end(&walk);
  return ok && ni_links_match(rootfd);
}

/* Makes what was written below `fd`'s directory durable: the file system
 * it is on where the platform can flush one (Linux), else every one. */
#if defined(__linux__) && !defined(__ANDROID__)
extern int syncfs(int fd);
#endif
static bool ni_flush(int fd) {
#if defined(__linux__) && !defined(__ANDROID__)
  return syncfs(fd) == 0;
#else
  (void)fd;
  sync();
  return true;
#endif
}

/* Writes the executable's tree below `rootfd` (an empty directory); false
 * when a directory, file or link could not be written in full. */
static bool ni_extract(int rootfd) {
  if (ni_modules == NULL && ni_nfiles > 0) ni_bad_manifest();
  NiWalk walk;
  ni_walk_begin(&walk, rootfd);
  bool ok = true;
  for (size_t i = 0; i < ni_nfiles && ok; i++) {
    const unsigned char *data = ni_modules + ni_files[i].offset;
    const char *base;
    int dirfd = ni_walk_parent(&walk, ni_files[i].path, true, &base);
    int fd = dirfd < 0
                 ? -1
                 : openat(dirfd, base, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
      ok = false;
      break;
    }
    size_t done = 0;
    while (done < ni_files[i].size) {
      ssize_t n = write(fd, data + done, ni_files[i].size - done);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) break;
      done += (size_t)n;
    }
    ok = close(fd) == 0 && done == ni_files[i].size;
  }
  ni_walk_end(&walk);
  if (!ok) return false;
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

/* Whether ni_root is the installed tree in the cache directory, which the
 * runtime may repair (scr_ni_tree_repair). */
static bool ni_root_installed = false;

/* Whether the file the build wrote next to a beside tree (`<modules>.tree`)
 * names this program's tree. */
static bool ni_beside_named(void) {
  char path[4200];
  int n = snprintf(path, sizeof path, "%s.tree", ni_root);
  if (n <= 0 || (size_t)n >= sizeof path) return false;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  char name[66];
  ssize_t got = read(fd, name, sizeof name);
  close(fd);
  return got >= 64 && memcmp(name, ni_tree_name, 64) == 0 && (got == 64 || name[64] == '\n');
}

/* The per-user directory the trees are installed in,
 * $XDG_CACHE_HOME/scriptc/node-islands (or ~/.cache/scriptc/node-islands),
 * created 0700 when absent: its descriptor, with the cache home's path in
 * `base`. -1 when there is no home, or when `scriptc` or `node-islands` is
 * reached through a link, belongs to another user or can be written by
 * anyone else. Everything the runtime keeps for a program's island lives in
 * this one directory (the tree, and Node's compile cache for it). */
static int ni_islands_dir(char base[4096]) {
  const char *xdg = getenv("XDG_CACHE_HOME");
  const char *home = getenv("HOME");
  int n;
  if (xdg != NULL && xdg[0] == '/')
    n = snprintf(base, 4096, "%s", xdg);
  else if (home != NULL && home[0] == '/')
    n = snprintf(base, 4096, "%s/.cache", home);
  else
    return -1;
  if (n <= 0 || (size_t)n >= 4096) return -1;
  (void)mkdir(base, 0700);
  int basefd = open(base, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (basefd < 0) return -1;
  int scriptc = ni_dir_at(basefd, "scriptc", true);
  close(basefd);
  int islands = ni_private_dir(scriptc) ? ni_dir_at(scriptc, "node-islands", true) : -1;
  if (scriptc >= 0) close(scriptc);
  if (!ni_private_dir(islands)) {
    if (islands >= 0) close(islands);
    return -1;
  }
  return islands;
}

static void ni_compile_cache_open(int islands, const char *base);

/* The tree in the cache directory, extracted there when absent. */
static bool ni_cached_root(const char *digest) {
  char base[4096];
  int islands = ni_islands_dir(base);
  if (islands < 0) return false;
  bool ok = false;
  int tree = ni_dir_at(islands, digest, false);
  if (tree < 0 && errno == ENOENT) {
    /* Install: extract into a fresh sibling, make it durable, then move it
     * into place. */
    if (ni_tracing()) fprintf(stderr, "[node-islands] installing the module tree\n");
    ni_manifest_ready();
    char staging[128];
    snprintf(staging, sizeof staging, "%s.%ld.tmp", digest, (long)getpid());
    int fd = ni_dir_at(islands, staging, true);
    if (ni_private_dir(fd) && ni_extract(fd) && ni_flush(fd) &&
        renameat(islands, staging, islands, digest) == 0) {
      close(fd);
      tree = ni_dir_at(islands, digest, false);
    } else {
      if (fd >= 0) ni_remove_below(fd);
      (void)unlinkat(islands, staging, AT_REMOVEDIR);
      tree = ni_dir_at(islands, digest, false); /* another process may have placed it */
    }
  }
  /* An installed tree is used as it is (see "What a start does" above). */
  if (ni_private_dir(tree)) {
    ok = ni_set_root(base, "/scriptc/node-islands/", digest);
    ni_root_installed = ok;
  }
  if (tree >= 0) close(tree);
  if (ok) ni_compile_cache_open(islands, base);
  close(islands);
  return ok;
}

/* ── repair ───────────────────────────────────────────────────────────── */

/* Written on the island's thread; a worker thread reads it around its own
 * synchronous call (K4), so the count is atomic. */
static atomic_size_t ni_repaired = 0;

size_t scr_ni_tree_repairs(void) { return ni_repaired; }

static bool ni_text_has(const char *text, size_t len, const char *part) {
  size_t n = strlen(part);
  for (size_t i = 0; n > 0 && i + n <= len; i++)
    if (text[i] == part[0] && memcmp(text + i, part, n) == 0) return true;
  return false;
}

/* Whether `text` (an error's message or stack) names the installed tree,
 * by the path the runtime gave Node or by the path Node resolved it to
 * (a cache directory reached through a link). */
bool scr_ni_tree_named(const char *text, size_t len) {
  static char resolved[4096] = "";
  static bool looked = false;
  if (!ni_root_installed) return false;
  if (ni_text_has(text, len, ni_root)) return true;
  if (!looked) {
    looked = true;
    char *real = realpath(ni_root, NULL);
    if (real != NULL && strlen(real) < sizeof resolved && strcmp(real, ni_root) != 0)
      strcpy(resolved, real);
    free(real);
  }
  return ni_text_has(text, len, resolved);
}

/* Writes back every file and link the manifest lists and the installed
 * tree lacks, from the executable's bytes, each through a temporary name
 * and a rename so that no reader sees part of a file. Once per process:
 * a tree that loses files while the program runs is repaired by the next
 * one. A file that is present is left as it is. */
void scr_ni_tree_repair(void) {
  static bool done = false;
  if (done || !ni_root_installed || ni_modules == NULL) return;
  done = true;
  ni_manifest_ready();
  int rootfd = open(ni_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (!ni_private_dir(rootfd)) {
    if (rootfd >= 0) close(rootfd);
    return;
  }
  size_t restored = 0;
  NiWalk walk;
  ni_walk_begin(&walk, rootfd);
  char temporary[64];
  snprintf(temporary, sizeof temporary, ".scriptc-repair.%ld.tmp", (long)getpid());
  for (size_t i = 0; i < ni_nfiles; i++) {
    const char *base;
    int dirfd = ni_walk_parent(&walk, ni_files[i].path, true, &base);
    struct stat st;
    if (dirfd < 0 || fstatat(dirfd, base, &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)
      continue;
    int fd = openat(dirfd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) continue;
    const unsigned char *data = ni_modules + ni_files[i].offset;
    size_t written = 0;
    while (written < ni_files[i].size) {
      ssize_t n = write(fd, data + written, ni_files[i].size - written);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) break;
      written += (size_t)n;
    }
    if (close(fd) == 0 && written == ni_files[i].size &&
        renameat(dirfd, temporary, dirfd, base) == 0)
      restored++;
    else
      (void)unlinkat(dirfd, temporary, 0);
  }
  ni_walk_end(&walk);
  for (size_t i = 0; i < ni_nlinks; i++) {
    const char *base;
    int dirfd = ni_parent_at(rootfd, ni_links[i].path, true, &base);
    if (dirfd < 0) continue;
    struct stat st;
    if (fstatat(dirfd, base, &st, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT &&
        symlinkat(ni_links[i].target, dirfd, base) == 0)
      restored++;
    close(dirfd);
  }
  close(rootfd);
  if (restored == 0) return;
  ni_repaired += restored;
  scr_stdout_settle();
  fflush(stdout);
  fprintf(stderr, "scriptc: reinstalled %zu Node island module file%s missing from %s\n", restored,
          restored == 1 ? "" : "s", ni_root);
  fflush(stderr);
}

static void ni_on_node_stack(void (*job)(void *), void *arg);

typedef struct {
  const char *code, *message, *stack;
  size_t code_len, message_len, stack_len;
} NiLostFile;

static void ni_lost_file_job(void *p) {
  const NiLostFile *e = p;
  if (e->code != NULL && scr_ni_missing_file_code(e->code, e->code_len) &&
      ((e->message != NULL && scr_ni_tree_named(e->message, e->message_len)) ||
       (e->stack != NULL && scr_ni_tree_named(e->stack, e->stack_len))))
    scr_ni_tree_repair();
}

/* An island error as Node reported it (a text is NULL when absent): when
 * its code says Node did not find a file and its message or stack names
 * the installed tree, what the tree lost is put back. The tree's state
 * (the resolved root, the once-per-process repair, its count) belongs to
 * the island's thread, so an error read on another thread is judged there
 * (K4): the reader waits for the answer like any other island operation. */
void scr_ni_tree_lost_file(const char *code, size_t code_len, const char *message,
                           size_t message_len, const char *stack, size_t stack_len) {
  NiLostFile e = {code, message, stack, code_len, message_len, stack_len};
  if (scr_ni_main_thread()) ni_lost_file_job(&e);
  else ni_on_node_stack(ni_lost_file_job, &e);
}

/* The tree in a private directory of this run, removed at exit. */
static bool ni_temporary_root(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || tmp[0] != '/') tmp = "/tmp";
  int n = snprintf(ni_temp_root, sizeof ni_temp_root, "%s/scriptc-node-islands-XXXXXX", tmp);
  if (n <= 0 || (size_t)n >= sizeof ni_temp_root || mkdtemp(ni_temp_root) == NULL) return false;
  scr_atexit(ni_remove_temp_root);
  int fd = open(ni_temp_root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  ni_manifest_ready();
  bool ok = ni_private_dir(fd) && ni_extract(fd);
  if (fd >= 0) close(fd);
  return ok && ni_set_root(ni_temp_root, "", "");
}

/* ── Node's compile cache ─────────────────────────────────────────────── */

/* Node keeps the bytecode V8 compiled for each module it loads in a
 * directory (module.enableCompileCache), named by the module's path and
 * checked against its source, so a later start compiles nothing an earlier
 * one compiled. Every program with an island module tree gets one beside
 * the tree, named by it: <islands directory>/<tree name>.compile-cache. A
 * rebuilt program has another tree, another path for every module and
 * another directory, so it never reads an older build's entries, and a
 * tree's cache can be removed with the tree.
 *
 * Node checks nothing about the directory: it creates what is missing with
 * mode 0777 and loads any entry it finds whose CRC-32 sums agree, and an
 * entry is code. The runtime therefore vouches for the directory it hands
 * to Node. It is created 0700 inside the islands directory (the user's own,
 * writable by no one else, never reached through a link: ni_islands_dir),
 * opened without following a link, and used only when it is a directory
 * owned by the process's user that no one else can write. Anything else
 * leaves the island without a cache, silently: the cache changes how fast
 * a module loads, never what it does. Node itself is as quiet about a
 * directory it cannot write (a read-only file system) and about an entry
 * that does not match its source, which it compiles again and replaces.
 *
 * The runtime makes no cache
 * - when NODE_COMPILE_CACHE names a directory (the user's own choice, which
 *   Node enables by itself) or NODE_DISABLE_COMPILE_CACHE is set;
 * - for the private $TMPDIR copy of the tree that one run extracts, or for
 *   a program that loads only built-in modules;
 * - when the process's real and effective user or group differ (Node names
 *   its entries by the real user; the checks above are for the effective
 *   one), as for a process with elevated privileges, which gets no tree;
 * - while the directory's file system has no free space: Node leaves an
 *   empty temporary file behind for every entry it fails to write.
 * A program whose island never starts runs none of this: no directory is
 * made and nothing is read.
 *
 * Node writes the entries of newly compiled modules when its environment
 * ends. A normal return ends it (ni_stop_atexit), and so does process.exit()
 * called by island code; process.exit() from native code ends the process
 * with Node still running, so that exit writes them first
 * (ni_process_exit), after the 'exit' listeners and the program's output.
 * The bootstrap also writes them once, a moment after Node started, for a
 * program that only ever ends by a signal (scr_node_island_host.cjs). A
 * write with nothing new touches no file.
 *
 * SCRIPTC_NODE_ISLANDS_TRACE=compile-cache prints the decision and each
 * write on stderr. */
static char ni_compile_cache[4352] = "";
/* Whether Node has a compile cache: the runtime's or NODE_COMPILE_CACHE's. */
static bool ni_compile_cache_on = false;

static bool ni_cache_tracing(void) {
  static int tracing = -1;
  if (tracing < 0) {
    const char *trace = getenv("SCRIPTC_NODE_ISLANDS_TRACE");
    tracing = trace != NULL && strstr(trace, "compile-cache") != NULL;
  }
  return tracing == 1;
}

/* The island runs without a compile cache of the runtime's. */
static void ni_compile_cache_none(const char *why) {
  if (ni_cache_tracing()) fprintf(stderr, "[node-islands] compile cache: none (%s)\n", why);
}

/* Decides the island's compile cache once its tree is in place. `islands`
 * is the open islands directory with the cache home's path in `base`, or -1
 * when the tree is not installed there (beside the executable): the
 * directory is then opened only if the runtime's own cache is wanted. */
static void ni_compile_cache_open(int islands, const char *base) {
  const char *user = getenv("NODE_COMPILE_CACHE");
  if (getenv("NODE_DISABLE_COMPILE_CACHE") != NULL) {
    ni_compile_cache_none("NODE_DISABLE_COMPILE_CACHE is set");
    return;
  }
  if (getuid() != geteuid() || getgid() != getegid()) {
    ni_compile_cache_none("the process's real and effective user or group differ");
    return;
  }
  if (user != NULL && user[0] != '\0') {
    ni_compile_cache_on = true;
    if (ni_cache_tracing()) fprintf(stderr, "[node-islands] compile cache: NODE_COMPILE_CACHE's\n");
    return;
  }
  char home[4096];
  int opened = islands < 0 ? ni_islands_dir(home) : -1;
  if (islands < 0) {
    islands = opened;
    base = home;
  }
  int n = islands < 0 ? 0
                      : snprintf(ni_compile_cache, sizeof ni_compile_cache,
                                 "%s/scriptc/node-islands/%s.compile-cache", base, ni_tree_name);
  if (n <= 0 || (size_t)n >= sizeof ni_compile_cache) {
    if (opened >= 0) close(opened);
    ni_compile_cache[0] = '\0';
    ni_compile_cache_none("this user has no private cache directory");
    return;
  }
  int fd = ni_dir_at(islands, strrchr(ni_compile_cache, '/') + 1, true);
  bool mine = ni_private_dir(fd);
  /* Node leaves an empty temporary file behind for every entry it fails to
   * write, at every launch: no cache while there is no room for one. */
  struct statvfs room;
  bool full = mine && fstatvfs(fd, &room) == 0 && room.f_bavail == 0;
  if (fd >= 0) close(fd);
  if (opened >= 0) close(opened);
  ni_compile_cache_on = mine && !full;
  if (ni_cache_tracing()) {
    if (ni_compile_cache_on)
      fprintf(stderr, "[node-islands] compile cache: %s\n", ni_compile_cache);
    else
      fprintf(stderr, "[node-islands] compile cache: none (%s %s)\n", ni_compile_cache,
              full ? "is on a file system with no free space"
                   : "cannot be made, or is not a directory of this user's own that no one else "
                     "can write");
  }
  if (!ni_compile_cache_on) ni_compile_cache[0] = '\0';
}

/* Makes the tree available and sets ni_root; fatal when it cannot. */
static void ni_open_modules(void) {
  if (ni_manifest == NULL) return; /* only built-in modules */
  if (ni_secure())
    ni_fatal("scriptc: a program running with elevated privileges cannot load Node island "
             "modules\n");
  ni_read_tree_name();
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
    bool ok = fd >= 0 && ni_beside_named();
    if (fd >= 0 && !ok) {
      /* No name beside the modules, or another tree's: the content decides. */
      ni_manifest_ready();
      ok = ni_tree_matches(fd);
    }
    if (fd >= 0) close(fd);
    if (!ok) {
      char message[8192];
      snprintf(message, sizeof message,
               "scriptc: the Node island modules at %s do not match this program\n", ni_root);
      ni_fatal(message);
    }
    ni_compile_cache_open(-1, NULL);
    return;
  }
  if (ni_cached_root(ni_tree_name)) return;
  if (!ni_temporary_root())
    ni_fatal("scriptc: cannot write this program's Node island modules to a private directory\n");
  ni_compile_cache_none("the module tree is this run's own temporary copy");
}

/* A path inside the tree: `<root>/<relative path>`. */
static char *ni_tree_path(const char *relative, size_t len) {
  size_t root = strlen(ni_root);
  bool slash = root > 0 && ni_root[root - 1] == '/';
  char *path = malloc(root + 1 + len + 1);
  if (path == NULL) ni_oom();
  memcpy(path, ni_root, root);
  if (!slash) path[root++] = '/';
  memcpy(path + root, relative, len);
  path[root + len] = '\0';
  return path;
}

/* The calling module's path inside the tree. */
static char *ni_caller_path(const ScrStr *relative) {
  return ni_tree_path(relative->data, relative->len);
}

/* Appends `text` to the bootstrap as the body of a JavaScript string
 * literal. The caller reserved six bytes per input byte. */
static size_t ni_js_string(char *out, size_t cap, size_t n, const char *text, size_t len) {
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)text[i];
    if (c == '"' || c == '\\')
      n += (size_t)snprintf(out + n, cap - n, "\\%c", c);
    else if (c < 0x20)
      n += (size_t)snprintf(out + n, cap - n, "\\u%04x", c);
    else
      out[n++] = (char)c;
  }
  return n;
}

/* The bootstrap: the tree root for the host's resolution guard and the
 * program's process state Node cannot read for itself (the command line as
 * process.argv has it, scr_process_argv's ["scriptc", argv[0], ...], and
 * whether the exit sequence already began), the compile cache's directory
 * when the runtime made one, then the host script. +1 malloc'd. */
static char *ni_bootstrap(void) {
  size_t host = strlen(scr_node_island_host_js);
  int argc = scr_lib_arg_count();
  size_t argv_bytes = 0;
  /* A malformed byte becomes U+FFFD (three bytes), and an escaped byte six. */
  for (int i = 0; i < argc; i++) argv_bytes += strlen(scr_lib_arg(i)) * 18 + 4;
  size_t cap = 256 + (strlen(ni_root) + strlen(ni_compile_cache)) * 6 + argv_bytes + host;
  char *out = malloc(cap);
  if (out == NULL) ni_oom();
  size_t n = (size_t)snprintf(out, cap, "globalThis.__scriptcNodeIslandRoot = \"");
  n = ni_js_string(out, cap, n, ni_root, strlen(ni_root));
  n += (size_t)snprintf(out + n, cap - n,
                        "\";\nglobalThis.__scriptcNodeIslandProcess = {exiting: %s, argv: [\"scriptc\",",
                        scr_process_exiting() ? "true" : "false");
  for (int i = 0; i < argc; i++) {
    const char *raw = scr_lib_arg(i);
    ScrStr *arg = scr_str_from_utf8_lossy((const uint8_t *)raw, strlen(raw));
    out[n++] = '"';
    n = ni_js_string(out, cap, n, arg->data, arg->len);
    out[n++] = '"';
    out[n++] = ',';
    scr_str_release(arg);
  }
  n += (size_t)snprintf(out + n, cap - n, "]};\n");
  if (ni_compile_cache[0] != '\0') {
    n += (size_t)snprintf(out + n, cap - n, "globalThis.__scriptcNodeIslandCompileCache = \"");
    n = ni_js_string(out, cap, n, ni_compile_cache, strlen(ni_compile_cache));
    n += (size_t)snprintf(out + n, cap - n, "\";\n");
  }
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

/* Whether an island error's code says that Node did not find a file. */
bool scr_ni_missing_file_code(const char *code, size_t len) {
  return (len == 16 && memcmp(code, "MODULE_NOT_FOUND", 16) == 0) ||
         (len == 20 && memcmp(code, "ERR_MODULE_NOT_FOUND", 20) == 0) ||
         (len == 6 && memcmp(code, "ENOENT", 6) == 0);
}

/* The last "T" outcome this thread read was a call whose module failed to
 * load (the host marks it: its function did not run). Per thread: a worker
 * thread reads the outcome of its own synchronous call (K4). */
static SCR_TL bool ni_load_failed = false;

/* Leaves the copied error of a "T" outcome pending. */
static void ni_throw(const char *json, size_t len) {
  ScrStr *text = scr_str_new(json, len);
  ScrDyn *body = scr_json_parse(text);
  scr_str_release(text);
  ni_load_failed = false;
  if (body == NULL) return; /* the parse error is pending */
  ScrDyn *error = scr_dyn_obj_get(body, "error", 5);
  if (error != NULL && error->kind == SCR_DYN_OBJ) {
    ScrDyn *kind = scr_dyn_obj_get(error, "kind", 4);
    ScrDyn *message = scr_dyn_obj_get(error, "message", 7);
    ScrDyn *code = scr_dyn_obj_get(error, "code", 4);
    ScrDyn *load = scr_dyn_obj_get(error, "load", 4);
    ni_load_failed = load != NULL && load->kind == SCR_DYN_BOOL && load->v.b;
    /* Node did not find a file of the installed module tree: what the tree
     * lost is put back, for a repeat of this call when its module had not
     * loaded yet, and for every later one. */
    if (code != NULL && code->kind == SCR_DYN_STR && message != NULL &&
        message->kind == SCR_DYN_STR)
      scr_ni_tree_lost_file(code->v.str->data, code->v.str->len, message->v.str->data,
                            message->v.str->len, NULL, 0);
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

static char *ni_call(uint32_t id, bool sync, ScrStr *file, ScrStr *specifier, ScrStr *name,
                     ScrDyn *json, size_t *len);

static void ni_settle(uint32_t id, const char *outcome, size_t len) {
  for (size_t i = 0; i < ni_npending; i++) {
    if (ni_pending[i].id != id) continue;
    ni_load_failed = false;
    ScrDyn *value = ni_outcome(outcome, len);
    if (value == NULL && ni_load_failed && ni_repaired != ni_pending[i].repairs &&
        !ni_pending[i].repeated) {
      /* The module did not load because the installed tree had lost a
       * file, and files were put back since the call was made (by this
       * outcome, or by that of another call that was pending with it): the
       * call once more, under the same id (its function never ran). */
      scr_caught_release(scr_exc_take());
      ni_pending[i].repeated = true;
      /* The call may settle before it returns, which releases the entry:
       * its strings are held here meanwhile. */
      ScrStr *file = scr_str_retain(ni_pending[i].file);
      ScrStr *specifier = scr_str_retain(ni_pending[i].specifier);
      ScrStr *name = scr_str_retain(ni_pending[i].name);
      ScrDyn *json = scr_dyn_retain(ni_pending[i].json);
      size_t again_len = 0;
      char *again = ni_call(id, false, file, specifier, name, json, &again_len);
      if (again != NULL) ni_bridge->release(again);
      scr_str_release(file);
      scr_str_release(specifier);
      scr_str_release(name);
      scr_dyn_release(json);
      return;
    }
    NiPending done = ni_pending[i];
    ni_pending[i] = ni_pending[--ni_npending];
    if (value != NULL)
      scr_promise_fulfill_ref(done.promise, value, scr_dyn_retain_v, scr_dyn_release_v,
                              scr_dyn_trace_v);
    scr_promise_reject_pending(done.promise); /* no-op unless an error is pending */
    scr_promise_release(done.promise);
    scr_str_release(done.file);
    scr_str_release(done.specifier);
    scr_str_release(done.name);
    scr_dyn_release(done.json);
    return;
  }
}

/* Node's own process.exit is under way (it ran Node's exit work, the
 * compile cache's write included), or Node has stopped. */
static bool ni_node_ending = false;

static void ni_exit(int code) {
  ni_node_ending = true;
  scr_process_exit((double)code);
  /* A code process.exit refuses: exit 1 rather than continue half-way. */
  ni_fatal("");
}

/* An island listener for a process event was added or removed. */
static void ni_listen(uint32_t event, const char *name, uint32_t listener, int add, int once) {
  (void)once; /* Node's once wrapper removes itself through removeListener */
  /* Island listeners deliver through the events unit, which cannot name
   * scr_node_island_emit itself: this unit installs the hook that reaches
   * it (the first island listener is registered here). */
  scr_events_set_island_emit(&scr_node_island_emit);
  if (event == SCR_NODE_EVENT_SIGNAL) {
    if (add) {
      ScrStr *s = scr_str_new(name, strlen(name));
      scr_signal_on_island(s, listener);
      scr_str_release(s);
    } else {
      scr_signal_off_island(listener);
    }
  } else if (event == SCR_NODE_EVENT_EXIT) {
    if (add) scr_process_on_exit_island(listener);
    else scr_process_off_exit_island(listener);
  }
}

/* The start of Node's stack for callers on it (V8's stack-scan bound). */
static uintptr_t ni_stack_start(void);

/* The main thread's stack, for V8's stack limit (ni_stack_limit). */
static uintptr_t ni_main_lo = 0, ni_main_hi = 0;

static void ni_main_stack(void) {
#if defined(__APPLE__)
  pthread_t self = pthread_self();
  ni_main_hi = (uintptr_t)pthread_get_stackaddr_np(self);
  ni_main_lo = ni_main_hi - pthread_get_stacksize_np(self);
#elif defined(__linux__)
  pthread_attr_t attr;
  if (pthread_getattr_np(pthread_self(), &attr) == 0) {
    void *addr = NULL;
    size_t size = 0;
    if (pthread_attr_getstack(&attr, &addr, &size) == 0) {
      ni_main_lo = (uintptr_t)addr;
      ni_main_hi = ni_main_lo + size;
    }
    pthread_attr_destroy(&attr);
  }
#endif
}

static void ni_on_node_stack(void (*job)(void *), void *arg);
static void ni_start(void);
static const ScrNodeBridgeHost ni_host;
#if defined(__APPLE__)
static void ni_pthread_hold(bool hold);
#endif

/* ── island operations on other threads ────────────────────────────────
 * Node runs on the thread that started it: its isolate is entered under
 * the Locker that thread holds, its stack is process-wide, and the island
 * tables and the bridge's own state are not thread-safe. A native worker
 * (or any other thread) that reaches island code therefore posts the
 * operation to the island's thread — the main thread — and blocks until it
 * has run there, exactly as Node's own workers reach the main thread.
 * Every operation already funnels through ni_on_node_stack, so that one
 * seam is where a foreign thread is diverted.
 *
 * The island's thread drains the posted operations from both loop shapes:
 * its own runtime loop before Node starts, and Node's loop afterwards
 * (scr_async.c asks scr_ni_remote_pending/pollfd and calls
 * scr_ni_remote_dispatch). The wake pipe ends a sleep with no timer due,
 * and the pending count keeps a loop that only waits for other work from
 * stalling a caller. */
typedef struct NiRoute {
  struct NiRoute *next;
  void (*job)(void *);
  void *arg;
  pthread_cond_t cond;
  bool taken; /* the island's thread took it off the queue: it runs to its end */
  bool done;
} NiRoute;

/* The operation this thread posted last did not run: the thread was asked
 * to stop before the island's thread took it (ni_route). */
SCR_TL bool scr_ni_unserved = false;

static pthread_mutex_t ni_route_lock = PTHREAD_MUTEX_INITIALIZER;
static NiRoute *ni_route_head = NULL, *ni_route_tail = NULL;
static atomic_size_t ni_route_pending;
static int ni_route_wake[2] = {-1, -1};

static void ni_route_noop(void *p) { (void)p; }

/* (under ni_route_lock) */
static void ni_route_open(void) {
  if (ni_route_wake[0] >= 0) return;
  if (pipe(ni_route_wake) != 0) {
    ni_route_wake[0] = ni_route_wake[1] = -1;
    return;
  }
  for (int i = 0; i < 2; i++) {
    (void)fcntl(ni_route_wake[i], F_SETFD, FD_CLOEXEC);
    int flags = fcntl(ni_route_wake[i], F_GETFL);
    if (flags >= 0) (void)fcntl(ni_route_wake[i], F_SETFL, flags | O_NONBLOCK);
  }
}

/* Runs `job` on the island's thread and returns once it has.
 *
 * A thread that is asked to stop does not wait for an operation the
 * island's thread has not taken. Its owner asked (worker.terminate()), or
 * the process is ending: the main thread then joins its workers and serves
 * nothing any more, so a worker that waited here for its answer was never
 * joined (a worker without a reference that was still calling the island
 * when the main thread's loop ran dry kept the process from ending). The
 * wait therefore looks at the stop request every few milliseconds; when it
 * is set and the operation is still queued, the operation is withdrawn, the
 * thread's termination is made pending as at any checkpoint, and the
 * caller gets no answer (scr_ni_unserved; its out-values keep what it
 * initialized them to). An operation already taken runs to its end. */
#define NI_ROUTE_STOP_POLL_NS 5000000L /* 5 ms */
/* Only a worker thread posts, and only an executable with workers has one. */
#if defined(SCR_WORKERS) && !defined(SCR_LIB)
#define NI_STOP_ASKED() (!scr_context_quiet())
#define NI_STOP_PENDING() ((void)scr_context_checkpoint())
#else
#define NI_STOP_ASKED() false
#define NI_STOP_PENDING() ((void)0)
#endif

static void ni_route(void (*job)(void *), void *arg) {
  scr_ni_unserved = false;
  if (NI_STOP_ASKED()) {
    scr_ni_unserved = true;
    NI_STOP_PENDING();
    return;
  }
  NiRoute request = {NULL, job, arg, {0}, false, false};
  if (pthread_cond_init(&request.cond, NULL) != 0) ni_oom();
  pthread_mutex_lock(&ni_route_lock);
  ni_route_open();
  if (ni_route_tail != NULL) ni_route_tail->next = &request;
  else ni_route_head = &request;
  ni_route_tail = &request;
  atomic_fetch_add_explicit(&ni_route_pending, 1, memory_order_release);
  if (ni_route_wake[1] >= 0) {
    char byte = 1;
    /* A full pipe already holds a wake for the operations queued before
     * this one. */
    (void)write(ni_route_wake[1], &byte, 1);
  }
  while (!request.done) {
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_nsec += NI_ROUTE_STOP_POLL_NS;
    if (until.tv_nsec >= 1000000000L) {
      until.tv_sec++;
      until.tv_nsec -= 1000000000L;
    }
    int waited = pthread_cond_timedwait(&request.cond, &ni_route_lock, &until);
    if (waited != ETIMEDOUT || request.done || request.taken || !NI_STOP_ASKED()) continue;
    /* Asked to stop, and still queued: withdrawn. */
    NiRoute *before = NULL;
    for (NiRoute *at = ni_route_head; at != NULL && at != &request; at = at->next) before = at;
    if (before != NULL) before->next = request.next;
    else ni_route_head = request.next;
    if (ni_route_tail == &request) ni_route_tail = before;
    atomic_fetch_sub_explicit(&ni_route_pending, 1, memory_order_release);
    scr_ni_unserved = true;
    break;
  }
  pthread_mutex_unlock(&ni_route_lock);
  pthread_cond_destroy(&request.cond);
  if (scr_ni_unserved) NI_STOP_PENDING();
}

#if SCR_NI_THREADS
static SCR_TL bool ni_route_serving = false;

bool scr_ni_remote_pending(void) {
  /* Posted operations are the island's thread's work: a worker thread's
   * loop has none of its own to run. */
  if (!scr_ni_main_thread()) return false;
  return atomic_load_explicit(&ni_route_pending, memory_order_acquire) > 0;
}

int scr_ni_remote_pollfd(void) {
  /* The wake fd belongs to the island's thread: another thread's loop has
   * no posted work of its own to wake for. */
  if (!scr_ni_main_thread()) return -1;
  pthread_mutex_lock(&ni_route_lock);
  ni_route_open();
  int fd = ni_route_wake[0];
  pthread_mutex_unlock(&ni_route_lock);
  return fd;
}

/* How the island's thread shares itself with the threads that post to it.
 * A thread it has just answered is no longer blocked, and in a run of
 * island operations it asks again within microseconds. Leaving as soon as
 * the queue is empty would give each such thread one operation per turn of
 * this thread's loop: beside a main thread whose own work fills its turns,
 * a worker's operations then take a main-thread turn each (measured: 2.8 ms
 * an operation, and the repro of the pi crash, 300,000 calls from a worker
 * beside a busy main thread, did not end within a minute). So the dispatch
 * waits a moment for the next operation (NI_ROUTE_GAP_NS) and goes on
 * serving, for at most as long as this thread spent on its own work since
 * the dispatch before (an equal share, between NI_ROUTE_SLICE_MIN_NS and
 * NI_ROUTE_SLICE_MAX_NS). A dispatch that finds nothing posted returns at
 * once and reads no clock. */
#define NI_ROUTE_GAP_NS UINT64_C(100000)         /* 100 us */
#define NI_ROUTE_SLICE_MIN_NS UINT64_C(1000000)  /* 1 ms */
#define NI_ROUTE_SLICE_MAX_NS UINT64_C(20000000) /* 20 ms */
/* When the last dispatch that served an operation ended (0: none has). */
static uint64_t ni_route_left_at = 0;

/* The island's thread: starts Node if it has not started yet, then runs
 * the posted operations (see the sharing rule above). Never re-entered (a
 * served operation may call back into the runtime, whose loop then asks
 * again). */
void scr_ni_remote_dispatch(void) {
  if (!scr_ni_main_thread() || ni_route_serving) return;
  ni_route_serving = true;
  int fd = scr_ni_remote_pollfd();
  if (fd >= 0) {
    char bytes[64];
    while (read(fd, bytes, sizeof bytes) > 0) {
    }
  }
  uint64_t slice_end = 0, gap_end = 0;
  for (;;) {
    NiRoute *request = NULL;
    if (atomic_load_explicit(&ni_route_pending, memory_order_acquire) > 0) {
      pthread_mutex_lock(&ni_route_lock);
      request = ni_route_head;
      if (request != NULL) {
        ni_route_head = request->next;
        if (ni_route_head == NULL) ni_route_tail = NULL;
        request->taken = true;
        atomic_fetch_sub_explicit(&ni_route_pending, 1, memory_order_release);
      }
      pthread_mutex_unlock(&ni_route_lock);
    }
    if (request == NULL) {
      if (slice_end == 0) break; /* nothing was posted */
      /* The thread just answered may be about to ask again. */
      uint64_t now = scr_hrtime_ns();
      if (now >= gap_end || now >= slice_end) break;
      continue;
    }
    if (slice_end == 0) {
      uint64_t now = scr_hrtime_ns();
      uint64_t own = ni_route_left_at != 0 && now > ni_route_left_at ? now - ni_route_left_at : 0;
      if (own < NI_ROUTE_SLICE_MIN_NS) own = NI_ROUTE_SLICE_MIN_NS;
      if (own > NI_ROUTE_SLICE_MAX_NS) own = NI_ROUTE_SLICE_MAX_NS;
      slice_end = now + own;
    }
    /* The posted operation may be the very first island use: Node starts
     * here, on the island's thread, before the operation runs. */
    ni_start();
    ni_on_node_stack(request->job, request->arg);
    pthread_mutex_lock(&ni_route_lock);
    request->done = true;
    pthread_cond_signal(&request->cond);
    pthread_mutex_unlock(&ni_route_lock);
    uint64_t now = scr_hrtime_ns();
    if (now >= slice_end) break; /* what is still posted waits for the next turn */
    gap_end = now + NI_ROUTE_GAP_NS;
  }
  if (slice_end != 0) ni_route_left_at = scr_hrtime_ns();
  ni_route_serving = false;
}
#endif /* SCR_NI_THREADS */

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

/* A context that runs fn on the stack [lo, lo + size), from its top.
 * macOS's makecontext clears the whole stack it is given, which costs a
 * pass over (and commits) every page of it on each call: there it is given
 * only the top slice. The context starts at the same address either way,
 * and its frames grow below the slice as they would anywhere on the
 * stack; nothing reads uc_stack after makecontext, and the stack's bound
 * is the runtime's stack guard (and the guard page), not uc_stack. */
static void ni_make_context(ucontext_t *ctx, char *lo, size_t size, void (*fn)(void)) {
  if (getcontext(ctx) != 0) scr_trap("scriptc: getcontext failed\n");
#if defined(__APPLE__)
  size_t slice = (size_t)64 * 1024;
  if (size > slice) {
    lo += size - slice;
    size = slice;
  }
#endif
  ctx->uc_stack.ss_sp = lo;
  ctx->uc_stack.ss_size = size;
  ctx->uc_link = NULL;
  makecontext(ctx, fn, 0);
#if defined(__APPLE__) && defined(__aarch64__)
  /* getcontext captured the creating stack's frame pointer and macOS's
   * makecontext leaves it in the context, so the stack's outermost frame
   * would link to a frame on another stack. The stack starts empty: its
   * outermost frame has no caller, the link a zeroed stack would give.
   * backtrace, which Node's diagnostic report calls, walks those links;
   * it ends at the top of this stack instead of following the other
   * stack's frames. */
  if (ctx->uc_mcontext != NULL) ctx->uc_mcontext->__ss.__fp = 0;
#endif
}

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

/* Whether `sp` lies on Node's stack. */
static bool ni_stack_has(uintptr_t sp) {
  return ni_stack != NULL && sp > (uintptr_t)ni_stack && sp <= (uintptr_t)ni_stack + NI_STACK;
}

/* The lowest address of Node's stack in use while runtime code Node's
 * frames called runs (a host callback below), 0 outside them: the
 * callback's frame, or lower, where that code switched to a fiber's stack
 * (scr_node_island_leave_stack) and left its own frames live. Runtime code
 * may resume an async fiber there, and the fiber may call into Node again:
 * that entry runs on Node's stack below this mark, so every frame of Node
 * stays on the one stack V8 scans (heap::base::Stack, bounded by
 * ni_stack_start), never on a fiber's stack beyond its bound. */
static uintptr_t ni_mark = 0;

/* Host callbacks run runtime code from Node's frames: each records the
 * mark for its duration. */
#define NI_MARK_BEGIN                                                    \
  uintptr_t ni_saved_mark = ni_mark;                                     \
  do {                                                                   \
    uintptr_t ni_here = (uintptr_t)__builtin_frame_address(0);           \
    if (ni_stack_has(ni_here)) ni_mark = ni_here;                        \
  } while (0)
#define NI_MARK_END (ni_mark = ni_saved_mark)

void scr_node_island_leave_stack(uintptr_t sp) {
  /* Node's stack is the island thread's: another thread's frames are never
   * on it, and the mark is that thread's to read. */
  if (!scr_ni_main_thread()) return;
  if (ni_mark != 0 && ni_stack_has(sp) && sp < ni_mark) ni_mark = sp;
}

/* A nested entry: job(arg) on Node's stack below the mark, from a fiber. */
static void (*ni_nested_job)(void *) = NULL;
static void *ni_nested_arg = NULL;
static ucontext_t *ni_nested_return = NULL;

#ifdef NI_ASAN
static uintptr_t ni_nested_top = 0; /* the nested context's stack top */
#endif

static void ni_nested_trampoline(void) {
#ifdef NI_ASAN
  const void *caller_bottom;
  size_t caller_size;
  uintptr_t top = ni_nested_top;
  __sanitizer_finish_switch_fiber(NULL, &caller_bottom, &caller_size);
#endif
  void (*job)(void *) = ni_nested_job;
  void *arg = ni_nested_arg;
  ucontext_t *back = ni_nested_return;
  job(arg);
#ifdef NI_ASAN
  /* This context ends: no fake stack to keep. Its frame never returns, so
   * the redzones ASan poisoned around this frame's locals would stay in
   * the shadow of Node's stack, where Node's own frames (uninstrumented)
   * later trip over them. Linux's ASan clears a context's stack when it is
   * switched to (its swapcontext interceptor); macOS's has none, so this
   * frame's part of the stack is unpoisoned here. */
  uintptr_t low = ((uintptr_t)__builtin_frame_address(0) - 4096) & ~(uintptr_t)7;
  if (top > low) __asan_unpoison_memory_region((const void *)low, top - low);
  __sanitizer_start_switch_fiber(NULL, caller_bottom, caller_size);
#endif
  setcontext(back);
}

static void ni_on_node_stack_below_mark(void (*job)(void *), void *arg) {
  ucontext_t nested, caller;
  char *lo = ni_stack + NI_GUARD;
  /* Below every live frame of Node's stack: the mark the host callback
   * recorded, or lower where runtime code it ran went deeper before it
   * switched to this fiber (an async call's eager start, a job: the
   * spawner's frame and its saved context are still in use there). Below
   * the red zone and the swap's own frame, 16-byte aligned, as makecontext
   * expects. */
  uintptr_t top = ni_mark;
  if (scr_node_stack_low != 0 && scr_node_stack_low < top) top = scr_node_stack_low;
  uintptr_t hi = (top - 1024) & ~(uintptr_t)15;
  ni_make_context(&nested, lo, hi - (uintptr_t)lo, ni_nested_trampoline);
#ifdef NI_ASAN
  ni_nested_top = hi;
#endif
  ni_nested_job = job;
  ni_nested_arg = arg;
  ni_nested_return = &caller;
  uintptr_t guard = scr_stack_guard;
  SCR_STACK_GUARD_SET(scr_stack_guard_for((uintptr_t)lo, hi - (uintptr_t)lo));
  void *loop_save = scr_loop_nested_enter();
#ifdef NI_ASAN
  void *caller_fake = NULL;
  __sanitizer_start_switch_fiber(&caller_fake, lo, hi - (uintptr_t)lo);
#endif
  swapcontext(&caller, &nested);
#ifdef NI_ASAN
  const void *bottom;
  size_t size;
  __sanitizer_finish_switch_fiber(caller_fake, &bottom, &size);
#endif
  scr_loop_nested_leave(loop_save);
  SCR_STACK_GUARD_SET(guard);
}

/* Runs job(arg) on Node's stack (directly when already there). On any
 * thread but the island's, the job runs on that thread instead, with this
 * one waiting for it (ni_route). */
static void ni_on_node_stack(void (*job)(void *), void *arg) {
  if (!scr_ni_main_thread()) {
    ni_route(job, arg);
    return;
  }
  if (ni_on_stack) {
    if (ni_mark != 0 && !ni_stack_has((uintptr_t)__builtin_frame_address(0)))
      ni_on_node_stack_below_mark(job, arg);
    else
      job(arg);
    return;
  }
  /* Island code is about to run: it sees the current native values of
   * shared exports (NI-6). */
  scr_ni_shared_refresh();
  if (ni_stack == NULL) {
    ni_stack = mmap(NULL, NI_STACK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (ni_stack == MAP_FAILED) ni_oom();
    (void)mprotect(ni_stack, NI_GUARD, PROT_NONE);
    scr_node_stack_has = &ni_stack_has;
#ifdef NI_ASAN
    if (__lsan_register_root_region) __lsan_register_root_region(ni_stack, NI_STACK);
#endif
    ni_make_context(&ni_node_ctx, ni_stack + NI_GUARD, NI_STACK - NI_GUARD, ni_trampoline);
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
#if defined(__APPLE__)
  ni_pthread_hold(true);
#endif
  swapcontext(&ni_caller_ctx, &ni_node_ctx);
#if defined(__APPLE__)
  ni_pthread_hold(false);
#endif
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

#if defined(__APPLE__)
/* V8 takes each thread's stack start (v8::base::Stack, the bound of its
 * conservative stack scan and of its stack limit) from
 * pthread_get_stackaddr_np the first time it asks, and keeps it for the
 * thread's life. On Linux the bridge's definitions of those functions
 * answer for libnode with Node's stack; macOS binds libnode's own calls
 * inside libnode, so they cannot. While a job runs on Node's stack (where
 * V8 first asks, and where every frame of Node runs), the main thread's
 * pthread record names Node's stack instead: its stack address and the
 * bottom pthread_get_stacksize_np derives from it, found by value next
 * to each other in the record and checked through the public accessors.
 * The record is restored when the job returns to the thread's own stack,
 * and asks again on the next one. */
static void **ni_pthread_stack = NULL;
static void *ni_pthread_saved[2];
static int ni_pthread_held = 0; /* jobs holding the record */

static void ni_pthread_stack_enter(uintptr_t start, size_t size) {
  pthread_t self = pthread_self();
  void *addr = pthread_get_stackaddr_np(self);
  void *bottom = (char *)addr - pthread_get_stacksize_np(self);
  void **record = (void **)(void *)self;
  for (size_t i = 0; i + 1 < 64; i++) {
    if (record[i] != addr || record[i + 1] != bottom) continue;
    ni_pthread_saved[0] = record[i];
    ni_pthread_saved[1] = record[i + 1];
    record[i] = (void *)start;
    record[i + 1] = (void *)(start - size);
    if (pthread_get_stackaddr_np(self) == (void *)start) {
      ni_pthread_stack = &record[i];
      return;
    }
    record[i] = ni_pthread_saved[0];
    record[i + 1] = ni_pthread_saved[1];
  }
}

static void ni_pthread_stack_leave(void) {
  if (ni_pthread_stack == NULL) return;
  ni_pthread_stack[0] = ni_pthread_saved[0];
  ni_pthread_stack[1] = ni_pthread_saved[1];
  ni_pthread_stack = NULL;
}

/* The record names the stack the thread runs on. While a job runs on
 * Node's stack that is Node's stack, for the reason above and for the
 * other readers of the record: libc's backtrace() (which Node's
 * diagnostic report calls) checks its own frame against it, and takes the
 * alternate-stack path with bounds of one megabyte per frame otherwise,
 * walking whatever an island frame links to. Nested jobs keep the outer
 * record, which already names this stack. */
static void ni_pthread_hold(bool hold) {
  if (hold) {
    if (ni_pthread_held++ == 0)
      ni_pthread_stack_enter((uintptr_t)ni_stack + NI_STACK, NI_STACK - NI_GUARD);
    return;
  }
  if (ni_pthread_held > 0 && --ni_pthread_held == 0) ni_pthread_stack_leave();
}
#endif

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

/* V8's stack limit for the stack an entry comes from: Node's own stack
 * (a reserve above its guard page), the main thread's (Node's default
 * --stack-size, 984 KiB, below its top), or an async fiber's (the
 * runtime's guard for it: its mapping's start plus the reserve compiled
 * code keeps). */
static uintptr_t ni_stack_limit(void) {
  /* The frame address, not a local's: under ASan's use-after-return
   * detection locals live on a fake stack elsewhere in memory. */
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  if (ni_stack_has(sp)) return (uintptr_t)(ni_stack + NI_GUARD) + NI_STACK / 8;
  if (sp > ni_main_lo && sp <= ni_main_hi) {
    uintptr_t limit = ni_main_hi > 984 * 1024 ? ni_main_hi - 984 * 1024 : 0;
    return limit > ni_main_lo ? limit : ni_main_lo + 64 * 1024;
  }
  if (scr_stack_guard != 0 && scr_stack_guard < sp) return scr_stack_guard;
  return 0;
}

/* The start of Node's stack for callers on it (V8's stack-scan bound). */
static uintptr_t ni_stack_start(void) {
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  return ni_stack_has(sp) ? (uintptr_t)ni_stack + NI_STACK : 0;
}

/* The host callbacks that run runtime code, with the mark recorded. */
static void ni_host_settle(uint32_t id, const char *outcome, size_t len) {
  NI_MARK_BEGIN;
  ni_settle(id, outcome, len);
  NI_MARK_END;
}

static void ni_host_exit(int code) {
  NI_MARK_BEGIN; /* never returns */
  (void)ni_saved_mark;
  ni_exit(code);
}

static void ni_host_run(uint32_t kind, uint32_t token) {
  NI_MARK_BEGIN;
  scr_loop_hosted_run(kind, token);
  scr_ni_shared_refresh();
  NI_MARK_END;
}

static void ni_host_io(void) {
  NI_MARK_BEGIN;
  scr_loop_hosted_io();
  NI_MARK_END;
}

/* V8's reaction job for a promise native code reacted to: the native
 * reactions run inside it (scr_ni_settle_value). */
static void ni_host_settle_value(uint32_t token, int rejected, const ScrNodeValue *value) {
  NI_MARK_BEGIN;
  scr_ni_settle_value(token, rejected, value);
  scr_ni_shared_refresh();
  NI_MARK_END;
}

static void ni_host_microtasks_done(void) {
  NI_MARK_BEGIN;
  scr_loop_hosted_microtasks_done();
  NI_MARK_END;
}

static void ni_host_listen(uint32_t event, const char *name, uint32_t listener, int add,
                           int once) {
  NI_MARK_BEGIN;
  ni_listen(event, name, listener, add, once);
  NI_MARK_END;
}

static const ScrNodeBridgeHost ni_host = {
    &ni_host_settle,
    &ni_host_exit,
    &ni_host_run,
    &scr_loop_hosted_io_state,
    &ni_host_io,
    &ni_host_microtasks_done,
    &ni_host_listen,
    &ni_stack_limit,
    &ni_stack_start,
    &ni_host_settle_value,
    &scr_ni_bytes_free,
    &scr_ni_host_export_call,
    &scr_ni_host_export_construct,
    &scr_ni_host_export_get,
    &scr_ni_host_export_set,
    &scr_ni_host_export_has,
    &scr_ni_host_export_delete,
    &scr_ni_host_export_keys,
    &scr_ni_host_export_watch,
    &scr_ni_host_export_release,
    &scr_ni_host_export_instance_of,
    &scr_ni_host_shared_table,
    &scr_ni_host_shared_get,
    &scr_ni_host_shared_tdz,
    &scr_ni_host_export_op,
    &scr_ni_host_gc_analyze,
    &scr_ni_host_bound,
    &scr_ni_host_bind,
    &scr_ni_host_holds,
    &scr_ni_host_export_symbol,
};

typedef struct {
  uint32_t event, listener;
  const char *name;
  int arg;
} NiEmit;

static void ni_emit_job(void *p) {
  NiEmit *e = p;
  ni_bridge->emit(e->event, e->listener, e->name, e->arg);
}

/* An island listener of a process event, on Node's stack (an exit listener
 * runs from the runtime's exit sequence, on whatever stack called it). */
void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg) {
  if (ni_bridge == NULL) return;
  char *n = malloc(name->len + 1);
  if (n == NULL) ni_oom();
  memcpy(n, name->data, name->len);
  n[name->len] = '\0';
  NiEmit e = {event, listener, n, arg};
  ni_on_node_stack(ni_emit_job, &e);
  free(n);
}

static void ni_stop_job(void *p) {
  (void)p;
  scr_ni_stop();
  ni_bridge->stop();
}

static void ni_h_checkpoint(int microtasks_first);

/* Process end after a normal return: the 'exit' listeners of both sides
 * run while Node can still call into JavaScript (this handler runs before
 * the events unit's own, which then finds them done), then Node stops. */
static void ni_stop_atexit(void) {
  scr_run_exit_listeners((double)scr_exit_code_hint_get());
  /* The program ended by running dry: Node drains the microtasks the 'exit'
   * listeners queued once, after the last listener (ticks queued while
   * exiting were dropped when they were queued). process.exit() never gets
   * here: it ends the process from inside the exit sequence. */
  ni_h_checkpoint(1);
#ifdef SCR_NODE_ISLAND_STDIO
  /* The shared output streams' helper, after the listeners' writes. */
  scr_ni_stdio_stop();
#endif
  /* SCRIPTC_NODE_ISLANDS_TRACE=handles: the import table at exit (leak
   * tests: acyclic island objects the program dropped are released). */
  const char *trace = getenv("SCRIPTC_NODE_ISLANDS_TRACE");
  if (trace != NULL && strcmp(trace, "handles") == 0) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "[node-islands] live handles %u\n", scr_ni_live_handles());
  }
  /* SCRIPTC_NODE_ISLANDS_TRACE=gc: the cross-heap collector's counters at
   * exit (NI-8; each major GC is traced by the bridge as it ends). */
  if (trace != NULL && strstr(trace, "gc") != NULL) {
    /* The native halves of cycles V8 already freed are cyclic garbage the
     * exit sweep would free anyway: count what is left after it. */
    scr_collect_cycles();
    ScrNodeGcStats stats;
    memset(&stats, 0, sizeof stats);
    ni_bridge->gc_stats(&stats);
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr,
            "[node-islands] gc totals: major %llu, analyzed %llu, freed exports %llu, freed "
            "imports %llu, representatives %u, import entries %u, held exports %u, held handles "
            "%u, analysis max %.3f ms total %.3f ms\n",
            (unsigned long long)stats.major_gcs, (unsigned long long)stats.analyses,
            (unsigned long long)stats.freed_exports, (unsigned long long)stats.freed_imports,
            stats.live_exports, stats.live_imports, scr_ni_live_exports(), scr_ni_live_handles(),
            (double)stats.max_analysis_ns / 1e6, (double)stats.analysis_ns / 1e6);
  }
  ni_on_node_stack(ni_stop_job, NULL);
  ni_node_ending = true;
  /* Timers and immediates the 'exit' listeners armed never run: release
   * their callbacks, as the loop's teardown released the ones before. */
  scr_timers_teardown();
  /* Node is gone: no representative can call in again. */
  scr_ni_exports_release_all();
  scr_ni_gc_cleanup();
}

/* The hosted loop's run_loop on Node's stack. */
typedef struct {
  int continue_turn, code;
} NiRunLoop;

static void ni_run_loop_job(void *p) {
  NiRunLoop *a = p;
  a->code = ni_bridge->run_loop(a->continue_turn);
}

static int ni_run_loop(int continue_turn) {
  NiRunLoop a = {continue_turn, 0};
  ni_on_node_stack(ni_run_loop_job, &a);
  return a.code;
}

/* The bridge as the hosted loop sees it. Every entry that runs JavaScript
 * (scheduling a tick, timer or immediate goes through the bootstrap's
 * helpers; a checkpoint drains queues; Node's loop) runs on Node's stack,
 * below the mark when it comes from an async fiber that a host callback
 * resumed, like every other entry: V8 scans only Node's stack, so no frame
 * of Node may live on a fiber's stack or the main thread's. */
typedef struct {
  int op;
  uint32_t a, b;
  double d0, d1;
  int i0;
  uint32_t result;
} NiHosted;

enum {
  NI_H_MICROTASK,
  NI_H_TICK,
  NI_H_TIMER,
  NI_H_TIMER_CLEAR,
  NI_H_TIMER_REF,
  NI_H_TIMER_REFRESH,
  NI_H_IMMEDIATE,
  NI_H_IMMEDIATE_CLEAR,
  NI_H_IMMEDIATE_REF,
  NI_H_CHECKPOINT,
};

static void ni_hosted_job(void *p) {
  NiHosted *h = p;
  switch (h->op) {
  case NI_H_MICROTASK: ni_bridge->microtask(h->a); break;
  case NI_H_TICK: ni_bridge->tick(h->a); break;
  case NI_H_TIMER: h->result = ni_bridge->timer(h->d0, h->d1, h->i0, h->a); break;
  case NI_H_TIMER_CLEAR: ni_bridge->timer_clear(h->a); break;
  case NI_H_TIMER_REF: ni_bridge->timer_ref(h->a, h->i0); break;
  case NI_H_TIMER_REFRESH: ni_bridge->timer_refresh(h->a); break;
  case NI_H_IMMEDIATE: h->result = ni_bridge->immediate(h->i0, h->a); break;
  case NI_H_IMMEDIATE_CLEAR: ni_bridge->immediate_clear(h->a); break;
  case NI_H_IMMEDIATE_REF: ni_bridge->immediate_ref(h->a, h->i0); break;
  case NI_H_CHECKPOINT: ni_bridge->checkpoint(h->i0); break;
  default: break;
  }
}

static uint32_t ni_hosted_run(int op, uint32_t a, double d0, double d1, int i0) {
  NiHosted h = {op, a, 0, d0, d1, i0, 0};
  ni_on_node_stack(ni_hosted_job, &h);
  return h.result;
}

static void ni_h_microtask(uint32_t token) { ni_hosted_run(NI_H_MICROTASK, token, 0, 0, 0); }
static void ni_h_tick(uint32_t token) { ni_hosted_run(NI_H_TICK, token, 0, 0, 0); }
static uint32_t ni_h_timer(double delay, double repeat, int ref, uint32_t token) {
  return ni_hosted_run(NI_H_TIMER, token, delay, repeat, ref);
}
static void ni_h_timer_clear(uint32_t h) { ni_hosted_run(NI_H_TIMER_CLEAR, h, 0, 0, 0); }
static void ni_h_timer_ref(uint32_t h, int ref) { ni_hosted_run(NI_H_TIMER_REF, h, 0, 0, ref); }
static void ni_h_timer_refresh(uint32_t h) { ni_hosted_run(NI_H_TIMER_REFRESH, h, 0, 0, 0); }
static uint32_t ni_h_immediate(int ref, uint32_t token) {
  return ni_hosted_run(NI_H_IMMEDIATE, token, 0, 0, ref);
}
static void ni_h_immediate_clear(uint32_t h) { ni_hosted_run(NI_H_IMMEDIATE_CLEAR, h, 0, 0, 0); }
static void ni_h_immediate_ref(uint32_t h, int ref) {
  ni_hosted_run(NI_H_IMMEDIATE_REF, h, 0, 0, ref);
}
static void ni_h_checkpoint(int microtasks_first) {
  ni_hosted_run(NI_H_CHECKPOINT, 0, 0, 0, microtasks_first);
}

static ScrNodeBridge ni_hosted;

/* ── process.exit() with a compile cache ──────────────────────────────── */

/* process.exit() from native code ends the process without stopping Node
 * (scr_process_exit ends in _Exit), so the entries of the modules this run
 * compiled are written here: Node's own module.flushCompileCache, reached
 * as the bootstrap's `scriptc:flushCompileCache` (scr_node_island_host.cjs,
 * `load`). Installed over the events unit's exit hook when Node starts with
 * a cache (ni_start), so it runs after the 'exit' listeners, on the main
 * thread; the program's output goes out first. */
static void (*ni_exit_listeners)(double code) = NULL;

static void ni_process_exit(double code) {
  if (ni_exit_listeners != NULL) ni_exit_listeners(code);
  if (ni_node_ending || ni_bridge == NULL) return;
  scr_stdout_settle();
  fflush(stdout);
  struct timespec t0 = {0, 0}, t1 = {0, 0};
  if (ni_cache_tracing()) (void)clock_gettime(CLOCK_MONOTONIC, &t0);
  static const char name[] = "scriptc:flushCompileCache";
  ScrStr *path = scr_str_new(name, sizeof name - 1);
  ScrDyn *written = scr_ni_require(path);
  scr_str_release(path);
  if (written != NULL) scr_dyn_release(written);
  else if (scr_exc_pending()) scr_caught_release(scr_exc_take());
  if (!ni_cache_tracing()) return;
  (void)clock_gettime(CLOCK_MONOTONIC, &t1);
  fprintf(stderr, "[node-islands] compile cache: written at process.exit in %.3f ms\n",
          (double)(t1.tv_sec - t0.tv_sec) * 1e3 + (double)(t1.tv_nsec - t0.tv_nsec) / 1e6);
}

/* ── loading Node ─────────────────────────────────────────────────────── */

void (*scr_ni_started_hook)(void) = NULL;

static void ni_start(void) {
  /* Another thread reads only the flag, which the island's thread sets
   * last: the bridge pointer is that thread's until then. */
  if (SCR_NI_THREADS && atomic_load_explicit(&ni_started, memory_order_acquire)) return;
  if (!scr_ni_main_thread()) {
    /* Only the island's thread may load Node: it runs ni_start itself, then
     * the posted no-op. When this returns, ni_started is set. */
    ni_route(ni_route_noop, NULL);
    return;
  }
  if (ni_bridge != NULL) return;
  /* Timers pending now keep their deadlines relative to this moment: the
   * time Node takes to load is invisible to their order. */
  double since = scr_now_ms();
  if (ni_tracing()) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "[node-islands] starting Node\n");
  }
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
  /* Node's argv[0] is "node": island process.argv0 reads it, and Node's
   * warning hint is built from it ("(Use `node --trace-deprecation ...`"),
   * which the runtime's own warnings print too. process.execPath stays the
   * executable (libuv's exepath). */
  char argv0[] = "node";
  /* Flush first: Node writes to the same stdout. */
  scr_stdout_settle();
  fflush(stdout);
  ni_bridge = bridge;
  ni_main_stack();
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
  /* Island listeners need the runtime's event registries and their
   * delivery; installed before the stop handler, whose 'exit' listeners
   * run first. */
  scr_events_install();
  if (ni_compile_cache_on) {
    ni_exit_listeners = scr_process_exit_hook;
    scr_process_exit_hook = &ni_process_exit;
  }
  scr_ni_handles_install();
  scr_atexit(ni_stop_atexit);
  ni_hosted = *bridge;
  ni_hosted.run_loop = &ni_run_loop;
  ni_hosted.microtask = &ni_h_microtask;
  ni_hosted.tick = &ni_h_tick;
  ni_hosted.timer = &ni_h_timer;
  ni_hosted.timer_clear = &ni_h_timer_clear;
  ni_hosted.timer_ref = &ni_h_timer_ref;
  ni_hosted.timer_refresh = &ni_h_timer_refresh;
  ni_hosted.immediate = &ni_h_immediate;
  ni_hosted.immediate_clear = &ni_h_immediate_clear;
  ni_hosted.immediate_ref = &ni_h_immediate_ref;
  ni_hosted.checkpoint = &ni_h_checkpoint;
  scr_loop_host(&ni_hosted, since);
#ifdef SCR_NODE_ISLAND_STDIO
  /* The island's process.stdout.write and process.stderr.write become the
   * program's write slots (scr_node_island_stdio.c) before any island
   * module runs. */
  scr_ni_stdio_started();
#endif
  /* Node's `process` is the registry of the process events from here on,
   * and process.exitCode its property (scr_node_island_events.c): the
   * program's native listeners move over first, in their order, and a code
   * the program already set goes with them. */
  scr_process_events_to_node();
  if (scr_process_has_exit_code()) {
    double ignored;
    (void)scr_ni_exit_code(true, scr_process_exit_code_or_zero(), &ignored);
  }
  /* NI-7: deferred island modules evaluate now, before the operation that
   * needed Node, in their import order. */
  if (scr_ni_started_hook != NULL) scr_ni_started_hook();
  /* Last: another thread waiting on a posted operation proceeds only once
   * Node is fully up (the acquire load in ni_start pairs with this). */
  atomic_store_explicit(&ni_started, true, memory_order_release);
}

const ScrNodeBridge *scr_ni_bridge(void) {
  ni_start();
  return ni_bridge;
}

const ScrNodeBridge *scr_ni_bridge_loaded(void) { return ni_bridge; }

const char *scr_ni_pack_dir(void) { return ni_pack_dir(); }
char *scr_ni_module_path(const ScrStr *path) {
  if (path->len >= 2 && path->data[0] == '.' && path->data[1] == '/')
    return ni_tree_path(path->data + 2, path->len - 2);
  return ni_cstr_of(path->data, path->len);
}

void scr_ni_on_node_stack(void (*job)(void *), void *arg) { ni_on_node_stack(job, arg); }

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

/* Asynchronous island calls are still main-thread-only: the promise they
 * settle and the pending table they register in belong to the calling
 * thread's heap, and delivering a settlement to another thread's loop is
 * not implemented. A call from a worker thread rejects, naming the limit,
 * instead of settling a promise that belongs to another thread. */
static bool ni_async_main_thread(void) {
  if (scr_ni_main_thread()) return true;
  static const char name[] = "ERR_SCRIPTC_ISLAND_WORKER_ASYNC";
  static const char text[] =
      "asynchronous island calls from a worker thread are not supported; "
      "call the island synchronously (@scriptc/node callSync) from the worker [SC8012]";
  ScrStr *code = scr_str_new(name, sizeof name - 1);
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  scr_throw_node_coded(0, code, message);
  scr_str_release(message);
  scr_str_release(code);
  return false;
}

ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  ScrDyn *json = ni_args_json(args);
  if (json == NULL) return NULL;
  ni_start();
  ScrDyn *result;
  for (int attempt = 0;; attempt++) {
    size_t repairs = ni_repaired;
    size_t len = 0;
    char *outcome = ni_call(0, true, file, specifier, name, json, &len);
    if (outcome == NULL && scr_ni_unserved) {
      /* This thread was asked to stop before the call ran. */
      scr_dyn_release(json);
      return NULL;
    }
    if (outcome == NULL) ni_fatal("scriptc: the libnode bridge answered no outcome\n");
    ni_load_failed = false;
    result = ni_outcome(outcome, len);
    ni_bridge->release(outcome);
    if (result != NULL || attempt > 0 || !ni_load_failed || ni_repaired == repairs) break;
    /* The module did not load because the installed tree had lost a file,
     * and the file is back: the call once more (its function never ran). */
    scr_caught_release(scr_exc_take());
  }
  scr_dyn_release(json);
  return result;
}

ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  ScrPromise *p = scr_promise_new();
  if (!ni_async_main_thread()) {
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
  ni_pending[ni_npending] = (NiPending){id,
                                        scr_promise_retain(p),
                                        scr_str_retain(file),
                                        scr_str_retain(specifier),
                                        scr_str_retain(name),
                                        scr_dyn_retain(json),
                                        ni_repaired,
                                        false};
  ni_npending++;
  size_t len = 0;
  char *outcome = ni_call(id, false, file, specifier, name, json, &len);
  scr_dyn_release(json);
  if (outcome != NULL) ni_bridge->release(outcome);
  return p;
}

#else /* _WIN32 || __wasi__ */

void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg) {
  (void)event;
  (void)listener;
  (void)name;
  (void)arg;
}

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

/* No islands here, so nothing is ever posted (the compiler refuses them on
 * this target; scr_async.c's island build still references the hooks). */
#if SCR_NI_THREADS
bool scr_ni_remote_pending(void) { return false; }
int scr_ni_remote_pollfd(void) { return -1; }
void scr_ni_remote_dispatch(void) {}
#endif

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
