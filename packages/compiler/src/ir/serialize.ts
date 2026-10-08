/* IR ↔ JSON. Numeric literals preserve JavaScript's complete number domain:
 * JSON's null/zero spellings must not erase NaN, infinities or negative zero. */
import type { IrModule } from "./ir.js";

// Version 15 expands the native Error prefix with filesystem metadata.
// Older modules embed incompatible subclass offsets and must be rejected.
export const IR_VERSION = 15 as const;

/** IR artifacts are plain data. Scan each function once before deciding
 * whether its JSON encoding needs the complete-number-domain replacer. */
function ordinaryNumbers(root: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value === "function") return false;
    if (value === null || typeof value !== "object") return true;
    if (seen.has(value)) return true;
    seen.add(value);
    if (Array.isArray(value)) return value.every(visit);
    return Object.values(value as Record<string, unknown>).every(visit);
  };
  return visit(root);
}

/** Compiler artifacts use compact JSON to keep large graphs below the host's
 * string size limit. API consumers can retain the readable default. */
export function serializeModule(mod: IrModule, compact = false): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value)) {
      return { $nonfinite: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
    }
    // JSON.stringify(-0) prints "0", silently losing the sign a numLit's
    // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
    // the same sentinel mechanism carries it.
    if (Object.is(value, -0)) {
      return { $nonfinite: "-0" };
    }
    return value;
  };
  if (!compact) return JSON.stringify(mod, replacer, 2);
  // A replacer reads through live native views. Serializing the complete
  // function array through one view refreshes every function capsule for
  // each element, making large compiler artifacts quadratic. The sentinel
  // replacer is key-independent, so encode each function as its own root.
  const header = JSON.stringify({ ...mod, functions: [] }, replacer);
  const slot = '"functions":[]';
  const offset = header.indexOf(slot);
  const functions = mod.functions
    .map(
      (fn) => (ordinaryNumbers(fn) ? JSON.stringify(fn) : JSON.stringify(fn, replacer)) ?? "null",
    )
    .join(",");
  return (
    header.slice(0, offset) + '"functions":[' + functions + "]" + header.slice(offset + slot.length)
  );
}

export function deserializeModule(json: string): IrModule {
  const mod = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$nonfinite" in value) {
      const tag = (value as { $nonfinite: string }).$nonfinite;
      if (tag === "inf") return Infinity;
      if (tag === "-inf") return -Infinity;
      if (tag === "-0") return -0;
      if (tag === "nan") return NaN;
      throw new Error(`Invalid IR number sentinel: ${String(tag)}`);
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
