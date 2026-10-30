import { dynUndefinedExpr, numLit, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  canConvertToDyn,
  funcOf,
  typeEquals,
  typeKey,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { transformStmtList } from "../../ir/traverse.js";
import { genResultRecord } from "../type-mapper.js";
import type { DispatchSites } from "./dispatch-sites.js";
import type { Lowerer, UntypedLoopSite } from "./lowerer.js";

type GeneratorType = Extract<IrType, { kind: "generator" }>;
type Invoke = Extract<IrExpr, { kind: "dynInvoke" }>;
type KeyGet = Extract<IrExpr, { kind: "dynKeyGet" }>;

/** The generator methods a dynamic call or read steps. */
export const GENERATOR_STEP_METHODS = new Set(["next", "return", "throw"]);

/** The iterator helper methods the runtime answers on checked iterators. */
export const HELPER_METHODS = new Set([
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
  "reduce",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
]);

/** An untyped consumer resumes the original native fiber. The capsule's
 * exact type key selects the channel conversions and result layout. */
export class GeneratorDynamicDispatch {
  private readonly generators = new Map<string, GeneratorType>();
  private readonly dispatches = new Map<
    string,
    { fn: IrFunction; source: Invoke; types: Set<string> }
  >();
  private readonly generated = new Set<IrFunction>();
  private readonly properties = new Map<string, { fn: IrFunction; types: Set<string> }>();
  /** Whether %main registers the next/return getters with the runtime. */
  private membersRegistered = false;

  /** The getter for a generator capsule's `method` (next, return, throw or
   * an iterator helper): a checked function over the capsule's type keys
   * that answers the method as a function value. `read` is the dyn read
   * whose fallback it keeps for other receivers. */
  private ensureProperty(lowerer: Lowerer, method: string, read: KeyGet): IrFunction {
    const existing = this.properties.get(method);
    if (existing) return existing.fn;
    const loc = read.loc;
    const fn: IrFunction = {
      name: `%dyn.generator.get.${method}`,
      params: [{ localId: "value", name: "value", type: DYN }],
      returnType: DYN,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      body: [{ kind: "return", value: { ...read, value: varRef("value", DYN, loc) }, loc }],
      loc,
    };
    this.properties.set(method, { fn, types: new Set() });
    this.generated.add(fn);
    lowerer.liftedFns.push(fn);
    lowerer.shareHelper(fn);
    // The runtime's own helper functions answer the helper methods.
    if (HELPER_METHODS.has(method)) return fn;
    lowerer.shareHelper(`%dyn.generator.method.${method}`);
    lowerer.liftedFns.push({
      name: `%dyn.generator.method.${method}`,
      params: [{ localId: "arg", name: "arg", type: DYN }],
      returnType: DYN,
      locals: [{ id: "arg", name: "arg", type: DYN, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynInvoke",
            method,
            calleeName: `Generator.${method}`,
            recv: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
            args: [varRef("arg", DYN, loc)],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return fn;
  }

  process(
    lowerer: Lowerer,
    functions: readonly IrFunction[],
    classHelpers: ReadonlySet<IrFunction>,
    sites: DispatchSites,
  ): boolean {
    const seen = new Set<string>();
    const rewrite = new Set<IrFunction>();
    let runtimeSteps = false;
    const discover = (type: IrType): void => {
      const key = typeKey(type);
      if (seen.has(key)) return;
      seen.add(key);
      if (type.kind === "generator") this.generators.set(key, type);
      else if (type.kind === "func") discover(type.ret);
      else if (type.kind === "promise") discover(type.inner);
      else if (type.kind === "array") discover(type.elem);
      else if (type.kind === "record")
        lowerer.shapes.get(type.shapeId)?.fields.forEach((field) => discover(field.type));
      else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(discover);
    };
    for (const fn of functions) {
      const found = sites.of(fn);
      found.values.forEach(discover);
      // The runtime steps the values iterator helpers and destructuring
      // receive.
      if (found.runtimeSteps) runtimeSteps = true;
      if (found.generatorSteps) rewrite.add(fn);
    }
    let changed = false;
    for (const fn of functions) {
      // The generator helper's fallback may itself dispatch native classes.
      // Its class helper must retain the runtime fallback, not route back
      // to the generator helper and form an indirect recursion cycle.
      if (this.generated.has(fn) || classHelpers.has(fn) || !rewrite.has(fn)) continue;
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          // A helper method read reaches the runtime's helpers through the
          // same getters once generators are boxed.
          if (
            expr.kind === "dynKeyGet" &&
            expr.key.kind === "strLit" &&
            (GENERATOR_STEP_METHODS.has(expr.key.value) ||
              (HELPER_METHODS.has(expr.key.value) && this.generators.size > 0))
          ) {
            const method = expr.key.value;
            if (!this.properties.has(method)) changed = true;
            const getter = this.ensureProperty(lowerer, method, expr);
            return {
              kind: "call",
              callee: getter.name,
              args: [expr.value],
              type: DYN,
              loc: expr.loc,
            };
          }
          if (expr.kind !== "dynInvoke" || !GENERATOR_STEP_METHODS.has(expr.method)) return expr;
          const key = JSON.stringify([expr.method, expr.args.length, expr.calleeName]);
          let dispatch = this.dispatches.get(key);
          if (!dispatch) {
            const loc = expr.loc;
            const params = [expr.recv, ...expr.args].map((_, i) => ({
              localId: `p.${i}`,
              name: `p${i}`,
              type: DYN,
            }));
            const helper: IrFunction = {
              name: `%dyn.generator.call.${this.dispatches.size}`,
              params,
              returnType: DYN,
              locals: params.map((p) => ({
                id: p.localId,
                name: p.name,
                type: DYN,
                mutable: false,
              })),
              body: [
                {
                  kind: "return",
                  value: {
                    ...expr,
                    recv: varRef("p.0", DYN, loc),
                    args: expr.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc)),
                  },
                  loc,
                },
              ],
              loc,
            };
            dispatch = { fn: helper, source: expr, types: new Set() };
            this.dispatches.set(key, dispatch);
            this.generated.add(helper);
            lowerer.liftedFns.push(helper);
            lowerer.shareHelper(helper);
            changed = true;
          }
          return {
            kind: "call",
            callee: dispatch.fn.name,
            args: [expr.recv, ...expr.args],
            type: DYN,
            loc: expr.loc,
          };
        },
      });
    }
    // Iterator helpers called on untyped values may reach a compiled
    // generator's capsule; the runtime drives it through these getters,
    // which %main registers first.
    const firstFn = functions[0];
    if (
      runtimeSteps &&
      !this.membersRegistered &&
      firstFn !== undefined &&
      [...this.generators.values()].some((t) => t.async !== true)
    ) {
      const loc = firstFn.loc;
      const read = (method: string): KeyGet => ({
        kind: "dynKeyGet",
        value: varRef("value", DYN, loc),
        key: { kind: "strLit", value: method, type: STRING, loc },
        type: DYN,
        loc,
      });
      const getterValue = (method: string): IrExpr => ({
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: this.ensureProperty(lowerer, method, read(method)).name,
          captures: [],
          type: funcOf([DYN], DYN),
          loc,
        },
        type: DYN,
        loc,
      });
      lowerer.mainPrelude.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.setGeneratorMembers",
          args: [getterValue("next"), getterValue("return")],
          type: VOID,
          loc,
        },
        loc,
      });
      this.membersRegistered = true;
      changed = true;
    }
    for (const [method, property] of this.properties)
      for (const [key] of this.generators) {
        if (property.types.has(key)) continue;
        property.types.add(key);
        const loc = property.fn.loc;
        property.fn.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [varRef("value", DYN, loc), { kind: "strLit", value: key, type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "return",
              value: HELPER_METHODS.has(method)
                ? {
                    kind: "libCall",
                    fn: "dyn.iteratorHelperMethod",
                    args: [{ kind: "strLit", value: method, type: STRING, loc }],
                    type: DYN,
                    loc,
                  }
                : {
                    kind: "dynFrom",
                    value: {
                      kind: "closure",
                      fnName: `%dyn.generator.method.${method}`,
                      captures: [],
                      type: funcOf([DYN], DYN),
                      loc,
                    },
                    type: DYN,
                    loc,
                  },
              loc,
            },
          ],
          else_: null,
          loc,
        });
        changed = true;
      }
    for (const dispatch of this.dispatches.values())
      for (const [key, type] of this.generators) {
        if (dispatch.types.has(key)) continue;
        dispatch.types.add(key);
        const loc = dispatch.fn.loc;
        const receiver = varRef("p.0", DYN, loc);
        const mode = dispatch.source.method as "next" | "return" | "throw";
        const result = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions)!;
        const resultType: IrType = type.async ? { kind: "promise", inner: result } : result;
        const supplied = dispatch.source.args.length > 0;
        const incoming = supplied ? varRef("p.1", DYN, loc) : dynUndefinedExpr(loc);
        const channel = mode === "next" ? type.nextT : type.retT;
        // return() with no value completes with undefined, as the typed
        // .return() does, whatever the return channel's type.
        const arg =
          mode === "throw"
            ? incoming
            : channel.kind === "undefinedT" ||
                channel.kind === "void" ||
                (mode === "return" && !supplied)
              ? null
              : lowerer.coerceToExpected(incoming, channel);
        const convertible = canConvertToDyn(
          resultType,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        );
        const body: IrStmt[] = [];
        // A void return channel cannot store a supplied completion value.
        if (mode === "return" && type.retT.kind === "void" && supplied)
          body.push({
            kind: "if",
            cond: {
              kind: "unary",
              op: "!",
              operand: { kind: "dynTest", test: "undefined", value: incoming, type: BOOL, loc },
              type: BOOL,
              loc,
            },
            then: [
              {
                kind: "runtimeFence",
                code: "SC1071",
                message:
                  "returning a value through a void native generator channel is not supported yet",
                loc,
              },
            ],
            else_: null,
            loc,
          });
        const resume = (sent: IrExpr | null): IrStmt => ({
          kind: "return",
          value: {
            kind: "dynFrom",
            value: {
              kind: "genResume",
              mode,
              gen: { kind: "dynCheck", value: receiver, type, loc },
              arg: sent,
              type: resultType,
              loc,
            },
            type: DYN,
            loc,
          },
          loc,
        });
        const valid =
          convertible && (arg === null || mode === "throw" || typeEquals(arg.type, channel));
        if (valid && mode === "return" && arg !== null)
          body.push({
            kind: "if",
            cond: { kind: "dynTest", test: "undefined", value: incoming, type: BOOL, loc },
            then: [resume(null)],
            else_: null,
            loc,
          });
        body.push(
          valid
            ? resume(arg)
            : {
                kind: "runtimeFence",
                code: "SC1071",
                message:
                  "resuming this native generator through an untyped value is not supported yet",
                loc,
              },
        );
        dispatch.fn.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [receiver, { kind: "strLit", value: key, type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: body,
          else_: null,
          loc,
        });
        changed = true;
      }
    return this.stepUntypedLoops(lowerer, functions) || changed;
  }

  /** The generator types a loop over an untyped iterable can step natively:
   * sync generators for `for … of`, and both kinds for `for await` (a sync
   * generator through the async-from-sync rules). Insertion order, so a
   * type keeps its index as later waves add types. */
  private loopTypes(lowerer: Lowerer, site: UntypedLoopSite): [string, GeneratorType][] {
    const out: [string, GeneratorType][] = [];
    for (const [key, type] of this.generators) {
      if (type.async === true && !site.async) continue;
      const result = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions);
      if (result === null) continue;
      // next() with no argument, as the protocol calls it.
      const channel = type.nextT;
      if (channel.kind !== "undefinedT" && channel.kind !== "void" && channel.kind !== "dyn")
        continue;
      if (
        !canConvertToDyn(
          result,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      )
        continue;
      out.push([key, type]);
    }
    return out;
  }

  /** Loops over untyped iterables step the program's own generators on the
   * typed path. Once the loop has its iterator and next method, a kind local
   * records which generator type the iterator is, when its next method is
   * the generator's own (`%dyn.generator.method.next`); each step then
   * resumes the generator directly and boxes only the value, where the
   * protocol would box the result record and its promise and read them
   * back. Every other iterator, and every early exit (return() through the
   * protocol), keeps the dynamic path. The awaits are the protocol's: a
   * `for await` over an async generator awaits next()'s promise, and over a
   * sync generator awaits once for the result and, reached through
   * Symbol.iterator, once for the value. */
  private stepUntypedLoops(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    if (this.generators.size === 0 || lowerer.untypedLoops.size === 0) return false;
    // The loop reads next through the getter only once it exists.
    if (!this.properties.has("next")) return false;
    let changed = false;
    for (const fn of functions) {
      if (this.generated.has(fn)) continue;
      const byKind = new Map<string, UntypedLoopSite>();
      const byValue = new Map<string, UntypedLoopSite>();
      for (const local of fn.locals) {
        const site = lowerer.untypedLoops.get(local);
        if (site === undefined) continue;
        byKind.set(site.kind, site);
        byValue.set(site.value, site);
      }
      if (byKind.size === 0) continue;
      fn.body = transformStmtList(fn.body, {
        expr: (expr) => expr,
        stmt: (stmt) => {
          if (stmt.kind !== "varDecl" || stmt.init === null) return stmt;
          const opened = byKind.get(stmt.localId);
          if (opened !== undefined) {
            const types = this.loopTypes(lowerer, opened);
            const init = this.loopKind(opened, types, stmt.loc);
            if (this.loopKindCount(stmt.init) === types.length) return stmt;
            changed = true;
            return { ...stmt, init };
          }
          const site = byValue.get(stmt.localId);
          if (site === undefined) return stmt;
          const types = this.loopTypes(lowerer, site);
          // The protocol step is the innermost else of the type chain.
          let fallback = stmt.init;
          let present = 0;
          while (
            fallback.kind === "ternary" &&
            fallback.cond.kind === "bin" &&
            fallback.cond.left.kind === "varRef" &&
            fallback.cond.left.localId === site.kind
          ) {
            fallback = fallback.else_;
            present++;
          }
          if (present === types.length) return stmt;
          let init = fallback;
          for (let i = types.length - 1; i >= 0; i--) {
            const [, type] = types[i]!;
            const record = `${site.kind}.r${i + 1}`;
            init = {
              kind: "ternary",
              cond: {
                kind: "bin",
                op: "===",
                left: varRef(site.kind, F64, stmt.loc),
                right: numLit(i + 1, stmt.loc),
                type: BOOL,
                loc: stmt.loc,
              },
              then: this.loopStep(lowerer, fn, site, type, record, stmt.loc),
              else_: init,
              type: DYN,
              loc: stmt.loc,
            };
          }
          changed = true;
          return { ...stmt, init };
        },
      });
    }
    return changed;
  }

  /** How many generator types a loop's kind initializer tests: the chain
   * inside its own-method test (loopKind). */
  private loopKindCount(init: IrExpr): number {
    if (init.kind !== "ternary") return 0;
    let count = 0;
    for (let chain = init.then; chain.kind === "ternary"; chain = chain.else_) count++;
    return count;
  }

  /** The loop's kind: the 1-based index of the generator type its iterator
   * is, when the next method it read is that generator's own, else 0. */
  private loopKind(
    site: UntypedLoopSite,
    types: readonly [string, GeneratorType][],
    loc: IrExpr["loc"],
  ): IrExpr {
    const own: IrExpr = {
      kind: "libCall",
      fn: "dyn.sameValue",
      args: [
        varRef(site.next, DYN, loc),
        {
          kind: "dynFrom",
          value: {
            kind: "closure",
            fnName: "%dyn.generator.method.next",
            captures: [],
            type: funcOf([DYN], DYN),
            loc,
          },
          type: DYN,
          loc,
        },
      ],
      type: BOOL,
      loc,
    };
    let kind: IrExpr = numLit(0, loc);
    for (let i = types.length - 1; i >= 0; i--)
      kind = {
        kind: "ternary",
        cond: {
          kind: "libCall",
          fn: "dyn.typedRefIs",
          args: [
            varRef(site.iterator, DYN, loc),
            { kind: "strLit", value: types[i]![0], type: STRING, loc },
          ],
          type: BOOL,
          loc,
        },
        then: numLit(i + 1, loc),
        else_: kind,
        type: F64,
        loc,
      };
    return types.length === 0
      ? kind
      : { kind: "ternary", cond: own, then: kind, else_: numLit(0, loc), type: F64, loc };
  }

  /** One step of a loop over an untyped iterable that is a `type`
   * generator: sets the loop's done flag and answers the value, boxed. */
  private loopStep(
    lowerer: Lowerer,
    fn: IrFunction,
    site: UntypedLoopSite,
    type: GeneratorType,
    recordId: string,
    loc: IrExpr["loc"],
  ): IrExpr {
    const gen: IrExpr = { kind: "dynCheck", value: varRef(site.iterator, DYN, loc), type, loc };
    const setDone = (value: IrExpr): IrStmt => ({ kind: "assign", localId: site.done, value, loc });
    const doneRef = varRef(site.done, BOOL, loc);
    const result = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions)!;
    if (!fn.locals.some((local) => local.id === recordId))
      fn.locals.push({ id: recordId, name: recordId, type: result, mutable: false });
    const field = (name: "value" | "done", fieldType: IrType): IrExpr => ({
      kind: "recordGet",
      obj: varRef(recordId, result, loc),
      shapeId: result.shapeId,
      field: name,
      type: fieldType,
      loc,
    });
    const valueType = lowerer.shapes
      .get(result.shapeId)!
      .fields.find((f) => f.name === "value")!.type;
    const boxed: IrExpr = { kind: "dynFrom", value: field("value", valueType), type: DYN, loc };
    const awaitDyn = (value: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "async.awaitDyn",
      args: [value],
      type: DYN,
      loc,
    });
    const resumed: IrExpr = {
      kind: "genResume",
      mode: "next",
      gen,
      arg: null,
      type: type.async === true ? { kind: "promise", inner: result } : result,
      loc,
    };
    if (!site.async)
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: recordId, init: resumed, loc },
          setDone(field("done", BOOL)),
        ],
        result: {
          kind: "ternary",
          cond: doneRef,
          then: dynUndefinedExpr(loc),
          else_: boxed,
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      };
    if (type.async === true)
      return {
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: recordId,
            init: { kind: "awaitExpr", value: resumed, type: result, loc },
            loc,
          },
          setDone(field("done", BOOL)),
        ],
        result: {
          kind: "ternary",
          cond: doneRef,
          then: dynUndefinedExpr(loc),
          else_: boxed,
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      };
    // for await over a sync generator: the result awaits once. When the
    // loop reached it through Symbol.iterator, the async-from-sync iterator
    // also awaits the value (the final one too); a sync generator that an
    // object's Symbol.asyncIterator returns passes the value as it is, as
    // the protocol does.
    const fromSync: IrExpr =
      site.sync === null
        ? { kind: "boolLit", value: false, type: BOOL, loc }
        : varRef(site.sync, BOOL, loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: recordId, init: resumed, loc },
        setDone(field("done", BOOL)),
        { kind: "exprStmt", expr: awaitDyn(dynUndefinedExpr(loc)), loc },
      ],
      result: {
        kind: "ternary",
        cond: doneRef,
        then: {
          kind: "ternary",
          cond: fromSync,
          then: {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: awaitDyn(boxed), loc }],
            result: dynUndefinedExpr(loc),
            type: DYN,
            loc,
          },
          else_: dynUndefinedExpr(loc),
          type: DYN,
          loc,
        },
        else_: {
          kind: "ternary",
          cond: fromSync,
          then: awaitDyn(boxed),
          else_: boxed,
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      },
      type: DYN,
      loc,
    };
  }
}
