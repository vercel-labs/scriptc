/* Which allocations of a region group take its arena (arenas.ts), and
 * which roots and call regions are worth one.
 *
 * An arena pays off for objects that live until the group is dropped: it
 * saves their frees and teardown, but holds their memory until the drop.
 * A temporary that dies early is cheaper on the heap, which reuses its
 * memory at once. So in an arena-aware function an allocation takes the
 * arena only when its value is kept by the group (its fate is the arena):
 * - it is returned;
 * - it is content of a new value that is kept;
 * - it is stored, other than by an element write, into the graph of a
 *   local that is kept (`out.push(row)`, `last.next = member`);
 * - it is bound to a local that is kept.
 * A local is kept when its value is returned or stored or put into
 * something kept; a constructor's `this` is kept (its object follows its
 * `new`); and in the callee of a call region, a local declared at the top
 * of the body lives until the region drops. An element write (`a[i] = v`)
 * usually replaces a value, so its value takes the heap.
 *
 * Every other allocation takes the heap, and so does everything a call
 * allocates when the call's value is not kept: the emitter suspends the
 * arena around such a call (heapCalls). Heap objects are always safe in a
 * group; only arena objects need the group's proof.
 *
 * A root or call region is worth an arena when its group grows: a kept
 * allocation runs in a loop, or a kept value comes from a recursive call
 * or from a call of a function whose group grows. Other groups are small,
 * and opening and dropping their arenas costs more than their frees. */
import type { IrFunction, IrModule } from "../../ir/ir.js";
import { contentOf, source, storeOf, storeTarget, type RegionGroups } from "./region-groups.js";
import {
  argsOf,
  children,
  indexOfNode,
  isExpr,
  refType,
  same,
  transparent,
  type Node,
} from "./region-ir.js";
import { VirtualTargets } from "./reference-effects.js";

export interface RegionSites {
  /** Allocation sites (and calls) whose value the group keeps. */
  arenaSites: Set<Node>;
  /** Calls, constructions and closure calls in arena-aware functions whose
   * value the group does not keep and whose callee may allocate: the
   * arena is suspended while they run. */
  heapCalls: Set<Node>;
}

const LOOPS = new Set(["while", "doWhile", "for", "forOf"]);

/** Collection methods that remove what their receiver holds. */
const REMOVALS = new Set(["pop", "shift", "splice", "delete", "clear"]);

/** The local whose graph `node` drops values from (an element write, a
 * length write, a delete, a removing method), or null. */
function removalTarget(node: Node): string | null {
  switch (node.kind) {
    case "arraySet":
    case "arraySetLength":
    case "arraySetUndefined":
    case "arrayDelete":
      return storeTarget(node.arr);
    case "recordKeyDelete":
      return storeTarget(node.obj);
    case "arrIntrinsic":
    case "mapIntrinsic":
    case "setIntrinsic":
      return REMOVALS.has(node.method) ? storeTarget(node.receiver) : null;
    default:
      return null;
  }
}

/** The functions a call-like node may run, or null when unknown. */
function targetsOf(vt: VirtualTargets, node: Node): readonly string[] | null {
  if (node.kind === "call") return [node.callee];
  if (node.kind === "new") return [`%${node.className}.constructor`];
  if (node.kind === "virtualCall") {
    const t = vt.targets(node.className, node.method);
    return t !== null && t.length > 0 ? t : null;
  }
  return null;
}

const callLike = (node: Node): boolean =>
  node.kind === "call" ||
  node.kind === "new" ||
  node.kind === "virtualCall" ||
  node.kind === "callValue" ||
  node.kind === "newValue";

/** The functions that run inside the arenas of `roots`: what they call,
 * transitively, with the closures they pass. */
export function reachableFrom(mod: IrModule, roots: Iterable<Node>): Set<string> {
  const fns = new Map(mod.functions.map((f) => [f.name, f]));
  const vt = new VirtualTargets(mod.classes ?? []);
  const reachable = new Set<string>();
  const queue: string[] = [];
  const visit = (node: Node): void => {
    const reach = (name: string): void => {
      if (fns.has(name) && !reachable.has(name)) {
        reachable.add(name);
        queue.push(name);
      }
    };
    if (node.kind === "closure") reach(node.fnName);
    else for (const t of targetsOf(vt, node) ?? []) reach(t);
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) visit(k);
  };
  for (const r of roots) visit(r);
  while (queue.length > 0) for (const st of fns.get(queue.pop()!)!.body) visit(st);
  return reachable;
}

interface FnSites {
  /** Kept call-like nodes and allocations, with whether each is in a loop. */
  kept: Map<Node, boolean>;
  /** Call-like nodes whose value is not kept. */
  dropped: Node[];
}

/** Classifies the allocations and calls of `fn`. */
function classify(fn: IrFunction, topLocalsKept: boolean): FnSites {
  const locals = new Set(fn.locals.map((l) => l.id));
  // Alias classes: a local bound to another local shares its fate.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let r = id;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const kept = new Set<string>();
  const keep = (id: string): boolean => {
    const r = find(id);
    if (kept.has(r)) return false;
    kept.add(r);
    return true;
  };
  const isKept = (id: string): boolean => kept.has(find(id));
  // Kept from the start (applied once the alias classes are known).
  const seeds: string[] = [];
  if (fn.name.endsWith(".constructor") && fn.params.length > 0) seeds.push(fn.params[0]!.localId);
  if (topLocalsKept) {
    const types = new Map(fn.locals.map((l) => [l.id, l.type]));
    for (const st of fn.body)
      if (st.kind === "varDecl" && refType(types.get(st.localId) ?? { kind: "void" }))
        seeds.push(st.localId);
  }

  // Uses of locals and of value-producing nodes, recorded once.
  type Fate =
    | { kind: "kept" }
    | { kind: "local"; id: string }
    | { kind: "target"; id: string }
    | { kind: "node"; node: Node }
    | { kind: "heap" };
  const fateOf = (node: Node, parents: readonly Node[]): Fate => {
    let value: Node = node;
    let at = parents.length - 1;
    while (at >= 0 && transparent(value, parents[at])) value = parents[at--]!;
    const p = at >= 0 ? parents[at] : undefined;
    if (p === undefined) return { kind: "heap" };
    if (p.kind === "return") return { kind: "kept" };
    if (
      (p.kind === "varDecl" && p.init !== null && same(p.init, value)) ||
      (p.kind === "assign" && same(p.value, value))
    ) {
      const id = p.localId;
      // A local assigned in a loop usually drops its old value.
      if (!locals.has(id) || (p.kind === "assign" && depth > 0)) return { kind: "heap" };
      return { kind: "local", id };
    }
    const target = storeOf(value, p);
    if (target !== undefined) {
      if (p.kind === "arraySet") return { kind: "heap" };
      const id = storeTarget(target);
      return id !== null && locals.has(id) ? { kind: "target", id } : { kind: "heap" };
    }
    if (isExpr(p) && contentOf(value, p)) return { kind: "node", node: p };
    // An argument of a call that returns a reference follows the call's
    // value: the callee may put it into its result.
    const args = argsOf(p);
    if (
      callLike(p) &&
      isExpr(p) &&
      refType(p.type) &&
      args !== null &&
      indexOfNode(args, value) >= 0
    )
      return { kind: "node", node: p };
    return { kind: "heap" };
  };

  // Lossy locals: their graphs drop values (element writes, removals), so
  // what is stored into them is not kept.
  const lossy = new Set<string>();
  const fates = new Map<Node, Fate>();
  const loops = new Map<Node, boolean>();
  const localUses: [string, Fate][] = [];
  const parents: Node[] = [];
  let depth = 0;
  const walk = (node: Node): void => {
    const removal = removalTarget(node);
    if (removal !== null) lossy.add(removal);
    if (source(node) || callLike(node)) {
      fates.set(node, fateOf(node, parents));
      loops.set(node, depth > 0);
    } else if (node.kind === "varRef" && locals.has(node.localId) && refType(node.type)) {
      const f = fateOf(node, parents);
      if (f.kind !== "heap") localUses.push([node.localId, f]);
    }
    const loop = LOOPS.has(node.kind);
    if (loop) depth++;
    const kids: Node[] = [];
    children(node, kids);
    parents.push(node);
    for (const k of kids) walk(k);
    parents.pop();
    if (loop) depth--;
  };
  for (const st of fn.body) walk(st);

  // A local bound to another local joins its class.
  for (const [id, f] of localUses) if (f.kind === "local") unite(id, f.id);
  for (const id of [...lossy]) lossy.add(find(id));
  for (const id of seeds) keep(id);
  const keptFate = (f: Fate, seen = 0): boolean => {
    if (seen > 64) return false;
    switch (f.kind) {
      case "kept":
        return true;
      case "local":
        return isKept(f.id);
      case "target":
        return isKept(f.id) && !lossy.has(find(f.id));
      case "node": {
        const g = fates.get(f.node);
        return g !== undefined && keptFate(g, seen + 1);
      }
      case "heap":
        return false;
    }
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, f] of localUses)
      if (f.kind !== "local" && keptFate(f) && keep(id)) changed = true;
  }
  const out: FnSites = { kept: new Map(), dropped: [] };
  for (const [e, f] of fates)
    if (keptFate(f)) out.kept.set(e, loops.get(e)!);
    else if (callLike(e)) out.dropped.push(e);
  return out;
}

/**
 * Narrows `groups` to the roots and call regions worth an arena (with
 * `reachable` recomputed for them) and classifies the allocations of the
 * functions that run in their arenas.
 */
export function planRegionSites(mod: IrModule, groups: RegionGroups): RegionSites {
  const fns = new Map(mod.functions.map((f) => [f.name, f]));
  const vt = new VirtualTargets(mod.classes ?? []);
  const regionCallees = new Set<string>();
  for (const c of groups.calls) if (c.kind === "call") regionCallees.add(c.callee);
  const sites = new Map<string, FnSites>();
  for (const name of groups.reachable) {
    const fn = fns.get(name);
    if (fn !== undefined) sites.set(name, classify(fn, regionCallees.has(name)));
  }
  // Which functions reach which (for recursion), over the reachable ones.
  const calleesOf = (name: string): Set<string> => {
    const out = new Set<string>();
    const s = sites.get(name);
    if (s === undefined) return out;
    for (const e of [...s.kept.keys(), ...s.dropped])
      for (const t of targetsOf(vt, e) ?? []) if (sites.has(t)) out.add(t);
    return out;
  };
  const edges = new Map([...sites.keys()].map((n) => [n, calleesOf(n)]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of edges.get(n) ?? new Set<string>()) stack.push(m);
    }
    return false;
  };
  const grows = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, s] of sites) {
      if (grows.has(name)) continue;
      let g = false;
      for (const [e, inLoop] of s.kept) {
        if (inLoop) g = true;
        for (const t of targetsOf(vt, e) ?? []) if (grows.has(t) || reaches(t, name)) g = true;
        if (g) break;
      }
      if (g) {
        grows.add(name);
        changed = true;
      }
    }
  }
  const worth = (r: Node): boolean => {
    // Module code runs once, and its groups hold the program's own state.
    if (r.kind === "call") return grows.has(r.callee) && !r.callee.startsWith("%init.");
    if (r.kind !== "new") return false;
    if (grows.has(`%${r.className}.constructor`)) return true;
    return r.args.some((a) => a.kind === "call" && grows.has(a.callee));
  };
  for (const r of [...groups.roots])
    if (!worth(r)) {
      groups.roots.delete(r);
      groups.drops.delete(r);
    }
  for (const c of [...groups.calls]) if (!worth(c)) groups.calls.delete(c);
  groups.reachable = reachableFrom(mod, [...groups.roots, ...groups.calls]);

  const arenaSites = new Set<Node>();
  const heapCalls = new Set<Node>();
  const mayAllocate = (e: Node): boolean => {
    const t = targetsOf(vt, e);
    return t === null || t.some((n) => groups.allocates.has(n) || !fns.has(n));
  };
  for (const name of groups.reachable) {
    const s = sites.get(name);
    if (s === undefined) continue;
    for (const e of s.kept.keys()) arenaSites.add(e);
    for (const e of s.dropped)
      if (!groups.roots.has(e) && !groups.calls.has(e) && mayAllocate(e)) heapCalls.add(e);
  }
  return { arenaSites, heapCalls };
}
