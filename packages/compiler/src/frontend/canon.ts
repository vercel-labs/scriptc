/* Canonical type normalization (localized-failure design part 2, §4),
 * stage N0: report-only. Nothing in the compiler consumes it yet.
 *
 * `canon(type, env)` resolves a checker type, under the current generic
 * bindings, to a small set of canonical shapes: primitive, literal, unit,
 * top, object (nominal or structural, with lazily resolved members), array,
 * tuple, flat union, unbound parameter, and an opaque leaf for what it
 * cannot reduce. The per-form rules of type-mapper.ts (generic aliases,
 * equal-member intersections, narrowed parameters, recursive placeholders)
 * are what this replaces family by family in later stages; N1 runs it in
 * shadow mode beside mapType, N2 as mapType's fallback.
 *
 * Nodes intern by checker type identity and the bindings of the type
 * parameters the walk consulted, so a recursive type closes on itself once
 * (a back-reference returns the node under construction). */
import * as ts from "./ts7/adapter.js";

export type CanonPrim = "number" | "string" | "boolean" | "bigint" | "symbol";

export interface CanonProp {
  name: string;
  optional: boolean;
  readonly: boolean;
  type: () => Canon;
}

export interface CanonSig {
  params: { name: string; optional: boolean; rest: boolean; type: () => Canon }[];
  ret: () => Canon;
  /** The signature keeps type parameters of its own. */
  generic: boolean;
}

export interface CanonIndex {
  key: Canon;
  value: () => Canon;
}

export interface AliasRef {
  name: string;
  args: readonly Canon[];
  /** The checker type the alias reference came from (identity preserved
   * for tables keyed by ts.Type, such as boundAliasInstances). */
  tsType: ts.Type;
}

export type Canon = CanonNode & {
  /** The checker type the node was normalized from (a type parameter's
   * binding for substituted parameters). */
  src?: ts.Type;
};

type CanonNode =
  | { k: "prim"; p: CanonPrim }
  | { k: "lit"; value: string | number | boolean }
  | { k: "unit"; u: "undefined" | "null" | "void" | "never" }
  | { k: "top"; t: "unknown" | "any" | "object" }
  | {
      k: "obj";
      /** Class or standard-library declaration name, when nominal. */
      nominal?: string;
      /** The type arguments of a nominal generic instantiation. */
      typeArgs: () => readonly Canon[];
      alias?: AliasRef;
      props: () => readonly CanonProp[];
      index: () => readonly CanonIndex[];
      call: () => readonly CanonSig[];
      construct: () => readonly CanonSig[];
    }
  | { k: "array"; elem: Canon; readonly: boolean }
  | { k: "tuple"; elems: readonly { type: Canon; optional: boolean; rest: boolean }[] }
  | { k: "union"; arms: readonly Canon[] }
  | { k: "param"; name: string }
  | { k: "opaque"; ts: ts.Type; reason: string };

/** Type-parameter bindings: the checker type a parameter is bound to, by
 * the parameter's symbol, or a resolver over the parameter type (the
 * lowerer's resolveTypeParamTs). */
export type CanonEnv = ReadonlyMap<ts.Symbol, ts.Type> | ((param: ts.Type) => ts.Type | null);

const PRIM_FLAGS: readonly [number, CanonPrim][] = [
  [ts.TypeFlags.Number, "number"],
  [ts.TypeFlags.String, "string"],
  [ts.TypeFlags.Boolean, "boolean"],
  [ts.TypeFlags.BigInt, "bigint"],
  [ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol, "symbol"],
];

/** A stable key for a canonical node, for deduplication and tests. Deep
 * and wide types are cut off (depth 6, about 4,000 characters), so equal
 * keys mean equal up to that horizon. */
export function canonKey(c: Canon): string {
  const budget = { left: 4000 };
  return canonKeyAt(c, 0, budget);
}

function canonKeyAt(c: Canon, depth: number, budget: { left: number }): string {
  const key = canonKeyInner(c, depth, budget);
  budget.left -= key.length;
  return key;
}

function canonKeyInner(c: Canon, depth: number, budget: { left: number }): string {
  if (depth > 6 || budget.left <= 0) return "…";
  const canonKey = (n: Canon, d: number) => canonKeyAt(n, d, budget);
  switch (c.k) {
    case "prim":
      return c.p;
    case "lit":
      return JSON.stringify(c.value);
    case "unit":
      return c.u;
    case "top":
      return c.t;
    case "param":
      return `param ${c.name}`;
    case "opaque":
      return `opaque(${c.reason})`;
    case "array":
      return `${c.readonly ? "readonly " : ""}${canonKey(c.elem, depth + 1)}[]`;
    case "tuple":
      return `[${c.elems.map((e) => `${e.rest ? "..." : ""}${canonKey(e.type, depth + 1)}${e.optional ? "?" : ""}`).join(", ")}]`;
    case "union":
      return c.arms.map((a) => canonKey(a, depth + 1)).join(" | ");
    case "obj": {
      if (c.nominal !== undefined) {
        const args = c.typeArgs();
        return args.length === 0
          ? c.nominal
          : `${c.nominal}<${args.map((a) => canonKey(a, depth + 1)).join(", ")}>`;
      }
      const props = c
        .props()
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${canonKey(p.type(), depth + 1)}`);
      const sig = (s: CanonSig): string =>
        `(${s.params
          .map(
            (p) => `${p.rest ? "..." : ""}${p.optional ? "?" : ""}${canonKey(p.type(), depth + 1)}`,
          )
          .join(", ")}) => ${canonKey(s.ret(), depth + 1)}`;
      const calls = c.call().map(sig);
      const constructs = c.construct().map((s) => `new ${sig(s)}`);
      const index = c
        .index()
        .map((i) => `[${canonKey(i.key, depth + 1)}]: ${canonKey(i.value(), depth + 1)}`);
      return `{ ${[...calls, ...constructs, ...index, ...props].join("; ")} }`;
    }
  }
}

/** The pairs a comparison takes as equal while it runs, and the order they
 * were assumed in, so that a failed comparison withdraws what it assumed. */
interface Assumptions {
  pairs: Map<Canon, Set<Canon>>;
  trail: [Canon, Canon][];
}

/** Whether two canonical nodes are the same type, structurally: unlike
 * canonKey, every part is compared (signature parameters, index
 * signatures, type arguments, any depth). A pair met again while it is
 * being compared is taken as equal, which closes the comparison of
 * recursive types; when the comparison fails, the pairs assumed during it
 * are withdrawn. */
export function canonEqual(
  a: Canon,
  b: Canon,
  assumed: Assumptions = { pairs: new Map(), trail: [] },
): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  let pairs = assumed.pairs.get(a);
  if (pairs?.has(b)) return true;
  if (pairs === undefined) assumed.pairs.set(a, (pairs = new Set()));
  const mark = assumed.trail.length;
  pairs.add(b);
  assumed.trail.push([a, b]);
  const equal = sameCanon(a, b, assumed);
  if (!equal)
    while (assumed.trail.length > mark) {
      const [x, y] = assumed.trail.pop()!;
      assumed.pairs.get(x)!.delete(y);
    }
  return equal;
}

function sameCanon(a: Canon, b: Canon, assumed: Assumptions): boolean {
  const eq = (x: Canon, y: Canon): boolean => canonEqual(x, y, assumed);
  const sigsEqual = (xs: readonly CanonSig[], ys: readonly CanonSig[]): boolean =>
    xs.length === ys.length &&
    xs.every((x, i) => {
      const y = ys[i]!;
      return (
        x.generic === y.generic &&
        x.params.length === y.params.length &&
        x.params.every(
          (p, j) =>
            p.optional === y.params[j]!.optional &&
            p.rest === y.params[j]!.rest &&
            eq(p.type(), y.params[j]!.type()),
        ) &&
        eq(x.ret(), y.ret())
      );
    });
  switch (a.k) {
    case "prim":
      return a.p === (b as typeof a).p;
    case "lit":
      return a.value === (b as typeof a).value;
    case "unit":
      return a.u === (b as typeof a).u;
    case "top":
      return a.t === (b as typeof a).t;
    case "param":
      return a.name === (b as typeof a).name;
    case "opaque":
      return a.ts === (b as typeof a).ts;
    case "array": {
      const o = b as typeof a;
      return a.readonly === o.readonly && eq(a.elem, o.elem);
    }
    case "tuple": {
      const o = b as typeof a;
      return (
        a.elems.length === o.elems.length &&
        a.elems.every(
          (e, i) =>
            e.optional === o.elems[i]!.optional &&
            e.rest === o.elems[i]!.rest &&
            eq(e.type, o.elems[i]!.type),
        )
      );
    }
    case "union": {
      const o = b as typeof a;
      return (
        a.arms.length === o.arms.length &&
        a.arms.every((x) => o.arms.some((y) => eq(x, y))) &&
        o.arms.every((y) => a.arms.some((x) => eq(x, y)))
      );
    }
    case "obj": {
      const o = b as typeof a;
      if (a.nominal !== o.nominal) return false;
      if (a.nominal !== undefined) {
        const ax = a.typeArgs();
        const ox = o.typeArgs();
        return ax.length === ox.length && ax.every((x, i) => eq(x, ox[i]!));
      }
      const ap = a.props();
      const op = o.props();
      if (ap.length !== op.length) return false;
      for (const p of ap) {
        const q = op.find((x) => x.name === p.name);
        if (q === undefined || q.optional !== p.optional || !eq(p.type(), q.type())) return false;
      }
      const ai = a.index();
      const oi = o.index();
      return (
        ai.length === oi.length &&
        ai.every((x, i) => eq(x.key, oi[i]!.key) && eq(x.value(), oi[i]!.value())) &&
        sigsEqual(a.call(), o.call()) &&
        sigsEqual(a.construct(), o.construct())
      );
    }
  }
}

export class Normalizer {
  private readonly interned = new Map<string, Canon>();
  /** A number for each type parameter an environment binds: parameters
   * with the same name are distinct keys. */
  private readonly paramIds = new Map<ts.Symbol, number>();

  constructor(private readonly checker: ts.TypeChecker) {}

  canon(type: ts.Type, env: CanonEnv = new Map()): Canon {
    const id = (type as { id?: number }).id;
    const key = id === undefined ? null : `${id}|${this.envKey(env)}`;
    if (key !== null) {
      const known = this.interned.get(key);
      if (known !== undefined) return known;
    }
    const node = this.build(type, env, key);
    if (node.src === undefined) node.src = type;
    if (key !== null && !this.interned.has(key)) this.interned.set(key, node);
    return node;
  }

  private envKey(env: CanonEnv): string {
    // A resolver's bindings are the caller's current instantiation: a
    // normalizer is used for one instantiation at a time.
    if (typeof env === "function") return "fn";
    if (env.size === 0) return "";
    const parts: string[] = [];
    for (const [param, bound] of env) {
      let id = this.paramIds.get(param);
      if (id === undefined) this.paramIds.set(param, (id = this.paramIds.size));
      parts.push(`${id}=${(bound as { id?: number }).id ?? "?"}`);
    }
    return parts.sort().join(",");
  }

  private build(type: ts.Type, env: CanonEnv, key: string | null): Canon {
    const flags = type.flags;
    if (flags & ts.TypeFlags.Any) return { k: "top", t: "any" };
    if (flags & ts.TypeFlags.Unknown) return { k: "top", t: "unknown" };
    if (flags & ts.TypeFlags.NonPrimitive) return { k: "top", t: "object" };
    if (flags & ts.TypeFlags.Never) return { k: "unit", u: "never" };
    if (flags & ts.TypeFlags.Void) return { k: "unit", u: "void" };
    if (flags & ts.TypeFlags.Undefined) return { k: "unit", u: "undefined" };
    if (flags & ts.TypeFlags.Null) return { k: "unit", u: "null" };
    if (flags & ts.TypeFlags.TemplateLiteral) return { k: "prim", p: "string" };
    if (flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) {
      const value = (type as { value?: string | number }).value;
      if (value !== undefined) return { k: "lit", value };
    }
    if (flags & ts.TypeFlags.BooleanLiteral)
      return { k: "lit", value: this.checker.typeToString(type) === "true" };
    if (!type.isUnionType())
      for (const [flag, p] of PRIM_FLAGS) if (flags & flag) return { k: "prim", p };
    if (flags & ts.TypeFlags.TypeParameter) {
      const symbol = type.getSymbol();
      const bound =
        typeof env === "function"
          ? (env(type) ?? undefined)
          : symbol === undefined
            ? undefined
            : env.get(symbol);
      if (bound !== undefined && bound !== type) return this.canon(bound, env);
      return { k: "param", name: symbol === undefined ? "?" : ts.symbolName(symbol) };
    }
    if (type.isUnionType()) return this.union(ts.constituentTypes(type), env);
    if (type.isIntersectionType()) return this.intersection(type, env, key);
    if (flags & (ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Index))
      return { k: "opaque", ts: type, reason: "symbolic type operator" };
    if (flags & ts.TypeFlags.Object) return this.object(type, env, key);
    return { k: "opaque", ts: type, reason: `flags ${flags}` };
  }

  /** Flat, deduplicated, never-free; `void` reads as `undefined`. */
  private union(parts: readonly ts.Type[], env: CanonEnv): Canon {
    const arms: Canon[] = [];
    const add = (c: Canon): void => {
      if (c.k === "union") {
        for (const a of c.arms) add(a);
        return;
      }
      if (c.k === "unit" && c.u === "never") return;
      const arm: Canon = c.k === "unit" && c.u === "void" ? { k: "unit", u: "undefined" } : c;
      // Objects dedupe by identity (they intern by checker type): comparing
      // their members would walk into a recursive type still being built.
      if (arms.some((a) => (arm.k === "obj" ? a === arm : canonEqual(a, arm)))) return;
      arms.push(arm);
    };
    for (const part of parts) add(this.canon(part, env));
    // Units last, in a fixed order; the rest keep the checker's order.
    const unitRank = (c: Canon): number =>
      c.k !== "unit" ? 0 : c.u === "null" ? 1 : c.u === "undefined" ? 2 : 3;
    arms.sort((a, b) => unitRank(a) - unitRank(b));
    if (arms.length === 0) return { k: "unit", u: "never" };
    if (arms.length === 1) return arms[0]!;
    // `true | false` is `boolean`.
    const bools = arms.filter((a) => a.k === "lit" && typeof a.value === "boolean");
    if (bools.length === 2) {
      const rest = arms.filter((a) => !(a.k === "lit" && typeof a.value === "boolean"));
      const merged: Canon[] = [{ k: "prim", p: "boolean" }, ...rest];
      return merged.length === 1 ? merged[0]! : { k: "union", arms: merged };
    }
    return { k: "union", arms };
  }

  /** Equal constituents collapse; object-like constituents without
   * signatures merge through the checker's resolved properties; a
   * primitive branded with an object is the primitive. */
  private intersection(type: ts.Type, env: CanonEnv, key: string | null): Canon {
    const parts = ts.constituentTypes(type).map((t) => this.canon(t, env));
    if (parts.every((p) => canonEqual(p, parts[0]!))) return parts[0]!;
    // Narrowed parameters: `T & {}` (and `T & ({} | null)`'s object part)
    // keep T without its undefined and null arms.
    const empty = (p: Canon): boolean =>
      p.k === "obj" &&
      p.nominal === undefined &&
      p.props().length === 0 &&
      p.index().length === 0 &&
      p.call().length === 0 &&
      p.construct().length === 0;
    const rest = parts.filter((p) => !empty(p));
    if (rest.length === 1 && rest.length < parts.length) {
      const only = rest[0]!;
      if (only.k !== "union") return only.k === "unit" ? { k: "unit", u: "never" } : only;
      const arms = only.arms.filter((a) => a.k !== "unit");
      return arms.length === 1 ? arms[0]! : { k: "union", arms };
    }
    const prims = parts.filter((p) => p.k === "prim" || p.k === "lit");
    if (prims.length === 1 && parts.every((p) => p.k === "prim" || p.k === "lit" || p.k === "obj"))
      return prims[0]!;
    if (parts.every((p) => p.k === "obj" || (p.k === "top" && p.t === "object"))) {
      const merged = this.object(type, env, key);
      // A class (or mixin instance) refined by other object types is that
      // class, with its type arguments: the nominal table answers it, not a
      // merged record.
      let refined: { nominal: string; typeArgs: () => readonly Canon[] } | undefined;
      for (const p of parts)
        if (p.k === "obj" && p.nominal !== undefined)
          refined ??= { nominal: p.nominal, typeArgs: p.typeArgs };
      if (refined !== undefined && merged.k === "obj" && merged.nominal === undefined) {
        merged.nominal = refined.nominal;
        merged.typeArgs = refined.typeArgs;
      }
      return merged;
    }
    return { k: "opaque", ts: type, reason: "intersection" };
  }

  private object(type: ts.Type, env: CanonEnv, key: string | null): Canon {
    const checker = this.checker;
    // Arrays and tuples enter the intern table before their elements are
    // normalized, so a recursive alias (`type Tree = Tree[] | number`)
    // closes on the node under construction.
    if (checker.isArrayType(type)) {
      const [elem] = checker.getTypeArguments(type as ts.TypeReference);
      const node: Canon & { k: "array" } = {
        k: "array",
        elem: { k: "top", t: "unknown" },
        readonly:
          type.getSymbol() !== undefined && ts.symbolName(type.getSymbol()!) === "ReadonlyArray",
      };
      if (key !== null) this.interned.set(key, node);
      if (elem !== undefined) node.elem = this.canon(elem, env);
      return node;
    }
    if (checker.isTupleType(type)) {
      const ref = type as ts.TupleTypeReference;
      // The element flags live on the tuple shape: the type itself, or the
      // target of a reference to it.
      const shape =
        (ref.elementFlags as ts.ElementFlags[] | undefined) !== undefined
          ? ref
          : (ref.getTarget() as ts.TupleType | undefined);
      const flags = shape?.elementFlags ?? [];
      const elems: { type: Canon; optional: boolean; rest: boolean }[] = [];
      const node: Canon = { k: "tuple", elems };
      if (key !== null) this.interned.set(key, node);
      checker.getTypeArguments(ref).forEach((a, i) => {
        const f = flags[i] ?? ts.ElementFlags.Required;
        elems.push({
          type: this.canon(a, env),
          optional: (f & ts.ElementFlags.Optional) !== 0,
          rest: (f & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
        });
      });
      return node;
    }
    // A mapped type the checker could not resolve (over an unbound or
    // symbolically bound parameter) shows no members: irreducible here.
    if (
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0 &&
      checker.getPropertiesOfType(type).length === 0 &&
      checker.getIndexInfosOfType(type).length === 0
    )
      return { k: "opaque", ts: type, reason: "unresolved mapped type" };
    const symbol = type.getSymbol();
    const decl = symbol?.declarations[0];
    const nominal =
      decl !== undefined && (ts.isClassDeclaration(decl) || ts.isClassExpression(decl))
        ? ts.symbolName(symbol!)
        : decl !== undefined &&
            ts.isInterfaceDeclaration(decl) &&
            ts.getSourceFileOfNode(decl).isDeclarationFile &&
            /\/lib\.[^/]*\.d\.ts$/.test(ts.getSourceFileOfNode(decl).fileName)
          ? ts.symbolName(symbol!)
          : undefined;
    const aliasSymbol = type.getAliasSymbol();
    const alias: AliasRef | undefined =
      aliasSymbol === undefined
        ? undefined
        : {
            name: ts.symbolName(aliasSymbol),
            args: type.getAliasTypeArguments().map((a) => this.canon(a, env)),
            tsType: type,
          };
    let typeArgs: readonly Canon[] | undefined;
    let props: readonly CanonProp[] | undefined;
    let index: readonly CanonIndex[] | undefined;
    let call: readonly CanonSig[] | undefined;
    let construct: readonly CanonSig[] | undefined;
    const sigs = (list: readonly ts.Signature[]): CanonSig[] =>
      list.map((s) => ({
        params: s.getParameters().map((p) => {
          const pd = p.declarations[0];
          const param = pd !== undefined && ts.isParameter(pd) ? pd : undefined;
          return {
            name: ts.symbolName(p),
            optional: param?.questionToken !== undefined || param?.initializer !== undefined,
            rest: param?.dotDotDotToken !== undefined,
            type: () => this.canon(checker.getTypeOfSymbol(p), env),
          };
        }),
        ret: () => this.canon(checker.getReturnTypeOfSignature(s), env),
        generic: s.getTypeParameters().length > 0,
      }));
    const node: Canon = {
      k: "obj",
      ...(nominal !== undefined ? { nominal } : {}),
      ...(alias !== undefined ? { alias } : {}),
      typeArgs: () =>
        (typeArgs ??=
          nominal !== undefined &&
          ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
            ? checker.getTypeArguments(type as ts.TypeReference).map((a) => this.canon(a, env))
            : []),
      props: () =>
        (props ??= checker.getPropertiesOfType(type).map((p) => ({
          name: ts.symbolName(p),
          optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
          readonly: false,
          type: () => this.canon(checker.getTypeOfSymbol(p), env),
        }))),
      index: () =>
        (index ??= checker.getIndexInfosOfType(type).map((info) => ({
          key: this.canon(info.keyType, env),
          value: () => this.canon(info.type, env),
        }))),
      call: () => (call ??= sigs(checker.getCallSignatures(type))),
      construct: () => (construct ??= sigs(checker.getConstructSignatures(type))),
    };
    // Recursion closes here: members resolve lazily, so a back-reference
    // reaches this node through the intern table.
    if (key !== null) this.interned.set(key, node);
    return node;
  }
}
