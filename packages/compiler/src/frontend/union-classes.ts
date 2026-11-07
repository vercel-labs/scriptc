/* Classes of record types that a union's deciding member cannot tell apart.
 *
 * A union of records is a tagged box: one arm per record layout, and a
 * literal member every arm requires says which arm a value is
 * (`IrUnionDef.discriminant`). That needs each literal to belong to one
 * layout. `{ type: "retry"; source: "a" } | { type: "retry"; source: "b";
 * reason: string } | { type: "end" }` has two layouts for `"retry"`, so
 * `type` decided nothing and the whole union fell back to choosing arms by
 * layout: a record that fits two arms by width (its own, and one whose
 * extra member may be absent) then had no arm, although its `type` names
 * exactly one, and a value arriving from JSON took the first arm it fit.
 *
 * In JavaScript the constituents that share a literal are one kind of
 * object: nothing but its other members says which a value is, and a value
 * can have the members of several. They are stored that way here. The
 * constituents of a declared union that share a literal of its deciding
 * member, directly or through other constituents, form a CLASS, and every
 * type of a class has ONE record layout: the union of the members its
 * types declare. A member every type declares keeps its type; a member
 * only some declare is optional, absent in a value that lacks it. So:
 *
 *  - the union's arms are one record per class, each owning its literals,
 *    and the deciding member is a total discriminant: a literal's arm, a
 *    record or another union converting in, a checked conversion from
 *    `unknown` and a narrowing all read it, as for any discriminated union;
 *  - a value of one constituent type IS a value of its class's record,
 *    wherever that type is written (a parameter, a binding, an `as`): it
 *    enters and leaves the union as the same object, with no conversion;
 *  - a member the constituent requires and the record holds as optional is
 *    read through the checked extraction of the slot's undefined arm.
 *
 * The classes are found once, before any type is mapped, from the union
 * types the program writes down (collectUnionClasses), so a constituent
 * maps to its class's record from its first use on. The layout of a type
 * then depends on a union declared elsewhere, which is a whole-program
 * fact (program-facts.ts, "union-classes"). A union one member already
 * decides has no class, and nothing about it changes. */
import * as ts from "./ts7/adapter.js";
import {
  shapeHasAccessorSlots,
  typeEquals,
  type IrRecordField,
  type IrRecordShape,
  type IrType,
} from "../ir/ir.js";
import { literalValues } from "./literal-values.js";
import { isJsSourceFile } from "./program.js";

/** Each type that belongs to a class, with the types of its class (the
 * same array for every member). */
export type UnionClasses = ReadonlyMap<ts.Type, readonly ts.Type[]>;

/** A class as one lowering pass maps it (type-mapper.ts). */
export interface UnionClassState {
  readonly members: readonly ts.Type[];
  state: "unmapped" | "mapping" | "merged" | "separate";
  /** The class's record once `state` is "merged". */
  record: (IrType & { kind: "record" }) | null;
  /** While mapping: the member whose own layout is being asked for, until
   * that request arrives; any other request for a member is a type that
   * contains its own class, which stays separate. */
  owning: ts.Type | null;
  reentered: boolean;
}

/** A union type node two of whose members can be record types. Primitive,
 * literal, array, tuple and function members never are. */
function mayHoldRecordClass(node: ts.UnionTypeNode): boolean {
  let records = 0;
  for (let member of node.types.nodes) {
    while (ts.isParenthesizedTypeNode(member)) member = member.type;
    if (
      ts.isTypeLiteralNode(member) ||
      ts.isTypeReferenceNode(member) ||
      ts.isIntersectionTypeNode(member) ||
      ts.isConditionalTypeNode(member) ||
      ts.isIndexedAccessTypeNode(member) ||
      ts.isMappedTypeNode(member)
    )
      records++;
  }
  return records >= 2;
}

/** A plain data object type: not an array, a tuple, a function, a class
 * instance or a type the standard library or a declaration file declares. */
function isRecordConstituent(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (checker.getCallSignatures(type).length > 0) return false;
  if (checker.getConstructSignatures(type).length > 0) return false;
  if (checker.getIndexInfosOfType(type).length > 0) return false;
  const symbol = type.getSymbol();
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
  const declarations = symbol === undefined ? [] : symbol.declarations;
  return !declarations.some((decl) => ts.getSourceFileOfNode(decl).isDeclarationFile);
}

/** The classes of one union type: for the member that separates its record
 * constituents into the most classes, each set of two or more constituents
 * that share a literal. Empty when some member gives every constituent its
 * own literals (that member is the union's discriminant as it stands),
 * when no literal member separates the constituents at all, or when a
 * constituent that is not plain data stands beside the records. */
function sharedLiteralClasses(union: ts.Type, checker: ts.TypeChecker): ts.Type[][] {
  const parts: ts.Type[] = [];
  for (const part of ts.constituentTypes(union)) {
    if ((part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) continue;
    if (!isRecordConstituent(checker, part)) return [];
    parts.push(part);
  }
  if (parts.length < 3) return [];
  let best: number[][] | null = null;
  for (const candidate of checker.getPropertiesOfType(parts[0]!)) {
    const field = ts.symbolName(candidate);
    if (field.startsWith("__@")) continue;
    const parent = parts.map((_, index) => index);
    const find = (index: number): number => {
      while (parent[index] !== index) index = parent[index]!;
      return index;
    };
    const owner = new Map<string, number>();
    let complete = true;
    for (let index = 0; index < parts.length && complete; index++) {
      const prop = checker.getPropertyOfType(parts[index]!, field);
      const values =
        prop &&
        !(
          prop.flags &
          (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
        )
          ? literalValues(checker.getTypeOfSymbol(prop))
          : null;
      if (!values) {
        complete = false;
        break;
      }
      for (const value of values) {
        const key = JSON.stringify(value);
        const previous = owner.get(key);
        if (previous === undefined) owner.set(key, index);
        else parent[find(index)] = find(previous);
      }
    }
    if (!complete) continue;
    const groups = new Map<number, number[]>();
    parts.forEach((_, index) => {
      const root = find(index);
      const group = groups.get(root);
      if (group) group.push(index);
      else groups.set(root, [index]);
    });
    if (groups.size === parts.length) return [];
    if (groups.size < 2) continue;
    if (best === null || groups.size > best.length) best = [...groups.values()];
  }
  if (best === null) return [];
  return best.filter((group) => group.length > 1).map((group) => group.map((i) => parts[i]!));
}

/** The classes of the union types the program's TypeScript sources write
 * down. A type in the classes of two unions joins them into one class. */
export function collectUnionClasses(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): Map<ts.Type, ts.Type[]> {
  const classOf = new Map<ts.Type, ts.Type[]>();
  const seen = new Set<ts.Type>();
  const join = (members: ts.Type[]): void => {
    const joined: ts.Type[] = [];
    for (const member of members) {
      for (const known of classOf.get(member) ?? [member]) {
        if (!joined.includes(known)) joined.push(known);
      }
    }
    for (const member of joined) classOf.set(member, joined);
  };
  for (const file of files) {
    if (file.isDeclarationFile || isJsSourceFile(file)) continue;
    ts.walkPreorder(file, (node) => {
      if (!ts.isUnionTypeNode(node) || !mayHoldRecordClass(node)) return;
      const type = checker.getTypeFromTypeNode(node);
      if (!type.isUnionType() || seen.has(type)) return;
      seen.add(type);
      for (const members of sharedLiteralClasses(type, checker)) join(members);
    });
  }
  return classOf;
}

export interface UnionClassEnv {
  /** `type | undefined`, or null when that union has no representation. */
  withUndefined(type: IrType): IrType | null;
  internRecord(fields: IrRecordField[], declaredOrder: string[]): string;
}

/** Whether a class member's own layout can be part of a class's record: a
 * closed record of ordinary data slots. */
export function classMemberLayout(shape: IrRecordShape | undefined): shape is IrRecordShape {
  return (
    shape !== undefined &&
    !shape.tuple &&
    shape.indexValue === undefined &&
    !shapeHasAccessorSlots(shape) &&
    !shape.fields.some((field) => field.name.startsWith("%"))
  );
}

/** One record over the members of a class's layouts, or null when the
 * layouts have no such record: a member two layouts declare with different
 * types, or an optional member whose type has no union with `undefined`. */
export function classRecord(shapes: readonly IrRecordShape[], env: UnionClassEnv): string | null {
  const order: string[] = [];
  for (const shape of shapes) {
    for (const name of shape.declaredOrder ?? shape.fields.map((field) => field.name)) {
      if (!order.includes(name)) order.push(name);
    }
  }
  const fields: IrRecordField[] = [];
  for (const name of order) {
    const declared = shapes.map((shape) => shape.fields.find((field) => field.name === name));
    const first = declared.find((field) => field !== undefined);
    if (first === undefined) return null;
    for (const field of declared) {
      if (
        field !== undefined &&
        (!typeEquals(field.type, first.type) || field.optional !== first.optional)
      )
        return null;
    }
    if (declared.every((field) => field !== undefined)) {
      fields.push({ ...first });
      continue;
    }
    // A member only some layouts declare: absent in a value of the others.
    if (first.type.kind === "dyn") {
      fields.push({ name, type: first.type, optional: true });
      continue;
    }
    const type = env.withUndefined(first.type);
    if (type === null) return null;
    fields.push({ name, type });
  }
  const names = new Set(shapes.flatMap((shape) => shape.fields.map((field) => field.name)));
  if (fields.length !== names.size) return null;
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return env.internRecord(fields, order);
}
