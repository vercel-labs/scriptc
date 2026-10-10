/* Which stores can reach a published object (see computePublishedTypes).
 * Pure function of the IR module; may-throw seeds its stores and the LLVM
 * emitter guards them. */
import type { IrExpr, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { typeKey } from "../ir/ir.js";
import { everyStmtList } from "../ir/traverse.js";
import { computeConstructionFacts } from "./immutability.js";

/** Array methods that write their receiver (the guarded ones). */
export const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pushSpread",
  "unshift",
  "unshiftSpread",
  "pop",
  "shift",
  "splice",
  "spliceInsert",
  "reverse",
  "copyWithin",
  "fill",
  "fillUndefined",
  "sortPrimitive",
]);

/** Map and Set methods that write their receiver. */
export const MUTATING_COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "set",
  "add",
  "delete",
  "clear",
]);

/** The static types whose values a program may publish
 * (@scriptc/threads publish), closed over everything they reach.
 *
 * A published object is immortal and shared with other threads, so it must
 * never be written again; a write throws Node's frozen-object TypeError.
 * Only stores whose target's static type is in this set can reach a
 * published object, so only those carry the guard. A class joins with its
 * whole hierarchy: a base-typed field can hold any subclass (whose fields
 * are then reached too), and a published subclass instance can be written
 * through a base-typed reference. */
export class PublishedTypes {
  readonly classes = new Set<string>();
  readonly records = new Set<string>();
  /** typeKeys of array, map and set types. */
  readonly containers = new Set<string>();
  /** Constructor stores into a `this` nothing else can reach yet
   * (immutability.ts): never a published target, so never guarded. */
  privateStores: ReadonlySet<IrStmt> = new Set();

  classGuarded(className: string): boolean {
    return this.classes.has(className);
  }

  /** Whether a class field store needs the guard. */
  fieldStoreGuarded(s: IrStmt): boolean {
    return s.kind === "fieldSet" && this.classes.has(s.className) && !this.privateStores.has(s);
  }

  recordGuarded(shapeId: string): boolean {
    return this.records.has(shapeId);
  }

  containerGuarded(t: IrType): boolean {
    return (
      (t.kind === "array" || t.kind === "map" || t.kind === "set") &&
      this.containers.has(typeKey(t))
    );
  }
}

export function computePublishedTypes(mod: IrModule): PublishedTypes | null {
  const roots: IrType[] = [];
  const visit = (e: IrExpr): boolean => {
    if (e.kind === "intrinsic" && e.name === "threads.publish") roots.push(e.type);
    return true;
  };
  for (const fn of mod.functions)
    everyStmtList(fn.body, { expr: visit, stmt: (_s: IrStmt) => true });
  if (roots.length === 0) return null;

  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const children = new Map<string, string[]>();
  for (const cls of classes.values())
    if (cls.base !== undefined) {
      let list = children.get(cls.base);
      if (!list) children.set(cls.base, (list = []));
      list.push(cls.name);
    }
  const records = new Map((mod.records ?? []).map((r) => [r.id, r]));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  const out = new PublishedTypes();
  out.privateStores = computeConstructionFacts(mod).privateStores;
  const seen = new Set<string>();
  const stack = [...roots];
  const addHierarchy = (className: string): void => {
    let root = className;
    for (
      let c = classes.get(root);
      c?.base !== undefined && classes.has(c.base);
      c = classes.get(root)
    )
      root = c.base;
    const todo = [root];
    while (todo.length > 0) {
      const name = todo.pop()!;
      if (out.classes.has(name)) continue;
      out.classes.add(name);
      for (const f of classes.get(name)?.fields ?? []) stack.push(f.type);
      todo.push(...(children.get(name) ?? []));
    }
  };
  while (stack.length > 0) {
    const t = stack.pop()!;
    const key = typeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    switch (t.kind) {
      case "object":
        addHierarchy(t.className);
        break;
      case "record": {
        out.records.add(t.shapeId);
        const shape = records.get(t.shapeId);
        for (const f of shape?.fields ?? []) stack.push(f.type);
        if (shape?.indexValue) stack.push(shape.indexValue);
        break;
      }
      case "array":
      case "set":
        out.containers.add(key);
        stack.push(t.elem);
        break;
      case "map":
        out.containers.add(key);
        stack.push(t.key, t.value);
        break;
      case "union":
        stack.push(...(unions.get(t.unionId)?.arms ?? []));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Whether a statement or expression writes into a value of a published
 * type (its guard can throw). */
export function writesPublished(published: PublishedTypes, node: IrExpr | IrStmt): boolean {
  switch (node.kind) {
    case "fieldSet":
      return published.fieldStoreGuarded(node);
    case "fieldIncDec":
      return published.classGuarded(node.className);
    case "recordSet":
    case "recordKeySet":
    case "recordKeyDelete":
      return published.recordGuarded(node.shapeId);
    case "arraySet":
    case "arraySetLength":
    case "arraySetUndefined":
    case "arrayDelete":
      return published.containerGuarded(node.arr.type);
    case "arrIntrinsic":
      return (
        MUTATING_ARRAY_METHODS.has(node.method) && published.containerGuarded(node.receiver.type)
      );
    case "mapIntrinsic":
    case "setIntrinsic":
      return (
        MUTATING_COLLECTION_METHODS.has(node.method) &&
        published.containerGuarded(node.receiver.type)
      );
    default:
      return false;
  }
}
