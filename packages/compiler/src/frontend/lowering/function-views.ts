import {
  BOOL,
  canAdaptDynFuncTo,
  canBoxFuncIntoDyn,
  DYN,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { strandedFuncAdapter } from "./coercions/function-adapters.js";
import { keyedHelperName } from "./stable-names.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

/* Function values and the views of them.
 *
 * A function type fixes a native call shape, so a function held at a type
 * with fewer parameters than it has is a second closure, a view: the
 * signature adapter that calls the function with `undefined` for the
 * parameters the type lacks. JavaScript has no views. The function object
 * is one object, and whoever calls it later with more arguments reaches
 * those parameters:
 *
 *   function label(prefix: string, options?: { upper: boolean }) { … }
 *   const ops: { make: (prefix: string) => string } = { make: label };
 *   const wide: (prefix: string, options: { upper: boolean }) => string = ops.make;
 *   wide("abc", { upper: true });      // label receives the options
 *
 * A conversion to a type with more parameters must therefore start from
 * the function, not from the view: an adapter wrapped around the view can
 * only call the view, which has nowhere to put the extra arguments.
 *
 * The program is closed, so when lowering ends every adapter that makes a
 * view of a function type S is known, with the type of the function it
 * forwards to. This pass gives each widening adapter (S to a type T with
 * more parameters) one test per such view: when the value is that view
 * (`viewOf`, a comparison of the closure's code), the result is built from
 * the function the view forwards to (`viewSource`) instead. It is built by
 * the conversions the two adapters already are, with the extra parameters
 * threaded through them: the function to S⁺ (S with T's extra parameters
 * appended), then S⁺ to T. Each of those is an ordinary signature adapter,
 * so a default applies when the final call passes `undefined`, a rest
 * parameter receives every argument, and an extra argument the function's
 * parameter cannot hold takes the stranded TypeError when the wide view is
 * invoked. A chain of views unwinds one adapter at a time: the adapter to
 * S⁺ is itself a widening adapter when the view only converted types.
 *
 * Two more consumers hand a function more than a view's type has, and
 * both are settled once, when every function is lowered (finish):
 *
 *  - A checked-dynamic callable held at a function type (`dynCheck`: a
 *    bound function, a function that crossed `any`) is a view too, marked
 *    by the boundary. A widening adapter whose source type the program
 *    checks callables into converts the callable itself to the wide type.
 *  - Boxing a view into a checked-dynamic value (`dynFrom`) would give
 *    dynamic callers the view's parameter list. It boxes the function the
 *    view forwards to instead, as the runtime already does for the
 *    boundary's own views.
 *
 * Nothing changes where a function is narrowed or called. A widening
 * adapter or a boxing changes only when the program holds a view of its
 * source type that can be handed more, so a program without that pair
 * compiles as before. */

type FuncType = IrType & { kind: "func" };

interface Adapter {
  /** The factory: `(f) => closure over the body`. */
  readonly factory: IrFunction;
  /** The adapter's body, the code of the views it makes. */
  readonly body: string;
  readonly source: FuncType;
  readonly target: FuncType;
  readonly checked: boolean;
  /** The factory's own statement, which makes the plain adapter. */
  readonly plain: IrStmt;
  /** The tests ahead of it, each under the name of the view it looks
   * through ("" for the checked-dynamic boundary's). */
  readonly tests: Map<string, IrStmt>;
}

/** Puts the adapter's tests ahead of its own statement, ordered by the
 * view's name, so the factory does not depend on the order the tests were
 * found in. */
function install(adapter: Adapter): void {
  const names = [...adapter.tests.keys()].sort();
  adapter.factory.body = [...names.map((name) => adapter.tests.get(name)!), adapter.plain];
}

/** The parameters a call through `type` fills, without a typed rest's
 * trailing array. */
function fixedCount(type: FuncType): number {
  return type.params.length - (type.restAbi === "typed" ? 1 : 0);
}

function byFactoryName(left: Adapter, right: Adapter): number {
  return left.factory.name < right.factory.name
    ? -1
    : left.factory.name > right.factory.name
      ? 1
      : 0;
}

export class FunctionViews {
  /** How far liftedFns has been read. */
  private scanned = 0;
  private readonly adapters: Adapter[] = [];
  /** By the key of a function type: the adapters whose views of that type
   * may stand for a function that takes more than the type passes. */
  private readonly holders = new Map<string, Adapter[]>();
  private readonly holding = new Set<Adapter>();
  /** The (widening adapter, view) pairs already given a test. */
  private readonly looked = new Set<string>();

  /** Reads the adapters lowering added since the last call and gives every
   * widening adapter its tests. True when it added or changed a function. */
  process(lowerer: Lowerer): boolean {
    let changed = false;
    for (;;) {
      // A pair to test appears only with a new adapter.
      if (!this.scan(lowerer)) return changed;
      this.settleHolders();
      let added = false;
      // Building a test adds adapters to the list; they are read on the
      // next round.
      // By name, so the tests and their order do not depend on the order
      // bodies lowered in.
      for (const widening of [...this.adapters].sort(byFactoryName)) {
        if (!this.widens(widening)) continue;
        const views = this.holders.get(typeKey(widening.source));
        if (views === undefined) continue;
        for (const view of [...views].sort(byFactoryName)) {
          const pair = `${widening.factory.name}\n${view.factory.name}`;
          if (this.looked.has(pair)) continue;
          this.looked.add(pair);
          const test = this.quietly(lowerer, () => this.lookThrough(lowerer, widening, view));
          if (test === null) continue;
          widening.tests.set(view.factory.name, test);
          install(widening);
          added = true;
        }
      }
      if (!added) return changed;
      changed = true;
    }
  }

  /** Runs `build` with diagnostics captured. The adapters built here
   * belong to no source statement, so a refusal while building one is not
   * the program's: the widening adapter stays as it was. */
  private quietly<T>(lowerer: Lowerer, build: () => T | null): T | null {
    const held = lowerer.diagSink;
    lowerer.diagSink = [];
    try {
      return build();
    } catch (e) {
      if (e instanceof PoisonError) return null;
      throw e;
    } finally {
      lowerer.diagSink = held;
    }
  }

  /** The consumers that are not signature adapters, once `functions` is
   * every lowered function and process has settled. */
  finish(lowerer: Lowerer, functions: readonly IrFunction[]): void {
    const wideners = this.adapters.filter((adapter) => this.widens(adapter)).sort(byFactoryName);
    if (wideners.length === 0 && this.holders.size === 0) return;
    // One walk: the function types the program checks callables into, and
    // the functions that box a view.
    const checkedInto = new Set<string>();
    const noted = new Set<string>();
    const note = (type: IrType): void => {
      const key = typeKey(type);
      if (noted.has(key)) return;
      noted.add(key);
      if (type.kind === "func") checkedInto.add(key);
      else if (type.kind === "union")
        for (const arm of lowerer.unions.get(type.unionId)?.arms ?? []) note(arm);
      else if (type.kind === "array") note(type.elem);
      else if (type.kind === "promise") note(type.inner);
      else if (type.kind === "record") {
        const shape = lowerer.shapes.get(type.shapeId);
        for (const field of shape?.fields ?? []) note(field.type);
        if (shape?.indexValue) note(shape.indexValue);
      }
    };
    const boxing: IrFunction[] = [];
    for (const fn of functions) {
      let boxes = false;
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "dynCheck") note(e.type);
          else if (!boxes && this.boxedView(lowerer, e) !== null) boxes = true;
          return true;
        },
        stmt: () => true,
      });
      if (boxes) boxing.push(fn);
    }
    for (const widening of wideners) {
      if (!checkedInto.has(typeKey(widening.source))) continue;
      const target = widening.target;
      if (
        !canAdaptDynFuncTo(
          target,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      )
        continue;
      const loc = widening.factory.loc;
      const value: IrExpr = {
        kind: "varRef",
        localId: widening.factory.params[0]!.localId,
        type: widening.source,
        loc,
      };
      widening.tests.set("", {
        kind: "if",
        cond: { kind: "viewOf", value, adapter: null, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: {
              kind: "dynCheck",
              value: { kind: "viewSource", value, adapter: null, type: DYN, loc },
              type: target,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
      install(widening);
    }
    for (const fn of boxing) {
      fn.body = transformStmtList(fn.body, {
        expr: (e) => {
          const type = this.boxedView(lowerer, e);
          if (type === null || e.kind !== "dynFrom") return e;
          const helper = this.boxHelper(lowerer, type, e.loc)!;
          return { kind: "call", callee: helper, args: [e.value], type: DYN, loc: e.loc };
        },
        stmt: (stmt) => stmt,
      });
    }
  }

  /** The views of `type` that box as the function they forward to. */
  private boxedSources(lowerer: Lowerer, type: FuncType): Adapter[] {
    return (this.holders.get(typeKey(type)) ?? [])
      .filter((view) =>
        canBoxFuncIntoDyn(
          view.source,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ),
      )
      .sort(byFactoryName);
  }

  /** The function type of the value `e` boxes, when that value can be a
   * view that boxes as its function. A value boxed with a static name or
   * length is a function the program names, and a closure expression is a
   * function, never a view. */
  private boxedView(lowerer: Lowerer, e: IrExpr): FuncType | null {
    if (
      e.kind !== "dynFrom" ||
      e.value.type.kind !== "func" ||
      e.value.kind === "closure" ||
      e.fnName !== undefined ||
      e.fnLength !== undefined
    )
      return null;
    return this.boxedSources(lowerer, e.value.type).length > 0 ? e.value.type : null;
  }

  /** `%fn.box.<type>(f)`: the checked-dynamic value of the function `f`
   * stands for. Null when no view of `type` boxes as its function. */
  private boxHelper(lowerer: Lowerer, type: FuncType, loc: SrcLoc): string | null {
    const views = this.boxedSources(lowerer, type);
    if (views.length === 0) return null;
    const key = `fnbox:${typeKey(type)}`;
    const existing = lowerer.valueHelpers.get(key);
    if (existing) return existing;
    const name = keyedHelperName(lowerer, "%fn.box", key);
    // Interned before the body: views that convert types can forward to
    // each other's types.
    lowerer.valueHelpers.set(key, name);
    const value: IrExpr = { kind: "varRef", localId: "f.0", type, loc };
    const body: IrStmt[] = views.map((view): IrStmt => {
      const source: IrExpr = {
        kind: "viewSource",
        value,
        adapter: view.body,
        type: view.source,
        loc,
      };
      const inner = this.boxHelper(lowerer, view.source, loc);
      return {
        kind: "if",
        cond: { kind: "viewOf", value, adapter: view.body, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value:
              inner === null
                ? { kind: "dynFrom", value: source, type: DYN, loc }
                : { kind: "call", callee: inner, args: [source], type: DYN, loc },
            loc,
          },
        ],
        else_: null,
        loc,
      };
    });
    body.push({ kind: "return", value: { kind: "dynFrom", value, type: DYN, loc }, loc });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type }],
      returnType: DYN,
      locals: [{ id: "f.0", name: "f", type, mutable: false }],
      body,
      loc,
    });
    return name;
  }

  /** Reads the adapters lowering added since the last call; false when
   * there is none. */
  private scan(lowerer: Lowerer): boolean {
    const known = this.adapters.length;
    const provenance = lowerer.coercions.signatureAdapters;
    for (; this.scanned < lowerer.liftedFns.length; this.scanned++) {
      const factory = lowerer.liftedFns[this.scanned]!;
      const mode = provenance.get(factory.name);
      if (mode === undefined) continue;
      const source = factory.params[0]?.type;
      const made = factory.body.at(-1);
      if (
        source?.kind !== "func" ||
        factory.returnType.kind !== "func" ||
        made?.kind !== "return" ||
        made.value?.kind !== "closure" ||
        made.value.adapts !== true
      )
        continue;
      this.adapters.push({
        factory,
        body: made.value.fnName,
        source,
        target: factory.returnType,
        checked: mode === "checked",
        plain: made,
        tests: new Map(),
      });
    }
    return this.adapters.length > known;
  }

  /** A view may be handed more than its type passes when the function it
   * forwards to has more parameters or a rest parameter, or when it only
   * converts types and the value it forwards to can itself be such a
   * view. The second rule makes the set a fixpoint. */
  private settleHolders(): void {
    for (let grew = true; grew;) {
      grew = false;
      for (const adapter of this.adapters) {
        if (this.holding.has(adapter)) continue;
        const { source, target } = adapter;
        if (target.rest === true) continue;
        const more = source.rest === true || fixedCount(source) > target.params.length;
        const relays =
          !more &&
          source.params.length === target.params.length &&
          this.holders.has(typeKey(source));
        if (!more && !relays) continue;
        this.holding.add(adapter);
        const key = typeKey(target);
        const list = this.holders.get(key);
        if (list) list.push(adapter);
        else this.holders.set(key, [adapter]);
        grew = true;
      }
    }
  }

  /** Whether calls through the adapter's target pass more arguments than
   * its source's type has. */
  private widens(adapter: Adapter): boolean {
    const { source, target } = adapter;
    return (
      source.rest !== true && target.rest !== true && target.params.length > source.params.length
    );
  }

  /** `if (f is the view `view` makes) return <the function it forwards to,
   * adapted to the widening's target>`, for the widening's factory. Null
   * when the widening's own conversion has no form with the extra
   * parameters, which leaves the adapter as it was. */
  private lookThrough(lowerer: Lowerer, widening: Adapter, view: Adapter): IrStmt | null {
    const loc = widening.factory.loc;
    const slot = widening.source;
    const target = widening.target;
    // The slot's type with the target's extra parameters: what the view
    // would have been had its slot been that wide.
    const extended: FuncType = {
      kind: "func",
      params: [...slot.params, ...target.params.slice(slot.params.length)],
      ret: slot.ret,
    };
    const param = widening.factory.params[0]!;
    const value: IrExpr = { kind: "varRef", localId: param.localId, type: slot, loc };
    let result: IrExpr = {
      kind: "viewSource",
      value,
      adapter: view.body,
      type: view.source,
      loc,
    };
    if (!typeEquals(view.source, extended)) {
      const first =
        this.adapter(lowerer, view.source, extended, view.checked, loc) ??
        strandedFuncAdapter(lowerer, view.source, extended, loc);
      result = { kind: "call", callee: first, args: [result], type: extended, loc };
    }
    if (!typeEquals(extended, target)) {
      const second = this.adapter(lowerer, extended, target, widening.checked, loc);
      if (second === null) return null;
      result = { kind: "call", callee: second, args: [result], type: target, loc };
    }
    return {
      kind: "if",
      cond: { kind: "viewOf", value, adapter: view.body, type: BOOL, loc },
      then: [{ kind: "return", value: result, loc }],
      else_: null,
      loc,
    };
  }

  /** The general signature adapter from `from` to `to`, built in the mode
   * the adapter it stands in for was built in. */
  private adapter(
    lowerer: Lowerer,
    from: FuncType,
    to: FuncType,
    checked: boolean,
    loc: SrcLoc,
  ): string | null {
    if (!checked) return lowerer.funcCoerceAdapter(from, to, loc);
    lowerer.coercions.checkedRetags++;
    try {
      return lowerer.funcCoerceAdapter(from, to, loc);
    } finally {
      lowerer.coercions.checkedRetags--;
    }
  }
}
