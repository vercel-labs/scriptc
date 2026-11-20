/* The optional-unit tables (scr_optional.h). This unit is always linked, so a
 * caller can read a table without causing the unit behind it to link; the unit
 * installs its table from a constructor when it is there. */
#include "scr_optional.h"

#include <stddef.h>

const ScrEventTargetOps *scr_optional_event_target = NULL;
const ScrDcOps *scr_optional_dc = NULL;
