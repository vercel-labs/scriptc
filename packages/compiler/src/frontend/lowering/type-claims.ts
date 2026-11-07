/* Type claims: the checked conversions of a lowered program whose value is
 * typed by something no build can verify (diagnostics/type-claims.ts has
 * the report's vocabulary).
 *
 * A checked conversion (`dynCheck`) is where an untyped value enters typed
 * code: it throws `TypeError: expected X at $.path, got Y` when the value
 * does not have the type the program gives it. Whether a conversion can
 * fail for a reason outside the compiled program is decided by where its
 * value comes from, read off the operand's IR:
 *
 * - a Node island's value, typed by the island package's declarations
 *   (the lowering records the declaration of each island value in a
 *   coverage analysis, Lowerer.islandClaimOrigins);
 * - a value typed by a package declaration (the conversion carries the
 *   declaration's origin, decl-origin.ts);
 * - data parsed at run time (`JSON.parse`);
 * - a value read from a binding the source declares `any` or `unknown`
 *   (a variable, a parameter, a function's result), named by that binding;
 * - a value the program holds dynamically and gives a type by assertion
 *   (`table() as Catalog`).
 *
 * A binding is followed to the values the program stores in it (a local's
 * and a global's assignments, a parameter's arguments at direct calls, a
 * function's returns): one that holds an island's value is the island's
 * claim. A binding the source gives a type, which the build happens to
 * hold dynamically, is not untyped: where its values are the runtime's own
 * or typed values of the program, reading them back is not a claim.
 *
 * A typed function handed to a Node island is a claim too: the island
 * calls it with its own values, and the function's thunk checks each
 * argument against the parameter types the island's declarations gave it.
 *
 * Not claims: conversions of values the compiler produced itself (a typed
 * value boxed and converted in one expression, the result of a library
 * call whose type the runtime guarantees), and a conversion a kind test of
 * the same value guards (`typeof v === "string" ? v : ""`, or the code
 * after `if (typeof v !== "string") return`), which cannot fail.
 *
 * A claim inside a `try` whose handler neither reads the error nor throws
 * is marked: there a failed conversion is invisible. `try { return
 * JSON.parse(line) as Entry } catch { return null }` means "skip a
 * malformed line", and natively it also skips every well-formed line that
 * lacks a field the type declares, where Node keeps the value.
 *
 * Runs over the final function bodies in coverage analyses only, so it
 * costs builds nothing and reads exactly the conversions a build emits. */
import type { IrExpr, IrFunction, IrGlobal, IrLocal, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import type { TypeClaimKind, TypeClaimSite } from "../../diagnostics/type-claims.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { packageOfFile } from "./decl-origin.js";

/** Library functions that answer data read at run time as an untyped
 * value: what the program then claims about it is checked. */
function parsesData(fn: string): boolean {
  return fn === "json.parse" || fn === "json.parseReviver";
}

/** The key of a source position in Lowerer.islandClaimOrigins. */
export function claimKey(loc: SrcLoc): string {
  return `${loc.file}\u0000${loc.start}\u0000${loc.end}`;
}

interface Root {
  kind: TypeClaimKind;
  /** The claiming declaration, when the lowering recorded one. */
  origin?: string;
  /** The untyped binding the value is read from. */
  binding?: { name: string; loc: SrcLoc };
  /** The compiled package whose code produced the value. */
  from?: { name: string; version: string };
}

/** Where a checked-dynamic value comes from: a root outside the compiled
 * program's knowledge, `"own"` for a typed value of the program boxed as
 * it is (a claim once it passed through an untyped binding), or null for
 * a value the runtime made. */
type Source = Root | "own" | null;

export interface TypeClaimInputs {
  functions: readonly IrFunction[];
  globals: ReadonlyMap<string, IrGlobal>;
  /** The lowering's origin table (`dynCheck.origin` indexes it). */
  declOrigins: readonly string[];
  /** Island values and island-called functions by position, with the
   * declaration that types each ("" when none can be named). */
  islandOrigins: ReadonlyMap<string, string>;
  /** The positions of the conversions an assertion (`x as T`) asked for. */
  asserted: ReadonlySet<string>;
  /** The positions of the declaration-typed boundary's casts
   * (decl-projection.ts): a package's value, typed by its declarations
   * where the program receives it. */
  boundary: ReadonlySet<string>;
  /** Whether the source declares the binding at `loc`, or the result of
   * the function at `loc`, `any` or `unknown` (true when it cannot say). */
  declaredUntyped: (loc: SrcLoc, what: "binding" | "result") => boolean;
  unionArms: (unionId: string) => readonly IrType[] | undefined;
  fmt: (type: IrType) => string;
}

/** True when no object a Node island made converts to `type`. The boundary
 * copies data and adapts functions; a Date, a RegExp and a Node server
 * handle hold only values compiled code made, so the conversion passes for
 * a value the program passed into the island and came back, and throws for
 * the island's own. The list is the kinds this was measured for; a union
 * is native-only when every arm that is not null or undefined is. */
function islandNativeOnly(
  type: IrType,
  unionArms: TypeClaimInputs["unionArms"],
  depth = 0,
): boolean {
  switch (type.kind) {
    case "date":
    case "regex":
    case "netServer":
      return true;
    case "union": {
      const arms = (unionArms(type.unionId) ?? []).filter(
        (arm) => arm.kind !== "nullT" && arm.kind !== "undefinedT",
      );
      return (
        depth < 8 &&
        arms.length > 0 &&
        arms.every((arm) => islandNativeOnly(arm, unionArms, depth + 1))
      );
    }
    default:
      return false;
  }
}

/** The kind test (`dynTest.test`) that proves a value converts to `type`,
 * or null when no single test does. */
function provingTest(type: IrType): string | null {
  switch (type.kind) {
    case "f64":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "bigint":
      return "bigint";
    case "bytes":
      return "bytes";
    case "object":
      return type.className === "%Error" ? "error" : null;
    default:
      return null;
  }
}

/** Answers TypeClaimInputs.declaredUntyped from the checker: the type the
 * source gives the binding whose name starts at a position, or the return
 * type of the function that starts there. A file's names and functions are
 * indexed on first use. A JavaScript file, and a position the index does
 * not hold (a destructuring pattern, a generated function), answer true:
 * their claims are kept. */
export function declaredUntypedIn(
  program: ts.Program,
  checker: ts.TypeChecker,
): TypeClaimInputs["declaredUntyped"] {
  interface FileIndex {
    names: Map<number, ts.Node>;
    functions: Map<number, ts.Node>;
  }
  const files = new Map<string, FileIndex | null>();
  const indexOf = (file: string): FileIndex | null => {
    let index = files.get(file);
    if (index !== undefined) return index;
    const sf = program.getSourceFile(file);
    // JavaScript declares no types: what the checker infers for a binding
    // there is itself unverified.
    if (sf === undefined || isJsSourceFile(sf)) index = null;
    else {
      const built: FileIndex = { names: new Map(), functions: new Map() };
      ts.walkPreorder(sf, (node: ts.Node): void => {
        if (ts.isIdentifier(node)) built.names.set(locOf(node).start, node);
        else if (ts.isFunctionLike(node)) built.functions.set(locOf(node).start, node);
      });
      index = built;
    }
    files.set(file, index);
    return index;
  };
  const untyped = (type: ts.Type | undefined): boolean =>
    type === undefined || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  return (loc, what) => {
    const index = indexOf(loc.file);
    if (index === null) return true;
    try {
      if (what === "binding") {
        const name = index.names.get(loc.start);
        return name === undefined || untyped(checker.getTypeAtLocation(name));
      }
      const fn = index.functions.get(loc.start);
      if (fn === undefined) return true;
      const signature = checker.getSignatureFromDeclaration(fn as ts.SignatureDeclaration);
      if (signature === undefined) return true;
      const result = checker.getReturnTypeOfSignature(signature);
      // An async function's result is what its promise settles with.
      return untyped(result) || /^Promise<(any|unknown)>$/.test(checker.typeToString(result));
    } catch {
      return true;
    }
  };
}

/** One function's bindings, the values its statements store in them, and
 * the values whose kind it tests. */
interface Scope {
  fn: IrFunction;
  locals: Map<string, IrLocal>;
  params: Set<string>;
  stored: Map<string, IrExpr[]>;
  chains: Map<string, IrExpr>;
  /** The locals stored to after their declaration: a kind test of one
   * says nothing about what it holds later. */
  reassigned: Set<string>;
  /** The conversions inside a `try` whose handler ignores the error. */
  swallowed: Set<IrExpr>;
}

/** True when a handler neither reads the caught error nor throws: what
 * the guarded body threw leaves no trace. */
function ignoresError(catchBody: IrStmt[], catchLocalId: string | null): boolean {
  return everyStmtList(catchBody, {
    expr: (e) => !(e.kind === "varRef" && e.localId === catchLocalId),
    stmt: (s) => s.kind !== "throw" && s.kind !== "rethrow",
  });
}

/** A stable name for the place a value is read from, or null. */
function pathOf(scope: Scope, e: IrExpr, depth = 0): string | null {
  if (depth > 16) return null;
  if (e.kind === "varRef") return e.localId;
  if (e.kind === "dynKeyGet" && e.key.kind === "strLit") {
    const base = pathOf(scope, e.value, depth + 1);
    return base === null ? null : `${base}\u0000${e.key.value}`;
  }
  if (e.kind === "chainRecv") {
    const receiver = scope.chains.get(e.id);
    return receiver === undefined ? null : pathOf(scope, receiver, depth + 1);
  }
  if (e.kind === "optChain") return pathOf(scope, e.body, depth + 1);
  return null;
}

/** Every claim site of the program, in function and source order. */
export function collectTypeClaims(input: TypeClaimInputs): TypeClaimSite[] {
  const sites: TypeClaimSite[] = [];
  const seen = new Set<string>();
  const byName = new Map<string, IrFunction>();
  for (const fn of input.functions) byName.set(fn.name, fn);
  // A class is named as the source names it, without its module's prefix.
  const typeText = (type: IrType): string => input.fmt(type).replace(/\bm\d+\./g, "");
  const packages = new Map<string, { name: string; version: string } | null>();
  const packageOf = (file: string): { name: string; version: string } | null => {
    let found = packages.get(file);
    if (found === undefined) {
      found = packageOfFile(file);
      packages.set(file, found);
    }
    return found;
  };
  // One site per source position: a generic function lowered for several
  // type arguments converts at the same place to each of them.
  const add = (site: TypeClaimSite): void => {
    const key = `${claimKey(site.loc)}\u0000${site.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const inPackage = packageOf(site.loc.file);
    sites.push(inPackage === null ? site : { ...site, inPackage });
  };

  // Every function's stores, and across the program the module globals',
  // the arguments of direct calls and the values functions return.
  type Stored = { scope: Scope; value: IrExpr };
  const globalStores = new Map<string, Stored[]>();
  const argumentStores = new Map<string, Stored[]>();
  const returnStores = new Map<string, Stored[]>();
  const push = (stores: Map<string, Stored[]>, key: string, stored: Stored): void => {
    const held = stores.get(key);
    if (held === undefined) stores.set(key, [stored]);
    else held.push(stored);
  };
  const scopes: Scope[] = [];
  for (const fn of input.functions) {
    const scope: Scope = {
      fn,
      locals: new Map(),
      params: new Set(fn.params.map((p) => p.localId)),
      stored: new Map(),
      chains: new Map(),
      reassigned: new Set(),
      swallowed: new Set(),
    };
    for (const local of fn.locals) scope.locals.set(local.id, local);
    const store = (id: string, value: IrExpr): void => {
      if (scope.locals.has(id)) {
        const held = scope.stored.get(id);
        if (held === undefined) scope.stored.set(id, [value]);
        else held.push(value);
      } else if (input.globals.has(id)) {
        push(globalStores, id, { scope, value });
      }
    };
    everyStmtList(fn.body as IrStmt[], {
      expr: (e) => {
        if (e.kind === "optChain") scope.chains.set(e.id, e.receiver);
        else if (e.kind === "assignExpr") {
          store(e.localId, e.value);
          scope.reassigned.add(e.localId);
        } else if (e.kind === "call") {
          e.args.forEach((value, i) => {
            if (value.type.kind === "dyn" || value.type.kind === "jsval")
              push(argumentStores, `${e.callee}\u0000${i}`, { scope, value });
          });
        }
        return true;
      },
      stmt: (s) => {
        if (s.kind === "varDecl" && s.init !== null) store(s.localId, s.init);
        else if (s.kind === "assign") {
          store(s.localId, s.value);
          if (s.initializes !== true) scope.reassigned.add(s.localId);
        } else if (s.kind === "return" && s.value !== null)
          push(returnStores, fn.name, { scope, value: s.value });
        else if (
          s.kind === "tryCatch" &&
          s.catchBody !== null &&
          ignoresError(s.catchBody, s.catchLocalId)
        ) {
          everyStmtList(s.tryBody, {
            expr: (e) => {
              if (e.kind === "dynCheck") scope.swallowed.add(e);
              return true;
            },
            stmt: () => true,
          });
        }
        return true;
      },
    });
    scopes.push(scope);
  }

  // What each binding holds, decided once; a binding being decided (a
  // value stored back into itself) contributes nothing.
  const decided = new Map<string, Source | "deciding">();
  const strongest = (a: Source, b: Source): Source => {
    const rank = (s: Source): number =>
      s === null ? 0 : s === "own" ? 1 : s.kind === "island" ? 4 : s.kind === "parsed" ? 3 : 2;
    return rank(b) > rank(a) ? b : a;
  };
  const bindingSource = (key: string, values: readonly Stored[], depth: number): Source => {
    const known = decided.get(key);
    if (known === "deciding") return null;
    if (known !== undefined) return known;
    decided.set(key, "deciding");
    let source: Source = null;
    for (const { scope, value } of values)
      source = strongest(source, sourceOf(scope, value, depth + 1));
    decided.set(key, source);
    return source;
  };
  /** What reading a source binding (or a function's result) yields, given
   * what the program stores in it: an island's value stays the island's;
   * parsed or untyped data is named by this binding; and where the stores
   * are the program's own typed values, the runtime's, or unseen (a
   * captured variable, an indirect call), the read is a claim exactly when
   * the source declares the binding `any` or `unknown`. */
  const through = (
    named: { name: string; loc: SrcLoc },
    what: "binding" | "result",
    held: Source,
  ): Source => {
    const from = packageOf(named.loc.file);
    if (held !== null && held !== "own") {
      if (held.kind === "island") return held;
      const producer = held.from ?? from;
      return { kind: held.kind, binding: named, ...(producer !== null ? { from: producer } : {}) };
    }
    if (!input.declaredUntyped(named.loc, what)) return held;
    return { kind: "untyped", binding: named, ...(from !== null ? { from } : {}) };
  };
  /** The binding or function a dynamically held value is read from, for
   * naming an assertion's claim. */
  const readFrom = (
    scope: Scope,
    e: IrExpr,
    depth = 0,
  ): { name: string; loc: SrcLoc } | undefined => {
    if (depth > 16) return undefined;
    switch (e.kind) {
      case "varRef": {
        const b = scope.locals.get(e.localId) ?? input.globals.get(e.localId);
        if (b === undefined) return undefined;
        if (b.source !== undefined) return { name: b.name, loc: b.source.loc };
        // A compiler temporary: what it was given.
        const given = scope.stored.get(e.localId)?.[0];
        return given === undefined ? undefined : readFrom(scope, given, depth + 1);
      }
      case "call": {
        const callee = byName.get(e.callee);
        if (callee === undefined || callee.sourceName === undefined) {
          const arg = e.args.find((a) => a.type.kind === "dyn" || a.type.kind === "jsval");
          return arg === undefined ? undefined : readFrom(scope, arg, depth + 1);
        }
        return { name: `${callee.sourceName}()`, loc: callee.loc };
      }
      case "dynKeyGet":
      case "awaitExpr":
        return readFrom(scope, e.value, depth + 1);
      case "seqExpr":
        return readFrom(scope, e.result, depth + 1);
      default:
        return undefined;
    }
  };
  /** Where a checked-dynamic operand's value comes from. */
  const sourceOf = (scope: Scope, e: IrExpr, depth: number): Source => {
    if (depth > 48) return null;
    const island = input.islandOrigins.get(claimKey(e.loc));
    if (island !== undefined && e.kind !== "dynCheck")
      return { kind: "island", ...(island !== "" ? { origin: island } : {}) };
    switch (e.kind) {
      case "varRef": {
        const local = scope.locals.get(e.localId);
        const b = local ?? input.globals.get(e.localId);
        if (b === undefined) return null;
        let values: readonly Stored[];
        let key: string;
        if (local === undefined) {
          values = globalStores.get(e.localId) ?? [];
          key = e.localId;
        } else if (scope.params.has(local.id)) {
          // A parameter holds what every caller passes. Its arguments at
          // direct calls say whether an unverified value reaches it; they
          // do not make its reads one caller's claim.
          const index = scope.fn.params.findIndex((p) => p.localId === local.id);
          const passed = argumentStores.get(`${scope.fn.name}\u0000${index}`) ?? [];
          const reached =
            passed.length === 0
              ? null
              : bindingSource(`${scope.fn.name}\u0000p${index}`, passed, depth);
          if (b.source === undefined) return reached !== null && reached !== "own" ? reached : null;
          const named = { name: b.name, loc: b.source.loc };
          if (
            (reached === null || reached === "own") &&
            !input.declaredUntyped(named.loc, "binding")
          )
            return reached;
          const from = packageOf(named.loc.file);
          return { kind: "untyped", binding: named, ...(from !== null ? { from } : {}) };
        } else {
          values = (scope.stored.get(local.id) ?? []).map((value) => ({ scope, value }));
          key = `${scope.fn.name}\u0000${local.id}`;
        }
        const held = values.length === 0 ? null : bindingSource(key, values, depth);
        // A compiler temporary is transparent.
        if (b.source === undefined) return held;
        return through({ name: b.name, loc: b.source.loc }, "binding", held);
      }
      case "dynKeyGet":
      case "awaitExpr":
      case "caughtToDyn":
        return sourceOf(scope, e.value, depth + 1);
      case "dynCall":
      case "callValue":
        return sourceOf(scope, e.callee, depth + 1);
      case "dynInvoke":
        return sourceOf(scope, e.recv, depth + 1);
      case "call": {
        const callee = byName.get(e.callee);
        // A generated helper reads from its arguments.
        if (callee === undefined || callee.sourceName === undefined) {
          let source: Source = null;
          for (const arg of e.args)
            if (arg.type.kind === "dyn" || arg.type.kind === "jsval")
              source = strongest(source, sourceOf(scope, arg, depth + 1));
          return source === "own" ? null : source;
        }
        const returns = returnStores.get(callee.name) ?? [];
        const held =
          returns.length === 0
            ? null
            : bindingSource(`${callee.name}\u0000returns`, returns, depth);
        return through({ name: `${callee.sourceName}()`, loc: callee.loc }, "result", held);
      }
      case "seqExpr":
        return sourceOf(scope, e.result, depth + 1);
      case "optChain":
        return sourceOf(scope, e.body, depth + 1);
      case "chainRecv": {
        const receiver = scope.chains.get(e.id);
        return receiver === undefined ? null : sourceOf(scope, receiver, depth + 1);
      }
      case "dynFrom": {
        // A typed wrapper of an island's value (its promise) is still the
        // island's; any other typed value is the program's own.
        const source = sourceOf(scope, e.value, depth + 1);
        return source !== null && source !== "own" && source.kind === "island" ? source : "own";
      }
      case "libCall": {
        if (e.fn.startsWith("nodeIsland.")) return { kind: "island" };
        if (parsesData(e.fn)) return { kind: "parsed" };
        // A wrapper the runtime applies to a value it was given
        // (dyn.promiseResolve of an island promise) keeps an island's
        // root; any other library result is the runtime's own.
        for (const arg of e.args) {
          if (arg.type.kind !== "dyn" && arg.type.kind !== "promise") continue;
          const source = sourceOf(scope, arg, depth + 1);
          if (source !== null && source !== "own" && source.kind === "island") return source;
        }
        return null;
      }
      default:
        return null;
    }
  };

  for (const scope of scopes) {
    /** A typed function among the values an island call hands over. */
    const islandCallbacks = (e: IrExpr, depth: number): void => {
      if (depth > 8) return;
      if (e.kind === "dynFrom") {
        const t = e.value.type;
        if (t.kind !== "func" || t.params.every((p) => p.kind === "dyn")) return;
        const origin = input.islandOrigins.get(claimKey(e.loc));
        add({
          kind: "island",
          loc: e.loc,
          claimed: typeText(t),
          callback: true,
          ...(origin !== undefined && origin !== "" ? { origin } : {}),
        });
      } else if (e.kind === "dynArrLit") {
        for (const elem of e.elems) islandCallbacks(elem, depth + 1);
      } else if (e.kind === "dynObjLit") {
        for (const field of e.fields ?? []) islandCallbacks(field.value, depth + 1);
      } else if (e.kind === "seqExpr") {
        islandCallbacks(e.result, depth + 1);
      }
    };
    /** The claim of one conversion, unless a kind test in `facts` guards it. */
    const claimAt = (e: IrExpr & { kind: "dynCheck" }, facts: ReadonlySet<string>): void => {
      const declared = e.origin === undefined ? undefined : input.declOrigins[e.origin];
      const source = sourceOf(scope, e.value, 0);
      const root = source === "own" ? null : source;
      // An assertion over a value the program holds dynamically is a
      // claim whatever the value's source.
      const asserted = root === null && input.asserted.has(claimKey(e.loc));
      const boundary = root === null && input.boundary.has(claimKey(e.loc));
      if (root === null && declared === undefined && !asserted && !boundary) return;
      const proof = provingTest(e.type);
      if (proof !== null) {
        const path = pathOf(scope, e.value);
        if (path !== null && facts.has(`${path}\u0001${proof}`)) return;
      }
      // The declaration of the value at this very position names the
      // claim; failing that, the one its root was recorded with.
      const here = input.islandOrigins.get(claimKey(e.loc));
      const origin = here !== undefined && here !== "" ? here : (root?.origin ?? declared);
      const read = asserted || boundary ? readFrom(scope, e.value) : undefined;
      const binding = asserted ? read : root?.binding;
      // A boundary cast's value was produced by the package it is read from.
      const from = root?.from ?? (read === undefined ? null : packageOf(read.loc.file));
      add({
        kind:
          root?.kind === "island"
            ? "island"
            : declared !== undefined || boundary
              ? "declared"
              : (root?.kind ?? "untyped"),
        loc: e.loc,
        claimed: typeText(e.type),
        ...(origin !== undefined ? { origin } : {}),
        ...(origin !== undefined && here === undefined && root?.origin !== undefined
          ? { reached: true as const }
          : {}),
        ...(binding !== undefined ? { binding } : {}),
        ...(asserted ? { asserted: true as const } : {}),
        ...(scope.swallowed.has(e) ? { swallowed: true as const } : {}),
        ...(from !== null && from !== undefined ? { from } : {}),
        ...(root?.kind === "island" && islandNativeOnly(e.type, input.unionArms)
          ? { nativeOnly: true as const }
          : {}),
      });
    };

    // A kind test guards what its outcome dominates: the branch of an `if`
    // or a conditional it selects, the right operand of `&&` and `||`, and
    // the statements after an `if` whose other branch always leaves. A test
    // of a binding the function stores to again guards nothing.
    const stable = (path: string): boolean => {
      const root = path.split("\u0000", 1)[0]!;
      if (scope.locals.has(root)) return !scope.reassigned.has(root);
      return (globalStores.get(root)?.length ?? 0) <= 1;
    };
    const proven = (cond: IrExpr, when: boolean, out: Set<string>): void => {
      if (cond.kind === "dynTest") {
        if ((cond.negated === true) === when) return;
        const path = pathOf(scope, cond.value);
        if (path !== null && stable(path))
          out.add(`${path}\u0001${cond.test === "buffer" ? "bytes" : cond.test}`);
      } else if (cond.kind === "unary" && cond.op === "!") proven(cond.operand, !when, out);
      else if (cond.kind === "toBool") proven(cond.operand, when, out);
      else if (cond.kind === "logical" && (cond.op === "&&") === when) {
        // Both operands of a true `&&`, and of a false `||`, are decided.
        proven(cond.left, when, out);
        proven(cond.right, when, out);
      }
    };
    const withFacts = (
      facts: ReadonlySet<string>,
      cond: IrExpr,
      when: boolean,
    ): ReadonlySet<string> => {
      const out = new Set(facts);
      proven(cond, when, out);
      return out.size === facts.size ? facts : out;
    };
    const leaves = (body: readonly IrStmt[]): boolean => {
      const last = body[body.length - 1];
      if (last === undefined) return false;
      if (last.kind === "block") return leaves(last.body);
      return (
        last.kind === "return" ||
        last.kind === "throw" ||
        last.kind === "rethrow" ||
        last.kind === "break" ||
        last.kind === "continue"
      );
    };
    const visitExpr = (e: IrExpr, facts: ReadonlySet<string>): void => {
      if (e.kind === "ternary") {
        visitExpr(e.cond, facts);
        visitExpr(e.then, withFacts(facts, e.cond, true));
        visitExpr(e.else_, withFacts(facts, e.cond, false));
        return;
      }
      if (e.kind === "logical") {
        visitExpr(e.left, facts);
        visitExpr(e.right, withFacts(facts, e.left, e.op === "&&"));
        return;
      }
      if (e.kind === "libCall" && e.fn.startsWith("nodeIsland."))
        for (const arg of e.args) islandCallbacks(arg, 0);
      else if (e.kind === "dynCheck" && e.exact !== true && e.inferredSite === undefined)
        claimAt(e, facts);
      everyExprChild(
        e,
        (child) => (visitExpr(child, facts), true),
        (child) => (visitStmt(child, facts), true),
      );
    };
    const visitStmts = (body: readonly IrStmt[], facts: ReadonlySet<string>): void => {
      let known = facts;
      for (const stmt of body) {
        if (stmt.kind !== "if") {
          visitStmt(stmt, known);
          continue;
        }
        visitExpr(stmt.cond, known);
        visitStmts(stmt.then, withFacts(known, stmt.cond, true));
        if (stmt.else_ !== null) visitStmts(stmt.else_, withFacts(known, stmt.cond, false));
        // `if (typeof v !== "string") return;` proves the test for the rest.
        if (leaves(stmt.then)) known = withFacts(known, stmt.cond, false);
        else if (stmt.else_ !== null && leaves(stmt.else_))
          known = withFacts(known, stmt.cond, true);
      }
    };
    const visitStmt = (stmt: IrStmt, facts: ReadonlySet<string>): void => {
      if (stmt.kind === "if") visitStmts([stmt], facts);
      else if (stmt.kind === "block") visitStmts(stmt.body, facts);
      else
        everyStmtChild(
          stmt,
          (child) => (visitExpr(child, facts), true),
          (child) => (visitStmt(child, facts), true),
        );
    };
    visitStmts(scope.fn.body, new Set());
  }
  return sites;
}
