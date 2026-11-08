import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  RUNTIME_ERROR_CLASSES,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, PoisonError, type Lowerer } from "./lowerer.js";
import {
  classMemberNameOf,
  findGenericMethodOn,
  findMethodOn,
  genericOverrideBelow,
  type ClassInfo,
} from "./lower-classes.js";
import { checkRefusedMemberUse, reportRefusedMemberUse } from "./class-member-refusals.js";
import { funcTypeFromParamShapes, isThisParameter, type ParamShape } from "./call-signatures.js";
import { erasedGenericInstance, implicitDefaultInstance } from "./generic-functions.js";
import { errorToStringMethod } from "./error-methods.js";
import { methodJsName } from "./function-names.js";
import { classCallbackValue, isClassCallback } from "./class-callbacks.js";
import { perEvaluationPrivateNames } from "./private-brands.js";

/** The name prefix of the helper that checks the receiver a class's method
 * value was called with into the class (`%method.receiver:C`). */
export const METHOD_RECEIVER_PREFIX = "%method.receiver:";

export interface ClassMethodValueSelection {
  expression: ts.PropertyAccessExpression;
  info: ClassInfo;
  method: string;
  fallback: IrExpr;
  fn: IrFunction;
  checked: boolean;
  values: Map<string, IrExpr>;
}

/** A method value retains its declaration's identity, not the receiver from
 * extraction. Its native thunk validates the receiver supplied at call time. */
export function lowerClassMethodValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  const method = expr.name.text;
  if (method === "toString" && findMethodOn(lowerer, info, method)?.declarer.builtinError) {
    return errorToStringMethod(lowerer, lowerer.lowerExpr(expr.expression));
  }
  const loc = locOf(expr);
  const receiver = lowerer.lowerExpr(expr.expression);
  const declared = findMethodOn(lowerer, info, method);
  // A JS checker may name a class while the value is held in checked
  // storage. Read its actual property so own replacements and getters
  // participate, and never pass a dynamic value to a native selector. A
  // method whose private names belong to one evaluation is that
  // evaluation's prototype method as well.
  if (receiver.type.kind === "dyn" || (!!declared && perEvaluationPrivateNames(declared.declarer)))
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(receiver, DYN),
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    };
  // Abstract declarations have no prototype function. Concrete descendants
  // provide the extracted value through the same reachability-driven selector.
  let value = declared?.sig.abstract
    ? nodeThrowExpr(
        1,
        "",
        `Missing implementation of method '${method}'`,
        funcTypeFromParamShapes(declared.sig.params, declared.sig.ret),
        loc,
      )
    : methodValue(lowerer, expr, info);
  if (!value) return null;
  const callback = isClassCallback(lowerer, info, method);
  const local = callback ? lowerer.declareHiddenLocal("%callbackReceiver", receiver.type) : null;
  const reference = local ? varRef(local.id, receiver.type, loc) : receiver;
  const finish = (result: IrExpr): IrExpr => {
    if (!local) return result;
    const selected = classCallbackValue(lowerer, reference, method, result, loc);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
      result: selected,
      type: selected.type,
      loc,
    };
  };
  const checked =
    isJsSourceFile(ts.getSourceFileOfNode(expr)) && lowerer.dynConvertible(value.type);
  if (checked) value = lowerer.coerceToExpected(value, DYN);
  // Select the declaration when extracting the value. Calling the value
  // later must not redispatch the method name on a different receiver.
  const name = `%method.select:${info.def.name}.${method}:${checked ? "checked" : "typed"}`;
  const receiverType: IrType = { kind: "object", className: info.def.name };
  if (!lowerer.classMethodValueHelpers.has(name)) {
    const body: IrStmt[] = [];
    body.push({ kind: "return", value, loc });
    const fn: IrFunction = {
      name,
      params: [{ localId: "this.0", name: "this", type: receiverType }],
      returnType: value.type,
      locals: [{ id: "this.0", name: "this", type: receiverType, mutable: false }],
      body,
      loc,
    };
    lowerer.liftedFns.push(fn);
    lowerer.classMethodValueSelections.set(name, {
      expression: expr,
      info,
      method,
      fallback: value,
      fn,
      checked,
      values: new Map(),
    });
    lowerer.classMethodValueHelpers.add(name);
  }
  return finish({ kind: "call", callee: name, args: [reference], type: value.type, loc });
}

/** Method extraction selects only constructible descendants, then expands
 * at the same reachability fixed point as constructors. A late class must
 * join an existing selector without reaching every imported subclass. */
export function refreshClassMethodValueSelections(lowerer: Lowerer): boolean {
  let changed = false;
  for (const selection of lowerer.classMethodValueSelections.values()) {
    let added = false;
    for (const candidate of lowerer.classes.values()) {
      if (
        candidate === selection.info ||
        selection.values.has(candidate.def.name) ||
        !lowerer.classCanBeConstructed(candidate) ||
        !lowerer.isSubclassOf(candidate.def.name, selection.info.def.name) ||
        !candidate.methods.has(selection.method) ||
        candidate.methods.get(selection.method)?.abstract
      )
        continue;
      selection.values.set(candidate.def.name, selectedMethodValue(lowerer, selection, candidate));
      added = true;
    }
    if (!added) continue;
    const loc = selection.fn.loc;
    const receiver = varRef("this.0", selection.fn.params[0]!.type, loc);
    const names = [...selection.values.keys()];
    const values = [...selection.values]
      .map(([className, value]) => ({
        className,
        value,
        ancestors: names.filter((name) => lowerer.isSubclassOf(className, name)).length,
      }))
      .sort((a, b) => b.ancestors - a.ancestors);
    selection.fn.body = values.map(({ className, value }): IrStmt => ({
      kind: "if",
      cond: { kind: "instanceOf", value: receiver, className, type: BOOL, loc },
      then: [{ kind: "return", value, loc }],
      else_: null,
      loc,
    }));
    selection.fn.body.push({ kind: "return", value: selection.fallback, loc });
    changed = true;
  }
  return changed;
}

/** The value a selector answers for instances of `candidate`.
 *
 * The selector grows in a pass that has no statement to poison, so a
 * candidate whose value is refused (its class refused the member, or the
 * override has no view as the selector's type) must not throw out of the
 * pass: the refusal has reported at the read that made the selector, which
 * fails the build, and the candidate's arm throws. The arm is never the
 * inherited method: a read through a base-typed receiver would answer the
 * wrong function for the class. A poison nothing reported stays a crash. */
function selectedMethodValue(
  lowerer: Lowerer,
  selection: ClassMethodValueSelection,
  candidate: ClassInfo,
): IrExpr {
  try {
    let value = methodValue(lowerer, selection.expression, candidate);
    if (value && selection.checked) value = lowerer.coerceToExpected(value, DYN);
    if (value && !typeEquals(value.type, selection.fallback.type)) {
      const widened = lowerer.coerceCovariantFunction(value, selection.fallback.type);
      // Only a representation-preserving view can keep extraction's
      // identity contract across differently typed base/derived views.
      if (widened) value = widened;
    }
    if (!value || !typeEquals(value.type, selection.fallback.type))
      lowerer.unsupported(
        "SC1090",
        selection.expression,
        "method values with incompatible override signatures",
      );
    return value;
  } catch (e) {
    if (!(e instanceof PoisonError) || lowerer.diags.length === 0) throw e;
    return nodeThrowExpr(
      1,
      "",
      `The value of method '${selection.method}' of class '${candidate.def.name}' did not compile`,
      selection.fallback.type,
      selection.fn.loc,
    );
  }
}

function methodValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  // A method read as a value in source: a refused member reports here.
  const declared = findMethodOn(lowerer, info, expr.name.text);
  if (declared) checkRefusedMemberUse(lowerer, declared.declarer, expr.name.text, expr.name);
  const generic = declared ? null : findGenericMethodOn(lowerer, info, expr.name.text);
  if (generic?.info.refused) reportRefusedMemberUse(lowerer, generic.info.refused, expr.name);
  return classMethodValue(lowerer, expr, info, expr.name.text, locOf(expr));
}

export function classMethodValue(
  lowerer: Lowerer,
  blame: ts.Node,
  info: ClassInfo,
  method: string,
  loc: SrcLoc,
): IrExpr | null {
  const found = findMethodOn(lowerer, info, method);
  const generic = found ? null : findGenericMethodOn(lowerer, info, method);
  if (!found && !generic) return null;
  const declaration = found?.declarer ?? generic!.declarer;
  const reflected = declaration.prototypeMethodValues?.get(method);
  if (reflected) return reflected;
  const checkedMethod = reflectedClassMethodValue(lowerer, declaration, method);
  if (checkedMethod) return checkedMethod;
  let owner: ClassInfo;
  let params: ParamShape[];
  let ret: IrType;
  let callee: string;
  if (found) {
    owner = found.declarer;
    if (found.sig.abstract)
      lowerer.unsupported("SC1090", blame, "values of abstract method declarations");
    params = found.sig.params;
    ret = found.sig.ret;
    callee = `%${owner.def.name}.${method}`;
    if (!owner.builtinError) lowerer.noteEdge(callee);
  } else if (
    generic?.info.implicitParams &&
    generic.declarer.decl &&
    !lowerer.overrideBelow(info, method) &&
    !genericOverrideBelow(info, method)
  ) {
    owner = generic.declarer;
    const instance = implicitDefaultInstance(lowerer, owner.decl!, generic.info);
    params = instance.params;
    ret = instance.returnType;
    callee = instance.name;
  } else if (
    generic &&
    !generic.info.implicitParams &&
    generic.info.typeParams.length > 0 &&
    generic.declarer.decl &&
    !lowerer.overrideBelow(info, method) &&
    !genericOverrideBelow(info, method)
  ) {
    // A generic method as a value: its erased instance.
    owner = generic.declarer;
    const instance = erasedGenericInstance(lowerer, blame, generic.info);
    params = instance.params;
    ret = instance.returnType;
    callee = instance.name;
  } else {
    lowerer.unsupported("SC1090", blame, "values of builtin or unspecialized generic methods");
  }
  const type = funcTypeFromParamShapes(params, ret);
  const name = `%method.value:${callee}`;
  const member = classMethodMember(lowerer, owner, method, false);
  // The value is the method the class declares, so its `length` is that
  // declaration's. The type counts the slot's parameters: an override that
  // adds optional parameters keeps the inherited slot, and a parameter with
  // a default is a position of the type that Node does not count.
  const typeLength = type.params.length - (type.restAbi === "typed" ? 1 : 0);
  const ownLength =
    member !== undefined && ts.isMethodDeclaration(member) ? declaredLength(member) : typeLength;
  if (!lowerer.classMethodValueHelpers.has(name)) {
    if (member !== undefined && readsReceiver(member))
      lowerer.receiverReadingMethodValues.add(name);
    const thunkParams = params.map((param, i) => ({
      localId: `p.${i}`,
      name: `p${i}`,
      type: param.type,
    }));
    const receiverType: IrType = { kind: "object", className: owner.def.name };
    const receiverName = `${METHOD_RECEIVER_PREFIX}${owner.def.name}`;
    if (!lowerer.classMethodValueHelpers.has(receiverName)) {
      lowerer.liftedFns.push({
        name: receiverName,
        params: [{ localId: "this.0", name: "this", type: DYN }],
        returnType: receiverType,
        locals: [{ id: "this.0", name: "this", type: DYN, mutable: false }],
        body: [
          {
            kind: "return",
            value: { kind: "dynCheck", value: varRef("this.0", DYN, loc), type: receiverType, loc },
            loc,
          },
        ],
        loc,
      });
      lowerer.classMethodValueHelpers.add(receiverName);
    }
    const receiver: IrExpr = {
      kind: "call",
      callee: receiverName,
      args: [{ kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc }],
      type: receiverType,
      loc,
    };
    const call: IrExpr = owner.builtinError
      ? {
          kind: "libCall",
          fn: "error.toString",
          args: [receiver],
          type: ret,
          loc,
        }
      : {
          kind: "call",
          callee,
          args: [receiver, ...thunkParams.map((p) => varRef(p.localId, p.type, loc))],
          type: ret,
          loc,
        };
    // The value is the method, so its `name` is the method's; the function
    // that stands for it has no source name of its own (function-names.ts).
    // The runtime's own `Error.prototype.toString` is in nearly every
    // program with an untyped error and stays as it was.
    if (!owner.builtinError) {
      const jsName = member?.name !== undefined ? methodJsName(member.name) : method;
      if (jsName !== null) lowerer.objectMethodNames.set(name, jsName);
    }
    const fn: IrFunction = {
      name,
      params: thunkParams,
      returnType: ret,
      locals: thunkParams.map((p) => ({
        id: p.localId,
        name: p.name,
        type: p.type,
        mutable: false,
      })),
      body:
        ret.kind === "void"
          ? [
              { kind: "exprStmt", expr: call, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value: call, loc }],
      loc,
    };
    lowerer.liftedFns.push(fn);
    lowerer.classMethodValueHelpers.add(name);
  }
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    ...(ownLength !== typeLength ? { length: ownLength } : {}),
    type,
    loc,
  };
}

/** A method declaration's own `length`, as Node counts it: the parameters
 * before the first one with a default or a rest. A `this` parameter is a
 * type, not a parameter. */
function declaredLength(member: ts.MethodDeclaration): number {
  const parameters = member.parameters.nodes.filter((parameter) => !isThisParameter(parameter));
  const stop = parameters.findIndex(
    (parameter) => parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined,
  );
  return stop < 0 ? parameters.length : stop;
}

/** Public JS prototype methods are ordinary callables over their actual
 * receiver, including descriptor-created copies of class instances. */
export function reflectedClassMethodValue(
  lowerer: Lowerer,
  info: ClassInfo,
  method: string,
): IrExpr | null {
  return reflectedMethodValue(lowerer, info, method, false);
}

/** Static JavaScript methods retain their identity and receive the class
 * value supplied by the call, including inherited and detached methods. */
export function reflectedClassStaticMethodValue(
  lowerer: Lowerer,
  info: ClassInfo,
  method: string,
): IrExpr | null {
  return reflectedMethodValue(lowerer, info, method, true);
}

/** The declaration with a body behind `method` of `info`'s own class
 * declaration (an accessor's name is `get:x` or `set:x`). An overloaded
 * method's signatures have none; its implementation is the one. */
function classMethodMember(
  lowerer: Lowerer,
  info: ClassInfo,
  method: string,
  staticMethod: boolean,
): ts.MethodDeclaration | ts.AccessorDeclaration | undefined {
  const member = info.decl?.members.nodes.find((member) => {
    if (
      (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) ||
      !member.name ||
      !member.body ||
      !!ts
        .getModifiers(member)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) !== staticMethod
    )
      return false;
    const name = classMemberNameOf(lowerer, member.name);
    return (
      (ts.isMethodDeclaration(member)
        ? name
        : ts.isGetAccessor(member)
          ? `get:${name}`
          : ts.isSetAccessor(member)
            ? `set:${name}`
            : null) === method
    );
  });
  return member && (ts.isMethodDeclaration(member) || ts.isAccessor(member)) && member.body
    ? member
    : undefined;
}

/** Whether a method's source reads its receiver: `this` or `super` in its
 * parameters or body, outside nested functions and classes, which bind
 * their own (arrow functions see the method's). */
function readsReceiver(member: ts.MethodDeclaration | ts.AccessorDeclaration): boolean {
  const reads = (node: ts.Node): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
      return true;
    if (
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return false;
    return ts.forEachChild(node, (child) => (reads(child) ? true : undefined)) === true;
  };
  return ts.forEachChild(member, (child) => (reads(child) ? true : undefined)) === true;
}

function reflectedMethodValue(
  lowerer: Lowerer,
  info: ClassInfo,
  method: string,
  staticMethod: boolean,
): IrExpr | null {
  const existing = (staticMethod ? info.staticMethodValues : info.prototypeMethodValues)?.get(
    method,
  );
  if (existing) return existing;
  const declaration = info.decl;
  if (!declaration) return null;
  const member = classMethodMember(lowerer, info, method, staticMethod);
  if (!member) return null;
  let needsNativeReceiver =
    !isJsSourceFile(ts.getSourceFileOfNode(declaration)) ||
    info.localClass !== undefined ||
    lowerer.errorHierarchyClassOf(info.def.name);
  // `super.m(...)` in a prototype method reads the base class's prototype,
  // which lowerSuperMethodCall answers over the call-site receiver when the
  // base has a prototype object. Other uses of `super` keep the native
  // receiver.
  const superCalls = !staticMethod && info.base !== null && prototypeChainViewable(info.base);
  // Over a dynamic receiver, private fields are brand-checked and read, and private methods
  // brand-checked and called; a private accessor, or a private method read as a value, would become a
  // lookup of its name.
  const privateAccessors = new Set<string>();
  const privateMethods = new Set<string>();
  for (const other of declaration.members.nodes)
    if (other.name !== undefined && ts.isPrivateIdentifier(other.name)) {
      if (ts.isAccessor(other)) privateAccessors.add(other.name.text);
      else if (ts.isMethodDeclaration(other)) privateMethods.add(other.name.text);
    }
  ts.walkPreorder(member, (node) => {
    if (node.kind === ts.SyntaxKind.SuperKeyword && !(superCalls && isSuperMethodCallee(node)))
      needsNativeReceiver = true;
    if (!ts.isPrivateIdentifier(node)) return;
    // Private members on a static method's receiver (the class value) keep
    // the native receiver; prototype methods brand-check theirs, except
    // private accessors and private methods used other than by a call.
    if (
      staticMethod ||
      privateAccessors.has(node.text) ||
      (privateMethods.has(node.text) && !isPrivateMethodCallee(node))
    )
      needsNativeReceiver = true;
  });
  if (needsNativeReceiver) return null;
  // The method reads itself as a value inside its own body: it is the
  // closure its lowering in progress produces.
  if (lowerer.methodLambdasInProgress.has(member)) {
    const pending = lowerer.methodLambdasInProgress.get(member);
    if (!pending) {
      lowerer.unsupported(
        "SC1090",
        member,
        "class methods that read their own value while their signature is computed",
      );
    }
    pending.selfReads++;
    return {
      kind: "closure",
      fnName: pending.fnName,
      captures: [],
      type: pending.type,
      loc: locOf(member),
    };
  }
  // The method may be lowered on top of an unrelated caller's frames (a
  // `super` call in another class's method reflects this class): its `this`
  // is its own receiver, never an enclosing function's.
  const context = newFnCtx(false, null, null, DYN);
  context.thisBoundary = true;
  const previousClass = lowerer.currentClass;
  lowerer.currentClass = info;
  lowerer.fnStack.push(context);
  lowerer.methodLambdasInProgress.set(member, null);
  try {
    const value = lowerer.lowerLambda(member);
    const pending = lowerer.methodLambdasInProgress.get(member);
    if (
      pending &&
      pending.selfReads > 0 &&
      (value.kind !== "closure" ||
        value.fnName !== pending.fnName ||
        value.captures.length > 0 ||
        !typeEquals(value.type, pending.type))
    ) {
      lowerer.unsupported(
        "SC1090",
        member,
        "class methods that read their own value inside their body when the method's value type is only settled by its body",
      );
    }
    if (value.kind === "closure" && value.captures.length === 0) {
      const body = lowerer.liftedFnNamed(value.fnName);
      if (body?.captures?.length === 0) delete body.captures;
    }
    const cache = staticMethod
      ? (info.staticMethodValues ??= new Map())
      : (info.prototypeMethodValues ??= new Map());
    cache.set(method, value);
    return value;
  } finally {
    lowerer.methodLambdasInProgress.delete(member);
    lowerer.fnStack.pop();
    lowerer.currentClass = previousClass;
  }
}

/** Whether `base` and every class above it have a complete prototype object
 * (reflectClassPrototype): module-level program classes that neither extend
 * Date nor a runtime-provided class. */
function prototypeChainViewable(base: ClassInfo): boolean {
  for (let c: ClassInfo | null = base; c; c = c.base)
    if (
      c.decl === null ||
      c.localClass !== undefined ||
      c.generic !== undefined ||
      c.genericInstance !== undefined ||
      c.mixinInstance !== undefined ||
      c.callableBase !== undefined ||
      c.extendsDate !== undefined ||
      c.def.runtime ||
      c.builtinEmitter ||
      c.builtinStream ||
      c.builtinError ||
      c.builtinEventTarget
    )
      return false;
  return true;
}

/** `super` as the receiver of a called member: `super.m(...)`. */
/** Whether `node`, a private name, is the method a call calls (`x.#m(...)`). */
function isPrivateMethodCallee(node: ts.Node): boolean {
  const access = node.parent;
  return (
    access !== undefined &&
    ts.isPropertyAccessExpression(access) &&
    access.name === node &&
    access.parent !== undefined &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  );
}

function isSuperMethodCallee(node: ts.Node): boolean {
  const access = node.parent;
  return (
    access !== undefined &&
    ts.isPropertyAccessExpression(access) &&
    access.expression === node &&
    access.parent !== undefined &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  );
}

/** Complete adapters after all native class bodies and instantiations exist. */
export function finalizeClassMethodValues(lowerer: Lowerer, functions: IrFunction[]): void {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  for (const fn of [...functions]) {
    if (fn.name.startsWith(METHOD_RECEIVER_PREFIX) && fn.returnType.kind === "object") {
      const owner = fn.returnType.className;
      const loc = fn.loc;
      const receiver = varRef("this.0", DYN, loc);
      const branches: IrStmt[] = [];
      if (lowerer.isSubclassOf(owner, "%Error")) {
        const base: IrExpr = {
          kind: "dynCheck",
          value: receiver,
          type: { kind: "object", className: "%Error" },
          loc,
        };
        branches.push({
          kind: "if",
          cond: { kind: "dynTest", test: "error", value: receiver, type: BOOL, loc },
          then: [
            {
              kind: "if",
              cond: { kind: "instanceOf", value: base, className: owner, type: BOOL, loc },
              then: [
                {
                  kind: "return",
                  value:
                    owner === "%Error"
                      ? base
                      : { kind: "downcast", value: base, type: fn.returnType, loc },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
          else_: null,
          loc,
        });
      }
      for (const info of lowerer.classes.values()) {
        const name = info.def.name;
        if (RUNTIME_ERROR_CLASSES.has(name)) continue;
        if (
          !lowerer.isSubclassOf(name, owner) &&
          !lowerer.isSubclassOf(owner, name) &&
          name !== owner
        )
          continue;
        const type: IrType = { kind: "object", className: name };
        const checked: IrExpr = { kind: "dynCheck", value: receiver, type, loc };
        const value: IrExpr =
          name === owner
            ? checked
            : lowerer.isSubclassOf(name, owner)
              ? { kind: "upcast", value: checked, type: fn.returnType, loc }
              : { kind: "downcast", value: checked, type: fn.returnType, loc };
        const returned: IrStmt = { kind: "return", value, loc };
        const then: IrStmt[] =
          name === owner || lowerer.isSubclassOf(name, owner)
            ? [returned]
            : [
                {
                  kind: "if",
                  cond: { kind: "instanceOf", value: checked, className: owner, type: BOOL, loc },
                  then: [returned],
                  else_: null,
                  loc,
                },
              ];
        branches.push({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [receiver, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then,
          else_: null,
          loc,
        });
      }
      fn.body.unshift(...branches);
    }
    if (!fn.name.startsWith("%method.value:")) continue;
    const target = byName.get(fn.name.slice("%method.value:".length));
    const thisParam = target?.params[0];
    if (!target || !thisParam || target.async || target.generator) continue;
    const usesThis =
      !!target.classCaptures?.length ||
      !everyStmtList(target.body, {
        stmt: () => true,
        expr: (expr) =>
          !(expr.kind === "varRef" && expr.localId === thisParam.localId) &&
          !(expr.kind === "closure" && expr.captures.includes(thisParam.localId)),
      });
    // The lowered body alone does not decide this. A test of the receiver
    // (`this === undefined`, `typeof this`, `this instanceof C`) and a test
    // of a member's type (`typeof this.name`) are answered from the type
    // `this` has after the check below, and leave no read behind: skipping
    // the check for such a method would run it with those answers on a
    // receiver that is not an instance.
    if (usesThis || lowerer.receiverReadingMethodValues.has(fn.name)) continue;
    // A method that never uses this remains callable when detached. Without
    // class captures it needs no class environment, so the detached copy
    // drops the (empty) capture list, which requires a receiver.
    const name = `%method.receiverless:${target.name}`;
    const { classCaptures: _classCaptures, ...detached } = target;
    // The copy owns its parameter and local records: later passes retype a
    // function's locals in place (the jsval promotion), one function at a
    // time.
    functions.push({
      ...detached,
      name,
      params: target.params.slice(1).map((param) => ({ ...param })),
      locals: target.locals
        .filter((local) => local.id !== thisParam.localId)
        .map((local) => ({ ...local })),
    });
    fn.body = transformStmtList(fn.body, {
      stmt: (stmt) => stmt,
      expr: (expr) =>
        expr.kind === "call" && expr.callee === target.name
          ? { ...expr, callee: name, args: expr.args.slice(1) }
          : expr,
    });
  }
}
