/* scriptc runtime — Node islands (scr_node_island.c). Linked only into
 * programs whose IR calls into Node.js (the `nodeIsland` runtime feature),
 * together with the SCR_NODE_ISLANDS build of scr_async.c, which defines
 * the loop slot below. */
#ifndef SCR_NODE_ISLAND_H
#define SCR_NODE_ISLAND_H

#include "scr_async.h"
#include "scr_dyn.h"

/* Records the build-time configuration: the libnode pack directory
 * (absolute, or `$ORIGIN/`-relative to the executable) and the Node version
 * its bridge must link. Both strings are static. The emitted main calls it
 * before %main. */
void scr_node_island_install(const char *libnode, const char *node_version);

/* @scriptc/node callSync(specifier, name, ...args): `file` is the calling
 * module's path (relative specifiers resolve from it), `args` the boxed
 * argument array, copied as JSON. Returns the JSON copy of the result, +1,
 * or NULL with the copied error pending. Borrows every argument. */
ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* @scriptc/node call(...): the same call, asynchronous. Returns a +1
 * promise that settles with the result's copy, or rejects with the copied
 * error (also when the arguments cannot be copied). Never throws. */
ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* The hosted loop (SCR_NODE_ISLANDS build of scr_async.c, scope-B NI-3).
 * scr_loop_host moves the runtime's pending ticks, promise jobs, timers
 * and immediates onto Node's queues through `bridge` and schedules every
 * later one there; `since_ms` (scr_now_ms() before Node began loading) is
 * the clock pending timers count their remaining delay from. The rest are
 * the bridge's host callbacks (scr_node_bridge.h). */
struct ScrNodeBridge;
struct ScrNodeIoState;
void scr_loop_host(const struct ScrNodeBridge *bridge, double since_ms);
bool scr_loop_is_hosted(void);
void scr_loop_hosted_run(uint32_t kind, uint32_t token);
void scr_loop_hosted_io_state(struct ScrNodeIoState *state);
void scr_loop_hosted_io(void);
void scr_loop_hosted_microtasks_done(void);

/* Process events island code listens to (SCR_NODE_EVENT_* of the bridge
 * ABI). Their listeners sit in the runtime's registries (the
 * SCR_NODE_ISLANDS build of scr_events.c) at their registration position,
 * and a delivery calls them through scr_node_island_emit: a signal with
 * its number, exit with the code. */
enum { SCR_NODE_ISLAND_EVENT_SIGNAL = 1, SCR_NODE_ISLAND_EVENT_EXIT = 2 };
void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg);
void scr_signal_on_island(ScrStr *name, uint32_t listener);
void scr_signal_off_island(uint32_t listener);
void scr_process_on_exit_island(uint32_t listener);
void scr_process_off_exit_island(uint32_t listener);

#endif /* SCR_NODE_ISLAND_H */
