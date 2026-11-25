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
 * A generator that crosses into a Node island is not the same value on the
 * other side yet, in either direction: the island value matrix pins that
 * for parameters and fields. The array form would add silent cases of it
 * (`[made].indexOf(kept)`, an element handed back to the island). A build
 * that runs an island therefore keeps the array type these slots had
 * before, which has no storage: each use that was refused by name is
 * refused by the same rule, and a program that reaches the end of lowering
 * with such a slot, where the backend stopped with an internal error, is
 * refused here. */
import { nodeIslandGeneratorArrayDiag } from "../../diagnostics/diagnostic.js";
import { varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrType,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { ITERATOR_ADAPTER_KEY } from "./iterator-adapters.js";
import type { Lowerer } from "./lowerer.js";
import { keyedHelperName } from "./stable-names.js";

/** Completes the slots that hold an array of generators
 * (DegradedType.generatorArray): refuses them in a program that can hand a
 * value to a Node island, and otherwise makes the conversions into
 * generator-typed slots keep a native generator's identity. */
export function finalizeGeneratorArrays(lowerer: Lowerer, functions: IrFunction[]): void {
  const slots = [...lowerer.degradedTypes.values()].flatMap((degraded) =>
    degraded.generatorArray === undefined ? [] : [degraded.generatorArray],
  );
  if (slots.length === 0) return;
  const islands = lowerer.hasNodeIslands();
  if (islands || lowerer.usesNodeIsland) {
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
  takeNativeGenerators(lowerer, functions);
}

/** Replaces each call of an iterator adapter over a checked-dynamic value
 * by a call of `%iter.exact.<n>(source)`: the source itself when it is the
 * native generator of the slot's type, else the adapter over it. */
function takeNativeGenerators(lowerer: Lowerer, functions: IrFunction[]): void {
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
    const fn: IrFunction = {
      name: keyedHelperName(lowerer, "%iter.exact", `iterExact:${typeKey(expected)}`),
      params: [{ localId: "source.0", name: "source", type: DYN }],
      returnType: expected,
      locals: [{ id: "source.0", name: "source", type: DYN, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [source, { kind: "strLit", value: typeKey(expected), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "return",
              value: { kind: "dynCheck", value: source, type: expected, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: { kind: "call", callee: adapter, args: [source], type: expected, loc },
          loc,
        },
      ],
      loc,
    };
    helpers.set(adapter, fn);
    return fn.name;
  };
  for (const fn of functions) {
    const calls = !everyStmtList(fn.body, { stmt: () => true, expr: (e) => !adapted(e) });
    if (!calls) continue;
    fn.body = transformStmtList(fn.body, {
      stmt: (s) => s,
      expr: (e) => (adapted(e) ? { ...e, callee: exact(e.callee, e.type, e) } : e),
    });
  }
  for (const fn of helpers.values()) {
    lowerer.liftedFns.push(fn);
    functions.push(fn);
  }
}
