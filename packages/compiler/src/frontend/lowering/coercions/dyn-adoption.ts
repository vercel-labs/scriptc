import { DYN, VOID, typeKey, type IrExpr, type IrType, type SrcLoc } from "../../../ir/ir.js";
import { helperLoc, varRef } from "../../../ir/build.js";
import type { Lowerer } from "../lowerer.js";
import { keyedHelperName } from "../stable-names.js";

/** True when a type holds a record or an array somewhere (values whose
 * identity can be observed). */
export function holdsReference(lowerer: Lowerer, t: IrType, seen = new Set<string>()): boolean {
  if (t.kind === "record" || t.kind === "array") return true;
  if (t.kind !== "union" || seen.has(t.unionId)) return false;
  seen.add(t.unionId);
  return (
    lowerer.unions.get(t.unionId)?.arms.some((arm) => holdsReference(lowerer, arm, seen)) ?? false
  );
}

/** A dynamic value this expression creates, which nothing else can hold
 * (`JSON.parse(text)`, `await response.json()`, an untyped literal). */
function freshDynValue(value: IrExpr): boolean {
  if (value.kind === "dynObjLit" || value.kind === "dynArrLit") return true;
  if (value.kind === "libCall" && value.fn === "json.parse") return true;
  return (
    value.kind === "awaitExpr" &&
    value.value.kind === "libCall" &&
    value.value.fn === "fetch.responseJson"
  );
}

/** typeKey with `?` after every `(T | undefined)[]` at any depth: the
 * checked conversion to `number[]` and to `(number | undefined)[]` accept
 * different elements though the two types share a typeKey, so each needs
 * its own helper. */
function adoptionKey(t: IrType): string {
  switch (t.kind) {
    case "array":
      return `array<${adoptionKey(t.elem)}>${t.optionalElements ? "?" : ""}`;
    case "map":
      return `map<${adoptionKey(t.key)},${adoptionKey(t.value)}>`;
    case "set":
      return `set<${adoptionKey(t.elem)}>`;
    case "promise":
      return `promise<${adoptionKey(t.inner)}>`;
    default:
      return typeKey(t);
  }
}

/** The implicit checked conversion of a dynamic value into a typed slot
 * (`const row: Row = data`, an `any` argument for a typed parameter). When
 * the target holds a record or an array and the value may have another
 * holder, the conversion adopts its source as a `value as T` cast does
 * (dyn.adoptShared): every source object or array that something else still
 * references becomes a live capsule of the native value built from it, so
 * writes through either reference reach the same object, as in Node.js. The
 * check and the adoption run in one helper per target type.
 *
 * `adopt: false` keeps the plain conversion. An evolving array source uses
 * it: the conversion builds a native array of the target element type, and a
 * later write of another element type through the source would fail that
 * element check, where Node keeps one array of an unsettled element type. */
export function adoptingDynCheck(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
  loc: SrcLoc,
  adopt = true,
): IrExpr {
  if (!adopt || !holdsReference(lowerer, target) || freshDynValue(value))
    return { kind: "dynCheck", value, type: target, loc };
  const key = `dynadopt:${adoptionKey(target)}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%dyn.adopt", key);
    lowerer.coercions.retags.set(key, name);
    const at = helperLoc(loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "source.0", name: "source", type: DYN }],
      locals: [
        { id: "source.0", name: "source", type: DYN, mutable: false },
        { id: "value.0", name: "value", type: target, mutable: false },
      ],
      returnType: target,
      body: [
        {
          kind: "varDecl",
          localId: "value.0",
          init: { kind: "dynCheck", value: varRef("source.0", DYN, at), type: target, loc: at },
          loc: at,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.adoptShared",
            args: [
              varRef("source.0", DYN, at),
              {
                kind: "dynFrom",
                value: varRef("value.0", target, at),
                liveRef: true,
                type: DYN,
                loc: at,
              },
            ],
            type: VOID,
            loc: at,
          },
          loc: at,
        },
        { kind: "return", value: varRef("value.0", target, at), loc: at },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [value], type: target, loc };
}
