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
import { newFnCtx, type Lowerer } from "./lowerer.js";
import {
  classMemberNameOf,
  findGenericMethodOn,
  findMethodOn,
  genericOverrideBelow,
  type ClassInfo,
} from "./lower-classes.js";
import { funcTypeFromParamShapes, type ParamShape } from "./call-signatures.js";
import { implicitDefaultInstance } from "./generic-functions.js";
import { errorToStringMethod } from "./error-methods.js";
import { classCallbackValue, isClassCallback } from "./class-callbacks.js";

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
  // A JS checker may name a class while the value is held in checked
  // storage. Read its actual property so own replacements and getters
  // participate, and never pass a dynamic value to a native selector.
  if (receiver.type.kind === "dyn")
    return {
      kind: "dynKeyGet",
      value: receiver,
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    };
  const declared = findMethodOn(lowerer, info, method);
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
  const checked = isJsSourceFile(expr.getSourceFile()) && lowerer.dynConvertible(value.type);
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
      selection.values.set(candidate.def.name, value);
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

function methodValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
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
  } else {
    lowerer.unsupported("SC1090", blame, "values of builtin or unspecialized generic methods");
  }
  const type = funcTypeFromParamShapes(params, ret);
  const name = `%method.value:${callee}`;
  if (!lowerer.classMethodValueHelpers.has(name)) {
    const thunkParams = params.map((param, i) => ({
      localId: `p.${i}`,
      name: `p${i}`,
      type: param.type,
    }));
    const receiverType: IrType = { kind: "object", className: owner.def.name };
    const receiverName = `%method.receiver:${owner.def.name}`;
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
  return { kind: "closure", fnName: name, captures: [], type, loc };
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
  const member = declaration.members.find((member) => {
    if (
      (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) ||
      !member.name ||
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
  if (!member || (!ts.isMethodDeclaration(member) && !ts.isAccessor(member)) || !member.body)
    return null;
  let needsNativeReceiver =
    !isJsSourceFile(declaration.getSourceFile()) ||
    info.localClass !== undefined ||
    lowerer.errorHierarchyClassOf(info.def.name);
  ts.walkPreorder(member, (node) => {
    if (ts.isPrivateIdentifier(node) || node.kind === ts.SyntaxKind.SuperKeyword)
      needsNativeReceiver = true;
  });
  if (needsNativeReceiver) return null;
  const context = newFnCtx(false, null, null, DYN);
  const previousClass = lowerer.currentClass;
  lowerer.currentClass = info;
  lowerer.fnStack.push(context);
  try {
    const value = lowerer.lowerLambda(member);
    if (value.kind === "closure" && value.captures.length === 0) {
      const body = lowerer.liftedFns.find((fn) => fn.name === value.fnName);
      if (body?.captures?.length === 0) delete body.captures;
    }
    const cache = staticMethod
      ? (info.staticMethodValues ??= new Map())
      : (info.prototypeMethodValues ??= new Map());
    cache.set(method, value);
    return value;
  } finally {
    lowerer.fnStack.pop();
    lowerer.currentClass = previousClass;
  }
}

/** Complete adapters after all native class bodies and instantiations exist. */
export function finalizeClassMethodValues(lowerer: Lowerer, functions: IrFunction[]): void {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  for (const fn of [...functions]) {
    if (fn.name.startsWith("%method.receiver:") && fn.returnType.kind === "object") {
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
    if (usesThis) continue;
    // A method that never uses this remains callable when detached.
    const name = `%method.receiverless:${target.name}`;
    functions.push({
      ...target,
      name,
      params: target.params.slice(1),
      locals: target.locals.filter((local) => local.id !== thisParam.localId),
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
