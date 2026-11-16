import { InternalCompilerError } from "../../errors.js";
import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

const EMPTY: ReadonlySet<string> = new Set();

/** What one function's body holds, collected once for the module-finish
 * passes. Each of them looks for a rare node kind or library entry point and
 * otherwise walks every function of the program to find nothing; with this
 * census they read a set instead. A kind the census does not list is a kind
 * the body does not contain: the walk visits every statement and every
 * expression, and a rewrite that changes a body replaces it (or is forgotten
 * explicitly), exactly as for DispatchSites. */
export interface FunctionFacts {
  statements: IrStmt[];
  length: number;
  first: IrStmt | undefined;
  last: IrStmt | undefined;
  /** The kinds of the expressions in the body, once each. */
  exprKinds: ReadonlySet<string>;
  /** The kinds of the statements in the body, once each. */
  stmtKinds: ReadonlySet<string>;
  /** The `libCall` entry points the body names, once each. */
  libFns: ReadonlySet<string>;
  /** The names of the intrinsics the body calls, once each. */
  intrinsics: ReadonlySet<string>;
}

const CHECK_CENSUS = process.env["SCRIPTC_CHECK_FUNCTION_CENSUS"] === "1";

/** The function bodies of one module-finish pass, scanned on first use. A
 * census is reused while the function's statement list is the same array
 * with the same length and the same first and last statements: the finish
 * passes replace the lists they rewrite, and a pass that changes a node
 * inside an unchanged list reports it with `forget` (or `clear`). */
export class FunctionCensus {
  private readonly facts = new Map<IrFunction, FunctionFacts>();

  of(fn: IrFunction): FunctionFacts {
    const cached = this.facts.get(fn);
    if (
      cached !== undefined &&
      cached.statements === fn.body &&
      cached.length === fn.body.length &&
      cached.first === fn.body[0] &&
      cached.last === fn.body[fn.body.length - 1]
    ) {
      if (CHECK_CENSUS && !sameFacts(cached, scanFacts(fn.body)))
        throw new InternalCompilerError(`reused census of ${fn.name} disagrees with a fresh scan`);
      return cached;
    }
    const facts = scanFacts(fn.body);
    this.facts.set(fn, facts);
    return facts;
  }

  /** Whether the body holds an expression of `kind`. */
  hasExpr(fn: IrFunction, kind: IrExpr["kind"]): boolean {
    return this.of(fn).exprKinds.has(kind);
  }

  /** Whether the body holds a statement of `kind`. */
  hasStmt(fn: IrFunction, kind: IrStmt["kind"]): boolean {
    return this.of(fn).stmtKinds.has(kind);
  }

  /** Whether the body calls the `libCall` entry point `name`. */
  hasLibFn(fn: IrFunction, name: string): boolean {
    return this.of(fn).libFns.has(name);
  }

  /** Whether the body calls any of `names` as a `libCall` entry point. */
  hasAnyLibFn(fn: IrFunction, names: ReadonlySet<string>): boolean {
    const held = this.of(fn).libFns;
    if (held.size === 0) return false;
    for (const name of names) if (held.has(name)) return true;
    return false;
  }

  /** Whether the body calls any of `names` as an intrinsic. */
  hasAnyIntrinsic(fn: IrFunction, names: readonly string[]): boolean {
    const held = this.of(fn).intrinsics;
    if (held.size === 0) return false;
    for (const name of names) if (held.has(name)) return true;
    return false;
  }

  /** Whether the body holds an expression of any of `kinds`. */
  hasAnyExpr(fn: IrFunction, kinds: readonly IrExpr["kind"][]): boolean {
    const held = this.of(fn).exprKinds;
    for (const kind of kinds) if (held.has(kind)) return true;
    return false;
  }

  /** Drops the census of a function whose body changed inside an unchanged
   * statement list. */
  forget(fn: IrFunction): void {
    this.facts.delete(fn);
  }

  /** Drops every census, for a pass that rewrites nodes in place. */
  clear(): void {
    this.facts.clear();
  }
}

function scanFacts(statements: IrStmt[]): FunctionFacts {
  let exprKinds: Set<string> | null = null;
  let stmtKinds: Set<string> | null = null;
  let libFns: Set<string> | null = null;
  let intrinsics: Set<string> | null = null;
  const expr = (node: IrExpr): boolean => {
    if (exprKinds === null) exprKinds = new Set();
    exprKinds.add(node.kind);
    if (node.kind === "libCall") {
      if (libFns === null) libFns = new Set();
      libFns.add(node.fn);
    } else if (node.kind === "intrinsic") {
      if (intrinsics === null) intrinsics = new Set();
      intrinsics.add(node.name);
    }
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => {
    if (stmtKinds === null) stmtKinds = new Set();
    stmtKinds.add(node.kind);
    return everyStmtChild(node, expr, stmt);
  };
  for (let i = 0; i < statements.length; i++) stmt(statements[i]!);
  return {
    statements,
    length: statements.length,
    first: statements[0],
    last: statements[statements.length - 1],
    exprKinds: exprKinds ?? EMPTY,
    stmtKinds: stmtKinds ?? EMPTY,
    libFns: libFns ?? EMPTY,
    intrinsics: intrinsics ?? EMPTY,
  };
}

function sameFacts(left: FunctionFacts, right: FunctionFacts): boolean {
  const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && [...a].every((item) => b.has(item));
  return (
    sameSet(left.exprKinds, right.exprKinds) &&
    sameSet(left.stmtKinds, right.stmtKinds) &&
    sameSet(left.libFns, right.libFns) &&
    sameSet(left.intrinsics, right.intrinsics)
  );
}
