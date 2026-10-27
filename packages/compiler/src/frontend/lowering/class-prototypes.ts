import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { builtinClassKind, builtinClassValue } from "./builtins/builtin-class-dyn.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  SYMBOL_T,
  VOID,
  isUnitType,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
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
import { PoisonError, newFnCtx } from "./lowerer.js";
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
    lowerer.shareHelper(name);
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
            // util.inspect prints an instance with its class's name.
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "dyn.nameClassPrototype",
                args: [value, { kind: "strLit", value: className, type: STRING, loc }],
                type: VOID,
                loc,
              },
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
    const helper = lowerer.liftedFnNamed(info.def.prototypeDataHelper)!;
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
      // A method value without a checked-dynamic form (an async method's
      // promise-returning signature) gets no data slot.
      const boxedValue = lowerer.coerceToExpected(compiled, DYN);
      if (boxedValue.type.kind !== "dyn") continue;
      const originalId = `%g.${info.def.prototypeDataHelper}.original.${method}`;
      lowerer.globalsList.push({
        id: originalId,
        name: `${info.def.jsName ?? info.def.name}.prototype.${method}.original`,
        type: DYN,
        mutable: true,
      });
      info.prototypeOriginals ??= new Map();
      info.prototypeOriginals.set(method, originalId);
      const descriptor: IrExpr = {
        kind: "dynObjLit",
        fields: [
          {
            key: { kind: "strLit", value: "value", type: STRING, loc },
            value: varRef(originalId, DYN, loc),
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
        init.then.push({ kind: "assign", localId: originalId, value: boxedValue, loc });
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

/** Whether reads of method `name` on instances of `info` use the observed
 * prototype slot: the census marked the name and the class has prototype
 * data that holds the method. Classes without prototype data (generic
 * instantiations, mixins and their subclasses) and function-local classes
 * check for the property and otherwise use the declared method. */
export function observedPrototypeMethod(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  loc: SrcLoc,
  receiver?: IrExpr,
): boolean {
  if (!lowerer.prototypeMethodAccesses.has(name)) return false;
  // Building the data also marks a function-local class whose instances
  // need it. That class value's prototype holds only methods the program
  // replaced there, so its reads check for the key (own or inherited) and
  // otherwise use the declared method.
  const data = classPrototypeData(lowerer, info, loc, receiver);
  return data !== null && info.localClass === undefined;
}

export function hasClassPrototypeData(info: ClassInfo): boolean {
  return (
    info.callableBase !== undefined ||
    info.localPrototypeData === true ||
    info.def.prototypeDataHelper !== undefined ||
    (info.base !== null && hasClassPrototypeData(info.base))
  );
}

/** Methods and accessors that live on the class's prototype. */
function declaresPrototypeMembers(decl: ts.ClassLikeDeclaration): boolean {
  return decl.members.nodes.some(
    (member) =>
      (ts.isMethodDeclaration(member) || ts.isAccessor(member)) &&
      !ts.isPrivateIdentifier(member.name) &&
      !ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
  );
}

/** The global that is true once the class's prototype view has been
 * populated by reflection (reflectClassPrototype): the view then holds an
 * own `constructor` unless the program deleted it. A view that was never
 * reflected leaves `constructor` implicit. */
export function prototypeReflectedFlag(lowerer: Lowerer, info: ClassInfo): string {
  if (info.prototypeReflectedFlag) return info.prototypeReflectedFlag;
  const id = `%g.%prototype.data.${info.def.name}.reflected`;
  lowerer.globalsList.push({
    id,
    name: `${info.def.jsName ?? info.def.name}.prototype.reflected`,
    type: BOOL,
    mutable: true,
  });
  info.prototypeReflectedFlag = id;
  return id;
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
  // A function-local class declaring no prototype members (zod 4's
  // `class Definition extends Parent {}`) has nothing to install: its
  // shared runtime view is complete once its base's is.
  if (info.localClass && declaresPrototypeMembers(info.decl))
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
  const helper = lowerer.liftedFnNamed(info.def.prototypeDataHelper);
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
    {
      kind: "assign",
      localId: prototypeReflectedFlag(lowerer, info),
      value: { kind: "boolLit", value: true, type: BOOL, loc },
      loc,
    },
  );
  // The members lower on top of whatever frames requested the view (a
  // `super` call in a subclass's method); their `this` is their own receiver.
  const context = newFnCtx(false, null, null, DYN);
  context.thisBoundary = true;
  lowerer.fnStack.push(context);
  try {
    for (const member of info.decl.members.nodes) {
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
      // A member whose value or key has no lowering refuses the reflection
      // at run time; its own diagnostic must not escape this walk (the
      // walk runs from emitReachable, after statement fences are placed).
      let before = lowerer.diags.length;
      let value: IrExpr | null;
      try {
        value = classMethodValue(lowerer, info.decl, info, method, loc);
      } catch (error) {
        if (!(error instanceof PoisonError)) throw error;
        lowerer.diags.splice(before);
        return refuse(
          "prototype reflection with a member that has no lowering is not supported yet",
        );
      }
      if (!value || !lowerer.dynConvertible(value.type))
        return refuse(
          "prototype reflection with a member that cannot cross a checked value boundary is not supported yet",
        );
      let key: IrExpr;
      before = lowerer.diags.length;
      try {
        key = ts.isComputedPropertyName(member.name)
          ? lowerer.lowerExpr(member.name.expression)
          : { kind: "strLit", value: member.name.text, type: STRING, loc };
      } catch (error) {
        if (!(error instanceof PoisonError)) throw error;
        lowerer.diags.splice(before);
        return refuse(
          "prototype reflection with a computed member key that has no lowering is not supported yet",
        );
      }
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

/** `Error.prototype` read as the checked-dynamic object, as a value or for
 * a member other than `toString` and `constructor`, which keep the Error
 * class's prototype data (`this.toString !== Error.prototype.toString`
 * compares class method values). */
export function isErrorPrototypeValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return (
    expr.name.text === "prototype" &&
    lowerer.isStdlibGlobal(expr.expression, "Error") &&
    !(
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      (parent.name.text === "toString" || parent.name.text === "constructor")
    )
  );
}

/** Whether a bare `C.prototype` read becomes the prototype of another object
 * or is only compared or inspected: the argument of `Object.create` or
 * `Object.getPrototypeOf` / `Reflect.getPrototypeOf`, the prototype argument
 * of `Object.setPrototypeOf` / `Reflect.setPrototypeOf`, or an operand of
 * `===` / `!==`. In these positions the complete view of the
 * prototype (reflectClassPrototype) answers. Objects that inherit from it
 * run the class's methods with themselves as the receiver, which the
 * methods' receiver-independent lowering (reflectedClassMethodValue)
 * supports. Other positions, such as `Object.setPrototypeOf(C.prototype, X)`,
 * which would relink the class, keep the diagnostic. */
function prototypeViewPosition(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = expr;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    node = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const args = parent.arguments.nodes;
    const objectMethod = lowerer.stdlibGlobalMember(parent.expression, "Object");
    const reflectMethod = lowerer.stdlibGlobalMember(parent.expression, "Reflect");
    if (
      objectMethod === "create" ||
      objectMethod === "getPrototypeOf" ||
      reflectMethod === "getPrototypeOf"
    )
      return args[0] === node;
    if (objectMethod === "setPrototypeOf" || reflectMethod === "setPrototypeOf")
      return args[1] === node;
    return false;
  }
  return (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  );
}

/** A module-level JavaScript class named directly (not a class value that
 * may hold a subclass at run time): its prototype has a complete view whose
 * methods accept any receiver. */
function viewableClass(lowerer: Lowerer, info: ClassInfo, receiver: ts.Expression): boolean {
  return (
    info.decl !== null &&
    info.localClass === undefined &&
    isJsSourceFile(ts.getSourceFileOfNode(info.decl)) &&
    exactClassOfReceiver(lowerer, receiver) === info
  );
}

/** The complete prototype view of the class `node` names, when it is a
 * viewable class (util.inherits's superCtor); null otherwise. */
export function classPrototypeView(
  lowerer: Lowerer,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  const info = exactClassOfReceiver(lowerer, node);
  if (!info || !viewableClass(lowerer, info, node)) return null;
  return reflectClassPrototype(lowerer, info, loc, classValueRef(lowerer, info, node));
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
  // Error.prototype as a value: the checked-dynamic object an ES5
  // constructor function inherits from (`F.prototype =
  // Object.create(Error.prototype)`).
  if (isErrorPrototypeValue(lowerer, expr))
    return { kind: "libCall", fn: "dyn.errorPrototype", args: [], type: DYN, loc: locOf(expr) };
  // EventEmitter.prototype and the stream prototypes: the untyped
  // constructor's prototype object (builtin-class-dyn.ts).
  const builtinKind = builtinClassKind(info.def.name);
  if (builtinKind !== null) {
    const loc = locOf(expr);
    return {
      kind: "dynKeyGet",
      value: builtinClassValue(builtinKind, loc),
      key: { kind: "strLit", value: "prototype", type: STRING, loc },
      type: DYN,
      loc,
    };
  }
  const parent = expr.parent;
  const descriptorKey =
    ts.isCallExpression(parent) &&
    parent.arguments.nodes[0] === expr &&
    ts.isPropertyAccessExpression(parent.expression) &&
    lowerer.stdlibGlobalMember(parent.expression, "Object") === "defineProperty" &&
    parent.arguments.nodes[1] &&
    ts.isStringLiteral(parent.arguments.nodes[1])
      ? parent.arguments.nodes[1].text
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
  // The whole prototype of a function-local class: the shared view
  // Object.getPrototypeOf answers for its instances.
  if (name === null && info.localClass) {
    const receiver = lowerer.lowerExprExpecting(expr.expression, {
      kind: "classval",
      className: info.def.name,
    });
    return reflectClassPrototype(lowerer, info, locOf(expr), receiver);
  }
  if (
    name === null &&
    prototypeViewPosition(lowerer, expr) &&
    viewableClass(lowerer, info, expr.expression)
  )
    return reflectClassPrototype(lowerer, info, locOf(expr), classValueRef(lowerer, info, expr));
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
  const target = call.arguments.nodes[0];
  if (!target || !ts.isPropertyAccessExpression(target) || target.name.text !== "prototype")
    return null;
  const info = exactClassOfReceiver(lowerer, target.expression);
  if (!info) return null;
  if (!ts.isExpressionStatement(call.parent) || call.arguments.nodes.some(ts.isSpreadElement)) {
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
  const sources = call.arguments.nodes
    .slice(1)
    .map((node) => lowerer.lowerExprExpecting(node, DYN));
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
        const declaration = entry ? entry[0].valueDeclaration : undefined;
        // A CommonJS key-table property holds its key in the table's global.
        const tableKey =
          declaration && ts.isPropertyAssignment(declaration)
            ? lowerer.globalsBySymbol.get(entry![0])
            : undefined;
        if (tableKey) {
          keys.push({ kind: "varRef", localId: tableKey.id, type: tableKey.type, loc });
          continue;
        }
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
  const target = call.arguments.nodes[0];
  if (
    member !== "defineProperties" ||
    call.arguments.nodes.length !== 2 ||
    call.arguments.nodes.some(ts.isSpreadElement) ||
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
      lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN),
      prototypeProtectedKeys(lowerer, info, target, loc),
    ],
    type: DYN,
    loc,
  };
}
