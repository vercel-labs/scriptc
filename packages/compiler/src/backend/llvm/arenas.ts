/* Group arenas (runtime scr_arena.h): objects that region-groups.ts proves
 * die together are bump-allocated in an arena and released at once.
 *
 * - A root (a fresh-result call or `new` whose value its caller keeps in
 *   one scope) opens an arena before it is evaluated and closes it after.
 *   The scope that holds the value drops the arena when it exits, on every
 *   path. A statement-frame entry closes the arena too, so an exception
 *   that skips the close never leaves it the allocation target.
 * - A call region (a call of a leak-free function that returns no
 *   reference) opens an arena and drops it as soon as the call returns,
 *   or when its statement frame unwinds.
 *
 * region-sites.ts keeps only the roots and call regions whose groups grow,
 * and picks the allocations that take the arena: those whose value the
 * group keeps. Arena-aware functions are the ones reached from the kept
 * roots and call regions. There, a kept `new`, record or array literal
 * calls the arena-aware constructor (`<new>.r`, `scr_arr_new*_r`), which
 * allocates in the current arena when one is open and on the heap
 * otherwise, and a call whose value the group does not keep runs with the
 * arena suspended. Every other allocation site stays as it is.
 *
 * Arenas are off in programs that construct weak collections, in programs
 * of more than ARENA_FUNCTION_LIMIT functions, in libraries, and with
 * lifetime regions. */
import type { IrClassDef, IrFunction, IrModule, IrType } from "../../ir/ir.js";
import {
  analyzeClosedGroups,
  analyzeRegionGroups,
  source,
  throws,
  type RegionGroups,
} from "./region-groups.js";
import { CYC_BUF, CYC_HDR, CYC_TYPE } from "./alloc.js";
import { VirtualTargets } from "./reference-effects.js";
import { ALLOCATIONS, children, forEachNode, isExpr, type Node } from "./region-ir.js";
import {
  guardedFunctions,
  holdValues,
  opensArena,
  planRegionSites,
  reachableFrom,
  type RegionSites,
} from "./region-sites.js";

/** The count an arena object starts with (scr_arena.h SCR_ARENA_RC). */
export const ARENA_RC = 2 ** 29;

/** Group arenas are on unless SCRIPTC_ARENAS=0 (for comparisons). */
export function arenasRequested(): boolean {
  return process.env["SCRIPTC_ARENAS"] !== "0";
}

export interface ArenaPlan {
  groups: RegionGroups;
  sites: RegionSites;
  /** Record shapes and classes that get an arena-aware constructor. */
  shapes: Set<string>;
  classes: Set<string>;
  /** Every root and call region opens a closed arena, so the current arena
   * is always closed or absent, and the arena-aware constructors of record
   * shapes and classes add no dispose entries. */
  allClosed: boolean;
}

export interface ArenaEligibility {
  shape(shapeId: string): boolean;
  cls(def: IrClassDef): boolean;
  /** The reference arm of a union stored as a nullable pointer, or null. */
  nullableArm(unionId: string): IrType | null;
  /** Whether values of `t` can be on a reference cycle (the collector
   * traces them). */
  traced(t: IrType): boolean;
  /** Whether `def` is a proven tree class (backend/tree-classes.ts):
   * headerless, uniquely owned and acyclic, so an arena may reclaim its
   * nodes as a group (arenaTreeClasses). */
  tree(def: IrClassDef): boolean;
}

/** Whether `mod` can construct a WeakMap or WeakSet, directly or through
 * a stored global constructor. A weak collection's entry for a key goes
 * when the key is freed, and an arena object is never freed on its own, so
 * such programs use no arenas. */
function constructsWeakCollections(mod: IrModule): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (node.kind === "libCall") {
      if (node.fn === "weakMap.new" || node.fn === "weakSet.new") found = true;
      else if (node.fn === "dyn.globalConstructor") {
        const name = node.args[0];
        if (name?.kind !== "strLit" || name.value === "WeakMap" || name.value === "WeakSet")
          found = true;
      }
    }
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) visit(k);
  };
  for (const fn of mod.functions) for (const s of fn.body) visit(s);
  return found;
}

/** Programs with more functions than this use no arenas: the analysis
 * visits every function, and on programs this large it costs more compile
 * time than their arenas save at run time. */
const ARENA_FUNCTION_LIMIT = 4000;

/** The arena plan of `mod`, or null when nothing would use an arena. */
export function planArenas(mod: IrModule, eligible: ArenaEligibility): ArenaPlan | null {
  if (mod.functions.length > ARENA_FUNCTION_LIMIT || constructsWeakCollections(mod)) return null;
  const groups = analyzeRegionGroups(mod);
  const sites = planRegionSites(mod, groups);
  if (groups.roots.size === 0 && groups.calls.size === 0) return null;
  const shapes = new Set<string>();
  const classes = new Set<string>();
  const defs = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const note = (node: Node): void => {
    const kept = sites.arenaSites.has(node) || groups.roots.has(node);
    if (
      kept &&
      node.kind === "recordLit" &&
      node.type.kind === "record" &&
      eligible.shape(node.type.shapeId)
    )
      shapes.add(node.type.shapeId);
    if (kept && node.kind === "new") {
      const def = defs.get(node.className);
      if (def !== undefined && eligible.cls(def)) classes.add(node.className);
    }
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) note(k);
  };
  for (const fn of mod.functions)
    if (groups.reachable.has(fn.name)) for (const s of fn.body) note(s);
  for (const r of groups.roots) if (r.kind === "new") note(r);
  // A group's heap objects die when its arena drops, unless heap objects
  // hold each other in a cycle: the collector frees those later, and by
  // then their references into the arena point at recycled memory. So a
  // group keeps its arena only if every cycle-capable object it can
  // allocate takes the arena.
  const takesArena = (node: Node): boolean =>
    (sites.arenaSites.has(node) || groups.roots.has(node)) &&
    ((node.kind === "recordLit" && node.type.kind === "record" && shapes.has(node.type.shapeId)) ||
      (node.kind === "new" && classes.has(node.className)) ||
      node.kind === "arrayLit");
  // The same holds for a value on the heap that holds a reference into the
  // group from outside it (RegionGroups.holders; holdValues sent it to the
  // heap): a group keeps its arena only if no such value can be on a cycle.
  // A holder that opens an arena of its own is judged as that group.
  let allocators: Set<string> | null = null;
  const fnNames = new Set(mod.functions.map((f) => f.name));
  const heldInCycle = (r: Node): boolean => {
    if (!opensArena(groups, r)) return false;
    for (const h of groups.holders(r)) {
      // Only a call that allocates can make a cycle: one that allocates
      // nothing hands back what it was given, and a copy is a single object
      // that the root's proof lets nothing else refer to.
      if (h.kind !== "call" || !sites.heldCalls.has(h)) continue;
      allocators ??= cycleCapableAllocators(mod, eligible.traced);
      if (allocators.has(h.callee) || !fnNames.has(h.callee)) return true;
    }
    return false;
  };
  const dropUnsafe = (): boolean => {
    const unsafe = cycleUnsafeFunctions(mod, groups.reachable, sites, takesArena, eligible.traced);
    let dropped = false;
    for (const r of [...groups.roots, ...groups.calls]) {
      const runs = reachableFrom(mod, [r]);
      if (
        [...runs].some((f) => unsafe.has(f)) ||
        (r.kind === "new" && !takesArena(r)) ||
        heldInCycle(r)
      ) {
        groups.roots.delete(r);
        groups.calls.delete(r);
        groups.drops.delete(r);
        dropped = true;
      }
    }
    return dropped;
  };
  // A root that lost its arena here may hold a reference into the group of
  // one that keeps its own: it takes the heap from now on (holdValues),
  // and a call that runs with the arena suspended can make a group unsafe.
  for (let again = dropUnsafe(); again;) again = holdValues(mod, groups, sites) && dropUnsafe();
  if (groups.roots.size === 0 && groups.calls.size === 0) return null;
  groups.reachable = reachableFrom(mod, [...groups.roots, ...groups.calls]);
  const treeClasses = arenaTreeClasses(mod, groups, sites, defs, eligible);
  for (const name of treeClasses) classes.add(name);
  const arenaType = (t: IrType): boolean => {
    if (t.kind === "object") return classes.has(t.className);
    if (t.kind === "record") return shapes.has(t.shapeId);
    if (t.kind === "union") {
      const arm = eligible.nullableArm(t.unionId);
      return arm !== null && arenaType(arm);
    }
    // Arrays of arena objects: kept array literals of them take the arena.
    return t.kind === "array" && t.elem.kind !== "union" && arenaType(t.elem);
  };
  const keptSite = (e: Node): boolean => sites.arenaSites.has(e) || groups.roots.has(e);
  const close = (): { closed: Set<Node>; allClosed: boolean } => {
    const closed = analyzeClosedGroups(mod, groups, arenaType, keptSite);
    return {
      closed,
      allClosed: [...groups.roots, ...groups.calls].every((r) => closed.has(r)),
    };
  };
  let { closed, allClosed } = close();
  // An open (not closed) root caps its arena at SCR_ARENA_CAP and sends the
  // rest of its allocations to the heap. A tree node has no count, so one
  // that fell back to the heap would have nothing to free it: adopt tree
  // classes only when every group is closed and the arena takes every byte.
  if (!allClosed && treeClasses.size > 0) {
    for (const name of treeClasses) classes.delete(name);
    ({ closed, allClosed } = close());
  }
  for (const r of closed) groups.closed.add(r);
  return { groups, sites, shapes, classes, allClosed };
}

/** Whether `node` allocates an object that can be on a reference cycle. */
function allocatesCycleCapable(node: Node, traced: (t: IrType) => boolean): boolean {
  return (
    isExpr(node) &&
    traced(node.type) &&
    (node.kind === "closure"
      ? node.captures.length > 0
      : (ALLOCATIONS.has(node.kind) || source(node) || node.kind === "libCall") &&
        node.kind !== "call" &&
        node.kind !== "callValue" &&
        node.kind !== "virtualCall")
  );
}

const NO_CALLEES: readonly string[] = [];

/** The functions `node` itself calls, constructs or makes a closure of;
 * null when it calls a function the call graph cannot name (a function
 * value, a dynamic call, a virtual call with no known target).
 *
 * A closure's allocations are found in the function that makes it, not in
 * the one that calls it: `tie(xs, cb) { return cb(xs) }` allocates nothing
 * a direct edge leads to, and still hands back the ring its callback tied
 * around `xs`. So a call of an unnamed function counts as allocating a
 * cycle-capable object wherever these edges are followed. */
function calleesOf(vt: VirtualTargets, node: Node): readonly string[] | null {
  switch (node.kind) {
    case "call":
      return [node.callee];
    case "new":
      return [`%${node.className}.constructor`];
    case "closure":
      return [node.fnName];
    case "virtualCall": {
      const targets = vt.targets(node.className, node.method);
      return targets !== null && targets.length > 0 ? targets : null;
    }
    case "callValue":
    case "newValue":
    case "dynCall":
    case "dynInvoke":
      return null;
    default:
      return NO_CALLEES;
  }
}

/** The functions of `mod` that can allocate a cycle-capable object, by
 * themselves or through a function they call, construct or make a closure
 * of, or through a function they call that the call graph cannot name
 * (calleesOf). A throw has the type of the value it stands in for and
 * makes none. */
function cycleCapableAllocators(mod: IrModule, traced: (t: IrType) => boolean): Set<string> {
  const out = new Set<string>();
  const callers = new Map<string, string[]>();
  const vt = new VirtualTargets(mod.classes ?? []);
  for (const fn of mod.functions)
    forEachNode(fn.body, (node) => {
      if (isExpr(node) && !throws(node) && allocatesCycleCapable(node, traced)) out.add(fn.name);
      const callees = calleesOf(vt, node);
      if (callees === null) {
        out.add(fn.name);
        return;
      }
      for (const callee of callees) {
        const list = callers.get(callee);
        if (list === undefined) callers.set(callee, [fn.name]);
        else list.push(fn.name);
      }
    });
  const queue = [...out];
  while (queue.length > 0)
    for (const caller of callers.get(queue.pop()!) ?? [])
      if (!out.has(caller)) {
        out.add(caller);
        queue.push(caller);
      }
  return out;
}

/** The functions in `reachable` that can allocate a cycle-capable object
 * on the heap while an arena is open: one that does not take the arena
 * (`takesArena`), or a call that runs with the arena suspended and reaches
 * any cycle-capable allocation. */
function cycleUnsafeFunctions(
  mod: IrModule,
  reachable: ReadonlySet<string>,
  sites: RegionSites,
  takesArena: (node: Node) => boolean,
  traced: (t: IrType) => boolean,
): Set<string> {
  const fns = new Map(mod.functions.map((f) => [f.name, f]));
  const vt = new VirtualTargets(mod.classes ?? []);
  const allocatesTraced = (node: Node): boolean => allocatesCycleCapable(node, traced);
  // Functions with a cycle-capable allocation (their own, or that of a
  // function they call that the call graph cannot name), and what they call.
  const direct = new Set<string>();
  const calls = new Map<string, Set<string>>();
  const heap = new Set<string>();
  for (const name of reachable) {
    const fn = fns.get(name);
    if (fn === undefined) continue;
    const out = new Set<string>();
    calls.set(name, out);
    forEachNode(fn.body, (node) => {
      if (allocatesTraced(node)) {
        direct.add(name);
        if (!takesArena(node)) heap.add(name);
      }
      const callees = calleesOf(vt, node);
      if (callees === null) direct.add(name);
      else for (const callee of callees) out.add(callee);
    });
  }
  const tracedSomewhere = new Set(direct);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, out] of calls)
      if (!tracedSomewhere.has(name) && [...out].some((c) => tracedSomewhere.has(c))) {
        tracedSomewhere.add(name);
        changed = true;
      }
  }
  for (const name of reachable) {
    const fn = fns.get(name);
    if (fn === undefined || heap.has(name)) continue;
    forEachNode(fn.body, (node) => {
      if (!sites.heapCalls.has(node)) return;
      const target =
        node.kind === "call"
          ? node.callee
          : node.kind === "new"
            ? `%${node.className}.constructor`
            : null;
      // A suspended call of an unknown function (a closure, a virtual call)
      // may allocate anything.
      if (target === null || tracedSomewhere.has(target)) heap.add(name);
    });
  }
  return heap;
}

/** The tree classes whose nodes a group arena may reclaim, with the proof
 * that lets it happen: every node of an adopted tree is allocated in the
 * arena of the tree's root, so the drop reclaims the whole subtree at the
 * moment the tree dies and no node ever needs a free of its own.
 *
 * A tree node is uniquely owned, acyclic and headerless (backend/
 * tree-classes.ts): nothing outside its owner can reach it, no counted path
 * ever sees it, and its memory can be reclaimed wholesale like the rest of
 * its group. Ownership does not change; only where the bytes come from.
 * What the proof adds is that the node cannot outlive the arena's drop:
 *
 * - every `new C` in the module takes an arena, so no instance is one the
 *   heap fallback allocated. A root opens an arena itself; every other site
 *   must be a kept site in a function that always runs inside an open arena
 *   (`guardedFunctions`), so the arena-aware constructor never misses.
 * - the function holding a non-root site opens no arena of its own, so a
 *   node lands in the arena of the root it belongs to, not in a nested one
 *   that closes and drops earlier.
 *
 * `guardedFunctions` bounds calls the call graph cannot name by the
 * module's own function values (every closure body), constructors and
 * methods, so no statically defined function escapes the check.
 *
 * The region plan already proves the root's value dies no later than its
 * arena's drop, and a tree's nodes are reachable only from that value, so
 * the drop is the tree's teardown. */
function arenaTreeClasses(
  mod: IrModule,
  groups: RegionGroups,
  sites: RegionSites,
  defs: ReadonlyMap<string, IrClassDef>,
  eligible: ArenaEligibility,
): Set<string> {
  const out = new Set<string>();
  const news = new Map<string, { node: Node; fn: string }[]>();
  for (const fn of mod.functions)
    forEachNode(fn.body, (node) => {
      if (node.kind !== "new") return;
      const list = news.get(node.className);
      if (list === undefined) news.set(node.className, [{ node, fn: fn.name }]);
      else list.push({ node, fn: fn.name });
    });
  if (news.size === 0) return out;
  const unguarded = guardedFunctions(mod, groups, sites);
  // The functions that open an arena of their own, by name.
  const opens = new Set<string>();
  for (const fn of mod.functions)
    forEachNode(fn.body, (node) => {
      if (groups.roots.has(node) || groups.calls.has(node)) opens.add(fn.name);
    });
  for (const [name, created] of news) {
    const def = defs.get(name);
    if (def === undefined || !eligible.tree(def)) continue;
    const ok = created.every(
      ({ node, fn }) =>
        groups.roots.has(node) ||
        (sites.arenaSites.has(node) &&
          groups.reachable.has(fn) &&
          !unguarded.has(fn) &&
          !opens.has(fn)),
    );
    if (ok) out.add(name);
  }
  return out;
}

/** The arena-aware constructor of a record shape or class. */
export function arenaNewSym(newSym: string): string {
  return `${newSym}.r`;
}

/** The function that releases an arena object's fields at the drop. */
export function arenaDisposeSym(newSym: string): string {
  return `${newSym}.dispose`;
}

/** Whether `fn` allocates through arena-aware constructors. */
export function arenaAware(plan: ArenaPlan | null, fn: IrFunction | undefined): boolean {
  return plan !== null && fn !== undefined && plan.groups.reachable.has(fn.name);
}

/** What arenaNewLines needs from its host (a subset of ShapeHost). */
export interface ArenaHost {
  declare(decl: string): void;
  /** A constant string's LLVM operand. */
  cstr(text: string): string;
  threadLocalAlloc?: boolean;
  inlineAlloc?: boolean;
  /** The target C ABI's `size_t`: also the pointer width. */
  readonly sizeType: "i32" | "i64";
}

/** Instructions that set `dest` to the address of the calling thread's
 * open arena pointer (scr_arena.c's scr_arena_cur), or null on targets
 * without the inline allocator, which call scr_arena_current,
 * scr_arena_suspend and scr_arena_resume instead. In worker programs the
 * pointer is thread-local. */
export function arenaCurrentAddress(host: ArenaHost, dest: string): string[] | null {
  if (host.inlineAlloc !== true) return null;
  if (host.threadLocalAlloc !== true) {
    host.declare(`@scr_arena_cur = external global ptr`);
    return [`${dest} = getelementptr inbounds i8, ptr @scr_arena_cur, i64 0`];
  }
  host.declare(`@scr_arena_cur = external thread_local global ptr`);
  host.declare(`declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)`);
  return [`${dest} = call ptr @llvm.threadlocal.address.p0(ptr @scr_arena_cur)`];
}

/**
 * The arena-aware constructor `<new>.r`: an object of `size` bytes (a
 * `size_t` constant expression) in the current arena, behind the collector header
 * `cyc` names (or none), which `init` sets up the way the heap constructor
 * does (with the count ARENA_RC). When `dispose` names a function and the
 * arena is not closed, the object goes on the arena's dispose list, which
 * the drop runs. The heap constructor's object when no arena is open or
 * the arena is full, unless `miss` is `trap`: an adopted tree node has no
 * count word, so a heap copy of it could never be freed, and the plan
 * proves the heap path unreachable (arenas.ts, arenaTreeClasses). The bump,
 * the clear, the header and the dispose entry are inline (scr_arena.c's
 * ScrArena ABI); scr_arena_obj takes a new chunk and scr_arena_disposal
 * grows the list.
 *
 * `clear` is what the bump path zeroes: the whole object, or only the
 * collector header, for callers that store every word of the object before
 * anything reads it (a record literal of a shape with no dispose entries:
 * `init` stores the count and the shape number, and the literal every
 * field). scr_arena_obj and the heap constructor return zeroed objects.
 */
export function arenaNewLines(
  host: ArenaHost,
  newSym: string,
  size: string,
  cyc: string | null,
  dispose: string | null,
  init: string[],
  result: string,
  clear: "object" | "header" = "object",
  /** What to do when no arena is open (or the arena cannot take the
   * object): allocate on the heap, or, for a tree node that has no count
   * word and so could never be freed there, stop. */
  miss: "heap" | "trap" = "heap",
): string[] {
  const S = host.sizeType;
  const fail = miss === "trap" ? "miss" : "heap";
  // ScrArena's fields and dispose entries are pointer-sized (scr_arena.c).
  const word = S === "i32" ? 4 : 8;
  host.declare(`declare ptr @scr_arena_obj(ptr, ${S}, ptr)`);
  host.declare(`declare void @llvm.memset.p0.${S}(ptr, i8, ${S}, i1)`);
  const cur = arenaCurrentAddress(host, "%cur");
  const current =
    cur === null
      ? (host.declare(`declare ptr @scr_arena_current()`), [`  %a = call ptr @scr_arena_current()`])
      : [...cur.map((line) => `  ${line}`), `  %a = load ptr, ptr %cur`];
  const lines: string[] = [
    `define internal ptr @${arenaNewSym(newSym)}() nounwind alwaysinline { ; in the open arena`,
    `entry:`,
    ...current,
    `  %on = icmp ne ptr %a, null`,
    `  br i1 %on, label %arena, label %${fail}`,
    `arena:`,
  ];
  // A traced type's first object registers its descriptor on the slow path.
  if (cyc !== null)
    lines.push(
      `  %tidp = getelementptr inbounds ${CYC_TYPE}, ptr ${cyc}, i32 0, i32 3`,
      `  %tid = load atomic i32, ptr %tidp acquire, align 4`,
      `  %creg = icmp ne i32 %tid, 0`,
    );
  const hdr = cyc === null ? 0 : CYC_HDR;
  lines.push(
    `  %n0 = add ${S} ${size}, ${hdr + 7}`,
    `  %n = and ${S} %n0, -8`,
    `  %bp = load ptr, ptr %a`,
    `  %limp = getelementptr inbounds i8, ptr %a, ${S} ${word}`,
    `  %lim = load ptr, ptr %limp`,
    `  %bpi = ptrtoint ptr %bp to ${S}`,
    `  %limi = ptrtoint ptr %lim to ${S}`,
    `  %room = sub ${S} %limi, %bpi`,
    `  %fits0 = icmp ule ${S} %n, %room`,
  );
  if (cyc !== null) lines.push(`  %fits = and i1 %fits0, %creg`);
  lines.push(
    `  br i1 ${cyc === null ? "%fits0" : "%fits"}, label %carve, label %slow`,
    `carve:`,
    `  %end = getelementptr inbounds i8, ptr %bp, ${S} %n`,
    `  store ptr %end, ptr %a`,
  );
  if (clear === "object")
    lines.push(`  call void @llvm.memset.p0.${S}(ptr align 8 %bp, i8 0, ${S} %n, i1 false)`);
  else if (cyc !== null)
    lines.push(
      `  call void @llvm.memset.p0.${S}(ptr align 8 %bp, i8 0, ${S} ${CYC_HDR}, i1 false)`,
    );
  if (cyc !== null)
    lines.push(
      `  %id = trunc i32 %tid to i16`,
      `  store i16 %id, ptr %bp ; ScrCycHdr.id`,
      `  %bufp = getelementptr inbounds i8, ptr %bp, i64 ${CYC_BUF}`,
      `  store i32 -1, ptr %bufp ; ScrCycHdr.buf = SCR_CYC_ACYCLIC`,
    );
  lines.push(
    `  %of = getelementptr inbounds i8, ptr %bp, ${S} ${hdr}`,
    `  br label %init`,
    `slow:`,
    `  %os = call ptr @scr_arena_obj(ptr %a, ${S} ${size}, ptr ${cyc ?? "null"})`,
    `  %got = icmp ne ptr %os, null`,
    `  br i1 %got, label %init, label %${fail}`,
    `init:`,
    `  %o = phi ptr [ %of, %carve ], [ %os, %slow ]`,
    ...init,
  );
  if (dispose !== null) {
    host.declare(`declare void @scr_arena_disposal(ptr, ptr, ptr)`);
    lines.push(
      `  %closedp = getelementptr inbounds i8, ptr %a, ${S} ${4 * word} ; ScrArena.closed`,
      `  %closed = load i32, ptr %closedp`,
      `  %skip = icmp ne i32 %closed, 0`,
      `  br i1 %skip, label %done, label %list`,
      `list:`,
      `  %dpp = getelementptr inbounds i8, ptr %a, ${S} ${2 * word} ; ScrArena.disposals`,
      `  %dp = load ptr, ptr %dpp`,
      `  %dep = getelementptr inbounds i8, ptr %a, ${S} ${3 * word} ; ScrArena.disposals_end`,
      `  %de = load ptr, ptr %dep`,
      `  %full = icmp eq ptr %dp, %de`,
      `  br i1 %full, label %grow, label %push`,
      `push:`,
      `  store ptr %o, ptr %dp ; ScrArenaDisposal.obj`,
      `  %dfp = getelementptr inbounds i8, ptr %dp, ${S} ${word}`,
      `  store ptr @${dispose}, ptr %dfp ; ScrArenaDisposal.dispose`,
      `  %dn = getelementptr inbounds i8, ptr %dp, ${S} ${2 * word}`,
      `  store ptr %dn, ptr %dpp`,
      `  br label %done`,
      `grow:`,
      `  call void @scr_arena_disposal(ptr %a, ptr %o, ptr @${dispose})`,
      `  br label %done`,
      `done:`,
    );
  }
  if (miss === "trap") {
    host.declare(`declare void @scr_trap(ptr)`);
    lines.push(
      `  ret ptr ${result}`,
      `miss:`,
      `  call void @scr_trap(ptr ${host.cstr("scriptc: internal error: a tree node was allocated outside its arena\n")})`,
      `  unreachable`,
      `}`,
      ``,
    );
  } else
    lines.push(
      `  ret ptr ${result}`,
      `heap:`,
      `  %h = call ptr @${newSym}()`,
      `  ret ptr %h`,
      `}`,
      ``,
    );
  return lines;
}

/** Dispose lines for field `i` of `%o` at `ptr` (a getelementptr into
 * `%o`), released by `release`: a plain reference (no union encoding) is
 * released only when it is a heap object, since an arena or immortal
 * object's count (the rc word's low half) is at least 2^28 and its release
 * would change nothing. */
export function disposeFieldLines(
  i: number,
  gep: string,
  plain: boolean,
  release: string,
  comment: string,
): string[] {
  const load = [`  %f${i} = ${gep}`, `  %v${i} = load ptr, ptr %f${i}`];
  if (!plain) return [...load, `  call void ${release}(ptr %v${i}) ; ${comment}`];
  return [
    ...load,
    `  %nn${i} = icmp ne ptr %v${i}, null`,
    `  br i1 %nn${i}, label %chk${i}, label %next${i}`,
    `chk${i}:`,
    `  %rc${i} = load i32, ptr %v${i}`,
    `  %heap${i} = icmp ult i32 %rc${i}, ${2 ** 28}`,
    `  br i1 %heap${i}, label %rel${i}, label %next${i}`,
    `rel${i}:`,
    `  call void ${release}(ptr %v${i}) ; ${comment}`,
    `  br label %next${i}`,
    `next${i}:`,
  ];
}

/** Whether values of `t` are plain pointers to counted objects. */
export function plainRefType(t: IrType): boolean {
  return (
    t.kind === "object" ||
    t.kind === "record" ||
    t.kind === "array" ||
    t.kind === "map" ||
    t.kind === "set" ||
    t.kind === "func" ||
    t.kind === "string"
  );
}

/** The dispose function: releases each reference field (`fields`, lines
 * that load `%v<i>` and release it) of the object `%o`. */
export function arenaDisposeLines(newSym: string, fields: string[]): string[] {
  return [
    `define internal void @${arenaDisposeSym(newSym)}(ptr %o) nounwind { ; arena drop`,
    `entry:`,
    ...fields,
    `  ret void`,
    `}`,
    ``,
  ];
}
