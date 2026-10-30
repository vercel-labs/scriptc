/* Which stores can reach a published object (see computePublishedTypes).
 * Pure function of the IR module; may-throw seeds its stores and the LLVM
 * emitter guards them. */
import type { IrExpr, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { NativeTypes, reachNativeTypes } from "../ir/native-types.js";
import { everyStmtList } from "../ir/traverse.js";
import { computeConstructionFacts } from "./immutability.js";

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
export class PublishedTypes extends NativeTypes {
  /** Constructor stores into a this nothing else can reach yet. This
   * publication exemption must never disable ordinary integrity guards. */
  privateStores: ReadonlySet<IrStmt> = new Set();

  fieldStoreGuarded(s: IrStmt): boolean {
    return s.kind === "fieldSet" && this.classes.has(s.className) && !this.privateStores.has(s);
  }
}

export function computePublishedTypes(mod: IrModule): PublishedTypes | null {
  const roots: IrType[] = [];
  const visit = (e: IrExpr): boolean => {
    // Values read from an InternTable were published by whichever thread
    // stored them.
    if (e.kind === "intrinsic" && (e.name === "threads.publish" || e.name === "itable.value"))
      roots.push(e.type);
    return true;
  };
  for (const fn of mod.functions)
    everyStmtList(fn.body, { expr: visit, stmt: (_s: IrStmt) => true });
  if (roots.length === 0) return null;

  const out = new PublishedTypes();
  out.privateStores = computeConstructionFacts(mod).privateStores;
  reachNativeTypes(mod, roots, out);
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
