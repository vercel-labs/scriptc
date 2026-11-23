import * as ts from "../ts7/adapter.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { isJsSourceFile, locOf } from "../program.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrParam,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { typeKey } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { isThisParameter } from "./call-signatures.js";
import { buildFunctionAdapter } from "./coercions/builders.js";
import { keyedHelperName } from "./stable-names.js";

/** `arguments.length` in a top-level function declaration that the program
 * also uses as a value. A direct call passes the declared parameters (tsc
 * checks the arity), while a call through the value passes the parameter
 * count of the function type the value was passed as (`[1].map(f)` calls f
 * with 3). The value is an adapter that stores that count in a global slot
 * before forwarding; the function reads the slot on entry and clears it,
 * so a direct call (the cleared slot) sees the declared count. */

/** The count slot of `decl`, or null when its `arguments.length` folds to
 * the declared count (or the declaration does not qualify). */
export function argumentCountSlot(lowerer: Lowerer, decl: ts.FunctionDeclaration): string | null {
  const cached = lowerer.argumentCountSlots.get(decl);
  if (cached !== undefined) return cached;
  let slot: string | null = null;
  if (
    decl.body !== undefined &&
    decl.name !== undefined &&
    decl.asteriskToken === undefined &&
    !decl.typeParameters?.nodes.length &&
    lowerer.isTopLevelFnSymbol(decl.name) &&
    decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
    !isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
    fixedArity(decl) &&
    bodyReadsArguments(decl) &&
    usedAsValue(lowerer, decl)
  ) {
    const sig = lowerer.fnSigOf(decl.name);
    if (sig) {
      slot = `%g.argc.${sig.name}`;
      lowerer.globalsList.push({ id: slot, name: "%argc", type: F64, mutable: true });
    }
  }
  lowerer.argumentCountSlots.set(decl, slot);
  return slot;
}

/** Reads `decl`'s count slot into a hidden local on entry and clears it; the
 * local holds the declared count when the slot was clear. */
export function declareArgumentCount(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  prologue: IrStmt[],
): void {
  const slot = argumentCountSlot(lowerer, decl);
  if (slot === null) return;
  const loc = locOf(decl);
  const local = lowerer.declareHiddenLocal("%argc", F64);
  const stored = varRef(slot, F64, loc);
  prologue.push(
    {
      kind: "varDecl",
      localId: local.id,
      init: {
        kind: "ternary",
        cond: {
          kind: "bin",
          op: "===",
          left: stored,
          right: { kind: "numLit", value: 0, type: F64, loc },
          type: BOOL,
          loc,
        },
        then: { kind: "numLit", value: declaredCount(decl), type: F64, loc },
        else_: stored,
        type: F64,
        loc,
      },
      loc,
    },
    { kind: "assign", localId: slot, value: { kind: "numLit", value: 0, type: F64, loc }, loc },
  );
  lowerer.ctx.argumentCount = local;
}

/** `decl` as a value at `reference`: the plain closure when every call
 * through the expected function type passes the declared count, otherwise
 * an adapter that stores the expected type's count in the slot first. */
export function argumentCountValue(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  reference: ts.Expression,
  closure: IrExpr & { type: IrType & { kind: "func" } },
): IrExpr {
  const slot = argumentCountSlot(lowerer, decl);
  if (slot === null) return closure;
  const count = contextualCallCount(lowerer, reference);
  if (count === "varies") {
    const target = variadicExpectation(lowerer, reference);
    if (target !== null) return variadicCountAdapter(lowerer, closure, target, slot);
    lowerer.unsupported(
      "SC1090",
      reference,
      "functions that read 'arguments.length' used as values where the expected function type has optional or rest parameters (the count varies per call)",
    );
  }
  if (count === null) {
    lowerer.unsupported(
      "SC1090",
      reference,
      "functions that read 'arguments.length' used as values where no function type is expected (the count each call passes is not known)",
    );
  }
  const declared = declaredCount(decl);
  if (count <= declared) return closure;
  const loc = locOf(reference);
  const type = closure.type;
  const key = `argc:${slot}:${count}:${typeKey(type)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%argc.adapter", key);
    lowerer.arrHofHelpers.set(key, name);
    const params = type.params.map((t, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: t }));
    lowerer.liftedFns.push(
      ...buildFunctionAdapter(
        name,
        type,
        type,
        params,
        [],
        [
          {
            kind: "assign",
            localId: slot,
            value: { kind: "numLit", value: count, type: F64, loc },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "callValue",
              callee: varRef("f.0", type, loc),
              args: params.map((p) => varRef(p.localId, p.type, loc)),
              type: type.ret,
              loc,
            },
            loc,
          },
        ],
        loc,
      ),
    );
  }
  return { kind: "call", callee: name, args: [closure], type, loc };
}

/** The variadic function type (`(...args: unknown[]) => R`) the checker
 * expects at `node`, or null when no single such type is expected. */
function variadicExpectation(
  lowerer: Lowerer,
  node: ts.Expression,
): (IrType & { kind: "func" }) | null {
  let contextual: ts.Type | undefined;
  try {
    contextual = lowerer.checker.getContextualType(node);
  } catch {
    return null;
  }
  if (contextual === undefined) return null;
  let mapped: IrType | null;
  try {
    mapped = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(contextual));
  } catch {
    return null;
  }
  if (mapped === null) return null;
  const funcs =
    mapped.kind === "func"
      ? [mapped]
      : mapped.kind === "union"
        ? (lowerer.unions.get(mapped.unionId)?.arms ?? []).filter(
            (arm): arm is IrType & { kind: "func" } => arm.kind === "func",
          )
        : [];
  const variadic = funcs.filter((func) => func.rest === true && func.restAbi === undefined);
  return funcs.length === 1 && variadic.length === 1 ? variadic[0]! : null;
}

/** The adapter that stores a function reading `arguments.length` where a
 * variadic function type is expected: each call hands it the hidden
 * argument array, so the count the call passes is that array's length. The
 * adapter records it in `slot` (argumentCountSlot) before calling the
 * function with the declared parameters. */
function variadicCountAdapter(
  lowerer: Lowerer,
  closure: IrExpr & { type: IrType & { kind: "func" } },
  target: IrType & { kind: "func" },
  slot: string,
): IrExpr {
  const loc = closure.loc;
  const fromT = closure.type;
  const key = `argc.rest:${slot}:${typeKey(target)}:${typeKey(fromT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%argc.rest", key);
    lowerer.arrHofHelpers.set(key, name);
    const params: IrParam[] = target.params.map((type, i) => ({
      localId: `p${i}.0`,
      name: `p${i}`,
      type,
    }));
    params.push({ localId: "rest.0", name: "rest", type: DYN });
    const rest: IrExpr = { kind: "varRef", localId: "rest.0", type: DYN, loc };
    const length: IrExpr = {
      kind: "dynKeyGet",
      value: rest,
      key: { kind: "strLit", value: "length", type: STRING, loc },
      type: DYN,
      loc,
    };
    const counted: IrExpr =
      target.params.length === 0
        ? { kind: "dynCheck", value: length, type: F64, loc }
        : {
            kind: "bin",
            op: "+",
            left: { kind: "numLit", value: target.params.length, type: F64, loc },
            right: { kind: "dynCheck", value: length, type: F64, loc },
            type: F64,
            loc,
          };
    const args = fromT.params.map((want, i): IrExpr => {
      const source: IrExpr =
        i < target.params.length
          ? { kind: "varRef", localId: `p${i}.0`, type: target.params[i]!, loc }
          : {
              kind: "dynKeyGet",
              value: rest,
              key: { kind: "strLit", value: String(i - target.params.length), type: STRING, loc },
              type: DYN,
              loc,
            };
      return lowerer.coerceToExpected(source, want);
    });
    const call: IrExpr = {
      kind: "callValue",
      callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
      receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
      args,
      type: fromT.ret,
      loc,
    };
    const body: IrStmt[] = [{ kind: "assign", localId: slot, value: counted, loc }];
    if (target.ret.kind === "void") {
      body.push({ kind: "exprStmt", expr: call, loc }, { kind: "return", value: null, loc });
    } else {
      body.push({ kind: "return", value: lowerer.coerceToExpected(call, target.ret), loc });
    }
    lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, target, params, [], body, loc));
  }
  return { kind: "call", callee: name, args: [closure], type: target, loc };
}

/** The argument count every call through the function type `node` is
 * expected as passes: that type's parameter count when it has one call
 * signature with a fixed parameter list (a `this` parameter is type-only),
 * "varies" when it has optional or rest parameters, null when there is no
 * such type. */
export function contextualCallCount(
  lowerer: Lowerer,
  node: ts.Expression,
): number | "varies" | null {
  const contextual = lowerer.checker.getContextualType(node);
  if (contextual === undefined) return null;
  const expected = lowerer.checker.getNonNullableType(contextual);
  let signatures = lowerer.checker.getCallSignatures(expected);
  // A slot that takes a function or something else (a callback or an
  // options object, a listener or a listener object): the function is
  // called through the one member that is a function type.
  if (signatures.length === 0 && expected.isUnionType()) {
    const callable = ts
      .constituentTypes(expected)
      .map((member) => lowerer.checker.getCallSignatures(member))
      .filter((member) => member.length > 0);
    if (callable.length === 1) signatures = callable[0]!;
  }
  if (signatures.length !== 1) return null;
  const declaration = signatures[0]!.declaration;
  if (declaration === undefined) return null;
  let count = 0;
  for (const parameter of (declaration.parameters?.nodes ?? []) as ts.ParameterDeclaration[]) {
    if (isThisParameter(parameter)) continue;
    if (parameter.questionToken || parameter.initializer || parameter.dotDotDotToken)
      return "varies";
    count++;
  }
  return count;
}

/** Whether the function expression `node` is handed where a type is
 * expected that does not say how it is called: an untyped parameter
 * (`any`, `unknown`, a JavaScript module's function), `Function`, an
 * object type, or a type with several call signatures. Its callers pass
 * what they like, so no constant is the count `arguments.length` reads. */
export function handedWithoutCallCount(lowerer: Lowerer, node: ts.Expression): boolean {
  return (
    lowerer.checker.getContextualType(node) !== undefined &&
    contextualCallCount(lowerer, node) === null
  );
}

/** Whether a program reference to the function declaration or method `fn`
 * reads it as a value (`xs.map(f)`, `const g = f`, `xs.map(C.parse)`) rather
 * than calling it. Export specifiers and default exports only name a
 * function; the importing files' references resolve to it and are checked
 * the same way. */
export function usedAsValue(
  lowerer: Lowerer,
  fn: ts.FunctionDeclaration | ts.MethodDeclaration,
): boolean {
  const name = fn.name;
  if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return false;
  const method = ts.isMethodDeclaration(fn);
  const symbolAt = (n: ts.Node): ts.Symbol | null | undefined =>
    method
      ? lowerer.checker.getSymbolAtLocation(n)
      : lowerer.resolveValueSymbol(n as ts.Identifier);
  const symbol = symbolAt(name);
  if (!symbol) return false;
  let found = false;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    ts.walkPreorder(sf, (n) => {
      if (found) return "stop";
      if (ts.isTypeNode(n)) return "skip";
      if (n === name || !(ts.isIdentifier(n) || ts.isPrivateIdentifier(n))) return undefined;
      if (n.text !== name.text || !n.parent) return undefined;
      const parent = n.parent;
      // A method is read through its member name (`C.parse`, `this.#m`).
      const read = ts.isPropertyAccessExpression(parent) && parent.name === n ? parent : n;
      if (method && read === n && !ts.isBindingElement(parent)) return undefined;
      const use = read.parent;
      if (use && ts.isCallExpression(use) && use.expression === read) return undefined;
      if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) return undefined;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return undefined;
      if (symbolAt(n) === symbol) found = true;
      return undefined;
    });
    if (found) break;
  }
  return found;
}

/** Whether the function being lowered, or the ordinary function an arrow in
 * it inherits `arguments` from, receives the hidden array of the arguments
 * actually passed (ParamMode "arguments"). A parameter that can be absent
 * makes the count a per-call fact, so such a function reads the array
 * instead of folding `arguments.length` to a constant. */
export function readsHiddenArguments(lowerer: Lowerer): boolean {
  for (let i = lowerer.fnStack.length - 1; i >= 0; i--) {
    const ctx = lowerer.fnStack[i]!;
    if (ctx.argumentsLocal) return true;
    if (!ctx.inheritsArguments) return false;
  }
  return false;
}

function fixedArity(fn: ts.FunctionLikeDeclaration): boolean {
  return fn.parameters.nodes.every(
    (p) =>
      p.questionToken === undefined &&
      p.initializer === undefined &&
      p.dotDotDotToken === undefined,
  );
}

function declaredCount(fn: ts.FunctionLikeDeclaration): number {
  return fn.parameters.nodes.filter((p) => !isThisParameter(p)).length;
}
