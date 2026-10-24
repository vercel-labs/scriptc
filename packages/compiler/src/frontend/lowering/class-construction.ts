import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { constructedValue } from "./constructor-returns.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  typeEquals,
  typeKey,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmt, transformExpr, transformStmtList } from "../../ir/traverse.js";
import type { DispatchSites } from "./dispatch-sites.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";
import type { ParamShape } from "./call-signatures.js";
import { classPrototypeData } from "./class-prototypes.js";
import { classInstanceOf } from "./class-dynamic-dispatch.js";
import { inheritedBuiltinCtorFence } from "./lower-classes.js";

const PREFIX = "%class.construct:";
const PACKED = `${PREFIX}packed`;
const INSTANCEOF = "%class.instanceof:dynamic";

/** `value instanceof callee` for an untyped constructor value, through one
 * shared helper. `refusal` is the site's message for a runtime
 * constructor with no instance test. */
export function checkedClassInstanceOf(
  lowerer: Lowerer,
  value: IrExpr,
  callee: IrExpr,
  refusal: string,
  loc: SrcLoc,
): IrExpr {
  if (!lowerer.liftedFns.some((fn) => fn.name === INSTANCEOF)) {
    const params = [
      { localId: "value", name: "value", type: DYN },
      { localId: "callee", name: "callee", type: DYN },
      { localId: "refusal", name: "refusal", type: STRING },
    ];
    lowerer.liftedFns.push({
      name: INSTANCEOF,
      params,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      returnType: BOOL,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "bytes.instanceOf",
            args: [
              varRef("value", DYN, loc),
              varRef("callee", DYN, loc),
              varRef("refusal", STRING, loc),
            ],
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "call",
    callee: INSTANCEOF,
    args: [value, callee, { kind: "strLit", value: refusal, type: STRING, loc }],
    type: BOOL,
    loc,
  };
}

/** Checked construction dispatches to emitted native constructor thunks. */
export function checkedClassConstruction(
  lowerer: Lowerer,
  callee: IrExpr,
  args: IrExpr[],
  loc: SrcLoc,
): IrExpr {
  const name = `${PREFIX}${args.length}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const params = [callee, ...args].map((_, index) => ({
      localId: `p.${index}`,
      name: `p${index}`,
      type: DYN,
    }));
    lowerer.liftedFns.push({
      name,
      params,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      returnType: DYN,
      speculativeDispatch: true,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.construct",
            args: [
              varRef("p.0", DYN, loc),
              {
                kind: "dynArrLit",
                elems: params.slice(1).map((param) => varRef(param.localId, DYN, loc)),
                type: DYN,
                loc,
              },
              { kind: "strLit", value: "constructor", type: STRING, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [callee, ...args], type: DYN, loc };
}

/** Runtime-length constructor spreads keep argument evaluation before defaults. */
export function checkedClassConstructionPacked(
  lowerer: Lowerer,
  callee: IrExpr,
  packed: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (!lowerer.liftedFns.some((fn) => fn.name === PACKED)) {
    const params = [
      { localId: "p.0", name: "callee", type: DYN },
      { localId: "p.1", name: "arguments", type: DYN },
    ];
    lowerer.liftedFns.push({
      name: PACKED,
      params,
      locals: params.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      })),
      returnType: DYN,
      speculativeDispatch: true,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.construct",
            args: [
              varRef("p.0", DYN, loc),
              varRef("p.1", DYN, loc),
              { kind: "strLit", value: "constructor", type: STRING, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: PACKED, args: [callee, packed], type: DYN, loc };
}

function constructorArguments(
  lowerer: Lowerer,
  params: ParamShape[],
  incoming: IrExpr[],
  loc: SrcLoc,
  packed?: IrExpr,
): IrExpr[] | null {
  const args: IrExpr[] = [];
  let index = 0;
  for (const param of params) {
    if (
      packed &&
      (param.mode === "rest" || param.mode === "dynRest" || param.mode === "arguments")
    ) {
      const rest: IrExpr =
        param.mode === "arguments"
          ? packed
          : {
              kind: "libCall",
              fn: "dyn.arrayProtoCall",
              args: [
                packed,
                { kind: "strLit", value: "slice", type: STRING, loc },
                {
                  kind: "dynArrLit",
                  elems: [
                    {
                      kind: "dynFrom",
                      value: { kind: "numLit", value: index, type: F64, loc },
                      type: DYN,
                      loc,
                    },
                  ],
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            };
      const converted = lowerer.coerceToExpected(rest, param.type);
      if (!typeEquals(converted.type, param.type)) return null;
      args.push(converted);
      continue;
    }
    if ((param.mode === "dynRest" || param.mode === "arguments") && param.type.kind === "dyn") {
      args.push({
        kind: "dynArrLit",
        elems: param.mode === "arguments" ? incoming : incoming.slice(index),
        type: DYN,
        loc,
      });
      index = incoming.length;
    } else if (param.mode === "rest" && param.type.kind === "array") {
      const elems = incoming
        .slice(index)
        .map((value) =>
          lowerer.coerceToExpected(value, param.type.kind === "array" ? param.type.elem : DYN),
        );
      if (
        elems.some(
          (value) => !typeEquals(value.type, param.type.kind === "array" ? param.type.elem : DYN),
        )
      )
        return null;
      args.push({ kind: "arrayLit", elems, type: param.type, loc });
      index = incoming.length;
    } else {
      if (param.mode !== "required" && param.mode !== "omittable") return null;
      let value: IrExpr = packed
        ? {
            kind: "libCall",
            fn: "dyn.arrAt",
            args: [packed, { kind: "numLit", value: index++, type: F64, loc }],
            type: DYN,
            loc,
          }
        : (incoming[index++] ?? param.callDefault ?? dynUndefinedExpr(loc));
      if (param.callDefault && value.type.kind === "dyn")
        value = {
          kind: "ternary",
          cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
          then: lowerer.coerceToExpected(param.callDefault, DYN),
          else_: value,
          type: DYN,
          loc,
        };
      const converted = lowerer.coerceToExpected(value, param.type);
      if (!typeEquals(converted.type, param.type)) return null;
      args.push(converted);
    }
  }
  return args;
}

export class ClassConstructionDispatch {
  private readonly constructors = new Set<string>();
  private readonly completed = new Map<string, Set<string>>();
  private prototypeHelper: IrFunction | null = null;
  private readonly prototypes = new Set<string>();

  process(lowerer: Lowerer, functions: readonly IrFunction[], sites: DispatchSites): boolean {
    const discover = (type: IrType): void => {
      if (type.kind === "classval") this.constructors.add(type.className);
      else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(discover);
    };
    const prototypeReads = new Set<IrFunction>();
    for (const fn of functions) {
      const found = sites.of(fn);
      found.values.forEach(discover);
      if (found.basePrototypes) prototypeReads.add(fn);
    }
    let changed = false;
    for (const fn of functions) {
      if (fn === this.prototypeHelper || !prototypeReads.has(fn)) continue;
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          if (expr.kind !== "libCall" || expr.fn !== "dyn.classBasePrototype") return expr;
          if (!this.prototypeHelper) {
            const loc = expr.loc;
            this.prototypeHelper = {
              name: "%class.basePrototype",
              params: [{ localId: "value", name: "value", type: DYN }],
              locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
              returnType: DYN,
              loc,
              body: [
                { kind: "return", value: { ...expr, args: [varRef("value", DYN, loc)] }, loc },
              ],
            };
            lowerer.liftedFns.push(this.prototypeHelper);
            changed = true;
          }
          return {
            kind: "call",
            callee: this.prototypeHelper.name,
            args: expr.args,
            type: DYN,
            loc: expr.loc,
          };
        },
      });
    }
    if (this.prototypeHelper)
      for (const name of this.constructors) {
        if (this.prototypes.has(name)) continue;
        this.prototypes.add(name);
        const info = lowerer.classes.get(name);
        if (!info) continue;
        const loc = this.prototypeHelper.loc;
        const type: IrType = { kind: "classval", className: name };
        const value = varRef("value", DYN, loc);
        const prototype = classPrototypeData(lowerer, info, loc, {
          kind: "dynCheck",
          value,
          type,
          loc,
        });
        if (!prototype) continue;
        const resolved = transformExpr(prototype, {
          stmt: (stmt) => stmt,
          expr: (expr) =>
            expr.kind === "libCall" && expr.fn === "dyn.classBasePrototype"
              ? {
                  kind: "call",
                  callee: this.prototypeHelper!.name,
                  args: expr.args,
                  type: DYN,
                  loc: expr.loc,
                }
              : expr,
        });
        this.prototypeHelper.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.classIs",
            args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: resolved, loc }],
          else_: null,
          loc,
        });
        changed = true;
      }
    for (const fn of functions) {
      if (!fn.name.startsWith(PREFIX) && fn.name !== INSTANCEOF) continue;
      let completed = this.completed.get(fn.name);
      if (!completed) this.completed.set(fn.name, (completed = new Set()));
      const loc = fn.loc;
      for (const name of this.constructors) {
        if (completed.has(name)) continue;
        completed.add(name);
        const info = lowerer.classes.get(name);
        if (!info || info.generic || info.def.runtime) continue;
        if (fn.name === INSTANCEOF) {
          const type: IrType = { kind: "classval", className: name };
          const callee = varRef("callee", DYN, loc);
          const result = classInstanceOf(lowerer, varRef("value", DYN, loc), info, loc, {
            kind: "dynCheck",
            value: callee,
            type,
            loc,
          });
          fn.body.unshift({
            kind: "if",
            cond: {
              kind: "libCall",
              fn: "dyn.classIs",
              args: [callee, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
              type: BOOL,
              loc,
            },
            then: [{ kind: "return", value: result, loc }],
            else_: null,
            loc,
          });
          changed = true;
          continue;
        }
        const type: IrType = { kind: "classval", className: name };
        const callee = varRef("p.0", DYN, loc);
        // A constructor inherited from a runtime stream or EventEmitter
        // takes no arguments here: arguments report at run time, as they do
        // at compile time for typed construction.
        const fence = inheritedBuiltinCtorFence(lowerer, info, loc);
        if (fence !== null && fn.name !== PACKED && fn.params.length > 1) {
          fn.body.unshift({
            kind: "if",
            cond: {
              kind: "libCall",
              fn: "dyn.classIs",
              args: [callee, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
              type: BOOL,
              loc,
            },
            then: [fence],
            else_: null,
            loc,
          });
          changed = true;
          continue;
        }
        const args = constructorArguments(
          lowerer,
          info.ctorParams,
          fn.params.slice(1).map((param) => varRef(param.localId, DYN, loc)),
          loc,
          fn.name === PACKED ? varRef("p.1", DYN, loc) : undefined,
        );
        if (!args) continue;
        const value = constructedValue(lowerer, info, {
          kind: "newValue",
          callee: { kind: "dynCheck", value: callee, type, loc },
          args,
          type: { kind: "object", className: name },
          loc,
        });
        const body: IrStmt[] = [
          { kind: "return", value: lowerer.coerceToExpected(value, DYN), loc },
        ];
        // A spread call's argument count is known only at run time.
        if (fence !== null && fn.name === PACKED)
          body.unshift({
            kind: "if",
            cond: {
              kind: "bin",
              op: ">",
              left: {
                kind: "libCall",
                fn: "dyn.arrLen",
                args: [varRef("p.1", DYN, loc)],
                type: F64,
                loc,
              },
              right: { kind: "numLit", value: 0, type: F64, loc },
              type: BOOL,
              loc,
            },
            then: [fence],
            else_: null,
            loc,
          });
        fn.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.classIs",
            args: [callee, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: body,
          else_: null,
          loc,
        });
        lowerer.noteEdge(`%${name}.constructor`);
        changed = true;
      }
    }
    return changed;
  }
}

/** Programs that construct dynamic values and read members a value may
 * inherit (`new (o[key])()`, `new o.constructor()`) install `new` through the
 * builtin constructors those reads answer, in %main
 * (scr_dyn_global_construct.c). Every other program lowers as before. */
export function installGlobalConstruct(functions: IrFunction[]): void {
  let constructs = false;
  let inherits = false;
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && e.fn === "dyn.construct") constructs = true;
      else if (
        e.kind === "dynKeyGet" &&
        (e.key.kind !== "strLit" || INHERITED_CONSTRUCT_KEYS.has(e.key.value))
      )
        inherits = true;
      return !(constructs && inherits);
    },
    stmt: (): boolean => !(constructs && inherits),
  };
  for (const fn of functions) {
    for (const s of fn.body) everyStmt(s, visitor);
    if (constructs && inherits) break;
  }
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (!constructs || !inherits || !main) return;
  main.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.globalConstructInstall",
      args: [],
      type: VOID,
      loc: main.loc,
    },
    loc: main.loc,
  });
}

/** The constant keys whose reads may answer a builtin constructor. */
const INHERITED_CONSTRUCT_KEYS: ReadonlySet<string> = new Set(["constructor"]);
