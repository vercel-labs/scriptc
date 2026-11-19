#undef NDEBUG
#include "scr_runtime.h"
#include "scr_stream.h"
#include "scr_string_methods.h"

#include <assert.h>
#include <stdio.h>
#include <unistd.h>

/* scr_stream.c links the readline unit for its terminal streams; that unit
 * reaches the regex engine's escape stripping, which this fixture never
 * runs. Answer the one symbol here instead of linking a second engine. */
ScrStr *scr_util_strip_vt(const ScrDyn *input) {
  (void)input;
  return NULL;
}

/* The parser only validates the options and hands the readable to the
 * iterator; a NULL readable keeps this fixture to the options graph (the
 * iterator answers done without one). */

/* The false option is read with the property's own fifteen-byte key, which
 * the iterator's return() proves: it must not destroy the readable. A key
 * length of 16 (the literal with its NUL) misses it and answers the default,
 * true. The graph is leaked deliberately; the fixture exits without the
 * collector teardown below. */
static void boolean_option_is_read(void) {
  ScrStream *s = scr_stream_new_readable(1, true, true, NULL, NULL, NULL, NULL);
  ScrDyn *options = scr_dyn_new_obj();
  scr_dyn_obj_set(options, "destroyOnReturn", 15, scr_dyn_new_bool(false));
  ScrDyn *iterator = scr_stream_dyn_iterator(s, &options, 1);
  assert(iterator != NULL);
  assert(!scr_exc_pending());
  ScrDyn *return_fn = scr_dyn_obj_get(iterator, "return", 6);
  assert(return_fn != NULL && return_fn->kind == SCR_DYN_FUNC);
  (void)scr_dyn_call(return_fn, NULL, 0, "return");
  assert(scr_stream_prop(s, "destroyed") == 0);
}

/* JSON can spell a property name with a trailing NUL, which the old 16-byte
 * lookup matched. Its value was released even though obj_get borrows it, so
 * dropping the options object freed the string a second time. */
static void borrowed_value_is_not_released(void) {
  static const char nul_suffixed[] = "destroyOnReturn\0";
  ScrDyn *options = scr_dyn_new_obj();
  ScrDyn *value = scr_dyn_new_str(scr_str_new("yes", 3));
  scr_dyn_obj_set(options, nul_suffixed, sizeof nul_suffixed - 1, value);
  scr_dyn_release(value);
  ScrDyn *iterator = scr_stream_dyn_iterator(NULL, &options, 1);
  assert(iterator != NULL);
  assert(!scr_exc_pending());
  scr_dyn_release(iterator);
  scr_dyn_release(options);
}

int main(void) {
  scr_init();
  scr_lib_init(0, NULL);
  /* The borrowed-value case runs first: with the release bug present it is
   * the sanitizer that reports, before the boolean case below. */
  borrowed_value_is_not_released();
  boolean_option_is_read();
  puts("stream iterator options parse without a borrowed release");
  fflush(stdout);
  /* The fixture leaves the process-wide runtime's event loop and collector
   * unrun; the assertions above are the contract, so exit without the
   * teardown the entry point would perform. */
  _exit(0);
}
