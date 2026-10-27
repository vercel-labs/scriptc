/* Execution tiers (two-tier design, stage S2: report-only).
 *
 * Every IR function belongs to one of two tiers:
 *
 * - static: today's compiler. Exact layouts, direct calls, unboxed values.
 *   A static function may hold dynamic (`dyn`) values, pass them to calls,
 *   return them and store them, and it may cross the boundary with the
 *   boundary operations below, but it never operates on a dynamic value.
 * - dynamic: code that operates on dynamic values with JavaScript semantics
 *   (property reads and writes, generic operators, calls of dynamic values,
 *   dynamic object and array construction).
 *
 * Invariant I1 (validate.ts): a static function contains no dynamic
 * operation. Only boundary operations and moves may mix the tiers. Calls
 * of generated `%dyn.*` helpers count as dynamic operations: they are the
 * dynamic dispatch the lowering placed out of line. Calls of other dynamic
 * functions are boundaries (the design's "call to a dynamic function").
 *
 * Boundary operations:
 * - `dynFrom` (static to dynamic, the design's `toJs`) and `caughtToDyn`;
 * - `dynCheck` (dynamic to static, the design's `fromJs`);
 * - kind tests that only inspect a dynamic value's tag (`dynTest`, the
 *   `dyn.*Is` and `dyn.typeof` builtins): the tag test of a conversion;
 * - calls of non-`dyn.*` builtins whose signatures take or return `dyn`
 *   (typed APIs implemented through dyn, leak L6 of the design). They stay
 *   boundaries until stage S1 gives them typed signatures.
 * - the jsval conversions (stage S3): `js.fromF64`, `js.fromBool`,
 *   `js.fromStr` and `js.fromBigInt` (static to jsval), `js.toF64` (jsval to number), and
 *   `js.fromDyn`/`js.toDyn`, which move a value between the two dynamic
 *   representations. Every other `js.*` builtin (the jsval operators) is a
 *   dynamic operation.
 *
 * Classification of existing code. The `dyn` vocabulary is today's
 * dynamic tier (`ScrDyn`): `any`, untyped JavaScript, unschematized
 * `JSON.parse`, and the generated dynamic dispatch helpers already lower to
 * it. Lowering therefore assigns tiers from function bodies: a function
 * containing a dynamic operation is dynamic, every other function is static
 * (`assignLegacyTiers`). Demotion (stage S6) will add tier decisions that
 * do not follow from a body; until then the classification is exact, and
 * the validator guards it against later passes and hand-written IR.
 *
 * Serialization. Since IR version 17 (stage S3) serialized IR carries
 * `tier` like any other function field. */
import type { IrExpr, IrFunction, SrcLoc } from "./ir.js";
import { everyStmtList, type IrVisitor } from "./traverse.js";

export type IrTier = "static" | "dynamic";

export function functionTier(fn: IrFunction): IrTier {
  return fn.tier === "dynamic" ? "dynamic" : "static";
}

/** `js.*` builtins that convert at the boundary instead of operating on a
 * dynamic value. */
const JS_BOUNDARY: ReadonlySet<string> = new Set([
  "js.fromDyn",
  "js.toDyn",
  "js.fromF64",
  "js.fromBool",
  "js.fromStr",
  "js.fromBigInt",
  "js.toF64",
]);

/** `dyn.*` builtins that only inspect a dynamic value's kind: the tag test
 * half of a dynamic-to-static conversion. */
const DYN_KIND_TESTS: ReadonlySet<string> = new Set([
  "dyn.typedRefIs",
  "dyn.typedRefKeyIs",
  "dyn.classIs",
  "dyn.nativeSetIs",
  "dyn.nativeMapIs",
  "dyn.nativeUrlIs",
  "dyn.nativeDateIs",
  "dyn.nativeDateHandleIs",
  "dyn.nativeRegexIs",
  "dyn.dataViewIs",
  "dyn.typeof",
]);

const DYN_HELPER_PREFIX = "%dyn.";

/** `%dyn.class.property.12` → `%dyn.class.property`. */
function dynHelperFamily(name: string): string {
  return name.replace(/(\.\d+)+$/, "");
}

/** The dynamic operation an expression performs, named for reports
 * (`dynKeyGet`, `dyn.keySet`, ...), or null for static operations, boundary
 * operations and moves. Only the node itself is inspected. */
export function dynamicOperationOf(e: IrExpr): string | null {
  switch (e.kind) {
    case "dynCall":
    case "dynInvoke":
    case "dynObjLit":
    case "dynArrLit":
    case "dynKeyGet":
    case "dynHasKey":
    case "dynScalarEq":
    case "dynDestrCheck":
    case "dynIterN":
      return e.kind;
    case "logical":
      // `a || b` over dyn operands applies ToBoolean to a dynamic value.
      return e.type.kind === "dyn" ? "logical" : null;
    case "libCall":
      if (e.fn.startsWith("js.")) return JS_BOUNDARY.has(e.fn) ? null : e.fn;
      return e.fn.startsWith("dyn.") && !DYN_KIND_TESTS.has(e.fn) ? e.fn : null;
    case "call":
      // Generated `%dyn.*` helpers are dynamic operations lowered out of
      // line (class dynamic dispatch, dynamic HOF adapters).
      return e.callee.startsWith(DYN_HELPER_PREFIX) ? dynHelperFamily(e.callee) : null;
    default:
      return null;
  }
}

export interface DynamicOperationSite {
  operation: string;
  loc: SrcLoc;
}

function collectDynamicOperations(fn: IrFunction, first: boolean): DynamicOperationSite[] {
  const found: DynamicOperationSite[] = [];
  const visitor: IrVisitor = {
    expr: (e) => {
      const operation = dynamicOperationOf(e);
      if (operation === null) return true;
      found.push({ operation, loc: e.loc });
      return !first;
    },
    stmt: () => true,
  };
  everyStmtList(fn.body, visitor);
  return found;
}

/** The first dynamic operation in a function body, in traversal order. */
export function firstDynamicOperation(fn: IrFunction): DynamicOperationSite | null {
  return collectDynamicOperations(fn, true)[0] ?? null;
}

/** Every dynamic operation in a function body (coverage reports). */
export function dynamicOperationSites(fn: IrFunction): DynamicOperationSite[] {
  return collectDynamicOperations(fn, false);
}

/** A function the classification placed in the dynamic tier, with the
 * operation that put it there. */
export interface DynamicFunction {
  name: string;
  loc: SrcLoc;
  operation: string;
  operationLoc: SrcLoc;
}

/** Assign every function its tier from its body (see the header). Returns
 * the dynamic functions in module order. */
export function assignLegacyTiers(functions: readonly IrFunction[]): DynamicFunction[] {
  const dynamic: DynamicFunction[] = [];
  for (const fn of functions) {
    const site = firstDynamicOperation(fn);
    if (site === null) continue;
    fn.tier = "dynamic";
    dynamic.push({ name: fn.name, loc: fn.loc, operation: site.operation, operationLoc: site.loc });
  }
  return dynamic;
}
