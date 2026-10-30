/* Whole-program stack-trace gate (see observesStacks). Pure function of the
 * IR module; the emitter keeps a source frame in every function only when
 * it answers true. */
import {
  exprFunctionReference,
  FUNCTION_REFERENCE_KINDS,
  moduleFunctionReferences,
} from "../ir/function-references.js";
import {
  eachNodeOfKinds,
  type IrKindScan,
  type IrNodeIndex,
  type IrNodeKind,
} from "../ir/node-index.js";
import { MAY_THROW_LIB_FNS } from "../ir/builtin-effects.js";
import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { MAY_THROW_ARR_METHODS } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import { unreachableStatements } from "./may-throw.js";
import type { PublishedTypes } from "./publication.js";
import { writesPublished } from "./publication.js";

/** The nodes the scans below read: stack reads, the "stack" literal, call
 * sites and function references, declarations. */
const STACK_READ_KINDS: readonly IrNodeKind[] = ["libCall", "dynKeyGet"];
const STRING_KINDS: readonly IrNodeKind[] = ["strLit"];
const CENSUS_KINDS: readonly IrNodeKind[] = ["call", ...FUNCTION_REFERENCE_KINDS];
const DECLARATION_KINDS: readonly IrNodeKind[] = ["varDecl"];

/** Lib calls that read a captured stack trace. */
const STACK_READS: ReadonlySet<string> = new Set(["error.stack"]);

/** Key types whose property names are never `stack`: a number, bigint or
 * boolean key names its decimal or `true`/`false` property. */
const NON_STACK_KEY_TYPES: ReadonlySet<IrType["kind"]> = new Set(["f64", "bigint", "bool"]);

/** Whether a computed key can be the string "stack", the question a read
 * on a checked-dynamic value asks before it counts as a stack read.
 * - A string literal answers by its value; a key of a number, bigint or
 *   boolean type, or one converted from such a value, cannot be "stack".
 * - An immutable local answers with its one initializer, and a parameter of
 *   a function the program only calls by name answers with the arguments
 *   its call sites pass.
 * - Any other key can be "stack" when the program spells the literal
 *   "stack" somewhere, since the literal can reach the key through fields,
 *   containers or calls; a key the program assembles from other strings or
 *   from data it reads keeps the static answer. */
class StackKeys {
  private spelled: boolean | undefined;
  private census:
    | { calls: Map<string, { caller: IrFunction; args: IrExpr[] }[]>; named: Set<string> }
    | undefined;
  private readonly inits = new Map<IrFunction, Map<string, IrExpr | null>>();
  /** Settled answers by function and local: true where a search reached a
   * key that can be "stack", false where a search that found none passed. */
  private readonly answers = new Map<string, boolean>();

  // The module walks run on the first question that needs them: a program
  // without a dynamic key read asks none.
  constructor(
    private readonly mod: IrModule,
    private readonly nodes: IrNodeIndex | undefined,
  ) {}

  private spellsStack(): boolean {
    return (this.spelled ??= spellsStack(this.mod, this.nodes));
  }

  private callCensus(): {
    calls: Map<string, { caller: IrFunction; args: IrExpr[] }[]>;
    named: Set<string>;
  } {
    if (this.census !== undefined) return this.census;
    const mod = this.mod;
    const calls = new Map<string, { caller: IrFunction; args: IrExpr[] }[]>();
    const named = new Set(moduleFunctionReferences(mod));
    // Class methods, accessors and constructors are called through dispatch.
    const classNames = new Set((mod.classes ?? []).map((cls) => cls.name));
    const scan = this.nodes?.scan(CENSUS_KINDS);
    for (const fn of mod.functions) {
      if (isClassMember(fn.name, classNames)) named.add(fn.name);
      eachNodeOfKinds(fn, scan, (node) => {
        if (node.kind === "call") {
          const sites = calls.get(node.callee) ?? [];
          sites.push({ caller: fn, args: node.args });
          calls.set(node.callee, sites);
        } else if (node.kind === "closure" || node.kind === "orDefault") {
          const referenced = exprFunctionReference(node);
          if (referenced !== undefined) named.add(referenced);
        }
      });
    }
    return (this.census = { calls, named });
  }

  mayBeStack(fn: IrFunction, key: IrExpr): boolean {
    const visited = new Set<string>();
    const answer = this.keyMayBeStack(fn, key, visited);
    // A search that found no way to "stack" explored everything it visited
    // to the end, so none of it can be "stack" either.
    if (!answer) for (const visit of visited) this.answers.set(visit, false);
    return answer;
  }

  private keyMayBeStack(fn: IrFunction, key: IrExpr, visited: Set<string>): boolean {
    if (key.kind === "strLit") return key.value === "stack";
    if (!this.spellsStack()) return false;
    if (NON_STACK_KEY_TYPES.has(key.type.kind)) return false;
    if (key.kind === "toString" && NON_STACK_KEY_TYPES.has(key.operand.type.kind)) return false;
    if (key.kind === "dynFrom" && NON_STACK_KEY_TYPES.has(key.value.type.kind)) return false;
    if (key.kind !== "varRef") return true;
    const visit = `${fn.name}\0${key.localId}`;
    const known = this.answers.get(visit);
    if (known !== undefined) return known;
    // Each local is searched once per question: a cycle, or a second path
    // to a local already searched, adds no value of its own.
    if (visited.has(visit)) return false;
    visited.add(visit);
    const answer = this.localMayBeStack(fn, key.localId, visited);
    if (answer) this.answers.set(visit, true);
    return answer;
  }

  private localMayBeStack(fn: IrFunction, localId: string, visited: Set<string>): boolean {
    const local = fn.locals.find((candidate) => candidate.id === localId);
    if (local === undefined || local.mutable) return true;
    const index = fn.params.findIndex((param) => param.localId === localId);
    if (index !== -1) {
      const { calls, named } = this.callCensus();
      const sites = calls.get(fn.name);
      if (named.has(fn.name) || sites === undefined) return true;
      return sites.some(
        (site) =>
          site.args.length !== fn.params.length ||
          this.keyMayBeStack(site.caller, site.args[index]!, visited),
      );
    }
    const init = this.initializerOf(fn, localId);
    return init === null || this.keyMayBeStack(fn, init, visited);
  }

  /** The one initializer of an immutable local, or null when it has none
   * or more than one declaration. */
  private initializerOf(fn: IrFunction, localId: string): IrExpr | null {
    let inits = this.inits.get(fn);
    if (inits === undefined) {
      inits = new Map();
      eachNodeOfKinds(fn, this.nodes?.scan(DECLARATION_KINDS), (node) => {
        if (node.kind === "varDecl")
          inits!.set(node.localId, inits!.has(node.localId) ? null : (node.init ?? null));
      });
      this.inits.set(fn, inits);
    }
    return inits.get(localId) ?? null;
  }
}

/** Whether `name` follows the `%<class>.<member>` convention of class
 * methods, accessors and constructors for one of `classNames`. */
function isClassMember(name: string, classNames: ReadonlySet<string>): boolean {
  if (!name.startsWith("%")) return false;
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    if (classNames.has(name.slice(1, dot))) return true;
  }
  return false;
}

/** A typed `error.stack` read, or a read on a checked-dynamic value that
 * can reach an error's own `stack` accessor: one whose key can be "stack"
 * (StackKeys). */
function readsStack(fn: IrFunction, expr: IrExpr, keys: StackKeys): boolean {
  if (expr.kind === "libCall") return STACK_READS.has(expr.fn);
  if (expr.kind !== "dynKeyGet") return false;
  return keys.mayBeStack(fn, expr.key);
}

/** Whether the module contains the string literal "stack". */
function spellsStack(mod: IrModule, nodes: IrNodeIndex | undefined): boolean {
  const scan = nodes?.scan(STRING_KINDS);
  return mod.functions.some((fn) => {
    let found = false;
    eachNodeOfKinds(fn, scan, (node) => {
      found = node.kind === "strLit" && node.value === "stack";
      return !found;
    });
    return found;
  });
}

function containsStackRead(fn: IrFunction, keys: StackKeys, scan: IrKindScan | undefined): boolean {
  let found = false;
  eachNodeOfKinds(fn, scan, (node, statement) => {
    found = !statement && readsStack(fn, node as IrExpr, keys);
    return !found;
  });
  return found;
}

/** Visit every expression of `body` that execution can reach: statements
 * after one that cannot complete normally in the same list are skipped. */
function visitLiveExprs(body: IrStmt[], visit: (expr: IrExpr) => void): void {
  const dead = unreachableStatements(body);
  const expr = (node: IrExpr): boolean => {
    visit(node);
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => dead.has(node) || everyStmtChild(node, expr, stmt);
  body.every(stmt);
}

/** Whether the program can read a captured stack trace, which is what makes
 * every function keep a source frame. A read counts when it can execute:
 * it sits in live code of a function reachable from the module's roots (its
 * entry, library exports, class prototype helpers and every class's
 * methods) through live code. Code after a statement that cannot complete
 * normally is not live: production builds of libraries such as React's
 * Flight server keep development-only stack parsing behind `throw` stubs,
 * and those reads must not cost every call of the program a frame.
 * Programs without any stack read answer false without the walk. */
export function observesStacks(mod: IrModule, nodes?: IrNodeIndex): boolean {
  const keys = new StackKeys(mod, nodes);
  const reads = nodes?.scan(STACK_READ_KINDS);
  if (!mod.functions.some((fn) => containsStackRead(fn, keys, reads))) return false;
  const byName = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const classNames = new Set((mod.classes ?? []).map((cls) => cls.name));
  const pending: string[] = [...moduleFunctionReferences(mod)];
  // Class methods, accessors and constructors are reachable through
  // dispatch the IR does not name per site: all of them are roots.
  for (const fn of mod.functions) if (isClassMember(fn.name, classNames)) pending.push(fn.name);
  const reached = new Set<string>();
  let observed = false;
  while (pending.length > 0 && !observed) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const fn = byName.get(name);
    if (fn === undefined) continue;
    visitLiveExprs(fn.body, (expr) => {
      if (readsStack(fn, expr, keys)) observed = true;
      if (expr.kind === "call" && !reached.has(expr.callee)) pending.push(expr.callee);
      const referenced = exprFunctionReference(expr);
      if (referenced !== undefined && !reached.has(referenced)) pending.push(referenced);
    });
  }
  return observed;
}

/** Expressions that neither create an Error nor throw one by themselves.
 * Calls, `new` and virtual calls are capture-free when their callees are. */
const CAPTURE_FREE_EXPRS: ReadonlySet<IrExpr["kind"]> = new Set([
  "numLit",
  "boolLit",
  "strLit",
  "unitLit",
  "varRef",
  "incDec",
  "assignExpr",
  "bin",
  "unary",
  "logical",
  "ternary",
  "nullish",
  "toBool",
  "fieldGet",
  "recordGet",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "strCmp",
  "strEq",
  "strConcat",
  "upcast",
  "unionDisc",
  "unionIsTag",
  "unionEq",
  "instanceOf",
  "recordLit",
  "arrayLit",
  "unionWrap",
  "unionNarrow",
  "libCall",
  "arrIntrinsic",
  "call",
  "new",
  "virtualCall",
]);

/** Statements that neither create an Error nor throw one by themselves. */
const CAPTURE_FREE_STMTS: ReadonlySet<IrStmt["kind"]> = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "while",
  "doWhile",
  "for",
  "switch",
  "block",
  "return",
  "break",
  "continue",
  "fieldSet",
  "recordSet",
  "arraySet",
]);

/** Functions whose frame no stack capture can ever include: a capture runs
 * where an Error is created (by the program or by a throwing runtime
 * operation), and these functions only perform operations from a fixed
 * list that never create one and only call functions of the same kind.
 * Their frames are therefore never observable and the emitter omits them,
 * which keeps small leaf methods and helpers free of the per-call frame
 * push in programs that read stacks. Recursive functions (the stack guard
 * throws RangeError), async and generator bodies, and every function of a
 * worker program keep their frames. */
export function captureFreeFunctions(
  mod: IrModule,
  stackChecks: ReadonlySet<string> | null,
  published: PublishedTypes | null,
): Set<string> {
  const free = new Set<string>();
  if (mod.workers === true) return free;
  const methodImpls = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    for (const m of cls.methods ?? []) {
      let list = methodImpls.get(m);
      if (!list) methodImpls.set(m, (list = []));
      list.push(`%${cls.name}.${m}`);
    }
  }
  const tdzGlobals = new Set((mod.globals ?? []).filter((g) => g.tdz).map((g) => g.id));
  const callees = new Map<string, string[]>();
  for (const fn of mod.functions) {
    if (fn.async === true || fn.generator !== undefined || stackChecks?.has(fn.name)) continue;
    const tdz = new Set([...tdzGlobals, ...fn.locals.filter((l) => l.tdz).map((l) => l.id)]);
    const calls: string[] = [];
    const bigint = (e: IrExpr): boolean => e.type.kind === "bigint";
    const expr = (e: IrExpr): boolean => {
      if (!CAPTURE_FREE_EXPRS.has(e.kind)) return false;
      switch (e.kind) {
        case "varRef":
        case "incDec":
        case "assignExpr":
          if (tdz.has(e.localId)) return false;
          break;
        case "bin":
          // BigInt division and remainder by zero throw RangeError.
          if (bigint(e) || bigint(e.left) || bigint(e.right)) return false;
          break;
        case "unary":
          if (bigint(e) || bigint(e.operand)) return false;
          break;
        case "libCall":
          // Math functions only: they neither throw nor call back.
          if (!e.fn.startsWith("math.") || MAY_THROW_LIB_FNS.has(e.fn)) return false;
          break;
        case "arrIntrinsic": {
          // Methods that cannot throw, over numbers, booleans or strings
          // (no element conversion can run program code) and without a
          // callback argument.
          const elem = e.receiver.type.kind === "array" ? e.receiver.type.elem.kind : null;
          if (
            MAY_THROW_ARR_METHODS.has(e.method) ||
            (elem !== "f64" && elem !== "bool" && elem !== "string") ||
            e.args.some((arg) => arg.type.kind === "func")
          )
            return false;
          break;
        }
        case "call":
          calls.push(e.callee);
          break;
        case "new":
          calls.push(`%${e.className}.constructor`);
          break;
        case "virtualCall": {
          const impls = methodImpls.get(e.method);
          if (impls === undefined) return false;
          calls.push(...impls);
          break;
        }
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      if (!CAPTURE_FREE_STMTS.has(s.kind)) return false;
      if (s.kind === "assign" && tdz.has(s.localId)) return false;
      if (published !== null && writesPublished(published, s)) return false;
      return everyStmtChild(s, expr, stmt);
    };
    if (fn.body.every(stmt)) callees.set(fn.name, calls);
  }
  // Drop candidates that call a function outside the set until none do.
  for (const name of callees.keys()) free.add(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, calls] of callees) {
      if (free.has(name) && !calls.every((callee) => free.has(callee))) {
        free.delete(name);
        changed = true;
      }
    }
  }
  return free;
}
