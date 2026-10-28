import {
  isUnitType,
  type IrClassDef,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";
import type { IrNodeIndex } from "../../ir/node-index.js";

/** A union of exactly one reference arm and one or two unit arms
 * (`C | undefined`, `C | null`, `C | null | undefined`) whose VALUES are
 * the reference pointer itself: NULL is the unit arm (`undefined` when both
 * unit arms exist, where the module's immortal NULLABLE_NULL sentinel is
 * `null`), anything else is the reference arm's instance. No union box
 * ever exists for such a type: wraps move the payload, narrowing borrows
 * it, retain/release/trace are the arm's NULL-tolerant entry points, and
 * every container, field, capture, parameter, and return slot holds the
 * plain pointer. Every other union keeps the tagged `%ScrUnion` box. */
export interface NullableUnion {
  repr: "single";
  unionId: string;
  refTag: number;
  /** The unit arm NULL encodes. */
  unitTag: number;
  /** The `null` arm of a two-unit-arm union, encoded by NULLABLE_NULL;
   * -1 when the union has one unit arm. */
  nullTag: number;
  /** One of NullableRefArm. Typed as the plain IrType so the self-hosted
   * frontend keeps IrType's structurally identical arms one record shape
   * (a PointerUnion arm holding the narrowed intersection would split them). */
  arm: IrType;
}

/** A union of two or more record arms and at most two unit arms (`A | B`,
 * `A | B | undefined`, discriminated unions of object literals) whose
 * VALUES are the record pointer itself, like a NullableUnion: NULL is the
 * unit arm (`undefined` when both exist, NULLABLE_NULL is then `null`).
 * Every record shape that is an arm of such a union is a TAGGED shape: its
 * struct carries the shape's module-wide number in a hidden `i32` word
 * right after the reference count (struct index 1), stored by every
 * allocation, so the arm of a pointer is that word mapped through the
 * union's arm table (the per-union `@sc_stag.<id>` helper). Records share
 * one retain; release and trace dispatch on the arm. */
export interface ShapeUnion {
  repr: "shapes";
  unionId: string;
  /** The unit arm NULL encodes; -1 when the union has no unit arm. */
  unitTag: number;
  /** The `null` arm of a two-unit-arm union, encoded by NULLABLE_NULL;
   * -1 otherwise. */
  nullTag: number;
  /** The record arms in tag order. */
  arms: readonly { tag: number; shapeId: string }[];
}

/** A union of two or more class arms and at most two unit arms (`A | B`,
 * `A | B | undefined`, sum types over classes) whose VALUES are the
 * instance pointer itself, like a ShapeUnion: NULL is the unit arm
 * (`undefined` when both exist, NULLABLE_NULL is then `null`). No arm is
 * an ancestor of another, so the arm of an instance is the arm whose
 * preorder interval holds its class id: every instance of an arm's
 * hierarchy keeps its class id in its header (classes.ts LlClassMeta.idInRc
 * and compactHeaderWord), which standalone arm classes do only because they
 * are arms (taggedClasses). The arms are all compact classes or all keep
 * the rc word, so one load reads the id of any value (the per-union
 * `@sc_ctag.<id>` helper). */
export interface ClassUnion {
  repr: "classes";
  unionId: string;
  /** The unit arm NULL encodes; -1 when the union has no unit arm. */
  unitTag: number;
  /** The `null` arm of a two-unit-arm union, encoded by NULLABLE_NULL;
   * -1 otherwise. */
  nullTag: number;
  /** The class arms in tag order. */
  arms: readonly { tag: number; className: string }[];
}

/** A union whose values are plain pointers (no `%ScrUnion` box). */
export type PointerUnion = NullableUnion | ShapeUnion | ClassUnion;

/** The struct index of a tagged record shape's hidden shape-number word. */
export const SHAPE_WORD_INDEX = 1;

/** The LLVM type through which any tagged record's shape word is read
 * (the reference count, then the word). */
export function shapeWordHeader(sizeType: "i32" | "i64"): string {
  return `{ ${sizeType}, i32 }`;
}

/** The per-union helper mapping a shape-union value to its tag. */
export function shapeTagFn(unionId: string): string {
  return `@sc_stag.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}

/** The per-union release and trace dispatchers of a shape union. */
export function shapeReleaseFn(unionId: string): string {
  return `@sc_srelease.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}
export function shapeTraceFn(unionId: string): string {
  return `@sc_strace.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}

/** The per-union helper mapping a class-union value to its tag. */
export function classTagFn(unionId: string): string {
  return `@sc_ctag.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}

/** The per-union retain, release and trace entry points of a class union. */
export function classRetainFn(unionId: string): string {
  return `@sc_cretain.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}
export function classReleaseFn(unionId: string): string {
  return `@sc_crelease.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}
export function classTraceFn(unionId: string): string {
  return `@sc_ctrace.${unionId.replace(/[^A-Za-z0-9_.]/g, "_")}`;
}

/** The helper mapping a shape- or class-union value to its tag. */
export function pointerTagFn(union: ShapeUnion | ClassUnion): string {
  return union.repr === "shapes" ? shapeTagFn(union.unionId) : classTagFn(union.unionId);
}

/** The module-scope immortal sentinel standing for `null` in a
 * `C | null | undefined` union (NULL is `undefined` there). */
export const NULLABLE_NULL = "@sc_nullable_null";

/** The module-scope immortal sentinel standing for the ABSENT state of a
 * nullable union's record field slot (an omitted optional property). */
export const NULLABLE_ABSENT = "@sc_nullable_absent";

/** The reference arms whose instances are never NULL. Class and record
 * entry points all tolerate NULL; strings, Stats snapshots, arrays, typed
 * arrays, maps and sets retain through a NULL-skipping wrapper (shapes.ts),
 * as do closures (function arms). Object arms are always truthy and compare
 * by identity (function arms by identity root); string arms are truthy when
 * non-empty and compare bytes. */
export type NullableRefArm =
  | { kind: "object"; className: string }
  | { kind: "record"; shapeId: string }
  | { kind: "string" }
  | { kind: "stats" }
  | (IrType & { kind: "array" | "bytes" | "map" | "set" | "func" });

/** The arm is a JS object: always truthy. */
export function isObjectArm(nullable: PointerUnion): boolean {
  return nullable.repr !== "single" || nullable.arm.kind !== "string";
}

/** The arm compares by pointer identity. Function arms compare identity
 * roots instead: a signature adapter is the function it adapts. */
export function isPointerIdentityArm(nullable: PointerUnion): boolean {
  return (
    nullable.repr !== "single" || (nullable.arm.kind !== "string" && nullable.arm.kind !== "func")
  );
}

/** The arm `tag` of a pointer union holds a reference: the value is that
 * payload itself (not a unit encoding). */
export function isPayloadTag(nullable: PointerUnion, tag: number): boolean {
  if (nullable.repr === "single") return tag === nullable.refTag;
  if (nullable.repr === "shapes") return nullable.arms.some((arm) => arm.tag === tag);
  return nullable.arms.some((arm) => arm.tag === tag);
}

/** The representation decision for every union of one module. It is a
 * pure function of the module, so serialized-IR and in-memory emission
 * agree. */
export class NullableUnions {
  private readonly byId = new Map<string, PointerUnion>();
  /** Tagged record shapes (arms of a shape union) by their module-wide
   * shape number (2 and up: 0 and 1 are the unit encodings' pseudo
   * numbers, never stored). */
  private readonly shapeNumbers = new Map<string, number>();
  /** NULL-skipping retain wrappers requested so far: symbol → inner retain
   * call target. The emitter defines each once. */
  readonly retainWrappers = new Map<string, string>();
  /** Some nullable union encodes `null` with NULLABLE_NULL. */
  readonly usesNullSentinel: boolean = false;
  /** The shape union whose release and trace helpers each shape union
   * uses: the first one over the same record arms; likewise for class
   * unions over the same classes. */
  private readonly helperOwners = new Map<string, string>();
  /** The standalone classes that are arms of a class union, which keep
   * their class id in their header only for that (taggedClasses). */
  private readonly tagged = new Set<string>();

  /** `shapes`: allow shape and class unions (debug builds keep boxes,
   * whose debug-info layouts describe every arm). `classIds`: the target
   * keeps class ids in instance headers (64-bit targets), which class
   * unions read their arm from. */
  constructor(mod: IrModule, shapes = true, nodes?: IrNodeIndex, classIds = true) {
    const emitted = new Set<string>();
    for (const cls of mod.classes ?? []) if (!cls.runtime) emitted.add(cls.name);
    const records = new Set<string>();
    for (const shape of mod.records ?? []) records.add(shape.id);
    const boxed = boxedUnionIds(mod, nodes);
    // Shape unions stay out of library builds (their host ABI marshals
    // boxes) and of programs with lifetime regions (whose walks report a
    // reference slot by its type's release entry point).
    const allowShapes = shapes && mod.lib === undefined && mod.lifetimeRegions !== true;
    const classes = allowShapes && classIds ? new ClassForest(mod) : null;
    // A record that is an arm of a boxed union never becomes a shape
    // union's arm: conversions between unions over the same records then
    // keep one representation.
    const boxedRecords = new Set<string>();
    for (const def of mod.unions ?? [])
      if (boxed.has(def.id))
        for (const arm of def.arms) if (arm.kind === "record") boxedRecords.add(arm.shapeId);
    for (const def of mod.unions ?? []) {
      if (boxed.has(def.id)) continue;
      const nullable =
        nullableShape(def, emitted, records) ??
        (allowShapes ? shapeUnion(def, records, boxedRecords) : null) ??
        (classes !== null ? classUnion(def, classes) : null);
      if (!nullable) continue;
      this.byId.set(def.id, nullable);
      if (nullable.nullTag >= 0) this.usesNullSentinel = true;
      if (nullable.repr === "shapes")
        for (const arm of nullable.arms)
          if (!this.shapeNumbers.has(arm.shapeId))
            this.shapeNumbers.set(arm.shapeId, this.shapeNumbers.size + 2);
      if (nullable.repr === "classes")
        for (const arm of nullable.arms)
          if (classes!.standalone(arm.className)) this.tagged.add(arm.className);
    }
    // Release and trace dispatch on the shape word, which names a record
    // shape module-wide, so unions over the same records share them; class
    // unions dispatch on the class id, so the same holds for their arms.
    const owners = new Map<string, string>();
    for (const nullable of this.byId.values()) {
      if (nullable.repr === "single") continue;
      const names =
        nullable.repr === "shapes"
          ? nullable.arms.map((arm) => arm.shapeId)
          : nullable.arms.map((arm) => arm.className);
      const key = `${nullable.repr}:${names.sort().join(" ")}`;
      const owner = owners.get(key) ?? nullable.unionId;
      owners.set(key, owner);
      this.helperOwners.set(nullable.unionId, owner);
    }
  }

  /** Standalone classes (no base, no subclass) that are arms of a class
   * union: their instances keep their class id in their header like
   * hierarchy members do (classes.ts buildClassGraph). */
  taggedClasses(): ReadonlySet<string> {
    return this.tagged;
  }

  /** The shape union whose release and trace helpers this one uses. */
  helperOwner(unionId: string): string {
    return this.helperOwners.get(unionId) ?? unionId;
  }

  get(unionId: string): PointerUnion | null {
    return this.byId.get(unionId) ?? null;
  }

  of(type: IrType): PointerUnion | null {
    return type.kind === "union" ? this.get(type.unionId) : null;
  }

  /** The single-reference-arm form only (shape unions answer null). */
  single(unionId: string): NullableUnion | null {
    const nullable = this.byId.get(unionId);
    return nullable?.repr === "single" ? nullable : null;
  }

  /** The shape-union form only. */
  shapes(unionId: string): ShapeUnion | null {
    const nullable = this.byId.get(unionId);
    return nullable?.repr === "shapes" ? nullable : null;
  }

  /** The class-union form only. */
  classes(unionId: string): ClassUnion | null {
    const nullable = this.byId.get(unionId);
    return nullable?.repr === "classes" ? nullable : null;
  }

  /** Every shape union, in module order. */
  allShapeUnions(): ShapeUnion[] {
    const out: ShapeUnion[] = [];
    for (const nullable of this.byId.values()) if (nullable.repr === "shapes") out.push(nullable);
    return out;
  }

  /** Every class union, in module order. */
  allClassUnions(): ClassUnion[] {
    const out: ClassUnion[] = [];
    for (const nullable of this.byId.values()) if (nullable.repr === "classes") out.push(nullable);
    return out;
  }

  /** The module-wide number a tagged record shape stores in its shape
   * word, or 0 for shapes that carry none. */
  shapeNumber(shapeId: string): number {
    return this.shapeNumbers.get(shapeId) ?? 0;
  }

  /** The struct index of a record shape's first declared field: 2 for
   * tagged shapes (after the shape word), 1 otherwise. */
  fieldBase(shapeId: string): number {
    return this.shapeNumbers.has(shapeId) ? 2 : 1;
  }

  has(unionId: string): boolean {
    return this.byId.has(unionId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** The reference arm of every single-arm nullable union, by union id. */
  armTypes(): Map<string, IrType> {
    const result = new Map<string, IrType>();
    for (const [id, nullable] of this.byId)
      if (nullable.repr === "single") result.set(id, nullable.arm);
    return result;
  }

  /** The union table restricted to tagged-box unions: the stack-box
   * optimizations (stack wraps, stack map/array reads, local union storage)
   * only apply to boxes. */
  boxedUnions(unions: ReadonlyMap<string, IrUnionDef>): Map<string, IrUnionDef> {
    const result = new Map<string, IrUnionDef>();
    for (const [id, def] of unions) if (!this.byId.has(id)) result.set(id, def);
    return result;
  }
}

function nullableShape(
  def: IrUnionDef,
  emittedClasses: ReadonlySet<string>,
  records: ReadonlySet<string>,
): NullableUnion | null {
  const units = def.arms.filter(isUnitType).length;
  if (units < 1 || units > 2 || def.arms.length !== units + 1) return null;
  const refTag = def.arms.findIndex((arm) => !isUnitType(arm));
  let unitTag: number, nullTag: number;
  if (units === 1) {
    unitTag = def.arms.findIndex(isUnitType);
    nullTag = -1;
  } else {
    unitTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
    nullTag = def.arms.findIndex((arm) => arm.kind === "nullT");
    if (unitTag < 0 || nullTag < 0) return null;
  }
  const arm = def.arms[refTag]!;
  const base = { repr: "single" as const, unionId: def.id, refTag, unitTag, nullTag };
  if (arm.kind === "object" && emittedClasses.has(arm.className))
    return { ...base, arm: { kind: "object", className: arm.className } };
  if (arm.kind === "record" && records.has(arm.shapeId))
    return { ...base, arm: { kind: "record", shapeId: arm.shapeId } };
  if (arm.kind === "string") return { ...base, arm: { kind: "string" } };
  if (arm.kind === "stats") return { ...base, arm: { kind: "stats" } };
  if (
    arm.kind === "array" ||
    arm.kind === "bytes" ||
    arm.kind === "map" ||
    arm.kind === "set" ||
    arm.kind === "func"
  )
    return { ...base, arm };
  return null;
}

/** Two or more emitted record arms and at most two unit arms (both:
 * undefined and null). */
function shapeUnion(
  def: IrUnionDef,
  records: ReadonlySet<string>,
  boxedRecords: ReadonlySet<string>,
): ShapeUnion | null {
  const units = def.arms.filter(isUnitType).length;
  if (units > 2 || def.arms.length - units < 2) return null;
  const arms: { tag: number; shapeId: string }[] = [];
  for (let tag = 0; tag < def.arms.length; tag++) {
    const arm = def.arms[tag]!;
    if (isUnitType(arm)) continue;
    if (arm.kind !== "record" || !records.has(arm.shapeId) || boxedRecords.has(arm.shapeId))
      return null;
    arms.push({ tag, shapeId: arm.shapeId });
  }
  let unitTag = -1,
    nullTag = -1;
  if (units === 1) unitTag = def.arms.findIndex(isUnitType);
  else if (units === 2) {
    unitTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
    nullTag = def.arms.findIndex((arm) => arm.kind === "nullT");
    if (unitTag < 0 || nullTag < 0) return null;
  }
  return { repr: "shapes", unionId: def.id, unitTag, nullTag, arms };
}

/** The class forest of a module, by base links: what classUnion needs
 * before the emitter builds its class graph. */
class ClassForest {
  private readonly byName = new Map<string, IrClassDef>();
  private readonly hasChildren = new Set<string>();
  private readonly lifetimeRoots: ReadonlySet<string>;
  private readonly slotRoots = new Set<string>();

  constructor(mod: IrModule) {
    for (const cls of mod.classes ?? []) {
      this.byName.set(cls.name, cls);
      if (cls.base !== undefined) this.hasChildren.add(cls.base);
    }
    this.lifetimeRoots = new Set(mod.contracts?.programLifetime ?? []);
    for (const key of mod.threadSlotKeys ?? []) {
      const root = this.root(key);
      if (root !== undefined) this.slotRoots.add(root.name);
    }
  }

  root(className: string): IrClassDef | undefined {
    let cls = this.byName.get(className);
    while (cls?.base !== undefined) cls = this.byName.get(cls.base);
    return cls;
  }

  /** `ancestor` is `className` or one of its bases. */
  extends(className: string, ancestor: string): boolean {
    let cls = this.byName.get(className);
    while (cls !== undefined) {
      if (cls.name === ancestor) return true;
      cls = cls.base === undefined ? undefined : this.byName.get(cls.base);
    }
    return false;
  }

  standalone(className: string): boolean {
    return this.byName.get(className)?.base === undefined && !this.hasChildren.has(className);
  }

  /** The class is in a ProgramLifetime hierarchy, whose instances count
   * nothing. */
  lifetime(className: string): boolean {
    const root = this.root(className);
    return root !== undefined && this.lifetimeRoots.has(root.name);
  }

  /** Instances of the class keep their class id in a compact header
   * (classes.ts assignCompactLayouts): ProgramLifetime hierarchies without
   * a slot word. */
  compact(className: string): boolean {
    return this.lifetime(className) && !this.slotRoots.has(this.root(className)!.name);
  }

  /** An emitted class in a program-rooted hierarchy that is no Array
   * subclass: one whose instances can carry a class id. */
  identifiable(className: string): boolean {
    const cls = this.byName.get(className);
    const root = this.root(className);
    return (
      cls !== undefined &&
      cls.runtime !== true &&
      root !== undefined &&
      root.runtime !== true &&
      root.arrayElem === undefined
    );
  }
}

/** Two or more class arms none of which extends another, all compact or
 * all keeping the rc word, all ProgramLifetime classes or none, and at most
 * two unit arms (both: undefined and null). */
function classUnion(def: IrUnionDef, classes: ClassForest): ClassUnion | null {
  const units = def.arms.filter(isUnitType).length;
  if (units > 2 || def.arms.length - units < 2) return null;
  const arms: { tag: number; className: string }[] = [];
  for (let tag = 0; tag < def.arms.length; tag++) {
    const arm = def.arms[tag]!;
    if (isUnitType(arm)) continue;
    if (arm.kind !== "object" || !classes.identifiable(arm.className)) return null;
    arms.push({ tag, className: arm.className });
  }
  const compact = classes.compact(arms[0]!.className);
  const lifetime = classes.lifetime(arms[0]!.className);
  for (const arm of arms) {
    if (classes.compact(arm.className) !== compact) return null;
    if (classes.lifetime(arm.className) !== lifetime) return null;
    for (const other of arms)
      if (other !== arm && classes.extends(arm.className, other.className)) return null;
  }
  let unitTag = -1,
    nullTag = -1;
  if (units === 1) unitTag = def.arms.findIndex(isUnitType);
  else if (units === 2) {
    unitTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
    nullTag = def.arms.findIndex((arm) => arm.kind === "nullT");
    if (unitTag < 0 || nullTag < 0) return null;
  }
  return { repr: "classes", unionId: def.id, unitTag, nullTag, arms };
}

/** Unions the runtime itself inspects as tagged boxes keep that
 * representation: Map keys and Set elements hash and compare union keys by
 * tag and payload inside the C map. A union of records alone is the
 * exception: its keys compare by record identity, which a shape union's
 * record pointer carries as well (the map keys it by reference). */
function boxedUnionIds(mod: IrModule, nodes?: IrNodeIndex): Set<string> {
  const boxed = new Set<string>();
  // Only the module's union definitions consult the result.
  if (!mod.unions?.length) return boxed;
  const recordsOnly = new Set<string>();
  for (const def of mod.unions)
    if (def.arms.length >= 2 && def.arms.every((arm) => arm.kind === "record"))
      recordsOnly.add(def.id);
  const mark = (t: IrType): void => {
    if (t.kind === "union" && !recordsOnly.has(t.unionId)) boxed.add(t.unionId);
  };
  if (nodes !== undefined) {
    for (const t of nodes.types) {
      if (t.kind === "map") mark(t.key);
      else if (t.kind === "set") mark(t.elem);
    }
    return boxed;
  }
  everyModuleNode(mod, {
    expr: () => true,
    stmt: () => true,
    type: (t) => {
      if (t.kind === "map") mark(t.key);
      else if (t.kind === "set") mark(t.elem);
      return true;
    },
  });
  return boxed;
}

/** Emitted classes keyed by name, for callers that only hold the class
 * list (nullable class fields). */
export function emittedClassNames(classes: readonly IrClassDef[]): Set<string> {
  const names = new Set<string>();
  for (const cls of classes) if (!cls.runtime) names.add(cls.name);
  return names;
}
