/* The Node island boundary (DESIGN.md §2.4–§2.5, scope-B NI-4): which
 * values of a compiled program are island values, and what crosses by
 * copy. Rule (decision 2): a value crosses by reference unless copying it
 * is unobservable. Primitives and strings are copied; every object stays a
 * handle whose identity is the V8 object's.
 *
 * Island values are typed by the island package's own declarations. A
 * checker type is FOREIGN when it is an object type declared in an island
 * package (its .d.ts, or its @types twin): a class, interface, type alias
 * or type literal there, the type of an exported function or class value,
 * or an island module's namespace. Values of foreign types are held as
 * island handles (the `foreign` IR type, represented as a dyn value), and
 * member operations on them compile from the declarations into bridge
 * calls. A union is foreign when every arm that is not null or undefined
 * is foreign (the dyn representation holds null and undefined). */
import * as ts from "../frontend/ts7/adapter.js";
import { packageDirOf } from "./origin.js";

/** One package the build runs in a Node island. */
export interface IslandPackage {
  name: string;
  version: string | null;
  /** The package directory (…/node_modules/<name>). */
  dir: string;
  /** The island class (runtime, object-model, gap, packaging) and the first
   * reason, for the SC8001 note. */
  class: string;
  reason: string;
}

/** The program's island packages, by package name. */
export interface NodeIslandSet {
  packages: ReadonlyMap<string, IslandPackage>;
}

/** The island package that owns a declaration or JavaScript file, or null.
 * `@types/<name>` declarations type the package `<name>`. */
export function islandPackageOfFile(islands: NodeIslandSet, file: string): IslandPackage | null {
  const at = packageDirOf(file);
  if (at === null) return null;
  let name = at.name;
  if (name.startsWith("@types/")) {
    const bare = name.slice("@types/".length);
    name = bare.includes("__") ? `@${bare.replace("__", "/")}` : bare;
  }
  return islands.packages.get(name) ?? null;
}

/* Native classes extending island classes (scope-B NI-5b): their class
 * values and instances are island objects, so their types are foreign.
 * Registered by the lowering's module split before any type maps. */
const islandSubclassDecls = new Set<ts.Node>();

export function markIslandSubclass(decl: ts.ClassDeclaration): void {
  islandSubclassDecls.add(decl);
}

export function isIslandSubclassDecl(decl: ts.Node | undefined): boolean {
  return decl !== undefined && islandSubclassDecls.has(decl);
}

function declaredInIsland(islands: NodeIslandSet, symbol: ts.Symbol | null | undefined): boolean {
  if (!symbol) return false;
  const decls = symbol.declarations;
  if (decls.length === 0) return false;
  if (islandSubclassDecls.size > 0 && decls.some((d) => islandSubclassDecls.has(d))) return true;
  return decls.every(
    (d) => islandPackageOfFile(islands, ts.getSourceFileOfNode(d).fileName) !== null,
  );
}

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/** Whether values of `type` are island handles (see the header). An
 * anonymous object type every property of which the island declares (the
 * namespace TypeScript synthesizes for `import()` of a CommonJS island
 * module) is foreign too. */
export function isForeignType(
  islands: NodeIslandSet,
  type: ts.Type,
  checker?: ts.TypeChecker,
): boolean {
  if (type.isUnionType()) {
    const arms = ts.constituentTypes(type).filter((t) => (t.flags & NULLISH) === 0);
    return arms.length > 0 && arms.every((t) => isForeignType(islands, t, checker));
  }
  // An intersection the island declares (execa's `ChildProcess &
  // ExecaChildPromise & Promise<…>`), or one with an island-declared arm,
  // is made by island code: its values are island objects.
  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    if (declaredInIsland(islands, type.getAliasSymbol())) return true;
    return ts.constituentTypes(type).some((t) => isForeignType(islands, t, checker));
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (
    declaredInIsland(islands, type.getAliasSymbol()) ||
    declaredInIsland(islands, type.getSymbol())
  )
    return true;
  if (checker === undefined || type.getAliasSymbol()) return false;
  const symbol = type.getSymbol();
  if (symbol && symbol.declarations.length > 0) return false;
  // Synthetic members (the interop `default`) have no declarations.
  let declared = 0;
  for (const p of checker.getPropertiesOfType(type)) {
    if (p.declarations.length === 0) continue;
    if (!declaredInIsland(islands, p)) return false;
    declared++;
  }
  return declared > 0;
}

/** How a value of a checker type crosses INTO an island as an argument or
 * an assigned value: copied (primitives, strings, null/undefined), passed
 * as its handle (foreign), passed as a dyn value the runtime converts
 * (any/unknown: a handle crosses as its object, a primitive is copied, a
 * fresh literal is copied), or not representable yet. */
export type BoundaryCrossing = "copy" | "handle" | "dyn" | "refused";

const COPIED =
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.StringLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void;

export function crossingOf(
  islands: NodeIslandSet,
  type: ts.Type,
  checker?: ts.TypeChecker,
): BoundaryCrossing {
  if (type.isUnionType()) {
    const arms = ts.constituentTypes(type);
    if (arms.every((t) => (t.flags & COPIED) !== 0)) return "copy";
    if (isForeignType(islands, type, checker)) return "handle";
    return "refused";
  }
  if ((type.flags & COPIED) !== 0) return "copy";
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return "dyn";
  if (isForeignType(islands, type, checker)) return "handle";
  return "refused";
}

/* The island set of the lowering in progress. lowerToIr sets it from its
 * options for the duration of one synchronous lowering; every Lowerer it
 * creates reads it at construction. Null in programs without islands, so
 * their lowering is unchanged. */
let active: NodeIslandSet | null = null;

export function setActiveNodeIslands(islands: NodeIslandSet | null): void {
  active = islands !== null && islands.packages.size > 0 ? islands : null;
}

export function activeNodeIslands(): NodeIslandSet | null {
  return active;
}

/* The island package names of the frontend load in progress (runFrontend
 * sets them for one synchronous load): preflight lets their imports
 * through, typed by their declarations. */
let frontendIslands: ReadonlySet<string> = new Set();

export function setFrontendIslands(names: ReadonlySet<string>): void {
  frontendIslands = names;
}

export function isFrontendIsland(pkg: string): boolean {
  return frontendIslands.size > 0 && frontendIslands.has(pkg);
}
