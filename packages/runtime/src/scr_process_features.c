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
 * values and says why each one holds.
 *
 * The object cannot be changed: every flag is a data property that is
 * neither writable nor configurable, and the object takes no new keys. A
 * member read (`process.features.tls`) is compiled as a constant, so a
 * write the object accepted would leave the read stale; under Node nine of
 * the flags are writable and a program may add keys of its own. A write
 * therefore throws the TypeError of a frozen object, and the constants
 * stay true of the object. */
ScrDyn *scr_process_features(void) {
  if (!scr_features_object) {
    static const struct {
      const char *name;
      bool value;
    } flags[] = {
        {"inspector", false},
        {"debug", false},
        {"uv", false},
        {"ipv6", true},
        {"tls_alpn", true},
        {"tls_sni", true},
        {"tls_ocsp", false},
        {"tls", true},
        {"openssl_is_boringssl", false},
        {"cached_builtins", false},
        {"require_module", true},
        {"quic", false},
        {"typescript", false},
    };
    scr_features_object = scr_dyn_new_obj();
    for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
      scr_dyn_obj_set(scr_features_object, flags[i].name, strlen(flags[i].name),
                      scr_dyn_new_bool(flags[i].value));
      scr_dyn_obj_set_attrs_at(scr_features_object, i, false, true, false);
    }
    scr_features_object->non_extensible = true;
    scr_atexit(&scr_features_object_cleanup);
  }
  return scr_dyn_retain(scr_features_object);
}
