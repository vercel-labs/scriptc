/* The dynamic global object's answer for the Node globals the native runtime
 * does not implement: a loud TypeError instead of a silently wrong undefined
 * (see host-globals.ts for the derivation and the static refusals). Linked
 * only into programs that read the global object through a computed key or
 * ask `… in globalThis`. */
#include "scr_runtime.h"

#include <string.h>

#define SCR_HOST_ABSENT_MAX 64
#define SCR_HOST_ABSENT_ARENA 4096

typedef struct {
  const char *data;
  size_t len;
} ScrHostAbsentName;

static SCR_TL ScrHostAbsentName scr_host_absent_names[SCR_HOST_ABSENT_MAX];
static SCR_TL size_t scr_host_absent_count;
static SCR_TL char scr_host_absent_arena[SCR_HOST_ABSENT_ARENA];
static SCR_TL size_t scr_host_absent_used;

void scr_global_host_absent_install(ScrArr *names) {
  if (scr_host_absent_count != 0 || names == NULL) return;
  for (size_t i = 0; i < names->len && scr_host_absent_count < SCR_HOST_ABSENT_MAX; i++) {
    ScrStr *name = (ScrStr *)scr_arr_get_ref(names, (double)i);
    if (name == NULL) continue;
    if (name->len != 0 && scr_host_absent_used + name->len <= SCR_HOST_ABSENT_ARENA) {
      char *copy = scr_host_absent_arena + scr_host_absent_used;
      memcpy(copy, name->data, name->len);
      scr_host_absent_used += name->len;
      scr_host_absent_names[scr_host_absent_count].data = copy;
      scr_host_absent_names[scr_host_absent_count].len = name->len;
      scr_host_absent_count++;
    }
    scr_str_release(name);
  }
}

/* One call, no allocation: the scan stays where the global read is, and only
 * the error's construction is cold. */
static bool scr_host_absent_named(const char *key, size_t length) {
  for (size_t i = 0; i < scr_host_absent_count; i++) {
    const ScrHostAbsentName *name = &scr_host_absent_names[i];
    if (name->len == length && memcmp(name->data, key, length) == 0) return true;
  }
  return false;
}

static SCR_COLD void scr_host_absent_throw(const char *key, size_t length) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_putc(&text, '\'');
  for (size_t i = 0; i < length; i++) scr_jb_putc(&text, key[i]);
  scr_jb_puts(&text, "' is a Node global that native code does not provide");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
}

bool scr_global_host_absent_check(const char *key, size_t length) {
  if (!scr_host_absent_named(key, length)) return false;
  scr_host_absent_throw(key, length);
  return true;
}

/* `key in <global object>`. A name native code does not provide throws
 * (above). Otherwise the answer is Node's: one of the names Node's global
 * object has or inherits, which the compiler hands over (`present`,
 * borrowed: global-object-names.ts), or a property the program added to the
 * global object. The builtin globals cannot be deleted or replaced through
 * the global object (scr_global_set), so the table is the whole answer for
 * them. The program's own properties are the keys a for-in over the global
 * object visits beyond Node's enumerable names, which are all in the table. */
bool scr_global_host_absent_has(ScrStr *key, ScrArr *present) {
  if (scr_global_host_absent_check(key->data, key->len)) return false;
  for (size_t i = 0; i < present->len; i++) {
    ScrStr *name = (ScrStr *)scr_arr_get_ref(present, (double)i);
    bool same = name->len == key->len && memcmp(name->data, key->data, key->len) == 0;
    scr_str_release(name);
    if (same) return true;
  }
  ScrDyn *keys = scr_global_for_in_object();
  bool own = scr_dyn_obj_get(keys, key->data, key->len) != NULL;
  scr_dyn_release(keys);
  return own;
}
