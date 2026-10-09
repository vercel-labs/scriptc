import { isUnitType, type IrClassDef, type IrType, type IrUnionDef } from "../../ir/ir.js";

/** A class field typed `C | null` or `C | undefined` (exactly one unit arm
 * and one emitted class arm) stores the class pointer itself: NULL is the
 * unit arm, anything else is the owned (+1) instance. No union box exists
 * for the field; reads build one only where a whole union value escapes,
 * and projections (tag tests, narrowing, equality, nullish) read the
 * pointer directly. The struct slot stays `ptr`, so layouts are unchanged. */
export interface NullableRefField {
  unionId: string;
  refTag: number;
  unitTag: number;
  arm: { kind: "object"; className: string };
}

export class NullableRefFields {
  private readonly emitted = new Map<string, IrClassDef>();
  private readonly cache = new Map<string, NullableRefField | null>();

  constructor(
    classes: readonly IrClassDef[],
    private readonly unions: ReadonlyMap<string, IrUnionDef>,
  ) {
    for (const cls of classes) if (!cls.runtime) this.emitted.set(cls.name, cls);
  }

  /** The representation of one declared field, or null for ordinary storage
   * (runtime classes keep their C layouts). */
  get(className: string, field: string): NullableRefField | null {
    const key = `${className}\0${field}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const cls = this.emitted.get(className);
    const type = cls?.fields.find((f) => f.name === field)?.type;
    const result = type && !field.startsWith("%") ? this.ofType(type) : null;
    this.cache.set(key, result);
    return result;
  }

  /** The storage form of a field type: the class arm for nullable fields. */
  storageType(className: string, field: string, type: IrType): IrType {
    return this.get(className, field)?.arm ?? type;
  }

  private ofType(type: IrType): NullableRefField | null {
    if (type.kind !== "union") return null;
    const def = this.unions.get(type.unionId);
    if (!def || def.arms.length !== 2) return null;
    const unitTag = def.arms.findIndex(isUnitType);
    if (unitTag < 0) return null;
    const refTag = 1 - unitTag;
    const arm = def.arms[refTag]!;
    if (arm.kind !== "object" || !this.emitted.has(arm.className)) return null;
    return { unionId: type.unionId, refTag, unitTag, arm };
  }
}
