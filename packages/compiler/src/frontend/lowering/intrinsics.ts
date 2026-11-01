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
import { INTRINSIC_IDS } from "./intrinsic-ids.generated.js";
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

/** The prototypes the runtime's own units already build and answer
 * (`scr_js_wrapper.c`, `scr_dyn_builtin_prototype.c`,
 * `scr_dyn_stdlib_prototype.c`): the frontend keeps lowering their reads
 * there, so one intrinsic never has two builders (§4.4) and the constructor
 * a program's wrapper prototype names stays the program's own closure
 * (`Boolean.prototype.constructor === Boolean`). */
const DEFERRED_PROTOTYPE_OWNERS: ReadonlySet<string> = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Date",
]);

/** The intrinsic id `X.prototype` names when `owner` is the standard
 * library's `X`, or null. */
function prototypeId(owner: string): string | null {
  if (!PROTOTYPE_OWNERS.has(owner) || DEFERRED_PROTOTYPE_OWNERS.has(owner)) return null;
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
