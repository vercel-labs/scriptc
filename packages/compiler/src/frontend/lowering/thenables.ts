/* Thenable adoption for `await` of checked-dynamic values, and the Promise
 * prototype as a value (execa's `(async () => {})().constructor.prototype`
 * Promise mixin; results/opt-execa-thenable/NOTES.md). */
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { thenReader } from "./checked-promise-all.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import type { Lowerer } from "./lowerer.js";

/** Whether any program source can define a thenable: a `then` method or
 * function (generic ones too), a `then:` key, a quoted `'then'` key, or an
 * assignment to `then` (a class field such as `then = (resolve) => ...` or
 * a `.then` property). `.then(` calls alone do not count. Programs without
 * one keep the plain checked-dynamic await. */
export function programMayDefineThenables(lowerer: Lowerer): boolean {
  if (lowerer.thenablesMayBeDefined === null) {
    const pattern = /(^|[^.\w$])then\s*[(<]|\bthen\s*:|['"`]then['"`]|(^|[^\w$])then\s*=(?![=>])/m;
    lowerer.thenablesMayBeDefined = lowerer.program
      .getImplementationSourceFiles()
      .some((sf) => !sf.isDeclarationFile && pattern.test(sf.text));
  }
  return lowerer.thenablesMayBeDefined;
}

/** `await v` over a checked-dynamic value: PromiseResolve(v), then the await
 * of that promise, as JavaScript defines it. A promise is itself, a plain
 * value takes one tick, and an object with a callable `then` is adopted. */
export function awaitDynThenable(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "awaitExpr",
    value: {
      kind: "libCall",
      fn: "dyn.promiseResolve",
      args: [value, thenReader(lowerer, loc)],
      type: { kind: "promise", inner: DYN },
      loc,
    },
    type: DYN,
    loc,
  };
}

const PROTOTYPE_GLOBAL = "%g.%promise.prototype";

/** Promise.prototype as a checked object: own, non-enumerable `then`,
 * `catch` and `finally` (the runtime's promise method values, which act on
 * their receiver) and `constructor`. Built once when the program starts. */
export function promisePrototypeValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  let global = lowerer.globalsList.find((g) => g.id === PROTOTYPE_GLOBAL);
  if (!global) {
    global = {
      id: PROTOTYPE_GLOBAL,
      name: "PromisePrototype",
      type: DYN,
      mutable: true,
    } as IrGlobal;
    lowerer.globalsList.push(global);
    const promise: IrExpr = {
      kind: "dynFrom",
      value: {
        kind: "libCall",
        fn: "dyn.promiseResolve",
        args: [dynUndefinedExpr(loc), thenReader(lowerer, loc)],
        type: { kind: "promise", inner: DYN },
        loc,
      },
      type: DYN,
      loc,
    };
    const str = (value: string): IrExpr => ({
      kind: "dynFrom",
      value: { kind: "strLit", value, type: STRING, loc },
      type: DYN,
      loc,
    });
    const bool = (value: boolean): IrExpr => ({
      kind: "dynFrom",
      value: { kind: "boolLit", value, type: BOOL, loc },
      type: DYN,
      loc,
    });
    const define = (key: string, value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.defineProperty",
        args: [
          varRef(PROTOTYPE_GLOBAL, DYN, loc),
          str(key),
          {
            kind: "dynObjLit",
            fields: [
              { key: { kind: "strLit", value: "value", type: STRING, loc }, value },
              { key: { kind: "strLit", value: "writable", type: STRING, loc }, value: bool(true) },
              {
                key: { kind: "strLit", value: "enumerable", type: STRING, loc },
                value: bool(false),
              },
              {
                key: { kind: "strLit", value: "configurable", type: STRING, loc },
                value: bool(true),
              },
            ],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    });
    const method = (name: string): IrExpr => ({
      kind: "dynKeyGet",
      value: promise,
      key: { kind: "strLit", value: name, type: STRING, loc },
      type: DYN,
      loc,
    });
    lowerer.mainPrelude.push(
      {
        kind: "assign",
        localId: PROTOTYPE_GLOBAL,
        value: { kind: "dynObjLit", fields: [], type: DYN, loc },
        loc,
      },
      define("constructor", builtinGlobalValue("Promise", loc)!),
      define("then", method("then")),
      define("catch", method("catch")),
      define("finally", method("finally")),
    );
  }
  return varRef(PROTOTYPE_GLOBAL, DYN, loc);
}
