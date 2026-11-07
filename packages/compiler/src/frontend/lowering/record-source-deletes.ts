/* `delete` of a key a record's type does not declare, where another record
 * holds the key in a slot.
 *
 * `record.sourceDelete` removes the key from the operand's kept source (the
 * undeclared keys a checked conversion keeps beside a closed record,
 * record-sources.ts). That is the whole of Node's delete only when the
 * operand is the one record the object has. Two conversions give one object
 * a second record: a narrowing conversion builds a copy of a wider record
 * (record-links.ts), and a checked conversion of a boxed record answers a
 * view of it or a copy (backend record-views.ts). When the wider record's
 * type declares the key, the property lives in that record's slot, which a
 * delete through the narrower type cannot empty: it would answer `true` and
 * leave the property where every read of the wider record still finds it.
 *
 * Which record types can reach an operand that way is known once every
 * function is lowered, so the deletes are checked here, and one that could
 * meet such a record is refused by name. The test is by type, not by value:
 * it refuses a program whose records of the wider type never reach the
 * delete, and accepts none that would answer wrongly. */
import type { IrFunction, IrType, SrcLoc } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";
import { EXPOSING_LIB_CALLS } from "./record-links.js";

/** Refuses each `record.sourceDelete` whose operand's record type can hold
 * a view or a copy of a record whose type declares the deleted key. Runs
 * before the links are pruned to the observed ones (finalizeRecordLinks):
 * a copy nothing observes is a second record all the same. */
export function refuseSourceFieldDeletes(lowerer: Lowerer, functions: readonly IrFunction[]): void {
  if (lowerer.recordSourceDeletes.length === 0) return;
  // The record types a checked conversion can produce, and those whose
  // values the program boxes: a boxed record can come back through a
  // checked conversion into any type whose required properties it has.
  const checked = new Set<string>();
  const boxed = new Set<string>();
  const closure = (out: Set<string>): ((t: IrType) => void) => {
    const seen = new Set<string>();
    const visit = (t: IrType): void => {
      const key = typeKey(t);
      if (seen.has(key)) return;
      seen.add(key);
      switch (t.kind) {
        case "record": {
          out.add(t.shapeId);
          const shape = lowerer.shapes.get(t.shapeId);
          for (const field of shape?.fields ?? []) visit(field.type);
          if (shape?.indexValue !== undefined) visit(shape.indexValue);
          break;
        }
        case "array":
        case "set":
          visit(t.elem);
          break;
        case "map":
          visit(t.key);
          visit(t.value);
          break;
        case "union":
          for (const arm of lowerer.unions.get(t.unionId)?.arms ?? []) visit(arm);
          break;
        case "promise":
          visit(t.inner);
          break;
        case "func":
          // A boxed function's results are boxed for its callers, and a
          // checked one's arguments are checked for it.
          visit(t.ret);
          for (const param of t.params) visit(param);
          break;
        default:
          break;
      }
    };
    return visit;
  };
  const check = closure(checked);
  const box = closure(boxed);
  // The deletes the lowered functions hold (a speculative lowering's entry
  // in recordSourceDeletes may name a delete that was lowered again).
  const sites = new Map<string, { shapeId: string; key: string; loc: SrcLoc }>();
  for (const fn of [...functions, ...lowerer.liftedFns]) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "dynCheck") check(e.type);
        else if (e.kind === "dynFrom") box(e.value.type);
        else if (e.kind === "jsonStringify") box(e.value.type);
        else if (e.kind === "libCall") {
          if (e.fn === "record.sourceDelete") {
            const operand = e.args[0]?.type;
            const key = e.args[1];
            if (operand?.kind === "record" && key?.kind === "strLit") {
              const id = `${e.loc.file}:${e.loc.start}:${operand.shapeId}:${key.value}`;
              if (!sites.has(id))
                sites.set(id, { shapeId: operand.shapeId, key: key.value, loc: e.loc });
            }
          }
          // Library calls that box their arguments, and the stream
          // callbacks whose typed completion data reaches untyped
          // consumers as a live capsule (record-views.ts).
          if (EXPOSING_LIB_CALLS.test(e.fn) || /^(transform|passthrough)\.(new|init)$/.test(e.fn))
            for (const arg of e.args) box(arg.type);
        }
        return true;
      },
    });
  }
  if (sites.size === 0) return;
  // The record types a narrowing conversion copies into each record type.
  const copiedFrom = new Map<string, string[]>();
  for (const link of lowerer.recordLinks.values()) {
    const list = copiedFrom.get(link.to);
    if (list) list.push(link.from);
    else copiedFrom.set(link.to, [link.from]);
  }
  const declares = (shapeId: string, key: string): boolean =>
    lowerer.shapes.get(shapeId)?.fields.some((field) => field.name === key) === true;
  // Whether a property the source lacks leaves a checked conversion into
  // this field type standing (an absent or undefined slot) instead of
  // throwing its TypeError.
  const mayBeMissing = (t: IrType): boolean =>
    t.kind === "dyn" ||
    t.kind === "jsval" ||
    t.kind === "undefinedT" ||
    t.kind === "void" ||
    (t.kind === "union" &&
      (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) => arm.kind === "undefinedT"));
  // Whether a checked conversion of a boxed `from` record into the record
  // type `to` can succeed: `from` has every property `to` requires. The
  // field types are not compared, which only widens the answer.
  const converts = (from: string, to: string): boolean => {
    const source = lowerer.shapes.get(from);
    const target = lowerer.shapes.get(to);
    if (!source || !target) return true;
    const names = new Set(source.fields.map((field) => field.name));
    return target.fields.every((field) => names.has(field.name) || mayBeMissing(field.type));
  };
  for (const site of sites.values()) {
    // Every record type whose value the operand can be a view or a copy of,
    // through any chain of the two conversions.
    const reached = new Set([site.shapeId]);
    const queue: { shapeId: string; how: "copy" | "checked" }[] = [];
    const reach = (shapeId: string, how: "copy" | "checked"): void => {
      if (reached.has(shapeId)) return;
      reached.add(shapeId);
      queue.push({ shapeId, how });
    };
    const expand = (shapeId: string): void => {
      for (const from of copiedFrom.get(shapeId) ?? []) reach(from, "copy");
      if (!checked.has(shapeId)) return;
      for (const from of boxed) if (converts(from, shapeId)) reach(from, "checked");
    };
    expand(site.shapeId);
    let found: { shapeId: string; how: "copy" | "checked" } | undefined;
    for (let i = 0; i < queue.length && found === undefined; i++) {
      const next = queue[i]!;
      if (declares(next.shapeId, site.key)) found = next;
      else expand(next.shapeId);
    }
    if (found === undefined) continue;
    const operandT = lowerer.fmt({ kind: "record", shapeId: site.shapeId });
    const sourceT = lowerer.fmt({ kind: "record", shapeId: found.shapeId });
    const reason =
      found.how === "copy"
        ? `a '${sourceT}' converted to a narrower record type is copied`
        : `a '${sourceT}' the program passes as an untyped value can be converted back to a narrower record type`;
    lowerer.pushDiag(
      unsupportedDiag(
        "SC1090",
        site.loc,
        `'delete' of '${site.key}': the operand's type '${operandT}' does not declare '${site.key}', but '${sourceT}' declares it (${reason}, and the delete cannot remove that record's '${site.key}' field through the narrower type; Node deletes the property from the one object)`,
        `delete '${site.key}' through the value's own type, '${sourceT}', with the field declared optional there`,
      ),
    );
  }
}
