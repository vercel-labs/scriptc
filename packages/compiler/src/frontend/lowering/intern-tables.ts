/* InternTable (@scriptc/experimental): named, append-only tables of
 * published values that every thread shares (scr_itable.c).
 *
 * An InternTable value is an instance of the synthetic class
 * `%InternTable` whose one private field holds the runtime table handle,
 * so it has the identity, typeof and inspection of the Node.js class (whose
 * state is private). One class serves every instantiation: the key and
 * value types come from the checker at each use. The surface lowers at its
 * use sites:
 * - `new InternTable<K, V>("name")` constructs the class; its constructor
 *   opens the table (itable.open). The name must be a string literal, and
 *   every construction of one name must use the same type arguments: all
 *   threads of the process share the table, so its value layout is one.
 * - `table.has(k)` is itable.find, `table.size` is itable.size;
 * - `get`, `getOrInsert` and `getOrInsertComputed` call an interned helper
 *   per (member, key type, value type) that finds the key's entry, inserts
 *   the published value when there is none (threads.publish, so the
 *   publication analysis guards stores into the value's types), and reads
 *   the entry's value (itable.value). `getOrInsertComputed` with a
 *   function expression lowers in place instead, and creates the callback
 *   only when the key has no entry; an arrow function with an expression
 *   body is not created at all: its body is lowered in place.
 * The entry handles that itable.find and itable.insert answer stay inside
 * these lowerings: f64 locals that only reach toBool and itable.value.
 * Any other use of the class or its members as values is refused. */
import { keyedHelperName } from "./stable-names.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { BOOL, F64, STRING, funcOf, typeKey } from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import {
  type InternTableMember,
  experimentalImportOf,
  internTableMemberOf,
} from "../experimental-import.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";

export const INTERN_TABLE_CLASS = "%InternTable";
const TABLE_FIELD = "#table";

const BUILTIN_LOC: SrcLoc = { file: "<builtin>", start: 0, end: 0 };

/** The runtime key kind of a key type (scr_itable.h SCR_ITABLE_KEY_*):
 * strings, numbers, and arrays of numbers or of strings. */
function keyKind(key: IrType): number | null {
  if (key.kind === "string") return 0;
  if (key.kind === "f64") return 1;
  if (key.kind === "array" && key.elem.kind === "f64") return 2;
  if (key.kind === "array" && key.elem.kind === "string") return 3;
  return null;
}

/** Value types a table stores: the publishable Map value types. */
const VALUE_KINDS = new Set<IrType["kind"]>([
  "f64",
  "bool",
  "string",
  "bigint",
  "array",
  "map",
  "set",
  "record",
  "object",
  "union",
  "dyn",
]);

/** The InternTable instance type, registering the class (and its
 * constructor) on first use. */
export function internTableType(lowerer: Lowerer): IrType {
  const type: IrType = { kind: "object", className: INTERN_TABLE_CLASS };
  if (lowerer.classes.has(INTERN_TABLE_CLASS)) return type;
  const info: ClassInfo = {
    def: {
      name: INTERN_TABLE_CLASS,
      fields: [{ name: TABLE_FIELD, type: F64 }],
      loc: BUILTIN_LOC,
    },
    fields: new Map(),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    internTable: true,
    ctor: null,
    ctorParams: [
      { type: STRING, mode: "required" },
      { type: F64, mode: "required" },
    ],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
  };
  lowerer.classes.set(INTERN_TABLE_CLASS, info);
  const ref = (localId: string, t: IrType): IrExpr => ({
    kind: "varRef",
    localId,
    type: t,
    loc: BUILTIN_LOC,
  });
  lowerer.liftedFns.push({
    name: `%${INTERN_TABLE_CLASS}.constructor`,
    params: [
      { localId: "this.0", name: "this", type },
      { localId: "name.0", name: "name", type: STRING },
      { localId: "kind.0", name: "kind", type: F64 },
    ],
    returnType: { kind: "void" },
    locals: [
      { id: "this.0", name: "this", type, mutable: false },
      { id: "name.0", name: "name", type: STRING, mutable: false },
      { id: "kind.0", name: "kind", type: F64, mutable: false },
    ],
    body: [
      {
        kind: "fieldSet",
        obj: ref("this.0", type),
        className: INTERN_TABLE_CLASS,
        field: TABLE_FIELD,
        value: {
          kind: "intrinsic",
          name: "itable.open",
          args: [ref("name.0", STRING), ref("kind.0", F64)],
          type: F64,
          loc: BUILTIN_LOC,
        },
        loc: BUILTIN_LOC,
      },
    ],
    loc: BUILTIN_LOC,
  });
  return type;
}

interface TableTypes {
  key: IrType;
  value: IrType;
}

/** The key and value types of an InternTable<K, V> checker type. */
function tableTypes(lowerer: Lowerer, type: ts.Type, blame: ts.Node): TableTypes {
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  const table = parts.find((p) => ts.symbolNameOf(p.getSymbol()) === "InternTable");
  const args = table ? lowerer.checker.getTypeArguments(table as ts.TypeReference) : [];
  if (args.length !== 2) lowerer.noLowering("InternTable without type arguments", blame);
  const key = lowerer.mapTypeOf(args[0]!);
  if (key === null || keyKind(key) === null)
    lowerer.unsupported(
      "SC1090",
      blame,
      `'${lowerer.checker.typeToString(args[0]!)}' as an InternTable key type`,
      "use string or number keys, or arrays of numbers or of strings",
    );
  const value = lowerer.mapTypeOf(args[1]!);
  if (value === null || !VALUE_KINDS.has(value.kind))
    lowerer.unsupported(
      "SC1090",
      blame,
      `'${lowerer.checker.typeToString(args[1]!)}' as an InternTable value type`,
      "store numbers, booleans, strings, bigints, arrays, Maps, Sets, objects and class instances",
    );
  return { key: key!, value: value! };
}

/** `new InternTable<K, V>("name")`. */
export function lowerInternTableNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  if (experimentalImportOf(lowerer.program, expr.expression) !== "InternTable") return null;
  const args = expr.arguments?.nodes ?? [];
  const arg = args[0];
  if (args.length !== 1 || arg === undefined || ts.isSpreadElement(arg))
    lowerer.noLowering(`new InternTable with ${args.length} arguments`, expr);
  if (!ts.isStringLiteral(arg!) && !ts.isNoSubstitutionTemplateLiteral(arg!))
    lowerer.unsupported(
      "SC1090",
      arg!,
      "InternTable names other than string literals",
      "name the table with a string literal: every thread that opens the name shares the table",
    );
  const name = (arg as ts.StringLiteral).text;
  const types = tableTypes(lowerer, lowerer.typeOf(expr), expr);
  const signature = `${typeKey(types.key)}|${typeKey(types.value)}`;
  const known = lowerer.internTableNames.get(name);
  if (known === undefined) lowerer.internTableNames.set(name, { key: signature, node: expr });
  else if (known.key !== signature)
    lowerer.unsupported(
      "SC1090",
      expr,
      `opening InternTable ${JSON.stringify(name)} with different type arguments than its first construction`,
      "every construction of one table name must use the same key and value types",
    );
  const loc = locOf(expr);
  return {
    kind: "new",
    className: INTERN_TABLE_CLASS,
    args: [
      { kind: "strLit", value: name, type: STRING, loc },
      { kind: "numLit", value: keyKind(types.key)!, type: F64, loc },
    ],
    type: internTableType(lowerer),
    loc,
  };
}

function handleOf(table: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "fieldGet",
    obj: table,
    className: INTERN_TABLE_CLASS,
    field: TABLE_FIELD,
    type: F64,
    loc,
  };
}

function find(handle: IrExpr, key: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "intrinsic", name: "itable.find", args: [handle, key], type: F64, loc };
}

/** The receiver of an InternTable member access, as a table value. */
function receiverOf(lowerer: Lowerer, access: ts.PropertyAccessExpression): IrExpr {
  return lowerer.coerceInto(
    access.expression,
    lowerer.lowerExpr(access.expression),
    internTableType(lowerer),
  );
}

/** `table.size`, and the refusal of members used as values. */
export function lowerInternTableProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = internTableMemberOf(lowerer.program, expr, lowerer.experimentalFiles);
  if (member === null) return null;
  if (member !== "size")
    lowerer.noLowering(
      `InternTable.${member} (@scriptc/experimental) as a value`,
      expr,
      `call table.${member}(...) directly`,
    );
  if (expr.questionDotToken !== undefined && !lowerer.chainHandled.has(expr)) return null;
  const loc = locOf(expr);
  return {
    kind: "intrinsic",
    name: "itable.size",
    args: [handleOf(receiverOf(lowerer, expr), loc)],
    type: F64,
    loc,
  };
}

/** `table.get(k)`, `has`, `getOrInsert` and `getOrInsertComputed`. */
export function lowerInternTableCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const member = internTableMemberOf(lowerer.program, callee, lowerer.experimentalFiles);
  if (member === null || member === "size") return null;
  // `table?.get(k)`: the optional-chain lowering binds the receiver and
  // dispatches the call again (optional-chains.ts).
  if (callee.questionDotToken !== undefined && !lowerer.chainHandled.has(callee)) return null;
  const loc = locOf(expr);
  if (expr.questionDotToken !== undefined)
    lowerer.noLowering(`InternTable.${member}?.() calls`, expr, `call table.${member}() directly`);
  const arity = member === "get" || member === "has" ? 1 : 2;
  if (
    expr.arguments.nodes.length !== arity ||
    expr.arguments.nodes.some((a) => ts.isSpreadElement(a))
  )
    lowerer.noLowering(`InternTable.${member} with ${expr.arguments.nodes.length} arguments`, expr);
  const types = tableTypes(lowerer, lowerer.typeOf(callee.expression), expr);
  const table = receiverOf(lowerer, callee);
  const keyNode = expr.arguments.nodes[0]!;
  const key = lowerer.coerceInto(keyNode, lowerer.lowerExpr(keyNode), types.key);
  if (member === "has")
    return { kind: "toBool", operand: find(handleOf(table, loc), key, loc), type: BOOL, loc };
  if (member === "get") {
    const resultTs = lowerer.typeOf(expr);
    const result = lowerer.mapTypeOf(resultTs);
    if (result === null) lowerer.badType(expr, resultTs);
    return {
      kind: "call",
      callee: getHelper(lowerer, types, result!),
      args: [table, key],
      type: result!,
      loc,
    };
  }
  const valueNode = expr.arguments.nodes[1]!;
  const expected = member === "getOrInsert" ? types.value : funcOf([types.key], types.value);
  if (
    member === "getOrInsertComputed" &&
    (ts.isArrowFunction(valueNode) || ts.isFunctionExpression(valueNode))
  )
    return lowerComputedInline(lowerer, table, key, valueNode, types, expected, loc);
  const value = lowerer.coerceInto(valueNode, lowerer.lowerExpr(valueNode), expected);
  return {
    kind: "call",
    callee: insertHelper(lowerer, member, types, expected),
    args: [table, key, value],
    type: types.value,
    loc,
  };
}

/** `table.getOrInsertComputed(key, () => ...)` with a function expression:
 *
 *     const t = table, k = key, e = itable.find(t.#table, k);
 *     e ? itable.value(e) : itable.value(itable.insert(t.#table, k, publish(callback(k))))
 *
 * Creating a function has no observable effect, so the callback's closure
 * is created only when the key has no entry, and a hit allocates nothing.
 * An arrow function with an expression body is lowered in place instead
 * (inlineArrowBody). */
function lowerComputedInline(
  lowerer: Lowerer,
  table: IrExpr,
  key: IrExpr,
  callbackNode: ts.Expression,
  types: TableTypes,
  callbackType: IrType,
  loc: SrcLoc,
): IrExpr {
  const tableT = internTableType(lowerer);
  const tableLocal = lowerer.declareHiddenLocal("%internTable", tableT);
  const keyLocal = lowerer.declareHiddenLocal("%internKey", types.key);
  const entryLocal = lowerer.declareHiddenLocal("%internEntry", F64);
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const handle = (): IrExpr => handleOf(ref(tableLocal.id, tableT), loc);
  const computed: IrExpr = inlineArrowBody(
    lowerer,
    callbackNode,
    ref(keyLocal.id, types.key),
    types.value,
  ) ?? {
    kind: "callValue",
    callee: lowerer.coerceInto(callbackNode, lowerer.lowerExpr(callbackNode), callbackType),
    args: [ref(keyLocal.id, types.key)],
    type: types.value,
    loc,
  };
  const inserted: IrExpr = {
    kind: "intrinsic",
    name: "itable.insert",
    args: [
      handle(),
      ref(keyLocal.id, types.key),
      { kind: "intrinsic", name: "threads.publish", args: [computed], type: types.value, loc },
    ],
    type: F64,
    loc,
  };
  const valueOf = (entry: IrExpr): IrExpr => ({
    kind: "intrinsic",
    name: "itable.value",
    args: [entry],
    type: types.value,
    loc,
  });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: tableLocal.id, init: table, loc },
      { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      {
        kind: "varDecl",
        localId: entryLocal.id,
        init: find(handle(), ref(keyLocal.id, types.key), loc),
        loc,
      },
    ],
    result: {
      kind: "ternary",
      cond: { kind: "toBool", operand: ref(entryLocal.id, F64), type: BOOL, loc },
      then: valueOf(ref(entryLocal.id, F64)),
      else_: valueOf(inserted),
      type: types.value,
      loc,
    },
    type: types.value,
    loc,
  };
}

/** Whether `node` contains a function or class, whose captures of the
 * inlined parameter would need a closure after all. */
function containsFunction(node: ts.Node): boolean {
  if (ts.isFunctionLike(node) || ts.isClassLikeDeclaration(node)) return true;
  return ts.forEachChild(node, (child) => (containsFunction(child) ? true : undefined)) === true;
}

/** The body of `() => value` or `(k) => value`, lowered where the callback
 * would be called, with the parameter bound to the key. Calling a fresh
 * arrow function at once is evaluating its body there with its parameter
 * bound, so no closure is created. Other callbacks answer null. */
function inlineArrowBody(
  lowerer: Lowerer,
  node: ts.Expression,
  key: IrExpr,
  value: IrType,
): IrExpr | null {
  if (!ts.isArrowFunction(node) || ts.isBlock(node.body)) return null;
  if (node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const param = node.parameters.nodes[0];
  if (
    node.parameters.nodes.length > 1 ||
    (param !== undefined &&
      (!ts.isIdentifier(param.name) ||
        param.initializer !== undefined ||
        param.dotDotDotToken !== undefined))
  )
    return null;
  if (containsFunction(node.body)) return null;
  const body = node.body;
  const loc = locOf(node);
  lowerer.scopes.push(new Map());
  try {
    const stmts: IrStmt[] = [];
    if (param !== undefined) {
      const paramTs = lowerer.typeOf(param);
      const paramType = lowerer.mapTypeOf(paramTs);
      if (paramType === null) lowerer.badType(param, paramTs);
      const local = lowerer.declareLocal(
        param.name,
        (param.name as ts.Identifier).text,
        paramType!,
        false,
      );
      stmts.push({
        kind: "varDecl",
        localId: local.id,
        init: lowerer.coerceToExpected(key, paramType!),
        loc,
      });
    }
    const result = lowerer.coerceInto(body, lowerer.lowerExpr(body), value);
    return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: value, loc };
  } finally {
    lowerer.scopes.pop();
  }
}

function helperName(lowerer: Lowerer, member: InternTableMember, signature: string): string | null {
  return lowerer.internTableHelpers.get(`${member}|${signature}`) ?? null;
}

function registerHelper(lowerer: Lowerer, member: InternTableMember, signature: string): string {
  const name = keyedHelperName(
    lowerer,
    `%${INTERN_TABLE_CLASS}.${member}`,
    `${member}|${signature}`,
  );
  lowerer.internTableHelpers.set(`${member}|${signature}`, name);
  return name;
}

/** `get` for one (key, result) type pair:
 *
 *     const e = itable.find(table.#table, key);
 *     if (e) return itable.value(e);
 *     return undefined;
 */
function getHelper(lowerer: Lowerer, types: TableTypes, result: IrType): string {
  const signature = `${typeKey(types.key)}|${typeKey(types.value)}|${typeKey(result)}`;
  const known = helperName(lowerer, "get", signature);
  if (known !== null) return known;
  const name = registerHelper(lowerer, "get", signature);
  const loc = BUILTIN_LOC;
  const tableT = internTableType(lowerer);
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const value: IrExpr = {
    kind: "intrinsic",
    name: "itable.value",
    args: [ref("e.0", F64)],
    type: types.value,
    loc,
  };
  const absent =
    result.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(result, loc);
  if (absent === null)
    throw new InternalCompilerError(`InternTable.get result ${typeKey(result)} has no undefined`);
  const fn: IrFunction = {
    name,
    params: [
      { localId: "table.0", name: "table", type: tableT },
      { localId: "key.0", name: "key", type: types.key },
    ],
    returnType: result,
    locals: [
      { id: "table.0", name: "table", type: tableT, mutable: false },
      { id: "key.0", name: "key", type: types.key, mutable: false },
      { id: "e.0", name: "e", type: F64, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "e.0",
        init: find(handleOf(ref("table.0", tableT), loc), ref("key.0", types.key), loc),
        loc,
      },
      {
        kind: "if",
        cond: { kind: "toBool", operand: ref("e.0", F64), type: BOOL, loc },
        then: [{ kind: "return", value: lowerer.coerceToExpected(value, result), loc }],
        else_: null,
        loc,
      },
      { kind: "return", value: absent, loc },
    ],
    loc,
  };
  lowerer.liftedFns.push(fn);
  return name;
}

/** `getOrInsert` and `getOrInsertComputed` for one (key, value) type pair:
 *
 *     let e = itable.find(table.#table, key);
 *     if (!e) e = itable.insert(table.#table, key, publish(value));
 *     return itable.value(e);
 *
 * where `value` is the argument, or `callback(key)`. */
function insertHelper(
  lowerer: Lowerer,
  member: "getOrInsert" | "getOrInsertComputed",
  types: TableTypes,
  argType: IrType,
): string {
  const signature = `${typeKey(types.key)}|${typeKey(types.value)}`;
  const known = helperName(lowerer, member, signature);
  if (known !== null) return known;
  const name = registerHelper(lowerer, member, signature);
  const loc = BUILTIN_LOC;
  const tableT = internTableType(lowerer);
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const handle = (): IrExpr => handleOf(ref("table.0", tableT), loc);
  const computed: IrExpr =
    member === "getOrInsert"
      ? ref("value.0", argType)
      : {
          kind: "callValue",
          callee: ref("value.0", argType),
          args: [ref("key.0", types.key)],
          type: types.value,
          loc,
        };
  const insert: IrStmt = {
    kind: "assign",
    localId: "e.0",
    value: {
      kind: "intrinsic",
      name: "itable.insert",
      args: [
        handle(),
        ref("key.0", types.key),
        { kind: "intrinsic", name: "threads.publish", args: [computed], type: types.value, loc },
      ],
      type: F64,
      loc,
    },
    loc,
  };
  const fn: IrFunction = {
    name,
    params: [
      { localId: "table.0", name: "table", type: tableT },
      { localId: "key.0", name: "key", type: types.key },
      { localId: "value.0", name: member === "getOrInsert" ? "value" : "callback", type: argType },
    ],
    returnType: types.value,
    locals: [
      { id: "table.0", name: "table", type: tableT, mutable: false },
      { id: "key.0", name: "key", type: types.key, mutable: false },
      {
        id: "value.0",
        name: member === "getOrInsert" ? "value" : "callback",
        type: argType,
        mutable: false,
      },
      { id: "e.0", name: "e", type: F64, mutable: true },
    ],
    body: [
      { kind: "varDecl", localId: "e.0", init: find(handle(), ref("key.0", types.key), loc), loc },
      {
        kind: "if",
        cond: {
          kind: "unary",
          op: "!",
          operand: { kind: "toBool", operand: ref("e.0", F64), type: BOOL, loc },
          type: BOOL,
          loc,
        },
        then: [insert],
        else_: null,
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "intrinsic",
          name: "itable.value",
          args: [ref("e.0", F64)],
          type: types.value,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  lowerer.liftedFns.push(fn);
  return name;
}
