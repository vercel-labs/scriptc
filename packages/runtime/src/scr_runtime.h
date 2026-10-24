/* scriptc runtime — public API.
 * Every scriptc binary compiles these sources in; there is no shared library.
 *
 * Prefix conventions: the runtime owns "scr_" and "SCR_" macros/"Scr" type names.
 * Compiler-emitted symbols use "sc_f_" (functions), "sc_l_" (locals),
 * "sc_t" (temps) and never collide.
 *
 * This file includes the per-module headers below in dependency order and
 * holds no declarations. The first comment of each module header says what
 * it declares and names the main runtime units (.c files) behind it. A module
 * header includes the headers whose names it uses and compiles on its own, so
 * a .c file may include only the module headers it needs.
 *
 * - A new declaration goes in the header of the unit that defines it:
 *   scr_<unit>.h for scr_<unit>.c, or the header whose first comment names
 *   the unit (scr_lib.c's process and fs entry points are in scr_lib.h, its
 *   crypto entry points in scr_crypto.h).
 * - A declaration must come after every type and macro it uses. When it uses
 *   a name from a header that is not yet included, add that #include to the
 *   module header. A header may include only headers listed above it here.
 * - A new module header gets its own include guard and an entry in this list
 *   after every header it includes.
 */
#ifndef SCR_RUNTIME_H
#define SCR_RUNTIME_H

#include "scr_core.h"
#include "scr_rc.h"
#include "scr_string.h"
#include "scr_error.h"
#include "scr_string_methods.h"
#include "scr_qs.h"
#include "scr_array.h"
#include "scr_regex.h"
#include "scr_map.h"
#include "scr_closure.h"
#include "scr_ffi.h"
#include "scr_union.h"
#include "scr_events_emitter.h"
#include "scr_stream.h"
#include "scr_exception.h"
#include "scr_lib.h"
#include "scr_dc.h"
#include "scr_child.h"
#include "scr_crypto.h"
#include "scr_path.h"
#include "scr_file_handle.h"
#include "scr_url.h"
#include "scr_symbol.h"
#include "scr_bigint.h"
#include "scr_os.h"
#include "scr_dyn.h"
#include "scr_json.h"
#include "scr_event_target.h"
#include "scr_blob.h"
#include "scr_object.h"
#include "scr_region.h"
#include "scr_itable.h"
#include "scr_slots.h"
#include "scr_async.h"
#include "scr_events.h"
#include "scr_readline.h"
#include "scr_generator.h"
#include "scr_number.h"
#include "scr_bytes.h"
#include "scr_inspect.h"
#include "scr_zlib.h"
#include "scr_net.h"
#include "scr_tls.h"
#include "scr_http.h"
#include "scr_http2.h"
#include "scr_dgram.h"
#include "scr_watch.h"
#include "scr_test.h"
#include "scr_assert.h"
#include "scr_console.h"
#include "scr_fs_cp.h"
#include "scr_wasm_abi.h"
#include "scr_wasm.h"
#include "scr_node_island.h"

#endif /* SCR_RUNTIME_H */
