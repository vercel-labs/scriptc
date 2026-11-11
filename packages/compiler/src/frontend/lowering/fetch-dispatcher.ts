/* The global fetch with a dispatcher.
 *
 * `fetch(url, { dispatcher })` sends the request through an object of the
 * undici package (an Agent, a ProxyAgent, a class extending Dispatcher):
 * Node's fetch is undici's. The native fetch has its own transport and
 * knows no dispatcher, and the built-in undici (shims/undici) has a fetch
 * that dispatches. So in a program that contains that package, a global
 * fetch call whose init can carry a dispatcher tests the init when it runs
 * and hands a request with one to the package's fetch, which sends it
 * through the dispatcher or refuses, by name, an object that is no
 * dispatcher of the package. A program without the package cannot make
 * such an object, and its fetch calls compile as before.
 *
 * The package's function reaches the call through one program global: the
 * package's module stores it there when it starts (the intrinsic
 * `scriptcFetchDispatcherHook`), and a flag beside it says that it has.
 */
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  funcOf,
  STRING,
  type IrExpr,
  type IrGlobal,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { extendsElementOf } from "../heritage-elements.js";
import { FETCH_DISPATCHER_HOOK, isPackageShimFile } from "../package-shims.js";
import type { Lowerer } from "./lowerer.js";

const HOOK_ID = "%g.%fetch.dispatcherHook";
const HOOK_SET_ID = "%g.%fetch.dispatcherHookSet";

/** `(input, init) => Promise<Response>` over checked-dynamic values. */
const HOOK_TYPE: IrType = funcOf([DYN, DYN], { kind: "promise", inner: DYN });

/** The two globals: the package's function, and whether it is stored. */
function hookGlobals(lowerer: Lowerer): { fn: IrGlobal; set: IrGlobal } {
  const global = (id: string, type: IrType): IrGlobal => {
    let found = lowerer.globalsList.find((g) => g.id === id);
    if (found === undefined) {
      found = { id, name: id.slice(3), type, mutable: true };
      lowerer.globalsList.push(found);
    }
    return found;
  };
  return { fn: global(HOOK_ID, HOOK_TYPE), set: global(HOOK_SET_ID, BOOL) };
}

/** Whether the program contains the built-in undici package. */
export function programHasUndiciPackage(lowerer: Lowerer): boolean {
  const known = lowerer.undiciPackageInProgram;
  if (known !== null) return known;
  let found = false;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (isPackageShimFile(sf.fileName) && sf.fileName.includes("/undici/")) {
      found = true;
      break;
    }
  }
  lowerer.undiciPackageInProgram = found;
  return found;
}

/** `scriptcFetchDispatcherHook(fn)` in the package: stores `fn` and sets
 * the flag. The call's value is the function. */
export function lowerFetchDispatcherHook(
  lowerer: Lowerer,
  callee: ts.Identifier,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (callee.text !== FETCH_DISPATCHER_HOOK) return null;
  const argument = call.arguments.nodes[0];
  if (argument === undefined || call.arguments.nodes.length !== 1) return null;
  const hook = hookGlobals(lowerer);
  const fn = lowerer.lowerExprExpecting(argument, HOOK_TYPE);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "assign", localId: hook.fn.id, value: fn, loc },
      {
        kind: "assign",
        localId: hook.set.id,
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
    ],
    result: varRef(hook.fn.id, HOOK_TYPE, loc),
    type: HOOK_TYPE,
    loc,
  };
}

/** Whether the init `node` is a literal that names every member it has
 * and none of them is `dispatcher`: most calls, which stay as they are. */
function initHoldsNoDispatcher(node: ts.Expression): boolean {
  const init = withoutParenthesesTypeWrappers(node);
  if (!ts.isObjectLiteralExpression(init)) return false;
  return init.properties.nodes.every((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    const name = property.name;
    if (name === undefined) return false;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text !== "dispatcher";
    return false;
  });
}

/** The global fetch call `native` (input and init already evaluated into
 * `input` and `init`), routed: a request whose init carries a dispatcher
 * goes to the package's fetch once the package has started. `native`
 * itself when the program has no such package or the init cannot carry
 * one. */
export function fetchThroughDispatcher(
  lowerer: Lowerer,
  initNode: ts.Expression | undefined,
  input: IrExpr,
  init: IrExpr,
  native: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (initNode === undefined || init.type.kind !== "dyn") return native;
  if (initHoldsNoDispatcher(initNode) || !programHasUndiciPackage(lowerer)) return native;
  const dynInput = input.type.kind === "dyn" ? input : lowerer.coerceToExpected(input, DYN);
  if (dynInput.type.kind !== "dyn") return native;
  const hook = hookGlobals(lowerer);
  const dispatcher: IrExpr = {
    kind: "dynKeyGet",
    value: init,
    key: { kind: "strLit", value: "dispatcher", type: STRING, loc },
    optional: true,
    type: DYN,
    loc,
  };
  // `dispatcher == undefined` holds for undefined and null.
  const absent: IrExpr = {
    kind: "libCall",
    fn: "dyn.abstractEq",
    args: [dispatcher, dynUndefinedExpr(loc)],
    type: BOOL,
    loc,
  };
  return {
    kind: "ternary",
    cond: {
      kind: "logical",
      op: "&&",
      left: varRef(hook.set.id, BOOL, loc),
      right: { kind: "unary", op: "!", operand: absent, type: BOOL, loc },
      type: BOOL,
      loc,
    },
    then: {
      kind: "callValue",
      callee: varRef(hook.fn.id, HOOK_TYPE, loc),
      args: [dynInput, init],
      type: native.type,
      loc,
    },
    else_: native,
    type: native.type,
    loc,
  };
}

/** A value written as the init's `dispatcher` that cannot be a dispatcher
 * of the package: an object literal, or an instance of a class that
 * extends no class of the package. Such a call is refused when the
 * program is built; any other value is tested when the call runs. */
export function definitelyNoUndiciDispatcher(lowerer: Lowerer, value: ts.Expression): boolean {
  const written = withoutParenthesesTypeWrappers(value);
  if (ts.isObjectLiteralExpression(written)) return true;
  let symbol = lowerer.typeOf(written).getSymbol();
  for (let depth = 0; symbol !== undefined && depth < 32; depth++) {
    const declaration: ts.Node | undefined = symbol.declarations.find(
      (d) => ts.isClassDeclaration(d) || ts.isClassExpression(d),
    );
    if (declaration === undefined) return false;
    if (isPackageShimFile(ts.getSourceFileOfNode(declaration).fileName)) return false;
    const base = extendsElementOf(declaration as ts.ClassDeclaration);
    if (base === undefined) return true;
    symbol = lowerer.typeOf(base.expression).getSymbol();
    // The class value's type names the class through its symbol; a
    // constructor type without one ends the walk undecided.
  }
  return false;
}
