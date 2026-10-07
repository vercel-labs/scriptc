import { varRef } from "../../ir/build.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import type { Lowerer } from "./lowerer.js";
import {
  DYN,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type SrcLoc,
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
import { generatorMeta, type ParamShape } from "./call-signatures.js";

/** True when the identifier resolves (through import aliases) to a
 * top-level function declaration of ANY program file (not merely a
 * same-named local shadowing one). Functions declared directly in a
 * FLATTENED namespace block count — splitFiles hoisted them into the
 * same collection lists top-level declarations ride. */
export function isTopLevelFnSymbol(lowerer: Lowerer, ident: ts.Identifier): boolean {
  const symbol = lowerer.resolveValueSymbol(ident);
  if (symbol && lowerer.staticCallables.get(symbol)?.kind === "declared-function") return true;
  const decl = symbol ? lowerer.checker.declarationsOf(symbol)[0] : undefined;
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
    isJsSourceFile(node.getSourceFile()) &&
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
    isJsSourceFile(node.getSourceFile()) &&
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
  // A lambda IS a value: the completed-ABI rule applies at birth. The
  // contextual (target) type decides — `(x?: number) => void` may flow
  // into a slot annotated `(x: number | undefined) => void` (same ABI
  // signature), anything else is fenced. Nested function declarations and
  // object-literal shorthand methods aren't expressions — always fenced.
  if (
    !(
      ts.isMethodDeclaration(node) &&
      isJsSourceFile(node.getSourceFile()) &&
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
  const nameIdent =
    !ts.isArrowFunction(node) && node.name && ts.isIdentifier(node.name) ? node.name : null;
  const baseName = nameIdent ? nameIdent.text : "";
  const fnName = `%fn${lowerer.lambdaCounter++}${baseName ? `_${baseName}` : ""}`;
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
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
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
  const inferredSignature =
    isJsSourceFile(node.getSourceFile()) && !node.type
      ? lowerer.checker.getSignatureFromDeclaration(node)
      : undefined;
  const returnsConstructor =
    inferredSignature &&
    producesConstructor(lowerer, lowerer.checker.getReturnTypeOfSignature(inferredSignature));
  if (
    isJsSourceFile(node.getSourceFile()) &&
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
    const { params, prologue } = lowerer.declareParams(node.parameters, shapes);
    // Checked JavaScript functions take their receiver from the call site.
    // Store it as this function's binding so escaping arrows capture it,
    // and a method nested inside another method never captures its owner.
    if ((checkedReceiver || isJsSourceFile(node.getSourceFile())) && !ts.isArrowFunction(node)) {
      const receiver = lowerer.declareThis(DYN);
      prologue.unshift({
        kind: "varDecl",
        localId: receiver.id,
        init: {
          kind: "libCall",
          fn: isGenerator ? "dyn.generatorThis" : "dyn.this",
          args: [],
          type: DYN,
          loc,
        },
        loc,
      });
    }
    declareFunctionArguments(
      lowerer,
      node,
      shapes,
      params,
      prologue,
      loc,
      funcType.rest === true &&
        funcType.restAbi === undefined &&
        !shapes.some((s) => s.mode === "dynRest" || s.mode === "islandRest"),
    );

    let body: IrStmt[];
    if (ts.isBlock(node.body!)) {
      body = lowerer.lowerStmts(node.body!.statements);
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
          body =
            value.kind === "unitLit"
              ? []
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
          value = { kind: "awaitExpr", value, type: value.type.inner, loc: value.loc };
        }
        body =
          value.type.kind === "void" && lowerer.wrappedUndefined(bodyReturn, locOf(node.body!))
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
    if (!isJsSourceFile(node.getSourceFile())) throw e;
    const params: IrParam[] = funcType.params.map((t, i) => ({
      localId: `%pf${i}`,
      name: `%pf${i}`,
      type: t,
    }));
    // A REST-MARKED value type hides one synthetic trailing dyn-array
    // param in the lifted function (the boxed call thunk fills it) —
    // the fence lambda must spell that slot too or the validator's
    // closure-signature check trips (SC9001). Island rest types SPELL
    // their trailing engine-array param, so funcType.params already
    // covers those.
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
    const { params, prologue } = lowerer.declareParams(decl.parameters, sig.params);
    declareFunctionArguments(
      lowerer,
      decl,
      sig.params,
      params,
      prologue,
      locOf(decl),
      sig.params.length > decl.parameters.length &&
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
    const body = [...prologue, ...lowerer.lowerStmts(bodyBlock.statements)];
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
    if (isJsSourceFile(decl.getSourceFile())) {
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
