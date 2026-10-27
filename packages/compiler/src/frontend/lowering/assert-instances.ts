/* node:assert's Assert class (Node 24.22, lib/assert.js).
 *
 * `new Assert(options?)` merges `{ strict: true, skipPrototype: false }`
 * with the options. A strict instance has own equal, deepEqual, notEqual and
 * notDeepEqual properties that are the strict methods. The prototype methods
 * read the instance options: `diff` reaches every AssertionError the method
 * throws, and `skipPrototype` reaches deepStrictEqual and
 * notDeepStrictEqual.
 *
 * Static instances lower here: a `const` binding initialized by
 * `new Assert()` with literal options or none, whose every reference is a
 * method call on it. The declaration emits nothing, and each method call
 * lowers like the module function, with the options attached at compile
 * time. Other uses of the class are refused with SC2020. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrLibFn, IrStmt, SrcLoc } from "../../ir/ir.js";
import { transformExpr } from "../../ir/traverse.js";
import { stripTypeCasts } from "./builtins/arguments.js";
import type { Lowerer } from "./lowerer.js";

export interface AssertInstanceOptions {
  strict: boolean;
  diff: "simple" | "full";
  skipPrototype: boolean;
}

/** The methods on an Assert instance: Assert.prototype's, plus a strict
 * instance's own aliases, which share the names. */
const ASSERT_INSTANCE_METHODS: ReadonlySet<string> = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "doesNotReject",
  "doesNotThrow",
  "equal",
  "fail",
  "ifError",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "ok",
  "partialDeepStrictEqual",
  "rejects",
  "strictEqual",
  "throws",
]);

const STRICT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["equal", "strictEqual"],
  ["notEqual", "notStrictEqual"],
  ["deepEqual", "deepStrictEqual"],
  ["notDeepEqual", "notDeepStrictEqual"],
]);

/** Assertion calls whose runtime function can construct an AssertionError.
 * An instance call marks them with its options (`assertOptions`), which the
 * native emitter hands to the runtime right before the call. */
export const ASSERT_FAILURE_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "assert.ok",
  "assert.eqF64",
  "assert.eqBigInt",
  "assert.eqStr",
  "assert.eqBool",
  "assert.eqSym",
  "assert.eqDyn",
  "assert.expectsErrDyn",
  "assert.looseDeepDyn",
  "assert.partialDeepDyn",
  "assert.looseResult",
  "assert.deepResult",
  "assert.looseDeepResult",
  "assert.partialDeepResult",
  "assert.match",
  "assert.throwsNone",
  "assert.throwsMismatch",
  "assert.throwsRegex",
  "assert.shapeEnd",
  "assert.unwantedRejection",
  "assert.unwantedError",
  "assert.ifErrorErr",
  "assert.ifErrorF64",
  "assert.ifErrorStr",
  "assert.ifErrorBool",
  "assert.ifErrorDyn",
  "assert.refEqFn",
  "assert.refEqBytes",
  "assert.bytesDeepEq",
] as IrLibFn[]);

/** Whether `expr` is `new Assert(...)` for node:assert's Assert class, by
 * import provenance: `import { Assert } from "node:assert"`, or
 * `assert.Assert` through a module binding. */
export function isAssertClassNew(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (!ts.isNewExpression(expr)) return false;
  const callee = stripTypeCasts(expr.expression);
  const builtin = ts.isIdentifier(callee)
    ? lowerer.builtinImportOf(callee)
    : ts.isPropertyAccessExpression(callee)
      ? lowerer.builtinMemberOf(callee)
      : null;
  return (
    builtin !== null &&
    (builtin.module === "assert" || builtin.module === "assert/strict") &&
    builtin.member === "Assert"
  );
}

/** The options of `new Assert(<literal options>)`, or null when an option is
 * not a literal or the argument list has another shape. */
export function literalAssertOptions(expr: ts.NewExpression): AssertInstanceOptions | null {
  const args = expr.arguments?.nodes ?? [];
  const options: AssertInstanceOptions = { strict: true, diff: "simple", skipPrototype: false };
  if (args.length === 0) return options;
  if (args.length > 1) return null;
  const arg = stripTypeCasts(args[0]!);
  if (ts.isIdentifier(arg) && arg.text === "undefined") return options;
  if (!ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    const value = stripTypeCasts(prop.initializer);
    const flag =
      value.kind === ts.SyntaxKind.TrueKeyword
        ? true
        : value.kind === ts.SyntaxKind.FalseKeyword
          ? false
          : null;
    if (name === "strict" && flag !== null) options.strict = flag;
    else if (name === "skipPrototype" && flag !== null) options.skipPrototype = flag;
    else if (
      name === "diff" &&
      ts.isStringLiteral(value) &&
      (value.text === "simple" || value.text === "full")
    )
      options.diff = value.text;
    else return null;
  }
  return options;
}

/** The static instance a `const` declaration binds, or null. Every
 * reference to the binding must be a method call on it, so the instance is
 * never needed as a value. Cached on the lowerer per declaration. */
export function staticAssertInstanceDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): AssertInstanceOptions | null {
  if (!ts.isIdentifier(nameNode) || init === undefined) return null;
  const decl = nameNode.parent;
  if (!ts.isVariableDeclaration(decl) || decl.name !== nameNode) return null;
  const cached = lowerer.assertInstances.get(decl);
  if (cached !== undefined) return cached;
  let result: AssertInstanceOptions | null = null;
  const value = stripTypeCasts(init);
  if (
    ts.isNewExpression(value) &&
    isAssertClassNew(lowerer, value) &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    const options = literalAssertOptions(value);
    if (options !== null && onlyMethodCallReferences(lowerer, nameNode)) result = options;
  }
  lowerer.assertInstances.set(decl, result);
  return result;
}

/** The static instance an expression names, or null. */
export function assertInstanceOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): AssertInstanceOptions | null {
  if (!ts.isIdentifier(expr)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return null;
  return staticAssertInstanceDecl(lowerer, decl.name, decl.initializer);
}

function onlyMethodCallReferences(lowerer: Lowerer, name: ts.Identifier): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(name);
  if (symbol === undefined) return false;
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (ts.isIdentifier(node) && node !== name && node.text === name.text) {
      if (lowerer.checker.getSymbolAtLocation(node) === symbol && !isMethodCallReceiver(node))
        ok = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.getSourceFileOfNode(name));
  return ok;
}

function isMethodCallReceiver(node: ts.Identifier): boolean {
  const access = node.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== node ||
    access.questionDotToken !== undefined ||
    !ASSERT_INSTANCE_METHODS.has(access.name.text)
  )
    return false;
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access;
}

/** The methods whose AssertionError carries the instance's `diff`: Node
 * 24.22 passes `this?.[kOptions]?.diff` from these. ok, match,
 * doesNotMatch and the throws, rejects, doesNotThrow and doesNotReject
 * expectations construct their errors without it (`diff` is "simple"). */
const DIFF_METHODS: ReadonlySet<string> = new Set([
  "fail",
  "equal",
  "notEqual",
  "deepEqual",
  "notDeepEqual",
  "strictEqual",
  "notStrictEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "partialDeepStrictEqual",
  "ifError",
]);

/** `instance.method(...)` on a static instance: the module function's
 * lowering, with the strict aliases and the instance options that reach
 * the method. Null when the receiver is not a static instance. */
export function lowerAssertInstanceCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  const options = assertInstanceOf(lowerer, access.expression);
  if (options === null) return null;
  const module = options.strict ? "assert/strict" : "assert";
  const member = access.name.text;
  // A strict instance's own aliases are the strict methods.
  const method =
    options.strict && STRICT_ALIASES.has(member) ? STRICT_ALIASES.get(member)! : member;
  // Node passes skipPrototype to isDeepStrictEqual from deepStrictEqual and
  // notDeepStrictEqual only.
  const applied: AssertInstanceOptions = {
    strict: options.strict,
    diff: DIFF_METHODS.has(method) ? options.diff : "simple",
    skipPrototype:
      options.skipPrototype && (method === "deepStrictEqual" || method === "notDeepStrictEqual"),
  };
  const previous = lowerer.assertCallOptions;
  lowerer.assertCallOptions = applied;
  try {
    const lowered = lowerer.lowerAssertModuleCall(expr, { module, member }, loc);
    if (lowered === null) return null;
    return markAssertOptionsExpr(lowered, applied);
  } finally {
    lowerer.assertCallOptions = previous;
  }
}

/** The runtime options an instance attaches to its failure calls, or null
 * for the defaults. */
export function assertOptionsMark(
  options: AssertInstanceOptions | null,
): { diff?: "full"; skipPrototype?: true } | null {
  if (options === null) return null;
  const mark: { diff?: "full"; skipPrototype?: true } = {};
  if (options.diff === "full") mark.diff = "full";
  if (options.skipPrototype) mark.skipPrototype = true;
  return mark.diff === undefined && mark.skipPrototype === undefined ? null : mark;
}

const markLibCall = (mark: { diff?: "full"; skipPrototype?: true }) => ({
  expr(node: IrExpr): IrExpr {
    if (node.kind === "libCall" && ASSERT_FAILURE_LIB_FNS.has(node.fn))
      return { ...node, assertOptions: mark };
    return node;
  },
  stmt: (node: IrStmt): IrStmt => node,
});

/** Attaches the instance options to every assertion failure call in a
 * lowered call site. */
export function markAssertOptionsExpr(expr: IrExpr, options: AssertInstanceOptions): IrExpr {
  const mark = assertOptionsMark(options);
  return mark === null ? expr : transformExpr(expr, markLibCall(mark));
}
