import type { IrExpr, IrFunction, IrGlobal, IrModule, IrStmt } from "./ir.js";
import {
  eachNodeOfKinds,
  type IrNodeIndex,
  type IrNodeKind,
  LOCAL_BINDING_KINDS,
} from "./node-index.js";
import { everyStmtList } from "./traverse.js";

/** The nodes that write a binding or capture one. */
const WRITE_KINDS: readonly IrNodeKind[] = [...LOCAL_BINDING_KINDS, "tryCatch", "closure"];

/** Module `let`/`var` bindings that only their declaration writes read as
 * module constants.
 *
 * A source binding whose one write in the whole program is a top-level
 * `assign` of the guarded, synchronous module initializer holds that value
 * for every later read, exactly like a `const`: reads that can run before
 * the store already carry the frontend's `initFlag`, TDZ sentinel or
 * `undefined`-admitting union type, and those globals are left alone. Marking
 * such a global immutable hands it to the analyses that already serve
 * `const` (constant folding, borrowed reads, constant tables) without
 * changing its storage, lifetime or initialization order. Compiler-internal
 * globals (init guards, initialization flags, caches) have no source binding
 * and are never touched. Library builds keep their globals: an embedder can
 * reset or observe library state between entries. `nodes`, an index of
 * `mod`, gives the writes without walking the bodies. */
export function freezeInitOnlyGlobals(mod: IrModule, nodes?: IrNodeIndex): IrModule {
  if (mod.lib || !mod.globals?.length) return mod;
  const candidates = new Map<string, IrGlobal>();
  for (const g of mod.globals)
    if (g.mutable && g.source && g.tdz !== true && g.initFlag === undefined)
      candidates.set(g.id, g);
  if (candidates.size === 0) return mod;

  // Every node other than a read that names a candidate is a write
  // (assignments, loop and catch bindings, compound updates); lifted
  // captures keep their own discipline.
  const writes = new Map<string, number>();
  const write = (id: string): void => {
    if (candidates.has(id)) writes.set(id, (writes.get(id) ?? 0) + 1);
  };
  for (const cls of mod.classes ?? [])
    for (const capture of cls.localCaptures ?? []) candidates.delete(capture.localId);
  const scan = nodes?.scan(WRITE_KINDS);
  for (const fn of mod.functions) {
    for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
      candidates.delete(capture.localId);
    eachNodeOfKinds(fn, scan, (node) => {
      if (node.kind === "closure") for (const id of node.captures) candidates.delete(id);
      else if (node.kind === "tryCatch") {
        if (node.catchLocalId) write(node.catchLocalId);
      } else if (node.kind !== "varRef" && "localId" in node && typeof node.localId === "string")
        write(node.localId);
    });
  }

  const frozen = new Set<string>();
  for (const fn of mod.functions) {
    if (!isGuardedInitializer(fn, mod)) continue;
    const readBefore = new Set<string>();
    const noteReads = (s: IrStmt): void => {
      everyStmtList([s], {
        stmt: () => true,
        expr: (e: IrExpr) => {
          if (e.kind === "varRef" && candidates.has(e.localId)) readBefore.add(e.localId);
          return true;
        },
      });
    };
    // Unlabeled blocks run unconditionally and in order, like the statements
    // around them; a labeled block can `break` past a write, and any other
    // compound statement may skip or repeat one.
    const scan = (list: readonly IrStmt[]): void => {
      for (const s of list) {
        if (s.kind === "block" && !s.labels?.length) {
          scan(s.body);
          continue;
        }
        if (
          s.kind === "assign" &&
          candidates.has(s.localId) &&
          writes.get(s.localId) === 1 &&
          !readBefore.has(s.localId)
        )
          frozen.add(s.localId);
        noteReads(s);
      }
    };
    scan(fn.body);
  }
  if (frozen.size === 0) return mod;
  return {
    ...mod,
    globals: mod.globals.map((g) => (frozen.has(g.id) ? immutableGlobal(g) : g)),
  };
}

/** `if (loaded) return; loaded = true; ...`: a synchronous module initializer
 * that runs its body at most once, whose guard only it writes. */
function isGuardedInitializer(fn: IrFunction, mod: IrModule): boolean {
  if (fn.async || fn.generator || fn.captures?.length) return false;
  const check = fn.body[0],
    set = fn.body[1];
  if (
    check?.kind !== "if" ||
    check.cond.kind !== "varRef" ||
    check.else_ !== null ||
    check.then.length !== 1 ||
    check.then[0]?.kind !== "return" ||
    check.then[0].value !== null ||
    set?.kind !== "assign" ||
    set.localId !== check.cond.localId ||
    set.value.kind !== "boolLit" ||
    !set.value.value
  )
    return false;
  const guard = mod.globals?.find((g) => g.id === set.localId);
  return guard?.type.kind === "bool" && guard.tdz !== true;
}

function immutableGlobal(global: IrGlobal): IrGlobal {
  return { ...global, mutable: false };
}
