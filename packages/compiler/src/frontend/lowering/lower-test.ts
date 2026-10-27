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
import {
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  BOOL,
  DYN,
  F64,
  STRING,
  TESTCTX_T,
  VOID,
  isUnitType,
} from "../../ir/ir.js";
import { dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import {
  lowerMockContextCall,
  lowerMockContextProperty,
  lowerMockFn,
  lowerMockMethod,
  lowerMockTimersCall,
  lowerMockTrackerCall,
  type MockTracker,
} from "./lower-mock.js";

const MOCK_HINT =
  "mock.fn, mock.method, mock.restoreAll, mock.reset and mock.timers are the supported mock members";

/** The mock tracker members that lower, for the module's `mock` (tracker
 * null) and t.mock. Null for other members. */
function lowerMockTrackerMember(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  what: string,
  tracker: () => MockTracker,
): IrExpr | null {
  switch (member) {
    case "fn":
      return lowerMockFn(lowerer, call, `${what}.fn`, tracker());
    case "method":
      return lowerMockMethod(lowerer, call, `${what}.method`, tracker());
    case "restoreAll":
    case "reset":
      return lowerMockTrackerCall(lowerer, call, member, tracker());
    default:
      return null;
  }
}

const TEST_FN_HINT = "test bodies take () or (t: TestContext) and return void or Promise<void>";
const TESTCTX_SURFACE_HINT =
  "t.test, t.skip, t.todo, t.diagnostic, t.plan, t.before, t.after, t.beforeEach, t.afterEach, t.name, t.fullName, t.filePath, t.attempt, t.passed, t.workerId, t.tags, and t.assert.* are the supported TestContext members";

/** Registration calls return Node's Promise<void>, but the promise only
 * resolves through the runner — consuming it outside `await t.test(...)`
 * has no lowering, so top-level registrations stand as statements. */
function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.noLowering(
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
  const target = ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name : expr;
  const sf = ts.getSourceFileOfNode(expr);
  const pos = sf.getLineAndCharacterOfPosition(ts.tokenStartOfNode(target));
  return `${sf.fileName}:${pos.line + 1}:${pos.character + 1}`;
}

/** One parsed { skip?, todo?, only? } options literal. `skip` and `todo`
 * are whether each is set (a string or true), and `skipMsg` and `todoMsg`
 * the string messages (directiveOf settles them). */
interface TestOptions {
  skip: boolean;
  skipMsg: IrExpr | null;
  todo: boolean;
  todoMsg: IrExpr | null;
  only: boolean;
  /** The { plan } count, -1 without one. */
  plan: number;
  /** The { timeout } in ms, null without one. */
  timeout: IrExpr | null;
  /** The { concurrency } count (-1 for true, 1 for false), null without one. */
  concurrency: IrExpr | null;
  /** The non-literal option values, evaluated in source order before the
   * registration call reads them. */
  pre: IrStmt[];
}

const noOptions = (): TestOptions => ({
  skip: false,
  skipMsg: null,
  todo: false,
  todoMsg: null,
  only: false,
  plan: -1,
  timeout: null,
  concurrency: null,
  pre: [],
});

/** The runtime mode (0 run / 1 skip / 2 todo) and directive message of a
 * test or suite, as Node's Test constructor settles them: the skip and todo
 * method twins override the options of the same name, skip wins over
 * todo, and the message is the skip string, else the todo string. */
function directiveOf(opts: TestOptions, methodMode: number, loc: SrcLoc): [IrExpr, IrExpr] {
  if (methodMode === 1) {
    opts.skip = true;
    opts.skipMsg = null;
  }
  if (methodMode === 2) {
    opts.todo = true;
    opts.todoMsg = null;
  }
  const mode = opts.skip ? 1 : opts.todo ? 2 : 0;
  return [numLit(mode, loc), opts.skipMsg ?? opts.todoMsg ?? strLit("", loc)];
}

/** Flags 8 and 16: a { timeout } and a { concurrency } are given. */
const optionFlags = (opts: TestOptions): number =>
  (opts.only ? 4 : 0) | (opts.timeout ? 8 : 0) | (opts.concurrency ? 16 : 0);

/** Evaluates a non-literal option value into a hidden local, so option
 * values run in source order. */
function optionValue(lowerer: Lowerer, out: TestOptions, value: IrExpr, loc: SrcLoc): IrExpr {
  if (value.kind === "strLit" || value.kind === "numLit") return value;
  const slot = lowerer.declareHiddenLocal("%testOption", value.type);
  out.pre.push({ kind: "varDecl", localId: slot.id, init: value, loc });
  return { kind: "varRef", localId: slot.id, type: value.type, loc };
}

/** Parses a test/describe options argument — an OBJECT LITERAL whose
 * skip/todo values are boolean literals or string messages and whose
 * only is the boolean literal, and concurrency, a boolean literal or a
 * number. Tests also take plan, a non-negative integer literal, and
 * timeout, a number. Everything else fences with the option name. */
function lowerTestOptions(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  suite: boolean,
): TestOptions {
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      `${what} with a non-literal options argument`,
      node,
      suite
        ? "pass the options as an object literal: { skip?, todo?, only?, concurrency? }"
        : "pass the options as an object literal: { skip?, todo?, only?, concurrency?, plan?, timeout? }",
    );
  }
  const out = noOptions();
  for (const prop of node.properties.nodes) {
    if (
      !(ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) &&
      !ts.isShorthandPropertyAssignment(prop)
    ) {
      lowerer.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a `name: value` or shorthand entry with a literal key",
      );
    }
    const key = prop.name as ts.Identifier;
    const name = key.text;
    // A shorthand entry's value is the binding of the same name.
    const init: ts.Expression = ts.isPropertyAssignment(prop) ? prop.initializer : key;
    if (name === "skip" || name === "todo") {
      const t = lowerer.typeOf(init);
      if (t.isStringLiteralType() || lowerer.mapTypeOf(t)?.kind === "string") {
        const msg = optionValue(
          lowerer,
          out,
          lowerer.lowerExprExpecting(init, STRING),
          locOf(init),
        );
        if (name === "skip") {
          out.skip = true;
          out.skipMsg = msg;
        } else {
          out.todo = true;
          out.todoMsg = msg;
        }
      } else if (
        init.kind === ts.SyntaxKind.TrueKeyword ||
        init.kind === ts.SyntaxKind.FalseKeyword
      ) {
        const on = init.kind === ts.SyntaxKind.TrueKeyword;
        if (name === "skip") {
          out.skip = on;
          out.skipMsg = null;
        } else {
          out.todo = on;
          out.todoMsg = null;
        }
      } else {
        lowerer.noLowering(
          `${what} with a non-literal ${name} value`,
          init,
          `${name} takes the literal true/false or a string message here`,
        );
      }
    } else if (name === "only") {
      if (init.kind === ts.SyntaxKind.TrueKeyword) out.only = true;
      else if (init.kind !== ts.SyntaxKind.FalseKeyword) {
        lowerer.noLowering(
          `${what} with a non-literal only value`,
          init,
          "only takes the literal true/false here",
        );
      }
    } else if (name === "plan" && !suite) {
      const value = ts.isNumericLiteral(init) ? Number(init.text) : NaN;
      if (!Number.isInteger(value) || value > 2147483647) {
        lowerer.noLowering(
          `${what} with a non-literal plan value`,
          init,
          "plan takes a non-negative integer literal here",
        );
      }
      out.plan = value;
    } else if (name === "concurrency") {
      const loc = locOf(init);
      if (init.kind === ts.SyntaxKind.TrueKeyword) out.concurrency = numLit(-1, loc);
      else if (init.kind === ts.SyntaxKind.FalseKeyword) out.concurrency = numLit(1, loc);
      else if (lowerer.mapTypeOf(lowerer.typeOf(init))?.kind === "f64") {
        out.concurrency = optionValue(lowerer, out, lowerer.lowerExprExpecting(init, F64), loc);
      } else {
        lowerer.noLowering(
          `${what} with a non-literal concurrency value`,
          init,
          "concurrency takes the literal true/false or a number here",
        );
      }
    } else if (name === "timeout" && !suite) {
      out.timeout = optionValue(lowerer, out, lowerer.lowerExprExpecting(init, F64), locOf(init));
    } else {
      lowerer.noLowering(
        `${what} option '${name}'`,
        prop,
        suite
          ? "skip, todo, only, and concurrency are the supported suite options"
          : "skip, todo, only, concurrency, plan, and timeout are the supported options",
      );
    }
  }
  return out;
}

/** The registration call, after the option values it reads. */
function withOptionValues(call: IrExpr, opts: TestOptions, loc: SrcLoc): IrExpr {
  if (opts.pre.length === 0) return call;
  return { kind: "seqExpr", stmts: opts.pre, result: call, type: call.type, loc };
}

/** Lowers a test/hook body, pinning the shape: 0 params or the one
 * TestContext param, returning void (sync) or Promise<void> (async —
 * the runner awaits through the emitted spawn wrapper). Returns the
 * closure and its runtime flags (1 async | 2 takes-ctx). */
function lowerBodyArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  allowCtx: boolean,
): { cb: IrExpr; flags: number } {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func") {
    lowerer.noLowering(`${what} whose body is not a function`, node, TEST_FN_HINT);
  }
  let flags = 0;
  if (cb.type.params.length > (allowCtx ? 1 : 0)) {
    lowerer.noLowering(
      `${what} with ${cb.type.params.length} parameters`,
      node,
      allowCtx ? TEST_FN_HINT : "hooks take no parameters",
    );
  }
  if (cb.type.params.length === 1) {
    if (cb.type.params[0]!.kind !== "testCtx") {
      lowerer.noLowering(`${what} whose parameter is not the TestContext`, node, TEST_FN_HINT);
    }
    flags |= 2;
  }
  const ret = cb.type.ret;
  if (ret.kind === "promise") {
    if (!(ret.inner.kind === "void" || isUnitType(ret.inner))) {
      lowerer.noLowering(
        `${what} returning Promise<${lowerer.fmt(ret.inner)}>`,
        node,
        TEST_FN_HINT,
      );
    }
    flags |= 1;
  } else if (ret.kind !== "void" && !isUnitType(ret)) {
    lowerer.noLowering(`${what} returning '${lowerer.fmt(ret)}'`, node, TEST_FN_HINT);
  }
  return { cb, flags };
}

/** The shared registration lowering behind test/it and their skip/todo/
 * only method twins — and, with `sub`, behind t.test. Argument shapes:
 * (name), (name, fn), (name, options, fn). */
/** The `name` a function value has in JavaScript, when the compiler can
 * tell: "" for an anonymous function expression, the declared or binding
 * name otherwise; null for other expressions. */
function staticFunctionName(lowerer: Lowerer, node: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isArrowFunction(node)) return "";
  if (ts.isFunctionExpression(node)) return node.name?.text ?? "";
  if (!ts.isIdentifier(node)) return null;
  const symbol = lowerer.resolveValueSymbol(node);
  if (!symbol) return null;
  for (const decl of symbol.declarations) {
    if (ts.isFunctionDeclaration(decl)) return decl.name?.text ?? "default";
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
      let init = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.name) return init.name.text;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return decl.name.text;
    }
  }
  return null;
}

/** Node's (name?, options?, fn?) argument forms (`Test#createSubtest`): a
 * leading function is the body, a leading object the options, otherwise
 * the first argument is the name and a following object the options. */
function splitTestArgs(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  what: string,
): { nameNode?: ts.Expression; optionsNode?: ts.Expression; fnNode?: ts.Expression } {
  const args = expr.arguments.nodes;
  const isFn = (a: ts.Expression): boolean =>
    lowerer.checker.getCallSignatures(lowerer.typeOf(a)).length > 0;
  const isOptions = (a: ts.Expression): boolean => ts.isObjectLiteralExpression(a);
  const unsupported = (): never =>
    lowerer.noLowering(
      `${what} with these arguments`,
      expr,
      "the supported forms are (name?, options?, fn?) with a string name, an options object literal, and a function",
    );
  if (args.length > 3 || args.some(ts.isSpreadElement)) unsupported();
  const out: { nameNode?: ts.Expression; optionsNode?: ts.Expression; fnNode?: ts.Expression } = {};
  let i = 0;
  const next = args[i];
  if (next !== undefined && !isFn(next) && !isOptions(next)) {
    out.nameNode = next;
    i++;
  }
  const options = args[i];
  if (options !== undefined && isOptions(options)) {
    out.optionsNode = options;
    i++;
  }
  const fn = args[i];
  if (fn !== undefined && isFn(fn)) {
    out.fnNode = fn;
    i++;
  }
  if (i < args.length) unsupported();
  return out;
}

/** The test's name, as Node's Test constructor completes it: a missing or
 * empty name takes the function's name, or "<anonymous>". */
function lowerTestName(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  what: string,
  nameNode: ts.Expression | undefined,
  fnNode: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  const fallback = (): string => {
    const fnName = fnNode ? staticFunctionName(lowerer, fnNode) : "";
    if (fnName === null) {
      lowerer.noLowering(
        `${what} without a name, with a function whose name is not known at compile time`,
        fnNode ?? expr,
        "give the test a name, or pass a function expression or a declared function",
      );
    }
    return fnName || "<anonymous>";
  };
  if (!nameNode) return strLit(fallback(), loc);
  const name = lowerer.lowerExprExpecting(nameNode, STRING);
  if (name.kind === "strLit") return name.value === "" ? strLit(fallback(), loc) : name;
  // A name computed at run time: when the function's own name is not known
  // at compile time (a function passed in as a parameter, say), the name
  // is used as given, and an empty one stays empty (the limitations page
  // notes it). Refusing here would refuse every helper that registers
  // tests for its callers.
  if (fnNode && staticFunctionName(lowerer, fnNode) === null) return name;
  const slot = lowerer.declareHiddenLocal("%testName", STRING);
  const value = varRef(slot.id, STRING, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: name, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "strEq", negated: false, left: value, right: strLit("", loc), type: BOOL, loc },
      then: strLit(fallback(), loc),
      else_: value,
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}

function lowerRegistration(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  what: string,
  loc: SrcLoc,
  methodMode: number, // 0 none, 1 skip, 2 todo, 3 only
  sub: IrExpr | null, // the lowered TestContext receiver (t.test)
): IrExpr {
  if (sub === null) requireStatementPosition(lowerer, expr, what);
  const { nameNode, optionsNode, fnNode } = splitTestArgs(lowerer, expr, what);
  let name = lowerTestName(lowerer, expr, what, nameNode, fnNode, loc);
  let opts = noOptions();
  if (optionsNode) {
    opts = lowerTestOptions(lowerer, optionsNode, what, false);
    // The name runs before the option values.
    if (opts.pre.length > 0 && name.kind !== "strLit") {
      const slot = lowerer.declareHiddenLocal("%testName", STRING);
      opts.pre.unshift({ kind: "varDecl", localId: slot.id, init: name, loc });
      name = { kind: "varRef", localId: slot.id, type: STRING, loc };
    }
  }
  if (methodMode === 3) opts.only = true;
  const at = strLit(atStringOf(expr), loc);
  const [mode, msg] = directiveOf(opts, methodMode, loc);
  const flagBits = optionFlags(opts);
  const planTimeout = [
    numLit(opts.plan, loc),
    opts.timeout ?? numLit(0, loc),
    opts.concurrency ?? numLit(0, loc),
  ];
  if (!fnNode) {
    const emptyFlags = numLit(flagBits, loc);
    return withOptionValues(
      sub
        ? {
            kind: "libCall",
            fn: "test.subEmpty",
            args: [sub, name, mode, msg, emptyFlags, at, ...planTimeout],
            type: VOID,
            loc,
          }
        : {
            kind: "libCall",
            fn: "test.registerEmpty",
            args: [name, mode, msg, emptyFlags, at, ...planTimeout],
            type: VOID,
            loc,
          },
      opts,
      loc,
    );
  }
  const { cb, flags } = lowerBodyArg(lowerer, fnNode, what, true);
  const flagsLit = numLit(flags | flagBits, loc);
  if (sub) {
    const promiseVoid: IrType = { kind: "promise", inner: VOID };
    return withOptionValues(
      {
        kind: "libCall",
        fn: "test.sub",
        args: [sub, name, mode, msg, cb, flagsLit, at, ...planTimeout],
        type: promiseVoid,
        loc,
      },
      opts,
      loc,
    );
  }
  return withOptionValues(
    {
      kind: "libCall",
      fn: "test.register",
      args: [name, mode, msg, cb, flagsLit, at, ...planTimeout],
      type: VOID,
      loc,
    },
    opts,
    loc,
  );
}

/** describe/suite (and describe.skip/todo/only): the body is a SYNC
 * zero-parameter closure that runs AT registration. */
function lowerSuite(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  what: string,
  loc: SrcLoc,
  methodMode: number,
): IrExpr {
  requireStatementPosition(lowerer, expr, what);
  const split = splitTestArgs(lowerer, expr, what);
  let name = lowerTestName(lowerer, expr, what, split.nameNode, split.fnNode, loc);
  let opts = noOptions();
  if (split.optionsNode) {
    opts = lowerTestOptions(lowerer, split.optionsNode, what, true);
    if (opts.pre.length > 0 && name.kind !== "strLit") {
      const slot = lowerer.declareHiddenLocal("%testName", STRING);
      opts.pre.unshift({ kind: "varDecl", localId: slot.id, init: name, loc });
      name = { kind: "varRef", localId: slot.id, type: STRING, loc };
    }
  }
  const fnNode = split.fnNode;
  if (!fnNode) {
    lowerer.noLowering(`${what} without a body`, expr, "give the suite a body function");
  }
  const cb = lowerer.lowerExpr(fnNode);
  // The body may take the SuiteContext (flag 2, as test bodies take theirs).
  if (
    cb.type.kind !== "func" ||
    cb.type.params.length > 1 ||
    (cb.type.params.length === 1 && cb.type.params[0]!.kind !== "testCtx")
  ) {
    lowerer.noLowering(
      `${what} whose body is not a function of the SuiteContext`,
      fnNode,
      "suite bodies take no parameters or the SuiteContext (they run at registration)",
    );
  }
  if (cb.type.ret.kind !== "void" && !isUnitType(cb.type.ret)) {
    lowerer.noLowering(
      `${what} with a non-void body`,
      fnNode,
      "suite bodies are synchronous and return nothing",
    );
  }
  const at = strLit(atStringOf(expr), loc);
  const [mode, msg] = directiveOf(opts, methodMode, loc);
  // describe.only and { only: true } mark the suite (flag 4, as for tests).
  const flags = numLit(
    optionFlags(opts) | (methodMode === 3 ? 4 : 0) | (cb.type.params.length === 1 ? 2 : 0),
    loc,
  );
  return withOptionValues(
    {
      kind: "libCall",
      fn: "test.suite",
      args: [name, mode, msg, cb, at, flags, opts.concurrency ?? numLit(0, loc)],
      type: VOID,
      loc,
    },
    opts,
    loc,
  );
}

/** before/after/beforeEach/afterEach — hooks on the enclosing suite
 * (top-level hooks attach to the implicit root). */
function lowerHook(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  which: number,
  what: string,
  loc: SrcLoc,
): IrExpr {
  requireStatementPosition(lowerer, expr, what);
  const args = expr.arguments.nodes;
  if (args.length !== 1) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      expr,
      "the supported form is one function (hook options have no lowering)",
    );
  }
  // A hook may take its context: the suite's for before/after, the test's
  // for beforeEach/afterEach.
  const { cb, flags } = lowerBodyArg(lowerer, args[0]!, what, true);
  return {
    kind: "libCall",
    fn: "test.hook",
    args: [numLit(which, loc), cb, numLit(flags, loc), strLit(atStringOf(expr), loc)],
    type: VOID,
    loc,
  };
}

const HOOK_WHICH: Record<string, number | undefined> = {
  before: 0,
  after: 1,
  beforeEach: 2,
  afterEach: 3,
};

/** Module-function calls on node:test import bindings (named imports AND
 * namespace/default-import members — both funnel here). Null for other
 * modules; every node:test member lands here — unlowered ones fence with
 * the module-qualified name. */
export function lowerNodeTestModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "test") return null;
  switch (bi.member) {
    case "test":
    case "it":
      return lowerRegistration(lowerer, expr, `${bi.member}(...)`, loc, 0, null);
    case "skip":
    case "todo":
    case "only":
      // The default-import method twins (`test.skip(...)` where `test`
      // is the module object).
      return lowerRegistration(
        lowerer,
        expr,
        `test.${bi.member}(...)`,
        loc,
        bi.member === "skip" ? 1 : bi.member === "todo" ? 2 : 3,
        null,
      );
    case "describe":
    case "suite":
      return lowerSuite(lowerer, expr, `${bi.member}(...)`, loc, 0);
    case "before":
    case "after":
    case "beforeEach":
    case "afterEach":
      return lowerHook(lowerer, expr, HOOK_WHICH[bi.member]!, `${bi.member}(...)`, loc);
    case "getTestContext":
      return lowerGetTestContext(lowerer, expr, loc);
    case "run":
      lowerer.noLowering(
        "test.run",
        expr,
        "the programmatic runner has no lowering — run tests by executing the compiled binary",
      );
      break;
    case "snapshot":
      lowerer.noLowering(
        "test.snapshot",
        expr,
        "t.assert.snapshot and t.assert.fileSnapshot are the supported snapshot surface",
      );
      break;
    default:
      lowerer.noLowering(
        `test.${bi.member}`,
        expr,
        "test/it, describe/suite, before/after/beforeEach/afterEach, getTestContext, and the skip/todo/only twins are the lowered node:test members",
        ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
      );
  }
  return null; // unreachable — noLowering throws
}

/** getTestContext(): the context of the test, suite or hook running in
 * the current async context, or undefined outside one (module top level,
 * and code reached only through timer, immediate, nextTick and
 * queueMicrotask callbacks). */
function lowerGetTestContext(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.nodes.length > 0) {
    lowerer.noLowering(
      `getTestContext with ${expr.arguments.nodes.length} arguments`,
      expr,
      "the supported form is getTestContext()",
    );
  }
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const missing = declared ? lowerer.wrappedUndefined(declared, loc) : null;
  if (!declared || !missing) {
    lowerer.noLowering(
      "getTestContext() of this type",
      expr,
      "getTestContext() lowers as TestContext | SuiteContext | undefined",
    );
  }
  return {
    kind: "ternary",
    cond: { kind: "libCall", fn: "test.hasContext", args: [], type: BOOL, loc },
    then: lowerer.coerceToExpected(
      { kind: "libCall", fn: "test.context", args: [], type: TESTCTX_T, loc },
      declared,
    ),
    else_: missing,
    type: declared,
    loc,
  };
}

/** The callable-module form: `test(...)` where the callee identifier IS
 * the node:test module binding — a default import (`import test from
 * "node:test"`) or the CJS `const test = require('node:test')` twin
 * (Node's module object is the test function itself). Null for other
 * callees. */
export function lowerTestDirectCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (lowerer.builtinNamespaceModuleOf(callee) !== "test") return null;
  const calleeSym = lowerer.checker.getSymbolAtLocation(callee);
  const decl = calleeSym ? calleeSym.declarations[0] : undefined;
  if (decl && ts.isNamespaceImport(decl)) {
    lowerer.unsupported(
      "SC1013",
      expr,
      "calling a module namespace object (Node throws TypeError there — " +
        'use the default import: import test from "node:test")',
    );
  }
  return lowerRegistration(lowerer, expr, "test(...)", loc, 0, null);
}

/** t.assert.snapshot(value[, options]) and t.assert.fileSnapshot(value,
 * path[, options]), Node's SnapshotManager assertions: the value runs
 * through options.serializers, by default Node's JSON.stringify(value,
 * null, 2), and String() of the result is compared with
 * assert.strictEqual against the snapshot that scr_test.c reads from
 * "<entry file>.snapshot" or `path`, or records in update mode. A throw
 * while serializing becomes Node's ERR_INVALID_STATE. */
function lowerSnapshotAssert(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "snapshot" | "fileSnapshot",
  testCtx: ts.Expression,
): IrExpr {
  const loc = locOf(call);
  const what = `t.assert.${member}`;
  const t = lowerer.lowerExpr(testCtx);
  const stmts: IrStmt[] = [];
  const slot = (name: string, type: IrType, init: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, type);
    stmts.push({ kind: "varDecl", localId: local.id, init, loc });
    return varRef(local.id, type, loc);
  };
  // Arguments evaluate in order before the assertion serializes, as in Node.
  const valueNode = call.arguments.nodes[0];
  const input = slot(
    "%snapshotInput",
    DYN,
    valueNode ? lowerer.lowerExprExpecting(valueNode, DYN) : dynUndefinedExpr(loc),
  );
  let path: IrExpr | null = null;
  if (member === "fileSnapshot") {
    const pathNode = call.arguments.nodes[1];
    path = slot(
      "%snapshotPath",
      STRING,
      pathNode ? lowerer.lowerExprExpecting(pathNode, STRING) : strLit("", loc),
    );
  }
  const serializers =
    snapshotSerializers(lowerer, call.arguments.nodes[member === "snapshot" ? 1 : 2], what)?.map(
      (fn) => slot("%snapshotSerializer", DYN, fn),
    ) ?? null;
  if (call.arguments.nodes.length > (member === "snapshot" ? 2 : 3)) {
    lowerer.noLowering(`${what} with ${call.arguments.nodes.length} arguments`, call);
  }
  const text: IrExpr = {
    kind: "toString",
    operand: {
      kind: "libCall",
      fn: "test.snapshotSerialize",
      args: [
        input,
        serializers === null
          ? dynUndefinedExpr(loc)
          : { kind: "dynArrLit", elems: serializers, type: DYN, loc },
      ],
      type: DYN,
      loc,
    },
    type: STRING,
    loc,
  };
  const actual = slot(
    "%snapshotActual",
    STRING,
    member === "snapshot"
      ? { kind: "libCall", fn: "test.snapshotValue", args: [text], type: STRING, loc }
      : text,
  );
  const expected: IrExpr =
    member === "snapshot"
      ? {
          kind: "libCall",
          fn: "test.ctxSnapshot",
          args: [t, actual, strLit(`${lowerer.entry.fileName}.snapshot`, loc)],
          type: STRING,
          loc,
        }
      : { kind: "libCall", fn: "test.fileSnapshot", args: [actual, path!], type: STRING, loc };
  const no: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "libCall",
      fn: "assert.eqStr",
      args: [actual, expected, no, no, strLit("", loc), no],
      type: VOID,
      loc,
    },
    type: VOID,
    loc,
  };
}

/** The serializer functions of a snapshot options object literal, as
 * checked-dynamic values in order; null without a serializers option.
 * Options that are not an object literal, a serializers list that is not
 * an array literal, and other options fence. */
function snapshotSerializers(
  lowerer: Lowerer,
  options: ts.Expression | undefined,
  what: string,
): IrExpr[] | null {
  if (options === undefined) return null;
  const hint = "pass the options as an object literal: { serializers: [(value) => ...] }";
  if (!ts.isObjectLiteralExpression(options)) {
    lowerer.noLowering(`${what} options that are not an object literal`, options, hint);
  }
  let fns: IrExpr[] | null = null;
  for (const prop of options.properties.nodes) {
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (
      name !== "serializers" ||
      !(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
    ) {
      lowerer.noLowering(`${what} options other than serializers`, prop, hint);
    }
    const list = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
    if (!ts.isArrayLiteralExpression(list)) {
      lowerer.noLowering(`${what} with a non-literal serializers list`, list, hint);
    }
    fns = list.elements.nodes.map((el) => {
      if (ts.isSpreadElement(el)) lowerer.noLowering(`${what} with a spread serializer`, el, hint);
      return lowerer.lowerExprExpecting(el, DYN);
    });
  }
  return fns;
}

/** `mock.timers` (tracker null) or `t.mock.timers` on a TestContext;
 * null for other expressions. */
function mockTimersReceiver(
  lowerer: Lowerer,
  expr: ts.Expression,
): { what: string; tracker: () => MockTracker } | null {
  if (
    !ts.isPropertyAccessExpression(expr) ||
    expr.questionDotToken ||
    expr.name.text !== "timers" ||
    !lowerer.isStdlibMember(expr)
  ) {
    return null;
  }
  const owner = expr.expression;
  if (ts.isIdentifier(owner)) {
    const bi = lowerer.builtinImportOf(owner);
    return bi && bi.module === "test" && bi.member === "mock"
      ? { what: "mock.timers", tracker: () => null }
      : null;
  }
  if (
    ts.isPropertyAccessExpression(owner) &&
    !owner.questionDotToken &&
    owner.name.text === "mock" &&
    lowerer.mapTypeOf(lowerer.typeOf(owner.expression))?.kind === "testCtx" &&
    lowerer.isStdlibMember(owner)
  ) {
    const testCtx = owner.expression;
    return { what: "t.mock.timers", tracker: () => lowerer.lowerExpr(testCtx) };
  }
  return null;
}

/** `mock.timers[Symbol.dispose]()` and its t.mock twin: an alias of
 * reset(), as in Node. Null for other element-access calls. */
export function lowerMockTimersElementCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.ElementAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const timers = mockTimersReceiver(lowerer, access.expression);
  if (!timers) return null;
  const key = access.argumentExpression;
  const isDispose =
    ts.isPropertyAccessExpression(key) &&
    key.name.text === "dispose" &&
    lowerer.stdlibGlobalMember(key, "Symbol") === "dispose";
  if (!isDispose) {
    lowerer.noLowering(
      `${timers.what} computed member calls`,
      call,
      "call timers[Symbol.dispose]()",
    );
  }
  return lowerMockTimersCall(lowerer, call, "reset", timers.what, timers.tracker, null);
}

/** Method-position node:test calls — one entry in lower-calls.ts's
 * intrinsic chain: skip/todo/only twins on NAMED import bindings
 * (`test.skip(...)` where `test` came from `{ test }`), the TestContext
 * surface (t.test/t.skip/t.todo/t.diagnostic), and t.assert.* (delegated
 * to the assert spoke). Null for other receivers. */
export function lowerTestMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || (access.questionDotToken && !lowerer.chainHandled.has(access)))
    return null;
  const loc = locOf(call);
  const member = access.name.text;
  // fn.mock.callCount() and the other mock context members.
  const mockContextCall = lowerMockContextCall(lowerer, call, access);
  if (mockContextCall) return mockContextCall;
  // test.skip / it.only / describe.todo on a NAMED import binding: the
  // receiver resolves to the module member the binding imported.
  if (ts.isIdentifier(access.expression)) {
    const bi = lowerer.builtinImportOf(access.expression);
    if (bi && bi.module === "test") {
      if (
        (bi.member === "test" || bi.member === "it") &&
        (member === "skip" || member === "todo" || member === "only")
      ) {
        return lowerRegistration(
          lowerer,
          call,
          `${bi.member}.${member}(...)`,
          loc,
          member === "skip" ? 1 : member === "todo" ? 2 : 3,
          null,
        );
      }
      if (
        (bi.member === "describe" || bi.member === "suite") &&
        (member === "skip" || member === "todo" || member === "only")
      ) {
        return lowerSuite(
          lowerer,
          call,
          `${bi.member}.${member}(...)`,
          loc,
          member === "skip" ? 1 : member === "todo" ? 2 : 3,
        );
      }
      if (bi.member === "mock") {
        const served = lowerMockTrackerMember(lowerer, call, member, "mock", () => null);
        if (served) return served;
        lowerer.noLowering(
          `test.mock.${member}`,
          call,
          MOCK_HINT,
          lowerer.checker.getSymbolAtLocation(access.name),
        );
      }
      lowerer.noLowering(
        `test.${bi.member}.${member}`,
        call,
        "skip, todo, and only are the supported method twins",
        lowerer.checker.getSymbolAtLocation(access.name),
      );
    }
  }
  // t.mock.fn(...) and the other tracker members: the test's mock tracker.
  if (
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "mock" &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression.expression))?.kind === "testCtx" &&
    lowerer.isStdlibMember(access.expression)
  ) {
    const testCtx = access.expression.expression;
    const served = lowerMockTrackerMember(lowerer, call, member, "t.mock", () =>
      lowerer.lowerExpr(testCtx),
    );
    if (served) return served;
  }
  // mock.timers.enable(...) and the other MockTimers members, on the
  // module's `mock` and on t.mock.
  const timers = mockTimersReceiver(lowerer, access.expression);
  if (timers) {
    const sym = lowerer.checker.getSymbolAtLocation(access.name) ?? null;
    return lowerMockTimersCall(lowerer, call, member, timers.what, timers.tracker, sym);
  }
  // t.assert.strictEqual(...) — the callee's receiver is `t.assert` on a
  // TestContext: Node's t.assert methods ARE the assert functions (bound
  // to the test for its counters — not modeled; the throw is identical),
  // so the assert spoke owns the call shape.
  if (
    ts.isPropertyAccessExpression(access.expression) &&
    !access.expression.questionDotToken &&
    access.expression.name.text === "assert" &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression.expression))?.kind === "testCtx" &&
    lowerer.isStdlibMember(access.expression)
  ) {
    const served =
      member === "snapshot" || member === "fileSnapshot"
        ? lowerSnapshotAssert(lowerer, call, member, access.expression.expression)
        : lowerer.lowerAssertModuleCall(call, { module: "assert", member }, loc);
    // Each t.assert call counts against the test's plan (t.plan).
    if (served)
      return {
        kind: "seqExpr",
        stmts: [
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "test.ctxCount",
              args: [lowerer.lowerExpr(access.expression.expression)],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        result: served,
        type: served.type,
        loc,
      };
    lowerer.noLowering(
      `t.assert.${member}`,
      call,
      "the assert-module surface is the supported t.assert surface",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  // The TestContext receiver surface.
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "testCtx") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const args = call.arguments.nodes;
  if (member === "test") {
    const receiver = lowerer.lowerExpr(access.expression);
    return lowerRegistration(lowerer, call, "t.test(...)", loc, 0, receiver);
  }
  if (member === "skip" || member === "todo") {
    requireStatementPosition(lowerer, call, `t.${member}(...)`);
    if (args.length > 1) {
      lowerer.noLowering(
        `t.${member} with ${args.length} arguments`,
        call,
        `the supported form is t.${member}([message])`,
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const msg = args[0] ? lowerer.lowerExprExpecting(args[0], STRING) : strLit("", loc);
    return {
      kind: "libCall",
      fn: member === "skip" ? "test.ctxSkip" : "test.ctxTodo",
      args: [receiver, msg],
      type: VOID,
      loc,
    };
  }
  const hook = HOOK_WHICH[member];
  if (hook !== undefined) {
    const what = `t.${member}(...)`;
    requireStatementPosition(lowerer, call, what);
    if (args.length !== 1) {
      lowerer.noLowering(
        `t.${member} with ${args.length} arguments`,
        call,
        "the supported form is one zero-parameter function (hook options have no lowering)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    // The hook may take the test's context.
    const { cb, flags } = lowerBodyArg(lowerer, args[0]!, what, true);
    return {
      kind: "libCall",
      fn: "test.ctxHook",
      args: [receiver, numLit(hook, loc), cb, numLit(flags, loc)],
      type: VOID,
      loc,
    };
  }
  if (member === "plan") {
    requireStatementPosition(lowerer, call, "t.plan(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `t.plan with ${args.length} arguments`,
        call,
        "the supported form is t.plan(count) (plan options have no lowering)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const count = lowerer.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: "test.ctxPlan", args: [receiver, count], type: VOID, loc };
  }
  if (member === "diagnostic") {
    requireStatementPosition(lowerer, call, "t.diagnostic(...)");
    if (args.length !== 1) {
      lowerer.noLowering(
        `t.diagnostic with ${args.length} arguments`,
        call,
        "the supported form is t.diagnostic(message)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const msg = lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "test.ctxDiagnostic", args: [receiver, msg], type: VOID, loc };
  }
  lowerer.noLowering(
    `TestContext.${member}`,
    call,
    TESTCTX_SURFACE_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** t.filePath (the entry file, as Node's entryFile), t.attempt (0: tests
 * run once), t.passed, t.workerId (Number(NODE_TEST_WORKER_ID) ||
 * undefined) and t.tags ([]: the tags option has no lowering), each
 * coerced to the member's declared type. */
function lowerTestCtxValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  member: "filePath" | "attempt" | "passed" | "workerId" | "tags",
): IrExpr {
  const loc = locOf(expr);
  const receiver = lowerer.lowerExpr(expr.expression);
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (!declared) {
    lowerer.noLowering(`TestContext.${member} of this type`, expr, TESTCTX_SURFACE_HINT);
  }
  const after = (value: IrExpr): IrExpr => ({
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: receiver, loc }],
    result: lowerer.coerceToExpected(value, declared),
    type: declared,
    loc,
  });
  switch (member) {
    case "filePath":
      return after(strLit(lowerer.entry.fileName, loc));
    case "attempt":
      return after(numLit(0, loc));
    case "tags":
      return after({ kind: "arrayLit", elems: [], type: declared, loc });
    case "passed":
      return lowerer.coerceToExpected(
        { kind: "libCall", fn: "test.ctxPassed", args: [receiver], type: BOOL, loc },
        declared,
      );
    case "workerId": {
      const id = lowerer.declareHiddenLocal("%workerId", F64);
      const missing = lowerer.wrappedUndefined(declared, loc);
      if (!missing)
        lowerer.noLowering("TestContext.workerId of this type", expr, TESTCTX_SURFACE_HINT);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "exprStmt", expr: receiver, loc },
          {
            kind: "varDecl",
            localId: id.id,
            init: { kind: "libCall", fn: "test.workerId", args: [], type: F64, loc },
            loc,
          },
        ],
        result: {
          kind: "ternary",
          cond: {
            kind: "bin",
            op: "!==",
            left: varRef(id.id, F64, loc),
            right: numLit(0, loc),
            type: BOOL,
            loc,
          },
          then: lowerer.coerceToExpected(varRef(id.id, F64, loc), declared),
          else_: missing,
          type: declared,
          loc,
        },
        type: declared,
        loc,
      };
    }
  }
}

/** `t.name` as a VALUE — one entry in lower-exprs' property chain. Null
 * for other receivers/members (the chain keeps trying); unlowered
 * TestContext members fence member-qualified. */
export function lowerTestCtxProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  // `getTestContext()?.name`: the optional-chain step re-enters here with
  // the receiver narrowed.
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const mockCalls = lowerMockContextProperty(lowerer, expr);
  if (mockCalls) return mockCalls;
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind !== "testCtx") return null;
  if (!lowerer.isStdlibMember(expr)) return null;
  const loc = locOf(expr);
  if (expr.name.text === "name" || expr.name.text === "fullName") {
    const receiver = lowerer.lowerExpr(expr.expression);
    return {
      kind: "libCall",
      fn: expr.name.text === "name" ? "test.ctxName" : "test.ctxFullName",
      args: [receiver],
      type: STRING,
      loc,
    };
  }
  const member = expr.name.text;
  if (
    member === "filePath" ||
    member === "attempt" ||
    member === "passed" ||
    member === "workerId" ||
    member === "tags"
  ) {
    return lowerTestCtxValue(lowerer, expr, member);
  }
  if (member === "assert") return null; // claimed by the call path
  lowerer.noLowering(
    `TestContext.${expr.name.text}`,
    expr,
    TESTCTX_SURFACE_HINT,
    lowerer.checker.getSymbolAtLocation(expr.name),
  );
}
