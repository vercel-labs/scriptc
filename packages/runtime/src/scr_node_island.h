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

/* Records the island module tree (node-islands/modules.ts): its manifest,
 * and its files concatenated in manifest order when the executable carries
 * them (NULL when they ship beside it at `location`, a `$ORIGIN/` path; ""
 * otherwise). All static. The emitted main calls it after
 * scr_node_island_install. */
void scr_node_island_install_modules(const char *manifest, size_t manifest_len,
                                     const unsigned char *data, size_t data_len,
                                     const char *location);

/* @scriptc/node callSync(specifier, name, ...args): `file` is the calling
 * module's path (relative specifiers resolve from it), `args` the boxed
 * argument array, copied as JSON. Returns the JSON copy of the result, +1,
 * or NULL with the copied error pending. Borrows every argument. */
ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* @scriptc/node call(...): the same call, asynchronous. Returns a +1
 * promise that settles with the result's copy, or rejects with the copied
 * error (also when the arguments cannot be copied). Never throws. */
ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args);

/* The loop slot (SCR_NODE_ISLANDS build of scr_async.c): `pending` keeps
 * the loop alive, `dispatch` runs at every turn top, `pollfd` joins the
 * idle poll and `timeout` (milliseconds, -1 for none) bounds its sleep. */
void scr_loop_set_node_island(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void),
                              int (*timeout)(void));

#endif /* SCR_NODE_ISLAND_H */
