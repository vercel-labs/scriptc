import { InternalCompilerError } from "../../errors.js";
/* comptime(fn) lowering: run the closed callback through the host at compile
 * time (with a timeout), then bake the produced VALUE into the IR as
 * literals — records/arrays/unions included, subject to comptimeBakeable. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isUnitType, type IrExpr, type IrType } from "../../ir/ir.js";
import { comptimeFailedDiag } from "../../diagnostics/diagnostic.js";
import { locOf } from "../program.js";
import { PoisonError } from "./lowerer.js";

/** Wall-clock budget for one comptime callback. Evaluation happens inside
 * the compiler (node:vm), so a runaway loop would hang the BUILD — the vm
 * timeout turns it into a diagnostic instead. */
const COMPTIME_TIMEOUT_MS = 2000;

/** Names a compile-time-computed JS value in a comptime result diagnostic
 * ("expected 'number' at $.t[2], got undefined"). */
function describeComptimeValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  return t === "object" ? "an object" : `a ${t}`;
}

/** `comptime(() => ...)`: the callback is extracted SOURCE-TEXTUALLY,
 * executed at compile time in an isolated node:vm context (real JavaScript
 * semantics — the compiler's own Node process), and the returned value is
 * lowered as if it were a literal written at the call site. No IR nodes,
 * no backend or runtime involvement — a pure frontend desugar to
 * numLit/strLit/boolLit/arrayLit/recordLit.
 *
 * The pipeline, each step with its own rejection:
 * 1. the argument must be an INLINE arrow/function-expression literal
 *    (not a reference — there is no closure to extract from a value);
 * 2. not async/generator;
 * 3. no references to outer bindings (the callback must be self-contained
 *    — it runs in a fresh context where module state doesn't exist) and no
 *    nested comptime calls; the ambient surface (JSON, ...) is permitted
 *    by the checker, though members with no vm counterpart (console,
 *    process, fs) fail at evaluation;
 * 4. the call's checker type T must bake as a literal (number/string/
 *    boolean/arrays/records, nested);
 * 5. evaluation runs under a wall-clock budget; a throw or timeout is a
 *    SC1110 diagnostic quoting the message;
 * 6. the returned VALUE is checked against T, path-annotated
 *    (dynCheck-style) — NaN/Infinity, undefined/null/functions, and shape
 *    mismatches are rejected, never miscompiled. */
export function lowerComptime(lowerer: Lowerer, expr: ts.CallExpression): IrExpr {
  // 1. Inline function literal only (tsc guarantees the arity/type; the
  // literal-ness is our requirement — source extraction needs the source).
  let cb: ts.Expression | undefined = expr.arguments.nodes[0];
  while (cb && ts.isParenthesizedExpression(cb)) cb = cb.expression;
  if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
    lowerer.unsupported(
      "SC1090",
      expr.arguments.nodes[0] ?? expr,
      "comptime arguments other than inline function literals " +
        "(write the callback directly in the call: comptime(() => ...))",
    );
  }
  // 2. Async/generator callbacks have no bakeable result.
  if (
    (ts.isFunctionExpression(cb) && cb.asteriskToken) ||
    cb.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    lowerer.unsupported("SC1090", cb, "async or generator comptime callbacks");
  }
  // 3. Self-containment.
  lowerer.rejectComptimeCaptures(cb);
  // 4. The checker's type for the call is the bake target.
  const target = lowerer.irTypeOf(expr);
  if (!lowerer.comptimeBakeable(target)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `baking comptime results of type '${lowerer.fmt(target)}' into the binary ` +
        `(number, string, boolean, and arrays, records and unions of those lower to literals; a record or union type reachable from itself does not)`,
    );
  }
  // 5. The host executes the extracted callback under a finite budget.
  // Shared lowering stays independent of the host's execution engine;
  // capture checks and result validation apply to every evaluator.
  let result: unknown;
  try {
    if (lowerer.frontendServices === undefined)
      throw new Error("compile-time evaluation requires frontend services");
    result = lowerer.frontendServices.evaluateComptime(ts.getTextOfNode(cb), COMPTIME_TIMEOUT_MS);
  } catch (e) {
    const detail = comptimeFailureDetail(e);
    lowerer.pushDiag(comptimeFailedDiag(detail, locOf(cb)));
    throw new PoisonError();
  }
  // 6. Result → literal IR, checked against T.
  return lowerer.comptimeValueToIr(result, target, "$", cb);
}

/** VM errors may come from another realm; read their public error fields
 * structurally rather than relying on the host Error constructor. */
function comptimeFailureDetail(error: unknown): string {
  const err =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : null;
  return err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    ? `evaluation exceeded the ${COMPTIME_TIMEOUT_MS}ms compile-time budget`
    : `the callback threw: ${err && typeof err.message === "string" ? err.message : String(error)}`;
}

/** True when a comptime result of this type can be written as a literal
 * expression: number/string/boolean, arrays and record shapes of those,
 * and unions of those with null or undefined (the mixed rows of a JSON
 * table: `(string | number)[][]`), nested. Closures, class instances,
 * promises, dyn, void, and recursive types (a record or union reachable
 * from itself, directly or through arrays) cannot be baked. */
export function comptimeBakeable(lowerer: Lowerer, t: IrType): boolean {
  return bakeableWithin(lowerer, t, new Set());
}

/** comptimeBakeable below the records and unions in `open` (keyed
 * `record:<shapeId>` and `union:<unionId>`), whose members are being
 * checked: reaching one of them again means the type is recursive. */
function bakeableWithin(lowerer: Lowerer, t: IrType, open: Set<string>): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
      return true;
    case "array":
      return bakeableWithin(lowerer, t.elem, open);
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      const key = `record:${t.shapeId}`;
      if (!shape || open.has(key)) return false;
      open.add(key);
      const bakeable = shape.fields.every((f) => bakeableWithin(lowerer, f.type, open));
      open.delete(key);
      return bakeable;
    }
    case "union": {
      const arms = lowerer.unions.get(t.unionId)?.arms;
      const key = `union:${t.unionId}`;
      if (arms === undefined || open.has(key)) return false;
      open.add(key);
      const bakeable = arms.every(
        (arm) => isUnitType(arm) || (arm.kind !== "union" && bakeableWithin(lowerer, arm, open)),
      );
      open.delete(key);
      return bakeable;
    }
    default:
      return false;
  }
}

/** The tag of the arm of union `unionId` that `value` bakes into, or -1.
 * A record value whose discriminant field holds one of the union's
 * discriminant values takes that case's arm, since arms with overlapping
 * shapes can both fit it. Any other value takes the first arm it fits, in
 * the union's arm order: a JSON value fits exactly one scalar arm, and
 * array or record arms are told apart by their contents. */
function comptimeUnionArm(lowerer: Lowerer, unionId: string, value: unknown): number {
  const def = lowerer.unions.get(unionId);
  if (!def) return -1;
  const discriminant = def.discriminant;
  if (
    discriminant !== undefined &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const key = (value as Record<string, unknown>)[discriminant.field];
    const named = discriminant.cases.find((c) => c.values.some((v) => v === key));
    if (named !== undefined)
      return comptimeFits(lowerer, value, def.arms[named.tag]!) ? named.tag : -1;
  }
  return def.arms.findIndex((arm) => comptimeFits(lowerer, value, arm));
}

/** Whether `value` bakes into the bakeable type `t` without a mismatch:
 * the arm choice of a union literal. Records are exact, as in
 * comptimeValueToIr; an absent field reads as undefined. */
function comptimeFits(lowerer: Lowerer, value: unknown, t: IrType): boolean {
  switch (t.kind) {
    case "f64":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "nullT":
      return value === null;
    case "undefinedT":
      return value === undefined;
    case "array":
      return Array.isArray(value) && value.every((el) => comptimeFits(lowerer, el, t.elem));
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape) return false;
      const obj = value as Record<string, unknown>;
      const declared = new Set(shape.fields.map((f) => f.name));
      return (
        Object.keys(obj).every((key) => declared.has(key)) &&
        shape.fields.every((f) => comptimeFits(lowerer, obj[f.name], f.type))
      );
    }
    case "union":
      return comptimeUnionArm(lowerer, t.unionId, value) >= 0;
    default:
      return false;
  }
}

/** The self-containment fence: every identifier inside the callback must
 * resolve to a declaration INSIDE the callback (its own locals/functions)
 * or to the standard library (whose JS intrinsics exist in the vm; what
 * doesn't — process, setTimeout — throws a ReferenceError at evaluation).
 * Anything else — module locals, imports, top-level functions — would be a
 * capture, and the evaluation context has no module state to capture from.
 * Type-position references (annotations, `as` targets) are exempt: they
 * are erased before evaluation. Nested comptime calls are rejected up
 * front with their own message (the vm context has no `comptime`). */
export function rejectComptimeCaptures(
  lowerer: Lowerer,
  cb: ts.ArrowFunction | ts.FunctionExpression,
): void {
  const sf = ts.getSourceFileOfNode(cb);
  const inTypePosition = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p && p !== cb; p = p.parent) {
      if (ts.isTypeNode(p)) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // Property NAMES never reference outer value bindings: members of
      // ambient interfaces (arr.push) or of shapes declared in the
      // callback. Value capture happens through the receiver identifier.
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName && !inTypePosition(node)) {
        const symbol = ts.isShorthandPropertyAssignment(parent)
          ? lowerer.checker.getShorthandAssignmentValueSymbol(parent)
          : lowerer.checker.getSymbolAtLocation(node);
        const decls = symbol ? symbol.declarations : undefined;
        if (symbol && decls && decls.length > 0) {
          const ownLocal = decls.every(
            (d) => ts.getSourceFileOfNode(d) === sf && d.pos >= cb.pos && d.end <= cb.end,
          );
          if (!ownLocal) {
            if (node.text === "comptime" && lowerer.isStdlibSymbol(symbol)) {
              lowerer.unsupported(
                "SC1090",
                node,
                "comptime calls inside comptime callbacks " +
                  "(the callback already runs at compile time — compute the value directly)",
              );
            }
            // V8 installs console in vm contexts, where calls could no-op
            // at compile time instead of printing at runtime.
            // Rejected so side effects cannot vanish without a diagnostic;
            // the other Node-isms (process, setTimeout) don't exist in the
            // vm and throw a ReferenceError at evaluation.
            if (node.text === "console" && lowerer.isStdlibSymbol(symbol)) {
              lowerer.unsupported(
                "SC1090",
                node,
                "console calls inside comptime callbacks " +
                  "(the callback computes a value at compile time — return it and log at runtime)",
              );
            }
            if (!lowerer.isStdlibSymbol(symbol)) {
              lowerer.unsupported(
                "SC1090",
                node,
                `comptime callbacks referencing outer bindings ` +
                  `('${node.text}' — the callback runs at compile time in an isolated ` +
                  `context and must be self-contained)`,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(cb);
}

/** A JS value computed at compile time → literal IR of the expected type,
 * recursively. Mismatches are SC1110 with the offending path
 * (dynCheck-style: `$.items[2].price`) and both sides rendered. */
export function comptimeValueToIr(
  lowerer: Lowerer,
  value: unknown,
  expected: IrType,
  path: string,
  blame: ts.Node,
): IrExpr {
  const loc = locOf(blame);
  const fail: (got: string) => never = (got) => {
    lowerer.pushDiag(
      comptimeFailedDiag(`expected '${lowerer.fmt(expected)}' at ${path}, got ${got}`, loc),
    );
    throw new PoisonError();
  };
  switch (expected.kind) {
    case "f64": {
      if (typeof value !== "number") fail(describeComptimeValue(value));
      if (!Number.isFinite(value)) {
        fail(`${String(value)} (only finite numbers can be written as literals)`);
      }
      return { kind: "numLit", value, type: expected, loc };
    }
    case "string": {
      if (typeof value !== "string") fail(describeComptimeValue(value));
      return { kind: "strLit", value, type: expected, loc };
    }
    case "bool": {
      if (typeof value !== "boolean") fail(describeComptimeValue(value));
      return { kind: "boolLit", value, type: expected, loc };
    }
    case "array": {
      if (!Array.isArray(value)) fail(describeComptimeValue(value));
      const elems = (value as unknown[]).map((el, i) =>
        lowerer.comptimeValueToIr(el, expected.elem, `${path}[${i}]`, blame),
      );
      return { kind: "arrayLit", elems, type: expected, loc };
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(describeComptimeValue(value));
      }
      const shape = lowerer.shapes.get(expected.shapeId)!; // bakeable-checked
      const obj = value as Record<string, unknown>;
      const declared = new Set(shape.fields.map((f) => f.name));
      for (const key of Object.keys(obj)) {
        // Exact shapes, like everywhere else: comptime results get no
        // width tolerance (nothing was declared for the extra field).
        if (!declared.has(key)) fail(`an object with an unexpected field '${key}'`);
      }
      const fields = shape.fields.map((f) => ({
        name: f.name,
        value: lowerer.comptimeValueToIr(obj[f.name], f.type, `${path}.${f.name}`, blame),
      }));
      return { kind: "recordLit", fields, type: expected, loc };
    }
    case "union": {
      const arms = lowerer.unions.get(expected.unionId)!.arms; // bakeable-checked
      const tag = comptimeUnionArm(lowerer, expected.unionId, value);
      if (tag < 0) fail(describeComptimeValue(value));
      const arm = arms[tag]!;
      const payload: IrExpr = isUnitType(arm)
        ? { kind: "unitLit", unit: arm.kind === "nullT" ? "null" : "undefined", type: arm, loc }
        : lowerer.comptimeValueToIr(value, arm, path, blame);
      return {
        kind: "unionWrap",
        unionId: expected.unionId,
        tag,
        value: payload,
        type: expected,
        loc,
      };
    }
    default:
      // comptimeBakeable already fenced these off.
      throw new InternalCompilerError(`lowerer bug: unbakeable comptime target '${expected.kind}'`);
  }
}
