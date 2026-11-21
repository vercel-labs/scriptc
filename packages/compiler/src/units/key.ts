/* The unit key: content-addressed identity of one unit's inputs.
 *
 * sha256 over canonical JSON of the schema, the compiler implementation
 * digest, the target triple and optimization, the options that reach
 * lowering, the FFI profile when one is present, the frontend environment,
 * the unit's files (package-relative path, content digest), and each
 * dependency's SUMMARY DIGEST — not its key. A dependency rebuilt with an
 * identical summary therefore leaves its consumers' keys unchanged.
 *
 * Nothing absolute enters the key: file entries are package-relative and the
 * dependency entries name units and digests. */

import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalValue } from "./canonical.js";

export const UNIT_KEY_SCHEMA = "scriptc.unit-key.v0";

/** Arbitrary option data as a canonical JSON value: primitives stay, arrays
 * and plain objects recurse, and anything else (a function, a symbol, a
 * class instance) is dropped the way JSON.stringify drops it. */
export function jsonValue(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object": {
      if (Array.isArray(value)) return value.map((item: unknown) => jsonValue(item));
      const record = value as Record<string, unknown>;
      const out: { [key: string]: CanonicalValue } = {};
      for (const key of Object.keys(record)) {
        if (record[key] === undefined) continue;
        out[key] = jsonValue(record[key]);
      }
      return out;
    }
    default:
      return null;
  }
}

/** Option fields that name a path rather than a value. A path is not part of
 * a unit's identity (two copies of one app in two directories must agree),
 * They reach emission or linking, not a unit's lowering: the FFI profile's
 * semantic surface is in the key as `ffiDigest`, and a function layout, PGO
 * profile or libnode directory changes the executable, not the unit summary.
 * They are left out so no absolute path can enter the key. */
const PATH_VALUED_OPTIONS: ReadonlySet<string> = new Set([
  "ffiProfilePath",
  "functionLayout",
  "profileUse",
  "profileGenerate",
  "libnode",
]);

/** The lowering options as canonical key data: JSON values, sorted keys, no
 * path-valued fields. */
export function loweringKeyValue(lowering: Record<string, unknown>): CanonicalValue {
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(lowering).sort()) {
    if (PATH_VALUED_OPTIONS.has(key)) continue;
    const value = lowering[key];
    if (value === undefined) continue;
    out[key] = jsonValue(value);
  }
  return out;
}

/** The FFI profile's semantic digest: format, functions, system libraries and
 * frameworks. The manifest's `libraries` are absolute object paths an app's
 * build directory owns; they reach the link, not a unit's lowering, so they
 * are left out (the same reason path-valued options are). */
export function ffiProfileDigest(profile: {
  ffiFormat: number;
  functions: unknown;
  systemLibraries: readonly string[];
  frameworks?: readonly string[] | undefined;
}): string {
  return digestOfText(
    canonicalJson({
      format: profile.ffiFormat,
      functions: jsonValue(profile.functions),
      systemLibraries: [...profile.systemLibraries],
      frameworks: [...(profile.frameworks ?? [])],
    }),
  );
}

/** Everything a unit's key is a function of. */
export interface UnitKeyInput {
  compiler: string | null;
  /** The target triple (or the build platform when no triple is known). */
  target: string;
  optimization: string;
  /** The options that reach lowering, canonical (loweringKeyValue). */
  lowering: CanonicalValue;
  /** The FFI profile's bytes digest, or null. */
  ffi: string | null;
  /** `frontendEnvironment()`: the SCRIPTC_* variables the frontend's output
   * can depend on. */
  environment: readonly (readonly [string, string])[];
  /** `[package-relative path, sha256(content)]`, sorted by path. */
  files: readonly (readonly [string, string])[];
  /** `[dependency unit id, its summary digest]`, in topological order. */
  dependencies: readonly (readonly [string, string])[];
}

/** The canonical payload the key hashes, by field. */
function keyPayload(input: UnitKeyInput): { [key: string]: CanonicalValue } {
  return {
    schema: UNIT_KEY_SCHEMA,
    compiler: input.compiler,
    target: input.target,
    optimization: input.optimization,
    lowering: input.lowering,
    ffi: input.ffi,
    environment: input.environment.map(([name, value]) => [name, value]),
    files: input.files.map(([path, digest]) => [path, digest]),
    dependencies: input.dependencies.map(([id, digest]) => [id, digest]),
  };
}

/** The unit's key, in hex. */
export function unitKey(input: UnitKeyInput): string {
  return createHash("sha256")
    .update(canonicalJson(keyPayload(input)))
    .digest("hex");
}

/** Each payload field's digest, for the meta entry: two stores whose keys
 * differ can be compared field by field (the leak report's key diagnosis). */
export function unitKeyParts(input: UnitKeyInput): { [key: string]: string } {
  const payload = keyPayload(input);
  const out: { [key: string]: string } = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value === undefined) continue;
    out[key] = digestOfText(canonicalJson(value));
  }
  return out;
}

/** The summary's digest, from its canonical text. */
export function digestOfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
