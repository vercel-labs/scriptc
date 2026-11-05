import type { IrModule } from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";
import type { LlvmTargetOptions } from "./emitter.js";

/** Test helper: emission options that keep every union of `mod` a tagged
 * `%ScrUnion` box, so stack-box tests exercise the paths that
 * nullable-pointer unions (nullable-unions.ts) bypass. */
export function keepUnionsBoxed(mod: IrModule): LlvmTargetOptions {
  return { boxedUnions: new Set((mod.unions ?? []).map((union) => union.id)) };
}

/** Test helper: emission options that keep each union the Sets of `mod`
 * hold a tagged box. Source tests of the stack-box paths declare a
 * `Set<T | undefined>` of the union they exercise. */
export function keepSetElementsBoxed(mod: IrModule): LlvmTargetOptions {
  const boxedUnions = new Set<string>();
  everyModuleNode(mod, {
    expr: () => true,
    stmt: () => true,
    type: (type) => {
      if (type.kind === "set" && type.elem.kind === "union") boxedUnions.add(type.elem.unionId);
      return true;
    },
  });
  return { boxedUnions };
}
