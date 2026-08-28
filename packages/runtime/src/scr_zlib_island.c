/* The zlib ↔ island bridge — the one translation unit referencing BOTH
 * scr_zlib.c and the island (the scr_inspect_island.c precedent): native-toolchain.ts
 * compiles it exactly when a --dynamic build's embedded npm graph
 * imports node:zlib, and the emitted main calls scr_zlib_island_install
 * before any island entry. zlib-free dynamic builds keep the island's
 * "zlib is not linked" refusal; island-free zlib builds never load this
 * file. */
#include "scr_runtime.h"

void scr_island_set_zlib(ScrBytes *(*deflate)(const ScrBytes *, double, double),
                         ScrBytes *(*inflate)(const ScrBytes *, double));

void scr_zlib_island_install(void) {
  scr_island_set_zlib(scr_zlib_deflate_mode, scr_zlib_inflate_mode);
}
