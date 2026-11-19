/* Many caught assertions must share one exit-cleanup registration: the
 * AssertionError property seed runs on every failure, and a worker
 * executable allocates an exit-list entry per registration. */
#include "../src/scr_runtime.h"
#include <stdio.h>

int main(void) {
  for (int i = 0; i < 1000; i++) {
    scr_error_seed_own_prop("generatedMessage", 16, scr_dyn_new_bool(true));
    ScrDyn *value = scr_error_take_seed();
    if (value == NULL) {
      printf("seed missing at %d\n", i);
      return 1;
    }
    scr_dyn_release(value);
  }
  size_t registrations = scr_error_seed_registration_count();
  if (registrations != 1) {
    printf("%zu registrations\n", registrations);
    return 1;
  }
  printf("one registration\n");
  return 0;
}
