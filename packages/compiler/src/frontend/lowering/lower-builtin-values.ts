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
  type IrLibFn,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { strLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import {
  BUILTIN_MODULE_CONSTS,
  BUILTIN_MODULE_FNS,
  OBJECT_CALLABLE_VALUES,
  builtinConstLit,
  builtinModuleConstOf,
  builtinModulesArrayLit,
  stdlibGlobalNameOf,
} from "./surfaces.js";

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
  return lowerer.checker
    .declarationsOf(symbol)
    .some(
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

export function pathModuleValue(lowerer: Lowerer, module: string, loc: SrcLoc): IrExpr {
  const fields: { key: IrExpr; value: IrExpr }[] = [];
  const add = (member: string, value: IrExpr): void => {
    fields.push({ key: strLit(member, loc), value: box(value) });
  };
  for (const member of Object.keys(BUILTIN_MODULE_FNS[module] ?? {})) {
    const value = lowerer.lowerBuiltinCallableValue({ module, member }, loc);
    if (value) add(member, value);
  }
  for (const member of Object.keys(BUILTIN_MODULE_CONSTS[module] ?? {})) {
    const value = builtinModuleConstOf(lowerer, module, member);
    if (value !== undefined) add(member, builtinConstLit(value, loc));
  }
  add("posix", moduleValue(lowerer, "path/posix", loc));
  add("win32", moduleValue(lowerer, "path/win32", loc));
  return { kind: "dynObjLit", fields, type: DYN, loc };
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
    for (const member of Object.keys(BUILTIN_MODULE_FNS[module] ?? {})) {
      const callable = lowerer.lowerBuiltinCallableValue({ module, member }, loc);
      if (callable) add(member, callable);
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
    }
    if (module === "worker_threads") {
      for (const member of ["isInternalThread", "parentPort", "workerData"])
        add(member, lowerWorkerMetadata(member, loc)!);
    }
    body.push({
      kind: "return",
      value: {
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
  return {
    kind: "libCall",
    fn: "process.builtinModule",
    args: [strLit(module, loc), box(getter)],
    type: DYN,
    loc,
  };
}

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
