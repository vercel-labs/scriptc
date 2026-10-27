/* Narrowings that refine record arms without naming a stored arm. */
import type { Lowerer } from "../lowerer.js";
import { type IrExpr, type IrType, type SrcLoc, typeEquals } from "../../../ir/ir.js";

/** A checker narrowing can refine the arms of a union of records with an
 * intersection: a predicate `r is Route & { path: string }`, or the
 * `"path" in r` narrowing, which intersects arms that do not declare the
 * name with `Record<"path", unknown>`. Each narrowed arm then maps to a
 * new record shape that is not an arm of the stored union, although the
 * value never changed layout. A stored record arm HOSTS a narrowed record
 * when both name the same members, each narrowed member refined to a
 * subset of the stored slot type (or to `unknown`); a member an assertion
 * attached to the stored shape (assertion-members.ts) may be missing from
 * the narrowed one. A required member the stored arm does not declare
 * cannot exist on its values: native records are closed, so `in` already
 * answers false there and the narrowed arm is uninhabited.
 *
 * Only unions of two or more record arms without a literal discriminant
 * qualify: discriminated unions narrow by their discriminant, and a
 * record with unit arms keeps its own predicate-strengthening reads.
 *
 * Returns the stored arms that can hold a value of the narrowed type, or
 * null when the union does not qualify, when some narrowed arm is neither
 * a stored arm nor a record, or when no stored arm is excluded (there is
 * nothing to narrow). */
export function hostedArmTags(
  lowerer: Lowerer,
  fromId: string,
  narrowed: IrType,
): Set<number> | null {
  const from = lowerer.unions.get(fromId);
  if (!from || !recordUnion(lowerer, fromId)) return null;
  const narrowedArms =
    narrowed.kind === "union" ? lowerer.unions.get(narrowed.unionId)?.arms : [narrowed];
  if (!narrowedArms || narrowedArms.length === 0) return null;
  const allowed = new Set<number>();
  let refined = false;
  for (const arm of narrowedArms) {
    const direct = lowerer.armTag(fromId, arm);
    if (direct >= 0) {
      allowed.add(direct);
      continue;
    }
    if (arm.kind !== "record") return null;
    refined = true;
    from.arms.forEach((stored, tag) => {
      if (stored.kind === "record" && recordHosts(lowerer, stored.shapeId, arm.shapeId)) {
        allowed.add(tag);
      }
    });
  }
  if (!refined || allowed.size === 0 || allowed.size === from.arms.length) return null;
  return allowed;
}

/** A union of at least two record arms without a literal discriminant. */
function recordUnion(lowerer: Lowerer, unionId: string): boolean {
  const def = lowerer.unions.get(unionId);
  if (!def || def.discriminant) return false;
  return def.arms.filter((arm) => arm.kind === "record").length >= 2;
}

/** Whether every value of `narrowed` (a checker refinement of a value
 * stored as `storage`) lives in the stored layout: each narrowed arm is a
 * stored arm or a record a stored record arm hosts (see hostedArmTags),
 * and at least one needs the hosting. A union storage must qualify as in
 * hostedArmTags; a single record only when an assertion attached members
 * to it. A binding initialized by such an assertion keeps the stored type,
 * so its member writes reach the asserted object. */
export function hostsAll(lowerer: Lowerer, storage: IrType, narrowed: IrType): boolean {
  if (typeEquals(storage, narrowed)) return false;
  let storedArms: readonly IrType[];
  if (storage.kind === "union") {
    if (!recordUnion(lowerer, storage.unionId)) return false;
    storedArms = lowerer.unions.get(storage.unionId)!.arms;
  } else if (storage.kind === "record" && lowerer.shapes.attachedNames(storage.shapeId).length) {
    storedArms = [storage];
  } else {
    return false;
  }
  const narrowedArms =
    narrowed.kind === "union" ? lowerer.unions.get(narrowed.unionId)?.arms : [narrowed];
  if (!narrowedArms || narrowedArms.length === 0) return false;
  let refined = false;
  for (const arm of narrowedArms) {
    if (storedArms.some((stored) => typeEquals(stored, arm))) continue;
    if (arm.kind !== "record") return false;
    const hosted = storedArms.some(
      (stored) => stored.kind === "record" && recordHosts(lowerer, stored.shapeId, arm.shapeId),
    );
    if (!hosted) return false;
    refined = true;
  }
  return refined;
}

function recordHosts(lowerer: Lowerer, storedId: string, narrowedId: string): boolean {
  const stored = lowerer.shapes.get(storedId);
  const narrowed = lowerer.shapes.get(narrowedId);
  if (!stored || !narrowed || stored.tuple || narrowed.tuple) return false;
  if (stored.indexValue || narrowed.indexValue) return false;
  const attached = lowerer.shapes.attachedNames(storedId);
  for (const sf of stored.fields) {
    if (!narrowed.fields.some((nf) => nf.name === sf.name) && !attached.includes(sf.name))
      return false;
  }
  for (const nf of narrowed.fields) {
    const sf = stored.fields.find((f) => f.name === nf.name);
    if (!sf || !slotRefines(lowerer, nf.type, sf.type)) return false;
  }
  return true;
}

/** Whether a stored slot of type `stored` can be read as `narrowed`: the
 * same type, `unknown`, or a subset of the stored union's arms (a read
 * site narrows from the stored slot exactly as it does for a predicate
 * strengthening one record). */
function slotRefines(lowerer: Lowerer, narrowed: IrType, stored: IrType): boolean {
  if (typeEquals(narrowed, stored) || narrowed.kind === "dyn") return true;
  if (stored.kind !== "union") return false;
  if (narrowed.kind !== "union") return lowerer.armTag(stored.unionId, narrowed) >= 0;
  const arms = lowerer.unions.get(narrowed.unionId)?.arms;
  return !!arms && arms.every((arm) => lowerer.armTag(stored.unionId, arm) >= 0);
}

/** The stored view of a hosted narrowing (see hostedArmTags): one stored
 * record arm extracted with the checked helper, or the sub-union of the
 * hosting arms re-tagged with the excluded arms as traps. Both keep the
 * value's stored layout, so member reads and writes reach the same
 * object. Null when the narrowing is not a hosted one. */
export function hostedStorageView(
  lowerer: Lowerer,
  value: IrExpr,
  narrowed: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const fromId = value.type.unionId;
  const allowed = hostedArmTags(lowerer, fromId, narrowed);
  if (!allowed) return null;
  const from = lowerer.unions.get(fromId)!;
  if (allowed.size === 1) {
    const arm = from.arms[[...allowed][0]!]!;
    const helper = lowerer.narrowedArmHelper(fromId, arm, loc);
    return helper ? lowerer.checkedNarrowCall(helper, value, arm, loc) : null;
  }
  const arms = from.arms.filter((_, tag) => allowed.has(tag));
  const subId = lowerer.unions.transform(from, arms);
  const trappable = new Set<number>();
  from.arms.forEach((_, tag) => {
    if (!allowed.has(tag)) trappable.add(tag);
  });
  const helper = lowerer.unionRetagHelper(fromId, subId, loc, trappable);
  if (!helper) return null;
  const type: IrType = { kind: "union", unionId: subId };
  return { kind: "call", callee: helper, args: [value], type, loc };
}
