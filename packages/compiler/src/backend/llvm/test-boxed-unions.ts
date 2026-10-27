import { F64, type IrModule, type IrType, type IrUnionDef } from "../../ir/ir.js";

/** Test helper: a Set of each union keeps it a tagged `%ScrUnion` box (Set
 * elements are runtime-inspected boxes), so stack-box tests exercise the
 * paths that nullable-pointer unions (nullable-unions.ts) bypass. A union of
 * records alone is a Set element by record identity, so for those the Set
 * holds a companion union with a number arm, which keeps the records out of
 * every shape union. */
export function keepUnionsBoxed(mod: IrModule): IrModule {
  const companions: IrUnionDef[] = [];
  const keep = (mod.unions ?? []).map((union) => {
    let elem = union.id;
    if (union.arms.every((arm) => arm.kind === "record")) {
      elem = `%keep.${union.id}`;
      companions.push({ id: elem, arms: [...union.arms, F64] });
    }
    return {
      id: `%g.keep.${union.id}`,
      name: `keep_${union.id}`,
      type: { kind: "set", elem: { kind: "union", unionId: elem } } as IrType,
      mutable: false,
    };
  });
  return {
    ...mod,
    unions: [...(mod.unions ?? []), ...companions],
    globals: [...(mod.globals ?? []), ...keep],
  };
}
