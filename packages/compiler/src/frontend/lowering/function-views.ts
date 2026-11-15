import {
  BOOL,
  canAdaptDynFuncTo,
  canBoxFuncIntoDyn,
  canDynCheckTo,
  DYN,
  typeEquals,
  typeKey,
  UNDEFINED_T,
} from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { everyStmtList, everyTypeChild, transformStmtList } from "../../ir/traverse.js";
import { isJsSourceFileName } from "../tsc-codes.js";
import { funcSlotAdaptable, strandedFuncAdapter } from "./coercions/function-adapters.js";
import { widerArrayHelper } from "./containers/array-callbacks.js";
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
 * An array method is the same kind of consumer: JavaScript hands every
 * callback the element, its index and the array, and the method's helper
 * passes the parameters the callback's type has. A shared helper whose
 * callback type has such a view tests for it the same way and hands the
 * function the view forwards to, adapted to the full parameter list, to
 * the same helper built for that list (ArrayHelperRecipe).
 *
 * Two more consumers hand a function more than a view's type has, and
 * both are settled once, when every function is lowered (finish):
 *
 *  - A checked-dynamic callable held at a function type (`dynCheck`: a
 *    bound function, a function that crossed `any`) is a view too, marked
 *    by the boundary. A widening adapter whose source type the program
 *    checks callables into converts the callable itself to the wide type,
 *    whether the wide type has more parameters or a wider one.
 *  - Boxing a view into a checked-dynamic value would give dynamic
 *    callers the view's parameter list. It boxes the function the view
 *    forwards to instead, as the runtime already does for the boundary's
 *    own views: in a program that boxes a function of the view's type,
 *    the view's body carries the mark (IrFunction.boxesSource) and the
 *    backend's box builder for that type, the one place every box of the
 *    type is made (a value converted by itself, a record's member, an
 *    array's element, a call's result), tests for it.
 *
 * The same holds for what an argument may be. A view converts each
 * argument from its slot's parameter type into the function's, so a caller
 * that holds the view at a wider type, or untyped, would have its argument
 * converted twice: into the slot's parameter type, a check the function
 * never asked for, and from there into the function's:
 *
 *   function show(payload: any) { … }
 *   const def: { show: (payload: { diff: string }) => string } = { show };
 *   const loose: (payload: any) => string = def.show;
 *   loose({});            // show runs: neither end names { diff: string }
 *   def.show({} as any);  // the program's claim: the assertion throws
 *
 * JavaScript hands the function the value as it is. So a conversion of
 * the slot's type to one that takes more at a parameter the view converts
 * (argumentWidens), and a boxing where that parameter is typed, start from
 * the function as well: the argument is converted once, into what the
 * function itself declares. A call through the slot's own type is not such
 * a consumer and converts as before. A call written in JavaScript source,
 * or through a binding declared `any`, is one, whatever function type the
 * compiler gave its callee: it makes no claim about its arguments
 * (untypedCalls).
 *
 * Nothing changes where a function is narrowed, or called through a
 * function type the program wrote. A widening adapter changes only when
 * the program holds a view of its source type that can be handed more, and
 * a box builder only when the program boxes a function type it holds such
 * a view of, so a program without that pair compiles as before. */

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
  /** The parameter positions at which the function the view forwards to
   * is handed a converted argument: the view converts there, or forwards
   * unchanged to a value that can itself be such a view. */
  readonly converts: Set<number>;
}

/** Whether `wide` takes values `narrow` excludes, read off the two types:
 * an untyped position where the other names a type, a union with more
 * arms, a record that requires less, a base class. A consumer that holds
 * a function at a parameter type like that can pass what the slot's
 * parameter type rejects. The answer is conservative: false leaves the
 * conversion through the slot's type in place. */
function argumentWidens(
  lowerer: Lowerer,
  wide: IrType,
  narrow: IrType,
  seen: Set<string> = new Set(),
): boolean {
  if (typeEquals(wide, narrow)) return false;
  if (wide.kind === "dyn") return true;
  if (narrow.kind === "dyn") return false;
  const key = `${typeKey(wide)}\n${typeKey(narrow)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const covers = (w: IrType, n: IrType): boolean =>
    typeEquals(w, n) || argumentWidens(lowerer, w, n, seen);
  if (wide.kind === "union") {
    const arms = lowerer.unions.get(wide.unionId)?.arms ?? [];
    const narrowArms =
      narrow.kind === "union" ? (lowerer.unions.get(narrow.unionId)?.arms ?? []) : [narrow];
    return narrowArms.length > 0 && narrowArms.every((n) => arms.some((w) => covers(w, n)));
  }
  if (narrow.kind === "union") return false;
  if (wide.kind === "array" && narrow.kind === "array")
    return argumentWidens(lowerer, wide.elem, narrow.elem, seen);
  if (wide.kind === "object" && narrow.kind === "object")
    return lowerer.isSubclassOf(narrow.className, wide.className);
  if (wide.kind === "record" && narrow.kind === "record") {
    const w = lowerer.shapes.get(wide.shapeId);
    const n = lowerer.shapes.get(narrow.shapeId);
    if (!w || !n || w.tuple || n.tuple || w.indexValue || n.indexValue) return false;
    // Every member the wide record names is one the narrow record has at a
    // type it covers, or one it may leave out. The types differ, so the
    // narrow record then requires more or names a narrower member.
    return w.fields.every((field) => {
      const other = n.fields.find((candidate) => candidate.name === field.name);
      if (other === undefined)
        return (
          field.type.kind === "dyn" ||
          (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0)
        );
      return covers(field.type, other.type);
    });
  }
  return false;
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
  /** By the key of a function type: the adapters whose views of that type
   * convert an argument on its way to the function (Adapter.converts). */
  private readonly converters = new Map<string, Adapter[]>();
  /** The (widening adapter, view) pairs already given a test. */
  private readonly looked = new Set<string>();
  /** The array-method helpers that test for views: the body each was
   * built with, and its tests by the view's name. */
  private readonly helpers = new Map<string, { own: IrStmt[]; tests: Map<string, IrStmt> }>();
  /** How many helper recipes the last call saw. */
  private recipes = 0;

  /** Reads the adapters lowering added since the last call and gives every
   * widening adapter its tests. True when it added or changed a function. */
  process(lowerer: Lowerer): boolean {
    let changed = false;
    for (;;) {
      // A pair to test appears only with a new adapter or a new helper.
      const adapters = this.scan(lowerer);
      if (!adapters && lowerer.arrHofRecipes.size === this.recipes) return changed;
      this.recipes = lowerer.arrHofRecipes.size;
      this.settleHolders();
      let added = this.helperTests(lowerer);
      // Building a test adds adapters to the list; they are read on the
      // next round.
      // By name, so the tests and their order do not depend on the order
      // bodies lowered in.
      for (const widening of [...this.adapters].sort(byFactoryName)) {
        const key = typeKey(widening.source);
        const more = this.widens(widening) ? (this.holders.get(key) ?? []) : [];
        const wider = (this.converters.get(key) ?? []).filter((view) =>
          this.handsWider(lowerer, widening, view),
        );
        if (more.length === 0 && wider.length === 0) continue;
        for (const view of [...new Set([...more, ...wider])].sort(byFactoryName)) {
          const pair = `${widening.factory.name}\n${view.factory.name}`;
          if (this.looked.has(pair)) continue;
          this.looked.add(pair);
          const test = this.quietly(
            lowerer,
            () =>
              (wider.includes(view) ? this.fromFunction(lowerer, widening, view) : null) ??
              (more.includes(view) ? this.lookThrough(lowerer, widening, view) : null),
          );
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

  /** Gives each shared array-method helper whose callback type has a view
   * its tests. True when it added one. */
  private helperTests(lowerer: Lowerer): boolean {
    let added = false;
    for (const name of [...lowerer.arrHofRecipes.keys()].sort()) {
      const helper = lowerer.liftedFnNamed(name);
      const callback = helper?.params[1];
      if (helper === undefined || callback?.type.kind !== "func") continue;
      const views = this.holders.get(typeKey(callback.type));
      if (views === undefined) continue;
      for (const view of [...views].sort(byFactoryName)) {
        const pair = `${name}\n${view.factory.name}`;
        if (this.looked.has(pair)) continue;
        this.looked.add(pair);
        const test = this.quietly(lowerer, () => this.throughHelper(lowerer, helper, view));
        if (test === null) continue;
        let entry = this.helpers.get(name);
        if (entry === undefined) {
          entry = { own: helper.body, tests: new Map() };
          this.helpers.set(name, entry);
          // A fused pipeline calls the callback itself and would skip the
          // tests: the helper leaves the registry fusion reads.
          lowerer.arrHofInfo.delete(name);
        }
        entry.tests.set(view.factory.name, test);
        const tests = entry.tests;
        helper.body = [...[...tests.keys()].sort().map((key) => tests.get(key)!), ...entry.own];
        added = true;
      }
    }
    return added;
  }

  /** `if (f is the view `view` makes) return <the same helper for the full
   * parameter list>(…, <the function it forwards to, adapted to that
   * list>, …)`, for the array-method helper `helper`. Null when the helper
   * already passes everything. */
  private throughHelper(lowerer: Lowerer, helper: IrFunction, view: Adapter): IrStmt | null {
    const loc = helper.loc;
    const recipe = lowerer.arrHofRecipes.get(helper.name);
    const wide = recipe === undefined ? null : widerArrayHelper(lowerer, recipe, loc);
    if (wide === null || wide === helper.name) return null;
    const full = lowerer.liftedFnNamed(wide)?.params[1]?.type;
    const callback = helper.params[1]!;
    if (full?.kind !== "func" || callback.type.kind !== "func") return null;
    const value: IrExpr = { kind: "varRef", localId: callback.localId, type: callback.type, loc };
    const first =
      this.adapter(lowerer, view.source, full, view.checked, loc) ??
      strandedFuncAdapter(lowerer, view.source, full, loc);
    const source: IrExpr = {
      kind: "viewSource",
      value,
      adapter: view.body,
      type: view.source,
      loc,
    };
    const call: IrExpr = {
      kind: "call",
      callee: wide,
      args: helper.params.map((param): IrExpr =>
        param === callback
          ? { kind: "call", callee: first, args: [source], type: full, loc }
          : { kind: "varRef", localId: param.localId, type: param.type, loc },
      ),
      type: helper.returnType,
      loc,
    };
    return {
      kind: "if",
      cond: { kind: "viewOf", value, adapter: view.body, type: BOOL, loc },
      then:
        helper.returnType.kind === "void"
          ? [
              { kind: "exprStmt", expr: call, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value: call, loc }],
      else_: null,
      loc,
    };
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

  /** The consumers that are not signature adapters (a boxing, the
   * checked-dynamic boundary), once `functions` is every lowered function
   * and process has settled. */
  finish(lowerer: Lowerer, functions: readonly IrFunction[]): void {
    // The adapters whose callers can hand the checked-dynamic boundary's
    // view more than its type admits: more arguments, or a wider one.
    const wideners = this.adapters
      .filter((adapter) => this.widens(adapter) || this.widensArgument(lowerer, adapter))
      .sort(byFactoryName);
    if (wideners.length === 0 && this.holders.size === 0 && this.converters.size === 0) return;
    // A dynamic caller passes more arguments than a view's type has, and
    // untyped ones where the type names one. The views it must see through
    // box as the function they forward to, in a program that boxes a
    // function of the view's type.
    let boxed: Set<string> | null = null;
    for (const view of this.adapters) {
      const typed = [...view.converts].some((index) => view.target.params[index]!.kind !== "dyn");
      if (!typed && !this.holding.has(view)) continue;
      boxed ??= this.boxedTypes(lowerer, functions);
      if (!boxed.has(typeKey(view.target))) continue;
      if (
        !canBoxFuncIntoDyn(
          view.source,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      )
        continue;
      const body = lowerer.liftedFnNamed(view.body);
      if (body !== undefined) body.boxesSource = true;
    }
    if (this.converters.size > 0) this.untypedCalls(lowerer, functions);
    if (wideners.length === 0) return;
    // The function types the program checks callables into.
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
    for (const fn of functions) {
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "dynCheck") note(e.type);
          return true;
        },
        stmt: () => true,
      });
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
  }

  /** The function types a value the program boxes can have: every function
   * type reachable from the operand of a `dynFrom` or the target of a
   * `dynCheck`, through members, elements, arms and class fields, and
   * through a function's parameters and result, which its call thunk and
   * the boundary's adapter box in turn. A program that boxes no function
   * of a view's type keeps that view unmarked, and its IR as it was. */
  private boxedTypes(lowerer: Lowerer, functions: readonly IrFunction[]): Set<string> {
    const boxed = new Set<string>();
    const seen = new Set<string>();
    let classes = false;
    const reach = (type: IrType): boolean => {
      const key = typeKey(type);
      if (seen.has(key)) return true;
      seen.add(key);
      if (type.kind === "func") boxed.add(key);
      else if (type.kind === "record") {
        const shape = lowerer.shapes.get(type.shapeId);
        for (const field of shape?.fields ?? []) reach(field.type);
        if (shape?.indexValue) reach(shape.indexValue);
      } else if (type.kind === "union") {
        for (const arm of lowerer.unions.get(type.unionId)?.arms ?? []) reach(arm);
      } else if (type.kind === "object" && !classes) {
        // An instance can be of any subclass: every class's fields.
        classes = true;
        for (const info of lowerer.classes.values())
          for (const field of info.fields.values()) reach(field);
      }
      return everyTypeChild(type, reach);
    };
    for (const fn of functions) {
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "dynFrom") reach(e.value.type);
          else if (e.kind === "dynCheck") reach(e.type);
          return true;
        },
        stmt: () => true,
      });
    }
    return boxed;
  }

  /** A call written in JavaScript source, or through a binding the program
   * declares `any` (callValue.untyped), makes no claim about its
   * arguments, whatever function type the compiler gave the callee (a
   * package function specialized for the callback it is handed, a local
   * that holds a function). Where such a call checks an untyped argument
   * against a parameter type the program holds converting views of, it
   * asks first whether the callee is one, and then calls the function the
   * view forwards to, with the argument checked against that function's
   * own parameter type. */
  private untypedCalls(lowerer: Lowerer, functions: readonly IrFunction[]): void {
    // The calls through the slot's type this pass built: the rewrite
    // visits what it returns.
    const kept = new Set<IrExpr>();
    const through = (e: IrExpr): IrExpr => {
      if (e.kind !== "callValue" || kept.has(e)) return e;
      const slot = e.callee.type;
      if (e.callee.kind !== "varRef" || slot.kind !== "func" || slot.rest === true) return e;
      if (e.untyped !== true && !isJsSourceFileName(e.loc.file)) return e;
      let result: IrExpr = e;
      const views = [...(this.converters.get(typeKey(slot)) ?? [])].sort(byFactoryName).reverse();
      for (const view of views) {
        const args = this.untypedArguments(lowerer, e, slot, view.source);
        if (args === null) continue;
        const loc: SrcLoc = e.loc;
        if (result === e) {
          result = { ...e };
          kept.add(result);
        }
        result = {
          kind: "ternary",
          cond: { kind: "viewOf", value: e.callee, adapter: view.body, type: BOOL, loc },
          then: {
            kind: "callValue",
            callee: {
              kind: "viewSource",
              value: e.callee,
              adapter: view.body,
              type: view.source,
              loc,
            },
            ...(e.receiver === undefined ? {} : { receiver: e.receiver }),
            args,
            type: e.type,
            loc,
          },
          else_: result,
          type: e.type,
          loc,
        };
      }
      return result;
    };
    for (const fn of functions) {
      let calls = false;
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "callValue" && (e.untyped === true || isJsSourceFileName(e.loc.file)))
            calls = true;
          return !calls;
        },
        stmt: () => !calls,
      });
      if (calls) fn.body = transformStmtList(fn.body, { expr: through, stmt: (stmt) => stmt });
    }
  }

  /** The arguments of the call `e` through `slot` for the function type
   * `source` a view of `slot` forwards to: each untyped argument the call
   * checks against the slot's parameter type is checked against the
   * function's instead. Null unless that is the only difference between
   * the two calls. */
  private untypedArguments(
    lowerer: Lowerer,
    e: IrExpr & { kind: "callValue" },
    slot: FuncType,
    source: FuncType,
  ): IrExpr[] | null {
    if (
      source.rest === true ||
      source.params.length !== slot.params.length ||
      e.args.length !== slot.params.length ||
      !typeEquals(source.ret, slot.ret)
    )
      return null;
    let differs = false;
    const args: IrExpr[] = [];
    for (let index = 0; index < e.args.length; index++) {
      const arg = e.args[index]!;
      const own = source.params[index]!;
      if (typeEquals(own, slot.params[index]!)) {
        args.push(arg);
        continue;
      }
      if (arg.kind !== "dynCheck" || arg.value.type.kind !== "dyn") return null;
      const value = arg.value;
      if (own.kind === "dyn") args.push(value);
      else if (
        canDynCheckTo(
          own,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      )
        args.push({ kind: "dynCheck", value, type: own, loc: arg.loc });
      else return null;
      differs = true;
    }
    return differs ? args : null;
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
        converts: new Set(),
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
    for (let grew = true; grew;) {
      grew = false;
      for (const adapter of this.adapters) {
        const { source, target, converts } = adapter;
        if (source.rest === true || target.rest === true) continue;
        const relayed = this.converters.get(typeKey(source));
        const shared = Math.min(source.params.length, target.params.length);
        for (let index = 0; index < shared; index++) {
          if (converts.has(index)) continue;
          if (
            typeEquals(source.params[index]!, target.params[index]!) &&
            !relayed?.some((view) => view.converts.has(index))
          )
            continue;
          if (converts.size === 0) {
            const key = typeKey(target);
            const list = this.converters.get(key);
            if (list) list.push(adapter);
            else this.converters.set(key, [adapter]);
          }
          converts.add(index);
          grew = true;
        }
      }
    }
  }

  /** Whether calls through the adapter's target can pass an argument its
   * source's type excludes. */
  private widensArgument(lowerer: Lowerer, adapter: Adapter): boolean {
    const { source, target } = adapter;
    if (source.rest === true || target.rest === true) return false;
    const shared = Math.min(source.params.length, target.params.length);
    for (let index = 0; index < shared; index++)
      if (argumentWidens(lowerer, target.params[index]!, source.params[index]!)) return true;
    return false;
  }

  /** Whether calls through the adapter's target can pass, at a parameter
   * the view converts, an argument the view's own type excludes. */
  private handsWider(lowerer: Lowerer, adapter: Adapter, view: Adapter): boolean {
    const { source, target } = adapter;
    if (source.rest === true || target.rest === true) return false;
    for (const index of view.converts) {
      const wide = target.params[index];
      if (wide !== undefined && argumentWidens(lowerer, wide, source.params[index]!)) return true;
    }
    return false;
  }

  /** `if (f is the view `view` makes) return <the function it forwards to,
   * converted to the consumer's type>`, for a consumer that hands the view
   * a wider argument (handsWider): each argument is converted once, into
   * the function's own parameter type. Null when that conversion has a
   * parameter or a result it can only refuse, which leaves the adapter as
   * it was. */
  private fromFunction(lowerer: Lowerer, widening: Adapter, view: Adapter): IrStmt | null {
    const loc = widening.factory.loc;
    const target = widening.target;
    const param = widening.factory.params[0]!;
    const value: IrExpr = { kind: "varRef", localId: param.localId, type: widening.source, loc };
    let result: IrExpr = {
      kind: "viewSource",
      value,
      adapter: view.body,
      type: view.source,
      loc,
    };
    if (!typeEquals(view.source, target)) {
      const checked = widening.checked || view.checked;
      const direct = this.inMode(lowerer, checked, () =>
        funcSlotAdaptable(lowerer, view.source, target, loc)
          ? lowerer.funcCoerceAdapter(view.source, target, loc)
          : null,
      );
      if (direct === null) return null;
      result = { kind: "call", callee: direct, args: [result], type: target, loc };
    }
    return {
      kind: "if",
      cond: { kind: "viewOf", value, adapter: view.body, type: BOOL, loc },
      then: [{ kind: "return", value: result, loc }],
      else_: null,
      loc,
    };
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
    return this.inMode(lowerer, checked, () => lowerer.funcCoerceAdapter(from, to, loc));
  }

  /** Runs `build` in the checked mode a method field's adapter is planned
   * and built in, or outside it. */
  private inMode<T>(lowerer: Lowerer, checked: boolean, build: () => T): T {
    if (!checked) return build();
    lowerer.coercions.checkedRetags++;
    try {
      return build();
    } finally {
      lowerer.coercions.checkedRetags--;
    }
  }
}
