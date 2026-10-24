/** The standard namespace objects (`Math`, `JSON`, `Reflect`) read as
 * JavaScript values. Each is one object per program, built on first use,
 * with Node's own properties in Node's order: the functions are writable,
 * configurable and non-enumerable, the Math constants are read-only and
 * non-configurable, and `Symbol.toStringTag` names the namespace. Function
 * members hold the same function values the spelled `Math.abs` read gives;
 * members without one hold a function that throws the named fence when
 * called. Direct member calls (`Math.abs(x)`) keep their static lowerings. */
import {
  BOOL,
  DYN,
  F64,
  STRING,
  SYMBOL_T,
  VOID,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
  funcOf,
} from "../../ir/ir.js";
import { helperLoc, varRef } from "../../ir/build.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";
import { InternalCompilerError } from "../../errors.js";
import { mathMemberValue } from "./lower-stdlib.js";
import { jsonMemberValue } from "./builtins/json.js";

/** A function member with its `length`, or a constant (`length` -1). */
interface NamespaceMember {
  readonly key: string;
  readonly length: number;
}

/** Node 24's own string-keyed properties of the namespace `name`, in
 * order, or null when `name` is not a namespace. */
function namespaceMembers(name: string): readonly NamespaceMember[] | null {
  switch (name) {
    case "Math":
      return [
        { key: "abs", length: 1 },
        { key: "acos", length: 1 },
        { key: "acosh", length: 1 },
        { key: "asin", length: 1 },
        { key: "asinh", length: 1 },
        { key: "atan", length: 1 },
        { key: "atanh", length: 1 },
        { key: "atan2", length: 2 },
        { key: "ceil", length: 1 },
        { key: "cbrt", length: 1 },
        { key: "expm1", length: 1 },
        { key: "clz32", length: 1 },
        { key: "cos", length: 1 },
        { key: "cosh", length: 1 },
        { key: "exp", length: 1 },
        { key: "floor", length: 1 },
        { key: "fround", length: 1 },
        { key: "hypot", length: 2 },
        { key: "imul", length: 2 },
        { key: "log", length: 1 },
        { key: "log1p", length: 1 },
        { key: "log2", length: 1 },
        { key: "log10", length: 1 },
        { key: "max", length: 2 },
        { key: "min", length: 2 },
        { key: "pow", length: 2 },
        { key: "random", length: 0 },
        { key: "round", length: 1 },
        { key: "sign", length: 1 },
        { key: "sin", length: 1 },
        { key: "sinh", length: 1 },
        { key: "sqrt", length: 1 },
        { key: "tan", length: 1 },
        { key: "tanh", length: 1 },
        { key: "trunc", length: 1 },
        { key: "E", length: -1 },
        { key: "LN10", length: -1 },
        { key: "LN2", length: -1 },
        { key: "LOG10E", length: -1 },
        { key: "LOG2E", length: -1 },
        { key: "PI", length: -1 },
        { key: "SQRT1_2", length: -1 },
        { key: "SQRT2", length: -1 },
        { key: "f16round", length: 1 },
      ];
    case "JSON":
      return [
        { key: "parse", length: 2 },
        { key: "stringify", length: 3 },
        { key: "rawJSON", length: 1 },
        { key: "isRawJSON", length: 1 },
      ];
    case "Reflect":
      return [
        { key: "defineProperty", length: 3 },
        { key: "deleteProperty", length: 2 },
        { key: "apply", length: 3 },
        { key: "construct", length: 2 },
        { key: "get", length: 2 },
        { key: "getOwnPropertyDescriptor", length: 2 },
        { key: "getPrototypeOf", length: 1 },
        { key: "has", length: 2 },
        { key: "isExtensible", length: 1 },
        { key: "ownKeys", length: 1 },
        { key: "preventExtensions", length: 1 },
        { key: "set", length: 3 },
        { key: "setPrototypeOf", length: 2 },
      ];
    default:
      return null;
  }
}

/** Property attribute bits for dyn.namespaceDefine (the members are never
 * enumerable). */
const WRITABLE = 1;
const CONFIGURABLE = 4;

/** The namespace object the stdlib global `canonical` reads as in
 * JavaScript, or null when it is not a namespace. */
export function builtinNamespaceValue(
  lowerer: Lowerer,
  canonical: string,
  loc: SrcLoc,
): IrExpr | null {
  const members = namespaceMembers(canonical);
  if (members === null) return null;
  const name = `%builtin.namespace.${canonical}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    defineNamespaceBuilder(lowerer, canonical, members, name, helperLoc(loc));
  lowerer.noteEdge(name);
  return { kind: "call", callee: name, args: [], type: DYN, loc };
}

/** The lifted function that builds the namespace object once and answers
 * the same object afterwards. */
function defineNamespaceBuilder(
  lowerer: Lowerer,
  canonical: string,
  members: readonly NamespaceMember[],
  name: string,
  loc: SrcLoc,
): void {
  const storage = `%g.${name}`;
  const ready = `${storage}%ready`;
  lowerer.globalsList.push(
    { id: storage, name: `${canonical} namespace`, type: DYN, mutable: true },
    { id: ready, name: "%ready", type: BOOL, mutable: true },
  );
  const object = varRef("namespace.0", DYN, loc);
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: varRef(ready, BOOL, loc),
      then: [{ kind: "return", value: varRef(storage, DYN, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "varDecl",
      localId: "namespace.0",
      init: {
        kind: "libCall",
        fn: "dyn.namespaceNew",
        args: [
          { kind: "strLit", value: canonical, type: STRING, loc },
          {
            kind: "dynFrom",
            value: {
              kind: "libCall",
              fn: "sym.wellKnown",
              args: [{ kind: "strLit", value: "toStringTag", type: STRING, loc }],
              type: SYMBOL_T,
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    },
  ];
  for (const { key, length } of members) {
    const value =
      length < 0
        ? constantValue(lowerer, canonical, key, loc)
        : functionValue(lowerer, canonical, key, loc);
    const attributes = length < 0 ? 0 : WRITABLE | CONFIGURABLE;
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.namespaceDefine",
        args: [
          object,
          { kind: "strLit", value: key, type: STRING, loc },
          value,
          { kind: "numLit", value: attributes, type: F64, loc },
          { kind: "numLit", value: length, type: F64, loc },
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  body.push(
    { kind: "assign", localId: storage, value: object, loc },
    {
      kind: "assign",
      localId: ready,
      value: { kind: "boolLit", value: true, type: BOOL, loc },
      loc,
    },
    { kind: "return", value: varRef(storage, DYN, loc), loc },
  );
  lowerer.liftedFns.push({
    name,
    params: [],
    locals: [{ id: "namespace.0", name: "namespace", type: DYN, mutable: false }],
    returnType: DYN,
    body,
    loc,
  });
}

/** A Math constant, boxed. */
function constantValue(lowerer: Lowerer, canonical: string, key: string, loc: SrcLoc): IrExpr {
  const value = canonical === "Math" ? mathMemberValue(lowerer, key, loc) : null;
  if (value === null)
    throw new InternalCompilerError(
      `builtin namespace '${canonical}.${key}' has no constant value`,
    );
  return { kind: "dynFrom", value, type: DYN, loc };
}

/** A function member: its function value under its own name, or a function
 * that throws the named fence when called. */
function functionValue(lowerer: Lowerer, canonical: string, key: string, loc: SrcLoc): IrExpr {
  const value =
    canonical === "Math"
      ? mathMemberValue(lowerer, key, loc)
      : canonical === "JSON"
        ? jsonMemberValue(lowerer, key, loc)
        : null;
  if (value !== null)
    return value.type.kind === "dyn"
      ? value
      : { kind: "dynFrom", value, fnName: key, type: DYN, loc };
  return fencedMember(lowerer, `${canonical}.${key}`, key, loc);
}

/** One function per member without a function value: calling it throws the
 * SC1090 fence, while `typeof`, identity and the property's presence stay
 * as in Node. */
function fencedMember(lowerer: Lowerer, display: string, key: string, loc: SrcLoc): IrExpr {
  const name = `%builtin.fence.${display}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const diag = unsupportedDiag(
      "SC1090",
      loc,
      `'${display}' as a function value (call it directly)`,
    );
    lowerer.runtimeFences.push(diag);
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [
        { kind: "runtimeFence", code: diag.code, message: `${diag.message} [${diag.code}]`, loc },
      ],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([], DYN), loc },
    fnName: key,
    type: DYN,
    loc,
  };
}
