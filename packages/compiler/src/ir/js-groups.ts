/* Object guard groups (shape-tier design 3.3): runs of constant-key reads
 * and stores on one dynamic subject inside one straight-line piece of a
 * function.
 *
 * An inline-cache site answers one read through its own record: kind test,
 * layout test, entry compares, slot load. A group shares one probe of the
 * subject's layout across several keys: the guard establishes the shape
 * once, and each member reads its slot index from the group's entry for
 * that shape. The backend (backend/llvm/js-groups.ts) emits the guard at
 * the first member and reuses the entry for the rest.
 *
 * Membership is a syntactic property of the call tree, so it lives here
 * rather than in the backend:
 *
 * - the subject is a `dyn` local or parameter that the function never
 *   reassigns and no closure captures (a boxed binding can change under a
 *   call);
 * - members are `get` sites of ir/js-ic.ts with a constant key other than
 *   `length` and `next`, and `set` sites that replace such a key of the
 *   same binding with a boxed primitive, in one straight line, in
 *   evaluation order;
 * - a member starts a new group when the subject differs from the current
 *   group's, and control flow (a branch, a short circuit, a sequence, a
 *   closure body) ends a run, because the guard must dominate every
 *   member it answers;
 * - a group has at least two members and at most JS_GROUP_KEYS keys.
 *
 * The plan also marks the members whose entry is not known to answer for
 * the subject. A *clobber* is an operation that may change any object's
 * layout or slots, or run user code; the member after it checks the
 * subject's layout against the entry first, and a member that took the
 * site's helper instead may have left the entry behind the subject's
 * layout, so the members after that check too. A clean member reads
 * through the guard's entry directly.
 *
 * What is not a clobber (design 3.3): grouped reads, grouped stores of a
 * primitive into a key the group holds, jsval arithmetic and comparison
 * fast paths, local moves and constants, number boxing. Every
 * other call may run user code that adds, deletes, defines, freezes or
 * replaces a property, so the default for an unrecognized node is a
 * clobber. */
import type { IrExpr, IrFunction, IrStmt, IrType } from "./ir.js";
import type { JsIcSites } from "./js-ic.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Keys a group may carry: one slot byte per key (ScrJsGroupEntry). */
export const JS_GROUP_KEYS = 8;

export interface JsGroupMember {
  /** The call expression of the site. */
  readonly site: IrExpr & { kind: "call" };
  readonly group: JsGroup;
  /** The member's position in the group, in evaluation order. */
  readonly position: number;
  /** The key's index in the group's key list. */
  readonly index: number;
  /** Whether the group's entry is not known to answer for the subject at
   * this member: a clobbering operation may have reshaped it, or an earlier
   * member's recheck may have found the entry stale. */
  readonly recheck: boolean;
  /** Whether the member reads the key or replaces its value. */
  readonly store: boolean;
}

export interface JsGroup {
  /** Unique within the function, and in creation order. */
  readonly id: number;
  /** The subject binding the members read. */
  readonly subject: string;
  /** The group's keys, in the order they were first read. */
  readonly keys: readonly string[];
  readonly members: readonly JsGroupMember[];
}

/** The groups of one function, and the member a site call belongs to. */
export class JsGroupPlan {
  readonly groups: JsGroup[];
  private readonly members = new Map<IrExpr, JsGroupMember>();

  constructor(groups: JsGroup[]) {
    this.groups = groups;
    for (const group of groups)
      for (const member of group.members) this.members.set(member.site, member);
  }

  /** The group member a call expression is, or undefined. */
  member(site: IrExpr): JsGroupMember | undefined {
    return this.members.get(site);
  }
}

/** Plans the groups of `fn`. `sites` classifies the callees, and `excluded`
 * names the ones the backend does not turn into cache sites (ir/... integer
 * ABI clones). */
export function planJsGroups(
  fn: IrFunction,
  sites: Pick<JsIcSites, "site">,
  excluded?: { has(callee: string): boolean },
): JsGroupPlan {
  const subjects = groupableSubjects(fn);
  if (subjects.size === 0) return new JsGroupPlan([]);

  const candidates: Candidate[] = [];
  let run: Candidate | null = null;
  let clobbered = false;
  /** Branching nodes being walked: the guard of a run cannot dominate
   * members in two branches, so nothing inside one is a member. */
  let blocked = 0;

  const endRun = (): void => {
    if (run !== null && run.members.length >= 2) candidates.push(run);
    run = null;
  };
  const clobber = (): void => {
    clobbered = true;
  };
  const barrier = (): void => {
    endRun();
    clobbered = false;
  };
  /** The statement callback of the shared walkers, which stop on false. */
  const visit = (s: IrStmt): boolean => {
    stmt(s);
    return true;
  };

  const expr = (e: IrExpr): boolean => {
    // A node that branches ends the run before its operands and after
    // them, and nothing inside it joins a run: members of two branches
    // have no common guard point.
    const branching = BARRIERS.has(e.kind);
    if (branching) {
      endRun();
      clobbered = false;
      blocked++;
    }
    // Children first: a call's arguments are evaluated before the call
    // itself, so a member inside them belongs to the run before its
    // clobber.
    const children = everyExprChild(e, expr, visit);
    if (branching) {
      blocked--;
      barrier();
      return children;
    }
    if (e.kind === "call") {
      const site = blocked === 0 && excluded?.has(e.callee) !== true ? sites.site(e.callee) : null;
      let subject: string | null = null;
      let key: string | null = null;
      let store = false;
      if (site !== null && site.kind !== "keyed" && site.key !== "length" && site.key !== "next") {
        if (site.kind === "get") subject = memberSubject(e);
        else {
          subject = storeSubject(e, site.key);
          store = subject !== null;
        }
        key = site.key;
      }
      if (subject === null || key === null || !subjects.has(subject)) {
        clobber();
        return children;
      }
      if (run === null || run.subject !== subject) {
        endRun();
        run = { subject, keys: [], members: [] };
        clobbered = false;
      }
      let index = run.keys.indexOf(key);
      if (index < 0) {
        if (run.keys.length >= JS_GROUP_KEYS) {
          // The entry holds one byte per key: a run that needs a ninth
          // key starts over after it.
          endRun();
          run = { subject, keys: [], members: [] };
          clobbered = false;
        }
        index = run.keys.length;
        run.keys.push(key);
      }
      const recheck = clobbered;
      run.members.push({ site: e, key, index, recheck, store });
      // A member that rechecks may instead have taken its slow path, the
      // site's own helper, which leaves the group's entry unanswered for
      // the subject's current layout: every later member checks the shape
      // again. (A store's slow path can also add a key.) Only a clean
      // member keeps the entry that answers the members after it.
      clobbered = recheck;
      return children;
    }
    if (!NEUTRAL.has(e.kind) && !neutralCall(e)) clobber();
    return children;
  };

  /** A list of statements in a straight line: a run continues across them. */
  const sequence = (list: readonly IrStmt[]): void => {
    for (const s of list) stmt(s);
  };
  /** The statements of one arm, loop body or handler: they form their own
   * runs, and no run crosses either edge. */
  const arm = (list: readonly IrStmt[] | null): void => {
    if (list === null) return;
    barrier();
    sequence(list);
    barrier();
  };
  /** An operand evaluated at its own point of the control flow (a condition,
   * a loop's init and update): no run crosses it. */
  const operand = (e: IrExpr | null): void => {
    if (e === null) return;
    barrier();
    expr(e);
    barrier();
  };
  const operandStmt = (s: IrStmt | null): void => {
    if (s === null) return;
    barrier();
    stmt(s);
    barrier();
  };

  /** The plain expression walk of a statement that only evaluates operands:
   * a run continues across it. */
  const operands = (s: IrStmt): void => {
    everyStmtChild(s, expr, visit);
  };

  const stmt = (s: IrStmt): void => {
    switch (s.kind) {
      // Statements that only evaluate their operands: the subject of a run
      // cannot be one of the bindings they write (a reassigned binding is
      // never a subject), and none of them can reshape an object.
      case "exprStmt":
      case "assign":
      case "varDecl":
      case "fieldSet":
      case "arraySet":
      case "arraySetLength":
      case "arraySetUndefined":
      case "arrayDelete":
      case "bytesSet":
      case "recordSet":
      case "recordKeySet":
      case "recordKeyDelete":
      case "runtimeFence":
      case "genBindBarrier":
        operands(s);
        return;
      case "block":
        sequence(s.body);
        return;
      // A jump leaves the run behind, whatever follows it starts its own.
      case "return":
      case "throw":
      case "break":
      case "continue":
      case "rethrow":
        operands(s);
        barrier();
        return;
      case "if":
        operand(s.cond);
        arm(s.then);
        arm(s.else_);
        return;
      case "while":
        operand(s.cond);
        arm(s.body);
        return;
      case "doWhile":
        arm(s.body);
        operand(s.cond);
        return;
      case "for":
        operandStmt(s.init);
        operand(s.cond);
        operandStmt(s.update);
        arm(s.body);
        return;
      case "forOf":
        operand(s.iterable);
        arm(s.body);
        return;
      case "switch":
        operand(s.disc);
        for (const clause of s.cases) {
          operand(clause.test);
          arm(clause.body);
        }
        return;
      case "tryCatch":
        arm(s.tryBody);
        arm(s.catchBody);
        arm(s.finallyBody);
        return;
    }
    s satisfies never;
  };

  for (const statement of fn.body) stmt(statement);
  barrier();

  const groups: JsGroup[] = [];
  for (const candidate of candidates) {
    // The members name their group, so the group is built around its
    // list before the list is filled.
    const members: JsGroupMember[] = [];
    const group: JsGroup = {
      id: groups.length,
      subject: candidate.subject,
      keys: candidate.keys,
      members,
    };
    for (let position = 0; position < candidate.members.length; position++) {
      const m = candidate.members[position]!;
      members.push({
        site: m.site,
        group,
        position,
        index: m.index,
        recheck: m.recheck,
        store: m.store,
      });
    }
    groups.push(group);
  }
  return new JsGroupPlan(groups);
}

interface Candidate {
  readonly subject: string;
  readonly keys: string[];
  readonly members: {
    site: IrExpr & { kind: "call" };
    key: string;
    index: number;
    recheck: boolean;
    store: boolean;
  }[];
}

/** The subject a call reads, when the call is a constant-key read of a
 * stable `dyn` binding. */
function memberSubject(e: IrExpr & { kind: "call" }): string | null {
  if (e.args.length !== 1) return null;
  const receiver = e.args[0]!;
  if (receiver.kind !== "varRef" || receiver.type.kind !== "dyn") return null;
  return receiver.localId;
}

/** The subject a call writes, when the call replaces a constant key of a
 * stable `dyn` binding with an inert value. `key` is the site's key. */
function storeSubject(e: IrExpr & { kind: "call" }, key: string): string | null {
  if (e.args.length !== 2) return null;
  const receiver = e.args[0]!;
  if (receiver.kind !== "varRef" || receiver.type.kind !== "dyn") return null;
  // A store to one of these runs the interpreter's error synchronization
  // around the value, which no inline slot write does.
  if (ERROR_SYNCED_KEYS.has(key)) return null;
  if (!inertValue(e.args[1]!)) return null;
  return receiver.localId;
}

/** Whether `value` is a static primitive boxed for the store. The parse
 * region treats such values as inert, so the write barrier cannot fire,
 * and a slot write to a key the guard's entry holds leaves the shape
 * alone. A store site makes the same deduction: a region a store of an
 * inert value reaches keeps its `intact` flag, so the site needs no probe
 * to apply the barrier. */
export function inertValue(value: IrExpr): boolean {
  if (value.kind === "dynFrom")
    return (
      value.liveRef === undefined &&
      value.fnName === undefined &&
      INERT_SOURCES.has(value.value.type.kind)
    );
  return (
    value.kind === "libCall" &&
    value.fn === "js.toDyn" &&
    INERT_SOURCES.has(value.args[0]!.type.kind)
  );
}

/** Type kinds whose dyn conversion is one of the region's inert values
 * (scr_dyn.h: numbers, strings, booleans, null). */
const INERT_SOURCES: ReadonlySet<IrType["kind"]> = new Set<IrType["kind"]>([
  "f64",
  "bool",
  "string",
]);

/** Keys whose store the interpreter synchronizes with an Error's fields. */
const ERROR_SYNCED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "code",
  "cause",
  "stack",
  "message",
]);

/** The `dyn` bindings a group may name: never reassigned and never
 * captured (a captured binding lives in a box a call can write). The scan
 * descends into expression operands: an assignment there changes which
 * object the binding names just as a statement does. */
function groupableSubjects(fn: IrFunction): Set<string> {
  const reassigned = new Set<string>();
  const note = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr" || e.kind === "incDec") reassigned.add(e.localId);
    return everyExprChild(e, note, noteStmt);
  };
  const noteStmt = (s: IrStmt): boolean => {
    if (s.kind === "assign" && s.initializes !== true) reassigned.add(s.localId);
    return everyStmtChild(s, note, noteStmt);
  };
  for (const s of fn.body) noteStmt(s);
  const subjects = new Set<string>();
  for (const local of fn.locals)
    if (local.type.kind === "dyn" && local.boxed !== true && !reassigned.has(local.id))
      subjects.add(local.id);
  return subjects;
}

/** Expression kinds that carry no call, no write a later member could
 * observe, and no branch: the design's non-clobbering operations. */
const NEUTRAL: ReadonlySet<IrExpr["kind"]> = new Set<IrExpr["kind"]>([
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "varRef",
  "moduleNsRef",
  "selfRef",
  "bin",
  "unary",
  "toBool",
  "strEq",
  "strCmp",
  "strConcat",
  "dynTest",
  "dynFrom",
  "upcast",
  "downcast",
]);

/** Expression kinds whose evaluation branches or runs a body: the guard of
 * a run cannot dominate a member behind one. */
const BARRIERS: ReadonlySet<IrExpr["kind"]> = new Set<IrExpr["kind"]>([
  "ternary",
  "logical",
  "nullish",
  "orDefault",
  "optChain",
  "seqExpr",
  "closure",
  "callValue",
  "dynCall",
  "dynInvoke",
  "awaitExpr",
  "awaitUnionExpr",
  "yieldExpr",
  "genResume",
  "newPromise",
  "promiseWithResolvers",
  "dynObjLit",
  "dynArrLit",
  "arrayLit",
  "recordLit",
  "recordClone",
  "regexLit",
  "templateStrings",
  "regexIntrinsic",
  "strIntrinsic",
  "arrIntrinsic",
  "mapIntrinsic",
  "setIntrinsic",
  "bytesIntrinsic",
  "bytesNew",
  "mapNew",
  "setNew",
  "arrayNewLen",
]);

/** The library calls that only rewrap the member value they are given. */
function neutralCall(e: IrExpr): boolean {
  return e.kind === "libCall" && (e.fn === "js.toDyn" || e.fn === "js.fromDyn");
}
