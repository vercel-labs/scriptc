import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  SYMBOL_T,
  isUnitType,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import {
  classMemberNameOf,
  classValueRef,
  exactClassOfReceiver,
  storedClassValueType,
  findGenericMethodOn,
  findMethodOn,
  type ClassInfo,
} from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";
import { newFnCtx } from "./lowerer.js";
import { classMethodValue } from "./class-method-values.js";

/** Data added to a top-level class prototype has shared identity and remains
 * separate from instance fields. Allocate lazily so inheritance and module
 * initialization order do not require hoisting source assignments. */
export function classPrototypeData(
  lowerer: Lowerer,
  info: ClassInfo,
  loc: SrcLoc,
  receiver?: IrExpr,
  metadataOnly = false,
): IrExpr | null {
  if (info.localClass) {
    if (!receiver) return null;
    info.localPrototypeData = true;
    const value: IrExpr =
      receiver.type.kind === "classval"
        ? receiver
        : {
            kind: "fieldGet",
            obj: receiver,
            className: info.def.name,
            field: `%classEnvironment:${info.def.name}`,
            type: { kind: "classval", className: info.def.name },
            loc,
          };
    const base: IrExpr | null = info.callableBase
      ? {
          kind: "libCall",
          fn: "dyn.classBasePrototype",
          args: [
            {
              kind: "libCall",
              fn: "dyn.getPrototype",
              args: [{ kind: "dynFrom", value, type: DYN, loc }],
              type: DYN,
              loc,
            },
          ],
          type: DYN,
          loc,
        }
      : info.base && !info.base.builtinError
        ? classPrototypeData(lowerer, info.base, loc, {
            kind: "dynCheck",
            value: {
              kind: "libCall",
              fn: "dyn.getPrototype",
              args: [{ kind: "dynFrom", value, type: DYN, loc }],
              type: DYN,
              loc,
            },
            type: { kind: "classval", className: info.base.def.name },
            loc,
          })
        : null;
    return {
      kind: "libCall",
      fn: "dyn.classPrototype",
      args: [{ kind: "dynFrom", value, type: DYN, loc }, base ?? dynUndefinedExpr(loc)],
      type: DYN,
      loc,
    };
  }
  if (
    info.mixinInstance ||
    info.generic ||
    info.genericInstance ||
    info.def.runtime ||
    info.builtinEmitter ||
    info.builtinStream ||
    info.builtinError
  )
    return null;
  if (info.def.prototypeDataHelper === undefined) {
    const base = info.callableBase
      ? varRef(info.callableBase.prototypeId, DYN, loc)
      : info.base && !info.base.builtinError
        ? classPrototypeData(
            lowerer,
            info.base,
            loc,
            info.def.baseValueGlobal
              ? varRef(
                  info.def.baseValueGlobal,
                  { kind: "classval", className: info.base.def.name },
                  loc,
                )
              : undefined,
            metadataOnly,
          )
        : null;
    if (info.base && !info.base.builtinError && base === null) return null;
    const name = `%prototype.data.${info.def.name}`;
    const globalId = `%g.${name}`;
    const readyId = `${globalId}.ready`;
    info.def.prototypeDataHelper = name;
    const className = info.def.jsName ?? info.def.name;
    lowerer.globalsList.push({
      id: globalId,
      name: `${className}.prototype`,
      type: DYN,
      mutable: true,
    });
    lowerer.globalsList.push({
      id: readyId,
      name: `${className}.prototype.ready`,
      type: BOOL,
      mutable: true,
    });
    const value = varRef(globalId, DYN, loc);
    const helper: IrFunction = {
      name,
      params: [],
      returnType: DYN,
      locals: [],
      loc,
      speculativeDispatch: true,
      body: [
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(readyId, BOOL, loc), type: BOOL, loc },
          then: [
            {
              kind: "assign",
              localId: globalId,
              value: base
                ? { kind: "libCall", fn: "dyn.objCreate", args: [base], type: DYN, loc }
                : { kind: "dynObjLit", fields: [], type: DYN, loc },
              loc,
            },
            {
              kind: "assign",
              localId: readyId,
              value: { kind: "boolLit", value: true, type: BOOL, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        { kind: "return", value, loc },
      ],
    };
    lowerer.liftedFns.push(helper);
  }
  if (!metadataOnly && !info.prototypeObservedMethodsReady) {
    info.prototypeObservedMethodsReady = true;
    const helper = lowerer.liftedFns.find((fn) => fn.name === info.def.prototypeDataHelper)!;
    const value = varRef(`%g.${info.def.prototypeDataHelper}`, DYN, loc);
    // Materialize only observed method slots. Own declarations stop lookup
    // at the correct prototype even if an ancestor is replaced later. An
    // abstract declaration emits no prototype member in JavaScript, so it
    // gets no slot: lookup continues to the ancestors, and the concrete
    // descendants' prototypes carry the implementations.
    for (const [method, access] of lowerer.prototypeMethodAccesses) {
      if (
        !info.methods.has(method) ||
        info.methods.get(method)?.abstract ||
        method.startsWith("get:") ||
        method.startsWith("set:")
      )
        continue;
      const compiled = classMethodValue(lowerer, access, info, method, locOf(access));
      if (!compiled) continue;
      const descriptor: IrExpr = {
        kind: "dynObjLit",
        fields: [
          {
            key: { kind: "strLit", value: "value", type: STRING, loc },
            value: lowerer.coerceToExpected(compiled, DYN),
          },
          {
            key: { kind: "strLit", value: "writable", type: STRING, loc },
            value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc }, DYN),
          },
          {
            key: { kind: "strLit", value: "configurable", type: STRING, loc },
            value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc }, DYN),
          },
        ],
        type: DYN,
        loc,
      };
      const init = helper.body[0]!;
      if (init.kind === "if")
        init.then.push({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.defineProperty",
            args: [
              value,
              lowerer.coerceToExpected({ kind: "strLit", value: method, type: STRING, loc }, DYN),
              descriptor,
            ],
            type: DYN,
            loc,
          },
          loc,
        });
    }
  }
  return { kind: "call", callee: info.def.prototypeDataHelper, args: [], type: DYN, loc };
}

export function hasClassPrototypeData(info: ClassInfo): boolean {
  return (
    info.callableBase !== undefined ||
    info.localPrototypeData === true ||
    info.def.prototypeDataHelper !== undefined ||
    (info.base !== null && hasClassPrototypeData(info.base))
  );
}

/** Populate the shared prototype view before exposing it to reflection.
 * Methods and accessors are non-enumerable and retain declaration identity. */
export function reflectClassPrototype(
  lowerer: Lowerer,
  info: ClassInfo,
  loc: SrcLoc,
  receiver: IrExpr,
): IrExpr | null {
  const prototype = classPrototypeData(lowerer, info, loc, receiver);
  if (!prototype || !info.decl) return prototype;
  const refuse = (message: string): IrExpr => {
    const name = `%prototype.refusal:${info.def.name}`;
    if (!lowerer.liftedFns.some((fn) => fn.name === name))
      lowerer.liftedFns.push({
        name,
        params: [],
        locals: [],
        returnType: DYN,
        body: [{ kind: "runtimeFence", code: "SC1090", message, loc }],
        loc,
      });
    info.prototypeReflectionRefusal = name;
    return { kind: "call", callee: name, args: [], type: DYN, loc };
  };
  if (info.prototypeReflectionRefusal)
    return { kind: "call", callee: info.prototypeReflectionRefusal, args: [], type: DYN, loc };
  // Local JavaScript factories initialize captured prototype members on
  // their constructor value, so the shared runtime view is already complete.
  if (info.localClass && info.runtimePrototypeMembers) return prototype;
  if (info.localClass)
    return refuse("prototype reflection on a function-local class is not supported yet");
  if (info.base && !info.base.builtinError) {
    reflectClassPrototype(
      lowerer,
      info.base,
      loc,
      info.def.baseValueGlobal
        ? varRef(info.def.baseValueGlobal, { kind: "classval", className: info.base.def.name }, loc)
        : receiver,
    );
    if (info.base.prototypeReflectionRefusal)
      return refuse("prototype reflection with this base class is not supported yet");
  }
  const helper = lowerer.liftedFns.find((fn) => fn.name === info.def.prototypeDataHelper);
  const initialization = helper?.body[0];
  if (!helper || initialization?.kind !== "if" || info.prototypeReflectionReady) return prototype;
  info.prototypeReflectionReady = true;
  // Earlier method or JSON views may have installed only observed slots.
  // Rebuild them in declaration order when the entire prototype is exposed.
  // Lowering passes may have rebuilt these statements, so match their
  // operation instead of relying on the original statement's identity.
  initialization.then = initialization.then.filter(
    (statement) =>
      !(
        statement.kind === "exprStmt" &&
        ((statement.expr.kind === "libCall" && statement.expr.fn === "dyn.defineProperty") ||
          (statement.expr.kind === "call" && statement.expr.callee === "%dyn.class.defineProperty"))
      ),
  );
  const define = (key: IrExpr, fields: { key: string; value: IrExpr }[]): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        prototype,
        lowerer.coerceToExpected(key, DYN),
        {
          kind: "dynObjLit",
          fields: [
            ...fields,
            {
              key: "configurable",
              value: { kind: "boolLit" as const, value: true, type: BOOL, loc },
            },
          ].map((field) => ({
            key: { kind: "strLit", value: field.key, type: STRING, loc },
            value: lowerer.coerceToExpected(field.value, DYN),
          })),
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    },
    loc,
  });
  const writable = {
    key: "writable",
    value: { kind: "boolLit", value: true, type: BOOL, loc } as IrExpr,
  };
  initialization.then.push(
    define({ kind: "strLit", value: "constructor", type: STRING, loc }, [
      { key: "value", value: classValueRef(lowerer, info, info.decl) },
      writable,
    ]),
  );
  const context = newFnCtx(false, null, null, DYN);
  lowerer.fnStack.push(context);
  try {
    for (const member of info.decl.members) {
      if (
        (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) ||
        !member.body ||
        ts.isPrivateIdentifier(member.name) ||
        ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
      )
        continue;
      const name = classMemberNameOf(lowerer, member.name);
      if (name === null)
        return refuse(
          "prototype reflection with an unresolved computed member is not supported yet",
        );
      const method = ts.isMethodDeclaration(member)
        ? name
        : `${ts.isGetAccessor(member) ? "get" : "set"}:${name}`;
      const value = classMethodValue(lowerer, info.decl, info, method, loc);
      if (!value || !lowerer.dynConvertible(value.type))
        return refuse(
          "prototype reflection with a member that cannot cross a checked value boundary is not supported yet",
        );
      const key: IrExpr = ts.isComputedPropertyName(member.name)
        ? lowerer.lowerExpr(member.name.expression)
        : { kind: "strLit", value: member.name.text, type: STRING, loc };
      initialization.then.push(
        define(
          key,
          ts.isMethodDeclaration(member)
            ? [{ key: "value", value }, writable]
            : [{ key: ts.isGetAccessor(member) ? "get" : "set", value }],
        ),
      );
    }
  } finally {
    helper.locals.push(...context.locals);
    lowerer.fnStack.pop();
  }
  return prototype;
}

export function isCompiledPrototypeMember(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
): boolean {
  return (
    name === "constructor" ||
    name === "__proto__" ||
    !!findMethodOn(lowerer, info, name) ||
    !!findGenericMethodOn(lowerer, info, name) ||
    !!findMethodOn(lowerer, info, `get:${name}`) ||
    !!findMethodOn(lowerer, info, `set:${name}`)
  );
}

/** Named data and method slots have native descriptors. Bare reflection and
 * accessor replacement still require a complete view of the prototype. */
export function lowerClassPrototypeData(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "prototype") return null;
  const stored = storedClassValueType(lowerer, expr.expression);
  const info =
    exactClassOfReceiver(lowerer, expr.expression) ??
    (stored?.kind === "classval" ? lowerer.classes.get(stored.className) : undefined);
  if (!info) return null;
  const parent = expr.parent;
  const descriptorKey =
    ts.isCallExpression(parent) &&
    parent.arguments[0] === expr &&
    ts.isPropertyAccessExpression(parent.expression) &&
    lowerer.stdlibGlobalMember(parent.expression, "Object") === "defineProperty" &&
    parent.arguments[1] &&
    ts.isStringLiteral(parent.arguments[1])
      ? parent.arguments[1].text
      : null;
  const name =
    ts.isPropertyAccessExpression(parent) && parent.expression === expr
      ? parent.name.text
      : ts.isElementAccessExpression(parent) &&
          parent.expression === expr &&
          parent.argumentExpression &&
          ts.isStringLiteral(parent.argumentExpression)
        ? parent.argumentExpression.text
        : descriptorKey;
  const method =
    name !== null && lowerer.prototypeMethodAccesses.has(name) && findMethodOn(lowerer, info, name);
  if (name === "constructor") {
    return reflectClassPrototype(lowerer, info, locOf(expr), classValueRef(lowerer, info, expr));
  }
  if (name === null || (isCompiledPrototypeMember(lowerer, info, name) && !method)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "class prototype reflection and accessor replacement (named prototype data and methods compile)",
    );
  }
  const value = classPrototypeData(
    lowerer,
    info,
    locOf(expr),
    info.localClass
      ? lowerer.lowerExprExpecting(expr.expression, { kind: "classval", className: info.def.name })
      : undefined,
  );
  if (value === null)
    lowerer.unsupported(
      "SC1090",
      expr,
      "prototype data on local, generic, mixin, or runtime-provided classes",
    );
  return value;
}

/** Object.assign may add data without exposing an incomplete prototype view.
 * The runtime refuses replacement of compiled members at the individual Set. */
export function lowerClassPrototypeAssign(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const target = call.arguments[0];
  if (!target || !ts.isPropertyAccessExpression(target) || target.name.text !== "prototype")
    return null;
  const info = exactClassOfReceiver(lowerer, target.expression);
  if (!info) return null;
  if (!ts.isExpressionStatement(call.parent) || call.arguments.some(ts.isSpreadElement)) {
    lowerer.unsupported("SC1090", call, "class prototype assignment results and spread arguments");
  }
  const loc = locOf(call);
  const value = classPrototypeData(
    lowerer,
    info,
    loc,
    info.localClass
      ? lowerer.lowerExprExpecting(target.expression, {
          kind: "classval",
          className: info.def.name,
        })
      : undefined,
  );
  if (!value)
    lowerer.unsupported(
      "SC1090",
      target,
      "prototype data on generic, mixin, or runtime-provided classes",
    );
  const sources = call.arguments.slice(1).map((node) => lowerer.lowerExprExpecting(node, DYN));
  return {
    kind: "libCall",
    fn: "dyn.assignPrototype",
    args: [
      value,
      { kind: "dynArrLit", elems: sources, type: DYN, loc },
      prototypeProtectedKeys(lowerer, info, target, loc),
    ],
    type: DYN,
    loc,
  };
}

function prototypeProtectedKeys(
  lowerer: Lowerer,
  info: ClassInfo,
  target: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const keys: IrExpr[] = ["constructor", "__proto__"].map((name) => ({
    kind: "strLit",
    value: name,
    type: STRING,
    loc,
  }));
  for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
    const methodNames = new Set([...owner.methods.keys()]);
    if (owner.genericMethods)
      for (const name of [...owner.genericMethods.keys()]) methodNames.add(name);
    for (const name of methodNames) {
      if (name.startsWith("#")) continue;
      // Error.toString uses checked native dispatch, including prototype
      // additions. A user-declared method remains protected below.
      if (owner.builtinError && name === "toString") continue;
      if (name.startsWith("sym:")) {
        keys.push({
          kind: "libCall",
          fn: "sym.wellKnown",
          args: [{ kind: "strLit", value: name.slice(4), type: STRING, loc }],
          type: SYMBOL_T,
          loc,
        });
      } else if (name.startsWith("%symbol:")) {
        const entries: [ts.Symbol, string][] = owner.symbolMethods ? [...owner.symbolMethods] : [];
        const entry = entries.find(([, field]) => field === name);
        const declaration = entry ? lowerer.checker.valueDeclarationOf(entry[0]) : undefined;
        if (
          !declaration ||
          !ts.isVariableDeclaration(declaration) ||
          !ts.isIdentifier(declaration.name)
        )
          lowerer.unsupported(
            "SC1090",
            target,
            "prototype mutation with unresolved symbol methods",
          );
        keys.push(lowerer.lowerExpr(declaration.name));
      } else
        keys.push({ kind: "strLit", value: name.replace(/^(get|set):/, ""), type: STRING, loc });
    }
  }
  return {
    kind: "dynArrLit",
    elems: keys.map((key) =>
      key.type.kind === "dyn" ? key : { kind: "dynFrom", value: key, type: DYN, loc },
    ),
    type: DYN,
    loc,
  };
}

/** Computed additions share the prototype bag without exposing or replacing
 * native method slots. Preserve reference/RHS evaluation and assignment value. */
export function lowerClassPrototypeComputedAssignment(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const target = expr.left;
  if (
    !ts.isElementAccessExpression(target) ||
    !ts.isPropertyAccessExpression(target.expression) ||
    target.expression.name.text !== "prototype"
  )
    return null;
  const prototypeNode = target.expression;
  const info = exactClassOfReceiver(lowerer, prototypeNode.expression);
  if (!info) return null;
  const loc = locOf(expr);
  const prototype = classPrototypeData(
    lowerer,
    info,
    loc,
    info.localClass
      ? lowerer.lowerExprExpecting(prototypeNode.expression, {
          kind: "classval",
          className: info.def.name,
        })
      : undefined,
  );
  if (!prototype)
    lowerer.unsupported(
      "SC1090",
      target,
      "prototype data on generic, mixin, or runtime-provided classes",
    );
  const receiver = lowerer.declareHiddenLocal("%prototypeReceiver", DYN);
  const key = lowerer.declareHiddenLocal("%prototypeKey", DYN);
  const raw = lowerer.lowerExpr(expr.right);
  const value =
    raw.type.kind === "void"
      ? {
          kind: "seqExpr" as const,
          stmts: [{ kind: "exprStmt" as const, expr: raw, loc }],
          result: dynUndefinedExpr(loc),
          type: DYN,
          loc,
        }
      : isUnitType(raw.type)
        ? lowerer.coerceInto(expr.right, raw, DYN)
        : raw;
  const assigned = lowerer.declareHiddenLocal("%prototypeValue", value.type);
  const result = varRef(assigned.id, value.type, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: prototype, loc },
      {
        kind: "varDecl",
        localId: key.id,
        init: lowerer.lowerExprExpecting(target.argumentExpression, DYN),
        loc,
      },
      { kind: "varDecl", localId: assigned.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.assignPrototype",
          args: [
            varRef(receiver.id, DYN, loc),
            {
              kind: "dynArrLit",
              elems: [
                {
                  kind: "dynObjLit",
                  fields: [
                    {
                      key: varRef(key.id, DYN, loc),
                      value: lowerer.coerceInto(expr.right, result, DYN),
                    },
                  ],
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            },
            prototypeProtectedKeys(lowerer, info, prototypeNode, loc),
          ],
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    result,
    type: result.type,
    loc,
  };
}

export function lowerClassPrototypeDescriptors(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
): IrExpr | null {
  const target = call.arguments[0];
  if (
    member !== "defineProperties" ||
    call.arguments.length !== 2 ||
    call.arguments.some(ts.isSpreadElement) ||
    !target ||
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== "prototype"
  )
    return null;
  const info = exactClassOfReceiver(lowerer, target.expression);
  if (!info) return null;
  const loc = locOf(call);
  const prototype = classPrototypeData(
    lowerer,
    info,
    loc,
    info.localClass
      ? lowerer.lowerExprExpecting(target.expression, {
          kind: "classval",
          className: info.def.name,
        })
      : undefined,
  );
  if (!prototype)
    lowerer.unsupported(
      "SC1090",
      target,
      "prototype data on generic, mixin, or runtime-provided classes",
    );
  return {
    kind: "libCall",
    fn: "dyn.definePrototypeProps",
    args: [
      prototype,
      lowerer.lowerExprExpecting(call.arguments[1]!, DYN),
      prototypeProtectedKeys(lowerer, info, target, loc),
    ],
    type: DYN,
    loc,
  };
}
