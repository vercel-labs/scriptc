import { lowerWorkerMetadata } from "./builtins/workers.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { boolLit, dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { isJsSourceFile } from "../program.js";
import { funcTypeFromParamShapes, type ParamShape } from "./call-signatures.js";
import { keyedHelperName } from "./stable-names.js";
import type { Lowerer } from "./lowerer.js";
import {
  BUILTIN_MODULE_CONSTS,
  builtinModuleFns,
  OBJECT_CALLABLE_VALUES,
  builtinConstLit,
  builtinModuleConstOf,
  builtinModulesArrayLit,
  stdlibGlobalNameOf,
  type BuiltinModuleFn,
  type BuiltinValueParam,
} from "./surfaces.js";
import { CRYPTO_CONSTANTS } from "./crypto-tables.js";

const PROTOTYPE_METHODS: Record<string, readonly string[]> = {
  Date: ["getTime", "valueOf", "toISOString", "toJSON"],
  Map: ["get", "set", "has", "delete", "clear", "keys", "values", "entries", "forEach"],
  Set: ["add", "has", "delete", "clear", "keys", "values", "entries", "forEach"],
  WeakMap: ["get", "set", "has", "delete"],
  WeakSet: ["add", "has", "delete"],
  String: [
    "split",
    "startsWith",
    "endsWith",
    "substring",
    "slice",
    "toLowerCase",
    "toUpperCase",
    "padStart",
    "charCodeAt",
    "normalize",
    "replace",
    "toString",
    "valueOf",
  ],
  Number: ["toString", "valueOf"],
  Object: ["hasOwnProperty", "propertyIsEnumerable", "toString", "valueOf"],
};

export function builtinPrototypeMethod(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): string | null {
  const prototype = expr.expression;
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return null;
  const owner = stdlibGlobalNameOf(lowerer, prototype.expression);
  return owner && PROTOTYPE_METHODS[owner]?.includes(expr.name.text) ? owner : null;
}

/** These native callables own their argument checks. Unannotated JS aliases
 * keep the checked value instead of narrowing it to the ambient signature.
 * This selects storage only: reassignment still updates a real runtime slot. */
export function isNativeBuiltinValueInitializer(
  lowerer: Lowerer,
  expr: ts.Expression | undefined,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (!expr) return false;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  const builtin = ts.isIdentifier(expr)
    ? lowerer.builtinImportOf(expr)
    : ts.isPropertyAccessExpression(expr)
      ? lowerer.builtinMemberOf(expr)
      : null;
  if (builtin?.module === "util/types") return true;
  if (
    builtin?.module === "util" &&
    ["stripVTControlCharacters", "toUSVString", "isDeepStrictEqual", "styleText"].includes(
      builtin.member,
    )
  )
    return true;
  // JS global snapshots may use an opaque builtin identity rather than
  // the ambient constructor's callable ABI. Store that actual value in
  // the checked representation, including optional capability probes.
  const global = ts.isIdentifier(expr) ? stdlibGlobalNameOf(lowerer, expr) : null;
  if (global && !["undefined", "Infinity", "NaN"].includes(global)) return true;
  if (lowerer.isStdlibGlobal(expr, "console")) return true;
  if (ts.isNewExpression(expr) && lowerer.isStdlibGlobal(expr.expression, "Date")) return true;
  if (ts.isConditionalExpression(expr)) {
    return (
      isNativeBuiltinValueInitializer(lowerer, expr.whenTrue, new Set(seen)) ||
      isNativeBuiltinValueInitializer(lowerer, expr.whenFalse, new Set(seen))
    );
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      builtinPrototypeMethod(lowerer, expr) !== null ||
      lowerer.stdlibGlobalMember(expr, "console") !== null ||
      lowerer.stdlibGlobalMember(expr, "globalThis") === "console" ||
      lowerer.stdlibGlobalMember(expr, "process") === "getBuiltinModule" ||
      lowerer.stdlibGlobalMember(expr, "process") === "hrtime" ||
      ["stdin", "stdout", "stderr"].includes(lowerer.stdlibGlobalMember(expr, "process") ?? "") ||
      (expr.name.text === "bigint" &&
        ts.isPropertyAccessExpression(expr.expression) &&
        lowerer.stdlibGlobalMember(expr.expression, "process") === "hrtime") ||
      lowerer.stdlibGlobalMember(expr, "Array") === "isArray" ||
      lowerer.stdlibGlobalMember(expr, "Array") === "from" ||
      lowerer.stdlibGlobalMember(expr, "Reflect") === "ownKeys" ||
      ["fromCharCode", "fromCodePoint"].includes(
        lowerer.stdlibGlobalMember(expr, "String") ?? "",
      ) ||
      ["parseInt", "parseFloat"].includes(lowerer.stdlibGlobalMember(expr, "Number") ?? "") ||
      lowerer.stdlibGlobalMember(expr, "Buffer") === "isBuffer" ||
      lowerer.stdlibGlobalMember(expr, "Array") === "prototype" ||
      lowerer.stdlibGlobalMember(expr, "Promise") === "prototype" ||
      (ts.isPropertyAccessExpression(expr.expression) &&
        lowerer.stdlibGlobalMember(expr.expression, "Array") === "prototype") ||
      lowerer.stdlibGlobalMember(expr, "Object") === "assign" ||
      lowerer.stdlibGlobalMember(expr, "Object") === "create" ||
      (expr.name.text === "apply" &&
        ts.isPropertyAccessExpression(expr.expression) &&
        lowerer.stdlibGlobalMember(expr.expression, "Function") === "prototype") ||
      lowerer.stdlibGlobalMember(expr, "JSON") === "stringify" ||
      (lowerer.isStdlibGlobal(expr.expression, "Object") &&
        Object.hasOwn(OBJECT_CALLABLE_VALUES, expr.name.text))
    );
  }
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return symbol.declarations.some(
    (decl) =>
      ts.isVariableDeclaration(decl) &&
      isNativeBuiltinValueInitializer(lowerer, decl.initializer, seen),
  );
}

/** The stored Array.isArray function shares the direct call's native test. */
export function lowerArrayIsArrayValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const key = "%builtin.Array.isArray";
  let name = lowerer.builtinCallableValueFns.get(key);
  if (!name) {
    name = key;
    lowerer.builtinCallableValueFns.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      returnType: BOOL,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynTest",
            test: "array",
            value: varRef("value", DYN, loc),
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
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [DYN], ret: BOOL },
    loc,
  };
}

export function lowerStringCodesValue(
  lowerer: Lowerer,
  member: "fromCharCode" | "fromCodePoint",
  loc: SrcLoc,
): IrExpr {
  const name = `%builtin.String.${member}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const values = varRef("values", DYN, loc),
      index = varRef("index", F64, loc),
      codes = varRef("codes", arrayOf(F64), loc),
      code = varRef("code", F64, loc);
    const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "first", name: "first", type: DYN },
        { localId: "values", name: "values", type: DYN },
      ],
      returnType: STRING,
      locals: [
        { id: "first", name: "first", type: DYN, mutable: false },
        { id: "values", name: "values", type: DYN, mutable: false },
        { id: "codes", name: "codes", type: arrayOf(F64), mutable: false },
        { id: "index", name: "index", type: F64, mutable: true },
        { id: "code", name: "code", type: F64, mutable: false },
      ],
      loc,
      body: [
        {
          kind: "varDecl",
          localId: "codes",
          init: { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
          loc,
        },
        { kind: "varDecl", localId: "index", init: number(0), loc },
        {
          kind: "while",
          cond: {
            kind: "bin",
            op: "<",
            left: index,
            right: {
              kind: "dynCheck",
              value: {
                kind: "dynKeyGet",
                value: values,
                key: strLit("length", loc),
                type: DYN,
                loc,
              },
              type: F64,
              loc,
            },
            type: BOOL,
            loc,
          },
          loc,
          body: [
            {
              kind: "varDecl",
              localId: "code",
              init: {
                kind: "libCall",
                fn: "dyn.toNumberCoerce",
                args: [
                  {
                    kind: "dynKeyGet",
                    value: values,
                    key: lowerer.coerceToExpected(index, DYN),
                    type: DYN,
                    loc,
                  },
                ],
                type: F64,
                loc,
              },
              loc,
            },
            ...(member === "fromCodePoint"
              ? [
                  {
                    kind: "exprStmt" as const,
                    expr: {
                      kind: "libCall" as const,
                      fn: "string.fromCodePoint" as const,
                      args: [{ kind: "arrayLit" as const, elems: [code], type: arrayOf(F64), loc }],
                      type: STRING,
                      loc,
                    },
                    loc,
                  },
                ]
              : []),
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: codes,
                args: [code],
                type: F64,
                loc,
              },
              loc,
            },
            {
              kind: "assign",
              localId: "index",
              value: { kind: "bin", op: "+", left: index, right: number(1), type: F64, loc },
              loc,
            },
          ],
        },
        {
          kind: "return",
          value: { kind: "libCall", fn: `string.${member}`, args: [codes], type: STRING, loc },
          loc,
        },
      ],
    });
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: [DYN], ret: STRING, rest: true, argumentsAll: true },
      loc,
    },
    fnName: member,
    type: DYN,
    loc,
  };
}

export function lowerCheckedPredicateValue(
  lowerer: Lowerer,
  display: string,
  test: "number" | "buffer",
  loc: SrcLoc,
  predicate?: IrLibFn,
): IrExpr {
  const name = `%builtin.${display}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const value = varRef("value", DYN, loc);
    const matches: IrExpr = { kind: "dynTest", test, value, type: BOOL, loc };
    const result: IrExpr = predicate
      ? {
          kind: "ternary",
          cond: matches,
          then: {
            kind: "libCall",
            fn: predicate,
            args: [{ kind: "dynCheck", value, type: F64, loc }],
            type: BOOL,
            loc,
          },
          else_: { kind: "boolLit", value: false, type: BOOL, loc },
          type: BOOL,
          loc,
        }
      : matches;
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      returnType: BOOL,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      body: [{ kind: "return", value: result, loc }],
      loc,
    });
  }
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [DYN], ret: BOOL },
    loc,
  };
}

export function lowerNumberParserValue(
  lowerer: Lowerer,
  member: "parseInt" | "parseFloat",
  loc: SrcLoc,
): IrExpr {
  const name = `%builtin.Number.${member}`;
  const types = member === "parseInt" ? [DYN, DYN] : [DYN];
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const params = types.map((type, index) => ({ localId: `p.${index}`, name: `p${index}`, type }));
    const text: IrExpr = {
      kind: "libCall",
      fn: "dyn.toStringCoerce",
      args: [varRef("p.0", DYN, loc)],
      type: STRING,
      loc,
    };
    const radix: IrExpr = {
      kind: "libCall",
      fn: "dyn.toNumberCoerce",
      args: [varRef("p.1", DYN, loc)],
      type: F64,
      loc,
    };
    lowerer.liftedFns.push({
      name,
      params,
      returnType: F64,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: `num.${member}`,
            args: member === "parseInt" ? [text, radix] : [text],
            type: F64,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: types, ret: F64 },
      loc,
    },
    fnName: member,
    type: DYN,
    loc,
  };
}

// These module values expose native callable lowerings and current-thread
// metadata. Stored Worker constructors remain refused: native worker roots
// must be resolved from the source at compilation time.
const MODULES = ["path/posix", "path/win32", "os", "worker_threads", "util/types"] as const;

const box = (value: IrExpr): IrExpr =>
  value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc: value.loc };

/** `path.posix`, `path.win32` and the bare module as untyped values: the
 * same module handle process.getBuiltinModule answers, so each family is
 * one object (`require("path/posix") === require("path").posix`) whose
 * members are the interned function values. */
export function pathModuleValue(lowerer: Lowerer, module: string, loc: SrcLoc): IrExpr {
  return moduleValue(lowerer, module, loc);
}

/** What a spread of a node:path namespace copies. A module object
 * (`require("path")`, a default import, `posix`, `win32`) is spread as
 * itself, so the copy holds its members in Node's order. An ES module
 * namespace (`import * as path`) has its keys sorted and also `default`,
 * the module object; each member is read through the module value, so the
 * copy holds the same functions (`{ ...path }.join === path.join`). */
export function pathModuleSpreadSource(
  lowerer: Lowerer,
  module: string,
  namespace: boolean,
  loc: SrcLoc,
): IrExpr {
  if (!namespace) return pathModuleValue(lowerer, module, loc);
  const local = lowerer.declareHiddenLocal("%pathModule", DYN);
  const value = varRef(local.id, DYN, loc);
  const fields = [...PATH_MODULE_KEYS, "default"].sort().map((key) => ({
    key: strLit(key, loc),
    value:
      key === "default"
        ? value
        : ({ kind: "dynKeyGet", value, key: strLit(key, loc), type: DYN, loc } as IrExpr),
  }));
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: local.id, init: pathModuleValue(lowerer, module, loc), loc },
    ],
    result: { kind: "dynObjLit", fields, type: DYN, loc },
    type: DYN,
    loc,
  };
}

export function utilTypesModuleValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  return moduleValue(lowerer, "util/types", loc);
}

export function lowerUtilTypeValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr {
  const name = `%builtin.util/types.${member}`;
  if (!lowerer.builtinCallableValueFns.has(name)) {
    lowerer.builtinCallableValueFns.set(name, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      returnType: BOOL,
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      loc,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "util.typeIs",
            args: [varRef("value", DYN, loc), strLit(member, loc)],
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
    });
  }
  const value: IrExpr = {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [DYN], ret: BOOL },
    loc,
  };
  return {
    kind: "libCall",
    fn: "util.typeValue",
    args: [box(value), strLit(member, loc)],
    type: DYN,
    loc,
  };
}

function moduleValue(lowerer: Lowerer, module: string, loc: SrcLoc): IrExpr {
  const cacheKey = `%builtin.module.get.${module}`;
  let name = lowerer.builtinCallableValueFns.get(cacheKey);
  if (!name) {
    name = cacheKey;
    lowerer.builtinCallableValueFns.set(cacheKey, name);
    const key = varRef("key", STRING, loc);
    const body: IrStmt[] = [];
    const add = (member: string, value: IrExpr): void => {
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: key,
          right: strLit(member, loc),
          type: BOOL,
          loc,
        },
        then: [{ kind: "return", value: box(value), loc }],
        else_: null,
        loc,
      });
    };
    for (const member of Object.keys(builtinModuleFns()[module] ?? {})) {
      const callable = lowerer.lowerBuiltinCallableValue({ module, member }, loc);
      if (callable) add(member, lowerer.checkedBuiltinValue(callable));
    }
    for (const member of Object.keys(BUILTIN_MODULE_CONSTS[module] ?? {})) {
      const worker = module === "worker_threads" ? lowerWorkerMetadata(member, loc) : null;
      const value = builtinModuleConstOf(lowerer, module, member);
      if (worker) add(member, worker);
      else if (value !== undefined) add(member, builtinConstLit(value, loc));
    }
    if (module.startsWith("path/")) {
      add("posix", moduleValue(lowerer, "path/posix", loc));
      add("win32", moduleValue(lowerer, "path/win32", loc));
      // Node's deprecated alias of toNamespacedPath.
      const alias = lowerer.lowerBuiltinCallableValue({ module, member: "toNamespacedPath" }, loc);
      if (alias) add("_makeLong", lowerer.checkedBuiltinValue(alias));
    }
    if (module === "worker_threads") {
      for (const member of ["isInternalThread", "parentPort", "workerData"])
        add(member, lowerWorkerMetadata(member, loc)!);
    }
    // A path family is the whole of Node's object, so another key is
    // absent there too.
    body.push({
      kind: "return",
      value: module.startsWith("path/")
        ? dynUndefinedExpr(loc)
        : {
            kind: "libCall",
            fn: "process.builtinUnsupported",
            args: [strLit(module, loc), key],
            type: DYN,
            loc,
          },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "key", name: "key", type: STRING }],
      returnType: DYN,
      locals: [{ id: "key", name: "key", type: STRING, mutable: false }],
      body,
      loc,
    });
  }
  const getter: IrExpr = {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [STRING], ret: DYN },
    loc,
  };
  // A path family is a plain object holding Node's members in Node's
  // order, so reflection over it (Object.keys, Object.assign, spreads,
  // own-property checks) sees them.
  if (module.startsWith("path/")) {
    return {
      kind: "libCall",
      fn: "process.builtinObject",
      args: [
        strLit(module, loc),
        box(getter),
        {
          kind: "arrayLit",
          elems: PATH_MODULE_KEYS.map((key) => strLit(key, loc)),
          type: arrayOf(STRING),
          loc,
        },
      ],
      type: DYN,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: "process.builtinModule",
    args: [strLit(module, loc), box(getter)],
    type: DYN,
    loc,
  };
}

/** Object.keys of Node's path.posix and path.win32. */
const PATH_MODULE_KEYS = [
  "resolve",
  "normalize",
  "isAbsolute",
  "join",
  "relative",
  "toNamespacedPath",
  "dirname",
  "basename",
  "extname",
  "format",
  "parse",
  "matchesGlob",
  "sep",
  "delimiter",
  "win32",
  "posix",
  "_makeLong",
];

/** A first-class loader uses the same native functions as direct imports.
 * Module handles cache values and preserve aliases without a JS engine. */
export function lowerObjectAssignValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const name = "%builtin.Object.assign";
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "target", name: "target", type: DYN },
        { localId: "sources", name: "sources", type: DYN },
      ],
      returnType: DYN,
      locals: [
        { id: "target", name: "target", type: DYN, mutable: false },
        { id: "sources", name: "sources", type: DYN, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.assignAll",
            args: [varRef("target", DYN, loc), varRef("sources", DYN, loc)],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [DYN], ret: DYN, rest: true },
    loc,
  };
}

export function lowerBuiltinLoaderValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const cacheKey = "%builtin.process.getBuiltinModule";
  let name = lowerer.builtinCallableValueFns.get(cacheKey);
  if (!name) {
    name = cacheKey;
    lowerer.builtinCallableValueFns.set(cacheKey, name);
    const id = varRef("id", STRING, loc);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "id",
        init: {
          kind: "libCall",
          fn: "process.builtinId",
          args: [varRef("input", DYN, loc), builtinModulesArrayLit(loc)],
          type: STRING,
          loc,
        },
        loc,
      },
    ];
    const add = (specifier: string, value: IrExpr): void => {
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: id,
          right: strLit(specifier, loc),
          type: BOOL,
          loc,
        },
        then: [{ kind: "return", value, loc }],
        else_: null,
        loc,
      });
    };
    add("", box({ kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }));
    // path's default is the target platform's implementation, including identity.
    const pathModule =
      builtinModuleConstOf(lowerer, "path", "sep") === "\\" ? "path/win32" : "path/posix";
    add("path", moduleValue(lowerer, pathModule, loc));
    for (const module of MODULES) add(module, moduleValue(lowerer, module, loc));
    body.push({
      kind: "return",
      value: {
        kind: "libCall",
        fn: "process.builtinUnsupported",
        args: [id, strLit("", loc)],
        type: DYN,
        loc,
      },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "input", name: "id", type: DYN }],
      returnType: DYN,
      locals: [
        { id: "input", name: "id", type: DYN, mutable: false },
        { id: "id", name: "module", type: STRING, mutable: false },
      ],
      body,
      loc,
    });
  }
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [DYN], ret: DYN },
    loc,
  };
}

/** The deprecated node:constants module object: the runtime merges
 * os.constants' groups and fs.constants with crypto.constants, which a
 * lifted function answers from the baked table the first time the object
 * is built. */
export function builtinConstantsObject(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const name = "%builtin.constants.crypto";
  if (!lowerer.builtinCallableValueFns.has(name)) {
    lowerer.builtinCallableValueFns.set(name, name);
    const fields = Object.entries(CRYPTO_CONSTANTS).map(([key, value]) => ({
      key: strLit(key, loc),
      value: box(builtinConstLit(value, loc)),
    }));
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: DYN,
      locals: [],
      body: [{ kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc }],
      loc,
    });
  }
  const table: IrExpr = {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [], ret: DYN },
    loc,
  };
  return { kind: "libCall", fn: "constants.object", args: [box(table)], type: DYN, loc };
}

/** The untyped-caller twin of a builtin function value whose parameters
 * carry Node's validator names (BuiltinValueParam.name): every argument
 * arrives as a checked-dynamic value. With a `checked` entry point the
 * arguments reach it as given, followed by its constants; otherwise string
 * parameters pass through validateString in Node's order (`valueOrder`)
 * before the direct call's entry point. One interned adapter per entry,
 * so each read of the value is the same closure. */
export function checkedNativeCallableValue(
  lowerer: Lowerer,
  fn: BuiltinModuleFn,
  display: string,
  loc: SrcLoc,
): IrExpr {
  const valueParams = fn.valueParams ?? [];
  const callee = fn.checked?.fn ?? fn.valueFn ?? fn.fn;
  const result = fn.checked ? (fn.checked.result ?? fn.result) : fn.result;
  const raw = fn.checked !== undefined;
  const shapes: ParamShape[] = valueParams.map((param): ParamShape => ({
    mode: param.mode === "rest" ? "dynRest" : param.mode === "optional" ? "omittable" : "required",
    type: DYN,
  }));
  const funcType = funcTypeFromParamShapes(shapes, result);
  const key = `checked:${callee}:${JSON.stringify(fn.checked?.args ?? [])}:${typeKey(funcType)}`;
  let fnName = lowerer.builtinCallableValueFns.get(key);
  if (!fnName) {
    fnName = keyedHelperName(lowerer, `%builtin.value.${callee}`, key);
    lowerer.builtinCallableValueFns.set(key, fnName);
    lowerer.builtinCallableValueNames.set(fnName, display.slice(display.lastIndexOf(".") + 1));
    const params = valueParams.map((_, index) => ({
      localId: `arg.${index}`,
      name: `arg${index}`,
      type: DYN,
    }));
    const locals = params.map((param) => ({
      id: param.localId,
      name: param.name,
      type: param.type as IrType,
      mutable: false,
    }));
    // validateString under Node's name; an omitted optional argument (or
    // undefined) takes its default without a check, as Node's
    // `if (suffix !== undefined)` does.
    const checked = (param: BuiltinValueParam, index: number): IrExpr => {
      const ref = varRef(`arg.${index}`, DYN, loc);
      const name = strLit(param.name ?? `arg${index}`, loc);
      if (param.mode === "rest") {
        return {
          kind: "libCall",
          fn: "dyn.validateStrings",
          args: [ref, name],
          type: arrayOf(STRING),
          loc,
        };
      }
      const value: IrExpr = {
        kind: "libCall",
        fn: "dyn.validateString",
        args: [ref, name],
        type: STRING,
        loc,
      };
      if (param.mode !== "optional" || typeof param.defaultValue !== "string") return value;
      return {
        kind: "ternary",
        cond: { kind: "dynTest", test: "undefined", value: ref, type: BOOL, loc },
        then: strLit(param.defaultValue, loc),
        else_: value,
        type: STRING,
        loc,
      };
    };
    const body: IrStmt[] = [];
    const args: IrExpr[] = valueParams.map((param, index) =>
      raw || param.type.kind === "dyn"
        ? varRef(`arg.${index}`, DYN, loc)
        : varRef(`checked.${index}`, param.mode === "rest" ? arrayOf(STRING) : STRING, loc),
    );
    // Validate in Node's order, then call with the arguments in place.
    for (const index of fn.valueOrder ?? valueParams.map((_, i) => i)) {
      const param = valueParams[index]!;
      if (raw || param.type.kind === "dyn") continue;
      const init = checked(param, index);
      locals.push({
        id: `checked.${index}`,
        name: `checked${index}`,
        type: init.type,
        mutable: false,
      });
      body.push({ kind: "varDecl", localId: `checked.${index}`, init, loc });
    }
    const call: IrExpr = {
      kind: "libCall",
      fn: callee,
      args: [...args, ...(fn.checked?.args ?? []).map((value) => boolLit(value, loc))],
      type: result,
      loc,
    };
    body.push(
      result.kind === "void"
        ? { kind: "exprStmt", expr: call, loc }
        : { kind: "return", value: call, loc },
    );
    if (result.kind === "void") body.push({ kind: "return", value: null, loc });
    lowerer.liftedFns.push({ name: fnName, params, returnType: result, locals, body, loc });
  }
  return { kind: "closure", fnName, captures: [], type: funcType, loc };
}

/** Every builtin function value that becomes untyped boxes as its checked
 * twin, under the builtin's name and length, wherever the boxing happens: a
 * module handle's member, an assertion's argument, or a read of a binding
 * whose only stores are that builtin (`const join = path.join`): a const
 * local, or a module-level binding, whose stores are all visible here.
 * An untyped caller then holds the value that validates its arguments as
 * Node does, and it compares equal to the same builtin read anywhere else.
 * A binding read keeps its own evaluation, so its TDZ check still runs. */
export function boxBuiltinValuesChecked(lowerer: Lowerer, functions: IrFunction[]): void {
  const names = lowerer.builtinCallableValueNames;
  if (names.size === 0) return;
  const lengths = lowerer.builtinCallableValueLengths;
  const builtin = (expr: IrExpr | null): expr is Extract<IrExpr, { kind: "closure" }> =>
    expr !== null &&
    expr.kind === "closure" &&
    expr.captures.length === 0 &&
    (names.has(expr.fnName) || lowerer.builtinCheckedValues.has(expr.fnName));
  // Bindings and the one builtin closure they hold, or null when a binding
  // stores anything else. Locals are keyed by their function.
  const globals = new Set(lowerer.globalsList.map((g) => g.id));
  const bound = new Map<string, Extract<IrExpr, { kind: "closure" }> | null>();
  const note = (key: string, value: IrExpr | null): void => {
    const previous = bound.get(key);
    const next = builtin(value) ? value : null;
    bound.set(
      key,
      previous === undefined || (previous !== null && next?.fnName === previous.fnName)
        ? next
        : null,
    );
  };
  const localKey = (fn: IrFunction, id: string): string => `${fn.name}\u0000${id}`;
  for (const fn of functions) {
    const constLocals = new Set(fn.locals.filter((l) => !l.mutable).map((l) => l.id));
    const keyOf = (id: string): string | null =>
      constLocals.has(id) ? localKey(fn, id) : globals.has(id) ? id : null;
    // Any other node naming a binding (a for-of target, a catch binding, an
    // expression-level write) may store something else in it.
    const other = (node: object): void => {
      for (const field of ["localId", "catchLocalId"]) {
        const id = (node as Record<string, unknown>)[field];
        const key = typeof id === "string" ? keyOf(id) : null;
        if (key) note(key, null);
      }
    };
    everyStmtList(fn.body, {
      expr: (expr) => {
        if (expr.kind !== "varRef") other(expr);
        return true;
      },
      stmt: (stmt) => {
        const key = stmt.kind === "varDecl" || stmt.kind === "assign" ? keyOf(stmt.localId) : null;
        if (stmt.kind === "varDecl" && key) {
          if (stmt.init) note(key, stmt.init);
        } else if (stmt.kind === "assign" && key) note(key, stmt.value);
        else other(stmt);
        return true;
      },
    });
  }
  const lifted = lowerer.liftedFns.length;
  for (const fn of functions) {
    fn.body = transformStmtList(fn.body, {
      stmt: (stmt) => stmt,
      expr: (expr) => {
        if (expr.kind !== "dynFrom") return expr;
        const read = expr.value.kind === "varRef" ? expr.value : null;
        const source = read
          ? (bound.get(localKey(fn, read.localId)) ?? bound.get(read.localId) ?? null)
          : builtin(expr.value)
            ? expr.value
            : null;
        if (!source) return expr;
        const value = lowerer.checkedBuiltinValue(source);
        const fnName =
          expr.fnName ??
          names.get(source.fnName) ??
          (value.kind === "closure" ? names.get(value.fnName) : undefined);
        const fnLength =
          expr.fnLength ??
          lengths.get(source.fnName) ??
          (value.kind === "closure" ? lengths.get(value.fnName) : undefined);
        const boxed: IrExpr = {
          ...expr,
          value,
          ...(fnName !== undefined ? { fnName } : {}),
          ...(fnLength !== undefined ? { fnLength } : {}),
        };
        if (!read) return boxed;
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: read, loc: read.loc }],
          result: boxed,
          type: DYN,
          loc: expr.loc,
        };
      },
    });
  }
  functions.push(...lowerer.liftedFns.slice(lifted));
}

/** A JavaScript call of a builtin with named value parameters whose
 * arguments are not the native parameters' types or omit one
 * (`path.matchesGlob(123, glob)`, `path.toNamespacedPath()`): the call goes
 * through the checked
 * adapter (checkedNativeCallableValue), which applies Node's validation and
 * answers the value Node answers. Null for every other call, which keeps
 * the direct lowering. */
export function jsCheckedBuiltinCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  fn: BuiltinModuleFn,
  display: string,
  loc: SrcLoc,
): IrExpr | null {
  const params = fn.valueParams;
  if (!params?.some((param) => param.name !== undefined)) return null;
  if (params.some((param) => param.mode === "rest")) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  const args = call.arguments.nodes;
  if (args.length > params.length || args.some((arg) => ts.isSpreadElement(arg))) return null;
  // An omitted required argument is undefined to Node's validation too.
  const required = params.filter((param) => param.mode === "required").length;
  const mismatch =
    args.length < required ||
    args.some((arg, index) => {
      const want = params[index]!.type;
      if (want.kind === "dyn") return false;
      const type = lowerer.mapTypeOf(lowerer.typeOf(arg));
      return type === null || !typeEquals(type, want);
    });
  if (!mismatch) return null;
  const adapter = checkedNativeCallableValue(lowerer, fn, display, loc);
  if (adapter.kind !== "closure") return null;
  return {
    kind: "call",
    callee: adapter.fnName,
    args: params.map((_, index) =>
      index < args.length ? lowerer.lowerExprExpecting(args[index]!, DYN) : dynUndefinedExpr(loc),
    ),
    type: fn.checked?.result ?? fn.result,
    loc,
  };
}
