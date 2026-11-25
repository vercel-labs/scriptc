/* The receiver of the call that made a generator, for a body that reads
 * `this` later, on the generator's fiber (scr_gen_receiver). An optional
 * unit, linked only into programs with such a read (dyn.generatorThis),
 * whose spawn wrappers call it: a generator of typed code takes no dynamic
 * value and links no receiver read, and every other program keeps the
 * default runtime objects byte for byte. */
#include "scr_runtime.h"
#include "scr_generator_private.h"

void scr_gen_capture_receiver(ScrGen *g) { g->receiver = scr_dyn_this_get(); }
