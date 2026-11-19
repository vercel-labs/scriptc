/* A unit's lowered IR, stored for M1-3's warm build.
 *
 * A cold split build lowers the whole program as today and then cuts each
 * non-app unit's part out of the finished module: the functions whose source
 * files are the unit's, and every module-level entry they name (globals,
 * class definitions, record shapes, unions), closed transitively. The slice
 * encodes with the IR codec's module encoding (ir/codec.ts), the same bytes a
 * whole module would use, so a reader needs no new decoder.
 *
 * Module-level state that is not a named entry (lifetime regions, record
 * links, the program's own fields) stays out: it is program-wide, and a warm
 * build regenerates it over the full module it splices the slices into.
 *
 * Nothing here decides whether a stored unit may be reused; that is the pin
 * vector's job (units/observe.ts). This module only slices, validates and
 * encodes. */

import { createHash } from "node:crypto";
import { decodeModuleBinary, encodeModuleBinary } from "../ir/codec.js";
import type {
  IrClassDef,
  IrFunction,
  IrGlobal,
  IrModule,
  IrRecordShape,
  IrUnionDef,
} from "../ir/ir.js";

/** Functions the build makes for the whole program rather than for a unit:
 * the class-dispatch helpers, the class tables and per-method-value helpers,
 * spread helpers and the generator dispatch. Their bodies and names come from
 * every unit's classes and from the program's sites, every build regenerates
 * them, and a stored unit neither defines them nor may reuse them. Pins and
 * stored IR slices both leave them out. */
const PROGRAM_WIDE_HELPER_PREFIXES = ["%dyn.", "%class.", "%method.", "%prototype.", "%spread."];

export function isProgramWideHelperName(name: string): boolean {
  return PROGRAM_WIDE_HELPER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The schema tag a stored slice's metadata carries. */
export const UNIT_IR_SCHEMA = "scriptc.unit-ir.v1";

/** The module-level entries a set of IR values names. */
export interface UnitIrReferences {
  readonly globals: ReadonlySet<string>;
  readonly classes: ReadonlySet<string>;
  readonly records: ReadonlySet<string>;
  readonly unions: ReadonlySet<string>;
}

/** One unit's IR, ready to store. */
export interface UnitIrSlice {
  /** The module encoding of the slice. */
  bytes: Buffer;
  /** sha256 of `bytes`. */
  digest: string;
  functions: readonly string[];
  globals: readonly string[];
  classes: readonly string[];
  records: readonly string[];
  unions: readonly string[];
}

/** Mutable collector for the walk below. */
class References {
  readonly globals = new Set<string>();
  readonly classes = new Set<string>();
  readonly records = new Set<string>();
  readonly unions = new Set<string>();
}

/** Every module-level name `value` refers to. IR refers to a module global
 * through a `varRef`'s `localId` (the `%g.` namespace), to a class through
 * `className`, and to a record shape or union through `shapeId`/`unionId`. A
 * class's `base` and a global's `initFlag` are bare strings, so the walk
 * collects them only when it visits the entry itself (see `addEntry`). */
function collectReferences(value: unknown, out: References, seen: Set<unknown>): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, out, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const field = record[key];
    if (typeof field === "string") {
      if (key === "localId" && field.startsWith("%g.")) out.globals.add(field);
      else if (key === "className") out.classes.add(field);
      else if (key === "shapeId") out.records.add(field);
      else if (key === "unionId") out.unions.add(field);
      continue;
    }
    collectReferences(field, out, seen);
  }
}

/** Adds a class definition and its bare-string references. */
function addClass(def: IrClassDef, out: References): void {
  collectReferences(def, out, new Set());
  if (def.base !== undefined) out.classes.add(def.base);
  if (def.baseValueGlobal !== undefined) out.globals.add(def.baseValueGlobal);
}

/** Adds a global and its bare-string references. */
function addGlobal(def: IrGlobal, out: References): void {
  collectReferences(def, out, new Set());
  if (def.initFlag !== undefined) out.globals.add(def.initFlag);
}

/** Pushes `entry` when its name is wanted and it is not held yet. */
function take<T>(
  held: Map<string, T>,
  name: string,
  wanted: ReadonlySet<string>,
  entry: T | undefined,
): boolean {
  if (entry === undefined || held.has(name) || !wanted.has(name)) return false;
  held.set(name, entry);
  return true;
}

/** The unit's IR as a module slice, or null when the unit defines no
 * function (nothing to store: its lowered output is empty).
 *
 * `relativeOf` maps an absolute source file to its package-relative module
 * path; `modules` are the unit's files. A class definition carries no source
 * file of its own, so a class the unit declares is named in `ownClasses`. */
export function unitModuleSlice(
  module: IrModule,
  modules: ReadonlySet<string>,
  relativeOf: (file: string) => string | undefined,
  ownClasses: ReadonlySet<string>,
): UnitIrSlice | null {
  const functions: IrFunction[] = [];
  for (const fn of module.functions) {
    // Program-wide helpers are the build's, not the unit's (see
    // isProgramWideHelperName); the pins leave them out for the same reason.
    if (isProgramWideHelperName(fn.name)) continue;
    const at = relativeOf(fn.loc.file);
    if (at !== undefined && modules.has(at)) functions.push(fn);
  }
  if (functions.length === 0) return null;
  const refs = new References();
  for (const fn of functions) collectReferences(fn, refs, new Set());
  for (const name of ownClasses) refs.classes.add(name);

  const globals = new Map<string, IrGlobal>();
  const classes = new Map<string, IrClassDef>();
  const records = new Map<string, IrRecordShape>();
  const unions = new Map<string, IrUnionDef>();
  const globalDefs = new Map((module.globals ?? []).map((entry) => [entry.id, entry]));
  const classDefs = new Map((module.classes ?? []).map((entry) => [entry.name, entry]));
  const recordDefs = new Map((module.records ?? []).map((entry) => [entry.id, entry]));
  const unionDefs = new Map((module.unions ?? []).map((entry) => [entry.id, entry]));
  // Close over everything the included entries name: a class's base, a
  // global's init flag, a record field's shape, a union arm's shape.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...refs.globals]) {
      const entry = globalDefs.get(id);
      if (entry !== undefined && take(globals, id, refs.globals, entry)) {
        addGlobal(entry, refs);
        changed = true;
      }
    }
    for (const name of [...refs.classes]) {
      const entry = classDefs.get(name);
      if (entry !== undefined && take(classes, name, refs.classes, entry)) {
        addClass(entry, refs);
        changed = true;
      }
    }
    for (const id of [...refs.records]) {
      const entry = recordDefs.get(id);
      if (entry !== undefined && take(records, id, refs.records, entry)) {
        collectReferences(entry, refs, new Set());
        changed = true;
      }
    }
    for (const id of [...refs.unions]) {
      const entry = unionDefs.get(id);
      if (entry !== undefined && take(unions, id, refs.unions, entry)) {
        collectReferences(entry, refs, new Set());
        changed = true;
      }
    }
  }
  const sorted = <T>(held: Map<string, T>): T[] =>
    [...held.keys()].sort((a, b) => a.localeCompare(b)).map((name) => held.get(name)!);
  const slice: IrModule = {
    irVersion: module.irVersion,
    sourceFile: "",
    functions,
    ...(classes.size === 0 ? {} : { classes: sorted(classes) }),
    ...(globals.size === 0 ? {} : { globals: sorted(globals) }),
    ...(records.size === 0 ? {} : { records: sorted(records) }),
    ...(unions.size === 0 ? {} : { unions: sorted(unions) }),
    entry: "",
  };
  // A slice that cannot round-trip is not stored: the warm build would splice
  // functions whose entries are missing.
  const bytes = encodeModuleBinary(slice);
  const back = decodeModuleBinary(bytes);
  const missing = missingUnitIrReferences(back);
  if (missing.length > 0)
    throw new Error(`a unit's IR slice does not round-trip: it names ${missing.join(", ")}`);
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    functions: functions.map((fn) => fn.name).sort((a, b) => a.localeCompare(b)),
    globals: [...globals.keys()].sort((a, b) => a.localeCompare(b)),
    classes: [...classes.keys()].sort((a, b) => a.localeCompare(b)),
    records: [...records.keys()].sort((a, b) => a.localeCompare(b)),
    unions: [...unions.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

/** The names a slice's IR refers to that the slice does not hold. A slice a
 * warm build splices must answer with none. */
export function missingUnitIrReferences(module: IrModule): string[] {
  const refs = new References();
  for (const fn of module.functions) collectReferences(fn, refs, new Set());
  for (const def of module.classes ?? []) addClass(def, refs);
  for (const def of module.globals ?? []) addGlobal(def, refs);
  for (const def of module.records ?? []) collectReferences(def, refs, new Set());
  for (const def of module.unions ?? []) collectReferences(def, refs, new Set());
  const globals = new Set((module.globals ?? []).map((entry) => entry.id));
  const classes = new Set((module.classes ?? []).map((entry) => entry.name));
  const records = new Set((module.records ?? []).map((entry) => entry.id));
  const unions = new Set((module.unions ?? []).map((entry) => entry.id));
  const missing: string[] = [];
  for (const id of refs.globals) if (!globals.has(id)) missing.push(`global ${id}`);
  for (const name of refs.classes) if (!classes.has(name)) missing.push(`class ${name}`);
  for (const id of refs.records) if (!records.has(id)) missing.push(`record ${id}`);
  for (const id of refs.unions) if (!unions.has(id)) missing.push(`union ${id}`);
  return missing.sort((a, b) => a.localeCompare(b));
}
