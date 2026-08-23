import { InternalCompilerError } from "../errors.js";
/* IR ↔ JSON. The IR is plain JSON-safe data by construction; the value of
 * this module is the version fence and the finiteness assertion (numLit
 * holds a JS number — NaN/Infinity literals cannot appear in source, but
 * a frontend bug producing one must not silently become `null` in JSON).
 */
import type { IrModule } from "./nodes.js";

export const IR_VERSION = 6 as const;

export function serializeModule(mod: IrModule): string {
  return JSON.stringify(mod, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      // ±Infinity numLits are real (the global `Infinity`); JSON cannot
      // spell them, so they ride a sentinel object no other IR value can
      // be (numbers never serialize as objects). NaN stays a bug.
      if (Number.isNaN(value)) throw new InternalCompilerError("IR contains NaN; refusing to serialize");
      return { $nonfinite: value > 0 ? "inf" : "-inf" };
    }
    // JSON.stringify(-0) prints "0", silently losing the sign a numLit's
    // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
    // the same sentinel mechanism carries it.
    if (typeof value === "number" && Object.is(value, -0)) {
      return { $nonfinite: "-0" };
    }
    return value;
  }, 2);
}

export function deserializeModule(json: string): IrModule {
  const mod = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$nonfinite" in value) {
      const tag = (value as { $nonfinite: string }).$nonfinite;
      return tag === "inf" ? Infinity : tag === "-0" ? -0 : -Infinity;
    }
    return value;
  }) as IrModule;
  if (mod.irVersion !== IR_VERSION) {
    throw new Error(
      `IR version mismatch: file has ${String(mod.irVersion)}, compiler expects ${IR_VERSION}`,
    );
  }
  return mod;
}
