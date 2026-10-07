/** Boxed bindings that are never written after initialization.
 *
 * A captured binding lives in a box shared by its declaring function and
 * every closure that captures it, each naming it with its own local id. When
 * no member of that group is ever assigned, the box holds one value for its
 * whole life: the declaring frame or the running closure's environment keeps
 * the box alive, so a use can borrow the value instead of retaining it.
 * Bindings captured by classes, or rebound by loops and catch clauses, keep
 * their owning reads. */
import { everyStmtList } from "../../ir/traverse.js";
import type { IrModule } from "../../ir/ir.js";

const key = (fn: string, local: string) => `${fn}\0${local}`;

export function immutableBoxes(mod: IrModule): Set<string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  const join = (a: string, b: string) => {
    const left = find(a),
      right = find(b);
    if (left !== right) parent.set(left, right);
  };
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const written = new Set<string>();
  const boxed: string[] = [];
  for (const fn of mod.functions) {
    for (const local of fn.locals) if (local.boxed) boxed.push(key(fn.name, local.id));
    const write = (local: string): void => {
      written.add(key(fn.name, local));
    };
    for (const capture of fn.classCaptures ?? []) write(capture.localId);
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        if (stmt.kind === "assign" || stmt.kind === "forOf") write(stmt.localId);
        else if (stmt.kind === "tryCatch" && stmt.catchLocalId !== null) write(stmt.catchLocalId);
        return true;
      },
      expr: (expr) => {
        if (expr.kind === "incDec" || expr.kind === "assignExpr") write(expr.localId);
        else if (expr.kind === "classRef") for (const id of expr.captures ?? []) write(id);
        else if (expr.kind === "closure") {
          const target = functions.get(expr.fnName);
          expr.captures.forEach((id, index) => {
            const capture = target?.captures?.[index];
            if (capture) join(key(fn.name, id), key(expr.fnName, capture.localId));
            else write(id);
          });
        }
        return true;
      },
    });
  }
  const writtenGroups = new Set([...written].map(find));
  return new Set(boxed.filter((id) => !writtenGroups.has(find(id))));
}
