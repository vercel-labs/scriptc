/* The build-time probe host for deferred Node islands (scope-B NI-7).
 * Not a runtime unit: the compiler (node-islands/snapshot.ts) builds it
 * once per bridge ABI and runs it against the libnode pack the program
 * will load, so the interface snapshot comes from that exact Node.
 *
 *   scr-node-probe <pack directory> <bootstrap.js> <input.json> <output.json>
 *
 * It starts Node from the pack's bridge with the bootstrap (which defines
 * the dispatcher and the probe), makes one synchronous call with the input
 * JSON, writes the outcome ("R<json>" or "T<json>") to the output file
 * (the probed modules may print) and exits. Never includes a Node or V8 header. */
#include "scr_node_bridge.h"

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__APPLE__)
#define BRIDGE_NAME "libscr_node_bridge.dylib"
#else
#define BRIDGE_NAME "libscr_node_bridge.so"
#endif

static char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *data = malloc((size_t)n + 1);
  if (data == NULL || fread(data, 1, (size_t)n, f) != (size_t)n) {
    fclose(f);
    free(data);
    return NULL;
  }
  fclose(f);
  data[n] = '\0';
  *len = (size_t)n;
  return data;
}

static void host_settle(uint32_t id, const char *outcome, size_t len) {
  (void)id;
  (void)outcome;
  (void)len;
}
static void host_exit(int code) {
  fflush(stdout);
  _Exit(code == 0 ? 3 : code);
}
static void host_run(uint32_t kind, uint32_t token) {
  (void)kind;
  (void)token;
}
static void host_io_state(ScrNodeIoState *state) { memset(state, 0, sizeof *state); }
static void host_void(void) {}
static void host_listen(uint32_t event, const char *name, uint32_t listener, int add, int once) {
  (void)event;
  (void)name;
  (void)listener;
  (void)add;
  (void)once;
}
static uintptr_t host_zero(void) { return 0; }
static void host_settle_value(uint32_t token, int rejected, const ScrNodeValue *value) {
  (void)token;
  (void)rejected;
  (void)value;
}
static void host_bytes_free(void *owner) { (void)owner; }
static int host_export_call(uint32_t id, const ScrNodeValue *this_, const ScrNodeValue *args,
                            size_t argc, ScrNodeValue *out) {
  (void)id;
  (void)this_;
  (void)args;
  (void)argc;
  out->tag = SCR_NV_UNDEFINED;
  return 0;
}
static int host_export_construct(uint32_t id, const ScrNodeValue *args, size_t argc,
                                 ScrNodeValue *out) {
  (void)id;
  (void)args;
  (void)argc;
  out->tag = SCR_NV_UNDEFINED;
  return 0;
}
static int host_export_get(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  (void)id;
  (void)key;
  (void)out;
  return 2;
}
static int host_export_set(uint32_t id, const ScrNodeValue *key, const ScrNodeValue *value,
                           ScrNodeValue *out) {
  (void)id;
  (void)key;
  (void)value;
  (void)out;
  return 2;
}
static int host_export_has(uint32_t id, const ScrNodeValue *key) {
  (void)id;
  (void)key;
  return 2;
}
static int host_export_delete(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  (void)id;
  (void)key;
  (void)out;
  return 2;
}
static int host_export_keys(uint32_t id, ScrNodeValue *out) {
  (void)id;
  (void)out;
  return 2;
}
static void host_export_id(uint32_t id) { (void)id; }

static const ScrNodeBridgeHost kHost = {
    .settle = host_settle,
    .exit = host_exit,
    .run = host_run,
    .io_state = host_io_state,
    .io_dispatch = host_void,
    .microtasks_done = host_void,
    .listen = host_listen,
    .stack_limit = host_zero,
    .stack_start = host_zero,
    .settle_value = host_settle_value,
    .bytes_free = host_bytes_free,
    .export_call = host_export_call,
    .export_construct = host_export_construct,
    .export_get = host_export_get,
    .export_set = host_export_set,
    .export_has = host_export_has,
    .export_delete = host_export_delete,
    .export_keys = host_export_keys,
    .export_watch = host_export_id,
    .export_release = host_export_id,
};

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: scr-node-probe <pack directory> <bootstrap.js> <input.json> <output.json>\n");
    return 2;
  }
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", argv[1], BRIDGE_NAME);
  void *library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (library == NULL) {
    fprintf(stderr, "scr-node-probe: %s\n", dlerror());
    return 1;
  }
  const ScrNodeBridge *(*entry)(void) =
      (const ScrNodeBridge *(*)(void))dlsym(library, SCR_NODE_BRIDGE_ENTRY);
  const ScrNodeBridge *bridge = entry != NULL ? entry() : NULL;
  if (bridge == NULL || bridge->abi != SCR_NODE_BRIDGE_ABI) {
    fprintf(stderr, "scr-node-probe: incompatible bridge at %s\n", path);
    return 1;
  }
  size_t blen = 0, ilen = 0;
  char *bootstrap = slurp(argv[2], &blen);
  char *input = slurp(argv[3], &ilen);
  if (bootstrap == NULL || input == NULL) {
    fprintf(stderr, "scr-node-probe: cannot read the bootstrap or the input\n");
    return 1;
  }
  char *error = bridge->start(&kHost, bootstrap, argv[0], 0);
  if (error != NULL) {
    fprintf(stderr, "scr-node-probe: %s\n", error);
    return 1;
  }
  size_t len = 0;
  char *outcome = bridge->call(0, 1, "", "", "probe", input, ilen, &len);
  fflush(stdout);
  FILE *out = fopen(argv[4], "wb");
  if (out == NULL || fwrite(outcome, 1, len, out) != len || fclose(out) != 0) {
    fprintf(stderr, "scr-node-probe: cannot write %s\n", argv[4]);
    _Exit(1);
  }
  bridge->release(outcome);
  /* No orderly stop: the probe's modules may hold handles; the process
   * exits here. */
  _Exit(0);
}
