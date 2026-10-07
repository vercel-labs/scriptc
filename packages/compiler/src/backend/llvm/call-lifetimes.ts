import {
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { borrowsStringInputs } from "./string-lifetimes.js";
import { borrowsMapReadInputs } from "./map-read-lifetimes.js";

interface ForwardedUse {
  callee: string;
  index: number;
}

interface Uses {
  invalid: Set<string>;
  written: Set<string>;
  declarations: Map<string, number>;
  forwards: Map<string, ForwardedUse[]>;
}

interface Parameter {
  safe: boolean;
  callers: Set<Parameter>;
}

export interface CallLifetimes {
  /** Unchanged heap bindings can borrow the caller's owner. Copies that
   * escape through returns, stores or other calls still acquire ownership.
   * This does not permit passing a stack box to the parameter. */
  borrowed: Map<string, Set<number>>;
  /** Locals initialized once and never assigned or captured. A source let
   * binding may be stable too; source mutability alone is not a write. */
  bindings: Map<string, Set<string>>;
  /** Parameters consumed only by projections, borrowing string operations,
   * callable invocation, or other proven parameters.
   * This is a lifetime fact, not a purity or nonthrowing guarantee. */
  parameters: Map<string, Set<number>>;
  /** Stable locals with the same use restriction. Their initialization
   * and ownership still need a separate representation proof. */
  locals: Map<string, Set<string>>;
  /** Projection-only local uses, allowing statement assignments. Each
   * initializer and assignment still needs a separate storage proof. */
  projectedLocals: Map<string, Set<string>>;
}

function eligible(local: IrLocal): boolean {
  // Source parameters are writable bindings even when the body never
  // assigns them. Actual writes are rejected by collectUses below.
  return (
    !local.boxed &&
    !local.tdz &&
    (local.type.kind === "union" ||
      local.type.kind === "object" ||
      local.type.kind === "record" ||
      local.type.kind === "string" ||
      local.type.kind === "func")
  );
}

/** Read each function once. A whole-value use is unsafe unless it is an
 * explicitly supported projection, invocation, borrowing string operation, or direct-call
 * argument whose target parameter can be proved separately. Traversal of every other consumer
 * reaches the ordinary varRef rejection, including future IR nodes.
 *
 * Projection results may escape: the existing emitter retains extracted
 * payloads. The enclosing union box itself must never be retained, released,
 * stored, returned, captured, or passed to arbitrary runtime code. */
function collectUses(fn: IrFunction): Uses {
  const uses: Uses = {
    invalid: new Set(),
    written: new Set(),
    declarations: new Map(),
    forwards: new Map(),
  };
  const stringInput = (value: IrExpr): boolean => {
    if (value.kind === "varRef" && value.type.kind === "string") return true;
    return expr(value);
  };
  function expr(node: IrExpr): boolean {
    switch (node.kind) {
      case "toBool":
      case "toString":
        if (node.operand.kind === "varRef" && node.operand.type.kind === "union") return true;
        break;
      case "strEq":
      case "strCmp":
      case "strConcat":
        return stringInput(node.left) && stringInput(node.right);
      case "strIntrinsic":
        if (borrowsStringInputs(node.method))
          return stringInput(node.receiver) && node.args.every(stringInput);
        break;
      case "mapIntrinsic":
      case "setIntrinsic":
        if (borrowsMapReadInputs(node)) return expr(node.receiver) && node.args.every(stringInput);
        break;
      case "unionNarrow":
      case "unionIsTag":
        if (node.value.kind === "varRef") return true;
        break;
      case "fieldGet":
      case "recordGet":
        if (node.obj.kind === "varRef") return true;
        break;
      case "callValue":
        if (node.callee.kind !== "varRef") expr(node.callee);
        if (node.receiver) expr(node.receiver);
        return node.args.every(expr);
      case "call":
        node.args.forEach((arg, index) => {
          if (arg.kind !== "varRef") {
            expr(arg);
            return;
          }
          let forwards = uses.forwards.get(arg.localId);
          if (!forwards) uses.forwards.set(arg.localId, (forwards = []));
          forwards.push({ callee: node.callee, index });
        });
        return true;
      case "assignExpr":
      case "incDec":
        uses.written.add(node.localId);
        uses.invalid.add(node.localId);
        break;
      case "varRef":
        uses.invalid.add(node.localId);
        break;
      case "closure":
      case "classRef":
        for (const id of node.captures ?? []) {
          uses.invalid.add(id);
          uses.written.add(id);
        }
        break;
    }
    return everyExprChild(node, expr, (node) => stmt(node, true));
  }
  function stmt(node: IrStmt, inExpression: boolean): boolean {
    switch (node.kind) {
      case "varDecl":
        uses.declarations.set(node.localId, (uses.declarations.get(node.localId) ?? 0) + 1);
        break;
      case "assign":
        uses.written.add(node.localId);
        // Sequence expressions can rebind a previous call argument before
        // its consumer runs. Those locals need an owned heap snapshot.
        if (inExpression) uses.invalid.add(node.localId);
        break;
      case "forOf":
        // The binding is initialized afresh for each iteration. Its uses
        // can project a borrowed element while the loop owns the array.
        uses.declarations.set(node.localId, (uses.declarations.get(node.localId) ?? 0) + 1);
        break;
      case "rethrow":
        uses.invalid.add(node.localId);
        uses.written.add(node.localId);
        break;
      case "tryCatch":
        if (node.catchLocalId !== null) {
          uses.invalid.add(node.catchLocalId);
          uses.written.add(node.catchLocalId);
        }
        break;
    }
    return everyStmtChild(node, expr, (node) => stmt(node, inExpression));
  }
  fn.body.forEach((node) => stmt(node, false));
  for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])]) {
    uses.invalid.add(capture.localId);
    uses.written.add(capture.localId);
  }
  return uses;
}

/** Solve dependencies between individual parameters, rather than marking
 * every argument unsafe when one parameter escapes. Begin optimistically
 * inside recursive groups, then propagate each rejection through reverse
 * edges. Every parameter enters the worklist at most once; deep call chains
 * do not recurse on the compiler stack or repeatedly rescan function bodies.
 *
 * The result is private to one emission of the finalized IR. No fact is
 * serialized or reused after a compiler transformation. Synchronous bodies
 * without environments are the only supported calling convention. */
export function analyzeCallLifetimes(functions: ReadonlyMap<string, IrFunction>): CallLifetimes {
  const usesByFunction = new Map<string, Uses>();
  const nodes = new Map<string, Parameter[]>();
  const unsafe: Parameter[] = [];
  const result: CallLifetimes = {
    parameters: new Map(),
    locals: new Map(),
    borrowed: new Map(),
    bindings: new Map(),
    projectedLocals: new Map(),
  };
  for (const fn of functions.values()) {
    if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures !== undefined)
      continue;
    const uses = collectUses(fn);
    usesByFunction.set(fn.name, uses);
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    const borrowed = new Set<number>();
    const stable = (local: IrLocal): boolean =>
      !local.boxed && !local.tdz && !uses.written.has(local.id);
    fn.params.forEach((param, index) => {
      const local = locals.get(param.localId);
      if (local && isRefCounted(param.type) && stable(local) && !uses.declarations.has(local.id))
        borrowed.add(index);
    });
    if (borrowed.size > 0) result.borrowed.set(fn.name, borrowed);
    result.bindings.set(
      fn.name,
      new Set(
        fn.locals
          .filter((local) => stable(local) && uses.declarations.get(local.id) === 1)
          .map((local) => local.id),
      ),
    );
    nodes.set(
      fn.name,
      fn.params.map((param) => {
        const local = locals.get(param.localId);
        const safe =
          local !== undefined &&
          eligible(local) &&
          !uses.written.has(param.localId) &&
          !uses.invalid.has(param.localId) &&
          !uses.declarations.has(param.localId);
        const node: Parameter = { safe, callers: new Set() };
        if (!safe) unsafe.push(node);
        return node;
      }),
    );
  }
  for (const fn of functions.values()) {
    const params = nodes.get(fn.name);
    const uses = usesByFunction.get(fn.name);
    if (!params || !uses) continue;
    fn.params.forEach((param, index) => {
      const node = params[index]!;
      if (!node.safe) return;
      for (const use of uses.forwards.get(param.localId) ?? []) {
        const callee = nodes.get(use.callee)?.[use.index];
        if (!callee) {
          node.safe = false;
          unsafe.push(node);
          break;
        }
        callee.callers.add(node);
      }
    });
  }
  for (let i = 0; i < unsafe.length; i++) {
    for (const caller of unsafe[i]!.callers) {
      if (!caller.safe) continue;
      caller.safe = false;
      unsafe.push(caller);
    }
  }
  for (const [name, params] of nodes) {
    const safe = new Set<number>();
    params.forEach((param, index) => {
      if (param.safe) safe.add(index);
    });
    if (safe.size > 0) result.parameters.set(name, safe);
  }
  for (const fn of functions.values()) {
    const uses = usesByFunction.get(fn.name);
    if (!uses) continue;
    const params = new Set(fn.params.map((param) => param.localId));
    const safe = new Set<string>();
    const projected = new Set<string>();
    for (const local of fn.locals) {
      if (
        params.has(local.id) ||
        !eligible(local) ||
        uses.invalid.has(local.id) ||
        uses.declarations.get(local.id) !== 1
      )
        continue;
      const forwards = uses.forwards.get(local.id) ?? [];
      if (forwards.every((use) => result.parameters.get(use.callee)?.has(use.index) === true)) {
        projected.add(local.id);
        if (eligible(local) && !uses.written.has(local.id)) safe.add(local.id);
      }
    }
    result.locals.set(fn.name, safe);
    result.projectedLocals.set(fn.name, projected);
  }
  return result;
}
