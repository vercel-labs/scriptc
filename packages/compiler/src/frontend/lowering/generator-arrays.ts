/* Arrays that hold generators.
 *
 * A generator has no array storage, so a slot declared as an array of
 * generators takes localized failure's lenient form (Lowerer.degradeType):
 * the array is a checked-dynamic value whose elements are the boxed
 * generators. Two things follow from that, and this module settles both
 * once every body is lowered.
 *
 * Reading an element into a generator-typed slot converts a checked-dynamic
 * value into the slot's type. That conversion is the iterator adapter
 * (iterator-adapters.ts): a new generator that steps its source. It is the
 * right answer for a Map iterator and the wrong one for the generator the
 * program put into the array: `list[0] === g` would be false. So in a
 * program that has such an array, every adapter call first asks whether the
 * value is the native generator of exactly the slot's type and then takes
 * it through the checked cast, which answers the same object. A program
 * without such an array keeps its adapter calls as they are.
 *
 * A program that uses a Node island asks the same question of every
 * adapter call, for the generator it handed to the island and got back, and
 * one more: whether the value is an island iterator that already has a
 * generator of the slot's type. The runtime keeps that pair
 * (scr_node_island_iter_pair), so an island iterator is one generator in
 * the program however often it crosses, and the generator is the island's
 * iterator again when it becomes a dynamic value (the backend boxes a
 * generator through scr_node_island_iter_ref in such a program).
 *
 * The array form stays refused beside an island: a build that runs one
 * keeps the array type these slots had before, which has no storage. Each
 * use that was refused by name is refused by the same rule, and a program
 * that reaches the end of lowering with such a slot, where the backend
 * stopped with an internal error, is refused here. */
import { nodeIslandGeneratorArrayDiag } from "../../diagnostics/diagnostic.js";
import { varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { ITERATOR_ADAPTER_KEY } from "./iterator-adapters.js";
import type { Lowerer } from "./lowerer.js";
import { keyedHelperName } from "./stable-names.js";

/** Completes the slots that hold an array of generators
 * (DegradedType.generatorArray): refuses them in a program that can hand a
 * value to a Node island, and otherwise makes the conversions into
 * generator-typed slots keep a native generator's identity. A program that
 * uses an island keeps it in every such conversion, and an island
 * iterator's with it. */
export function finalizeGeneratorArrays(lowerer: Lowerer, functions: IrFunction[]): void {
  const slots = [...lowerer.degradedTypes.values()].flatMap((degraded) =>
    degraded.generatorArray === undefined ? [] : [degraded.generatorArray],
  );
  const island = lowerer.usesNodeIsland;
  if (slots.length === 0) {
    if (island) takeNativeGenerators(lowerer, functions, true);
    return;
  }
  const islands = lowerer.hasNodeIslands();
  if (islands || island) {
    // With an island set the slots kept their array type, and the uses the
    // lowering refused are the program's diagnostics, as before.
    if (islands && lowerer.diags.length > 0) return;
    // Once per array type, where it failed first: a literal's own type and
    // its binding's declared type are two types that read alike.
    const reported = new Set<string>();
    for (const slot of slots) {
      if (reported.has(slot.type)) continue;
      reported.add(slot.type);
      lowerer.pushDiag(nodeIslandGeneratorArrayDiag(slot.type, slot.loc));
    }
    return;
  }
  takeNativeGenerators(lowerer, functions, false);
}

/** Replaces each call of an iterator adapter over a checked-dynamic value
 * by a call of `%iter.exact.<n>(source)`: the source itself when it is the
 * native generator of the slot's type, else the adapter over it.
 *
 * With `island`, the helper first takes the source as the generator the
 * program already holds it as (nodeIsland.iterView: the generator paired
 * with an island iterator), and pairs the adapter it makes over an island
 * iterator. (A checked cast into a generator type asks the same question
 * in the backend, so a generator that became a dynamic value, its island
 * iterator's handle, is that generator again.) And an adapter steps an
 * island value's own iterator (nodeIsland.iterator), where `dyn.iterator`
 * would read every value out of it first. */
function takeNativeGenerators(lowerer: Lowerer, functions: IrFunction[], island: boolean): void {
  const adapters = new Set<string>();
  for (const [key, name] of lowerer.valueHelpers)
    if (key.startsWith(ITERATOR_ADAPTER_KEY)) adapters.add(name);
  if (adapters.size === 0) return;
  const adapted = (e: IrExpr): e is IrExpr & { kind: "call" } =>
    e.kind === "call" &&
    adapters.has(e.callee) &&
    e.args.length === 1 &&
    e.args[0]!.type.kind === "dyn" &&
    e.type.kind === "generator";
  const viewOf = (value: IrExpr, type: IrType): IrExpr => ({
    kind: "libCall",
    fn: "nodeIsland.iterView",
    args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc: value.loc }],
    type: DYN,
    loc: value.loc,
  });
  /** An adapter's `dyn.iterator(source)`, beside an island. */
  const opens = (e: IrExpr): e is IrExpr & { kind: "libCall" } =>
    island && e.kind === "libCall" && e.fn === "dyn.iterator";
  const locs = new Map(
    functions.flatMap((fn) => (adapters.has(fn.name) ? [[fn.name, fn.loc]] : [])),
  );
  const helpers = new Map<string, IrFunction>();
  const exact = (adapter: string, expected: IrType, call: IrExpr): string => {
    const known = helpers.get(adapter);
    if (known !== undefined) return known.name;
    // The adapter's own position: the helper is the same whichever call
    // needs it first.
    const loc = locs.get(adapter) ?? call.loc;
    const source = varRef("source.0", DYN, loc);
    const key: IrExpr = { kind: "strLit", value: typeKey(expected), type: STRING, loc };
    /** `value` itself when it is the native generator of the slot's type. */
    const taken = (value: IrExpr): IrStmt => ({
      kind: "if",
      cond: { kind: "libCall", fn: "dyn.typedRefIs", args: [value, key], type: BOOL, loc },
      then: [{ kind: "return", value: { kind: "dynCheck", value, type: expected, loc }, loc }],
      else_: null,
      loc,
    });
    const fresh: IrExpr = { kind: "call", callee: adapter, args: [source], type: expected, loc };
    const view = varRef("view.0", DYN, loc);
    const made = varRef("made.0", expected, loc);
    const fn: IrFunction = {
      name: keyedHelperName(lowerer, "%iter.exact", `iterExact:${typeKey(expected)}`),
      params: [{ localId: "source.0", name: "source", type: DYN }],
      returnType: expected,
      locals: [
        { id: "source.0", name: "source", type: DYN, mutable: false },
        ...(island
          ? [
              { id: "view.0", name: "view", type: DYN, mutable: false },
              { id: "made.0", name: "made", type: expected, mutable: false },
            ]
          : []),
      ],
      body: island
        ? [
            { kind: "varDecl", localId: "view.0", init: viewOf(source, expected), loc },
            taken(view),
            { kind: "varDecl", localId: "made.0", init: fresh, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "nodeIsland.iterPair",
                args: [source, { kind: "dynFrom", value: made, type: DYN, loc }],
                type: VOID,
                loc,
              },
              loc,
            },
            { kind: "return", value: made, loc },
          ]
        : [taken(source), { kind: "return", value: fresh, loc }],
      loc,
    };
    helpers.set(adapter, fn);
    return fn.name;
  };
  for (const fn of functions) {
    const adapter = adapters.has(fn.name);
    const untouched = everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => !adapted(e) && !(adapter && opens(e)),
    });
    if (untouched) continue;
    fn.body = transformStmtList(fn.body, {
      stmt: (s) => s,
      expr: (e) =>
        adapted(e)
          ? { ...e, callee: exact(e.callee, e.type, e) }
          : adapter && opens(e)
            ? { ...e, fn: "nodeIsland.iterator" }
            : e,
    });
  }
  for (const fn of helpers.values()) {
    lowerer.liftedFns.push(fn);
    functions.push(fn);
  }
}
