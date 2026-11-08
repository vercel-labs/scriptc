import type { IrRecordShape, IrType, IrUnionDef, IrUnionDiscriminant } from "../ir/ir.js";

export type UnionLiteral = string | number | boolean;

/** Only ordinary data slots have a safe literal-comparison ABI. */
export function discriminantField(shape: IrRecordShape | undefined, field: string): IrType | null {
  if (field.startsWith("%") || !shape || shape.tuple) return null;
  if (
    shape.fields.some((entry) => entry.name === `%get:${field}` || entry.name === `%set:${field}`)
  )
    return null;
  const type = shape.fields.find((entry) => entry.name === field)?.type;
  return type && (type.kind === "string" || type.kind === "f64" || type.kind === "bool")
    ? type
    : null;
}

/** Whether a field of IR type `type` stores the literal `value`. */
export function matchesLiteral(type: IrType, value: UnionLiteral): boolean {
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "bool") return typeof value === "boolean";
  return type.kind === "f64" && typeof value === "number" && Number.isFinite(value);
}

/** Validate ownership before using semantic variants to choose a payload.
 * JSON keys keep numeric, string and boolean literals distinct. */
export function discriminantOwners(
  union: IrUnionDef,
  shapeOf: (id: string) => IrRecordShape | undefined,
): Map<string, number> | null {
  const discriminant = union.discriminant;
  if (!discriminant) return null;
  const owners = new Map<string, number>();
  const tags = new Set<number>();
  for (const entry of discriminant.cases) {
    const arm = union.arms[entry.tag];
    if (!Number.isInteger(entry.tag) || !arm || arm.kind !== "record" || tags.has(entry.tag))
      return null;
    tags.add(entry.tag);
    const type = discriminantField(shapeOf(arm.shapeId), discriminant.field);
    if (!type || entry.values.length === 0) return null;
    for (const value of entry.values) {
      if (!matchesLiteral(type, value)) return null;
      const key = JSON.stringify(value);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== entry.tag) return null;
      owners.set(key, entry.tag);
    }
  }
  for (let tag = 0; tag < union.arms.length; tag++) {
    if (union.arms[tag]!.kind === "record" && !tags.has(tag)) return null;
  }
  return owners;
}

/** A known literal set selects one storage arm only when every value has
 * that same owner. The caller must still validate the payload conversion. */
export function literalUnionArm(
  union: IrUnionDef,
  values: readonly UnionLiteral[],
  shapeOf: (id: string) => IrRecordShape | undefined,
  validatedOwners?: ReadonlyMap<string, number> | null,
): (IrType & { kind: "record" }) | null {
  if (values.length === 0) return null;
  const owners =
    validatedOwners === undefined ? discriminantOwners(union, shapeOf) : validatedOwners;
  if (owners === null) return null;
  let tag: number | undefined;
  for (const value of values) {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    const next = owners.get(JSON.stringify(value));
    if (next === undefined || (tag !== undefined && next !== tag)) return null;
    tag = next;
  }
  const arm = tag === undefined ? undefined : union.arms[tag];
  return arm?.kind === "record" ? arm : null;
}

/** Preserve semantic cases through an exact arm permutation/subset.
 * Adding a unit or scalar does not affect the record discriminator. A new
 * record layout cannot inherit another record's literal ownership. */
export function remapUnionDiscriminant(
  source: IrUnionDef,
  arms: readonly IrType[],
): IrUnionDiscriminant | undefined {
  const original = source.discriminant;
  if (!original) return undefined;
  // Only record arms own discriminator cases, and their shape id is their
  // complete type identity. Index them once rather than searching the whole
  // destination for each case in large unions such as the compiler's IR.
  const recordTags = new Map<string, number>();
  for (let tag = 0; tag < arms.length; tag++) {
    const arm = arms[tag]!;
    if (arm.kind === "record" && !recordTags.has(arm.shapeId)) recordTags.set(arm.shapeId, tag);
  }
  const seen = new Set<number>();
  const covered = new Set<number>();
  const cases: IrUnionDiscriminant["cases"] = [];
  for (const entry of original.cases) {
    const arm = source.arms[entry.tag];
    if (
      !Number.isInteger(entry.tag) ||
      !arm ||
      arm.kind !== "record" ||
      seen.has(entry.tag) ||
      entry.values.length === 0
    ) {
      return undefined;
    }
    seen.add(entry.tag);
    const tag = recordTags.get(arm.shapeId);
    if (tag !== undefined) {
      covered.add(tag);
      cases.push({ tag, values: entry.values.slice() });
    }
  }
  for (let tag = 0; tag < source.arms.length; tag++) {
    if (source.arms[tag]!.kind === "record" && !seen.has(tag)) return undefined;
  }
  for (let tag = 0; tag < arms.length; tag++) {
    if (arms[tag]!.kind === "record" && !covered.has(tag)) return undefined;
  }
  if (cases.length === 0) return undefined;
  cases.sort((a, b) => a.tag - b.tag);
  return { field: original.field, cases };
}
