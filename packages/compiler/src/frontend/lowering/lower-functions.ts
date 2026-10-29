import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { declareTypedArguments } from "./typed-arguments.js";
import { declareArgumentCount } from "./argument-counts.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { declareContextLocal, type FnCtx } from "./function-context.js";
import { isErrorFirstErrorType } from "./builtins/arguments.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import { isRebindableFunctionSymbol } from "./rebindable-functions.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
  VOID,
  canBoxFuncIntoDyn,
  typeEquals,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { PoisonError, jsFuncNameOf, newFnCtx } from "./lowerer.js";
import { enforceLibBoundary, lowerSurplusCalls } from "./lib-boundary.js";
import { returnsOnlyThis } from "./lower-classes.js";
import { declSymbolOf } from "./lower-modules.js";
import {
  hasExplicitJsDocReturn,
  producesConstructor,
  resolveInferredReturn,
  appendImplicitUndefinedReturn,
  blockBodyOf,
} from "./function-returns.js";
import { generatorMeta, isThisParameter, type ParamShape } from "./call-signatures.js";
import { isStrictCode } from "./strict-mode.js";
import { lowerSloppyGlobalReceiver } from "./lower-global-value.js";

/** Save the call-site receiver before defaults or body effects. Escaping
 * arrows capture this binding instead of reading a later call's receiver. */
function declareCallReceiver(
  lowerer: Lowerer,
  node: ts.FunctionLikeDeclaration,
  generator: boolean,
): IrStmt {
  const receiver = lowerer.declareThis(DYN);
  const loc = locOf(node);
  const bound: IrExpr = {
    kind: "libCall",
    fn: generator ? "dyn.generatorThis" : "dyn.this",
    args: [],
    type: DYN,
    loc,
  };
  // A sloppy-mode function's `this` is the global object when it is called
  // with undefined or null. The function's own body decides its mode.
  const sloppy = !ts.isArrowFunction(node) && node.body !== undefined && !isStrictCode(node.body);
  return {
    kind: "varDecl",
    localId: receiver.id,
    init: sloppy
      ? {
          kind: "nullish",
          left: bound,
          right: lowerSloppyGlobalReceiver(lowerer, node, loc),
          type: DYN,
          loc,
        }
      : bound,
    loc,
  };
}

/** Remove the receiver declaration when no lookup of `this` reached it:
 * the parameters, the body and nested arrows never read it, so the entry
 * does not read the call-site receiver. */
function dropUnreadReceiver(ctx: FnCtx, prologue: IrStmt[], receiver: IrStmt | null): void {
  if (receiver === null || receiver.kind !== "varDecl" || ctx.thisRead) return;
  const at = prologue.indexOf(receiver);
  if (at < 0) return;
  prologue.splice(at, 1);
  const local = ctx.locals.findIndex((l) => l.id === receiver.localId);
  if (local >= 0) ctx.locals.splice(local, 1);
  ctx.thisLocal = null;
}

/** True when the identifier resolves (through import aliases) to a
 * top-level function declaration of ANY program file (not merely a
 * same-named local shadowing one). Functions declared directly in a
 * FLATTENED namespace block count — splitFiles hoisted them into the
 * same collection lists top-level declarations ride. */
export function isTopLevelFnSymbol(lowerer: Lowerer, ident: ts.Identifier): boolean {
  const symbol = lowerer.resolveValueSymbol(ident);
  // A reassigned JavaScript declaration is read through its module global.
  if (isRebindableFunctionSymbol(lowerer, symbol ?? undefined)) return false;
  if (symbol && lowerer.staticCallables.get(symbol)?.kind === "declared-function") return true;
  const decl = symbol ? symbol.declarations[0] : undefined;
  return (
    !!decl &&
    ts.isFunctionDeclaration(decl) &&
    (ts.isSourceFile(decl.parent) ||
      (decl.parent !== undefined && lowerer.nsBlocks.get(decl.parent) === "flattened"))
  );
}

/** Nested `function name(...) {...}`: declare the mutable function binding
 * before lowering its body, then initialize it with the lifted closure.
 * The early declaration is observable only when another nested closure
 * captures the binding: its box must exist before either side of a mutual
 * recursion cycle builds its closure. Forward source references use the
 * same split declaration/assignment through predeclareForwardFnDecl.
 * Self-references inside the body lower to `selfRef`, not a capture: a box
 * holding its own closure would be an RC cycle. */
export function lowerNestedFunctionDecl(lowerer: Lowerer, stmt: ts.FunctionDeclaration): IrStmt {
  if (!stmt.name) lowerer.unsupported("SC1090", stmt, "anonymous function declarations");
  const { funcType } = lowerer.lambdaSignature(stmt);
  // Function declaration bindings are mutable in JavaScript. More
  // importantly, putting the empty slot into the owning statement list
  // BEFORE lowerLambda lets a sibling lowered from that body capture this
  // local's eventual box. The local object may become boxed while either
  // body lowers; backends inspect its final shape when emitting varDecl.
  const local = lowerer.declareLocal(stmt.name, stmt.name.text, funcType, true);
  let declared = false;
  for (let i = lowerer.activeStmtLists.length - 1; i >= 0; i--) {
    const entry = lowerer.activeStmtLists[i]!;
    if (entry.ctx !== lowerer.ctx || !entry.stmts.includes(stmt)) continue;
    entry.out.push({ kind: "varDecl", localId: local.id, init: null, loc: locOf(stmt) });
    declared = true;
    break;
  }
  if (!declared) {
    throw new InternalCompilerError(
      "lowerer bug: nested function declaration has no active statement list",
    );
  }
  const init = lowerer.lowerLambda(stmt);
  // Body inference may settle a JS return differently from the initial
  // checker signature. Publish that same ABI on the hoisted binding and
  // every mutable capture of it before callers are lowered.
  if (init.type.kind === "func" && !typeEquals(local.type, init.type)) {
    local.type = init.type;
    for (const fn of lowerer.liftedFns)
      for (const capture of fn.captures ?? []) {
        if (capture.localId === local.id) capture.type = init.type;
      }
  }
  return { kind: "assign", localId: local.id, value: init, loc: locOf(stmt) };
}

/** Install the hidden arguments binding, or clone a source rest pack
 * when the body reads arguments separately. Never alias those two arrays. */
function declareFunctionArguments(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  shapes: readonly ParamShape[],
  params: IrParam[],
  prologue: IrStmt[],
  loc: SrcLoc,
  receivesArgumentsSlot: boolean,
): void {
  if (receivesArgumentsSlot) {
    const local = lowerer.declareHiddenLocal("%arguments", DYN);
    params.push({ localId: local.id, name: "%arguments", type: DYN });
    lowerer.ctx.argumentsLocal = local;
  }
  if (
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    !ts.isArrowFunction(node) &&
    shapes.length === 1 &&
    shapes[0]?.mode === "dynRest" &&
    bodyReadsArguments(node)
  ) {
    const local = lowerer.declareHiddenLocal("%arguments", DYN);
    prologue.push({
      kind: "varDecl",
      localId: local.id,
      init: {
        kind: "dynInvoke",
        recv: varRef(params[0]!.localId, DYN, loc),
        method: "slice",
        calleeName: "Array.prototype.slice",
        args: [],
        type: DYN,
        loc,
      },
      loc,
    });
    lowerer.ctx.argumentsLocal = local;
  }
}

/** The type parameters a lambda without its own takes from a generic
 * contextual signature, unbound in the current scope. */
function contextualTypeParameterSymbols(
  lowerer: Lowerer,
  node: ts.ArrowFunction | ts.FunctionExpression,
): ts.Symbol[] {
  const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(node));
  if (signatures.length !== 1) return [];
  const symbols: ts.Symbol[] = [];
  for (const parameter of signatures[0]!.getTypeParameters()) {
    const symbol = parameter.getSymbol();
    if (!symbol || lowerer.typeParamBindings?.has(symbol)) return [];
    symbols.push(symbol);
  }
  return symbols;
}

/** Lifts an arrow function / function expression / nested declaration /
 * object-literal shorthand method to a module-level function and yields
 * the `closure` expression creating it. */
export function lowerLambda(
  lowerer: Lowerer,
  node:
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  checkedReceiver = false,
): IrExpr {
  // A generic lambda used as a value has no per-call instantiation: it
  // lowers once with its type parameters bound to `unknown`, the erased
  // instance JavaScript itself runs.
  if (node.typeParameters?.nodes.length && !lowerer.erasingLambdas.has(node)) {
    const previous = lowerer.typeParamBindings;
    const bindings = new Map(previous ?? []);
    for (const parameter of node.typeParameters.nodes) {
      const symbol = lowerer.checker.getSymbolAtLocation(parameter.name);
      if (symbol) bindings.set(symbol, DYN);
    }
    lowerer.typeParamBindings = bindings;
    lowerer.erasingLambdas.add(node);
    lowerer.erasingDepth++;
    try {
      return lowerLambda(lowerer, node, checkedReceiver);
    } finally {
      lowerer.erasingDepth--;
      lowerer.erasingLambdas.delete(node);
      lowerer.typeParamBindings = previous;
    }
  }
  // A lambda contextually typed by a GENERIC signature (`send: (m) => …`
  // for `send<T>(m: Msg<T>): string`) takes that signature's type
  // parameters as its own; it lowers once, erased, like a generic lambda.
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    !node.typeParameters?.nodes.length &&
    !lowerer.erasingLambdas.has(node)
  ) {
    const contextual = contextualTypeParameterSymbols(lowerer, node);
    if (contextual.length > 0) {
      const previous = lowerer.typeParamBindings;
      const bindings = new Map(previous ?? []);
      for (const symbol of contextual) bindings.set(symbol, DYN);
      lowerer.typeParamBindings = bindings;
      lowerer.erasingLambdas.add(node);
      lowerer.erasingDepth++;
      try {
        return lowerLambda(lowerer, node, checkedReceiver);
      } finally {
        lowerer.erasingDepth--;
        lowerer.erasingLambdas.delete(node);
        lowerer.typeParamBindings = previous;
      }
    }
  }
  const prepared =
    ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      ? lowerer.preparedClassFactories.get(node)
      : undefined;
  if (prepared) return prepared;
  const loc = locOf(node);
  const signature = lowerer.lambdaSignature(node);
  const { shapes } = signature;
  let { funcType } = signature;
  // Reflected JS methods receive the caller's actual `this`, which may
  // be a Proxy or a descriptor-created object rather than the class.
  // Fluent methods must return that receiver without a class cast.
  if (
    ts.isMethodDeclaration(node) &&
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    !node.type &&
    !node.asteriskToken &&
    !hasExplicitJsDocReturn(node) &&
    returnsOnlyThis(node)
  ) {
    funcType = {
      ...funcType,
      ret: funcType.ret.kind === "promise" ? { ...funcType.ret, inner: DYN } : DYN,
    };
  }
  // An ASYNC lambda whose signature answered a bare checked-dynamic result
  // (`retry(async () => loose())` against a library slot typed
  // `(...) => A | Promise<A>` with A = any — the union collapses to `any`):
  // calling it still produces a promise, so the value's result is
  // Promise<unknown>, the payload the dyn the body returns.
  if (
    funcType.ret.kind === "dyn" &&
    !ts.isAccessor(node) &&
    node.asteriskToken === undefined &&
    node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
  ) {
    funcType = { ...funcType, ret: { kind: "promise", inner: DYN } };
  }
  // A lambda IS a value: the completed-ABI rule applies at birth. The
  // contextual (target) type decides — `(x?: number) => void` may flow
  // into a slot annotated `(x: number | undefined) => void` (same ABI
  // signature), anything else is fenced. Object-literal shorthand methods
  // aren't expressions: their slot is the literal's, judged inside.
  // A nested function DECLARATION is not an expression either: lowering it
  // builds the body, not a value, and every value use re-runs the same
  // fence at the reference (identifiers.ts) with that use's own target
  // (a call, or `const g = f` under an annotated slot). Fencing it here
  // refused declarations that are only ever CALLED.
  if (
    !ts.isFunctionDeclaration(node) &&
    !(
      ts.isMethodDeclaration(node) &&
      isJsSourceFile(ts.getSourceFileOfNode(node)) &&
      canBoxFuncIntoDyn(
        funcType,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
  )
    lowerer.requireExactArityValue(
      node,
      ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : null,
      shapes,
      funcType,
    );
  // An error-first callback that reads its Buffer result: undefined on the
  // error path, as in Node.
  const undefinedResult = undefinedResultParam(
    lowerer,
    node,
    shapes,
    lowerer.errorFirstLiterals.has(node),
  );
  const nameIdent =
    !ts.isArrowFunction(node) && node.name && ts.isIdentifier(node.name) ? node.name : null;
  const baseName = nameIdent ? nameIdent.text : "";
  const fnName = lowerer.closureName(locOf(node), baseName ? `_${baseName}` : "");
  // Named function expressions/declarations can self-reference by name; an
  // object-literal method's name is a PROPERTY, not a binding — no self.
  const selfSymbol =
    nameIdent && !ts.isMethodDeclaration(node) && !ts.isAccessor(node)
      ? (lowerer.checker.getSymbolAtLocation(nameIdent) ?? null)
      : null;

  // Async lambdas — object-literal async METHODS included (a method in
  // an object literal is a function value in a record field; no vtable
  // exists to dispatch through): the VALUE's type returns Promise<T>,
  // the lifted body returns the inner T (a `return v` fulfills with v).
  const isAsync =
    !ts.isAccessor(node) &&
    node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = node.asteriskToken !== undefined;
  if (isAsync && !isGenerator && funcType.ret.kind !== "promise")
    lowerer.badType(node, lowerer.typeOf(node));
  // Generator lambdas (function* expressions and object-literal
  // *methods): the VALUE's type returns the generator; the lifted body
  // returns the TReturn channel (a `return v` is the done-value).
  if (
    isGenerator &&
    (funcType.ret.kind !== "generator" || (funcType.ret.async === true) !== isAsync)
  )
    lowerer.badType(node, lowerer.typeOf(node));
  let bodyReturn = isGenerator
    ? lowerer.genBodyReturnType(funcType.ret)
    : lowerer.bodyReturnType(isAsync, funcType.ret);

  const fnCtx = newFnCtx(true, selfSymbol, funcType, bodyReturn);
  if (lowerer.methodLambdasInProgress.has(node))
    lowerer.methodLambdasInProgress.set(node, { fnName, type: funcType, selfReads: 0 });
  const inferredSignature =
    isJsSourceFile(ts.getSourceFileOfNode(node)) && !node.type
      ? lowerer.checker.getSignatureFromDeclaration(node)
      : undefined;
  const returnsConstructor =
    inferredSignature &&
    producesConstructor(lowerer, lowerer.checker.getReturnTypeOfSignature(inferredSignature));
  if (
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    !node.type &&
    !isAsync &&
    !isGenerator &&
    (bodyReturn.kind === "classval" ||
      bodyReturn.kind === "date" ||
      bodyReturn.kind === "symbol" ||
      bodyReturn.kind === "record" ||
      ((bodyReturn.kind === "dyn" || bodyReturn.kind === "func") && returnsConstructor))
  ) {
    fnCtx.inferReturn = { entries: [] };
  }
  fnCtx.inheritsArguments = ts.isArrowFunction(node);
  fnCtx.isAsync = isAsync;
  if (isGenerator && funcType.ret.kind === "generator") {
    fnCtx.generator = generatorMeta(lowerer, funcType.ret);
  }
  const diagsBefore = lowerer.diags.length;
  lowerer.fnStack.push(fnCtx);
  try {
    const receiver =
      (checkedReceiver ||
        isJsSourceFile(ts.getSourceFileOfNode(node)) ||
        node.parameters.nodes.some(isThisParameter)) &&
      !ts.isArrowFunction(node)
        ? declareCallReceiver(lowerer, node, isGenerator)
        : null;
    const { params, prologue } = lowerer.declareParams(node.parameters.nodes, shapes);
    if (receiver) prologue.unshift(receiver);
    if (ts.isFunctionExpression(node) && lowerer.typedArgumentsLambdas.has(node))
      declareTypedArguments(lowerer, node, shapes, params, prologue);
    declareFunctionArguments(
      lowerer,
      node,
      shapes,
      params,
      prologue,
      loc,
      funcType.rest === true &&
        funcType.restAbi === undefined &&
        !shapes.some((s) => s.mode === "dynRest"),
    );

    const lowerBody = (): IrStmt[] => {
      let body: IrStmt[];
      if (ts.isBlock(node.body!)) {
        body = lowerer.lowerStmts(node.body!.statements.nodes);
      } else {
        // Bare-expression arrow body: `x => e` is `x => { return e; }`
        // (or an expression statement when the signature returns void — or
        // when a union-returning signature wraps a void expression, whose
        // value is the implicit undefined arm appended below).
        const bodyExpr = node.body as ts.Expression;
        if (bodyReturn.kind === "void") {
          // `() => undefined` — the return type maps to void (standalone
          // undefined IS void in the type mapping) and the body value is a
          // bare unit literal: a pure no-op, dropped rather than tripping
          // the validator's bare-unitLit rule (typeCheckReturnExpression).
          // A `void e` body rides the statement lowering (the value is
          // discarded here, so the operand evaluates for effect alone —
          // `(name) => void doThing(name)`, the fire-and-forget arrow). A
          // conditional body does the same so its void arms become lazy
          // statement branches instead of a forbidden void-valued ternary.
          let stripped: ts.Expression = bodyExpr;
          while (ts.isParenthesizedExpression(stripped)) stripped = stripped.expression;
          if (ts.isVoidExpression(stripped) || ts.isConditionalExpression(stripped)) {
            body = [lowerer.lowerExprStatement(stripped)];
          } else {
            const value = lowerer.lowerExpr(bodyExpr);
            // `async () => p` with a void result still resolves the
            // function's promise with p (its settlement, rejections included);
            // a maybe-promise value adopts only its promise arm.
            const flattened = isAsync ? lowerer.maybePromiseReturn(bodyExpr, value, VOID) : null;
            body = flattened
              ? [flattened]
              : value.kind === "unitLit"
                ? []
                : isAsync && value.type.kind === "promise"
                  ? [lowerer.adoptingReturn(value, VOID, (e) => e)]
                  : [{ kind: "exprStmt", expr: value, loc: locOf(node.body!) }];
          }
        } else {
          // Concise and block bodies use the same destination layout for
          // fresh literals. Async bodies must inspect promises first.
          let value =
            isAsync || fnCtx.inferReturn
              ? lowerer.lowerExpr(bodyExpr)
              : lowerer.lowerExprExpecting(bodyExpr, bodyReturn);
          // An async concise body whose value is itself a promise
          // (`async () => p`): the async machinery RESOLVES the returned
          // thenable into the function's own promise — lowerReturnValue's
          // await-through, applied to the implicit return.
          if (isAsync && value.type.kind === "promise" && bodyReturn.kind !== "promise") {
            value = lowerer.returnedPromiseAwait(value);
          }
          const flattened =
            isAsync && !fnCtx.inferReturn
              ? lowerer.maybePromiseReturn(bodyExpr, value, bodyReturn)
              : null;
          body = flattened
            ? [flattened]
            : value.type.kind === "void" && lowerer.wrappedUndefined(bodyReturn, locOf(node.body!))
              ? [{ kind: "exprStmt", expr: value, loc: locOf(node.body!) }]
              : [
                  {
                    kind: "return",
                    value: fnCtx.inferReturn
                      ? value
                      : lowerer.coerceInto(bodyExpr, value, bodyReturn),
                    loc: locOf(node.body!),
                  },
                ];
          if (fnCtx.inferReturn && body[0]?.kind === "return")
            fnCtx.inferReturn.entries.push({ stmt: body[0], node: bodyExpr });
        }
      }
      return body;
    };
    let body = undefinedResult
      ? lowerUndefinedResultBody(lowerer, node, undefinedResult, lowerBody)
      : lowerBody();
    if (fnCtx.inferReturn) {
      bodyReturn = resolveInferredReturn(
        lowerer,
        { returnType: bodyReturn },
        fnCtx.inferReturn,
        body,
        node,
      );
      funcType = { ...funcType, ret: bodyReturn };
      fnCtx.returnType = bodyReturn;
    }
    dropUnreadReceiver(fnCtx, prologue, receiver);
    body = [...prologue, ...body];
    // Bare-expression bodies never pass through lowerStmts, so the
    // lib-boundary chokepoint runs here (idempotent for block bodies,
    // whose statements were already walked). A fence poisons the
    // enclosing statement — the lambda IS part of it.
    body = lowerSurplusCalls(lowerer, body);
    enforceLibBoundary(lowerer, body);
    appendImplicitUndefinedReturn(lowerer, body, bodyReturn, loc);

    const ctx = lowerer.ctx;
    const lifted: IrFunction = {
      name: fnName,
      sourceName: jsFuncNameOf(node) ?? "<anonymous>",
      ...(!isAsync &&
      !isGenerator &&
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
        ? { ownsPrototype: true as const }
        : {}),
      params,
      returnType: bodyReturn,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    };
    if (isAsync) lifted.async = true;
    if (fnCtx.generator) lifted.generator = fnCtx.generator;
    lowerer.liftedFns.push(lifted);
    return { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
  } catch (e) {
    // JS sources defer LAMBDA poisons like function declarations
    // (lowerFunction's catch, lambda form — entry the function-level
    // deferral): a fenced concise body (`(list) => new Intl.ListFormat
    // (...).format(list)` — the error-message list-join idiom) would
    // otherwise poison the ENCLOSING statement, stopping module init
    // where Node only stops when the lambda is CALLED. The value
    // compiles as a capture-free closure over a runtimeFence body —
    // calling throws the first captured diagnostic at its source
    // position. ICEs (SC9001) stay compile errors, exactly like
    // lowerStmts; probe mode (diagSink) keeps the poison.
    if (!(e instanceof PoisonError)) throw e;
    if (!isJsSourceFile(ts.getSourceFileOfNode(node))) throw e;
    const params: IrParam[] = funcType.params.map((t, i) => ({
      localId: `%pf${i}`,
      name: `%pf${i}`,
      type: t,
    }));
    // A REST-MARKED value type hides one synthetic trailing dyn-array
    // param in the lifted function (the boxed call thunk fills it) —
    // the fence lambda must spell that slot too to preserve its ABI.
    if (funcType.rest === true && funcType.restAbi === undefined) {
      params.push({ localId: "%pfrest", name: "%pfrest", type: DYN });
    }
    const fence = lowerer.deferToRuntimeFence(diagsBefore, node, {
      kind: "closure",
      name: fnName,
      params,
      returnType: bodyReturn,
      type: funcType,
      ...(isAsync ? { async: true as const } : {}),
      ...(fnCtx.generator ? { generator: fnCtx.generator } : {}),
    });
    if (!fence) throw e;
    return fence;
  } finally {
    lowerer.fnStack.pop();
  }
}

export function lowerFunction(lowerer: Lowerer, decl: ts.FunctionDeclaration): IrFunction | null {
  // Overload signatures and ambient declarations are type-world: they
  // share the implementation's symbol (when one exists) but have no body
  // of their own — collection skipped them and the run/discover loops do
  // too; this guard is defensive.
  if (!decl.body) return null;
  const declSymbol = declSymbolOf(lowerer, decl);
  const sig = declSymbol ? lowerer.fnSigsBySymbol.get(declSymbol) : undefined;
  if (!sig) return null; // signature collection failed

  const bodyReturn =
    sig.generator !== undefined
      ? lowerer.genBodyReturnType(sig.returnType)
      : lowerer.bodyReturnType(sig.isAsync === true, sig.returnType);
  const ctx = newFnCtx(false, null, null, bodyReturn);
  ctx.isAsync = sig.isAsync === true;
  if (sig.generator !== undefined) ctx.generator = sig.generator;
  const diagsBefore = lowerer.diags.length;
  lowerer.fnStack.push(ctx);
  try {
    // The count a call through a value stored is taken (and its slot
    // cleared) before the parameters bind: a destructuring default that
    // throws must not leave the slot set for the next direct call.
    const argumentCount: IrStmt[] = [];
    declareArgumentCount(lowerer, decl, argumentCount);
    const receiver =
      decl.parameters.nodes.some(isThisParameter) || isJsSourceFile(ts.getSourceFileOfNode(decl))
        ? declareCallReceiver(lowerer, decl, sig.generator !== undefined)
        : null;
    const { params, prologue } = lowerer.declareParams(decl.parameters.nodes, sig.params);
    if (receiver) prologue.unshift(receiver);
    prologue.unshift(...argumentCount);
    declareFunctionArguments(
      lowerer,
      decl,
      sig.params,
      params,
      prologue,
      locOf(decl),
      sig.params.length > decl.parameters.nodes.length &&
        (sig.params[sig.params.length - 1]!.mode === "dynRest" ||
          sig.params[sig.params.length - 1]!.mode === "arguments"),
    );
    const bodyBlock = blockBodyOf(decl);
    if (!bodyBlock) {
      lowerer.unsupported(
        "SC1090",
        decl,
        "function declarations whose block body the frontend cannot locate",
      );
    }
    const undefinedResult = undefinedResultParam(lowerer, decl, sig.params, false);
    const lowerBody = (): IrStmt[] => lowerer.lowerStmts(bodyBlock.statements.nodes);
    const statements = undefinedResult
      ? lowerUndefinedResultBody(lowerer, decl, undefinedResult, lowerBody)
      : lowerBody();
    dropUnreadReceiver(ctx, prologue, receiver);
    const body = [...prologue, ...statements];
    appendImplicitUndefinedReturn(lowerer, body, bodyReturn, locOf(decl));
    const fn: IrFunction = {
      name: sig.name,
      sourceName: decl.name?.text ?? "<anonymous>",
      ...(!sig.isAsync && !sig.generator ? { ownsPrototype: true as const } : {}),
      params,
      returnType: bodyReturn,
      locals: lowerer.ctx.locals,
      body,
      loc: locOf(decl),
    };
    if (sig.isAsync) fn.async = true;
    if (sig.generator !== undefined) fn.generator = sig.generator;
    return fn;
  } catch (e) {
    // A poison OUTSIDE the per-statement catches (a parameter DEFAULT
    // whose initializer is fenced, a parameter PATTERN over a class
    // that never lowered): the diagnostic is already recorded — the
    // function skips, like a signature-blocked one, instead of killing
    // the whole analysis.
    if (!(e instanceof PoisonError)) throw e;
    // JS sources defer function-level poisons like statement fences
    // (the sentence-walker idiom `({ parent: sentenceNode })` over the
    // #private-fenced AstPath): the function compiles as its OWN
    // runtimeFence — CALLING it throws the first captured diagnostic
    // at the declaration's position — so a reachable-but-broken
    // signature stops the RUN at its own site instead of the build.
    // ICEs (SC9001) stay compile errors, exactly like lowerStmts.
    if (isJsSourceFile(ts.getSourceFileOfNode(decl))) {
      // An ABI type naming a class that never REGISTERED (the sentence-
      // walker idiom's path type — the #private fence) is fine to emit:
      // callers CAN lower calls to this symbol (a same-typed param
      // passes straight through — no construction needed), so the fence
      // function must exist, and run()'s unregistered-class sweep
      // rewrites every such slot to the inert f64 placeholder before
      // emission — caller and fence stay ABI-consistent.
      const params: IrParam[] = sig.params.map((p, i) => ({
        localId: `%pf${i}`,
        name: `%pf${i}`,
        type: p.type,
      }));
      const fence = lowerer.deferToRuntimeFence(diagsBefore, decl, {
        kind: "function",
        name: sig.name,
        params,
        returnType: bodyReturn,
        ...(sig.isAsync ? { async: true as const } : {}),
        ...(sig.generator ? { generator: sig.generator } : {}),
      });
      if (fence) return fence;
    }
    return null;
  } finally {
    lowerer.fnStack.pop();
  }
}

/** The parameters of an error-first callback whose Buffer result its body
 * reads: `(err, out)` with err typed Error | null (or any) and out a
 * Buffer. The callback adapters of zlib and crypto pass a NULL Buffer
 * after an error, where Node passes undefined. `error` is the error
 * parameter's symbol when nothing writes it; `onlyAdapterCalls` marks a
 * literal passed straight to such a function, which nothing else calls. */
interface UndefinedResultParam {
  symbol: ts.Symbol;
  name: ts.Identifier;
  error: ts.Symbol | null;
  onlyAdapterCalls: boolean;
}

function undefinedResultParam(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  shapes: readonly ParamShape[],
  onlyAdapterCalls: boolean,
): UndefinedResultParam | null {
  const params = node.parameters.nodes.filter((p) => !isThisParameter(p));
  if (params.length !== 2 || shapes.length !== 2 || node.asteriskToken !== undefined) return null;
  const [errorDecl, decl] = params as [ts.ParameterDeclaration, ts.ParameterDeclaration];
  const [errorShape, shape] = shapes as [ParamShape, ParamShape];
  if (
    !ts.isIdentifier(decl.name) ||
    decl.initializer !== undefined ||
    decl.questionToken !== undefined ||
    decl.dotDotDotToken !== undefined ||
    shape.mode !== "required" ||
    shape.type.kind !== "bytes" ||
    shape.type.elem !== "u8" ||
    errorShape.mode !== "required" ||
    !isErrorFirstErrorType(lowerer, errorShape.type)
  )
    return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (
    symbol === undefined ||
    node.body === undefined ||
    !readsSymbol(lowerer, node.body, symbol, decl.name)
  )
    return null;
  const errorSymbol = ts.isIdentifier(errorDecl.name)
    ? lowerer.checker.getSymbolAtLocation(errorDecl.name)
    : undefined;
  const error =
    errorSymbol !== undefined &&
    errorDecl.initializer === undefined &&
    bindingNeverReassigned(lowerer, errorSymbol, errorDecl)
      ? errorSymbol
      : null;
  return { symbol, name: decl.name, error, onlyAdapterCalls };
}

/** Whether `body` reads `symbol` (other than at its declaration `name`). */
function readsSymbol(
  lowerer: Lowerer,
  body: ts.Node,
  symbol: ts.Symbol,
  name: ts.Identifier,
): boolean {
  let read = false;
  const visit = (n: ts.Node): void => {
    if (read) return;
    if (ts.isShorthandPropertyAssignment(n)) {
      if (lowerer.checker.getShorthandAssignmentValueSymbol(n) === symbol) read = true;
    } else if (ts.isIdentifier(n)) {
      if (n !== name && lowerer.checker.getSymbolAtLocation(n) === symbol) read = true;
    } else {
      ts.forEachChild(n, visit);
    }
  };
  visit(body);
  return read;
}

/** The body of an error-first callback whose Buffer result may be absent.
 * With a result, the body lowers as written. Without one (the adapter's
 * NULL Buffer after an error), the body lowers again with the result read
 * as `any` holding undefined and the error parameter holding an Error.
 * Conditions on the error parameter fold in that copy (staticCondition),
 * and in the first copy too, as null, for a literal only the adapter
 * calls: a body that returns after `if (err)` then keeps the rest of its
 * statements in the first copy only.
 *
 * Inside an error-path copy, a nested callback lowers once with the result
 * read as `any`, so nested callbacks do not double at every level. An
 * error-path copy with no lowering throws a coded error when it runs. */
function lowerUndefinedResultBody(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  result: UndefinedResultParam,
  lowerBody: () => IrStmt[],
): IrStmt[] {
  const loc = locOf(node);
  const param = lowerer.bindingIn(lowerer.ctx, result.symbol);
  if (param === null) throw new InternalCompilerError("lowerer bug: callback result unbound");
  const absent = (): IrExpr => ({
    kind: "libCall",
    fn: "bytes.isAbsent",
    args: [varRef(param.id, param.type, loc)],
    type: BOOL,
    loc,
  });
  const fence: IrStmt = {
    kind: "runtimeFence",
    code: "SC2020",
    message: `the callback's '${result.name.text}' is undefined after an error, and this callback has no lowering that reads it as undefined`,
    loc,
  };
  const withKnownError = (error: boolean | null, lower: () => IrStmt[]): IrStmt[] => {
    if (result.error === null || error === null) return lower();
    lowerer.knownErrors.set(result.error, error);
    try {
      return lower();
    } finally {
      lowerer.knownErrors.delete(result.error);
    }
  };
  /** The body with the result read as `any` from `slot`, or null when it
   * has no such lowering or converts the result into a static slot. */
  const lowerDynamic = (slot: IrLocal, knownError: boolean | null): IrStmt[] | null => {
    const diags = lowerer.diags.length;
    const stats = lowerer.suppressStats;
    lowerer.scopes.push(new Map([[result.symbol, slot]]));
    lowerer.anySymbols.add(result.symbol);
    lowerer.suppressStats = true;
    lowerer.errorPathCopies++;
    try {
      const lowered = withKnownError(knownError, lowerBody);
      if (lowerer.diags.length > diags || !readsSlotDynamically(lowered, slot.id))
        throw new PoisonError();
      // Passed on into a Buffer slot, the result is the Buffer it holds
      // (the adapter's, or one the body assigned), or, while it holds
      // undefined, the absent Buffer, which a callee with this entry test
      // reads as undefined.
      const guarded = new Set<IrExpr>();
      return transformStmtList(lowered, {
        expr: (e) => {
          if (!isBufferCheckOf(e, slot.id) || guarded.has(e)) return e;
          guarded.add(e);
          return {
            kind: "ternary",
            cond: {
              kind: "dynTest",
              test: "undefined",
              value: varRef(slot.id, DYN, e.loc),
              type: BOOL,
              loc: e.loc,
            },
            then: { kind: "libCall", fn: "bytes.absent", args: [], type: e.type, loc: e.loc },
            else_: e,
            type: e.type,
            loc: e.loc,
          };
        },
        stmt: (stmt) => stmt,
      });
    } catch (error) {
      if (error instanceof InternalCompilerError) throw error;
      lowerer.diags.length = diags;
      return null;
    } finally {
      lowerer.errorPathCopies--;
      lowerer.anySymbols.delete(result.symbol);
      lowerer.scopes.pop();
      lowerer.suppressStats = stats;
    }
  };
  // Mutable: the body may assign to its result (`if (!out) out = ...`).
  const slot = declareContextLocal(lowerer.ctx, "%result", DYN, true, undefined, undefined);
  const undefinedResult: IrStmt = {
    kind: "varDecl",
    localId: slot.id,
    init: dynUndefinedExpr(loc),
    loc,
  };
  if (lowerer.errorPathCopies > 0) {
    // One copy for both paths, with the result boxed when present.
    const dynamic = lowerDynamic(slot, null);
    if (dynamic !== null)
      return [
        {
          kind: "varDecl",
          localId: slot.id,
          init: {
            kind: "ternary",
            cond: absent(),
            then: dynUndefinedExpr(loc),
            else_: lowerer.coerceInto(result.name, varRef(param.id, param.type, loc), DYN),
            type: DYN,
            loc,
          },
          loc,
        },
        ...dynamic,
      ];
  }
  const withResult = withKnownError(result.onlyAdapterCalls ? false : null, lowerBody);
  const withoutResult = lowerDynamic(slot, true);
  return [
    {
      kind: "if",
      cond: absent(),
      then: withoutResult === null ? [fence] : [undefinedResult, ...withoutResult],
      else_: withResult,
      loc,
    },
  ];
}

/** Whether the error-path copy reads the checked-dynamic result slot only as
 * a checked-dynamic value, never converted into a static slot (where Node
 * would hold undefined) other than a Buffer one. */
function readsSlotDynamically(body: IrStmt[], slotId: string): boolean {
  const isSlot = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === slotId;
  return everyStmtList(body, {
    expr: (e) => {
      if (isSlot(e)) return e.type.kind === "dyn";
      if (e.kind === "dynCheck" && isSlot(e.value)) return isBufferCheckOf(e, slotId);
      return true;
    },
    stmt: () => true,
  });
}

/** Whether `e` converts the result slot into a Buffer slot. */
function isBufferCheckOf(e: IrExpr, slotId: string): boolean {
  return (
    e.kind === "dynCheck" &&
    e.value.kind === "varRef" &&
    e.value.localId === slotId &&
    e.type.kind === "bytes" &&
    e.type.elem === "u8"
  );
}

/** The diagnostics of a TypeScript function whose signature did not
 * compile, for the coverage remainder: its statements lower for their
 * diagnostics only (the remainder's output is discarded), so the report
 * lists them with the signature's blocker instead of hiding them behind it.
 * Each parameter whose type maps is declared, and a use of any other
 * parameter reports SC2004 back to the declaration. The statements already
 * count as failed (countSkippedBody), so the pass leaves the stats alone.
 * The pass adds diagnostics only: an internal error while it lowers drops
 * what it found, and the signature's blocker stands alone as before. */
export function blockedBodyDiagnostics(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
): ScrDiagnostic[] {
  const body = decl.body;
  if (!body || decl.typeParameters || decl.asteriskToken) return [];
  if (isJsSourceFile(ts.getSourceFileOfNode(decl))) return [];
  const symbol = declSymbolOf(lowerer, decl);
  if (!symbol || lowerer.fnSigsBySymbol.has(symbol)) return [];
  const diagsBefore = lowerer.diags.length;
  const fencesBefore = lowerer.runtimeFences.length;
  const suppressStats = lowerer.suppressStats;
  lowerer.suppressStats = true;
  let declared: IrType = DYN;
  lowersCleanly(lowerer, () => {
    declared = lowerer.declaredReturnType(decl, decl);
  });
  const isAsync = decl.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  const ctx = newFnCtx(false, null, null, lowerer.bodyReturnType(isAsync, declared));
  ctx.isAsync = isAsync;
  lowerer.fnStack.push(ctx);
  let internal = false;
  try {
    // A declared `this` parameter gives the body its receiver, as
    // lowerFunction declares it.
    if (decl.parameters.nodes.some(isThisParameter)) declareCallReceiver(lowerer, decl, false);
    for (const param of decl.parameters.nodes) {
      if (isThisParameter(param)) continue;
      const declaredParam = lowersCleanly(lowerer, () => {
        lowerer.declareParams([param], lowerer.paramShapes([param]));
      });
      if (declaredParam) continue;
      const symbol = ts.isIdentifier(param.name)
        ? lowerer.checker.getSymbolAtLocation(param.name)
        : undefined;
      if (symbol) lowerer.blockedBindings.add(symbol);
    }
    lowersCleanly(lowerer, () => {
      lowerer.lowerStmts(body.statements.nodes);
    });
  } catch (error) {
    if (!(error instanceof InternalCompilerError)) throw error;
    internal = true;
  } finally {
    lowerer.fnStack.pop();
    lowerer.suppressStats = suppressStats;
  }
  lowerer.runtimeFences.splice(fencesBefore);
  const diags = lowerer.diags.splice(diagsBefore);
  return internal || diags.some((d) => d.code === "SC9001") ? [] : diags;
}

/** Runs `lower`, for blockedBodyDiagnostics: false when it poisons, with the
 * diagnostics it recorded dropped (a failed mapping reports what the
 * signature's blocker already reports). */
function lowersCleanly(lowerer: Lowerer, lower: () => void): boolean {
  const before = lowerer.diags.length;
  try {
    lower();
    return true;
  } catch (error) {
    if (!(error instanceof PoisonError)) throw error;
    lowerer.diags.splice(before);
    return false;
  }
}
