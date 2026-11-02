/* Builtin intrinsics read as ordinary checked objects (t262-da A1).
 *
 * A JavaScript source reads `Date.prototype`, `Number.prototype` or
 * `Array.prototype.push` as the objects the language defines: the ones that
 * exist before the program runs, whose members are the runtime's interned
 * functions. The runtime builds them from a table of the pinned Node
 * release (scr_js_intrinsics.c), one object per intrinsic, with the
 * singletons the runtime already keeps — Object.prototype, Array.prototype,
 * Error.prototype — filled in place rather than replaced.
 *
 * This module decides when a program reads one of those objects and lowers
 * the read to `dyn.intrinsic` with the table's id. The fact is
 * program-wide: a program that reads any intrinsic read all of them from
 * the same graph, so `Number.prototype === Object.getPrototypeOf(0)`-style
 * identity tests agree. Until a program reads one, every existing lowering
 * (dyn.builtinPrototype, dyn.stdlibPrototype, dyn.arrayPrototype, ...) is
 * byte-for-byte what it was, and typed programs never reach here at all. */
import * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { INTRINSIC_IDS, INTRINSIC_PROTOTYPE_MEMBERS } from "./intrinsic-ids.generated.js";
import { isJsSourceFile, locOf } from "../program.js";
import { stdlibGlobalNameOf } from "./surfaces.js";
import type { Lowerer } from "./lowerer.js";

/** The standard library globals whose prototype the intrinsic table names
 * (`Date.prototype`, `Object.prototype`, ...), derived from the table so the
 * list cannot drift from it. */
const PROTOTYPE_OWNERS: ReadonlySet<string> = new Set(
  [...INTRINSIC_IDS]
    .filter((id) => id.endsWith(".prototype") && id[0] !== "%")
    .map((id) => id.slice(0, -".prototype".length)),
);

/** The primitive wrapper prototypes the intrinsic table builds (t262-da A2).
 * @types/node declares `X.prototype` with the wrapper interface
 * (`Number.prototype: Number`), so the checker types the object as a
 * primitive. A dynamic read of it must not extract a scalar from it, or
 * `Number.prototype.added = 7` would lower its receiver as the checked cast
 * to a number and throw (isPrimitivePrototypeValue in narrowing.ts). Date
 * needs no such guard: its checker type is an object. */
const WRAPPER_PROTOTYPE_OWNERS: ReadonlySet<string> = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
]);

/** The prototypes whose builtin members a compiled call site reaches
 * natively: `n.toFixed(2)` and `d.getTime()` call the runtime function, not
 * the table object, so a write that replaced one of those members would be
 * silently ignored rather than observed. The frontend refuses such a write by
 * name (fenceIntrinsicPrototypeWrite in property-access.ts). */
const FENCED_PROTOTYPE_OWNERS: ReadonlySet<string> = new Set([...WRAPPER_PROTOTYPE_OWNERS, "Date"]);

/** The primitive constructors whose source value is the compiler's interned
 * conversion closure rather than the graph's constructor object, so
 * `X.prototype.constructor` answers that closure and the identity Node
 * defines (`Boolean.prototype.constructor === Boolean`) holds. */
const PRIMITIVE_CONSTRUCTOR_OWNERS: ReadonlySet<string> = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
]);

/** Whether `owner`'s prototype is one the write fence covers. */
export function isFencedPrototypeOwner(owner: string): boolean {
  return FENCED_PROTOTYPE_OWNERS.has(owner);
}

/** Whether `id` names a wrapper prototype object (`Number.prototype`): the
 * intrinsic value the checker types as the wrapper's primitive. */
export function isWrapperPrototypeId(id: string): boolean {
  return (
    id.endsWith(".prototype") && WRAPPER_PROTOTYPE_OWNERS.has(id.slice(0, -".prototype".length))
  );
}

/** Whether `key` names a member the table gives `owner.prototype`: the
 * members a compiled call site calls natively. */
export function isPrototypeMember(owner: string, key: string): boolean {
  return INTRINSIC_PROTOTYPE_MEMBERS.get(`${owner}.prototype`)?.has(key) ?? false;
}

/** Whether `owner` is a primitive constructor whose `.prototype.constructor`
 * is the program's own conversion closure. */
export function isPrimitiveConstructorOwner(owner: string): boolean {
  return PRIMITIVE_CONSTRUCTOR_OWNERS.has(owner);
}

/** The intrinsic id `X.prototype` names when `owner` is the standard
 * library's `X`, or null. */
function prototypeId(owner: string): string | null {
  if (!PROTOTYPE_OWNERS.has(owner)) return null;
  const id = `${owner}.prototype`;
  return INTRINSIC_IDS.has(id) ? id : null;
}

/** Whether any compiled JavaScript source reads a builtin intrinsic: `X
 * .prototype` of a standard library global the table names, a
 * `getPrototypeOf` call (Object or Reflect), an `isPrototypeOf` member, or a
 * `__proto__` read. Computed once per program. */
export function programUsesIntrinsicObjects(lowerer: Lowerer): boolean {
  if (lowerer.usesIntrinsicObjects !== undefined) return lowerer.usesIntrinsicObjects;
  let found = false;
  for (const sourceFile of lowerer.program.getSourceFiles()) {
    if (found) break;
    if (sourceFile.isDeclarationFile || !isJsSourceFile(sourceFile)) continue;
    const text = sourceFile.text;
    // The names that can start one of these reads; a file with none of them
    // cannot hold one.
    if (
      !text.includes("prototype") &&
      !text.includes("getPrototypeOf") &&
      !text.includes("__proto__")
    )
      continue;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (name === "prototype") {
          const owner = stdlibGlobalNameOf(lowerer, node.expression);
          if (owner !== null && prototypeId(owner) !== null) {
            found = true;
            return;
          }
        } else if (name === "__proto__" || name === "isPrototypeOf") {
          found = true;
          return;
        } else if (name === "getPrototypeOf") {
          const owner = stdlibGlobalNameOf(lowerer, node.expression);
          if (owner === "Object" || owner === "Reflect") {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  lowerer.usesIntrinsicObjects = found;
  return found;
}

function intrinsicCall(id: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "dyn.intrinsic",
    args: [{ kind: "strLit", value: id, type: STRING, loc }],
    type: DYN,
    loc,
  };
}

/** `X.prototype` and the members read through it (`X.prototype.push`) in a
 * JavaScript source, when the intrinsic table names `X.prototype`: the one
 * checked object the runtime's intrinsic graph holds. Null for every other
 * property access, so the existing lowerings still answer them. */
export function lowerIntrinsicMember(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  if (!programUsesIntrinsicObjects(lowerer)) return null;
  const loc = locOf(expr);
  // `X.prototype`.
  const owner = stdlibGlobalNameOf(lowerer, expr.expression);
  if (owner !== null && lowerer.stdlibGlobalMember(expr, owner) === "prototype") {
    const id = prototypeId(owner);
    return id === null ? null : intrinsicCall(id, loc);
  }
  // `X.prototype.member`: a member of the prototype object, read through
  // the same object so `Date.prototype.getTime` is the function a Date
  // value answers (`dynKeyGet` on the intrinsic).
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner)) return null;
  const innerOwner = stdlibGlobalNameOf(lowerer, inner.expression);
  if (innerOwner === null || lowerer.stdlibGlobalMember(inner, innerOwner) !== "prototype")
    return null;
  const id = prototypeId(innerOwner);
  if (id === null) return null;
  // `Function.prototype.apply` keeps `dyn.functionApply`, the runtime's
  // singleton that `f.apply` also answers; the table's Function.prototype
  // holds the same function, so both reads agree.
  if (innerOwner === "Function" && expr.name.text === "apply") return null;
  return {
    kind: "dynKeyGet",
    value: intrinsicCall(id, locOf(inner)),
    key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
    type: DYN,
    loc,
  };
}

/** `X.prototype[k]` in a JavaScript source: a keyed read of the same
 * intrinsic object, so `RegExp.prototype[Symbol.replace]` is the function a
 * RegExp answers for that key. Null for every other element access. */
export function lowerIntrinsicElement(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  if (!programUsesIntrinsicObjects(lowerer)) return null;
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner)) return null;
  const owner = stdlibGlobalNameOf(lowerer, inner.expression);
  if (owner === null || lowerer.stdlibGlobalMember(inner, owner) !== "prototype") return null;
  const id = prototypeId(owner);
  if (id === null) return null;
  return {
    kind: "dynKeyGet",
    value: intrinsicCall(id, locOf(inner)),
    key: lowerer.lowerExprExpecting(expr.argumentExpression, DYN),
    type: DYN,
    loc: locOf(expr),
  };
}
