/* Unit tests for boxes and closures: RC cascades (closure → box → string),
 * scalar and ref slots, set_ref release of old contents, immortal closures.
 * Built with -DSCR_RC_AUDIT; exits nonzero on any failure or leak.
 */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern long scr_str_live_count(void);
extern long scr_box_live_count(void);
extern long scr_closure_live_count(void);

static int failures = 0;
#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      failures++;                                                              \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                          \
  } while (0)

static double dummy_fn(ScrClosure *env, double x) {
  (void)env;
  return x * 2;
}

int main(void) {
  /* scalar box */
  ScrBox *nb = scr_box_new(SCR_BOX_F64);
  CHECK(scr_box_get_f64(nb) == 0);
  scr_box_set_f64(nb, 3.5);
  CHECK(scr_box_get_f64(nb) == 3.5);

  /* string box: set_ref releases the old value; get_ref returns +1 */
  ScrBox *sb = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(sb, scr_str_new("first", 5));
  scr_box_set_ref(sb, scr_str_new("second", 6)); /* releases "first" */
  CHECK(scr_str_live_count() == 1);
  ScrStr *out = (ScrStr *)scr_box_get_ref(sb);
  CHECK(out->rc == 2 && strcmp(out->data, "second") == 0);
  scr_str_release(out);

  /* closure holding boxes: release cascades */
  ScrClosure *c = scr_closure_new((void *)&dummy_fn, 2);
  c->caps[0] = scr_box_retain(nb);
  c->caps[1] = scr_box_retain(sb);
  CHECK(((double (*)(ScrClosure *, double))c->fn)(c, 21) == 42);
  scr_box_release(nb);
  scr_box_release(sb);
  CHECK(scr_box_live_count() == 2); /* kept alive by the closure */
  scr_closure_release(c);
  CHECK(scr_box_live_count() == 0);
  CHECK(scr_str_live_count() == 0);
  CHECK(scr_closure_live_count() == 0);

  /* box holding a closure: cascade through SCR_BOX_FUNC */
  ScrBox *fb = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(fb, scr_closure_new((void *)&dummy_fn, 0));
  CHECK(scr_closure_live_count() == 1);
  scr_box_release(fb);
  CHECK(scr_closure_live_count() == 0);

  /* identity roots: an adapter of an adapter answers the original */
  ScrClosure *root = scr_closure_new((void *)&dummy_fn, 0);
  ScrClosure *view = scr_closure_new((void *)&dummy_fn, 0);
  ScrClosure *view2 = scr_closure_new((void *)&dummy_fn, 0);
  ScrClosure *other = scr_closure_new((void *)&dummy_fn, 0);
  CHECK(scr_closure_identity(root) == root && scr_closure_identity(NULL) == NULL);
  scr_closure_adopt_identity(view, root, 1);
  scr_closure_adopt_identity(view2, view, 3);
  CHECK(scr_closure_identity(view) == root && scr_closure_identity(view2) == root);
  CHECK(view->identity_length == 1 && view2->identity_length == 1);
  CHECK(scr_closure_identity_equal(view2, root) && scr_closure_identity_equal(view, view2));
  CHECK(!scr_closure_identity_equal(view, other) && !scr_closure_identity_equal(root, other));
  scr_closure_release(view2);
  scr_closure_release(view);
  scr_closure_release(other);
  scr_closure_release(root);
  CHECK(scr_closure_live_count() == 0);

  /* immortal closure: retain/release are no-ops */
  static struct { size_t rc; void *fn; size_t ncaps; } immortal = {SIZE_MAX, NULL, 0};
  immortal.fn = (void *)&dummy_fn;
  ScrClosure *ic = (ScrClosure *)&immortal;
  CHECK(scr_closure_retain(ic) == ic);
  scr_closure_release(ic);
  CHECK(ic->rc == SIZE_MAX);

  fprintf(stderr, "%s\n", failures ? "FAILED" : "all closure tests passed");
  return failures ? 1 : 0;
}
