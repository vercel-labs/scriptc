/* Loads a libnode pack the way scr_node_island.c does (dlopen the bridge,
 * check its ABI, start Node from the snapshot with the runtime's embedded
 * bootstrap) and makes calls through the bridge: synchronous results and
 * errors, and an asynchronous call settled by Node's own loop, which this
 * host runs the way the runtime's hosted loop does (host_loop, a
 * checkpoint, run_loop) with no runtime work of its own. bridge.test.ts
 * compares the transcript. Usage: bridge-smoke <pack dir> <module path> */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_node_bridge.h"
#include "scr_node_island_host.h"

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

static void run(uint32_t kind, uint32_t token) {
  printf("run %u %u\n", kind, token);
}

static void io_state(ScrNodeIoState *state) {
  state->nfds = 0;
  state->alive = 0;
  state->ready = 0;
  state->cap_ms = -1;
}

static void io_dispatch(void) {}
static void microtasks_done(void) {}

static void listen(uint32_t event, const char *name, uint32_t listener, int add, int once) {
  printf("listen %u %s %u %d %d\n", event, name, listener, add, once);
}

static uintptr_t stack_limit(void) { return 0; }
static uintptr_t stack_start(void) { return 0; }

static const ScrNodeBridgeHost host = {settle,          on_exit_code, run,   io_state, io_dispatch,
                                       microtasks_done, listen,       stack_limit, stack_start};

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
  snprintf(path, sizeof path, "%s/libscr_node_bridge.so", argv[1]);
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
  b->host_loop();
  b->checkpoint(0);
  b->run_loop(0);
  call(b, 0, 1, file, "quit", "[3]");
  return 0;
}
