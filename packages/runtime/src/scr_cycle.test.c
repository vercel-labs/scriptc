/* White-box check for the cycle-type registry size override (scr_cycle.c).
 * Built by scr_cycle.test.ts with -DSCR_CYC_MAX_TYPES=4: ids 1..3 register,
 * the table holds exactly four entries, and a fourth type traps. */
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

static ScrCycType types[4];

int main(void) {
  assert(sizeof(scr_cyc_types) / sizeof(scr_cyc_types[0]) == 4);
  for (uint32_t i = 0; i < 3; i++) assert(scr_cyc_type_id(&types[i]) == i + 1);
  puts("registered 3 cycle types in a table of 4");
  fflush(stdout);
  scr_cyc_type_id(&types[3]);
  puts("unreachable");
  return 0;
}
