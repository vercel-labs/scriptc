/* Smoke test for a libnode pack, written the way the scriptc runtime loads
 * one: a plain C program that never includes a Node or V8 header, dlopens
 * the pack's bridge, checks its ABI and Node version, starts Node (one
 * environment from the built-in startup snapshot), evaluates expressions
 * synchronously and asynchronously through the bridge's C ABI, and tears
 * Node down.
 *
 *   smoke <pack directory>     (or SCRIPTC_LIBNODE=<pack directory> smoke)
 *
 * stdout is deterministic and compared by scripts/smoke.mjs; timings and
 * memory go to stderr. */
#include "scr_node_bridge.h"

#include <dlfcn.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>

#if defined(__APPLE__)
#define BRIDGE_NAME "libscr_node_bridge.dylib"
#else
#define BRIDGE_NAME "libscr_node_bridge.so"
#endif

/* The bootstrap runs as the environment's main script. It hands the bridge
 * a dispatcher that evaluates `name` as an expression and answers the
 * bridge's outcome strings: "R<json>" when it returns, "T<json>" when it
 * throws; an asynchronous call settles through the host. Its `finish` is
 * the program end the bridge reports, which the smoke test does not use. */
static const char kBootstrap[] =
    "const host = globalThis.__scriptcNodeIslandHost;\n"
    "globalThis.require = require;\n"
    "const outcome = (ok, value) => (ok ? 'R' : 'T') + JSON.stringify(\n"
    "  ok ? value : { error: { name: value?.name, message: String(value?.message ?? value) } });\n"
    "globalThis.__scriptcNodeIsland = {\n"
    "  call(id, sync, file, specifier, name, args) {\n"
    "    let value;\n"
    "    try { value = (0, eval)(name); } catch (error) { return outcome(false, error); }\n"
    "    if (sync) return outcome(true, value);\n"
    "    Promise.resolve(value).then((v) => host.settle(id, outcome(true, v)),\n"
    "                                (e) => host.settle(id, outcome(false, e)));\n"
    "  },\n"
    "  finish(code) {},\n"
    "};\n";

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static long max_rss_kb(void) {
  struct rusage usage;
  getrusage(RUSAGE_SELF, &usage);
#if defined(__APPLE__)
  return usage.ru_maxrss / 1024;
#else
  return usage.ru_maxrss;
#endif
}

/* Whether a library whose path contains `needle` is mapped (Linux only). */
static int mapped(const char *needle) {
  FILE *maps = fopen("/proc/self/maps", "r");
  if (maps == NULL) return -1;
  char line[4096];
  int found = 0;
  while (!found && fgets(line, sizeof line, maps) != NULL) found = strstr(line, needle) != NULL;
  fclose(maps);
  return found;
}

static char *settled = NULL;
static size_t settled_len = 0;

static void host_settle(uint32_t id, const char *outcome, size_t len) {
  (void)id;
  settled = malloc(len + 1);
  memcpy(settled, outcome, len);
  settled[len] = '\0';
  settled_len = len;
}

static void host_exit(int code) {
  fflush(stdout);
  exit(code);
}

static const ScrNodeBridgeHost kHost = {host_settle, host_exit};

static const ScrNodeBridge *bridge;

static void eval_sync(const char *expression) {
  size_t len = 0;
  char *outcome = bridge->call(0, 1, "", "", expression, "[]", 2, &len);
  printf("%s => %s\n", expression, outcome);
  bridge->release(outcome);
}

static void eval_async(const char *expression) {
  settled = NULL;
  size_t len = 0;
  char *immediate = bridge->call(1, 0, "", "", expression, "[]", 2, &len);
  if (immediate != NULL) bridge->release(immediate);
  /* Drive Node's loop until the promise settles, as the runtime's loop does
   * before NI-3 hosts its queues on libuv. */
  while (settled == NULL && bridge->alive()) {
    struct pollfd fd = {bridge->backend_fd(), POLLIN, 0};
    poll(&fd, 1, bridge->backend_timeout());
    bridge->pump();
  }
  if (settled == NULL) bridge->pump();
  printf("await %s => %s\n", expression, settled != NULL ? settled : "(never settled)");
  free(settled);
  settled = NULL;
}

int main(int argc, char **argv) {
  const char *dir = argc > 1 ? argv[1] : getenv("SCRIPTC_LIBNODE");
  if (dir == NULL || dir[0] == '\0') {
    fprintf(stderr, "usage: smoke <pack directory> (or set SCRIPTC_LIBNODE)\n");
    return 2;
  }
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", dir, BRIDGE_NAME);
  int before = mapped("/libnode.");
  double t0 = now_ms();
  void *library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (library == NULL) {
    fprintf(stderr, "smoke: %s\n", dlerror());
    return 1;
  }
  double t1 = now_ms();
  const ScrNodeBridge *(*entry)(void) =
      (const ScrNodeBridge *(*)(void))dlsym(library, SCR_NODE_BRIDGE_ENTRY);
  if (entry == NULL) {
    fprintf(stderr, "smoke: %s has no %s\n", path, SCR_NODE_BRIDGE_ENTRY);
    return 1;
  }
  bridge = entry();
  if (bridge->abi != SCR_NODE_BRIDGE_ABI) {
    fprintf(stderr, "smoke: bridge ABI %u, expected %u\n", bridge->abi, SCR_NODE_BRIDGE_ABI);
    return 1;
  }
  printf("bridge ABI %u, Node %s, NODE_MODULE_VERSION %u\n", bridge->abi, bridge->node_version,
         bridge->module_version);
  printf("libnode mapped before dlopen: %s\n", before == 1 ? "yes" : "no");
  char *error = bridge->start(&kHost, kBootstrap, argv[0], 0);
  if (error != NULL) {
    fprintf(stderr, "smoke: %s\n", error);
    return 1;
  }
  double t2 = now_ms();
  eval_sync("1 + 2");
  double t3 = now_ms();
  eval_sync("process.versions.node");
  eval_sync("process.config.variables.node_use_node_snapshot");
  eval_sync("process.config.variables.icu_small");
  eval_sync("new Intl.NumberFormat('de-DE').format(1234567.891)");
  eval_sync("new Intl.DateTimeFormat('ja-JP', { timeZone: 'UTC', dateStyle: 'full' }).format(0)");
  eval_sync("require('node:crypto').createHash('sha256').update('scriptc').digest('hex')");
  eval_sync("require('node:zlib').gunzipSync(require('node:zlib').gzipSync('round trip')).toString()");
  eval_sync("[typeof require('node:fs').readFileSync, require('node:path').join('a', 'b')]");
  eval_sync("null.property");
  eval_async("new Promise((resolve) => setTimeout(() => resolve('timer fired'), 5))");
  eval_async("require('node:fs/promises').readFile(process.execPath).then((b) => b.length > 0)");
  eval_async("Promise.reject(new RangeError('rejected'))");
  fprintf(stderr,
          "smoke: dlopen %.1f ms, start %.1f ms, first result %.2f ms, dlopen to first result "
          "%.1f ms, max RSS %ld KB\n",
          t1 - t0, t2 - t1, t3 - t2, t3 - t0, max_rss_kb());
  bridge->stop();
  printf("ok\n");
  return 0;
}
