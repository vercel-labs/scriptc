/* The node:test lowering (a spoke module like lower-dgram.ts): the
 * registration surface — test/it with sync and async bodies, skip/todo/
 * only options and their method twins (test.skip/test.todo/test.only),
 * describe/suite groups (bodies run at registration, Node's collection
 * phase), the before/after/beforeEach/afterEach hooks — plus the
 * TestContext argument's members: t.test subtests (inline on the runner
 * fiber, the settled promise `await` consumes), t.skip/t.todo,
 * t.diagnostic, t.name, and t.assert.* (delegated to the assert spoke —
 * Node's t.assert methods ARE the assert functions bound to the test).
 *
 * Everything else the module declares fences member-qualified with a
 * named hint — mock/run/snapshot (no lowering), concurrency/timeout/plan
 * options, non-literal skip/todo values. Never a generic rejection,
 * never silence. */
import * as ts from "../ts7/adapter.js";
import { resultIsDiscarded } from "./call-position.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { IrExpr, IrType, SrcLoc, STRING, VOID, isUnitType } from "../../ir/nodes.js";
import { numLit, strLit } from "../../ir/build.js";

const TEST_FN_HINT =
  "test bodies take () or (t: TestContext) and return void or Promise<void>";
const TESTCTX_SURFACE_HINT =
  "t.test, t.skip, t.todo, t.diagnostic, t.name, and t.assert.* are the supported TestContext members";

/** Registration calls return Node's Promise<void>, but the promise only
 * resolves through the runner — consuming it outside `await t.test(...)`
 * has no lowering, so top-level registrations stand as statements. */
function requireStatementPosition(L: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  L.noLowering(
    `using the result of ${what}`,
    call,
    "call it as its own statement (await t.test(...) is the supported awaited form)",
  );
}
/** The "file:line:col" of a registration call — the failing-section
 * "test at" line (Node reads the stack; the frontend HAS the position).
 * V8 frames point at the callee's NAME for member calls (`t.test(...)`
 * reports the `test` property's column), at the call for plain ones. */
function atStringOf(expr: ts.CallExpression): string {
  const target = ts.isPropertyAccessExpression(expr.expression)
    ? expr.expression.name
    : expr;
  const sf = expr.getSourceFile();
  const pos = sf.getLineAndCharacterOfPosition(target.getStart());
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1}`;
}

/** One parsed { skip?, todo?, only? } options literal. `mode` is the
 * runtime literal (0 run / 1 skip / 2 todo), `msg` the directive message
 * expression ("" = none). */
interface TestOptions {
  mode: number;
  msg: IrExpr | null;
  only: boolean;
}

/** Parses a test/describe options argument — an OBJECT LITERAL whose
 * skip/todo values are boolean literals or string messages and whose
 * only is the boolean literal. Everything else fences with the option
 * name (concurrency/timeout/plan included — bounded surface, honest
 * fence). */
function lowerTestOptions(L: Lowerer, node: ts.Expression, what: string): TestOptions {
  if (!ts.isObjectLiteralExpression(node)) {
    L.noLowering(
      `${what} with a non-literal options argument`,
      node,
      "pass the options as an object literal: { skip?, todo?, only? }",
    );
  }
  const out: TestOptions = { mode: 0, msg: null, only: false };
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      L.noLowering(
        `${what} options with computed keys, spreads, or shorthand entries`,
        prop,
        "each option must be a plain `name: value` entry with a literal key",
      );
    }
    const name = prop.name.text;
    if (name === "skip" || name === "todo") {
      const mode = name === "skip" ? 1 : 2;
      const t = L.typeOf(prop.initializer);
      if (t.isStringLiteralType() || L.mapTypeOf(t)?.kind === "string") {
        out.mode = mode;
        out.msg = L.lowerExprExpecting(prop.initializer, STRING);
      } else if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        out.mode = mode;
      } else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        // explicit false: run normally
      } else {
        L.noLowering(
          `${what} with a non-literal ${name} value`,
          prop.initializer,
          `${name} takes the literal true/false or a string message here`,
        );
      }
    } else if (name === "only") {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) out.only = true;
      else if (prop.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
        L.noLowering(
          `${what} with a non-literal only value`,
          prop.initializer,
          "only takes the literal true/false here",
        );
      }
    } else {
      L.noLowering(
        `${what} option '${name}'`,
        prop,
        "skip, todo, and only are the supported options",
      );
    }
  }
  return out;
}

/** Lowers a test/hook body, pinning the shape: 0 params or the one
 * TestContext param, returning void (sync) or Promise<void> (async —
 * the runner awaits through the emitted spawn wrapper). Returns the
 * closure and its runtime flags (1 async | 2 takes-ctx). */
function lowerBodyArg(L: Lowerer, node: ts.Expression, what: string, allowCtx: boolean): { cb: IrExpr; flags: number } {
  const cb = L.lowerExpr(node);
  if (cb.type.kind !== "func") {
    L.noLowering(`${what} whose body is not a function`, node, TEST_FN_HINT);
  }
  let flags = 0;
  if (cb.type.params.length > (allowCtx ? 1 : 0)) {
    L.noLowering(
      `${what} with ${cb.type.params.length} parameters`,
      node,
      allowCtx ? TEST_FN_HINT : "hooks take no parameters",
    );
  }
  if (cb.type.params.length === 1) {
    if (cb.type.params[0]!.kind !== "testCtx") {
      L.noLowering(
        `${what} whose parameter is not the TestContext`,
        node,
        TEST_FN_HINT,
      );
    }
    flags |= 2;
  }
  const ret = cb.type.ret;
  if (ret.kind === "promise") {
    if (!(ret.inner.kind === "void" || isUnitType(ret.inner))) {
      L.noLowering(
        `${what} returning Promise<${L.fmt(ret.inner)}>`,
        node,
        TEST_FN_HINT,
      );
    }
    flags |= 1;
  } else if (ret.kind !== "void" && !isUnitType(ret)) {
    L.noLowering(`${what} returning '${L.fmt(ret)}'`, node, TEST_FN_HINT);
  }
  return { cb, flags };
}

/** The shared registration lowering behind test/it and their skip/todo/
 * only method twins — and, with `sub`, behind t.test. Argument shapes:
 * (name), (name, fn), (name, options, fn). */
function lowerRegistration(
  L: Lowerer,
  expr: ts.CallExpression,
  what: string,
  loc: SrcLoc,
  methodMode: number, // 0 none, 1 skip, 2 todo, 3 only
  sub: IrExpr | null, // the lowered TestContext receiver (t.test)
): IrExpr {
  if (sub === null) requireStatementPosition(L, expr, what);
  const args = expr.arguments;
  if (args.length < 1 || args.length > 3) {
    L.noLowering(
      `${what} with ${args.length} arguments`,
      expr,
      "the supported forms are (name), (name, fn), and (name, options, fn)",
    );
  }
  const name = L.lowerExprExpecting(args[0]!, STRING);
  let opts: TestOptions = { mode: 0, msg: null, only: false };
  let fnNode: ts.Expression | undefined;
  if (args.length === 2) fnNode = args[1];
  if (args.length === 3) {
    opts = lowerTestOptions(L, args[1]!, what);
    fnNode = args[2];
  }
  if (methodMode === 1 || methodMode === 2) opts.mode = methodMode;
  if (methodMode === 3) opts.only = true;
  const at = strLit(atStringOf(expr), loc);
  const mode = numLit(opts.mode, loc);
  const msg = opts.msg ?? strLit("", loc);
  if (!fnNode) {
    const emptyFlags = numLit(opts.only ? 4 : 0, loc);
    return sub
      ? { kind: "libCall", fn: "test.subEmpty", args: [sub, name, mode, msg, at], type: VOID, loc }
      : { kind: "libCall", fn: "test.registerEmpty", args: [name, mode, msg, emptyFlags, at], type: VOID, loc };
  }
  const { cb, flags } = lowerBodyArg(L, fnNode, what, true);
  const flagsLit = numLit(flags | (opts.only ? 4 : 0), loc);
  if (sub) {
    const promiseVoid: IrType = { kind: "promise", inner: VOID };
    return { kind: "libCall", fn: "test.sub", args: [sub, name, mode, msg, cb, flagsLit, at], type: promiseVoid, loc };
  }
  return { kind: "libCall", fn: "test.register", args: [name, mode, msg, cb, flagsLit, at], type: VOID, loc };
}

/** describe/suite (and describe.skip/todo/only): the body is a SYNC
 * zero-parameter closure that runs AT registration. */
function lowerSuite(
  L: Lowerer,
  expr: ts.CallExpression,
  what: string,
  loc: SrcLoc,
  methodMode: number,
): IrExpr {
  requireStatementPosition(L, expr, what);
  const args = expr.arguments;
  if (args.length < 2 || args.length > 3) {
    L.noLowering(
      `${what} with ${args.length} arguments`,
      expr,
      "the supported forms are (name, fn) and (name, options, fn)",
    );
  }
  const name = L.lowerExprExpecting(args[0]!, STRING);
  let opts: TestOptions = { mode: 0, msg: null, only: false };
  let fnNode = args[1]!;
  if (args.length === 3) {
    opts = lowerTestOptions(L, args[1]!, what);
    fnNode = args[2]!;
  }
  if (methodMode === 1 || methodMode === 2) opts.mode = methodMode;
  const cb = L.lowerExpr(fnNode);
  if (cb.type.kind !== "func" || cb.type.params.length !== 0) {
    L.noLowering(
      `${what} whose body is not a zero-parameter function`,
      fnNode,
      "suite bodies take no parameters (they run at registration)",
    );
  }
  if (cb.type.ret.kind !== "void" && !isUnitType(cb.type.ret)) {
    L.noLowering(
      `${what} with a non-void body`,
      fnNode,
      "suite bodies are synchronous and return nothing",
    );
  }
  const at = strLit(atStringOf(expr), loc);
  const mode = numLit(opts.mode, loc);
  const msg = opts.msg ?? strLit("", loc);
  return { kind: "libCall", fn: "test.suite", args: [name, mode, msg, cb, at], type: VOID, loc };
}

/** before/after/beforeEach/afterEach — hooks on the enclosing suite
 * (top-level hooks attach to the implicit root). */
function lowerHook(L: Lowerer, expr: ts.CallExpression, which: number, what: string, loc: SrcLoc): IrExpr {
  requireStatementPosition(L, expr, what);
  const args = expr.arguments;
  if (args.length !== 1) {
    L.noLowering(
      `${what} with ${args.length} arguments`,
      expr,
      "the supported form is one zero-parameter function (hook options have no lowering)",
    );
  }
  const { cb, flags } = lowerBodyArg(L, args[0]!, what, false);
  return {
    kind: "libCall", fn: "test.hook",
    args: [numLit(which, loc), cb, numLit(flags, loc)], type: VOID, loc,
  };
}

const HOOK_WHICH: Record<string, number | undefined> = {
  before: 0, after: 1, beforeEach: 2, afterEach: 3,
};

/** Module-function calls on node:test import bindings (named imports AND
 * namespace/default-import members — both funnel here). Null for other
 * modules; every node:test member lands here — unlowered ones fence with
 * the module-qualified name. */
export function lowerNodeTestModuleCall(
  L: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "test") return null;
  switch (bi.member) {
    case "test":
    case "it":
      return lowerRegistration(L, expr, `${bi.member}(...)`, loc, 0, null);
    case "skip":
    case "todo":
    case "only":
      // The default-import method twins (`test.skip(...)` where `test`
      // is the module object).
      return lowerRegistration(
        L, expr, `test.${bi.member}(...)`, loc,
        bi.member === "skip" ? 1 : bi.member === "todo" ? 2 : 3, null,
      );
    case "describe":
    case "suite":
      return lowerSuite(L, expr, `${bi.member}(...)`, loc, 0);
    case "before":
    case "after":
    case "beforeEach":
    case "afterEach":
      return lowerHook(L, expr, HOOK_WHICH[bi.member]!, `${bi.member}(...)`, loc);
    case "run":
      L.noLowering(
        "test.run",
        expr,
        "the programmatic runner has no lowering — run tests by executing the compiled binary",
      );
      break;
    case "snapshot":
      L.noLowering("test.snapshot", expr, "snapshot testing has no lowering");
      break;
    default:
      L.noLowering(
        `test.${bi.member}`,
        expr,
        "test/it, describe/suite, before/after/beforeEach/afterEach, and the skip/todo/only twins are the lowered node:test members",
        ts.isIdentifier(expr.expression) ? L.resolveValueSymbol(expr.expression) : undefined,
      );
  }
  return null; // unreachable — noLowering throws
}

/** The callable-module form: `test(...)` where the callee identifier IS
 * the node:test module binding — a default import (`import test from
 * "node:test"`) or the CJS `const test = require('node:test')` twin
 * (Node's module object is the test function itself). Null for other
 * callees. */
export function lowerTestDirectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (L.builtinNamespaceModuleOf(callee) !== "test") return null;
  const calleeSym = L.checker.getSymbolAtLocation(callee);
  const decl = calleeSym ? L.checker.declarationsOf(calleeSym)[0] : undefined;
  if (decl && ts.isNamespaceImport(decl)) {
    L.unsupported(
      "SC1013",
      expr,
      "calling a module namespace object (Node throws TypeError there — " +
        'use the default import: import test from "node:test")',
    );
  }
  return lowerRegistration(L, expr, "test(...)", loc, 0, null);
}

/** Method-position node:test calls — one entry in lower-calls.ts's
 * intrinsic chain: skip/todo/only twins on NAMED import bindings
 * (`test.skip(...)` where `test` came from `{ test }`), the TestContext
 * surface (t.test/t.skip/t.todo/t.diagnostic), and t.assert.* (delegated
 * to the assert spoke). Null for other receivers. */
export function lowerTestMethodCall(
  L: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  const member = access.name.text;
  // test.skip / it.only / describe.todo on a NAMED import binding: the
  // receiver resolves to the module member the binding imported.
  if (ts.isIdentifier(access.expression)) {
    const bi = L.builtinImportOf(access.expression);
    if (bi && bi.module === "test") {
      if ((bi.member === "test" || bi.member === "it") && (member === "skip" || member === "todo" || member === "only")) {
        return lowerRegistration(
          L, call, `${bi.member}.${member}(...)`, loc,
          member === "skip" ? 1 : member === "todo" ? 2 : 3, null,
        );
      }
      if ((bi.member === "describe" || bi.member === "suite") && (member === "skip" || member === "todo" || member === "only")) {
        return lowerSuite(L, call, `${bi.member}.${member}(...)`, loc, member === "skip" ? 1 : member === "todo" ? 2 : 0);
      }
      if (bi.member === "mock") {
        L.noLowering("test.mock", call, "mocking has no lowering", L.checker.getSymbolAtLocation(access.name));
      }
      L.noLowering(
        `test.${bi.member}.${member}`,
        call,
        "skip, todo, and only are the supported method twins",
        L.checker.getSymbolAtLocation(access.name),
      );
    }
  }
  // t.assert.strictEqual(...) — the callee's receiver is `t.assert` on a
  // TestContext: Node's t.assert methods ARE the assert functions (bound
  // to the test for its counters — not modeled; the throw is identical),
  // so the assert spoke owns the call shape.
  if (
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "assert" &&
    L.mapTypeOf(L.typeOf(access.expression.expression))?.kind === "testCtx" &&
    L.isStdlibMember(access.expression)
  ) {
    const served = L.lowerAssertModuleCall(call, { module: "assert", member }, loc);
    if (served) return served;
    L.noLowering(
      `t.assert.${member}`,
      call,
      "the assert-module surface is the supported t.assert surface",
      L.checker.getSymbolAtLocation(access.name),
    );
  }
  // The TestContext receiver surface.
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "testCtx") return null;
  if (!L.isStdlibMember(access)) return null;
  const args = call.arguments;
  if (member === "test") {
    const receiver = L.lowerExpr(access.expression);
    return lowerRegistration(L, call, "t.test(...)", loc, 0, receiver);
  }
  if (member === "skip" || member === "todo") {
    requireStatementPosition(L, call, `t.${member}(...)`);
    if (args.length > 1) {
      L.noLowering(`t.${member} with ${args.length} arguments`, call, `the supported form is t.${member}([message])`);
    }
    const receiver = L.lowerExpr(access.expression);
    const msg = args[0] ? L.lowerExprExpecting(args[0], STRING) : strLit("", loc);
    return {
      kind: "libCall", fn: member === "skip" ? "test.ctxSkip" : "test.ctxTodo",
      args: [receiver, msg], type: VOID, loc,
    };
  }
  if (member === "diagnostic") {
    requireStatementPosition(L, call, "t.diagnostic(...)");
    if (args.length !== 1) {
      L.noLowering(`t.diagnostic with ${args.length} arguments`, call, "the supported form is t.diagnostic(message)");
    }
    const receiver = L.lowerExpr(access.expression);
    const msg = L.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "test.ctxDiagnostic", args: [receiver, msg], type: VOID, loc };
  }
  L.noLowering(
    `TestContext.${member}`,
    call,
    TESTCTX_SURFACE_HINT,
    L.checker.getSymbolAtLocation(access.name),
  );
}

/** `t.name` as a VALUE — one entry in lower-exprs' property chain. Null
 * for other receivers/members (the chain keeps trying); unlowered
 * TestContext members fence member-qualified. */
export function lowerTestCtxProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken) return null;
  if (L.mapTypeOf(L.typeOf(expr.expression))?.kind !== "testCtx") return null;
  if (!L.isStdlibMember(expr)) return null;
  const loc = locOf(expr);
  if (expr.name.text === "name") {
    const receiver = L.lowerExpr(expr.expression);
    return { kind: "libCall", fn: "test.ctxName", args: [receiver], type: STRING, loc };
  }
  if (expr.name.text === "assert") return null; // claimed by the call path
  L.noLowering(
    `TestContext.${expr.name.text}`,
    expr,
    TESTCTX_SURFACE_HINT,
    L.checker.getSymbolAtLocation(expr.name),
  );
}
