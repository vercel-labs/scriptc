import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  DYN,
  STRING,
  isDynTypedRefType,
  isUnitType,
  canConvertToDyn,
  canDynCheckTo,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { type Lowerer } from "./lowerer.js";
import { findMethodOn, upcastTo, type ClassInfo } from "./lower-classes.js";
import { isClassCallback } from "./class-callbacks.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";

/** A method call through a class-backed protocol (`s.area()` with
 * `s: Shape`) that keeps its static signature. ClassDynamicDispatch adds
 * one native arm to `fn` per boxed class implementing the method; other
 * values take `fallback`, the checked-dynamic call. */
export interface ProtocolDispatch {
  method: string;
  /** (receiver, [callee], ...args, calleeName) → result. Generated: its
   * capsule tests and unboxing stay as written. */
  fn: IrFunction;
  /** The same signature as `fn`, lowered as ordinary code so property
   * reads and checks dispatch like the call they replace. */
  fallback: IrFunction;
  /** Reads the callee before arguments run, for argument lists with
   * effects. Native arms answer undefined without reading it. */
  probe: IrFunction | null;
  params: IrType[];
  /** The call's static result; DYN for a void protocol method, whose
   * implementations may still return a value. */
  result: IrType;
  returnsVoid: boolean;
  /** A property read (`s.name`) rather than a method call: arms read the
   * implementing class's field. */
  field: boolean;
  classes: Set<string>;
}

/** The fallback takes its own reference to the receiver. A caller may lend
 * the receiver from an array element, and the checked call can run code
 * that removes that element. */
function ownedReceiver(params: IrParam[]): IrParam[] {
  return params.map((param, index) => (index === 0 ? { ...param, owned: true } : param));
}

/** Lowered arguments whose evaluation can neither throw nor change any
 * value. */
function effectFree(expr: IrExpr): boolean {
  const scalar = (value: IrExpr): boolean =>
    (value.type.kind === "f64" || value.type.kind === "bool") && effectFree(value);
  switch (expr.kind) {
    case "varRef":
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
      return true;
    case "bin":
      return scalar(expr.left) && scalar(expr.right);
    case "unary":
      return scalar(expr.operand);
    default:
      return false;
  }
}

/** The function, class field initializer or static block whose code runs
 * `node`, or its source file. */
function codeOwner(node: ts.Node): ts.Node {
  let current = node.parent;
  while (
    current &&
    !ts.isSourceFile(current) &&
    !ts.isFunctionLike(current) &&
    !ts.isClassStaticBlockDeclaration(current) &&
    !ts.isPropertyDeclaration(current)
  )
    current = current.parent;
  return current ?? ts.getSourceFileOfNode(node);
}

/** A local variable or parameter that only its own function's code
 * assigns. Reading a method can run a getter, which can then assign only
 * bindings that its own body writes, so such a variable keeps its value
 * across the read. */
function ownedBinding(lowerer: Lowerer, id: ts.Identifier): boolean {
  const symbol = lowerer.resolveValueSymbol(id);
  if (!symbol) return false;
  const cached = lowerer.protocolOwnedBindings.get(symbol);
  if (cached !== undefined) return cached;
  const decl = symbol.valueDeclaration;
  let owned =
    decl !== undefined &&
    ts.getSourceFileOfNode(decl) === ts.getSourceFileOfNode(id) &&
    ((ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) ||
      (ts.isParameter(decl) && ts.isIdentifier(decl.name)));
  if (owned && decl) {
    const owner = codeOwner(decl);
    const names = (node: ts.Node): boolean =>
      ts.isIdentifier(node) &&
      node.text === ts.symbolName(symbol) &&
      lowerer.resolveValueSymbol(node) === symbol;
    const written = (target: ts.Node): boolean => {
      let found = false;
      const walk = (node: ts.Node): void => {
        if (found) return;
        if (names(node)) found = true;
        else ts.forEachChild(node, walk);
      };
      walk(target);
      return found;
    };
    const visit = (node: ts.Node): void => {
      if (!owned) return;
      // Sloppy-mode `arguments` aliases parameters.
      if (ts.isParameter(decl) && ts.isIdentifier(node) && node.text === "arguments") owned = false;
      let target: ts.Node | null = null;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        target = node.left;
      else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        target = node.operand;
      else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
      )
        target = node.initializer;
      if (target && codeOwner(node) !== owner && written(target)) owned = false;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(owner, visit);
  }
  lowerer.protocolOwnedBindings.set(symbol, owned);
  return owned;
}

/** Arguments a method read cannot change: literals, and arithmetic over
 * literals and owned bindings. The method may then be read after them. */
function stableArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return stableArgument(lowerer, node.expression);
  if (ts.isIdentifier(node)) return ownedBinding(lowerer, node);
  if (ts.isPrefixUnaryExpression(node)) return stableArgument(lowerer, node.operand);
  if (ts.isBinaryExpression(node))
    return (
      (node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
        node.operatorToken.kind > ts.SyntaxKind.LastAssignment) &&
      stableArgument(lowerer, node.left) &&
      stableArgument(lowerer, node.right)
    );
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

interface ProtocolSignature {
  params: IrType[];
  result: IrType;
  returnsVoid: boolean;
}

/** The protocol method's parameter and result types, when every parameter
 * is plain (no rest, optional or default) and every type maps. */
function protocolSignature(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): ProtocolSignature | null {
  // A guarded optional step's receiver still carries its nullish arms.
  const recvTs = lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression));
  const property = lowerer.checker.getPropertyOfType(recvTs, access.name.text);
  if (!property) return null;
  const declarations = property.declarations;
  if (
    declarations.length === 0 ||
    !declarations.every(
      (decl) => ts.isMethodSignatureDeclaration(decl) || ts.isMethodDeclaration(decl),
    )
  )
    return null;
  const signature = lowerer.checker.getResolvedSignature(call);
  const declaration = signature && signature.declaration;
  if (
    !signature ||
    !declaration ||
    !(ts.isMethodSignatureDeclaration(declaration) || ts.isMethodDeclaration(declaration)) ||
    (declaration.typeParameters?.nodes.length ?? 0) > 0
  )
    return null;
  const declared = (declaration.parameters.nodes ?? []).filter(
    (param) => !(ts.isIdentifier(param.name) && param.name.text === "this"),
  );
  const symbols = signature.getParameters();
  if (symbols.length !== declared.length || call.arguments.nodes.length !== declared.length)
    return null;
  const records = (id: string) => lowerer.shapes.get(id);
  const unions = (id: string) => lowerer.unions.get(id);
  const params: IrType[] = [];
  for (let i = 0; i < declared.length; i++) {
    const param = declared[i]!;
    if (param.dotDotDotToken || param.questionToken || param.initializer) return null;
    const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(symbols[i]!));
    if (!mapped || mapped.kind === "void" || !canConvertToDyn(mapped, records, unions)) return null;
    params.push(mapped);
  }
  const returned = lowerer.checker.getReturnTypeOfSignature(signature);
  if ((returned.flags & ts.TypeFlags.Void) !== 0) return { params, result: DYN, returnsVoid: true };
  const result = lowerer.mapTypeOf(returned);
  if (!result || result.kind === "void" || !canDynCheckTo(result, records, unions)) return null;
  return { params, result, returnsVoid: false };
}

/** `s.m(args)` on a class-backed protocol receiver: the arguments and the
 * result keep their static types, and receivers that are instances of a
 * boxed implementing class call the native method directly. */
export function lowerProtocolMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr | null {
  // An optional chain that already guarded this step (`s?.m(x)`, the chain
  // re-dispatching with the narrowed receiver) calls like a plain one.
  if (
    recv.type.kind !== "dyn" ||
    lowerer.chainBlocked(call, access) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  let signature: ProtocolSignature | null;
  try {
    signature = protocolSignature(lowerer, call, access);
  } catch {
    return null;
  }
  if (!signature) return null;
  const { params, result, returnsVoid } = signature;
  const loc = locOf(call);
  const method = access.name.text;
  // A const binding already holds the receiver for the whole call; other
  // receivers are evaluated once into a hidden local.
  const constant =
    recv.kind === "varRef" &&
    lowerer.ctx.locals.some((local) => local.id === recv.localId && !local.mutable);
  const receiverLocal = constant ? null : lowerer.declareHiddenLocal("%protocolReceiver", DYN);
  const receiver = receiverLocal ? varRef(receiverLocal.id, DYN, loc) : recv;
  const stmts: IrStmt[] = receiverLocal
    ? [{ kind: "varDecl", localId: receiverLocal.id, init: recv, loc }]
    : [];
  const args = call.arguments.nodes.map((arg, i) =>
    lowerer.coerceToExpected(lowerer.lowerExprExpecting(arg, params[i]!), params[i]!),
  );
  const probed =
    !args.every(effectFree) || !call.arguments.nodes.every((arg) => stableArgument(lowerer, arg));
  const key = JSON.stringify([method, params.map(typeKey), typeKey(result), returnsVoid, probed]);
  let dispatch = lowerer.protocolDispatches.get(key);
  if (!dispatch) {
    const index = lowerer.protocolDispatches.size;
    const signatureParams: IrParam[] = [
      { localId: "p.0", name: "receiver", type: DYN },
      ...(probed ? [{ localId: "p.callee", name: "callee", type: DYN }] : []),
      ...params.map((type, i) => ({ localId: `p.${i + 1}`, name: `p${i + 1}`, type })),
      { localId: "p.calleeName", name: "calleeName", type: STRING },
    ];
    const locals = () =>
      signatureParams.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      }));
    const read = (): IrExpr => ({
      kind: "dynKeyGet",
      value: varRef("p.0", DYN, loc),
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    });
    const dynamicCall: IrExpr = {
      kind: "dynCall",
      callee: probed ? varRef("p.callee", DYN, loc) : read(),
      receiver: varRef("p.0", DYN, loc),
      calleeName: ts.getTextOfNode(access),
      calleeNameValue: varRef("p.calleeName", STRING, loc),
      args: params.map((type, i) => lowerer.coerceToExpected(varRef(`p.${i + 1}`, type, loc), DYN)),
      type: DYN,
      loc,
    };
    const fallback: IrFunction = {
      name: `%dyn.class.protocol.fallback.${index}`,
      params: ownedReceiver(signatureParams),
      returnType: result,
      locals: locals(),
      body: [{ kind: "return", value: lowerer.coerceToExpected(dynamicCall, result), loc }],
      loc,
    };
    const fn: IrFunction = {
      name: `%dyn.class.protocol.${index}`,
      params: signatureParams,
      returnType: result,
      locals: locals(),
      body: [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: fallback.name,
            args: signatureParams.map((param) => varRef(param.localId, param.type, loc)),
            type: result,
            loc,
          },
          loc,
        },
      ],
      loc,
    };
    const probe: IrFunction | null = probed
      ? {
          name: `%dyn.class.protocol.callee.${index}`,
          params: [signatureParams[0]!],
          returnType: DYN,
          locals: [{ id: "p.0", name: "receiver", type: DYN, mutable: false }],
          body: [{ kind: "return", value: read(), loc }],
          loc,
        }
      : null;
    dispatch = {
      method,
      fn,
      fallback,
      probe,
      params,
      result,
      returnsVoid,
      field: false,
      classes: new Set(),
    };
    lowerer.protocolDispatches.set(key, dispatch);
    lowerer.liftedFns.push(fn, fallback, ...(probe ? [probe] : []));
  }
  const callee = dispatch.probe ? lowerer.declareHiddenLocal("%protocolCallee", DYN) : null;
  if (dispatch.probe && callee)
    stmts.push({
      kind: "varDecl",
      localId: callee.id,
      init: { kind: "call", callee: dispatch.probe.name, args: [receiver], type: DYN, loc },
      loc,
    });
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "call",
      callee: dispatch.fn.name,
      args: [
        receiver,
        ...(callee ? [varRef(callee.id, DYN, loc)] : []),
        ...args,
        { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc },
      ],
      type: result,
      loc,
    },
    type: result,
    loc,
  };
}

/** The native arm for receivers of `info`: the method's own signature must
 * accept the protocol's argument types unchanged (or as one checked-dynamic
 * value), and nothing may replace the method on an instance. */
export function protocolArm(
  lowerer: Lowerer,
  dispatch: ProtocolDispatch,
  info: ClassInfo,
  receiver: IrExpr,
  asyncFree: boolean,
): IrStmt[] | null {
  const { method } = dispatch;
  const loc = dispatch.fn.loc;
  if (
    info.def.runtime ||
    info.builtinError ||
    info.builtinEmitter ||
    info.builtinStream ||
    isClassCallback(lowerer, info, method)
  )
    return null;
  const found = findMethodOn(lowerer, info, method);
  if (!found || (asyncFree && (found.sig.gen || found.sig.async))) return null;
  const records = (id: string) => lowerer.shapes.get(id);
  const unions = (id: string) => lowerer.unions.get(id);
  const { params } = found.sig;
  if (params.length !== dispatch.params.length) return null;
  const args: IrExpr[] = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const incoming = varRef(`p.${i + 1}`, dispatch.params[i]!, loc);
    if (param.mode !== "required" && param.mode !== "omittable") return null;
    if (typeEquals(param.type, incoming.type)) args.push(incoming);
    else if (param.type.kind === "dyn") args.push(lowerer.coerceToExpected(incoming, DYN));
    else return null;
  }
  const owner = found.declarer;
  const virtual = lowerer.overrideBelow(owner, method) || found.sig.abstract === true;
  const callee = `%${owner.def.name}.${method}`;
  const ret = found.sig.ret;
  const invoke: IrExpr = virtual
    ? {
        kind: "virtualCall",
        className: owner.def.name,
        method,
        args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
        type: ret,
        loc,
      }
    : {
        kind: "call",
        callee,
        args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
        type: ret,
        loc,
      };
  let body: IrStmt[];
  if (ret.kind === "void") {
    if (!dispatch.returnsVoid) return null;
    body = [
      { kind: "exprStmt", expr: invoke, loc },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    ];
  } else if (typeEquals(ret, dispatch.result)) {
    body = [{ kind: "return", value: invoke, loc }];
  } else if (dispatch.result.kind === "dyn" && canConvertToDyn(ret, records, unions)) {
    body = [{ kind: "return", value: lowerer.coerceToExpected(invoke, DYN), loc }];
  } else return null;
  if (virtual) lowerer.noteVirtualEdge(owner, method);
  else lowerer.noteEdge(callee);
  return body;
}

/** Static results that the checked fallback converts without copying: the
 * value keeps its identity whichever path produced it. */
function identityResult(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "f64" || type.kind === "bool" || type.kind === "string") return true;
  if (isDynTypedRefType(type)) return true;
  if (type.kind !== "union") return false;
  return (
    lowerer.unions
      .get(type.unionId)
      ?.arms.every(
        (arm) =>
          arm.kind === "f64" ||
          arm.kind === "bool" ||
          arm.kind === "string" ||
          isUnitType(arm) ||
          isDynTypedRefType(arm),
      ) ?? false
  );
}

/** `s.name` on a class-backed protocol receiver, where `name` is a property
 * signature: the read has the property's static type, and receivers that
 * are instances of a boxed class declaring the field read it directly. */
export function lowerProtocolPropertyRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  const receiverType = lowerer.typeOf(access.expression);
  if (!lowerer.classImplementedProtocol(receiverType)) return null;
  const name = access.name.text;
  const property = lowerer.checker.getPropertyOfType(receiverType, name);
  const declarations = property ? property.declarations : [];
  if (declarations.length === 0 || !declarations.every((decl) => ts.isPropertySignature(decl)))
    return null;
  const result = lowerer.mapTypeOf(lowerer.typeOf(access));
  if (
    !result ||
    !identityResult(lowerer, result) ||
    !canDynCheckTo(
      result,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  const recv = tryLowerExpression(lowerer, access.expression);
  if (recv?.type.kind !== "dyn") return null;
  const loc = locOf(access);
  const key = JSON.stringify(["get", name, typeKey(result)]);
  let dispatch = lowerer.protocolDispatches.get(key);
  if (!dispatch) {
    const index = lowerer.protocolDispatches.size;
    const params: IrParam[] = [{ localId: "p.0", name: "receiver", type: DYN }];
    const locals = () => [{ id: "p.0", name: "receiver", type: DYN, mutable: false }];
    const read: IrExpr = {
      kind: "dynKeyGet",
      value: varRef("p.0", DYN, loc),
      key: { kind: "strLit", value: name, type: STRING, loc },
      type: DYN,
      loc,
    };
    const fallback: IrFunction = {
      name: `%dyn.class.protocol.fallback.${index}`,
      params: ownedReceiver(params),
      returnType: result,
      locals: locals(),
      body: [{ kind: "return", value: lowerer.coerceToExpected(read, result), loc }],
      loc,
    };
    const fn: IrFunction = {
      name: `%dyn.class.protocol.${index}`,
      params,
      returnType: result,
      locals: locals(),
      body: [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: fallback.name,
            args: [varRef("p.0", DYN, loc)],
            type: result,
            loc,
          },
          loc,
        },
      ],
      loc,
    };
    dispatch = {
      method: name,
      fn,
      fallback,
      probe: null,
      params: [],
      result,
      returnsVoid: false,
      field: true,
      classes: new Set(),
    };
    lowerer.protocolDispatches.set(key, dispatch);
    lowerer.liftedFns.push(fn, fallback);
  }
  return { kind: "call", callee: dispatch.fn.name, args: [recv], type: result, loc };
}

/** The field arm for receivers of `info`: a declared field of the read's
 * type. Accessors and fields of JavaScript classes, which an own property
 * can replace, keep the checked read. */
export function protocolFieldArm(
  lowerer: Lowerer,
  dispatch: ProtocolDispatch,
  info: ClassInfo,
  receiver: IrExpr,
): IrStmt[] | null {
  if (
    info.def.runtime ||
    info.builtinError ||
    info.builtinEmitter ||
    info.builtinStream ||
    info.def.tracksOwnFields
  )
    return null;
  const field = info.fields.get(dispatch.method);
  if (!field || !typeEquals(field, dispatch.result)) return null;
  const loc = dispatch.fn.loc;
  return [
    {
      kind: "return",
      value: {
        kind: "fieldGet",
        obj: receiver,
        className: info.def.name,
        field: dispatch.method,
        type: field,
        loc,
      },
      loc,
    },
  ];
}
