/* SCRIPTC_UNITS selects the separate-compilation mode.
 *
 * `observe` runs the ordinary whole-program build and, after lowering,
 * reports the unit graph, keys, summaries and pins without changing the
 * program's output. `split` (M1-3) does the same and also stores each
 * non-app unit's lowered IR; until the warm path lands it is still a
 * whole-program build — the design's fallback — so its output is identical to
 * a plain build's. A mode this compiler does not implement is refused rather
 * than silently falling back. */

export type UnitsMode = "observe" | "split";

/** The mode `value` spells, or null when it names none. */
export function parseUnitsMode(value: string | undefined): UnitsMode | null {
  if (value === "observe" || value === "split") return value;
  return null;
}

/** The mode this process's environment selects, or null. An unrecognized
 * value reads as null: the build's option check refuses it with the list of
 * modes. */
export function unitsMode(env: NodeJS.ProcessEnv = process.env): UnitsMode | null {
  return parseUnitsMode(env["SCRIPTC_UNITS"]);
}

/** Whether this lowering should collect the M0 observation. */
export function unitsObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return unitsMode(env) === "observe";
}

/** Whether this build collects the unit observation and stores unit entries,
 * in either mode: `observe` reports, `split` also stores each non-app unit's
 * IR for M1-3's warm build. */
export function unitsCollectingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = unitsMode(env);
  return mode === "observe" || mode === "split";
}

/** The raw environment value, for the option check's refusal text. */
export function unitsModeValue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["SCRIPTC_UNITS"];
}
