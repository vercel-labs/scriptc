/** Static members of builtin constructors read through untyped values
 * (`globalThis[name].resolve`, `this.Promise.resolve` in a sloppy-mode
 * function, `o.constructor.keys`). The runtime answers Node's own static
 * members of the builtin constructor values (scr_builtin_values.c): the
 * numeric constants, and functions with Node's name and length that throw
 * SC1090 when called. Once a constructor has a property table, they are own
 * properties of it with Node's attributes. A program that holds builtin
 * constructor values installs a lookup (`%builtin.staticValue`) answering
 * the members it has function values for with the values their static
 * spellings read, so `globalThis.Object.keys === Object.keys`. */
import {
  BOOL,
  DYN,
  F64,
  STRING,
  SYMBOL_T,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
  funcOf,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList } from "../../ir/traverse.js";
import { own, type Lowerer } from "./lowerer.js";
import { OBJECT_CALLABLE_VALUES } from "./surfaces.js";
import {
  lowerArrayIsArrayValue,
  lowerNumberParserValue,
  lowerObjectAssignValue,
  lowerStringCodesValue,
} from "./lower-builtin-values.js";
import { lowerArrayFromValue } from "./containers/array-construction.js";
import { numberPredicateValue } from "./builtins/numbers.js";

const LOOKUP_FN = "%builtin.staticValue";

/** The static members of `owner` that `constructorStaticValue` answers,
 * with Node's length for each. */
function staticValueMembers(owner: string): Readonly<Record<string, number>> {
  switch (owner) {
    case "Object":
      return {
        assign: 2,
        freeze: 1,
        is: 2,
        create: 2,
        defineProperty: 3,
        getOwnPropertyDescriptor: 2,
        getOwnPropertyDescriptors: 1,
        defineProperties: 2,
        hasOwn: 2,
        keys: 1,
        values: 1,
        entries: 1,
        fromEntries: 1,
        getOwnPropertySymbols: 1,
        getOwnPropertyNames: 1,
        getPrototypeOf: 1,
      };
    case "Array":
      return { isArray: 1, from: 1 };
    case "String":
      return { fromCharCode: 1, fromCodePoint: 1 };
    case "Number":
      return { isFinite: 1, isNaN: 1, isInteger: 1, isSafeInteger: 1, parseFloat: 1, parseInt: 2 };
    case "Date":
      return { now: 0 };
    case "Error":
      return { captureStackTrace: 2 };
    case "Symbol": {
      const members: Record<string, number> = { for: 1, keyFor: 1 };
      for (const key of WELL_KNOWN_SYMBOLS) members[key] = SYMBOL_CONSTANT;
      return members;
    }
    default:
      return {};
  }
}

/** Node 24's well-known symbols, the Symbol constructor's constant
 * members. */
const WELL_KNOWN_SYMBOLS = [
  "asyncIterator",
  "hasInstance",
  "isConcatSpreadable",
  "iterator",
  "match",
  "matchAll",
  "replace",
  "search",
  "species",
  "split",
  "toPrimitive",
  "toStringTag",
  "unscopables",
  "dispose",
  "asyncDispose",
];

/** The length staticValueMembers gives a well-known symbol: the lookup
 * answers it whether or not the program names it. */
const SYMBOL_CONSTANT = -1;

/** The compiled closures the primitive constructors read as (lower-exprs.ts
 * primitiveCtorClosure, and Symbol's in global-function-values.ts). The
 * runtime does not intern them, so the lookup names their constructor when
 * the runtime asks for the key "". */
const PRIMITIVE_CONSTRUCTORS: ReadonlyMap<string, string> = new Map([
  ["%builtin.String", "String"],
  ["%builtin.String.dyn", "String"],
  ["%builtin.Number", "Number"],
  ["%builtin.Number.dyn", "Number"],
  ["%builtin.Boolean", "Boolean"],
  ["%builtin.Boolean.dyn", "Boolean"],
  ["%builtin.BigInt", "BigInt"],
  ["%builtin.BigInt.dyn", "BigInt"],
  ["%builtin.global.Symbol", "Symbol"],
]);

/** The function value the static spelling `owner.key` reads, or null when
 * the member has none. */
export function constructorStaticValue(
  lowerer: Lowerer,
  owner: string,
  key: string,
  loc: SrcLoc,
): IrExpr | null {
  switch (owner) {
    case "Object": {
      if (key === "assign") return lowerObjectAssignValue(lowerer, loc);
      if (key === "freeze") return objectFreezeValue(lowerer, loc);
      const fn = own(OBJECT_CALLABLE_VALUES, key);
      return fn ? lowerer.lowerNativeCallableValue(fn, `Object.${key}`, loc) : null;
    }
    case "Array":
      if (key === "isArray") return lowerArrayIsArrayValue(lowerer, loc);
      return key === "from" ? lowerArrayFromValue(lowerer, loc) : null;
    case "String":
      return key === "fromCharCode" || key === "fromCodePoint"
        ? lowerStringCodesValue(lowerer, key, loc)
        : null;
    case "Number":
      return key === "parseInt" || key === "parseFloat"
        ? lowerNumberParserValue(lowerer, key, loc)
        : numberPredicateValue(lowerer, key, loc);
    case "Date":
      return key === "now"
        ? lowerer.lowerNativeCallableValue(
            { fn: "date.now", params: [], result: F64, valueParams: [] },
            "Date.now",
            loc,
          )
        : null;
    case "Symbol":
      return symbolStaticValue(lowerer, key, loc);
    case "Error":
      return key === "captureStackTrace"
        ? { kind: "libCall", fn: "dyn.errorCaptureStackTraceFunction", args: [], type: DYN, loc }
        : null;
    default:
      return null;
  }
}

/** Symbol.for, Symbol.keyFor and the well-known symbols. */
function symbolStaticValue(lowerer: Lowerer, key: string, loc: SrcLoc): IrExpr | null {
  if (WELL_KNOWN_SYMBOLS.includes(key))
    return {
      kind: "dynFrom",
      value: {
        kind: "libCall",
        fn: "sym.wellKnown",
        args: [{ kind: "strLit", value: key, type: STRING, loc }],
        type: SYMBOL_T,
        loc,
      },
      type: DYN,
      loc,
    };
  if (key !== "for" && key !== "keyFor") return null;
  const name = `%builtin.Symbol.${key}`;
  const argument = varRef("value", DYN, loc);
  const value: IrExpr =
    key === "for"
      ? {
          kind: "dynFrom",
          value: {
            kind: "libCall",
            fn: "sym.for",
            args: [
              { kind: "libCall", fn: "dyn.toStringCoerce", args: [argument], type: STRING, loc },
            ],
            type: SYMBOL_T,
            loc,
          },
          type: DYN,
          loc,
        }
      : { kind: "libCall", fn: "sym.keyForDyn", args: [argument], type: DYN, loc };
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      returnType: DYN,
      body: [{ kind: "return", value, loc }],
      loc,
    });
  return { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc };
}

/** Object.freeze as a function value. It can freeze any untyped value it
 * is passed, so the program keeps integrity words on untyped values. */
export function objectFreezeValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  lowerer.untypedIntegrity = true;
  const name = "%builtin.Object.freeze";
  if (!lowerer.liftedFns.some((fn) => fn.name === name))
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      returnType: DYN,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.freeze",
            args: [varRef("value", DYN, loc)],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  return { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc };
}

/** A builtin constructor value read in `functions`: its constructor, the
 * key that tells its values apart, a fresh expression reading it, and
 * whether the runtime interns it. */
interface ConstructorValue {
  readonly owner: string;
  readonly key: string;
  readonly read: (loc: SrcLoc) => IrExpr;
  readonly interned: boolean;
}

function constructorValueOf(expr: IrExpr): ConstructorValue | null {
  if (expr.kind === "libCall") {
    const arg = expr.args[0];
    const fn = expr.fn;
    const owner =
      fn === "dyn.globalConstructor"
        ? arg?.kind === "strLit"
          ? arg.value
          : null
        : fn === "dyn.arrayConstructor"
          ? "Array"
          : fn === "arrayBuffer.constructor"
            ? "ArrayBuffer"
            : null;
    if (owner === null) return null;
    const args = fn === "dyn.globalConstructor" ? [owner] : [];
    return {
      owner,
      key: owner,
      read: (loc) => ({
        kind: "libCall",
        fn,
        args: args.map((value) => ({ kind: "strLit", value, type: STRING, loc })),
        type: DYN,
        loc,
      }),
      interned: true,
    };
  }
  if (
    expr.kind === "dynFrom" &&
    expr.value.kind === "closure" &&
    expr.value.captures.length === 0
  ) {
    const closure = expr.value;
    const owner = PRIMITIVE_CONSTRUCTORS.get(closure.fnName);
    if (owner === undefined) return null;
    return {
      owner,
      key: closure.fnName,
      read: (loc) => ({
        kind: "dynFrom",
        value: { kind: "closure", fnName: closure.fnName, captures: [], type: closure.type, loc },
        type: DYN,
        loc,
      }),
      interned: false,
    };
  }
  return null;
}

/** Installs the program's static-member lookup at the start of the entry
 * module when `functions` read a builtin constructor value or a
 * `constructor` member of an untyped value. The lookup answers the static
 * members with function values whose names the program spells (as a
 * member name or a string), and the runtime the others. */
export function installBuiltinStatics(lowerer: Lowerer, functions: IrFunction[]): void {
  const entryInit = lowerer.initNameOf.get(lowerer.entry);
  const entry = functions.find((fn) => fn.name === entryInit);
  if (entry === undefined) return;
  const values = new Map<string, ConstructorValue>();
  const names = new Set<string>();
  let readsConstructor = false;
  for (const fn of functions) {
    everyStmtList(fn.body, {
      expr: (expr) => {
        if (expr.kind === "strLit") names.add(expr.value);
        else if (expr.kind === "dynHasKey") names.add(expr.key);
        else if (expr.kind === "dynInvoke") names.add(expr.method);
        if (
          expr.kind === "dynKeyGet" &&
          expr.key.kind === "strLit" &&
          expr.key.value === "constructor"
        )
          readsConstructor = true;
        const value = constructorValueOf(expr);
        if (value !== null && !values.has(value.key)) values.set(value.key, value);
        return true;
      },
      stmt: () => true,
    });
  }
  if (values.size === 0 && !readsConstructor) return;
  // A `constructor` member of an untyped value can be one of the
  // constructors the runtime answers it with, whose static members then
  // need their function values too (`JSON.parse(text).constructor.keys`).
  if (readsConstructor)
    for (const owner of ["Object", "Array", "Date", "Error"]) {
      const value = constructorValueOf(
        owner === "Array"
          ? { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc: entry.loc }
          : {
              kind: "libCall",
              fn: "dyn.globalConstructor",
              args: [{ kind: "strLit", value: owner, type: STRING, loc: entry.loc }],
              type: DYN,
              loc: entry.loc,
            },
      );
      if (value !== null && !values.has(value.key)) values.set(value.key, value);
    }
  const loc: SrcLoc = { ...entry.loc, end: entry.loc.start };
  const lifted = lowerer.liftedFns.length;
  if (!lowerer.liftedFns.some((fn) => fn.name === LOOKUP_FN)) {
    const value: IrExpr = { kind: "varRef", localId: "value.0", type: DYN, loc };
    const key: IrExpr = { kind: "varRef", localId: "key.0", type: STRING, loc };
    const body: IrStmt[] = [];
    for (const constructor of values.values()) {
      // The key "" asks which constructor a value the runtime does not
      // intern is (scr_bv_owner_of).
      const members: IrStmt[] = constructor.interned
        ? []
        : [
            ifKey(
              key,
              "",
              lowerer.coerceToExpected(
                { kind: "strLit", value: constructor.owner, type: STRING, loc },
                DYN,
              ),
              loc,
            ),
          ];
      const lengths = staticValueMembers(constructor.owner);
      for (const member of Object.keys(lengths)) {
        if (!names.has(member) && lengths[member] !== SYMBOL_CONSTANT) continue;
        // Untyped values carry integrity words only in programs that can
        // freeze them, which lowering has settled by now.
        if (member === "freeze" && !lowerer.untypedIntegrity) continue;
        const found = constructorStaticValue(lowerer, constructor.owner, member, loc);
        if (found === null) continue;
        const boxed = lowerer.coerceToExpected(found, DYN);
        const named: IrExpr =
          boxed.kind === "dynFrom" && boxed.value.type.kind === "func"
            ? { ...boxed, fnName: member, fnLength: lengths[member] ?? 0 }
            : boxed;
        members.push(ifKey(key, member, named, loc));
      }
      // The runtime answers the other members.
      members.push({ kind: "return", value: nullValue(lowerer, loc), loc });
      body.push({
        kind: "if",
        cond: { kind: "dynScalarEq", left: value, right: constructor.read(loc), type: BOOL, loc },
        then: members,
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: nullValue(lowerer, loc), loc });
    lowerer.liftedFns.push({
      name: LOOKUP_FN,
      params: [
        { localId: "value.0", name: "value", type: DYN },
        { localId: "key.0", name: "key", type: STRING },
      ],
      returnType: DYN,
      locals: [
        { id: "value.0", name: "value", type: DYN, mutable: false },
        { id: "key.0", name: "key", type: STRING, mutable: false },
      ],
      body,
      loc,
    });
  }
  functions.push(...lowerer.liftedFns.slice(lifted));
  const fnType: IrType = { kind: "func", params: [DYN, STRING], ret: DYN };
  entry.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.installBuiltinStatics",
      args: [
        lowerer.coerceToExpected(
          { kind: "closure", fnName: LOOKUP_FN, captures: [], type: fnType, loc },
          DYN,
        ),
      ],
      type: { kind: "void" },
      loc,
    },
    loc,
  });
}

function ifKey(key: IrExpr, member: string, value: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "if",
    cond: {
      kind: "strEq",
      negated: false,
      left: key,
      right: { kind: "strLit", value: member, type: STRING, loc },
      type: BOOL,
      loc,
    },
    then: [{ kind: "return", value, loc }],
    else_: null,
    loc,
  };
}

function nullValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  return lowerer.coerceToExpected(
    { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc },
    DYN,
  );
}
