/** The young-in nursery (phase 1, experimental): compile-time opt-in with
 * SCRIPTC_YOUNG_NURSERY=1. Executables then allocate compiled class and
 * record instances young (the emitted constructors call scr_yin_enter) and
 * link the collector unit built with SCR_YIN, which collects young cycles
 * in nursery collections (scr_cycle.c, "young-in nursery"). Unset, nothing
 * the compiler emits or links changes. */
export function youngNurseryRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SCRIPTC_YOUNG_NURSERY"] === "1";
}
