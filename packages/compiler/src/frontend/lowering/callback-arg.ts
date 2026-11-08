import * as ts from "../ts7/adapter.js";
import { canBoxFuncIntoDyn, DYN, funcOf, type IrExpr, type IrType, VOID } from "../../ir/ir.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { withoutParentheses } from "../outer-expressions.js";
import { isJsSourceFile, locOf } from "../program.js";
import { isThisParameter } from "./call-signatures.js";
import { functionUsesThis } from "./cjs-exports-object.js";
import type { Lowerer } from "./lowerer.js";

/** The declarations behind the call signatures of the function `node`
 * evaluates to, as far as the checker names them: the function written in
 * place, or the one a binding, a member or an import resolves to. */
type SignatureNode = NonNullable<
  ReturnType<Lowerer["checker"]["getCallSignatures"]>[number]["declaration"]
>;

function callbackDeclarations(lowerer: Lowerer, node: ts.Expression): SignatureNode[] {
  const value = withoutParentheses(node);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return [value];
  try {
    return lowerer.checker
      .getCallSignatures(lowerer.typeOf(value))
      .flatMap((signature) => (signature.declaration ? [signature.declaration] : []));
  } catch {
    return [];
  }
}

/** The parameters a signature's declaration names. */
function declaredParameters(declaration: SignatureNode): readonly ts.ParameterDeclaration[] {
  return (declaration.parameters?.nodes ?? []).filter(ts.isParameter);
}

/** Whether `node` is a function written in place, or names one by its
 * declaration: a function declaration, or a constant initialized with a
 * function written in place and no declared type. Such a value is a
 * function of its own signature, never the content of a typed slot. */
export function namesDeclaredFunction(lowerer: Lowerer, node: ts.Expression): boolean {
  const value = withoutParentheses(node);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  if (!ts.isIdentifier(value)) return false;
  let declarations: readonly ts.Node[];
  try {
    declarations = lowerer.resolveValueSymbol(value)?.declarations ?? [];
  } catch {
    return false;
  }
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (ts.isFunctionDeclaration(declaration)) return true;
      if (!ts.isVariableDeclaration(declaration) || declaration.type !== undefined) return false;
      if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return false;
      const initializer = declaration.initializer;
      return (
        initializer !== undefined &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      );
    })
  );
}

/** Whether the function `node` evaluates to observes every argument its
 * caller passes, as far as the program says: it declares a rest parameter,
 * or its own body reads `arguments`. */
export function callbackTakesEveryArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  return callbackDeclarations(lowerer, node).some(
    (declaration) =>
      declaredParameters(declaration).some((param) => param.dotDotDotToken !== undefined) ||
      (!ts.isArrowFunction(declaration) &&
        ts.isFunctionLike(declaration) &&
        declaration.body !== undefined &&
        bodyReadsArguments(declaration)),
  );
}

/** Whether the function `node` evaluates to reads the `this` it is called
 * with, as far as the program says: its body reads `this` (an arrow reads
 * the enclosing one), or its signature declares a `this` parameter. */
export function callbackReadsThis(lowerer: Lowerer, node: ts.Expression): boolean {
  return callbackDeclarations(lowerer, node).some((declaration) => {
    if (ts.isArrowFunction(declaration)) return false;
    if (declaredParameters(declaration).some(isThisParameter)) return true;
    return (
      ts.isFunctionLike(declaration) &&
      declaration.body !== undefined &&
      functionUsesThis(declaration as ts.FunctionLikeDeclaration)
    );
  });
}

/** Refuses, in a TypeScript source, a callback that reads `this` where
 * Node.js calls it with a receiver the native call does not pass (`what`
 * names the function, `receiver` what Node passes). The callback would
 * read `undefined` there, silently. JavaScript sources keep their callbacks:
 * a function there may name `this` without relying on it. */
export function refuseCallbackThis(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  receiver: string,
): void {
  if (isJsSourceFile(ts.getSourceFileOfNode(node))) return;
  if (!callbackReadsThis(lowerer, node)) {
    // A function stored under a type that hides its read of `this` can
    // still arrive here: the store is what answers for it.
    lowerer.noteReceiverCall(node, what);
    return;
  }
  lowerer.unsupported(
    "SC1090",
    node,
    `a callback that reads 'this', passed to ${what} (Node.js calls it with ${receiver} as 'this', which the native call does not pass; read that value by name, or write the callback as an arrow function)`,
  );
}

interface CallbackArgOptions {
  /** Event payload tuple for checked-dynamic callback adaptation. */
  dynTuple?: readonly IrType[];
  /** The dgram precedent: a raw dyn value may fill a zero-arg slot. */
  dynZero?: boolean;
  /** Reject non-void callbacks instead of adapting their result away. */
  rejectValueReturn?: boolean;
  adapt?: (cb: IrExpr) => IrExpr;
}

/** Shared listener/callback shape validation for the Node spoke modules.
 * `paramOk` is asked about every declared parameter, by position: the
 * runtime calls the closure with the event's native payload, so a
 * parameter of another type would read that payload as something it is
 * not. A callback whose only mismatched parameters are dynamic (`unknown`,
 * `any`, an untyped JavaScript parameter) crosses the checked-dynamic
 * boundary instead when the event's payload tuple is known. */
export function lowerCallbackArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (param: IrType, index: number) => boolean,
  paramHint: string,
  options: CallbackArgOptions = {},
): { cb: IrExpr; nparams: number } {
  let cb = lowerer.lowerExpr(node);
  if (cb.type.kind === "dyn" && options.dynTuple !== undefined) {
    const toT = funcOf([...options.dynTuple], VOID);
    return {
      cb: { kind: "dynCheck", value: cb, type: toT, loc: locOf(node) },
      nparams: options.dynTuple.length,
    };
  }
  if (
    options.dynTuple !== undefined &&
    cb.type.kind === "func" &&
    (cb.type.rest === true ||
      (cb.type.params.length > 0 && cb.type.params.some((param, i) => !paramOk(param, i)))) &&
    cb.type.params.every((param, i) => param.kind === "dyn" || paramOk(param, i)) &&
    canBoxFuncIntoDyn(
      cb.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
    const toT = funcOf([...options.dynTuple], VOID);
    return {
      cb: { kind: "dynCheck", value: boxed, type: toT, loc: locOf(node) },
      nparams: options.dynTuple.length,
    };
  }
  if (cb.type.kind === "dyn" && options.dynZero && maxParams === 0) {
    cb = { kind: "dynCheck", value: cb, type: funcOf([], VOID), loc: locOf(node) };
  }
  // A function or undefined: an optional callback read from storage that
  // can hold undefined (a binding code can read before its first store keeps
  // the stored value where the library's parameter admits undefined).
  const arms = cb.type.kind === "union" ? lowerer.unions.get(cb.type.unionId)?.arms : undefined;
  if (
    arms?.length === 2 &&
    arms.some((arm) => arm.kind === "func") &&
    arms.some((arm) => arm.kind === "undefinedT")
  ) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} that may be undefined (pass a function: test the value first, or wrap it in an arrow function)`,
    );
  }
  if (cb.type.kind !== "func" || cb.type.params.length > maxParams) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} with more than ${maxParams} parameter${maxParams === 1 ? "" : "s"} (${paramHint})`,
    );
  }
  if (options.rejectValueReturn && cb.type.ret.kind !== "void") {
    lowerer.unsupported(
      "SC1090",
      node,
      "listeners returning a value (make the callback body a block, or return nothing)",
    );
  }
  const params = cb.type.params;
  for (let i = 0; i < params.length; i++) {
    if (!paramOk(params[i]!, i)) {
      lowerer.unsupported(
        "SC1090",
        node,
        `${what} whose parameter is not supported (${paramHint})`,
      );
    }
  }
  const adapted = options.adapt?.(cb) ?? cb;
  return { cb: adapted, nparams: cb.type.params.length };
}
