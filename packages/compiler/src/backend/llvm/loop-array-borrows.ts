import { F64, isRefCounted, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../../ir/node-index.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { ReferenceEffects } from "./reference-effects.js";
import type { OptionalArrayReads } from "./local-array-reads.js";
import type { ReferenceWrites } from "./reference-writes.js";

/** Typed interface dispatch helpers (class-protocol-dispatch.ts), not
 * their fallbacks or early method reads. */
function isProtocolDispatch(name: string): boolean {
  return /^%dyn\.class\.protocol\.\d+$/.test(name);
}

/** A dispatch helper keeps a lent receiver alive: every statement ahead of
 * its final fallback call preserves heap edges (key tests and calls to
 * implementing methods that cannot release the receiver), and the fallback,
 * which can run any code, takes its own reference to the receiver. */
function dispatchLends(
  helper: IrFunction,
  functions: ReadonlyMap<string, IrFunction>,
  effects: ReferenceEffects,
): boolean {
  const last = helper.body[helper.body.length - 1];
  if (
    last?.kind !== "return" ||
    last.value?.kind !== "call" ||
    !/^%dyn\.class\.protocol\.fallback\.\d+$/.test(last.value.callee) ||
    last.value.args[0]?.kind !== "varRef" ||
    last.value.args[0].localId !== helper.params[0]?.localId
  )
    return false;
  if (functions.get(last.value.callee)?.params[0]?.owned !== true) return false;
  return effects.preservesScope(helper.body.slice(0, -1));
}

/** A checked-dynamic element read that yields undefined for a hole:
 * `arrayState(a, i) === 1 ? a[i] : undefined` (arrayValueRead's form for
 * dyn elements). Returns the element read. */
export function dynHoleRead(value: IrExpr): (IrExpr & { kind: "arrayGet" }) | null {
  if (value.kind !== "ternary" || value.type.kind !== "dyn") return null;
  const { cond, then, else_ } = value;
  if (
    cond.kind !== "bin" ||
    cond.op !== "===" ||
    cond.left.kind !== "arrayState" ||
    cond.right.kind !== "numLit" ||
    cond.right.value !== 1 ||
    then.kind !== "arrayGet" ||
    then.type.kind !== "dyn" ||
    else_.kind !== "dynFrom" ||
    else_.value.kind !== "unitLit" ||
    else_.value.unit !== "undefined"
  )
    return null;
  const same = (left: IrExpr, right: IrExpr): boolean =>
    left.kind === "varRef" && right.kind === "varRef" && left.localId === right.localId;
  return same(cond.left.arr, then.arr) && same(cond.left.index, then.index) ? then : null;
}

const LOOP_KINDS: readonly IrNodeKind[] = ["forOf", "for", "while", "doWhile"];

/** Limit a borrow to a loop whose complete iteration preserves heap edges.
 * Initialization and unrelated work elsewhere in the function may mutate.
 * The array remains owned by its unchanged local or global binding; the
 * iteration binding can only project it or forward it to proven consumers.
 * Callbacks, suspension, capture, reference writes, and escaping uses keep
 * the ordinary owned read. Missing elements retain the runtime's checks.
 * With ReferenceWrites, an iteration that writes no array element (nor the
 * binding holding the array) suffices, whatever else it writes. */
export function findLoopArrayBorrows(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  effects: ReferenceEffects,
  optionalReads?: OptionalArrayReads,
  writes?: ReferenceWrites | null,
  functions?: ReadonlyMap<string, IrFunction>,
  /** The module's node index, read instead of walking for the loops. */
  nodes?: IrNodeIndex,
): ReadonlySet<IrStmt> {
  const result = new Set<IrStmt>();
  if (fn.async || fn.generator) return result;
  const projected = lifetimes.locals.get(fn.name);
  const bindings = lifetimes.bindings.get(fn.name);
  const parameters = new Set(fn.params.map((param) => param.localId));
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const stableSource = (value: IrExpr): boolean => {
    if (value.kind !== "varRef") return false;
    const local = locals.get(value.localId);
    // Globals cannot be rebound while a completely preserving loop runs.
    return (
      !local ||
      (!local.boxed && !local.tdz && (bindings?.has(local.id) || parameters.has(local.id)))
    );
  };
  eachNodeOfKinds(fn, nodes?.scan(LOOP_KINDS), (node, statement) => {
    if (!statement) return true;
    const loop = node as IrStmt;
    {
      if (loop.kind === "forOf") {
        const local = locals.get(loop.localId);
        if (
          loop.iterable.type.kind === "array" &&
          isRefCounted(loop.iterable.type.elem) &&
          local &&
          !local.boxed &&
          !local.tdz &&
          projected?.has(loop.localId) &&
          bindings?.has(loop.localId) &&
          ((effects.preservesScope(loop.body) && effects.preserves(loop.iterable)) ||
            // The loop owns the evaluated array; only element removals can
            // release an element it lends.
            (writes && !writes.conflicts(["a"], writes.stmts(loop.body))))
        )
          result.add(loop);
        return true;
      }
      if (loop.kind !== "for" && loop.kind !== "while" && loop.kind !== "doWhile") return true;
      // A binding whose one use is the receiver of an interface dispatch
      // can hold a lent element when nothing else in the iteration can
      // release it and the dispatch keeps it alive itself (dispatchLends).
      const lentToDispatch = (id: string): boolean => {
        let uses = 0;
        let dispatch: (IrExpr & { kind: "call" }) | null = null;
        everyStmtList(loop.body, {
          stmt: () => true,
          expr: (node) => {
            if (node.kind === "varRef" && node.localId === id) uses++;
            if (
              node.kind === "call" &&
              node.args[0]?.kind === "varRef" &&
              node.args[0].localId === id &&
              isProtocolDispatch(node.callee)
            )
              dispatch = node;
            return true;
          },
        });
        const call = dispatch as (IrExpr & { kind: "call" }) | null;
        if (uses !== 1 || call === null || !functions) return false;
        const helper = functions.get(call.callee);
        if (!helper || !dispatchLends(helper, functions, effects)) return false;
        if (!call.args.slice(1).every((arg) => effects.preserves(arg))) return false;
        const placeholder: IrExpr = { kind: "numLit", value: 0, type: F64, loc: call.loc };
        const rest = transformStmtList(loop.body, {
          stmt: (node) => node,
          expr: (node) => (node === call ? placeholder : node),
        });
        return (
          effects.preservesScope(rest) &&
          (!loop.cond || effects.preserves(loop.cond)) &&
          (loop.kind !== "for" || !loop.update || effects.preservesScope([loop.update]))
        );
      };
      const preserving =
        effects.preservesScope(loop.body) &&
        (!loop.cond || effects.preserves(loop.cond)) &&
        (loop.kind !== "for" || !loop.update || effects.preservesScope([loop.update]));
      const loopWrites =
        preserving || !writes
          ? null
          : writes.union([
              writes.stmts(loop.body),
              loop.cond ? writes.expr(loop.cond) : null,
              loop.kind === "for" && loop.update ? writes.stmt(loop.update) : null,
            ]);
      if (!preserving && !writes && !functions) return true;
      everyStmtList(loop.body, {
        expr: () => true,
        stmt: (stmt) => {
          if (stmt.kind !== "varDecl" || !stmt.init || !bindings?.has(stmt.localId)) return true;
          const hole = dynHoleRead(stmt.init);
          const local = locals.get(stmt.localId);
          if (
            !isRefCounted(stmt.init.type) ||
            !(
              projected?.has(stmt.localId) ||
              (hole && local && !local.boxed && !local.tdz && lentToDispatch(stmt.localId))
            )
          )
            return true;
          const source =
            stmt.init.kind === "arrayGet"
              ? stmt.init.arr
              : (hole?.arr ?? optionalReads?.get(stmt.init)?.array);
          if (!source || !stableSource(source)) return true;
          if (preserving || (hole && !projected?.has(stmt.localId))) result.add(stmt);
          else {
            const keys = writes!.readKeys(source);
            if (keys && !writes!.conflicts(["a", ...keys], loopWrites)) result.add(stmt);
          }
          return true;
        },
      });
      return true;
    }
  });
  return result;
}
