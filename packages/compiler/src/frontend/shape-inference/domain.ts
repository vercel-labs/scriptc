/* Shape inference (results/design-shape-inference/DESIGN.md), stage S1:
 * the abstract domain of the allocation-site points-to analysis.
 *
 * An abstract value is a set of atoms. An atom names a set of runtime
 * values: a primitive kind, an allocation site (object or array literal, or
 * a value a builtin creates at one call site), the instances of one class,
 * one class value, one function (closure site), a builtin object, or ⊤ —
 * every value the analysis does not track. Value nodes hold atom sets and
 * flow into each other along inclusion edges; the solver (analyze.ts)
 * attaches load, store and call constraints that fire as atoms arrive. */
import type * as ts from "../ts7/adapter.js";

export type AtomKind =
  | "prim"
  | "top"
  | "object"
  | "array"
  | "instance"
  | "class"
  | "function"
  | "builtin"
  | "promise"
  | "collection"
  | "dictionary";

export interface Atom {
  readonly id: number;
  readonly kind: AtomKind;
  /** Short display name, e.g. `string`, `ZodString`, `{status,value}@types.js:804`. */
  readonly label: string;
  /** The syntax that creates the atom: the literal, class or function
   * declaration, or the builtin call. Undefined for prims, ⊤ and builtins. */
  readonly node?: ts.Node | undefined;
  /** builtin atoms: the dotted path (`Object.keys`, `array.push`). */
  readonly path?: string | undefined;
  /** method atoms of builtin receivers: the receiver atom. */
  readonly receiver?: Atom | undefined;
  /** function atoms: the analysis context of the function's clone (a
   * method's receiver class), "" for the context-insensitive default. */
  readonly ctx?: string | undefined;
}

export class AtomTable {
  readonly atoms: Atom[] = [];
  private readonly byKey = new Map<string, Atom>();

  intern(key: string, make: (id: number) => Omit<Atom, "id">): Atom {
    let atom = this.byKey.get(key);
    if (atom === undefined) {
      const id = this.atoms.length;
      atom = { id, ...make(id) };
      this.atoms.push(atom);
      this.byKey.set(key, atom);
    }
    return atom;
  }
}

/** Object.prototype members: a read of one of these names on a plain
 * object resolves on the prototype, never to an absent own key. */
export const OBJECT_PROTOTYPE_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
]);

/** Global names the analysis models as builtin objects. Any other global is ⊤. */
export const MODELED_GLOBALS: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Date",
  "RegExp",
  "console",
  "Reflect",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "BigInt",
  "Proxy",
]);

/** Results of string (and number) methods, by name. Anything else is ⊤. */
type MethodResult = "string" | "number" | "boolean" | "array";
export const STRING_METHOD_RESULTS: ReadonlyMap<string, MethodResult> = new Map<
  string,
  MethodResult
>([
  ["at", "string"],
  ["charAt", "string"],
  ["charCodeAt", "number"],
  ["codePointAt", "number"],
  ["concat", "string"],
  ["endsWith", "boolean"],
  ["includes", "boolean"],
  ["indexOf", "number"],
  ["lastIndexOf", "number"],
  ["localeCompare", "number"],
  ["match", "array"],
  ["matchAll", "array"],
  ["normalize", "string"],
  ["padEnd", "string"],
  ["padStart", "string"],
  ["repeat", "string"],
  ["replace", "string"],
  ["replaceAll", "string"],
  ["search", "number"],
  ["slice", "string"],
  ["split", "array"],
  ["startsWith", "boolean"],
  ["substring", "string"],
  ["substr", "string"],
  ["toLowerCase", "string"],
  ["toUpperCase", "string"],
  ["toLocaleLowerCase", "string"],
  ["toLocaleUpperCase", "string"],
  ["toString", "string"],
  ["trim", "string"],
  ["trimEnd", "string"],
  ["trimStart", "string"],
  ["valueOf", "string"],
  ["test", "boolean"],
  ["toFixed", "string"],
  ["toPrecision", "string"],
  ["toExponential", "string"],
]);
