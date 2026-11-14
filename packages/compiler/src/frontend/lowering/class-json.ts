/* The domain of the type-directed JSON writer for class instances.
 *
 * `JSON.stringify` of a class instance normally crosses into the runtime
 * walk: the walk reads the instance's own enumerable properties and calls
 * `toJSON`. A class whose instances the static layout describes exactly —
 * every own enumerable field in its slot, in the order the runtime walk
 * would list them — serializes directly from the slots instead. A class
 * that fails any condition here keeps the runtime walk, which is always
 * correct, only slower.
 *
 * The fields still need one runtime guard: an instance that took a dynamic
 * property through an untyped reference holds it in the compiler-owned
 * property bag (`%dynProperties`), past the layout. The emitted writer
 * tests the bag and falls back to the runtime walk when it holds anything
 * (backend/llvm/class-json.ts). */
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import {
  CLASS_FIELD_ATTRIBUTES_PREFIX,
  isClassOwnEnumerableFieldName,
  isJsonStringifySafeType,
  type IrType,
} from "../../ir/ir.js";

/** Whether `JSON.stringify` of values statically typed as an instance of
 * `className` can serialize the static layout: no subclass instance can
 * reach the value, the class declares no `toJSON` (and no `toJSON` can be
 * installed on a prototype at run time), and every own enumerable field is
 * one the type-directed writer serializes, in its slot's order. */
export function classJsonInstanceEligible(lowerer: Lowerer, className: string): boolean {
  return classEligible(lowerer, className, new Set());
}

function classEligible(lowerer: Lowerer, className: string, visiting: Set<string>): boolean {
  const key = `class:${className}`;
  // A field of the class's own type (a tree) is decided by the rest of the
  // walk, exactly as isJsonSafeAt treats a shape it is already inside.
  if (visiting.has(key)) return true;
  const info = lowerer.classes.get(className);
  if (info === undefined) return false;
  // A subclass instance can be stored in a value of the base type and
  // carries fields the base layout does not describe.
  if (info.subclasses.length > 0) return false;
  // Classes the program does not declare as a single native class: erased
  // (runtime-provided) hierarchies, arrays, class expressions evaluated per
  // call, and classes whose declaration a decorator can replace.
  if (info.def.runtime === true) return false;
  if (info.def.arrayElem !== undefined) return false;
  if (info.localClass !== undefined || info.classDecorators !== undefined) return false;
  // `toJSON` answers for the whole value. A declaration at or above the
  // class is the frontend's separate dynamic path; a program that reads or
  // replaces a method called `toJSON` anywhere can install one at run time.
  if (lowerer.prototypeMethodAccesses.has("toJSON")) return false;
  for (let current: ClassInfo | null = info; current !== null; current = current.base) {
    if (current.methods.has("toJSON")) return false;
    // A runtime-provided root keeps its own layout (an Error's slots, a
    // stream's state): the declared fields are not the whole own-property
    // set, and its order is the runtime's.
    if (current.def.runtime === true) return false;
  }
  visiting.add(key);
  for (let current: ClassInfo | null = info; current !== null; current = current.base) {
    if (!ownOrderMatchesLayout(current)) return false;
    const symbols = new Set((current.def.symbolFields ?? []).map((entry) => entry.field));
    for (const field of current.def.fields) {
      // Compiler-owned words (`%dynProperties`, `%attributes`, an Error's
      // `%cause`) are not own enumerable properties; a field whose
      // attributes `Object.defineProperty` changed may not be enumerable.
      if (!isClassOwnEnumerableFieldName(field.name)) {
        if (field.name.startsWith(CLASS_FIELD_ATTRIBUTES_PREFIX)) return false;
        continue;
      }
      if (symbols.has(field.name)) continue;
      // A function-valued field is dropped from the output, like any
      // function-valued property; the writer skips it.
      if (field.type.kind === "func") continue;
      if (field.name === "toJSON") return false;
      if (!fieldJsonSafe(lowerer, field.type, visiting)) return false;
    }
  }
  visiting.delete(key);
  // The backend writer reads the layout only for a class that answered this
  // question; any other class instance keeps the runtime walk.
  info.def.jsonLayout = true;
  return true;
}

/** Whether a class creates its own enumerable fields in the order its
 * layout stores them. The runtime walk lists own properties in creation
 * order, and parameter properties and class fields are both defined in
 * declaration order, so the two agree unless a redeclared or erased field
 * moves a name. */
function ownOrderMatchesLayout(info: ClassInfo): boolean {
  const declared = info.def.fields.slice(info.base?.def.fields.length ?? 0);
  const own = declared.map((field) => field.name).filter(isClassOwnEnumerableFieldName);
  const created = info.fieldOrder
    .filter((field) => field.redeclared !== true)
    .map((field) => field.name)
    .filter(isClassOwnEnumerableFieldName);
  return own.length === created.length && own.every((name, index) => name === created[index]);
}

/** Whether the type-directed writer serializes a value of `t` in a class
 * field position as `JSON.stringify` does: an own field holding
 * `undefined` is dropped (the writer branches on the undefined arm), and an
 * array element holding `undefined` is written `null`. */
function fieldJsonSafe(lowerer: Lowerer, t: IrType, visiting: Set<string>): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "date":
    case "nullT":
    case "undefinedT":
      return true;
    case "array":
      return fieldJsonSafe(lowerer, t.elem, visiting);
    // A Map or a Set holds no own enumerable property and has no toJSON:
    // the writer emits the empty object Node does.
    case "set":
    case "map":
      return true;
    case "object":
      return classEligible(lowerer, t.className, visiting);
    // A record or a union of records keeps the shared type-directed domain:
    // its writer drops undefined-valued fields and writes array slots as
    // null exactly as the runtime walk does.
    case "record":
      return isJsonStringifySafeType(
        t,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      );
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      if (def === undefined) return false;
      const key = `union:${t.unionId}`;
      if (visiting.has(key)) return true;
      visiting.add(key);
      const safe = def.arms.every(
        (arm) => arm.kind === "undefinedT" || fieldJsonSafe(lowerer, arm, visiting),
      );
      visiting.delete(key);
      return safe;
    }
    default:
      return false;
  }
}
