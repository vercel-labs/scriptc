/* Which refusals involve a primitive constructor held as a value.
 *
 * `String`, `Number`, `Boolean` and `BigInt` held as values have two
 * representations (TypeMapperCtx.untypedConstructors). The first pass types
 * them by the constructors' own function types, which serve what a held
 * constructor is used for (a call with any arguments, identity, `name`, a
 * union of several as one function). Whatever else a program does with such
 * a value is an operation on a typed function, a typed record of functions
 * or a typed collection of them, and the typed tier refuses many of those
 * (printing, JSON, `in`, key listing, an untyped slot). In the other
 * representation a constructor type is the checked-dynamic value, as
 * `unknown` is: a table of constructors is a record of untyped values, the
 * tier that held such a table before the function form existed, and those
 * operations run there on the same function values.
 *
 * So the function form stands only for a program whose lowering meets no
 * refusal that involves a held constructor: lowerToIr lowers any other
 * program once more with the constructors untyped and keeps the pass with
 * fewer refusals, a refusal deferred to run time counting like a build
 * error behind the errors (constructorRefusals, fewerRefusals).
 *
 * This module answers which refusals involve one. Once the program has
 * written a constructor as a value (Lowerer.constructorFunctionTypes), the
 * lowerer counts each value it lowers whose type holds a constructor's
 * function type and each mapping of such a type
 * (Lowerer.constructorTouches); a diagnostic made after the innermost
 * statement being lowered counted one is marked
 * (ScrDiagnostic.heldConstructor), and so is every diagnostic made before
 * that first value. The mark over-approximates on purpose: it decides
 * only whether the comparison pass runs, never which pass stands. A program
 * that writes no constructor as a value looks at nothing and never
 * compares. */
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import {
  BIGINT_T,
  BOOL,
  DYN,
  F64,
  STRING,
  primitiveConstructorType,
  sortArms,
} from "../../ir/ir.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";
import type { Lowerer, LowerResult } from "./lowerer.js";

/** Whether a value of `type` holds a primitive constructor by its own
 * function type at any depth: the function itself, a member of a record, an
 * element, a Map's key or value, an arm of a union, a field of a class
 * instance, a parameter or result of a function. */
export function holdsConstructorFunction(lowerer: Lowerer, type: IrType): boolean {
  switch (type.kind) {
    case "func":
    case "array":
    case "map":
    case "set":
    case "promise":
    case "generator":
    case "record":
    case "union":
    case "object":
      return holds(lowerer, type, null);
    default:
      return false;
  }
}

function holds(lowerer: Lowerer, type: IrType, visiting: Set<string> | null): boolean {
  switch (type.kind) {
    case "func": {
      if (type.argumentsPresence === true) return true;
      for (const param of type.params) if (holds(lowerer, param, visiting)) return true;
      return holds(lowerer, type.ret, visiting);
    }
    case "array":
    case "set":
      return holds(lowerer, type.elem, visiting);
    case "map":
      return holds(lowerer, type.key, visiting) || holds(lowerer, type.value, visiting);
    case "promise":
      return holds(lowerer, type.inner, visiting);
    case "generator":
      return (
        holds(lowerer, type.yieldT, visiting) ||
        holds(lowerer, type.retT, visiting) ||
        holds(lowerer, type.nextT, visiting)
      );
    case "record": {
      const shapeId = type.shapeId;
      return named(lowerer, `r:${shapeId}`, visiting, (inner) => {
        const shape = lowerer.shapes.get(shapeId);
        if (shape === undefined) return false;
        for (const field of shape.fields) if (holds(lowerer, field.type, inner)) return true;
        return shape.indexValue !== undefined && holds(lowerer, shape.indexValue, inner);
      });
    }
    case "union": {
      const unionId = type.unionId;
      return named(lowerer, `u:${unionId}`, visiting, (inner) => {
        const arms = lowerer.unions.get(unionId)?.arms ?? [];
        for (const arm of arms) if (holds(lowerer, arm, inner)) return true;
        return false;
      });
    }
    case "object": {
      const className = type.className;
      const fields = lowerer.classes.get(className)?.fields;
      if (fields === undefined) return false;
      // A class gains fields while it is collected: the answer is kept for
      // the fields it was given for.
      return named(lowerer, `c:${className}:${fields.size}`, visiting, (inner) => {
        for (const field of fields.values()) if (holds(lowerer, field, inner)) return true;
        return false;
      });
    }
    default:
      return false;
  }
}

/** The answer for a named type (a record shape, a union, a class), kept in
 * Lowerer.constructorHolders. A type met again while it is being answered
 * holds nothing new: the rest of the walk decides. An answer found under
 * such a cut is not kept unless it is a yes. */
function named(
  lowerer: Lowerer,
  key: string,
  visiting: Set<string> | null,
  answer: (visiting: Set<string>) => boolean,
): boolean {
  const known = lowerer.constructorHolders.get(key);
  if (known !== undefined) return known;
  if (visiting !== null && visiting.has(key)) return false;
  const inner = visiting ?? new Set<string>();
  inner.add(key);
  const result = answer(inner);
  inner.delete(key);
  if (result || inner.size === 0) lowerer.constructorHolders.set(key, result);
  return result;
}

/** Whether one of a pass's refusals, a build error or a refusal deferred to
 * run time, involves a held constructor. A program that never writes a
 * constructor as a value has none, whatever its diagnostics are marked. */
export function constructorRefusals(lowerer: Lowerer, result: LowerResult): boolean {
  if (!lowerer.constructorFunctionTypes) return false;
  return (
    result.diagnostics.some(involvesConstructor) || result.runtimeFences.some(involvesConstructor)
  );
}

/** Whether one of a pass's build errors involves no held constructor. */
export function otherErrors(result: LowerResult): boolean {
  return result.diagnostics.some((d) => !involvesConstructor(d));
}

function involvesConstructor(d: ScrDiagnostic): boolean {
  return d.heldConstructor === true;
}

/** Whether `candidate` refuses less than `standing`: fewer build errors; or
 * as many, and fewer refusals deferred to run time that a module's own
 * top-level code reaches (they stop the program when it starts); or as many
 * of both, and fewer deferred refusals in all. */
export function fewerRefusals(candidate: LowerResult, standing: LowerResult): boolean {
  if (candidate.diagnostics.length !== standing.diagnostics.length)
    return candidate.diagnostics.length < standing.diagnostics.length;
  const atStart = (result: LowerResult): number =>
    result.runtimeFences.filter((d) => d.startup === true || d.moduleInit === true).length;
  const candidateAtStart = atStart(candidate);
  const standingAtStart = atStart(standing);
  if (candidateAtStart !== standingAtStart) return candidateAtStart < standingAtStart;
  return candidate.runtimeFences.length < standing.runtimeFences.length;
}

/** The builtin constructors `node`'s checker type holds, when it holds
 * nothing else: `typeof String`, a union of the primitive constructors,
 * `typeof Function`. Null for any other type. */
export function builtinConstructorNames(lowerer: Lowerer, node: ts.Expression): string[] | null {
  const held = constructorNamesOfType(lowerer, lowerer.typeOf(node));
  return held === null || held.absent ? null : held.names;
}

/** The builtin constructors a checker type holds, and whether it also
 * admits undefined or null (a Map's `get`, an optional member). */
function constructorNamesOfType(
  lowerer: Lowerer,
  type: ts.Type,
): { names: string[]; absent: boolean } | null {
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  const names: string[] = [];
  let absent = false;
  for (const part of parts) {
    if ((part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) {
      absent = true;
      continue;
    }
    const symbol = part.getSymbol();
    if (!symbol) return null;
    const name = ts.symbolName(symbol);
    if (
      name !== "StringConstructor" &&
      name !== "NumberConstructor" &&
      name !== "BooleanConstructor" &&
      name !== "BigIntConstructor" &&
      name !== "FunctionConstructor"
    )
      return null;
    if (!lowerer.isStdlibSymbol(symbol)) return null;
    names.push(name.slice(0, -"Constructor".length));
  }
  return names.length === 0 ? null : { names, absent };
}

/** The text of a value the checker types as a builtin constructor whose
 * function value is compiled or has no text of its own in the runtime
 * (`typeof String`, a union of the primitive constructors, `typeof
 * Function`): Node's `function String() { [native code] }`. It is the
 * answer of every string conversion of such a value (`String(c)`, a
 * template, a concatenation, `c.toString()`, `%s`), in whichever tier holds
 * it. One constructor type names its constructor; a union's value carries
 * the name. Null for any other value. */
export function builtinConstructorText(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
  lists = true,
): IrExpr | null {
  // A typed list of them joins each function's text, which the untyped
  // tier answers from the names the functions' boxes carry: refused here,
  // so that the program holds its constructors untyped. (`lists` is off
  // for `%s`, which prints a list as inspect does.)
  if (lists && value.type.kind === "array" && holdsConstructorFunction(lowerer, value.type.elem))
    lowerer.unsupported(
      "SC1090",
      node,
      "the text of a typed list of built-in constructors (Node joins each function's own text)",
    );
  if (!ts.isExpression(node)) return null;
  const type = lowerer.typeOf(node);
  const held = constructorNamesOfType(lowerer, type);
  const loc = value.loc;
  if (held === null) {
    // An untyped list of them converts as a template converts it: the
    // join that prints each function by the name its box carries.
    if (
      lists &&
      value.type.kind === "dyn" &&
      (lowerer.checker.isArrayType(type) || lowerer.checker.isTupleType(type))
    ) {
      const elements = lowerer.checker.getTypeArguments(type as ts.TypeReference);
      const constructors = (element: ts.Type): boolean => {
        const names = constructorNamesOfType(lowerer, element);
        return names !== null && !names.absent;
      };
      if (elements.length > 0 && elements.every(constructors))
        return { kind: "toString", operand: value, type: STRING, loc };
    }
    return null;
  }
  const { names } = held;
  // An untyped value that may be absent answers as any absent value does.
  if (held.absent) {
    if (value.type.kind !== "dyn") return null;
    const local = lowerer.declareHiddenLocal("%constructor", DYN);
    const read: IrExpr = { kind: "varRef", localId: local.id, type: DYN, loc };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
      result: {
        kind: "ternary",
        cond: { kind: "dynTest", test: "truthy", value: read, type: BOOL, loc },
        then: nameText(lowerer, read, loc),
        else_: { kind: "toString", operand: read, type: STRING, loc },
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    };
  }
  if (names.length === 1) {
    const result: IrExpr = {
      kind: "strLit",
      value: `function ${names[0]}() { [native code] }`,
      type: STRING,
      loc,
    };
    if (isSafeToDiscard(value)) return result;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: value, loc }],
      result,
      type: STRING,
      loc,
    };
  }
  if (value.type.kind !== "func" && value.type.kind !== "dyn") return null;
  return nameText(lowerer, value, loc);
}

/** `function <name>() { [native code] }` with the name `value` carries. */
function nameText(lowerer: Lowerer, value: IrExpr, loc: IrExpr["loc"]): IrExpr {
  const name: IrExpr = {
    kind: "dynCheck",
    value: {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(value, DYN),
      key: { kind: "strLit", value: "name", type: STRING, loc },
      type: DYN,
      loc,
    },
    type: STRING,
    loc,
  };
  return {
    kind: "strConcat",
    left: {
      kind: "strConcat",
      left: { kind: "strLit", value: "function ", type: STRING, loc },
      right: name,
      type: STRING,
      loc,
    },
    right: { kind: "strLit", value: "() { [native code] }", type: STRING, loc },
    type: STRING,
    loc,
  };
}

/** The name prefix of the program's one function per primitive constructor
 * (lower-exprs.ts, primitiveCtorClosure). */
export const CONSTRUCTOR_FUNCTION_PREFIX = "%builtin.constructor.";

/** The box of a primitive constructor's function, made where the function
 * itself is written, carries the constructor's name: the untyped tier
 * prints a list of functions by the names their boxes carry. A box made
 * from a slot's content has no static name (the slot holds whichever
 * function was stored) and is answered at run time. */
export function namedConstructorBox(e: IrExpr): IrExpr {
  if (
    e.kind === "dynFrom" &&
    e.fnName === undefined &&
    e.value.kind === "closure" &&
    e.value.fnName.startsWith(CONSTRUCTOR_FUNCTION_PREFIX)
  )
    return { ...e, fnName: e.value.fnName.slice(CONSTRUCTOR_FUNCTION_PREFIX.length) };
  return e;
}

/** In the pass that holds constructors untyped: a value the checker types
 * as a primitive constructor (or a union of several), about to enter a slot
 * of a function type. It enters as the constructor's function does, through
 * a checked read of the function type and the rules for that type (the
 * exact adapter, the store check), not as an untyped function of unknown
 * arity, whose view under a fixed signature passes only the arguments the
 * signature names. Null for any other value. */
export function untypedConstructorAsFunction(
  lowerer: Lowerer,
  node: ts.Node,
  value: IrExpr,
): IrExpr | null {
  if (value.type.kind !== "dyn" || !ts.isExpression(node)) return null;
  const held = constructorNamesOfType(lowerer, lowerer.typeOf(node));
  if (held === null || held.absent || held.names.includes("Function")) return null;
  const results: IrType[] = [];
  for (const name of held.names) {
    const result =
      name === "String" ? STRING : name === "Number" ? F64 : name === "Boolean" ? BOOL : BIGINT_T;
    if (!results.includes(result)) results.push(result);
  }
  sortArms(results);
  const type = primitiveConstructorType(
    results.length === 1 ? results[0]! : { kind: "union", unionId: lowerer.unions.intern(results) },
  );
  return { kind: "dynCheck", value, type, loc: value.loc };
}
