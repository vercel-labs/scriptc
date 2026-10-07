/** Tag dispatch for string discriminant reads on record unions.
 *
 * `r.kind` on a discriminated record union reads the field from whichever
 * arm the runtime tag selects. When that arm owns exactly one literal and no
 * program write targets the field on its shape, the tag already determines
 * the value: `r.kind === "lit"` becomes a tag test and `switch (r.kind)`
 * dispatches on the tag without loading, retaining or comparing a string.
 * Arms that share a shape across several literals, or whose field is ever
 * written, keep reading the field and comparing it in source order. */
import { InternalCompilerError } from "../../errors.js";
import { everyModuleNode } from "../../ir/traverse.js";
import type { IrExpr, IrModule, IrRecordShape, IrUnionDef } from "../../ir/ir.js";
import type { LlvmEmitterContext } from "./expr-context.js";

/** Per-tag answer for one union field: the single literal a fixed arm holds,
 * or null when the arm's field must be read. */
export type DiscriminantTags = (string | null)[];

/** Record fields written anywhere in the module, as `shape\0field`; a keyed
 * write with a computed key marks `shape\0` (every field). */
export function recordFieldWrites(mod: IrModule): Set<string> {
  const writes = new Set<string>();
  everyModuleNode(mod, {
    expr: () => true,
    type: () => true,
    stmt: (stmt) => {
      if (stmt.kind === "recordSet") writes.add(`${stmt.shapeId}\0${stmt.field}`);
      else if (stmt.kind === "recordKeySet" || stmt.kind === "recordKeyDelete")
        writes.add(
          stmt.key.kind === "strLit" ? `${stmt.shapeId}\0${stmt.key.value}` : `${stmt.shapeId}\0`,
        );
      return true;
    },
  });
  return writes;
}

/** Answers for `field` on `def`, or null when no arm can use the tag. */
export function discriminantTags(
  def: IrUnionDef,
  field: string,
  shapeOf: (id: string) => IrRecordShape,
  writes: ReadonlySet<string>,
): DiscriminantTags | null {
  if (def.discriminant?.field !== field) return null;
  const tags: DiscriminantTags = def.arms.map(() => null);
  for (const entry of def.discriminant.cases) {
    const arm = def.arms[entry.tag];
    if (arm?.kind !== "record" || entry.values.length !== 1) continue;
    const value = entry.values[0];
    if (typeof value !== "string") continue;
    const shape = shapeOf(arm.shapeId);
    const slot = shape.fields.find((entry) => entry.name === field);
    if (
      slot?.type.kind !== "string" ||
      shape.tuple ||
      shape.fields.some(
        (entry) => entry.name === `%get:${field}` || entry.name === `%set:${field}`,
      ) ||
      writes.has(`${arm.shapeId}\0${field}`) ||
      writes.has(`${arm.shapeId}\0`)
    )
      continue;
    tags[entry.tag] = value;
  }
  return tags.some((value) => value !== null) ? tags : null;
}

/** A discriminant read `r.field` compared against literal `other`. */
export function discriminantComparison(
  left: IrExpr,
  right: IrExpr,
): { read: IrExpr & { kind: "unionDisc" }; literal: string } | null {
  if (left.kind === "unionDisc" && right.kind === "strLit")
    return { read: left, literal: right.value };
  if (right.kind === "unionDisc" && left.kind === "strLit")
    return { read: right, literal: left.value };
  return null;
}

/** Borrowed string field of whichever record or class arm `union` holds,
 * through the shared field-group dispatch. The receiver keeps the payload
 * alive; nothing runs between this load and its comparisons. */
export function emitUnionStringField(
  host: LlvmEmitterContext,
  union: string,
  def: IrUnionDef,
  field: string,
): string {
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const join = B.newLabel("uds.j");
  host.unionTagSwitch(
    union,
    def,
    (arm) => {
      const payload = host.unionPeek(union);
      if (arm.kind !== "record" && arm.kind !== "object")
        throw new InternalCompilerError(`llvm emitter bug: discriminant read of ${arm.kind} arm`);
      const { ptr, type } =
        arm.kind === "object"
          ? host.classFieldPtr(payload, arm.className, field)
          : host.recordFieldPtr(payload, arm.shapeId, field);
      B.line(`store ptr ${host.loadField(ptr, type)}, ptr ${slot}`);
      B.br(join);
    },
    host.unionFieldGroups(def, field),
  );
  B.startBlock(join);
  const value = B.tmp();
  B.line(`${value} = load ptr, ptr ${slot}`);
  return value;
}

/** `r.field === literal` (or `!==`) by tag: an arm fixed to `literal`
 * answers true, other fixed arms answer false, and every other arm shares
 * one field read and comparison. Returns null when the read has no fixed
 * arm. */
export function emitDiscriminantEquality(
  host: LlvmEmitterContext,
  read: IrExpr & { kind: "unionDisc" },
  literal: string,
  negated: boolean,
): string | null {
  const def = host.unionsById.get(read.unionId);
  const tags = def ? host.discriminantTags(def, read.field) : null;
  if (!def || !tags) return null;
  const B = host.B;
  const union = host.emitReadReceiver(read.value);
  const yes = B.newLabel("ude.t"),
    no = B.newLabel("ude.f"),
    compare = B.newLabel("ude.r"),
    join = B.newLabel("ude.j");
  let reads = false;
  host.unionTagRoutes(union.name, def, (tag) => {
    const fixed = tags[tag] ?? null;
    if (fixed === null) {
      reads = true;
      return compare;
    }
    return fixed === literal ? yes : no;
  });
  const incoming = [`[ true, %${yes} ]`, `[ false, %${no} ]`];
  if (reads) {
    B.startBlock(compare);
    host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
    const value = emitUnionStringField(host, union.name, def, read.field);
    const constant = host.emitExpr({
      kind: "strLit",
      value: literal,
      type: read.type,
      loc: read.loc,
    });
    const equal = B.tmp();
    B.line(`${equal} = call zeroext i1 @scr_str_eq(ptr ${value}, ptr ${constant.name})`);
    incoming.push(`[ ${equal}, %${B.currentLabel()} ]`);
    B.br(join);
  }
  B.startBlock(yes);
  B.br(join);
  B.startBlock(no);
  B.br(join);
  B.startBlock(join);
  const equal = B.tmp();
  B.line(`${equal} = phi i1 ${incoming.join(", ")}`);
  if (!negated) return equal;
  const result = B.tmp();
  B.line(`${result} = xor i1 ${equal}, true`);
  return result;
}
