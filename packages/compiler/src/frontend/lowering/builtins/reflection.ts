import { nodeThrowExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, jsFuncNameOf } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { builtinModuleFnOf } from "../surfaces.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { lowerInGlobalObject } from "../expressions/relational.js";
import { noteUntypedIntegrity } from "../frozen-records.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  canConvertToDyn,
  isUnitType,
} from "../../../ir/ir.js";

const str = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });

/** `Type(target) is Object`: objects and functions, never null. This is the
 * test every Reflect member applies before its operation, answering Node's
 * TypeError when it fails. */
function isObjectTarget(target: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "logical",
    op: "||",
    left: { kind: "dynTest", test: "function", value: target, type: BOOL, loc },
    right: {
      kind: "logical",
      op: "&&",
      left: { kind: "dynTest", test: "object", value: target, type: BOOL, loc },
      right: { kind: "dynTest", test: "null", negated: true, value: target, type: BOOL, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

/** Node's TypeError for a Reflect target that is not an object. */
function nonObjectThrow(member: string, type: IrType, loc: SrcLoc): IrExpr {
  return nodeThrowExpr(1, "", `Reflect.${member} called on non-object`, type, loc);
}

/** Evaluates `node` once into a hidden checked-dynamic local and runs
 * `operation` on it when it is an object, throwing `Reflect.<member>`'s
 * non-object TypeError otherwise. The same shape the member values use. */
function withObjectTarget(
  lowerer: Lowerer,
  member: string,
  node: ts.Expression,
  resultType: IrType,
  loc: SrcLoc,
  operation: (target: IrExpr) => IrExpr,
  prelude: IrStmt[] = [],
): IrExpr {
  const local = lowerer.declareHiddenLocal("%reflectTarget", DYN);
  const target = varRef(local.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: local.id,
        init: lowerer.lowerExprExpecting(node, DYN),
        loc,
      },
      ...prelude,
    ],
    result: {
      kind: "ternary",
      cond: isObjectTarget(target, loc),
      then: operation(target),
      else_: nonObjectThrow(member, resultType, loc),
      type: resultType,
      loc,
    },
    type: resultType,
    loc,
  };
}

/** The value the hidden actual-argument array holds at `index`, or undefined
 * past its length: a member value sees only the arguments its caller
 * passed, exactly like Node's own function. */
const actualArgument = (args: IrExpr, index: number, loc: SrcLoc): IrExpr => ({
  kind: "dynKeyGet",
  value: args,
  key: str(String(index), loc),
  type: DYN,
  loc,
});

/** How many arguments the caller actually passed (`arguments.length`); a
 * member whose receiver defaults only when the argument is ABSENT reads
 * this (`Reflect.get(t, k)` vs `Reflect.get(t, k, undefined)`). */
const actualArity = (args: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "dynCheck",
  value: { kind: "dynKeyGet", value: args, key: str("length", loc), type: DYN, loc },
  type: F64,
  loc,
});

const arityAtLeast = (args: IrExpr, count: number, loc: SrcLoc): IrExpr => ({
  kind: "bin",
  op: ">=",
  left: actualArity(args, loc),
  right: { kind: "numLit", value: count, type: F64, loc },
  type: BOOL,
  loc,
});

/** One Reflect member as a function value. `arguments` is the hidden
 * actual-argument array (argumentsAll), so the closure sees the arity its
 * caller used; `build` declares the locals it needs. The boxed value keeps
 * Node's name and length and stays checked-dynamic, so calls through it
 * convert arguments the way Node's own member function does. */
function reflectMemberFunction(
  lowerer: Lowerer,
  member: string,
  ret: IrType,
  length: number,
  loc: SrcLoc,
  build: (args: IrExpr, locals: IrLocal[]) => IrStmt[],
): IrExpr {
  const name = `%builtin.Reflect.${member}`;
  if (lowerer.liftedFnNamed(name) === undefined) {
    const locals: IrLocal[] = [{ id: "args", name: "args", type: DYN, mutable: false }];
    const body = build(varRef("args", DYN, loc), locals);
    lowerer.liftedFns.push({
      name,
      // The one parameter is the hidden actual-argument array (argumentsAll):
      // the member declares none, and reads every argument from it.
      params: [{ localId: "args", name: "args", type: DYN }],
      returnType: ret,
      locals,
      body,
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: [], ret, rest: true, argumentsAll: true },
      loc,
    },
    fnName: member,
    fnLength: length,
    type: DYN,
    loc,
  };
}

/** The function value of the Reflect member `member`, or null for the three
 * whose behavior has no faithful lowering yet (setPrototypeOf answers false
 * where Object.setPrototypeOf throws, defineProperty answers false for a
 * non-configurable member, and construct takes a new.target — each would
 * need runtime work, so they keep their call-time fence). */
export function reflectMemberValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr | null {
  const memberLocal = (locals: IrLocal[], ident: string, label: string): IrExpr => {
    locals.push({ id: ident, name: label, type: DYN, mutable: false });
    return varRef(ident, DYN, loc);
  };
  // The target check every guarded member shares, after reading argument 0.
  const guard = (target: IrExpr): IrStmt => ({
    kind: "if",
    cond: {
      kind: "unary",
      op: "!",
      operand: isObjectTarget(target, loc),
      type: BOOL,
      loc,
    },
    then: [{ kind: "exprStmt", expr: nonObjectThrow(member, VOID, loc), loc }],
    else_: null,
    loc,
  });
  switch (member) {
    case "isExtensible":
      // The handle-aware query: the target arrives untyped, so it may be a
      // native handle whose integrity the handle property table tracks (a
      // program that adds own properties to handles installs it). The plain
      // dyn.isExtensible entry answers false for every handle; the query
      // answers from the table, and refuses a handle whose integrity nothing
      // tracks, as Object.isExtensible does.
      return reflectMemberFunction(lowerer, member, BOOL, 1, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          guard(target),
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.isExtensibleQuery",
              args: [target],
              type: BOOL,
              loc,
            },
            loc,
          },
        ];
      });
    case "preventExtensions":
      // The member function can prevent extensions of any untyped value it
      // is passed, so the program keeps integrity words on untyped values
      // (as Object.freeze as a value does).
      lowerer.untypedIntegrity = true;
      return reflectMemberFunction(lowerer, member, BOOL, 1, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          guard(target),
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.preventExtensions",
              args: [target],
              type: DYN,
              loc,
            },
            loc,
          },
          { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
        ];
      });
    case "getOwnPropertyDescriptor":
      return reflectMemberFunction(lowerer, member, DYN, 2, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          guard(target),
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.getOwnPropertyDescriptor",
              args: [target, actualArgument(args, 1, loc)],
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      });
    case "has":
      return reflectMemberFunction(lowerer, member, BOOL, 2, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.reflectHasTarget",
              args: [target],
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.hasKeyComputed",
              args: [target, actualArgument(args, 1, loc)],
              type: BOOL,
              loc,
            },
            loc,
          },
        ];
      });
    case "deleteProperty":
      return reflectMemberFunction(lowerer, member, BOOL, 2, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.reflectDeleteProperty",
              args: [target, actualArgument(args, 1, loc)],
              type: BOOL,
              loc,
            },
            loc,
          },
        ];
      });
    case "get":
      return reflectMemberFunction(lowerer, member, DYN, 2, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        const receiver = memberLocal(locals, "r.0", "receiver");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          {
            kind: "varDecl",
            localId: "r.0",
            init: {
              kind: "ternary",
              cond: arityAtLeast(args, 3, loc),
              then: actualArgument(args, 2, loc),
              else_: target,
              type: DYN,
              loc,
            },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.reflectGet",
              args: [target, actualArgument(args, 1, loc), receiver],
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      });
    case "set":
      return reflectMemberFunction(lowerer, member, BOOL, 3, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        const receiver = memberLocal(locals, "r.0", "receiver");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          {
            kind: "varDecl",
            localId: "r.0",
            init: {
              kind: "ternary",
              cond: arityAtLeast(args, 4, loc),
              then: actualArgument(args, 3, loc),
              else_: target,
              type: DYN,
              loc,
            },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.reflectSet",
              args: [target, actualArgument(args, 1, loc), actualArgument(args, 2, loc), receiver],
              type: BOOL,
              loc,
            },
            loc,
          },
        ];
      });
    case "apply":
      // Node's order: the target must be callable, then the list must be an
      // object, and only then is the list read. The runtime entry of the
      // direct call builds the list from any array-like and calls the target
      // with the receiver as `this`; it takes a missing list as empty, which
      // is Function.prototype.apply's rule and not Reflect.apply's, so both
      // checks happen here.
      return reflectMemberFunction(lowerer, member, DYN, 3, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        const list = memberLocal(locals, "l.0", "list");
        const is = (test: "function" | "null" | "object" | "symbol", value: IrExpr): IrExpr => ({
          kind: "dynTest",
          test,
          value,
          type: BOOL,
          loc,
        });
        const throwTypeError = (message: IrExpr): IrStmt => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "error.nodeThrow",
            args: [{ kind: "numLit", value: 1, type: F64, loc }, str("", loc), message],
            type: VOID,
            loc,
          },
          loc,
        });
        const when = (cond: IrExpr, then: IrStmt[]): IrStmt => ({
          kind: "if",
          cond,
          then,
          else_: null,
          loc,
        });
        const not = (operand: IrExpr): IrExpr => ({
          kind: "unary",
          op: "!",
          operand,
          type: BOOL,
          loc,
        });
        const concat = (left: IrExpr, right: IrExpr): IrExpr => ({
          kind: "strConcat",
          left,
          right,
          type: STRING,
          loc,
        });
        const called = "Function.prototype.apply was called on ";
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          { kind: "varDecl", localId: "l.0", init: actualArgument(args, 2, loc), loc },
          when(not(is("function", target)), [
            when(is("null", target), [
              throwTypeError(str(`${called}null, which is null and not a function`, loc)),
            ]),
            // An object or a symbol: Node names it the way V8 prints a value
            // in a message (`#<Shelf>`, `[object Array]`), which nothing
            // here renders; the TypeError keeps the runtime's wording for a
            // receiver of Function.prototype.apply that is not callable.
            when(
              {
                kind: "logical",
                op: "||",
                left: is("object", target),
                right: is("symbol", target),
                type: BOOL,
                loc,
              },
              [throwTypeError(str(`${called}a non-callable value`, loc))],
            ),
            throwTypeError(
              concat(
                concat(
                  concat(
                    concat(str(called, loc), {
                      kind: "libCall",
                      fn: "dyn.toStringCoerce",
                      args: [target],
                      type: STRING,
                      loc,
                    }),
                    str(", which is a ", loc),
                  ),
                  { kind: "libCall", fn: "dyn.typeof", args: [target], type: STRING, loc },
                ),
                str(" and not a function", loc),
              ),
            ),
          ]),
          when(not(isObjectTarget(list, loc)), [
            throwTypeError(str("CreateListFromArrayLike called on non-object", loc)),
          ]),
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.reflectApply",
              args: [target, actualArgument(args, 1, loc), list],
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      });
    case "getPrototypeOf":
      // The direct call's two steps: Reflect's TypeError for a primitive
      // target, then the prototype edge of the checked-dynamic view.
      return reflectMemberFunction(lowerer, member, DYN, 1, loc, (args, locals) => {
        const target = memberLocal(locals, "t.0", "target");
        return [
          { kind: "varDecl", localId: "t.0", init: actualArgument(args, 0, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.reflectGetPrototypeTarget",
              args: [target],
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "return",
            value: { kind: "libCall", fn: "dyn.getPrototype", args: [target], type: DYN, loc },
            loc,
          },
        ];
      });
    case "ownKeys": {
      const value = lowerer.lowerNativeCallableValue(
        {
          fn: "dyn.ownKeys",
          params: [DYN],
          result: DYN,
          valueParams: [{ mode: "required", type: DYN }],
        },
        "Reflect.ownKeys",
        loc,
      )!;
      return { kind: "dynFrom", value, fnName: "ownKeys", type: DYN, loc };
    }
    default:
      return null;
  }
}

/** Object.getPrototypeOf / Reflect.getPrototypeOf (and their setPrototypeOf
 * twins) over a dyn-convertible value: the checked-dynamic prototype edge,
 * so a class instance, plain object, function or array all answer Node's
 * prototype of their boxed view. The identity-only flag marks a producer
 * the runtime can answer without materializing the prototype (a `===`).
 * Null when the value has no checked-dynamic form (the caller's fence). */
export function lowerPrototypeReflectionCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "getPrototypeOf" | "setPrototypeOf",
  loc: SrcLoc,
  rejectPrimitiveTarget = false,
): IrExpr | null {
  let object = lowerer.lowerExpr(call.arguments.nodes[0]!);
  // The runtime's getPrototypeOf refuses a built-in constructor's function
  // value when it runs (another function answers once the program has set
  // its prototype): the build names the statement (SC6015).
  if (
    member === "getPrototypeOf" &&
    (object.type.kind === "func" || object.type.kind === "dyn") &&
    lowerer.holdsBuiltinConstructor(call.arguments.nodes[0]!)
  )
    lowerer.noteDeferredRefusal(
      call,
      "Object.getPrototypeOf of a held built-in constructor is not supported yet",
      "ask `typeof value` where the question is whether the value is a function",
    );
  if (object.type.kind === "func") {
    const fnName = jsFuncNameOf(call.arguments.nodes[0]!, lowerer);
    object = {
      kind: "dynFrom",
      value: object,
      type: DYN,
      loc,
      ...(fnName !== null ? { fnName } : {}),
    };
  }
  // A JavaScript source asks about a native Set, Map, WeakMap or WeakSet:
  // the runtime answers %<Class>.prototype% so Symbol.toStringTag and the
  // prototype's methods are reachable (a typed source keeps the refusal
  // below). The weak collections live in checked-dynamic storage, so their
  // argument is already a dynamic handle; the runtime dispatches on it.
  if (
    member === "getPrototypeOf" &&
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    (object.type.kind === "set" ||
      object.type.kind === "map" ||
      (object.type.kind === "dyn" &&
        lowerer.weakCollectionNamesOf(lowerer.typeOf(call.arguments.nodes[0]!)) !== null))
  ) {
    const boxed = lowerer.coerceInto(call.arguments.nodes[0]!, object, DYN);
    if (boxed.type.kind === "dyn")
      return { kind: "libCall", fn: "dyn.collectionGetPrototype", args: [boxed], type: DYN, loc };
  }
  if (
    object.type.kind !== "dyn" &&
    canConvertToDyn(
      object.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    object = lowerer.coerceInto(call.arguments.nodes[0]!, object, DYN);
  if (object.type.kind !== "dyn") return null;
  if (member === "getPrototypeOf") {
    let parent: ts.Node | undefined = call.parent;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    const identityOnly =
      !!parent &&
      ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        parent.operatorToken.kind,
      );
    const answer: IrExpr = {
      kind: "libCall",
      fn: "dyn.getPrototype",
      args: [object],
      type: DYN,
      loc,
      ...(identityOnly ? { prototypeIdentityOnly: true as const } : {}),
    };
    if (!rejectPrimitiveTarget) return answer;
    // Reflect.getPrototypeOf rejects every primitive target with its own
    // TypeError, where Object.getPrototypeOf boxes it: the target is bound
    // once and checked before the prototype edge is read.
    const targetLocal = lowerer.declareHiddenLocal("%reflectProtoTarget", DYN);
    const targetRef = varRef(targetLocal.id, DYN, loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: targetLocal.id, init: object, loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.reflectGetPrototypeTarget",
            args: [targetRef],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      result: { ...answer, args: [targetRef] },
      type: DYN,
      loc,
    };
  }
  const prototype = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
  if (prototype.type.kind !== "dyn") return null;
  return { kind: "libCall", fn: "dyn.setPrototype", args: [object, prototype], type: DYN, loc };
}

/** Reflect.ownKeys uses native computed-key reflection. Reflect.apply(target,
 * thisArg, argsList) where the TARGET is a builtin
 * rest-parameter table fn (path.join / path.resolve — test/common
 * fixtures.js's fixturesPath forwards its rest args exactly this way):
 * the packed libCall over a validated string[] extraction of argsList.
 * The builtins ignore the receiver, so thisArg must be an effect-free
 * spelling (`this`, an identifier, a unit literal) whose dropped
 * evaluation is unobservable; every other Reflect.apply keeps the
 * fence. Null when this isn't a supported Reflect call. */
export function lowerReflectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    !call.questionDotToken &&
    !access.questionDotToken &&
    lowerer.stdlibGlobalMember(access, "Reflect") === "ownKeys" &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    return {
      kind: "libCall",
      fn: "dyn.ownKeys",
      args: [lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN)],
      type: DYN,
      loc: locOf(call),
    };
  }
  if (call.questionDotToken) return null;
  const reflectMember = lowerer.stdlibGlobalMember(access, "Reflect");
  // Reflect.getPrototypeOf(target) — the prototype object of the target's
  // checked-dynamic view, exactly Object.getPrototypeOf's answer.
  if (
    reflectMember === "getPrototypeOf" &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    return lowerPrototypeReflectionCall(lowerer, call, "getPrototypeOf", locOf(call), true);
  }
  // Reflect.isExtensible / preventExtensions over an object target: the
  // Object operation, behind Reflect's non-object TypeError.
  // preventExtensions answers Node's boolean rather than the runtime's
  // object.
  if (
    (reflectMember === "isExtensible" || reflectMember === "preventExtensions") &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    const target = call.arguments.nodes[0]!;
    if (reflectMember === "isExtensible")
      return withObjectTarget(lowerer, reflectMember, target, BOOL, locOf(call), (object) => ({
        kind: "libCall",
        // The target is a checked-dynamic value, so the handle-aware query
        // answers a native handle from the handle property table (and
        // refuses one nothing tracks) instead of the plain entry's false for
        // every handle.
        fn: "dyn.isExtensibleQuery",
        args: [object],
        type: BOOL,
        loc: locOf(call),
      }));
    // The target can be any untyped value the program holds, so hierarchies
    // reachable that way keep integrity words (as Object.preventExtensions's
    // untyped form does).
    noteUntypedIntegrity(lowerer, target);
    return withObjectTarget(lowerer, reflectMember, target, BOOL, locOf(call), (object) => ({
      kind: "seqExpr",
      stmts: [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.preventExtensions",
            args: [object],
            type: DYN,
            loc: locOf(call),
          },
          loc: locOf(call),
        },
      ],
      result: { kind: "boolLit", value: true, type: BOOL, loc: locOf(call) },
      type: BOOL,
      loc: locOf(call),
    }));
  }
  // Reflect.has(target, key) — the `in` operator's presence query over
  // the target's checked-dynamic view (own and inherited names, proxy
  // `has` traps included). A primitive target is Node's TypeError
  // ("Reflect.has called on non-object"): a statically primitive target
  // is refused, and a target held as any, unknown or a union is checked
  // at run time (dyn.reflectHasTarget).
  if (
    reflectMember === "has" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const loc = locOf(call);
    // The global object answers `in` through its own presence query
    // (lowerInGlobalObject): Reflect.has is the same question.
    {
      const inGlobal = lowerInGlobalObject(
        lowerer,
        call.arguments.nodes[1]!,
        call.arguments.nodes[0]!,
        loc,
      );
      if (inGlobal !== null) return inGlobal;
    }
    const target = lowerer.lowerExpr(call.arguments.nodes[0]!);
    const primitive =
      isUnitType(target.type) ||
      ["bool", "f64", "string", "bigint", "symbol"].includes(target.type.kind);
    if (primitive)
      lowerer.noLowering(
        "Reflect.has on a primitive target",
        call.arguments.nodes[0]!,
        "Node throws a TypeError for a primitive target; narrow to an object first",
      );
    if (!lowerer.dynConvertible(target.type))
      lowerer.noLowering("Reflect.has on this target", call.arguments.nodes[0]!);
    const key = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
    if (target.type.kind !== "dyn" && target.type.kind !== "union") {
      return {
        kind: "libCall",
        fn: "dyn.hasKeyComputed",
        args: [lowerer.coerceToExpected(target, DYN), key],
        type: BOOL,
        loc,
      };
    }
    // A target held as any, unknown or a union may be a primitive at run
    // time: both arguments are evaluated, then the target is checked.
    const targetLocal = lowerer.declareHiddenLocal("%reflectHasTarget", DYN);
    const keyLocal = lowerer.declareHiddenLocal("%reflectHasKey", DYN);
    const targetRef = varRef(targetLocal.id, DYN, loc);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: targetLocal.id,
          init: lowerer.coerceToExpected(target, DYN),
          loc,
        },
        { kind: "varDecl", localId: keyLocal.id, init: key, loc },
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.reflectHasTarget", args: [targetRef], type: VOID, loc },
          loc,
        },
      ],
      result: {
        kind: "libCall",
        fn: "dyn.hasKeyComputed",
        args: [targetRef, varRef(keyLocal.id, DYN, loc)],
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  // Reflect.getOwnPropertyDescriptor over checked objects: the Object
  // operation behind Reflect's non-object TypeError (where the Object form
  // boxes a primitive, this one throws).
  if (
    reflectMember === "getOwnPropertyDescriptor" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const loc = locOf(call);
    const key = lowerer.declareHiddenLocal("%reflectKey", DYN);
    return withObjectTarget(
      lowerer,
      reflectMember,
      call.arguments.nodes[0]!,
      DYN,
      loc,
      (target) => ({
        kind: "libCall",
        fn: "dyn.getOwnPropertyDescriptor",
        args: [target, varRef(key.id, DYN, loc)],
        type: DYN,
        loc,
      }),
      [
        {
          kind: "varDecl",
          localId: key.id,
          init: lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN),
          loc,
        },
      ],
    );
  }
  // Reflect.defineProperty over checked objects (execa's Promise mixin):
  // the Object operation, with defineProperty answering true.
  if (reflectMember === "defineProperty" && call.arguments.nodes.length === 3) {
    if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
    const loc = locOf(call);
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.defineProperty", args, type: DYN, loc },
          loc,
        },
      ],
      result: { kind: "boolLit", value: true, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  // Reflect.deleteProperty over a value with a live property table: a
  // checked-dynamic value, or a JavaScript class whose statics are runtime
  // properties of its constructor
  // (`Reflect.deleteProperty(Response, "getResponseState")`).
  if (
    reflectMember === "deleteProperty" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const loc = locOf(call);
    let target = lowerer.lowerExpr(call.arguments.nodes[0]!);
    const info =
      target.type.kind === "classval" ? lowerer.classes.get(target.type.className) : undefined;
    // A primitive target throws the TypeError, so it boxes as is.
    const primitive =
      isUnitType(target.type) ||
      ["bool", "f64", "string", "bigint", "symbol"].includes(target.type.kind);
    if (
      primitive ||
      (info !== undefined && hasRuntimeStatics(info) && lowerer.dynConvertible(target.type))
    )
      target = lowerer.coerceToExpected(target, DYN);
    if (target.type.kind !== "dyn") return null;
    return {
      kind: "libCall",
      fn: "dyn.reflectDeleteProperty",
      args: [target, lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN)],
      type: BOOL,
      loc,
    };
  }
  if (reflectMember === "get" || reflectMember === "set") {
    const required = reflectMember === "get" ? 2 : 3;
    if (
      call.arguments.nodes.length < required ||
      call.arguments.nodes.length > required + 1 ||
      call.arguments.nodes.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `Reflect.${reflectMember} with this argument shape`,
        call,
        `use Reflect.${reflectMember}(target, key${reflectMember === "set" ? ", value" : ""}, receiver?)`,
      );
    }
    const loc = locOf(call);
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    const target =
      call.arguments.nodes.length === required
        ? lowerer.declareHiddenLocal("%reflectTarget", DYN)
        : null;
    const operation: IrExpr = {
      kind: "libCall",
      fn: reflectMember === "get" ? "dyn.reflectGet" : "dyn.reflectSet",
      args: target
        ? [varRef(target.id, DYN, loc), ...args.slice(1), varRef(target.id, DYN, loc)]
        : args,
      type: reflectMember === "get" ? DYN : BOOL,
      loc,
    };
    return target
      ? {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: target.id, init: args[0]!, loc }],
          result: operation,
          type: operation.type,
          loc,
        }
      : operation;
  }
  if (lowerer.stdlibGlobalMember(access, "Reflect") !== "apply") return null;
  const loc = locOf(call);
  const fenceHint =
    "the lowered form is Reflect.apply(path.join | path.resolve, <effect-free this>, args) — call other functions directly (f(...args))";
  if (call.arguments.nodes.length !== 3 || call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering("Reflect.apply with this argument shape", call, fenceHint);
  }
  const targetNode = call.arguments.nodes[0]!;
  const bi = ts.isPropertyAccessExpression(targetNode) ? lowerer.builtinMemberOf(targetNode) : null;
  const fn = bi ? builtinModuleFnOf(lowerer, bi.module, bi.member) : null;
  if (!fn || fn.variadicPack !== true) {
    const target = lowerer.lowerExprExpecting(targetNode, DYN);
    const receiver = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
    const argumentsList = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, DYN);
    return {
      kind: "libCall",
      fn: "dyn.reflectApply",
      args: [target, receiver, argumentsList],
      type: DYN,
      loc,
    };
  }
  const thisNode = call.arguments.nodes[1]!;
  const effectFree =
    thisNode.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isIdentifier(thisNode) ||
    thisNode.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(thisNode) && thisNode.text === "undefined");
  if (!effectFree) {
    lowerer.noLowering(
      "Reflect.apply with a computed thisArg",
      thisNode,
      "the target ignores its receiver, so only effect-free spellings drop honestly (`this`, a binding, null, undefined)",
    );
  }
  const packed = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, arrayOf(STRING));
  return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
}
