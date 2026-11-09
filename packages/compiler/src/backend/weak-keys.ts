import type { IrExpr, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";

/** The types whose values can be the key of a WeakMap or WeakSet entry, as
 * cycle-analysis units (`object:<class>`, `record:<shape id>`); null when
 * the program makes no such entry (IrModule.weakKeys is absent), which is
 * every program without a weak collection.
 *
 * An entry holds its value for as long as its key lives, and the value can
 * reference any object, the key included. The runtime ends an entry that
 * only its own value keeps alive by walking from the values to the keys
 * (scr_json.c, scr_weak_judge), and it can only judge a key the collector
 * walks. So a weak-key type is intrinsic in the cycle analysis, like a type
 * with a closure field: it gets the collector header, and so does every
 * type that can reach it. A type this misses is a key that is not judged:
 * its entry stays until the key dies, as before; no entry is ended early.
 * A type that has the header for this reason alone is the weak analysis's,
 * not the collector's (cycle-analysis.ts, computeCyclic).
 *
 * A key with a static type names its unit directly. A key that is a
 * checked value already (`*`: `object`, `unknown`) can be any value the
 * program converts to one, so the units are then the operand types of
 * every `dynFrom`: records and what their conversion reaches (fields,
 * container elements, union arms), and classes. Checked references that no
 * `dynFrom` makes (a field read through a capsule, the `this` of a checked
 * call, stream chunks, error views) are not found.
 *
 * An array, Map or Set carries the header exactly when its elements do
 * (the trace visits every element as a headered child), so a container of
 * numbers or strings is never judged, whatever its type says here. */
export function weakKeyUnits(mod: IrModule): ReadonlySet<string> | null {
  if (mod.weakKeys === undefined) return null;
  return collect(mod, mod.weakKeys);
}

function collect(mod: IrModule, keys: readonly string[]): ReadonlySet<string> {
  const units = new Set<string>();
  let converted = false;
  for (const key of keys) {
    if (key === "*") converted = true;
    else units.add(key);
  }
  if (!converted) return units;
  const records = new Map((mod.records ?? []).map((r) => [r.id, r] as const));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u] as const));
  const walked = new Set<string>();
  const types: IrType[] = [];
  const reach = (operand: IrType): void => {
    types.push(operand);
    while (types.length > 0) {
      const t = types.pop()!;
      switch (t.kind) {
        case "object":
          units.add(`object:${t.className}`);
          break;
        case "record": {
          const unit = `record:${t.shapeId}`;
          if (walked.has(unit)) break;
          walked.add(unit);
          units.add(unit);
          const def = records.get(t.shapeId);
          if (def === undefined) break;
          for (const field of def.fields) types.push(field.type);
          if (def.indexValue) types.push(def.indexValue);
          break;
        }
        case "union": {
          const unit = `union:${t.unionId}`;
          if (walked.has(unit)) break;
          walked.add(unit);
          for (const arm of unions.get(t.unionId)?.arms ?? []) types.push(arm);
          break;
        }
        case "array":
        case "set":
          types.push(t.elem);
          break;
        case "map":
          types.push(t.key, t.value);
          break;
      }
    }
  };
  const exprs: IrExpr[] = [];
  const stmts: IrStmt[] = [];
  const expr = (e: IrExpr): boolean => {
    exprs.push(e);
    return true;
  };
  const stmt = (s: IrStmt): boolean => {
    stmts.push(s);
    return true;
  };
  for (const fn of mod.functions) {
    for (const s of fn.body) stmts.push(s);
    while (exprs.length > 0 || stmts.length > 0) {
      const e = exprs.pop();
      if (e !== undefined) {
        if (e.kind === "dynFrom") reach(e.value.type);
        everyExprChild(e, expr, stmt);
        continue;
      }
      everyStmtChild(stmts.pop()!, expr, stmt);
    }
  }
  return units;
}
