/** Reflection answers for builtin module namespaces (`in`, Object.keys,
 * hasOwnProperty) come from ONE census of Node's member surface, so every
 * module reports exactly what Node reports — including members the
 * lowerings do not implement yet — instead of the ambient subset the
 * lowering tables know about.
 *
 * A builtin module namespace has two runtime shapes, and they answer
 * differently:
 *   - the CommonJS exports object (`require("node:zlib")`, a default
 *     import, and every sub-namespace such as `fs.promises`): own
 *     enumerable keys in insertion order, every own name (enumerable or
 *     not) for ownership, and Object.prototype/Function.prototype (or an
 *     EventEmitter prototype, for node:process and node:cluster) for `in`;
 *   - an ECMAScript module namespace object (an `import * as ns` binding):
 *     the module's export names SORTED in code-unit order with "default"
 *     in place, a null prototype, and no hasOwnProperty at all. */
import {
  BUILTIN_MODULE_MEMBERS,
  type BuiltinModuleMemberCensus,
} from "./builtin-module-members.generated.js";

/** How a namespace expression names its module at run time. "unknown" is an
 * expression the type system describes as a builtin module namespace but
 * whose origin does not fix the shape (a parameter, the result of a call
 * the compiler does not trace), so no census answer applies: every table
 * below returns null for it and the caller keeps its fence. */
export type BuiltinModuleNamespaceFlavor = "cjs" | "esm" | "unknown";

/** Namespaces whose own members come from the platform's C library and
 * headers rather than from Node's JavaScript. node:constants merges the
 * dlopen, errno, priority and signals groups of os.constants with
 * fs.constants and crypto.constants, and those tables differ by platform:
 * Darwin has O_SYMLINK and RTLD_FIRST, Linux has O_NOATIME, O_DIRECT and
 * RTLD_DEEPBIND, Windows has UV_FS_O_FILEMAP. The census is one table
 * taken from the machine that generated it, so it cannot answer for a
 * program that runs somewhere else: these namespaces get no census answer
 * and the lowering keeps the runtime test, which asks the namespace the
 * program actually loaded. */
const PLATFORM_DEPENDENT_NAMESPACES: ReadonlySet<string> = new Set(["constants"]);

export function builtinModuleMemberCensus(module: string): BuiltinModuleMemberCensus | null {
  if (PLATFORM_DEPENDENT_NAMESPACES.has(module)) return null;
  return Object.hasOwn(BUILTIN_MODULE_MEMBERS, module)
    ? (BUILTIN_MODULE_MEMBERS[module] ?? null)
    : null;
}

/** An ESM namespace's key list: the CommonJS enumerable keys plus
 * "default", sorted by code unit. Cached — the answer depends only on the
 * module's census. */
const esmNames = new Map<string, readonly string[]>();

function builtinModuleEsmNames(
  module: string,
  census: BuiltinModuleMemberCensus,
): readonly string[] {
  const cached = esmNames.get(module);
  if (cached !== undefined) return cached;
  const names = [...census.keys, "default"].sort();
  esmNames.set(module, names);
  return names;
}

/** Object.keys over a builtin module namespace, in Node's order. */
export function builtinModuleKeys(
  module: string,
  flavor: BuiltinModuleNamespaceFlavor,
): readonly string[] | null {
  if (flavor === "unknown") return null;
  const census = builtinModuleMemberCensus(module);
  if (census === null) return null;
  return flavor === "esm" ? builtinModuleEsmNames(module, census) : census.keys;
}

/** Object.getOwnPropertyNames over a builtin module namespace, in Node's
 * order (an ESM namespace's exports are all own and enumerable). */
export function builtinModuleOwnNames(
  module: string,
  flavor: BuiltinModuleNamespaceFlavor,
): readonly string[] | null {
  if (flavor === "unknown") return null;
  const census = builtinModuleMemberCensus(module);
  if (census === null) return null;
  return flavor === "esm" ? builtinModuleEsmNames(module, census) : census.ownNames;
}

/** Every name `key in ns` can find: the own names, then (for a CommonJS
 * exports object) the inherited ones. */
const inNames = new Map<string, readonly string[]>();

export function builtinModuleInNames(
  module: string,
  flavor: BuiltinModuleNamespaceFlavor,
): readonly string[] | null {
  if (flavor === "unknown") return null;
  const census = builtinModuleMemberCensus(module);
  if (census === null) return null;
  if (flavor === "esm") return builtinModuleEsmNames(module, census);
  const cacheKey = `cjs:${module}`;
  const cached = inNames.get(cacheKey);
  if (cached !== undefined) return cached;
  const names = [...census.ownNames, ...census.inherited];
  inNames.set(cacheKey, names);
  return names;
}

const inNameSets = new Map<string, ReadonlySet<string>>();
const ownNameSets = new Map<string, ReadonlySet<string>>();

function nameSet(
  cache: Map<string, ReadonlySet<string>>,
  key: string,
  names: readonly string[],
): ReadonlySet<string> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const set = new Set(names);
  cache.set(key, set);
  return set;
}

/** `key in ns`. Null when the module is not in the census (the caller keeps
 * its fence). */
export function builtinModuleHasMember(
  module: string,
  flavor: BuiltinModuleNamespaceFlavor,
  key: string,
): boolean | null {
  const names = builtinModuleInNames(module, flavor);
  if (names === null) return null;
  return nameSet(inNameSets, `${flavor}:${module}`, names).has(key);
}

/** `ns.hasOwnProperty(key)`. Null when the module is not in the census. */
export function builtinModuleHasOwnMember(
  module: string,
  flavor: BuiltinModuleNamespaceFlavor,
  key: string,
): boolean | null {
  const names = builtinModuleOwnNames(module, flavor);
  if (names === null) return null;
  return nameSet(ownNameSets, `${flavor}:${module}`, names).has(key);
}
