import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import { arrayOf, funcOf } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import {
  DYN,
  STRING,
  SYMBOL_T,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import { newFnCtx, PoisonError, type Lowerer } from "./lowerer.js";

/** Computed namespace reads select live exports instead of copying a
 * namespace into a registry snapshot. Constructor registries may contain
 * unrelated classes with different native signatures. */
export function lowerModuleNamespaceElement(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  const type = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (type?.kind !== "moduleNs") return null;
  // A builtin namespace with a module object (`path[platform]`): the keyed
  // read of that object.
  if (type.moduleId.startsWith("builtin:")) {
    const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN);
    if (receiver.type.kind !== "dyn") return null;
    const key = lowerer.lowerExpr(expr.argumentExpression);
    return {
      kind: "dynKeyGet",
      key: key.type.kind === "string" ? key : lowerer.coerceInto(expr.argumentExpression, key, DYN),
      value: receiver,
      type: DYN,
      loc: locOf(expr),
    };
  }
  const source = lowerer.sourceFileOfModuleNamespace(type);
  if (!source) return null;
  const loc = locOf(expr);
  const name = `%module.element:${type.moduleId}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(context);
    try {
      const body: IrStmt[] = [];
      const symbol = lowerer.checker.getSymbolAtLocation(source);
      for (const exported of symbol ? lowerer.checker.getExportsOfModule(symbol) : []) {
        const key = ts.symbolName(exported);
        const target =
          exported.flags & ts.SymbolFlags.Alias
            ? lowerer.checker.getAliasedSymbol(exported)
            : exported;
        if (!(target.flags & ts.SymbolFlags.Value)) continue;
        const declaration = target.valueDeclaration;
        const identifier = declaration?.name as ts.Node | undefined;
        if (!identifier || !ts.isIdentifier(identifier)) {
          lowerer.unsupported("SC1090", expr, "computed namespace reads of unnamed exports");
        }
        const value = lowerer.lowerExprExpecting(identifier, DYN);
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
          then: [{ kind: "return", value, loc }],
          else_: null,
          loc,
        });
      }
      body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
      const fn: IrFunction = {
        name,
        params: [
          { localId: "namespace", name: "namespace", type },
          { localId: "key", name: "key", type: STRING },
        ],
        returnType: DYN,
        locals: [
          { id: "namespace", name: "namespace", type, mutable: false },
          { id: "key", name: "key", type: STRING, mutable: false },
          ...context.locals,
        ],
        body,
        loc,
      };
      lowerer.liftedFns.push(fn);
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }
  }
  const receiver = lowerer.lowerExpr(expr.expression);
  const key = lowerer.lowerExpr(expr.argumentExpression);
  const text: IrExpr =
    key.type.kind === "string"
      ? key
      : {
          kind: "libCall",
          fn: "dyn.toStringCoerce",
          args: [lowerer.coerceInto(expr.argumentExpression, key, DYN)],
          type: STRING,
          loc,
        };
  return { kind: "call", callee: name, args: [receiver, text], type: DYN, loc };
}

/** A module namespace taken as an untyped value (`{ ...ns }`, `{ iso: ns }`
 * in JavaScript): an object holding each value export, keyed in the
 * namespace's sorted key order. The copy is exact while every export is a
 * binding that never changes after initialization (const, function or
 * class); null for other namespaces, which keep their fence. */
export function moduleNamespaceObject(
  lowerer: Lowerer,
  ns: IrExpr & { type: IrType & { kind: "moduleNs" } },
): IrExpr | null {
  const source = lowerer.sourceFileOfModuleNamespace(ns.type);
  if (!source) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(source);
  if (!symbol) return null;
  const exports: { key: string; identifier: ts.Identifier }[] = [];
  let exact = true;
  // The module's resolved exports, which include `export *` members.
  for (const exported of lowerer.checker.getExportsOfModule(symbol)) {
    const key = ts.symbolName(exported);
    const target =
      exported.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(exported) : exported;
    if (!(target.flags & ts.SymbolFlags.Value)) continue;
    const declaration = target.valueDeclaration;
    const identifier = declaration?.name as ts.Node | undefined;
    const immutable =
      declaration !== undefined &&
      (ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0));
    if (!identifier || !ts.isIdentifier(identifier) || !immutable) {
      exact = false;
      break;
    }
    exports.push({ key, identifier });
  }
  if (!exact) return null;
  exports.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const name = `%module.object:${ns.type.moduleId}`;
  const loc = ns.loc;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(context);
    try {
      const fields = exports.map(({ key, identifier }) => ({
        key: strLit(key, loc),
        value: lowerer.lowerExprExpecting(identifier, DYN),
      }));
      if (fields.some((field) => field.value.type.kind !== "dyn")) return null;
      const fn: IrFunction = {
        name,
        params: [],
        returnType: DYN,
        locals: [...context.locals],
        body: [{ kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc }],
        loc,
      };
      lowerer.liftedFns.push(fn);
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }
  }
  const call: IrExpr = { kind: "call", callee: name, args: [], type: DYN, loc };
  if (ns.kind === "moduleNsRef") return call;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: ns, loc }],
    result: call,
    type: DYN,
    loc,
  };
}

/** The compiled getter behind a namespace object: one lifted function per
 * module that answers an export's current value by name, plus the module's
 * sorted export names. An export whose value has no checked-dynamic form
 * throws its fence when it is read. */
function moduleNamespaceGetter(
  lowerer: Lowerer,
  ns: IrExpr & { type: IrType & { kind: "moduleNs" } },
): { name: string; keys: string[] } | null {
  const source = lowerer.sourceFileOfModuleNamespace(ns.type);
  if (!source) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(source);
  if (!symbol) return null;
  const exports: { key: string; declaration: ts.Node | undefined; symbol: ts.Symbol }[] = [];
  for (const exported of lowerer.checker.getExportsOfModule(symbol)) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(exported) : exported;
    if (!(target.flags & ts.SymbolFlags.Value)) continue;
    exports.push({
      key: ts.symbolName(exported),
      declaration: target.valueDeclaration,
      symbol: target,
    });
  }
  exports.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const name = `%module.namespace:${ns.type.moduleId}`;
  const loc = ns.loc;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(context);
    try {
      const body: IrStmt[] = [];
      for (const { key, declaration, symbol: exportSymbol } of exports) {
        const node = declaration ?? source;
        const diagsBefore = lowerer.diags.length;
        let read: IrStmt[];
        try {
          const identifier = declaration?.name as ts.Node | undefined;
          let value: IrExpr;
          if (identifier && ts.isIdentifier(identifier)) {
            value = lowerer.lowerExprExpecting(identifier, DYN);
          } else {
            // `export default <expression>` and the anonymous default
            // class/function have no named binding to read. The module's
            // pre-registered default global holds the value the export
            // statement snapshotted — the same storage a default import
            // reads — so the namespace property answers it instead of
            // fencing. A default whose type has no checked-dynamic form
            // still fails the coercion below and keeps its fence.
            const storage = lowerer.globalsBySymbol.get(exportSymbol);
            if (!storage) {
              lowerer.unsupported(
                "SC1090",
                node,
                `reading the unnamed export '${key}' through a module namespace object`,
              );
            }
            value = lowerer.coerceToExpected(varRef(storage.id, storage.type, loc), DYN);
          }
          if (value.type.kind !== "dyn") {
            lowerer.unsupported(
              "SC1101",
              identifier ?? node,
              `reading the export '${key}' ('${lowerer.fmt(value.type)}') through a module namespace object`,
            );
          }
          read = [{ kind: "return", value, loc }];
        } catch (err) {
          if (!(err instanceof PoisonError)) throw err;
          const fence = lowerer.deferToRuntimeFence(diagsBefore, node, { kind: "statement" });
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
      body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "key", name: "key", type: STRING }],
        returnType: DYN,
        locals: [{ id: "key", name: "key", type: STRING, mutable: false }, ...context.locals],
        body,
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }
  }
  return { name, keys: exports.map(({ key }) => key) };
}

/** A module namespace taken as an untyped value whose exports a copy
 * cannot represent: a binding that can change after initialization (`let`,
 * `var`), or an export the copy cannot name. The value is the runtime's
 * namespace object (scr_module_namespace_value): one per module, whose
 * property reads call a compiled getter for the export's current value and
 * whose writes throw Node's TypeError. An export whose value has no
 * checked-dynamic form throws its fence when it is read, and listing the
 * object's keys or inspecting it throws the "not supported yet" error. */
export function moduleNamespaceValue(
  lowerer: Lowerer,
  ns: IrExpr & { type: IrType & { kind: "moduleNs" } },
): IrExpr | null {
  const getter = moduleNamespaceGetter(lowerer, ns);
  if (!getter) return null;
  const loc = ns.loc;
  const value: IrExpr = {
    kind: "libCall",
    fn: "module.namespaceValue",
    args: [
      strLit(ns.type.moduleId, loc),
      {
        kind: "arrayLit",
        elems: getter.keys.map((key) => strLit(key, loc)),
        type: arrayOf(STRING),
        loc,
      },
      {
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: getter.name,
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
  if (ns.kind === "moduleNsRef") return value;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: ns, loc }],
    result: value,
    type: DYN,
    loc,
  };
}

/** A module namespace boxed for typed code through a dynamic slot
 * (`const u: unknown = ns`, `take(ns)`): Node's namespace object as
 * scr_module_namespace_dyn.c builds it — one non-extensible null-prototype
 * object per module whose own sorted export names are enumerable read-only
 * accessors, whose `Symbol.toStringTag` is "Module", whose reads call the same
 * compiled getter, and whose writes and coerces throw Node's TypeErrors. A
 * `node:` builtin has no compiled export table, so it keeps its fence. */
export function moduleNamespaceDynValue(
  lowerer: Lowerer,
  ns: IrExpr & { type: IrType & { kind: "moduleNs" } },
): IrExpr | null {
  const getter = moduleNamespaceGetter(lowerer, ns);
  if (!getter) return null;
  const loc = ns.loc;
  const value: IrExpr = {
    kind: "libCall",
    fn: "module.namespaceDyn",
    args: [
      strLit(ns.type.moduleId, loc),
      {
        kind: "arrayLit",
        elems: getter.keys.map((key) => strLit(key, loc)),
        type: arrayOf(STRING),
        loc,
      },
      {
        kind: "dynFrom",
        value: {
          kind: "closure",
          fnName: getter.name,
          captures: [],
          type: funcOf([STRING], DYN),
          loc,
        },
        type: DYN,
        loc,
      },
      {
        kind: "dynFrom",
        value: {
          kind: "libCall",
          fn: "sym.wellKnown",
          args: [strLit("toStringTag", loc)],
          type: SYMBOL_T,
          loc,
        },
        type: DYN,
        loc,
      },
    ],
    type: DYN,
    loc,
  };
  if (ns.kind === "moduleNsRef") return value;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: ns, loc }],
    result: value,
    type: DYN,
    loc,
  };
}
