/* process.features — the stable object of Node's feature flags.
 *
 * A separate runtime unit, selected only by programs that read
 * process.features as a value, so that scr_lib.c keeps its object, byte for
 * byte, for every other program (a new function and its state there change
 * the code of unrelated functions in executables that never call it).
 */
#include "scr_runtime.h"
#include <string.h>

static SCR_TL ScrDyn *scr_features_object;

static void scr_features_object_cleanup(void) {
  scr_dyn_release(scr_features_object);
  scr_features_object = NULL;
}

/* Node's process.features keys in Node's order (lib/internal/bootstrap/
 * node.js) with the values that are true of a compiled binary; the
 * lowering's PROCESS_FEATURES table answers member reads from the same
 * values and says why each one holds. Node defines the last four through
 * getters without setters: here they are data properties that cannot be
 * written. */
ScrDyn *scr_process_features(void) {
  if (!scr_features_object) {
    static const struct {
      const char *name;
      bool value, writable;
    } flags[] = {
        {"inspector", false, true},
        {"debug", false, true},
        {"uv", false, true},
        {"ipv6", true, true},
        {"tls_alpn", true, true},
        {"tls_sni", true, true},
        {"tls_ocsp", false, true},
        {"tls", true, true},
        {"openssl_is_boringssl", false, true},
        {"cached_builtins", false, false},
        {"require_module", true, false},
        {"quic", false, false},
        {"typescript", false, false},
    };
    scr_features_object = scr_dyn_new_obj();
    for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
      scr_dyn_obj_set(scr_features_object, flags[i].name, strlen(flags[i].name),
                      scr_dyn_new_bool(flags[i].value));
      if (!flags[i].writable) scr_dyn_obj_set_attrs_at(scr_features_object, i, false, true, true);
    }
    scr_atexit(&scr_features_object_cleanup);
  }
  return scr_dyn_retain(scr_features_object);
}
