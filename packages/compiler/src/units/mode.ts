/* SCRIPTC_UNITS selects the separate-compilation mode. M0 implements
 * `observe` only: it runs the ordinary whole-program build and, after
 * lowering, computes and stores the unit graph, keys and summaries without
 * changing the program's output. `split` (M1) and later modes change output
 * and are not implemented yet, so they are refused rather than silently
 * falling back to a whole-program build. */

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

/** The raw environment value, for the option check's refusal text. */
export function unitsModeValue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["SCRIPTC_UNITS"];
}

/** Why SCRIPTC_UNITS refuses this build, or null when it accepts it. Both
 * hosts call this before any work: a mode this build cannot honour (an
 * unknown value, `split`, which M0 does not implement, or any mode in a
 * release build) must fail the build on both the Node and the native
 * compiler, not silently fall back to whole-program compilation. */
export interface UnitsModeRefusal {
  message: string;
  hint: string;
}

export function unitsModeRefusal(
  optimization: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): UnitsModeRefusal | null {
  const raw = unitsModeValue(env);
  if (raw === undefined || raw === "") return null;
  const mode = parseUnitsMode(raw);
  if (mode === null)
    return {
      message: `SCRIPTC_UNITS=${JSON.stringify(raw)} is not a mode (supported: observe)`,
      hint: "Unset SCRIPTC_UNITS for a whole-program build.",
    };
  if ((optimization ?? "release") === "release")
    return {
      message: "SCRIPTC_UNITS is a development-build feature and a release build cannot use it",
      hint: "Build with --optimization=dev (or speed) to observe compilation units.",
    };
  if (mode === "split")
    return {
      message: "SCRIPTC_UNITS=split is not implemented yet; only observe mode exists",
      hint: "Use SCRIPTC_UNITS=observe, or unset SCRIPTC_UNITS.",
    };
  return null;
}
