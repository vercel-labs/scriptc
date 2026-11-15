/** The refusing function value: what a JavaScript source reads for a Node
 * function or class that native code has no value for.
 *
 * Node hands the program a real function. The compiled value is one function
 * per name, with Node's `name` and `length`, whose body throws the named
 * refusal: `typeof` answers "function", identity holds across every spelling
 * of the name (`fn === fs.readFileSync`, Set membership), inspection prints
 * `[Function: name]`, and calling or constructing it is refused where that
 * happens. A read is not a use, so a module that only stores, compares or
 * re-exports the value keeps loading.
 *
 * One builder serves every such value: a builtin module function with no
 * value adapter, a builtin module member with no lowering at all, a global
 * function or class with no lowering, and the Node globals native code does
 * not provide (host-global-values.ts adds the constructor's own `prototype`
 * to those, because native code can produce no instance of them). */
import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type SrcLoc, funcOf } from "../../ir/ir.js";
import {
  nodeValueDiag,
  unsupportedDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";
import { builtinFenceHintOf, builtinModuleFnOf } from "./surfaces.js";
import { nodeGlobalKind, nodeModuleMemberKind } from "./node-values.js";

/** The lifted function a refusing value closes over, defined once per
 * program under `lifted`. `message` is what it throws. `ownsPrototype` gives
 * the function its own `prototype` object: a host global's shape, for a
 * class native code can produce no instance of, so `x instanceof C` is false
 * for every value. A class native code does produce instances of has no
 * `prototype` here, so `instanceof` through its value throws instead of
 * answering false for a real instance. */
export function defineRefusingFunction(
  lowerer: Lowerer,
  lifted: string,
  diag: ScrDiagnostic,
  message: string,
  loc: SrcLoc,
  ownsPrototype = false,
): boolean {
  if (lowerer.liftedFnNamed(lifted) !== undefined) return false;
  lowerer.liftedFns.push({
    name: lifted,
    ...(ownsPrototype ? { ownsPrototype: true as const } : {}),
    params: [],
    locals: [],
    returnType: DYN,
    body: [{ kind: "runtimeFence", code: diag.code, message, loc }],
    loc,
  });
  return true;
}

/** The refusing function value over `lifted`, boxed under Node's `name` and
 * `length` (the closure's own arity when Node's length is not known). */
export function refusingFunctionRef(
  lifted: string,
  name: string,
  length: number | undefined,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: lifted, captures: [], type: funcOf([], DYN), loc },
    fnName: name,
    ...(length !== undefined ? { fnLength: length } : {}),
    type: DYN,
    loc,
  };
}

/** The name a refusing function value stands for (`fs.readFileSync`,
 * `URL`), or null when `value` is not one. `new` spelled on such a value is
 * refused by name where it is written (lower-classes.ts): the value cannot
 * be constructed, and "is not a constructor" would be a fabricated answer
 * for a class Node constructs. */
export function refusingFunctionNameOf(value: IrExpr): string | null {
  if (value.kind !== "dynFrom" || value.value.kind !== "closure") return null;
  const lifted = value.value.fnName;
  if (!lifted.startsWith(FENCE_PREFIX)) return null;
  const display = lifted.slice(FENCE_PREFIX.length);
  return display.startsWith("global.") ? display.slice("global.".length) : display;
}

const FENCE_PREFIX = "%builtin.fence.";

/** The message a deferred refusal throws: the diagnostic's text at the
 * source line that first read the value. */
export function locatedFenceMessage(diag: ScrDiagnostic, node: ts.Node): string {
  const source = ts.getSourceFileOfNode(node);
  const line = ts.getLineAndCharacterOfPosition(source, diag.loc.start).line + 1;
  return `${diag.message} [${diag.code} at ${diag.loc.file}:${line}]`;
}

/** A builtin module function or class used as a JavaScript value when it has
 * no value of its own (lowerBuiltinCallableValue answered none).
 *
 * A member the call tables lower keeps the refusal its value always had
 * (SC1090: the direct call works, the value does not), reported once where
 * it is first read. A member with no lowering at all throws the SC2020 that
 * names it; reading it reports nothing, because the read does not throw. */
export function builtinFunctionFenceValue(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const display = `${bi.module}.${bi.member}`;
  const lifted = `%builtin.fence.${display}`;
  const kind = nodeModuleMemberKind(bi.module, bi.member);
  const length = kind?.kind === "function" ? kind.length : undefined;
  if (builtinModuleFnOf(lowerer, bi.module, bi.member)) {
    const diag = unsupportedDiag(
      "SC1090",
      loc,
      `library functions as values ('${display}' has no function-value lowering; call it directly)`,
    );
    const message = locatedFenceMessage(diag, node);
    if (defineRefusingFunction(lowerer, lifted, diag, message, loc))
      lowerer.runtimeFences.push(diag);
  } else {
    const diag = nodeValueDiag(display, loc, builtinFenceHintOf(bi.module, bi.member));
    const message = locatedFenceMessage(diag, node);
    defineRefusingFunction(lowerer, lifted, diag, message, loc);
  }
  return refusingFunctionRef(lifted, bi.member, length, loc);
}

/** A global function or class used as a JavaScript value when it has no
 * value of its own: calling or constructing it throws the SC2020 that names
 * it. `diag` replaces the refusal for the globals whose direct use reports a
 * different one. */
export function globalFunctionFenceValue(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  diag: ScrDiagnostic = nodeValueDiag(name, loc),
): IrExpr {
  const lifted = `%builtin.fence.global.${name}`;
  const kind = nodeGlobalKind(name);
  defineRefusingFunction(lowerer, lifted, diag, `${diag.message} [${diag.code}]`, loc);
  return refusingFunctionRef(
    lifted,
    name,
    kind?.kind === "function" ? kind.length : undefined,
    loc,
  );
}
