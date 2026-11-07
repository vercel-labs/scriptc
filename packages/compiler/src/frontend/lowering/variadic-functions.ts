/* What happens to a variadic function after lowering made its value: the
 * checks behind the rule in coercions/function-adapters.ts (THE RULE), run
 * once over the finished IR.
 *
 * 1. A variadic function handed to native code.
 *
 * A function that takes a rest parameter of untyped values, or reads
 * `arguments`, has no native call form: its compiled body takes one hidden
 * argument array. Lowering never adapts it to a slot it made for one of its
 * own helpers (THE RULE), so where a helper or a runtime builtin would call
 * it as a closure of fixed arity, the value arrives there still variadic.
 * A site that knows how to hand it every argument has done so before this
 * pass (it boxed the function, and the checked-dynamic call packs the
 * list). Every other such arrival is refused here, by name: a builtin given
 * the closure itself, a helper whose parameter is another function type,
 * a native call of it with the wrong argument list. Without this the
 * builtin calls the body with a typed argument list it reads as an array.
 *
 * 2. Where a variadic function goes after it was stored as a fixed signature.
 *
 * A variadic function stored in a declared slot is called through an
 * adapter that passes the slot's parameters, which is every argument a
 * call through that slot passes. It is not every argument when the stored
 * value is handed on to a caller that passes more than the slot's type
 * names:
 *
 *   const one: (x: number) => number = (...args: unknown[]) => args.length;
 *   [3, 1, 2].map(one);            // JavaScript passes three arguments
 *
 * The array method's loop calls a function value with the parameters its
 * type names (one), JavaScript calls it with three, and the function behind
 * the adapter sees the difference. Nothing at that call can tell an adapter
 * from an ordinary function of the type without a test every typed program
 * would pay for, so the store is what is refused, by name, when the program
 * hands a function of the slot's type to such a caller:
 *
 * - a function type with more parameters, or with a rest parameter (the
 *   conversion drops what the narrower type does not name);
 * - a library function whose callback takes more arguments than the type
 *   names, by its declaration (`map`, `then`) or by what its lowering knows
 *   it passes (an event's arguments, a replacer's).
 *
 * Untyped code is not such a caller. The adapter is a checked adapter over
 * the boxed function, so the value made untyped again is the original
 * function (scr_dyn_new_func), and untyped code calls that with every
 * argument it passes: directly, as what a promise settles with, or through
 * a member of an object it was handed. A runtime builtin that is given the
 * box and calls the typed entry behind it is a native caller.
 *
 * The test is by type, not by value: it asks whether any function value of
 * the slot's type takes one of those paths, not whether the stored one
 * does. A function the program writes in place, or names by its
 * declaration, is not such a value: it is a function, not a slot's content.
 *
 * Three older conversions store a variadic function under a fixed
 * signature without that adapter, and are held to the same rule where the
 * loss is certain (StoreKind): an untyped variadic function through the
 * checked function boundary, a function expression whose `arguments` is
 * typed by the signature it is written for, and a typed rest function
 * packed behind a fixed signature.
 *
 * The receiver is the other thing a caller passes that a type may not
 * name. A callback whose own type shows that it reads `this` is refused
 * where Node passes a receiver the native call does not (callback-arg.ts).
 * A variadic function that reads `this`, stored under a type that does not
 * show it, is refused here when the program hands a function of that type
 * to such a caller.
 *
 * What this cannot see: a declaration that names fewer parameters than the
 * library passes at run time. */

import type { IrExpr, IrFunction, IrType, SrcLoc } from "../../ir/ir.js";
import { typeEquals } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { typeKey } from "../type-mapper.js";
import { isThisParameter } from "./call-signatures.js";
import { namesDeclaredFunction } from "./callback-arg.js";
import { VARIADIC_ADAPTER_PREFIX } from "./coercions/function-adapters.js";
import type { Lowerer } from "./lowerer.js";

type FuncType = IrType & { kind: "func" };

/** Records that a function value of `type` is handed, at `loc`, to `what`,
 * which calls it with more arguments than the type names. */
type CallsLonger = (type: FuncType, loc: SrcLoc, what: string, kind: LongerKind) => void;

/** A place that hands a function value to a caller with a longer list. */
interface LongerCall {
  readonly loc: SrcLoc;
  /** What the value is handed to, as the diagnostic names it. */
  readonly what: string;
}

/** How a store was made, which decides the calls that refuse it. */
type StoreKind =
  /** Through the variadic adapter: any call that can pass more refuses it. */
  | "adapter"
  /** A store that compiled before the adapter existed: an untyped variadic
   * function through the checked function boundary, a typed rest function
   * packed behind a fixed signature, or a function expression whose
   * `arguments` is typed by the signature it is written for (the form
   * wrappers forward their arguments with). Programs that compile today
   * keep compiling unless they certainly lose arguments: only a call that
   * certainly passes more refuses it. A wrapper that only forwards loses
   * nothing where more is merely possible. */
  | "noted";

/** The stores of one slot type. */
interface Stores {
  /** The slot type's key, its spelling and its parameter count. */
  readonly key: string;
  readonly text: string;
  readonly names: number;
  readonly locs: SrcLoc[];
  /** "adapter" when any of the stores is one. */
  kind: StoreKind;
}

/** How a native caller passes a function value a longer list. */
type LongerKind =
  /** The caller's type names more parameters. */
  | "certain"
  /** The caller may pass more (a rest parameter, a slot the declaration
   * does not type). */
  | "possible";

/** Whether `type` is a function type with a fixed parameter list. */
function fixedFunc(type: IrType): type is FuncType {
  return type.kind === "func" && type.rest !== true;
}

/** Whether `type` is a function type with the hidden argument array: a
 * rest parameter of untyped values, or `arguments`. */
function variadicFunc(type: IrType): type is FuncType {
  return type.kind === "func" && type.rest === true && type.restAbi === undefined;
}

const NATIVE_CALL =
  "a function that takes a rest parameter or reads 'arguments', passed where it is called with a fixed argument list (name the parameters the function uses)";

/** The checks of this file's head, in one walk of the finished IR. */
export function checkVariadicFunctions(lowerer: Lowerer, functions: readonly IrFunction[]): void {
  // Every function adapter is a factory of one parameter, the adapted
  // function, that answers the adapter (coercions/builders.ts). The
  // variadic adapter's takes the function boxed.
  const factories = new Map<string, { from: FuncType; to: FuncType }>();
  const variadicFactories = new Map<string, FuncType>();
  const byName = new Map<string, IrFunction>();
  for (const fn of functions) {
    byName.set(fn.name, fn);
    if (!lowerer.freshClosureAdapters.has(fn.name) || fn.params.length !== 1) continue;
    const from = fn.params[0]!.type;
    const to = fn.returnType;
    if (to.kind !== "func") continue;
    if (fn.name.startsWith(`${VARIADIC_ADAPTER_PREFIX}.`)) variadicFactories.set(fn.name, to);
    else if (from.kind === "func") factories.set(fn.name, { from, to });
  }

  /** The stores, by the slot's type. */
  const stored = new Map<string, Stores>();
  const store = (key: string, text: string, names: number, loc: SrcLoc, kind: StoreKind): void => {
    let entry = stored.get(key);
    if (entry === undefined) stored.set(key, (entry = { key, text, names, locs: [], kind }));
    if (kind === "adapter") entry.kind = kind;
    entry.locs.push(loc);
  };
  /** The stores of a variadic function that reads `this`, by the slot's
   * type: refused where a function of the type is handed to a caller Node
   * gives a receiver and the native call does not. */
  const receiverStores = new Map<string, { text: string; locs: SrcLoc[] }>();
  for (const entry of lowerer.notedVariadicStores) {
    const [key, text, names, file, start, end, receiver] = entry.split("\u001f");
    const loc = { file: file!, start: Number(start), end: Number(end) };
    if (receiver === "receiver") {
      let stores = receiverStores.get(key!);
      if (stores === undefined) receiverStores.set(key!, (stores = { text: text!, locs: [] }));
      stores.locs.push(loc);
    } else store(key!, text!, Number(names), loc, "noted");
  }

  /** Conversions that keep the parameter count: the result calls the value
   * with everything it is called with, so it is another view of the store. */
  const views = new Map<string, Set<string>>();
  /** The first longer call of each function type, by the store kind it
   * refuses: any refuses an adapter's store, a certain one a noted store. */
  const longer: Record<StoreKind, Map<string, LongerCall>> = {
    adapter: new Map(),
    noted: new Map(),
  };
  const keyCallsLonger = (key: string, loc: SrcLoc, what: string, kind: LongerKind): void => {
    if (!longer.adapter.has(key)) longer.adapter.set(key, { loc, what });
    if (kind === "certain" && !longer.noted.has(key)) longer.noted.set(key, { loc, what });
  };
  const callsLonger: CallsLonger = (type, loc, what, kind) =>
    keyCallsLonger(typeKey(type), loc, what, kind);
  /** The first call of each function type by a caller that Node gives a
   * receiver. */
  const receiverCalls = new Map<string, LongerCall>();
  for (const entry of lowerer.notedLongerCalls) {
    const [key, what, file, start, end, kind] = entry.split("\u001f");
    const loc = { file: file!, start: Number(start), end: Number(end) };
    if (kind === "receiver") {
      if (!receiverCalls.has(key!)) receiverCalls.set(key!, { loc, what: what! });
    } else keyCallsLonger(key!, loc, what!, "certain");
  }
  /** Where a function value was made untyped for untyped code to call: a
   * library call's argument boxed there is handed over as an untyped
   * value, which calls the function behind a store with every argument. A
   * runtime builtin that takes the box itself (builtinTaken) may call the
   * typed entry behind it instead, natively. */
  const boxedAt = new Set<string>();
  const builtinTaken = new Set<IrExpr>();
  const place = (loc: SrcLoc): string => `${loc.file}:${loc.start}:${loc.end}`;
  const view = (from: FuncType, to: FuncType): void => {
    const key = typeKey(from);
    let set = views.get(key);
    if (set === undefined) views.set(key, (set = new Set()));
    set.add(typeKey(to));
  };
  // A function written in place or named by its declaration lowers to a
  // closure of its own body: not the content of a slot.
  const plainFunction = (value: IrExpr): boolean =>
    value.kind === "closure" && value.adapts !== true;
  const refuseNativeCall = (loc: SrcLoc): void =>
    lowerer.pushDiag(unsupportedDiag("SC1090", loc, NATIVE_CALL));

  // A value boxed where nothing is called through the box: an operand of a
  // comparison (`f === g`), the receiver of a call.
  const compared = new Set<IrExpr>();
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (node) => {
        if (node.kind === "dynScalarEq") {
          compared.add(node.left);
          compared.add(node.right);
          return true;
        }
        if (node.kind === "libCall") {
          // A runtime builtin calls the closure it is given natively, and
          // an untyped function it is given through the function's own
          // typed entry.
          for (const arg of node.args) {
            if (variadicFunc(arg.type)) refuseNativeCall(arg.loc);
            if (arg.kind === "dynFrom") builtinTaken.add(arg);
          }
          return true;
        }
        if (node.kind === "newPromise") {
          // The promise calls its executor with the two settling functions.
          if (variadicFunc(node.executor.type)) refuseNativeCall(node.executor.loc);
          return true;
        }
        if (node.kind === "callValue") {
          if (node.receiver !== undefined) compared.add(node.receiver);
          // The one native call form of a variadic function passes its
          // named parameters and the argument array.
          const callee = node.callee.type;
          if (
            variadicFunc(callee) &&
            (node.args.length !== callee.params.length + 1 || node.args.at(-1)!.type.kind !== "dyn")
          )
            refuseNativeCall(node.loc);
          return true;
        }
        if (node.kind === "call") {
          const slot = variadicFactories.get(node.callee);
          if (slot !== undefined) {
            store(typeKey(slot), lowerer.fmt(slot), slot.params.length, node.loc, "adapter");
            return true;
          }
          const adapter = factories.get(node.callee);
          const value = node.args[0];
          if (adapter === undefined || value === undefined) {
            // A helper built for a callback of another signature.
            const params = byName.get(node.callee)?.params;
            if (params !== undefined)
              node.args.forEach((arg, i) => {
                const param = params[i];
                if (
                  param !== undefined &&
                  variadicFunc(arg.type) &&
                  !typeEquals(arg.type, param.type)
                )
                  refuseNativeCall(arg.loc);
              });
            return true;
          }
          const { from, to } = adapter;
          // A typed rest function packed behind a fixed signature receives
          // the slot's arguments in its rest array: the same kind of store.
          if (from.rest === true && from.restAbi === "typed" && fixedFunc(to)) {
            store(typeKey(to), lowerer.fmt(to), to.params.length, node.loc, "noted");
            return true;
          }
          if (!fixedFunc(from)) return true;
          if (to.rest === true) {
            if (!plainFunction(value))
              callsLonger(from, node.loc, "a function type with a rest parameter", "possible");
          } else if (to.params.length > from.params.length) {
            if (!plainFunction(value))
              callsLonger(
                from,
                node.loc,
                `a function type with ${to.params.length} parameter${to.params.length === 1 ? "" : "s"}`,
                "certain",
              );
          } else view(from, to);
          return true;
        }
        if (node.kind === "upcast" && fixedFunc(node.value.type) && fixedFunc(node.type)) {
          view(node.value.type, node.type);
          return true;
        }
        // A function made untyped where untyped code takes it: itself, or
        // as what a promise settles with or a collection holds.
        if (
          node.kind === "dynFrom" &&
          !compared.has(node) &&
          !builtinTaken.has(node) &&
          !plainFunction(node.value) &&
          carriedFunctionTypes(lowerer, node.value.type).length > 0
        ) {
          boxedAt.add(place(node.loc));
          boxedAt.add(place(node.value.loc));
        }
        return true;
      },
    });
  }
  /** The first call in `calls` of the type `key` or of a view of it. */
  const firstCall = (key: string, calls: Map<string, LongerCall>): LongerCall | undefined => {
    const reached = new Set<string>([key]);
    const work = [key];
    while (work.length > 0) {
      const next = work.pop()!;
      const hit = calls.get(next);
      if (hit !== undefined) return hit;
      for (const viewed of views.get(next) ?? []) {
        if (reached.has(viewed)) continue;
        reached.add(viewed);
        work.push(viewed);
      }
    }
    return undefined;
  };
  for (const [key, { text, locs }] of receiverStores) {
    const hit = firstCall(key, receiverCalls);
    if (hit === undefined) continue;
    for (const loc of locs)
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1090",
          loc,
          `variadic function values that read 'this', stored as '${text}' in a program that hands a function of that type to ${hit.what} at ${where(lowerer, hit.loc)} (Node.js calls it there with a receiver the native call does not pass, and the type no longer shows that the function reads it: read that value by name)`,
        ),
      );
  }
  if (stored.size === 0) return;
  libraryCalls(lowerer, callsLonger, (loc) => boxedAt.has(place(loc)));

  for (const { key, text, names, locs, kind } of stored.values()) {
    const hit = firstCall(key, longer[kind]);
    if (hit === undefined) continue;
    for (const loc of locs)
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1090",
          loc,
          `variadic function values stored as '${text}' in a program that hands a function of that type to ${hit.what} at ${where(lowerer, hit.loc)}, which can call it with more than the ${names} argument${names === 1 ? "" : "s"} the type names (the stored function would not receive them: store a function that names the arguments it uses, or call it from one)`,
        ),
      );
  }
}

/** `loc` as `file:line:column` with the file's base name. */
function where(lowerer: Lowerer, loc: SrcLoc): string {
  const name = loc.file.slice(loc.file.lastIndexOf("/") + 1);
  const source = lowerer.moduleOrder.find((file) => file.fileName === loc.file);
  if (source === undefined) return name;
  const at = ts.getLineAndCharacterOfPosition(source, loc.start);
  return `${name}:${at.line + 1}:${at.character + 1}`;
}

/** The fixed function types a value of `type` is: the type itself, or a
 * union's function arms. */
function directFunctionTypes(lowerer: Lowerer, type: IrType): FuncType[] {
  if (type.kind === "func") return fixedFunc(type) ? [type] : [];
  if (type.kind !== "union") return [];
  return (lowerer.unions.get(type.unionId)?.arms ?? []).filter(fixedFunc);
}

/** The fixed function types a value of `type` carries as a value: the type
 * itself, a union's arms, and what a promise settles with or an array, a
 * Set or a Map holds. Not the members of a record or an object. */
function carriedFunctionTypes(lowerer: Lowerer, type: IrType): FuncType[] {
  const found: FuncType[] = [];
  const seen = new Set<string>();
  const visit = (t: IrType): void => {
    if (t.kind === "func") {
      if (fixedFunc(t) && !found.some((other) => typeEquals(other, t))) found.push(t);
    } else if (t.kind === "union") {
      if (seen.has(t.unionId)) return;
      seen.add(t.unionId);
      for (const arm of lowerer.unions.get(t.unionId)?.arms ?? []) visit(arm);
    } else if (t.kind === "array" || t.kind === "set") visit(t.elem);
    else if (t.kind === "map") {
      visit(t.key);
      visit(t.value);
    } else if (t.kind === "promise") visit(t.inner);
  };
  visit(type);
  return found;
}

/** The fixed function types a value of `type` holds where untyped code can
 * reach them: the type itself, a union's arms, and the members, elements
 * and settled values under them. */
function heldFunctionTypes(lowerer: Lowerer, type: IrType): FuncType[] {
  const found: FuncType[] = [];
  const seen = new Set<string>();
  const visit = (t: IrType): void => {
    if (t.kind === "func") {
      if (fixedFunc(t) && !found.some((other) => typeEquals(other, t))) found.push(t);
      return;
    }
    if (t.kind === "union") {
      if (seen.has(`u:${t.unionId}`)) return;
      seen.add(`u:${t.unionId}`);
      for (const arm of lowerer.unions.get(t.unionId)?.arms ?? []) visit(arm);
    } else if (t.kind === "record") {
      if (seen.has(`r:${t.shapeId}`)) return;
      seen.add(`r:${t.shapeId}`);
      const shape = lowerer.shapes.get(t.shapeId);
      for (const field of shape?.fields ?? []) visit(field.type);
      if (shape?.indexValue !== undefined) visit(shape.indexValue);
    } else if (t.kind === "array") visit(t.elem);
    else if (t.kind === "set") visit(t.elem);
    else if (t.kind === "map") {
      visit(t.key);
      visit(t.value);
    } else if (t.kind === "promise") visit(t.inner);
    else if (t.kind === "object") {
      if (seen.has(`c:${t.className}`)) return;
      seen.add(`c:${t.className}`);
      for (const field of lowerer.classes.get(t.className)?.def.fields ?? []) visit(field.type);
    }
  };
  visit(type);
  return found;
}

/** Reports every function value the program's own modules hand to a
 * library function (one a declaration file declares, or the compiler
 * implements) that can call it with more arguments than its type names. */
function libraryCalls(
  lowerer: Lowerer,
  callsLonger: CallsLonger,
  /** Whether the value at `loc` was made untyped there. */
  boxed: (loc: SrcLoc) => boolean,
): void {
  const checker = lowerer.checker;
  const attempt = <T>(query: () => T): T | undefined => {
    try {
      return query();
    } catch {
      return undefined;
    }
  };
  /** Whether a slot the checker types `declared` is called with more than
   * `count` arguments: "certain" when it names more parameters, "possible"
   * when it takes a rest parameter or says nothing about the call, null
   * when it names no more. The type lowering gives the slot answers first
   * (it instantiates a generic signature); the declaration's own parameter
   * list answers where that type has no lowering. */
  const declaresMore = (
    declared: ts.Type | undefined,
    count: number,
  ): "certain" | "possible" | null => {
    if (declared === undefined) return "possible";
    const mapped = attempt(() => lowerer.mapTypeOf(declared)) ?? null;
    if (mapped !== null) {
      const funcs =
        mapped.kind === "func"
          ? [mapped]
          : mapped.kind === "union"
            ? (lowerer.unions.get(mapped.unionId)?.arms ?? []).filter(
                (arm): arm is FuncType => arm.kind === "func",
              )
            : [];
      if (funcs.length === 0) return "possible";
      if (funcs.some((func) => func.rest !== true && func.params.length > count)) return "certain";
      return funcs.some((func) => func.rest === true) ? "possible" : null;
    }
    // The members of the slot's type that are function types: a slot that
    // takes a callback or something else calls the callback as declared.
    const parts = declared.isUnionType() ? ts.constituentTypes(declared) : [declared];
    let answer: "possible" | null = null;
    let callable = false;
    for (const part of parts) {
      const signatures = attempt(() => checker.getCallSignatures(part)) ?? [];
      if (signatures.length === 0) continue;
      callable = true;
      for (const signature of signatures) {
        const params = signature.declaration?.parameters?.nodes;
        if (params === undefined) {
          answer = "possible";
          continue;
        }
        const own = params.filter((param) => !ts.isParameter(param) || !isThisParameter(param));
        const named = own.filter(
          (param) => !ts.isParameter(param) || param.dotDotDotToken === undefined,
        );
        if (named.length > count) return "certain";
        if (named.length !== own.length) answer = "possible";
      }
    }
    return callable ? answer : "possible";
  };
  const handed = (node: ts.Expression, declared: ts.Type | undefined, what: string): void => {
    const expr = withoutParenthesesTypeWrappers(node);
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return;
    if (ts.isObjectLiteralExpression(expr)) {
      for (const member of expr.properties.nodes) {
        if (ts.isPropertyAssignment(member))
          handed(
            member.initializer,
            attempt(() => checker.getContextualType(member.initializer)),
            what,
          );
        else if (ts.isShorthandPropertyAssignment(member) && ts.isIdentifier(member.name)) {
          const name = member.name;
          handed(
            name,
            attempt(() => checker.getContextualType(name)),
            what,
          );
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements.nodes)
        if (!ts.isSpreadElement(element) && !ts.isOmittedExpression(element))
          handed(
            element,
            attempt(() => checker.getContextualType(element)),
            what,
          );
      return;
    }
    if (namesDeclaredFunction(lowerer, expr)) return;
    const checked = attempt(() => lowerer.typeOf(expr));
    const type = checked === undefined ? null : (attempt(() => lowerer.mapTypeOf(checked)) ?? null);
    if (type === null) return;
    if (type.kind === "func" || type.kind === "union") {
      // Handed over untyped, the function is called by untyped code, which
      // the IR walk recorded where the value was boxed.
      if (boxed(locOf(expr))) return;
      for (const func of directFunctionTypes(lowerer, type)) {
        const more = declaresMore(declared, func.params.length);
        if (more !== null) callsLonger(func, locOf(expr), what, more);
      }
      return;
    }
    // A value with function members (an options object): the library may
    // call any of them, unless the declaration types the slot as this
    // value's own type, which is a slot that only holds it.
    const slot =
      declared === undefined ? null : (attempt(() => lowerer.mapTypeOf(declared)) ?? null);
    if (slot !== null && typeEquals(slot, type)) return;
    for (const func of heldFunctionTypes(lowerer, type))
      callsLonger(func, locOf(expr), what, "possible");
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments?.nodes ?? [];
      if (args.length > 0) {
        const declaration = attempt(() => checker.getResolvedSignature(node))?.declaration;
        if (declaration === undefined || ts.getSourceFileOfNode(declaration).isDeclarationFile) {
          const callee = ts.isPropertyAccessExpression(node.expression)
            ? `'${node.expression.name.text}'`
            : ts.isIdentifier(node.expression)
              ? `'${node.expression.text}'`
              : "a library function";
          for (const arg of args) {
            if (ts.isSpreadElement(arg)) continue;
            handed(
              arg,
              attempt(() => checker.getContextualType(arg)),
              callee,
            );
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      // A property a declaration file declares (`target.onmessage = f`).
      const left = node.left;
      const declarations =
        attempt(() => checker.getSymbolAtLocation(left.name))?.declarations ?? [];
      if (
        declarations.length > 0 &&
        declarations.every((declaration) => ts.getSourceFileOfNode(declaration).isDeclarationFile)
      )
        handed(
          node.right,
          attempt(() => lowerer.typeOf(left)),
          `'${left.name.text}'`,
        );
    }
    ts.forEachChild(node, visit);
  };
  for (const file of lowerer.moduleOrder) {
    // A JavaScript module holds every function value untyped; the dynFrom
    // scan sees what it is handed.
    if (file.isDeclarationFile || isJsSourceFile(file)) continue;
    visit(file);
  }
}
