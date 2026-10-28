/* Loads a libnode pack the way scr_node_island.c does (dlopen the bridge,
 * check its ABI, start Node from the snapshot with the runtime's embedded
 * bootstrap) and makes calls through the bridge: synchronous results and
 * errors, and an asynchronous call settled by Node's own loop, which this
 * host drives like the runtime's loop slot. bridge.test.ts compares the
 * transcript. Usage: bridge-smoke <pack dir> <module path> */
#include <dlfcn.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_node_bridge.h"
#include "scr_node_island_host.h"

#ifdef __APPLE__
#define BRIDGE_FILE "libscr_node_bridge.dylib"
#else
#define BRIDGE_FILE "libscr_node_bridge.so"
#endif

static int settled = 0;

static void settle(uint32_t id, const char *outcome, size_t len) {
  printf("settle %u %.*s\n", id, (int)len, outcome);
  settled++;
}

static void on_exit_code(int code) {
  printf("exit %d\n", code);
  fflush(stdout);
  _Exit(code);
}

static const ScrNodeBridgeHost host = {settle, on_exit_code};

static void call(const ScrNodeBridge *b, uint32_t id, int sync, const char *module,
                 const char *name, const char *args) {
  size_t len = 0;
  char *out = b->call(id, sync, module, "./smoke.cjs", name, args, strlen(args), &len);
  if (out != NULL) {
    printf("%s %s -> %.*s\n", sync ? "sync" : "async", name, (int)len, out);
    b->release(out);
  } else {
    printf("%s %s -> pending\n", sync ? "sync" : "async", name);
  }
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  char path[4096];
  snprintf(path, sizeof path, "%s/" BRIDGE_FILE, argv[1]);
  void *lib = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (lib == NULL) {
    fprintf(stderr, "%s\n", dlerror());
    return 1;
  }
  const ScrNodeBridge *(*entry)(void) = (const ScrNodeBridge *(*)(void))dlsym(lib, SCR_NODE_BRIDGE_ENTRY);
  const ScrNodeBridge *b = entry();
  printf("abi %u ok %d\n", b->abi, b->abi == SCR_NODE_BRIDGE_ABI);
  char *error = b->start(&host, scr_node_island_host_js, argv[0], 0);
  if (error != NULL) {
    fprintf(stderr, "%s\n", error);
    return 1;
  }
  /* The caller file is the module itself: "./smoke.cjs" resolves beside it. */
  const char *file = argv[2];
  call(b, 0, 1, file, "add", "[2,3]");
  call(b, 0, 1, file, "fails", "[]");
  call(b, 0, 1, file, "missing", "[]");
  call(b, 7, 0, file, "later", "[5]");
  while (settled == 0 || b->alive()) {
    struct pollfd fd = {b->backend_fd(), POLLIN, 0};
    (void)poll(&fd, 1, b->backend_timeout());
    b->pump();
  }
  call(b, 0, 1, file, "quit", "[3]");
  return 0;
}
