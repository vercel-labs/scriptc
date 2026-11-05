/* A CommonJS module's exports object taken as a value.
 *
 * The compiled module system has no reflective exports object: each export
 * is a module global, and a requirer's `const m = require("./m.cjs")`
 * resolves members through the export table. A module that re-exports
 * another module's namespace (`var cst = require("./parse/cst.cjs");
 * exports.CST = cst;`) uses the namespace itself as a value, and its
 * requirers read `yaml.CST.parse(...)` through it.
 *
 * The value is the runtime's exports object (scr_cjs_exports.c): one plain
 * extensible object per module, with the module's export names as own
 * enumerable accessors in assignment order. Each accessor calls a compiled
 * getter that reads the export's module global, so the object is live — a
 * value the exporting module assigns after it finished evaluating is
 * visible — and every holder of the namespace sees the same object. */
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import {
  arrayOf,
  funcOf,
  DYN,
  STRING,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import { newFnCtx, PoisonError, type Lowerer } from "./lowerer.js";
import { cjsExportValueByName } from "./cjs-inline-require.js";

/** The compiled getter behind an exports object: one lifted function per
 * module that answers an export's current value by name. An export whose
 * value has no checked-dynamic form throws its fence when it is read. */
function cjsExportsGetter(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  moduleId: string,
  keys: readonly string[],
): string {
  const name = `%cjs.exports:${moduleId}`;
  if (lowerer.liftedFns.some((fn) => fn.name === name)) return name;
  const context = newFnCtx(false, null, null, DYN);
  const previousClass = lowerer.currentClass;
  lowerer.currentClass = null;
  lowerer.fnStack.push(context);
  try {
    const body: IrStmt[] = [];
    for (const key of keys) {
      const blame = lowerer.cjsModuleExportSymbol(dep, key)?.declarations[0] ?? dep;
      const loc = locOf(blame);
      const diagsBefore = lowerer.diags.length;
      let read: IrStmt[];
      try {
        const value = cjsExportValueByName(lowerer, dep, key, blame);
        if (value === null) {
          lowerer.unsupported(
            "SC1090",
            blame,
            `reading the export '${key}' through the module's exports object`,
          );
        }
        const dyn = lowerer.coerceToExpected(value, DYN);
        if (dyn.type.kind !== "dyn") {
          lowerer.unsupported(
            "SC1101",
            blame,
            `reading the export '${key}' ('${lowerer.fmt(dyn.type)}') through the module's exports object`,
          );
        }
        read = [{ kind: "return", value: dyn, loc }];
      } catch (err) {
        if (!(err instanceof PoisonError)) throw err;
        const fence = lowerer.deferToRuntimeFence(diagsBefore, blame, { kind: "statement" });
        if (!fence) throw err;
        read = [fence];
      }
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: varRef("key", STRING, loc),
          right: strLit(key, loc),
          type: { kind: "bool" },
          loc,
        },
        then: read,
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: dynUndefinedExpr(locOf(dep)), loc: locOf(dep) });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "key", name: "key", type: STRING }],
      returnType: DYN,
      locals: [{ id: "key", name: "key", type: STRING, mutable: false }, ...context.locals],
      body,
      loc: locOf(dep),
    });
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = previousClass;
  }
  return name;
}

/** The exports object of `dep` as a checked-dynamic value, or null when the
 * module's export names are not statically known (a computed name, a
 * replaced exports object) or the module is not in this program. */
export function lowerCjsExportsValue(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  loc: SrcLoc,
): IrExpr | null {
  if (!lowerer.moduleOrder.includes(dep)) return null;
  const namespace = lowerer.cjsNamespaceOf(dep);
  // A computed export name or a replaced `module.exports` leaves no name
  // set to build the object from.
  if (namespace.assignedLater === "all") return null;
  const keys = [...namespace.names].filter(
    (name) => name !== "default" && name !== "module.exports",
  );
  const moduleId = `cjs:${lowerer.pathOf(dep)}`;
  const getter = cjsExportsGetter(lowerer, dep, moduleId, keys);
  return {
    kind: "libCall",
    fn: "module.cjsExports",
    args: [
      strLit(moduleId, loc),
      {
        kind: "arrayLit",
        elems: keys.map((key) => strLit(key, loc)),
        type: arrayOf(STRING),
        loc,
      },
      {
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: getter,
          captures: [],
          type: funcOf([STRING], DYN),
          loc,
        },
        type: DYN,
        loc,
      },
    ],
    type: DYN,
    loc,
  };
}
