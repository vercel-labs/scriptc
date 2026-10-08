import { typeEquals, type IrType } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

/** A value may enter wider storage only through tag changes or a class
 * prefix view. Structural copies and callback adapters change identity.
 * Retagging requires one target arm unless the caller's own conversion
 * selects among several ancestor class views of the same object. */
export function identityPreservingWidening(
  lowerer: Lowerer,
  source: IrType,
  target: IrType,
  ancestorChoice = false,
): boolean {
  if (typeEquals(source, target)) return true;
  if (source.kind === "object" && target.kind === "object")
    return lowerer.isSubclassOf(source.className, target.className);
  if (source.kind === "union")
    return (
      lowerer.unions
        .get(source.unionId)
        ?.arms.every((arm) => identityPreservingWidening(lowerer, arm, target, ancestorChoice)) ??
      false
    );
  if (target.kind === "union") {
    const arms = lowerer.unions.get(target.unionId)?.arms;
    if (arms?.some((arm) => typeEquals(source, arm))) return true;
    const candidates =
      arms?.filter((arm) => identityPreservingWidening(lowerer, source, arm, ancestorChoice)) ?? [];
    return (
      candidates.length === 1 ||
      (ancestorChoice && candidates.length > 1 && candidates.every((arm) => arm.kind === "object"))
    );
  }
  return false;
}
