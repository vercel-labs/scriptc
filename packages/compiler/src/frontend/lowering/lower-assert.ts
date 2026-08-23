import { InternalCompilerError } from "../../errors.js";
/* The node:assert lowering (a spoke module like lower-dgram.ts): the
 * callable module form (`assert(x)` through a default import or a CJS
 * require binding), ok, the strict/deep equality quartet, fail, throws,
 * and match/doesNotMatch — for BOTH the "assert" and "assert/strict"
 * modules ("assert/strict" additionally binds the loose NAMES to the
 * strict comparisons: equal IS strictEqual, exactly Node's aliasing).
 *
 * Failures throw Node's AssertionError (a runtime %Error whose name is
 * "AssertionError" and whose code slot is "ERR_ASSERTION"), so the
 * catch-side reads (`instanceof Error`, `.name`, `.message`, `.code`)
 * answer exactly like Node's. Generated messages are Node-exact for the
 * scalar comparisons (the runtime reproduces assertion_error.js's scalar
 * forms; scr_assert.c's design note lists the divergences); assert.ok's
 * source-text message bakes at compile time — the frontend HAS the source
 * where Node re-reads the file at runtime.
 *
 * Deep equality is honest, never approximate: deepStrictEqual over
 * composite values synthesizes a per-type structural comparison (Node's
 * strict rules — Object.is for numbers, per-element arrays, per-field
 * records, SameValueZero-keyed Maps/Sets with deep values), and any type
 * it cannot compare faithfully (class instances, typed arrays, index-
 * signature records, dyn/unknown) fences at the call site instead of
 * miscomparing. */
import * as ts from "../ts7/adapter.js";
import { resultIsDiscarded } from "./call-position.js";
import type { Lowerer } from "./lowerer.js";
import { jsFuncNameOf, own } from "./lowerer.js";
import { NARROW_FIRST } from "./surfaces.js";
import { typeReachesItself } from "./lower-inspect.js";
import { BOOL, CAUGHT, DYN, DYN_HANDLE_KINDS, F64, IrExpr, IrLibFn, IrStmt, IrType, REGEX, RUNTIME_ERROR_CLASSES, STRING, SrcLoc, VOID, isUnitType, typeEquals, typeKey } from "../../ir/nodes.js";
import { boolLit, countedFor, numLit, strLit, varRef } from "../../ir/build.js";

/** node:assert/strict binds the loose NAMES to the strict comparisons —
 * Node's own aliasing (`strict.equal === assert.strictEqual`). */
const STRICT_ALIASES: Record<string, string | undefined> = {
  equal: "strictEqual",
  notEqual: "notStrictEqual",
  deepEqual: "deepStrictEqual",
  notDeepEqual: "notDeepStrictEqual",
};

/** The canonical member the two modules share ("assert/strict".equal →
 * strictEqual); "assert" members pass through unchanged. */
function canonicalAssertMember(module: string, member: string): string {
  if (module === "assert/strict") return own(STRICT_ALIASES, member) ?? member;
  return member;
}

/** VOID/never results are usable as statements and concise arrow bodies
 * only (the lower-dgram stance): nothing downstream can consume them. */
function requireStatementPosition(L: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  L.noLowering(
    `using the result of ${what}`,
    call,
    "the result is void — call it as its own statement",
  );
}

/** The optional trailing message argument: Node accepts a string or an
 * Error (throwing the Error itself) — the STRING form lowers; a literal
 * `undefined` counts as omitted (Node's `message == null` test). Returns
 * the libCall's (msg, hasMsg) pair — a "" dummy when omitted, so the
 * runtime can distinguish an omitted message from an empty one. */
function lowerMessageArg(
  L: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): { msg: IrExpr; hasMsg: IrExpr } {
  if (!node || (ts.isIdentifier(node) && node.text === "undefined")) {
    return { msg: { kind: "strLit", value: "", type: STRING, loc }, hasMsg: boolLit(false, loc) };
  }
  const msg = L.lowerExpr(node);
  if (msg.type.kind !== "string") {
    L.noLowering(
      `assert messages of type '${L.fmt(msg.type)}'`,
      node,
      "only string messages lower (Node also accepts an Error to throw — construct and throw it directly)",
    );
  }
  return { msg, hasMsg: boolLit(true, loc) };
}

/** The module-function dispatch — the spoke's entry, called from both the
 * named-import and namespace/default-import call paths. Null for other
 * modules and for members with no lowering (the module tables' fence
 * takes over, module-qualified with the surfaces.ts hints). */
export function lowerAssertModuleCall(
  L: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "assert" && bi.module !== "assert/strict") return null;
  switch (canonicalAssertMember(bi.module, bi.member)) {
    case "ok":
      return lowerAssertOk(L, expr, loc);
    case "strictEqual":
      return lowerAssertEqual(L, expr, loc, false, false);
    case "notStrictEqual":
      return lowerAssertEqual(L, expr, loc, true, false);
    case "deepStrictEqual":
      return lowerAssertEqual(L, expr, loc, false, true);
    case "notDeepStrictEqual":
      return lowerAssertEqual(L, expr, loc, true, true);
    case "fail":
      return lowerAssertFail(L, expr, loc);
    case "match":
      return lowerAssertMatch(L, expr, loc, false);
    case "doesNotMatch":
      return lowerAssertMatch(L, expr, loc, true);
    case "throws":
      return lowerAssertThrows(L, expr, loc);
    case "rejects":
      return lowerAssertRejects(L, expr, loc, false);
    case "doesNotReject":
      return lowerAssertRejects(L, expr, loc, true);
    case "ifError":
      return lowerAssertIfError(L, expr, loc);
    default:
      return null;
  }
}

/** The callable-module form: `assert(x)` where the callee identifier IS
 * the assert module binding — a default import (`import assert from
 * "node:assert"`) or the CJS `const assert = require("assert")`. Node's
 * module object is assert.ok itself. A NAMESPACE import binding is not
 * callable in Node (ES namespace objects throw TypeError), so that form
 * fences instead of compiling a crash. Null for non-assert callees. */
export function lowerAssertDirectCall(
  L: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return null;
  const module = L.builtinNamespaceModuleOf(callee);
  if (module !== "assert" && module !== "assert/strict") return null;
  const calleeSym = L.checker.getSymbolAtLocation(callee);
  const decl = calleeSym ? L.checker.declarationsOf(calleeSym)[0] : undefined;
  if (decl && ts.isNamespaceImport(decl)) {
    L.unsupported(
      "SC1013",
      expr,
      "calling a module namespace object (Node throws TypeError there — " +
        'use the default import: import assert from "node:assert")',
    );
  }
  return lowerAssertOk(L, expr, loc);
}

/** assert(value[, message]) / assert.ok(value[, message]): the truthiness
 * test over any condition-testable type; the generated message carries the
 * call's SOURCE TEXT (Node re-reads the file at runtime — the frontend has
 * the same bytes at compile time). */
function lowerAssertOk(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  requireStatementPosition(L, expr, expr.expression.getText());
  if (expr.arguments.length < 1 || expr.arguments.length > 2) {
    L.noLowering(
      `${expr.expression.getText()} with ${expr.arguments.length} arguments`,
      expr,
      "the supported forms are assert(value) and assert(value, message)",
    );
  }
  const valueNode = expr.arguments[0]!;
  const pass = L.ensureBool(L.lowerExpr(valueNode), valueNode);
  const msgNode = expr.arguments[1];
  if (!msgNode || (ts.isIdentifier(msgNode) && msgNode.text === "undefined")) {
    // Node reads the CALLSITE LINE and slices the expression out of it
    // (internal/errors/error_source.js) — a call spanning lines truncates
    // at the first newline, so the compile-time text does too.
    const source = expr.getText().split("\n", 1)[0]!;
    const generated = `The expression evaluated to a falsy value:\n\n  ${source}\n`;
    const msg: IrExpr = { kind: "strLit", value: generated, type: STRING, loc };
    return { kind: "libCall", fn: "assert.ok", args: [pass, msg], type: VOID, loc };
  }
  const { msg } = lowerMessageArg(L, msgNode, loc);
  return { kind: "libCall", fn: "assert.ok", args: [pass, msg], type: VOID, loc };
}

/** assert.fail([message]): an unconditional AssertionError — "Failed"
 * when the message is omitted (Node's internal default). Lowers as
 * assert.ok over a false literal. */
function lowerAssertFail(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  requireStatementPosition(L, expr, "assert.fail");
  if (expr.arguments.length > 1) {
    L.noLowering(
      `assert.fail with ${expr.arguments.length} arguments`,
      expr,
      "the supported form is fail(message?) — the deprecated fail(actual, expected, ...) has no lowering",
    );
  }
  let msg: IrExpr;
  const msgNode = expr.arguments[0];
  if (!msgNode || (ts.isIdentifier(msgNode) && msgNode.text === "undefined")) {
    msg = { kind: "strLit", value: "Failed", type: STRING, loc };
  } else {
    msg = lowerMessageArg(L, msgNode, loc).msg;
  }
  const falseLit: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  return { kind: "libCall", fn: "assert.ok", args: [falseLit, msg], type: VOID, loc };
}

/** The equality quartet. Scalars (number/string/boolean) compare with
 * Object.is in the runtime (strictEqual and deepStrictEqual agree there —
 * Node's own rule) and generate Node's exact messages; composite
 * deepStrictEqual synthesizes the per-type structural comparison. Objects
 * under strictEqual (reference equality), mixed static types, and unions
 * fence — honestly, never a miscompare. */
function lowerAssertEqual(
  L: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  negated: boolean,
  deep: boolean,
): IrExpr {
  const surface = `assert.${deep ? (negated ? "notDeepStrictEqual" : "deepStrictEqual") : negated ? "notStrictEqual" : "strictEqual"}`;
  requireStatementPosition(L, expr, surface);
  if (expr.arguments.length < 2 || expr.arguments.length > 3) {
    L.noLowering(`${surface} with ${expr.arguments.length} arguments`, expr);
  }
  // A context-free EMPTY array literal on either side has no element type
  // of its own (`deepStrictEqual(ee.listeners('x'), [])` — the checker
  // says any[]): it adopts the OTHER side's array type. Literals have no
  // side effects, so lowering order is unobservable.
  const aNode = expr.arguments[0]!;
  const bNode = expr.arguments[1]!;
  const emptyArrayLit = (n: ts.Expression): boolean =>
    ts.isArrayLiteralExpression(n) && n.elements.length === 0;
  const emptyOf = (t: IrType): IrExpr => ({ kind: "arrayLit", elems: [], type: t, loc });
  // A dyn other side adopts number[] — the dyn array a boxed empty
  // literal builds is elementless, so any elem type serves.
  const adoptedEmpty = (other: IrType): IrExpr | null =>
    other.kind === "array" ? emptyOf(other) : other.kind === "dyn" ? emptyOf({ kind: "array", elem: F64 }) : null;
  let a: IrExpr;
  let b: IrExpr;
  if (emptyArrayLit(aNode) && !emptyArrayLit(bNode)) {
    b = L.lowerExpr(bNode);
    a = adoptedEmpty(b.type) ?? L.lowerExpr(aNode);
  } else {
    a = L.lowerExpr(aNode);
    b = emptyArrayLit(bNode) ? (adoptedEmpty(a.type) ?? L.lowerExpr(bNode)) : L.lowerExpr(bNode);
  }
  const { msg, hasMsg } = lowerMessageArg(L, expr.arguments[2], loc);

  // CHECKED-DYNAMIC operands (dyn-vs-dyn, dyn-vs-static): both sides
  // cross into the checked-dynamic tree and one runtime entry answers the whole quartet —
  // SameValue for the strict pair (boxed-closure identity for
  // functions), the structural dyn walk for the deep pair, with
  // assertion_error.js's generated messages (scalar forms byte-exact;
  // composites render compact:false/sorted through the checked-dynamic tree). The static
  // side boxes only when the conversion is HONEST for the operator:
  // scalars and unit literals always; boxable functions (the closure
  // crosses by identity); JSON-safe composites under the deep pair only.
  // Under strictEqual a composite fences instead: crossing the unknown
  // boundary COPIES, so a strict compare against a static composite
  // would answer false where Node can answer true (the value's own
  // earlier crossing) — a miscompare, never lowered. Bytes fence both
  // ways (the dyn copy cannot carry the Buffer/Uint8Array brand the
  // checker type knows); class instances and everything non-convertible
  // keep the fence too.
  if (a.type.kind === "dyn" || b.type.kind === "dyn") {
    const box = (e: IrExpr, node: ts.Expression): IrExpr => {
      if (e.type.kind === "dyn") return e;
      const k = e.type.kind;
      const ok =
        e.kind === "unitLit" ||
        k === "f64" ||
        k === "string" ||
        k === "bool" ||
        (k === "func" && L.dynConvertible(e.type)) ||
        // Runtime handles cross by REFERENCE (identity preserved), so the
        // strict compare is honest: assert.strictEqual(this, server) —
        // the ambient-receiver suite shape. The runtime's deep arm
        // answers same-handle only (its documented stance).
        DYN_HANDLE_KINDS.has(k) ||
        // %Error crosses as the checked-dynamic tree's error encoding ({%error, name,
        // message, code?}) through scr_dyn_from_error's IDENTITY CACHE —
        // one error instance is ONE dyn node however it crosses. Strict
        // compares are therefore honest reference equality (a trace
        // context's stamped .error, a caught dyn, and the static error's
        // own boxing are the same node exactly when Node's objects are the
        // same), and the deep walk compares the encoding's name/message/
        // code — Node's deepStrictEqual over Errors. Island round trips
        // re-encode and lose the identity (SEMANTICS.md).
        (k === "object" && e.type.kind === "object" && e.type.className === "%Error") ||
        (deep && k !== "bytes" && k !== "object" && L.dynConvertible(e.type));
      if (!ok) {
        const hint =
          !deep && (k === "record" || k === "array" || k === "map" || k === "set" || k === "union")
            ? "strictEqual on objects is reference equality, which does not survive the unknown boundary (values copy when they cross) — deepStrictEqual compares structure, or narrow the unknown side first"
            : k === "bytes"
              ? "the unknown boundary cannot carry the Buffer-vs-Uint8Array brand Node compares — narrow the unknown side to a typed array and compare those"
              : "the static side must convert into the checked-dynamic tree (numbers, strings, booleans, null/undefined, boxable functions, or JSON-safe structures under the deep forms) — narrow the unknown side instead";
        L.noLowering(`${surface} of 'unknown' and '${L.fmt(e.type)}' values`, node, hint);
      }
      // A boxed closure takes its best-effort JS name from the source
      // node (the coerceInto convention) — the failure message renders
      // [Function: name] like Node.
      const fnName = k === "func" ? jsFuncNameOf(node) : null;
      return { kind: "dynFrom", value: e, ...(fnName !== null ? { fnName } : {}), type: DYN, loc: e.loc };
    };
    return {
      kind: "libCall",
      fn: "assert.eqDyn",
      args: [box(a, aNode), box(b, bNode), boolLit(negated, loc), boolLit(deep, loc), msg, hasMsg],
      type: VOID,
      loc,
    };
  }
  const scalarFn =
    a.type.kind === b.type.kind
      ? a.type.kind === "f64"
        ? ("assert.eqF64" as const)
        : a.type.kind === "string"
          ? ("assert.eqStr" as const)
          : a.type.kind === "bool"
            ? ("assert.eqBool" as const)
            : a.type.kind === "symbol"
              ? // Symbols are primitives under SameValue: strictEqual IS
                // deepStrictEqual (pointer identity), with v24's
                // "Symbol(desc)" stacked-diff messages.
                ("assert.eqSym" as const)
              : null
      : null;
  if (scalarFn) {
    return {
      kind: "libCall",
      fn: scalarFn,
      args: [a, b, boolLit(negated, loc), boolLit(deep, loc), msg, hasMsg],
      type: VOID,
      loc,
    };
  }
  // Typed arrays / Buffers, both sides one static bytes type. strictEqual
  // is reference identity (Object.is on objects — the runtime value IS its
  // pointer); deepStrictEqual is brand + content: Node compares prototypes
  // first (Buffer.from([1]) is never deep-equal to new Uint8Array([1])),
  // and the brand lives in each argument's own checker type (the
  // lower-inspect precedent: the runtime representation is one ScrBytes
  // either way). A checker brand this code cannot classify fences — never
  // a miscompare. The one accepted approximation: a bytes value reaching
  // the call through a binding whose DECLARED constructor differs from the
  // value's runtime one compares by the declared brand (SEMANTICS.md).
  if (a.type.kind === "bytes" && typeEquals(a.type, b.type)) {
    const brandA = bytesBrandOf(L, expr.arguments[0]!);
    const brandB = bytesBrandOf(L, expr.arguments[1]!);
    if (!deep) {
      // Brands shape only the failure HEADER (same-structure vs
      // reference-equal expectation); an unclassifiable side defers to the
      // content probe.
      const brandsEq = boolLit(brandA === null || brandB === null || brandA === brandB, loc);
      return {
        kind: "libCall",
        fn: "assert.refEqBytes",
        args: [a, b, boolLit(negated, loc), brandsEq, msg, hasMsg],
        type: VOID,
        loc,
      };
    }
    if (brandA === null || brandB === null) {
      L.noLowering(
        `${surface} of typed-array values whose constructor is not in the static type`,
        brandA === null ? expr.arguments[0]! : expr.arguments[1]!,
        "Node's deep equality compares prototypes (a Buffer is never deep-equal to a plain Uint8Array) — annotate the value so its constructor is visible",
      );
    }
    const verdict: IrExpr = {
      kind: "libCall",
      fn: "assert.bytesDeepEq",
      args: [a, b, boolLit(brandA === brandB, loc)],
      type: BOOL,
      loc,
    };
    return {
      kind: "libCall",
      fn: "assert.deepResult",
      args: [verdict, boolLit(negated, loc), msg, hasMsg],
      type: VOID,
      loc,
    };
  }
  // Function values (ANY two static signatures — a tuple-typed
  // listeners() element against a prefix-declared handler): strictEqual
  // is reference identity (functions are objects to Object.is), Node's
  // object-comparison headers. The deep forms fall through to the generic
  // deep path below — deep equality over functions IS reference identity
  // (same-typed there; the per-type helper carries it).
  if (!deep && a.type.kind === "func" && b.type.kind === "func") {
    return {
      kind: "libCall",
      fn: "assert.refEqFn",
      args: [a, b, boolLit(negated, loc), msg, hasMsg],
      type: VOID,
      loc,
    };
  }
  if (!deep) {
    const hint =
      a.type.kind === "union" || b.type.kind === "union"
        ? `union-typed comparisons need one arm (${NARROW_FIRST})`
        : a.type.kind !== b.type.kind
          ? "both sides must share one static scalar type (number, string, or boolean)"
          : "strictEqual on objects is reference equality — deepStrictEqual compares structure";
    L.noLowering(`${surface} of '${L.fmt(a.type)}' and '${L.fmt(b.type)}' values`, expr, hint);
  }
  // Deep equality: identical static types, structurally comparable.
  if (!typeEquals(a.type, b.type)) {
    L.noLowering(
      `${surface} of '${L.fmt(a.type)}' and '${L.fmt(b.type)}' values`,
      expr,
      "deep equality lowers when both sides have the SAME static type — annotate or narrow one side",
    );
  }
  if (isUnitType(a.type)) {
    // undefined vs undefined / null vs null: trivially deep-equal.
    return {
      kind: "libCall",
      fn: "assert.deepResult",
      args: [boolLit(true, loc), boolLit(negated, loc), msg, hasMsg],
      type: VOID,
      loc,
    };
  }
  const unsupported = deepUnsupportedReason(L, a.type, new Set());
  if (unsupported !== null) {
    L.noLowering(`${surface} of '${L.fmt(a.type)}' values`, expr, unsupported);
  }
  const helper = deepEqHelper(L, a.type, loc);
  const verdict: IrExpr = { kind: "call", callee: helper, args: [a, b], type: BOOL, loc };
  return {
    kind: "libCall",
    fn: "assert.deepResult",
    args: [verdict, boolLit(negated, loc), msg, hasMsg],
    type: VOID,
    loc,
  };
}

/** assert.match / assert.doesNotMatch: the regex test with Node's
 * generated message (regex source + getter-ordered flags, the inspected
 * input). */
function lowerAssertMatch(
  L: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  negated: boolean,
): IrExpr {
  const surface = negated ? "assert.doesNotMatch" : "assert.match";
  requireStatementPosition(L, expr, surface);
  if (expr.arguments.length < 2 || expr.arguments.length > 3) {
    L.noLowering(`${surface} with ${expr.arguments.length} arguments`, expr);
  }
  const s = L.lowerExprExpecting(expr.arguments[0]!, STRING);
  const re = L.lowerExpr(expr.arguments[1]!);
  if (re.type.kind !== "regex") {
    L.noLowering(
      `${surface} with a non-regex pattern`,
      expr.arguments[1]!,
      "the second argument must be a regular expression",
    );
  }
  const { msg, hasMsg } = lowerMessageArg(L, expr.arguments[2], loc);
  const neg: IrExpr = { kind: "boolLit", value: negated, type: BOOL, loc };
  return { kind: "libCall", fn: "assert.match", args: [s, re, neg, msg, hasMsg], type: VOID, loc };
}

/* ── assert.throws / assert.rejects / assert.doesNotReject ─────────────── */

/** One key of an expected-error OBJECT shape (Node's expectedException
 * over the static error surface): ids follow scr_assert.c's slot order
 * (0 code, 1 message, 2 name); the value is the lowered string or regex
 * expression, kept in the literal's own property order so argument
 * evaluation stays source-ordered. enameBake is the compile-time
 * "/source/flags" rendering of a regex-LITERAL name value — the
 * missing-exception ` (${expected.name})` detail needs the name's
 * rendering, not a match. */
interface ThrowsShapeKey {
  id: number;
  kind: "str" | "re";
  value: IrExpr;
  enameBake: string | null;
}

/** The classified expected argument of throws/rejects/doesNotReject.
 * "message" is Node's string form (the value IS the assertion message);
 * the rest select a synthesized catch body in the interned helper. */
type ThrowsExpected =
  | { form: "bare" }
  | { form: "message"; msg: IrExpr; hasMsg: IrExpr }
  | { form: "class"; className: string; displayName: string }
  | { form: "regex"; value: IrExpr }
  | { form: "shape"; keys: ThrowsShapeKey[] }
  // An error-INSTANCE expected (Node compares name, message, and the
  // expected's own enumerable keys with isDeepStrictEqual): the value
  // crosses as a dyn error and the runtime runs the per-key walk
  // (assert.expectsErrDyn). Carried as DYN — a checked-dynamic value
  // passes through, a static %Error boxes (the identity-cached crossing).
  | { form: "errValue"; value: IrExpr };

const SHAPE_KEY_IDS: Record<string, number | undefined> = { code: 0, message: 1, name: 2 };

/** inspect renders regex flags in GETTER order (dgimsuvy), not source
 * order — the same reordering scr_regex.c applies at runtime. */
function regexFlagsGetterOrder(flags: string): string {
  return [..."dgimsuvy"].filter((f) => flags.includes(f)).join("");
}

/** Is `className` the runtime %Error root or a class inside its
 * hierarchy (builtin kinds and user subclasses alike)? */
function inErrorHierarchy(L: Lowerer, className: string): boolean {
  if (className === "%Error" || RUNTIME_ERROR_CLASSES.has(className)) return true;
  for (let c = L.classes.get(className)?.base ?? null; c; c = c.base) {
    if (c.def.name === "%Error") return true;
  }
  return false;
}

/** Classify the expected argument: string → message, regex value → the
 * regex test over String(error), an error-class identifier → instanceof,
 * an object LITERAL over name/message/code (string or regex values) →
 * the per-key shape comparison. Anything else fences honestly. */
function classifyThrowsExpected(
  L: Lowerer,
  surface: string,
  node: ts.Expression,
  loc: SrcLoc,
): ThrowsExpected {
  const expectedT = L.mapTypeOf(L.typeOf(node));
  if (expectedT?.kind === "string") {
    const m = lowerMessageArg(L, node, loc);
    return { form: "message", msg: m.msg, hasMsg: m.hasMsg };
  }
  if (expectedT?.kind === "regex") {
    return { form: "regex", value: L.lowerExpr(node) };
  }
  const sym = ts.isIdentifier(node) ? L.resolveValueSymbol(node) : null;
  const info = (sym && L.builtinErrorInfoOf(sym)) ?? (sym && L.classBySymbol.get(sym)) ?? null;
  // A rebindable decorated name: the runtime expectation is the decoration
  // result's interval, not the declaration's — no static class check.
  if (info?.classDecorators?.valueGlobalId !== undefined) {
    L.unsupported(
      "SC1090",
      node,
      "assert.throws/rejects against a decorated class whose decorators may replace it",
    );
  }
  if (info && L.inHierarchy(info)) {
    const rec = RUNTIME_ERROR_CLASSES.get(info.def.name);
    return {
      form: "class",
      className: info.def.name,
      displayName: rec ? rec.lib : info.def.name.replace(/^%/, ""),
    };
  }
  let obj: ts.Expression = node;
  while (ts.isParenthesizedExpression(obj)) obj = obj.expression;
  if (ts.isObjectLiteralExpression(obj)) {
    if (obj.properties.length === 0) {
      L.noLowering(
        `${surface} with an empty expected object`,
        obj,
        "Node rejects this (the error 'may not be an empty object') — name at least one of name/message/code",
      );
    }
    // Duplicate keys keep the LAST value (JS object-literal semantics);
    // property order is preserved for argument evaluation.
    const byId = new Map<number, ThrowsShapeKey>();
    for (const prop of obj.properties) {
      const named =
        ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) ? prop : null;
      if (!named || !(ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
        L.noLowering(
          `${surface} with this expected-object property form`,
          prop,
          "plain `key: value` properties are the lowered form",
        );
      }
      const keyName = named.name.text;
      const id = own(SHAPE_KEY_IDS, keyName);
      if (id === undefined) {
        L.noLowering(
          `${surface} comparing the '${keyName}' property of the thrown error`,
          prop,
          "the static error surface carries name, message, and code — compare other properties in a catch block",
        );
      }
      const valueNode = ts.isPropertyAssignment(named) ? named.initializer : named.name;
      const value = L.lowerExpr(valueNode);
      if (value.type.kind === "string") {
        byId.set(id, { id, kind: "str", value, enameBake: null });
      } else if (value.type.kind === "regex") {
        let bake: string | null = null;
        if (ts.isRegularExpressionLiteral(valueNode)) {
          const text = valueNode.text;
          const cut = text.lastIndexOf("/");
          bake = `/${text.slice(1, cut)}/${regexFlagsGetterOrder(text.slice(cut + 1))}`;
        }
        byId.set(id, { id, kind: "re", value, enameBake: bake });
      } else {
        L.noLowering(
          `${surface} expected-object values of type '${L.fmt(value.type)}'`,
          valueNode,
          "string and regular-expression values are the lowered comparisons",
        );
      }
    }
    return { form: "shape", keys: [...byId.values()] };
  }
  // An error INSTANCE (`assert.rejects(p, expectedError)` — the
  // tracingChannel suite's shape): the value crosses as a dyn error and
  // the runtime compares per Node's expectsError key walk. A
  // checked-dynamic expected rides directly; a static %Error boxes.
  if (expectedT?.kind === "dyn") {
    const value = L.lowerExpr(node);
    if (value.type.kind === "dyn") return { form: "errValue", value };
  }
  if (expectedT?.kind === "object" && expectedT.className === "%Error") {
    const value = L.lowerExpr(node);
    if (value.type.kind === "object") {
      return { form: "errValue", value: { kind: "dynFrom", value, type: DYN, loc } };
    }
  }
  // A plain expected object held in a VARIABLE (`const oor = { code: ... };
  // assert.throws(fn, oor)` — the suite's shared expectation records): the
  // same runtime key walk as an error instance — Node's expectsError reads
  // the expected's own keys only, so a convertible record crosses as its
  // dyn object. Records carrying regex members are not convertible and
  // keep the fence (the runtime walk would deep-compare, not test).
  if (expectedT?.kind === "record" && L.dynConvertible(expectedT)) {
    const value = L.lowerExpr(node);
    // JS-lane locals holding object literals lower to dyn already; a
    // typed record crosses through dynFrom.
    if (value.type.kind === "dyn") return { form: "errValue", value };
    if (typeEquals(value.type, expectedT)) {
      return { form: "errValue", value: { kind: "dynFrom", value, type: DYN, loc } };
    }
  }
  L.noLowering(
    `${surface} with this expected-error shape`,
    node,
    "an error CLASS (Error/TypeError/... or a class extending them), an error instance, a message string, " +
      "a regular expression, or an object literal over name/message/code are the lowered forms",
  );
}

/** assert.throws(fn[, expected][, message]): the zero-parameter callback
 * runs inside a synthesized try/catch helper. Bare form: any throw
 * passes, a normal return throws "Missing expected exception." — a
 * STRING second argument is Node's message form. An error-CLASS second
 * argument checks `instanceof` (a non-matching Error throws Node's
 * mismatch AssertionError); a REGEX tests String(error); an object
 * LITERAL compares its name/message/code keys (strings deep, regex
 * values by test) with Node's byte-exact Comparison-diff message. A
 * non-Error thrown value under any expectation propagates
 * (SEMANTICS.md 104 — Node builds an AssertionError from its
 * inspection). */
function lowerAssertThrows(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  requireStatementPosition(L, expr, "assert.throws");
  if (expr.arguments.length < 1 || expr.arguments.length > 3) {
    L.noLowering(
      `assert.throws with ${expr.arguments.length} arguments`,
      expr,
      "the supported forms are throws(fn), throws(fn, expected), and throws(fn, expected, message)",
    );
  }
  const fn = L.lowerExpr(expr.arguments[0]!);
  if (fn.type.kind !== "func" || fn.type.params.length !== 0) {
    L.noLowering(
      "assert.throws with this callback shape",
      expr.arguments[0]!,
      "the callback must be a zero-parameter function",
    );
  }
  const { expected, msg, hasMsg } = throwsArguments(L, "assert.throws", expr, loc);
  const helper = assertThrowsHelper(L, "throws", fn.type, false, expected, loc);
  return { kind: "call", callee: helper, args: [fn, msg, hasMsg, ...expectedArgs(expected)], type: VOID, loc };
}

/** assert.rejects / assert.doesNotReject: the async twins. The first
 * argument is a zero-parameter promise-returning function (an async
 * function value — a synchronous throw from a non-async one propagates
 * RAW through the helper's own promise, Node's waitForActual) or a
 * promise value. The call answers Promise<void>: `await` it like Node;
 * an un-awaited failing call enters the unhandled-rejection ledger,
 * also like Node. rejects shares assert.throws's expected forms;
 * doesNotReject rethrows a NON-matching rejection and throws Node's
 * "Got unwanted rejection" AssertionError on a match (regex
 * expectations fence — the runtime predicate is throw-shaped). */
function lowerAssertRejects(
  L: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  doesNot: boolean,
): IrExpr {
  const surface = doesNot ? "assert.doesNotReject" : "assert.rejects";
  if (expr.arguments.length < 1 || expr.arguments.length > 3) {
    L.noLowering(
      `${surface} with ${expr.arguments.length} arguments`,
      expr,
      `the supported forms are ${doesNot ? "doesNotReject" : "rejects"}(fn), (fn, expected), and (fn, expected, message)`,
    );
  }
  const recv = L.lowerExpr(expr.arguments[0]!);
  const recvIsPromise = recv.type.kind === "promise";
  if (
    !recvIsPromise &&
    (recv.type.kind !== "func" || recv.type.params.length !== 0 || recv.type.ret.kind !== "promise")
  ) {
    L.noLowering(
      `${surface} with this first argument`,
      expr.arguments[0]!,
      "an async (promise-returning) zero-parameter function or a promise are the lowered forms " +
        "(a bare thenable — an object with a then method — has no lowering: wrap it, e.g. Promise.resolve().then(() => thenable))",
    );
  }
  const { expected, msg, hasMsg } = throwsArguments(L, surface, expr, loc);
  if (doesNot && (expected.form === "shape" || expected.form === "errValue")) {
    // Node itself rejects this form (ERR_INVALID_ARG_TYPE: "expected"
    // must be a function or RegExp) — the fence is the compile-time
    // statement of the same rule.
    L.noLowering(
      `${surface} with an object-shape expectation`,
      expr.arguments[1]!,
      "Node rejects this form (doesNotReject takes a class or RegExp) — use a class, a regex, or a bare call",
    );
  }
  const helper = assertThrowsHelper(L, doesNot ? "dnr" : "rejects", recv.type, recvIsPromise, expected, loc);
  return {
    kind: "call",
    callee: helper,
    args: [recv, msg, hasMsg, ...expectedArgs(expected)],
    type: { kind: "promise", inner: VOID },
    loc,
  };
}

/** The shared expected/message argument split (arguments 2 and 3): a
 * string expected IS the message and excludes a third argument (Node
 * throws ERR_INVALID_ARG_TYPE there). */
function throwsArguments(
  L: Lowerer,
  surface: string,
  expr: ts.CallExpression,
  loc: SrcLoc,
): { expected: ThrowsExpected; msg: IrExpr; hasMsg: IrExpr } {
  const expectedNode = expr.arguments[1];
  // A literal `undefined` expected counts as omitted (Node reads the
  // message from the THIRD argument in that spelling).
  const expected: ThrowsExpected =
    expectedNode && !(ts.isIdentifier(expectedNode) && expectedNode.text === "undefined")
      ? classifyThrowsExpected(L, surface, expectedNode, loc)
      : { form: "bare" };
  if (expected.form === "message") {
    if (expr.arguments.length === 3) {
      L.noLowering(
        `${surface} with a string expected argument AND a message`,
        expr.arguments[2]!,
        "Node rejects this form (the string IS the message) — use an expected shape second",
      );
    }
    return { expected, msg: expected.msg, hasMsg: expected.hasMsg };
  }
  const { msg, hasMsg } = lowerMessageArg(L, expr.arguments[2], loc);
  return { expected, msg, hasMsg };
}

/** The extra call-site arguments a form carries into its helper, in the
 * helper's own parameter order. */
function expectedArgs(expected: ThrowsExpected): IrExpr[] {
  if (expected.form === "regex") return [expected.value];
  if (expected.form === "shape") return expected.keys.map((k) => k.value);
  if (expected.form === "errValue") return [expected.value];
  return [];
}

/** The interned per-(mode, receiver-type, expected-signature) helper:
 *
 *   %assert.throws.<n>(f, m, hm[, re | k0..kN]) {
 *     try { f(); } catch (e) { <per-form checks> }
 *     <"Missing expected exception" throw>
 *   }
 *
 * rejects/doesNotReject synthesize the ASYNC twin — the callback's
 * promise is created OUTSIDE the try (a sync throw from the callback
 * rejects the helper's own promise raw, Node's waitForActual), then
 * awaited inside it:
 *
 *   async %assert.rejects.<n>(f, m, hm, ...) {
 *     const pr = f();                    // or the promise param itself
 *     try { await pr; } catch (e) { <per-form checks, return> }
 *     <"Missing expected rejection" throw>
 *   }
 *
 * Per-form catch bodies (throws/rejects): bare returns; class returns on
 * instanceof, throws the mismatch AssertionError for other Errors;
 * regex/shape run their runtime checks (which throw on mismatch) and
 * return. doesNotReject inverts: a MATCHING Error throws "Got unwanted
 * rejection", everything else rethrows the original reason. A non-Error
 * thrown value under any expectation propagates (SEMANTICS.md 104). */
function assertThrowsHelper(
  L: Lowerer,
  mode: "throws" | "rejects" | "dnr",
  recvType: IrType,
  recvIsPromise: boolean,
  expected: ThrowsExpected,
  loc: SrcLoc,
): string {
  const sig =
    expected.form === "class"
      ? `class:${expected.className}`
      : expected.form === "regex"
        ? "regex"
        : expected.form === "shape"
          ? "shape:" + expected.keys.map((k) => `${k.id}${k.kind}:${k.enameBake ?? ""}`).join(",")
          : expected.form === "errValue"
            ? "errval"
            : "bare";
  const key = `assert.${mode}:${recvIsPromise ? "p" : "f"}:${typeKey(recvType)}:${sig}`;
  const existing = L.assertHelpers.get(key);
  if (existing) return existing;
  const name = `%assert.${mode}.${L.assertHelpers.size}`;
  L.assertHelpers.set(key, name);

  const caughtRef = (): IrExpr => varRef("e.0", CAUGHT, loc);
  const errT: IrType = { kind: "object", className: "%Error" };
  const narrowed = (): IrExpr => ({ kind: "caughtNarrow", value: caughtRef(), type: errT, loc });
  const isInstance = (className: string): IrExpr => ({
    kind: "caughtTest", value: caughtRef(), test: "instanceof", className, type: BOOL, loc,
  });
  const lib = (fn: IrLibFn, args: IrExpr[]): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "libCall", fn, args, type: VOID, loc },
    loc,
  });
  const m = (): IrExpr => varRef("m.0", STRING, loc);
  const hm = (): IrExpr => varRef("hm.0", BOOL, loc);
  const doReturn: IrStmt = { kind: "return", value: null, loc };
  const rethrow: IrStmt = { kind: "rethrow", localId: "e.0", loc };
  const ifStmt = (cond: IrExpr, then: IrStmt[]): IrStmt => ({ kind: "if", cond, then, else_: null, loc });

  const params: { localId: string; name: string; type: IrType }[] = [
    { localId: "f.0", name: recvIsPromise ? "p" : "f", type: recvType },
    { localId: "m.0", name: "m", type: STRING },
    { localId: "hm.0", name: "hm", type: BOOL },
  ];
  const shapeParamIds: string[] = [];
  if (expected.form === "regex") params.push({ localId: "re.0", name: "re", type: REGEX });
  if (expected.form === "errValue") params.push({ localId: "ev.0", name: "ev", type: DYN });
  if (expected.form === "shape") {
    expected.keys.forEach((k, i) => {
      const localId = `k${i}.0`;
      shapeParamIds.push(localId);
      params.push({ localId, name: `k${i}`, type: k.kind === "str" ? STRING : REGEX });
    });
  }
  const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = params.map(
    (p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false }),
  );
  locals.push({ id: "e.0", name: "e", type: CAUGHT, mutable: false });

  /** shapeBegin + one slot call per key (never throw; shapeEnd consumes
   * the accumulator). */
  const shapeSlotStmts = (): IrStmt[] => {
    if (expected.form !== "shape") return [];
    const stmts: IrStmt[] = [lib("assert.shapeBegin", [narrowed()])];
    expected.keys.forEach((k, i) => {
      stmts.push(
        lib(k.kind === "str" ? "assert.shapeStr" : "assert.shapeRe", [
          numLit(k.id, loc),
          varRef(shapeParamIds[i]!, k.kind === "str" ? STRING : REGEX, loc),
        ]),
      );
    });
    return stmts;
  };

  // The ` (${expected.name})` detail of the missing-exception message: a
  // class's display name, a shape's name VALUE (its string param, or the
  // compile-time rendering of a regex-literal name); a non-literal regex
  // name drops the detail (a documented sliver).
  const ename = ((): { e: IrExpr; has: boolean } => {
    if (expected.form === "class") return { e: strLit(expected.displayName, loc), has: true };
    if (expected.form === "shape") {
      const i = expected.keys.findIndex((k) => k.id === 2);
      if (i >= 0) {
        const k = expected.keys[i]!;
        if (k.kind === "str") return { e: varRef(shapeParamIds[i]!, STRING, loc), has: true };
        if (k.enameBake !== null) return { e: strLit(k.enameBake, loc), has: true };
      }
    }
    return { e: strLit("", loc), has: false };
  })();

  let catchBody: IrStmt[];
  if (mode === "dnr") {
    switch (expected.form) {
      case "bare":
      case "message":
        catchBody = [
          ifStmt(isInstance("%Error"), [lib("assert.unwantedRejection", [narrowed(), m(), hm()])]),
          rethrow,
        ];
        break;
      case "class":
        catchBody = [
          ifStmt(isInstance(expected.className), [
            lib("assert.unwantedRejection", [narrowed(), m(), hm()]),
          ]),
          rethrow,
        ];
        break;
      case "regex":
        catchBody = [
          ifStmt(isInstance("%Error"), [
            ifStmt(
              {
                kind: "libCall",
                fn: "assert.regexErrTest",
                args: [varRef("re.0", REGEX, loc), narrowed()],
                type: BOOL,
                loc,
              },
              [lib("assert.unwantedRejection", [narrowed(), m(), hm()])],
            ),
          ]),
          rethrow,
        ];
        break;
      default:
        // Node itself rejects shape expectations here (ERR_INVALID_ARG_TYPE)
        // — the call site fences before reaching this helper.
        throw new InternalCompilerError("assert helper: doesNotReject shape forms fence at the call site");
    }
  } else {
    switch (expected.form) {
      case "bare":
      case "message":
        catchBody = [doReturn];
        break;
      case "class":
        catchBody = [
          ifStmt(isInstance(expected.className), [doReturn]),
          ifStmt(isInstance("%Error"), [
            lib("assert.throwsMismatch", [strLit(expected.displayName, loc), narrowed(), m(), hm()]),
          ]),
          // A non-Error thrown value: propagate (SEMANTICS.md 104; the
          // mismatch throw above never falls through — its pending
          // exception unwinds first).
          rethrow,
        ];
        break;
      case "regex":
        catchBody = [
          ifStmt(isInstance("%Error"), [
            lib("assert.throwsRegex", [varRef("re.0", REGEX, loc), narrowed(), m(), hm()]),
            doReturn,
          ]),
          rethrow,
        ];
        break;
      case "shape":
        catchBody = [
          ifStmt(isInstance("%Error"), [
            ...shapeSlotStmts(),
            lib("assert.shapeEnd", [m(), hm()]),
            doReturn,
          ]),
          rethrow,
        ];
        break;
      case "errValue":
        // Node's expectsError over an error-instance expected: the
        // caught value crosses as a dyn value (identity-preserving) and
        // the runtime walks the expected's keys — a mismatch throws the
        // deep-equal AssertionError.
        catchBody = [
          lib("assert.expectsErrDyn", [
            { kind: "caughtToDyn", value: caughtRef(), type: DYN, loc },
            varRef("ev.0", DYN, loc),
            m(),
            hm(),
          ]),
          doReturn,
        ];
        break;
    }
  }

  const body: IrStmt[] = [];
  let tryBody: IrStmt[];
  if (mode === "throws") {
    const fnT = recvType as IrType & { kind: "func" };
    tryBody = [
      {
        kind: "exprStmt",
        expr: { kind: "callValue", callee: varRef("f.0", fnT, loc), args: [], type: fnT.ret, loc },
        loc,
      },
    ];
  } else {
    let awaited: IrExpr;
    if (recvIsPromise) {
      awaited = varRef("f.0", recvType, loc);
    } else {
      const fnT = recvType as IrType & { kind: "func" };
      const promT = fnT.ret;
      locals.push({ id: "pr.0", name: "pr", type: promT, mutable: false });
      body.push({
        kind: "varDecl",
        localId: "pr.0",
        init: { kind: "callValue", callee: varRef("f.0", fnT, loc), args: [], type: promT, loc },
        loc,
      });
      awaited = varRef("pr.0", promT, loc);
    }
    const inner = (awaited.type as IrType & { kind: "promise" }).inner;
    tryBody = [
      { kind: "exprStmt", expr: { kind: "awaitExpr", value: awaited, type: inner, loc }, loc },
    ];
  }
  body.push({ kind: "tryCatch", tryBody, catchBody, catchLocalId: "e.0", finallyBody: null, loc });
  if (mode !== "dnr") {
    body.push(lib("assert.throwsNone", [boolLit(mode === "rejects", loc), ename.e, boolLit(ename.has, loc), m(), hm()]));
  }
  body.push(doReturn);

  L.liftedFns.push({
    name,
    params,
    returnType: VOID,
    locals,
    body,
    loc,
    ...(mode === "throws" ? {} : { async: true as const }),
  });
  return name;
}

/* ── assert.ifError ────────────────────────────────────────────────────── */

/** The typed runtime entry for one non-union ifError argument type:
 * "unit" for null/undefined (can never throw — the evaluated expression
 * alone suffices), a libCall name for scalars and %Error-hierarchy
 * objects, null for everything else (the caller fences). */
function ifErrorLibFn(
  L: Lowerer,
  t: IrType,
): "assert.ifErrorErr" | "assert.ifErrorF64" | "assert.ifErrorStr" | "assert.ifErrorBool" | "unit" | null {
  switch (t.kind) {
    case "undefinedT":
    case "nullT":
      return "unit";
    case "f64":
      return "assert.ifErrorF64";
    case "string":
      return "assert.ifErrorStr";
    case "bool":
      return "assert.ifErrorBool";
    case "object":
      return inErrorHierarchy(L, t.className) ? "assert.ifErrorErr" : null;
    default:
      return null;
  }
}

/** assert.ifError(value): Node throws for ANY value except null and
 * undefined — falsy scalars included — with "ifError got unwanted
 * exception: " + the error's message (its name when the message is
 * empty) or the value's inspection. Unit-typed arguments lower to the
 * evaluated expression alone; scalars and %Error-hierarchy objects
 * throw through the typed runtime entries; unions dispatch per arm in
 * an interned helper. Anything else fences. */
function lowerAssertIfError(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  requireStatementPosition(L, expr, "assert.ifError");
  if (expr.arguments.length !== 1) {
    L.noLowering(
      `assert.ifError with ${expr.arguments.length} arguments`,
      expr,
      "the supported form is ifError(value)",
    );
  }
  const argNode = expr.arguments[0]!;
  const argT = L.mapTypeOf(L.typeOf(argNode));
  if (argT && isUnitType(argT)) {
    // null/undefined can never throw, and a unit-typed expression has no
    // standalone runtime value to evaluate — a passing assert.ok is the
    // void-typed no-op.
    return {
      kind: "libCall",
      fn: "assert.ok",
      args: [
        { kind: "boolLit", value: true, type: BOOL, loc },
        { kind: "strLit", value: "", type: STRING, loc },
      ],
      type: VOID,
      loc,
    };
  }
  const v = L.lowerExpr(argNode);
  const fence = (t: IrType): never =>
    L.noLowering(
      `assert.ifError over '${L.fmt(t)}' values`,
      argNode,
      "numbers, strings, booleans, Errors, null/undefined, and unions of those are the lowered forms",
    );
  const direct = ifErrorLibFn(L, v.type);
  if (direct === "unit") {
    // A unit-typed value that mapped through some other checker spelling:
    // the same no-op (unreachable in practice — the mapTypeOf branch
    // above catches unit checker types).
    return {
      kind: "libCall",
      fn: "assert.ok",
      args: [
        { kind: "boolLit", value: true, type: BOOL, loc },
        { kind: "strLit", value: "", type: STRING, loc },
      ],
      type: VOID,
      loc,
    };
  }
  if (direct !== null) return { kind: "libCall", fn: direct, args: [v], type: VOID, loc };
  // A checked-dynamic argument (test/common's mustSucceed wrapper — the
  // callback's err parameter is untyped): the runtime dispatches over the
  // dyn kind — units pass quietly, %error-marked objects throw with the
  // error's message, everything else with the inspection.
  if (v.type.kind === "dyn") {
    return { kind: "libCall", fn: "assert.ifErrorDyn", args: [v], type: VOID, loc };
  }
  if (v.type.kind !== "union") fence(v.type);
  const unionT = v.type as IrType & { kind: "union" };
  const def = L.unions.get(unionT.unionId);
  if (!def) fence(v.type);
  for (const arm of def!.arms) {
    if (ifErrorLibFn(L, arm) === null) fence(arm);
  }
  const helper = ifErrorHelper(L, unionT, loc);
  return { kind: "call", callee: helper, args: [v], type: VOID, loc };
}

/** The interned per-union ifError helper `%assert.iferr.<n>(v): void` —
 * one tag test per arm: unit arms return quietly, every other arm
 * narrows and throws through its typed runtime entry. */
function ifErrorHelper(L: Lowerer, t: IrType & { kind: "union" }, loc: SrcLoc): string {
  const key = `assert.iferr:${typeKey(t)}`;
  const existing = L.assertHelpers.get(key);
  if (existing) return existing;
  const name = `%assert.iferr.${L.assertHelpers.size}`;
  L.assertHelpers.set(key, name);
  const def = L.unions.get(t.unionId);
  if (!def) throw new InternalCompilerError(`assert.ifError over unknown union ${t.unionId}`);
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: t, loc });
  const doReturn: IrStmt = { kind: "return", value: null, loc };
  const body: IrStmt[] = [];
  def.arms.forEach((arm, tag) => {
    const fn = ifErrorLibFn(L, arm);
    if (fn === null) throw new InternalCompilerError("assert.ifError helper over an unfenced arm");
    const then: IrStmt[] =
      fn === "unit"
        ? [doReturn]
        : [
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn,
                args: [{ kind: "unionNarrow", unionId: t.unionId, tag, value: v(), type: arm, loc }],
                type: VOID,
                loc,
              },
              loc,
            },
            doReturn,
          ];
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: v(), type: BOOL, loc },
      then,
      else_: null,
      loc,
    });
  });
  body.push(doReturn); // unreachable: some arm always matches
  L.liftedFns.push({
    name,
    params: [{ localId: "v.0", name: "v", type: t }],
    returnType: VOID,
    locals: [{ id: "v.0", name: "v", type: t, mutable: false }],
    body,
    loc,
  });
  return name;
}

/** The TOP-LEVEL checker brand of a bytes-typed argument: the constructor
 * name Node's deep equality compares as the prototype. The runtime
 * representation is one ScrBytes for Buffer AND the typed arrays, so the
 * argument's own checker type is the only carrier (the lower-inspect
 * precedent). Null when the spelling is not a recognized constructor —
 * the caller fences. */
const BYTES_BRANDS: ReadonlySet<string> = new Set([
  "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array",
  "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "DataView",
]);

function bytesBrandOf(L: Lowerer, node: ts.Expression): string | null {
  const tname = L.checker.typeToString(L.checker.getBaseTypeOfLiteralType(L.typeOf(node)));
  const head = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(tname)?.[0] ?? "";
  if (head === "Buffer" || head === "NonSharedBuffer") return "Buffer";
  return BYTES_BRANDS.has(head) ? head : null;
}

/* ── deep equality (deepStrictEqual / notDeepStrictEqual) ──────────────── */

/** Why `t` has no honest deep comparison, or null when it lowers. The
 * fence names the FIRST unsupported constituent — never a silent
 * miscompare. Recursive record shapes terminate through `visiting`
 * (a shape being checked is assumed fine; its own walk decides). */
function deepUnsupportedReason(L: Lowerer, t: IrType, visiting: Set<string>): string | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
      return null;
    case "array":
      return deepUnsupportedReason(L, t.elem, visiting);
    case "record": {
      if (visiting.has(t.shapeId)) return null;
      visiting.add(t.shapeId);
      const shape = L.shapes.get(t.shapeId);
      if (!shape) return "this record shape has no deep comparison";
      if (shape.indexValue !== undefined) {
        return "index-signature records have no deep comparison (their key sets are dynamic)";
      }
      for (const f of shape.fields) {
        const why = deepUnsupportedReason(L, f.type, visiting);
        if (why !== null) return why;
      }
      return null;
    }
    case "map": {
      const keyWhy = deepUnsupportedReason(L, t.key, visiting);
      if (keyWhy !== null) return keyWhy;
      return deepUnsupportedReason(L, t.value, visiting);
    }
    case "set":
      return t.elem.kind === "f64" || t.elem.kind === "string" || t.elem.kind === "bool"
        ? null
        : "Sets of non-scalar elements have no deep comparison (Node matches object members structurally)";
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) return "this union has no deep comparison";
      for (const arm of def.arms) {
        const why = deepUnsupportedReason(L, arm, visiting);
        if (why !== null) return why;
      }
      return null;
    }
    case "func":
      // Node's deep equality over functions is reference identity (two
      // distinct functions are never deep-equal; the same reference is) —
      // a pointer compare carries it faithfully.
      return null;
    case "symbol":
      // Symbols deep-compare by identity (SameValue primitives) — the
      // pointer IS the identity.
      return null;
    case "bytes":
      // NESTED bytes (an array element, a record field): the Buffer-vs-
      // Uint8Array brand Node compares lives in the checker type of a
      // TOP-LEVEL argument only — no brand survives into shapes.
      return "typed arrays inside composites have no deep comparison (Node compares constructors, which the static element/field type does not carry)";
    case "object":
      return "class instances have no deep comparison (Node compares prototypes and own properties)";
    default:
      return `'${L.fmt(t)}' values have no deep comparison`;
  }
}

/** The interned per-type deep-equality helper `%assert.deq.<n>(a, b):
 * boolean` — Node's strict deep rules over the static type: Object.is
 * numbers, byte-equal strings, per-element arrays, per-field records,
 * tag+payload unions, SameValueZero-keyed Maps with deep values, scalar
 * Sets by membership. Registered in the cache BEFORE the body builds, so
 * recursive record shapes call themselves by name. */
function deepEqHelper(L: Lowerer, t: IrType, loc: SrcLoc): string {
  const key = `assert.deq:${typeKey(t)}`;
  const existing = L.assertHelpers.get(key);
  if (existing) return existing;
  const name = `%assert.deq.${L.assertHelpers.size}`;
  L.assertHelpers.set(key, name);

  const a = (): IrExpr => varRef("a.0", t, loc);
  const b = (): IrExpr => varRef("b.0", t, loc);
  const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
  const retFalse: IrStmt = ret(boolLit(false, loc));
  const not = (operand: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand, type: BOOL, loc });
  const neq = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "!==", left, right, type: BOOL, loc });
  /** if (cond) return false; */
  const bailIf = (cond: IrExpr): IrStmt => ({ kind: "if", cond, then: [retFalse], else_: null, loc });
  /** Deep-compare two same-typed exprs through the per-type helper. */
  const deq = (elemT: IrType, x: IrExpr, y: IrExpr): IrExpr =>
    isUnitType(elemT)
      ? boolLit(true, loc)
      : { kind: "call", callee: deepEqHelper(L, elemT, loc), args: [x, y], type: BOOL, loc };

  let locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
    { id: "a.0", name: "a", type: t, mutable: false },
    { id: "b.0", name: "b", type: t, mutable: false },
  ];
  let body: IrStmt[];

  switch (t.kind) {
    case "f64":
      body = [ret({ kind: "libCall", fn: "assert.sameValue", args: [a(), b()], type: BOOL, loc })];
      break;
    case "string":
      body = [ret({ kind: "strEq", negated: false, left: a(), right: b(), type: BOOL, loc })];
      break;
    case "bool":
      body = [ret({ kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc })];
      break;
    case "func":
    case "symbol":
      // Reference identity — Node's deep equality over functions; a
      // symbol IS its pointer identity.
      body = [ret({ kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc })];
      break;
    case "array": {
      const len = (arr: IrExpr): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: arr, args: [], type: F64, loc });
      const at = (arr: IrExpr, i: IrExpr): IrExpr => ({ kind: "arrayGet", arr, index: i, type: t.elem, loc });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      body = [
        bailIf(neq(len(a()), len(b()))),
        countedFor(loc, len(a()), (i) => [bailIf(not(deq(t.elem, at(a(), i), at(b(), i))))]),
        ret(boolLit(true, loc)),
      ];
      break;
    }
    case "record": {
      const shape = L.shapes.get(t.shapeId);
      if (!shape) throw new InternalCompilerError(`assert deep-equal of unknown shape ${t.shapeId}`);
      const get = (obj: IrExpr, field: string, type: IrType): IrExpr => ({ kind: "recordGet", obj, shapeId: t.shapeId, field, type, loc });
      body = [];
      for (const f of shape.fields) {
        if (isUnitType(f.type)) continue; // a unit field is equal by type
        body.push(bailIf(not(deq(f.type, get(a(), f.name, f.type), get(b(), f.name, f.type)))));
      }
      body.push(ret(boolLit(true, loc)));
      break;
    }
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) throw new InternalCompilerError(`assert deep-equal of unknown union ${t.unionId}`);
      const isTag = (v: IrExpr, tag: number, negated: boolean): IrExpr => ({ kind: "unionIsTag", unionId: t.unionId, tag, negated, value: v, type: BOOL, loc });
      const narrow = (v: IrExpr, tag: number, armT: IrType): IrExpr => ({ kind: "unionNarrow", unionId: t.unionId, tag, value: v, type: armT, loc });
      body = [];
      def.arms.forEach((arm, tag) => {
        body.push({
          kind: "if",
          cond: isTag(a(), tag, false),
          then: [
            bailIf(isTag(b(), tag, true)),
            ret(deq(arm, narrow(a(), tag, arm), narrow(b(), tag, arm))),
          ],
          else_: null,
          loc,
        });
      });
      body.push(retFalse); // unreachable: some arm always matches
      break;
    }
    case "map": {
      const mi = (method: "size" | "iterCount" | "iterLive" | "iterKey" | "iterValue" | "has" | "get", receiver: IrExpr, args: IrExpr[], type: IrType): IrExpr => ({ kind: "mapIntrinsic", method, receiver, args, type, loc });
      const valueT = t.value;
      const hasUndefArm =
        valueT.kind === "union" &&
        (L.unions.get(valueT.unionId)?.arms.some((arm) => arm.kind === "undefinedT") ?? false);
      const getT = hasUndefArm ? valueT : L.withUndefinedArm(valueT);
      locals.push(
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "k.0", name: "k", type: t.key, mutable: false },
        { id: "av.0", name: "av", type: valueT, mutable: false },
        { id: "bv.0", name: "bv", type: getT, mutable: false },
      );
      const i = (): IrExpr => varRef("i.0", F64, loc);
      const k = (): IrExpr => varRef("k.0", t.key, loc);
      // The b-side value: get() answers `V | undefined`; has() already
      // proved presence, so a plain V narrows through the value arm.
      const bValue: IrExpr =
        getT === valueT
          ? varRef("bv.0", getT, loc)
          : {
              kind: "unionNarrow",
              unionId: (getT as IrType & { kind: "union" }).unionId,
              tag: L.armTag((getT as IrType & { kind: "union" }).unionId, valueT),
              value: varRef("bv.0", getT, loc),
              type: valueT,
              loc,
            };
      body = [
        bailIf(neq(mi("size", a(), [], F64), mi("size", b(), [], F64))),
        countedFor(loc, mi("iterCount", a(), [], F64), () => [
            { kind: "if", cond: not(mi("iterLive", a(), [i()], BOOL)), then: [{ kind: "continue", loc }], else_: null, loc },
            { kind: "varDecl", localId: "k.0", init: mi("iterKey", a(), [i()], t.key), loc },
            bailIf(not(mi("has", b(), [k()], BOOL))),
            { kind: "varDecl", localId: "av.0", init: mi("iterValue", a(), [i()], valueT), loc },
            { kind: "varDecl", localId: "bv.0", init: mi("get", b(), [k()], getT), loc },
            bailIf(not(deq(valueT, varRef("av.0", valueT, loc), bValue))),
          ],
        ),
        ret(boolLit(true, loc)),
      ];
      break;
    }
    case "set": {
      const si = (method: "size" | "iterCount" | "iterLive" | "iterKey" | "has", receiver: IrExpr, args: IrExpr[], type: IrType): IrExpr => ({ kind: "setIntrinsic", method, receiver, args, type, loc });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      const i = (): IrExpr => varRef("i.0", F64, loc);
      body = [
        bailIf(neq(si("size", a(), [], F64), si("size", b(), [], F64))),
        countedFor(loc, si("iterCount", a(), [], F64), () => [
            { kind: "if", cond: not(si("iterLive", a(), [i()], BOOL)), then: [{ kind: "continue", loc }], else_: null, loc },
            bailIf(not(si("has", b(), [si("iterKey", a(), [i()], t.elem)], BOOL))),
          ],
        ),
        ret(boolLit(true, loc)),
      ];
      break;
    }
    default:
      throw new InternalCompilerError(`assert deep-equal helper over unexpected type ${typeKey(t)}`);
  }

  // CYCLE-CAPABLE containers (recursive record types and their arrays/
  // maps) wrap the structural walk in the runtime PAIR MEMO: identical
  // references are deep-equal without walking, and a (a, b) pair already
  // being compared answers equal — Node's memoization, so equal cyclic
  // structures compare true instead of recursing forever. The walk moves
  // into a sibling function; `name` becomes the memo wrapper every caller
  // (recursion included) enters through.
  if ((t.kind === "record" || t.kind === "array" || t.kind === "map") && typeReachesItself(L, t)) {
    const walkName = `${name}.walk`;
    L.liftedFns.push({
      name: walkName,
      params: [
        { localId: "a.0", name: "a", type: t },
        { localId: "b.0", name: "b", type: t },
      ],
      returnType: BOOL,
      locals,
      body,
      loc,
    });
    locals = [
      { id: "a.0", name: "a", type: t, mutable: false },
      { id: "b.0", name: "b", type: t, mutable: false },
      { id: "eq.0", name: "eq", type: BOOL, mutable: false },
    ];
    body = [
      { kind: "if", cond: { kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc }, then: [ret(boolLit(true, loc))], else_: null, loc },
      {
        kind: "if",
        cond: { kind: "libCall", fn: "assert.deqEnter", args: [a(), b()], type: BOOL, loc },
        then: [ret(boolLit(true, loc))],
        else_: null,
        loc,
      },
      { kind: "varDecl", localId: "eq.0", init: { kind: "call", callee: walkName, args: [a(), b()], type: BOOL, loc }, loc },
      { kind: "exprStmt", expr: { kind: "libCall", fn: "assert.deqLeave", args: [], type: VOID, loc }, loc },
      ret(varRef("eq.0", BOOL, loc)),
    ];
  }

  L.liftedFns.push({
    name,
    params: [
      { localId: "a.0", name: "a", type: t },
      { localId: "b.0", name: "b", type: t },
    ],
    returnType: BOOL,
    locals,
    body,
    loc,
  });
  return name;
}
