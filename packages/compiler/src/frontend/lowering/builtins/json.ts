import { callbackTakesEveryArgument } from "../callback-arg.js";
import { widensReducedRecords } from "../function-returns.js";
import { keyedHelperName } from "../stable-names.js";
import { isDateJsonSource } from "./dates.js";
import { isPerfEntryType } from "./performance.js";
import { isX509Type, x509ToString } from "./x509.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParentheses } from "../../outer-expressions.js";
import { type Lowerer } from "../lowerer.js";

/** Whether `node`, seen through parentheses and a non-null assertion, is an
 * ELEMENT read whose lowered value keeps an absent (undefined) arm the
 * checker's type does not name: the read whose runtime value the JSON
 * lowering serializes (undefined at the root, dropped in an object). A call
 * or a plain property read keeps its declared type and its fence. */
function runtimeOptionalRead(lowerer: Lowerer, node: ts.Expression, value: IrExpr): boolean {
  let read = node;
  while (ts.isParenthesizedExpression(read) || ts.isNonNullExpression(read)) read = read.expression;
  return (
    ts.isElementAccessExpression(read) &&
    lowerer.isRuntimeOptionalOrigin(read) &&
    lowerer.bareUndefinedArmedUnion(value.type)
  );
}
import { locOf } from "../../program.js";
import {
  isJsonStringifyDynamicType,
  isJsonStringifyRuntimeScalarType,
  BOOL,
  DYN,
  type IrType,
  classDynViewSupported,
  isClassOwnEnumerableFieldName,
  isDynTypedRefType,
  isLiveDynRefType,
  type IrExpr,
  type IrStmt,
  STRING,
  type SrcLoc,
  canBoxFuncIntoDyn,
  isUnitType,
} from "../../../ir/ir.js";
import { optionalStringTags } from "./arguments.js";

/** JSON parse produces checked-dynamic data; a native reviver walks it
 * bottom-up before any checked cast. Stringify without a callback keeps
 * its type-directed fast path. A function or array replacer boxes the input
 * and walks it before primitive normalization. Both paths share literal gap
 * rules, and callback failures use ordinary native exception unwinding. */
export function lowerJsonMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "JSON");
  if (member === null) return null;
  const loc = locOf(call);
  if (
    (member === "parse" && (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2)) ||
    (member === "stringify" && call.arguments.nodes.length > 3) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `JSON.${member} with extra or spread arguments`,
      call,
      "pass the JSON arguments explicitly",
    );
  }
  if (member === "parse") {
    const text = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    const reviver = call.arguments.nodes[1];
    if (!reviver || jsonNullishArgument(lowerer, reviver)) {
      return { kind: "libCall", fn: "json.parse", args: [text], type: DYN, loc };
    }
    const callback = lowerJsonCallback(lowerer, reviver, "reviver");
    return { kind: "libCall", fn: "json.parseReviver", args: [text, callback], type: DYN, loc };
  }
  if (member === "stringify") {
    const replacerNode = call.arguments.nodes[1];
    const spaceNode = call.arguments.nodes[2];
    const runtimeOptions =
      (replacerNode &&
        !jsonNullishArgument(lowerer, replacerNode) &&
        lowerer.mapTypeOf(lowerer.typeOf(replacerNode))?.kind === "dyn") ||
      (spaceNode &&
        !jsonNullishArgument(lowerer, spaceNode) &&
        !ts.isNumericLiteral(spaceNode) &&
        !ts.isStringLiteral(spaceNode) &&
        !ts.isNoSubstitutionTemplateLiteral(spaceNode) &&
        !(ts.isPrefixUnaryExpression(spaceNode) && ts.isNumericLiteral(spaceNode.operand)));
    if (runtimeOptions && call.arguments.nodes[0]) {
      const args = [0, 1, 2].map((index) =>
        call.arguments.nodes[index]
          ? lowerer.lowerExprExpecting(call.arguments.nodes[index]!, DYN)
          : dynUndefinedExpr(loc),
      );
      return { kind: "libCall", fn: "json.stringifyValue", args, type: DYN, loc };
    }
    const indent = stringifySpaceIndent(lowerer, call);
    if (call.arguments.nodes.length === 0) {
      return lowerer.wrappedUndefined(lowerer.withUndefinedArm(STRING), loc)!;
    }
    const argNode = call.arguments.nodes[0]!;
    let value = lowerer.lowerExpr(argNode);
    // Optional Map/array reads and partially narrowed unions keep their
    // storage representation when lowered as ordinary arguments. Select
    // the JSON walker from the proven use-site type, using a checked
    // conversion so a stale capture cannot read an impossible payload.
    // Optional strings have a serializer that preserves a missing root;
    // an unchecked array read can still be absent despite its checker type.
    // A Date's toJSON() result keeps its null: the lib types say string.
    if (
      value.type.kind === "union" &&
      optionalStringTags(lowerer, value.type) === null &&
      !isDateJsonSource(lowerer, argNode)
    ) {
      const narrowed = lowerer.mapTypeOf(lowerer.typeOf(argNode));
      // A union of record types the checker's subtype reduction spelled as
      // one of them serializes each value by its own layout.
      if (
        narrowed &&
        !isUnitType(narrowed) &&
        narrowed.kind !== "void" &&
        // A runtime-optional read (an absent dictionary key, an empty array
        // slot) can still BE the absent arm at run time: narrowing to the
        // checker's type would throw where Node serializes the absence.
        !runtimeOptionalRead(lowerer, argNode, value) &&
        !widensReducedRecords(lowerer, narrowed, value.type)
      ) {
        const helper =
          narrowed.kind === "union"
            ? lowerer.narrowedRetagHelper(argNode, value.type.unionId, narrowed.unionId, loc)
            : lowerer.narrowedArmHelper(value.type.unionId, narrowed, loc);
        if (helper) value = { kind: "call", callee: helper, args: [value], type: narrowed, loc };
      }
    }
    // A performance entry serializes through its toJSON, and the fields
    // that answers depend on the entry's runtime class: a resource entry
    // carries its timing fields and no detail, while a mark or measure
    // carries detail. The static type does not say which class a value is
    // (a PerformanceEntry-typed value can be either), so the record or the
    // array crosses to the runtime walker, which runs the entry
    // prototype's toJSON.
    if (
      (value.type.kind === "record" && isPerfEntryType(lowerer, value.type)) ||
      (value.type.kind === "array" && isPerfEntryType(lowerer, value.type.elem))
    ) {
      value = { kind: "dynFrom", value, type: DYN, loc };
    }
    const replacer = call.arguments.nodes[1];
    if (replacer && !jsonNullishArgument(lowerer, replacer)) {
      const callback = lowerJsonCallback(lowerer, replacer, "replacer");
      if (value.type.kind === "undefinedT" || value.type.kind === "nullT")
        value = lowerer.coerceToExpected(value, DYN);
      // Evaluate the original arguments before taking a typed snapshot.
      // Creating the callback can itself mutate the input object.
      const inputSlot = lowerer.declareHiddenLocal("%jsonInput", value.type);
      const callbackSlot = lowerer.declareHiddenLocal("%jsonCallback", DYN);
      const boxed = lowerer.coerceToExpected(varRef(inputSlot.id, value.type, loc), DYN);
      if (boxed.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify callback input of type '${lowerer.fmt(value.type)}' (the value must cross the checked-dynamic boundary)`,
        );
      }
      const raw: IrExpr = {
        kind: "libCall",
        fn: "json.stringifyReplacer",
        args: [
          boxed,
          varRef(callbackSlot.id, DYN, loc),
          { kind: "strLit", value: indent, type: STRING, loc },
        ],
        type: DYN,
        loc,
      };
      // A replacer can omit even the root. Preserve actual undefined;
      // an inferred binding adopts this union, while a required string
      // consumer uses the ordinary checked optional-value boundary.
      const result: IrExpr = {
        kind: "dynCheck",
        value: raw,
        type: lowerer.withUndefinedArm(STRING),
        loc,
      };
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: inputSlot.id, init: value, loc },
          { kind: "varDecl", localId: callbackSlot.id, init: callback, loc },
        ],
        result,
        type: result.type,
        loc,
      };
    }
    // An X509Certificate serializes through its toJSON, which answers its
    // PEM: the JSON text is that string's (a root string takes no
    // indentation).
    if (isX509Type(lowerer, value.type))
      return { kind: "jsonStringify", value: x509ToString(value, loc), type: STRING, loc };
    const optionalString = lowerOptionalStringifyRoot(lowerer, value, indent, loc);
    if (optionalString) return optionalString;
    // A null root is the text "null" (Node never writes its unit literal
    // through the typed serializer, which rejects a bare unit).
    if (value.type.kind === "nullT")
      return constantStringifyRoot(
        lowerer,
        call,
        value,
        { kind: "strLit", value: "null", type: STRING, loc },
        loc,
      );
    const maybeUndefined = lowerMaybeUndefinedStringifyRoot(
      lowerer,
      value,
      indent,
      loc,
      argNode,
      call,
    );
    if (maybeUndefined) return maybeUndefined;
    // A program class instance whose class (or a base) declares toJSON:
    // JSON.stringify serializes whatever toJSON(key) returns, so the
    // instance crosses into the runtime walker, which calls the hook
    // through the checked-dynamic class view.
    const toJsonClass =
      value.type.kind === "object" &&
      lowerer.findMethodOn(lowerer.classes.get(value.type.className) ?? null, "toJSON") !== null &&
      lowerer.dynConvertible(value.type);
    // A record that declares toJSON is serialized by the runtime walker for
    // the same reason: the method runs with the record as receiver, and the
    // value it answers is what gets serialized. Its other methods stay
    // function-valued properties, which Node omits.
    const toJsonRecord = recordDeclaresToJson(lowerer, value.type);
    if (toJsonRecord && !lowerer.dynConvertible(value.type)) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
          `(the record declares toJSON, which must be called, and the value cannot cross ` +
          `into the checked-dynamic boundary)`,
      );
    }
    // A Buffer serializes through its toJSON ({ type: "Buffer", data }), and
    // another typed array as an object keyed by index: the runtime walker
    // tells them apart by the box.
    if (
      value.type.kind === "url" ||
      value.type.kind === "dyn" ||
      value.type.kind === "bytes" ||
      toJsonClass ||
      toJsonRecord ||
      isJsonStringifyDynamicType(
        value.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      ) ||
      isJsonStringifyRuntimeScalarType(
        value.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      const unreadable = classFieldWithoutJsonView(lowerer, value.type, new Set());
      if (unreadable !== null) {
        lowerer.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify of '${lowerer.fmt(value.type)}' values (field '${unreadable.field}' of class ` +
            `'${unreadable.className}' has type '${lowerer.fmt(unreadable.type)}', which the runtime JSON ` +
            `traversal cannot ${unreadable.reason})`,
        );
      }
      // Keep the original containers live while the runtime visits them:
      // a toJSON callback can mutate a later field, and shared/cyclic
      // references must retain their identities throughout traversal. A
      // union of scalars only (`bigint | number`, `symbol | string`) holds
      // no container: it converts by value.
      const boxed: IrExpr =
        value.type.kind === "dyn"
          ? value
          : {
              kind: "dynFrom",
              value,
              ...(isLiveDynRefType(value.type, (id) => lowerer.unions.get(id))
                ? { liveRef: true }
                : {}),
              type: DYN,
              loc,
            };
      const raw: IrExpr = {
        kind: "libCall",
        fn: "json.stringifyReplacer",
        args: [boxed, dynUndefinedExpr(loc), { kind: "strLit", value: indent, type: STRING, loc }],
        type: DYN,
        loc,
      };
      // A dyn root can serialize to undefined (undefined, a function, a
      // symbol). The result keeps the actual undefined unless every use
      // reads it as the text "undefined" (jsonResultTextOnly); those keep
      // the dyn-root string ABI.
      return (value.type.kind === "dyn" || toJsonClass || toJsonRecord) &&
        jsonResultTextOnly(lowerer, call)
        ? { kind: "toString", operand: raw, type: STRING, loc }
        : { kind: "dynCheck", value: raw, type: lowerer.withUndefinedArm(STRING), loc };
    }

    if (!lowerer.jsonStringifySafe(value.type)) {
      // Maybe-undefined roots took the walker above; everything left has no
      // serializer at all.
      lowerer.unsupported(
        "SC1090",
        argNode,
        `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
          `(only number, string, boolean, records, arrays, unions of those, and 'unknown' stringify)`,
      );
    }
    const node: IrExpr = { kind: "jsonStringify", value, type: STRING, loc };
    if (indent !== "") node.indent = indent;
    return node;
  }
  return null; // unknown members are tsc errors before lowering
}

/** Whether a record reachable from `t` declares a toJSON method. Such a type
 * cannot be serialized field by field: Node calls the method (with the record
 * as receiver) and serializes what it answers, so the value takes the runtime
 * walker. */
function recordDeclaresToJson(
  lowerer: Lowerer,
  t: IrType,
  visiting: Set<string> = new Set(),
): boolean {
  switch (t.kind) {
    case "array":
      return recordDeclaresToJson(lowerer, t.elem, visiting);
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined || visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      for (const field of shape.fields) {
        if (field.name === "toJSON" && field.type.kind === "func") return true;
        if (recordDeclaresToJson(lowerer, field.type, visiting)) return true;
      }
      return shape.indexValue !== undefined
        ? recordDeclaresToJson(lowerer, shape.indexValue, visiting)
        : false;
    }
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      const key = `union:${t.unionId}`;
      if (def === undefined || visiting.has(key)) return false;
      visiting.add(key);
      return def.arms.some((arm) => recordDeclaresToJson(lowerer, arm, visiting));
    }
    default:
      return false;
  }
}

/** True when a lowered type's value may be undefined at run time: the
 * undefined type itself, or a union with an undefined arm. */
export function jsonTypeMaybeUndefined(lowerer: Lowerer, t: IrType): boolean {
  // A call to a function declared to return undefined lowers to the void
  // type: its value is undefined, Node's stringify of it is not a string.
  if (t.kind === "undefinedT" || t.kind === "void") return true;
  if (t.kind !== "union") return false;
  const def = lowerer.unions.get(t.unionId);
  return def !== undefined && def.arms.some((arm) => arm.kind === "undefinedT");
}

/** True when a `JSON.stringify` root expression's checker type may be
 * undefined at run time: a bare undefined, a union with an undefined arm,
 * the dynamic boundary, an untyped JavaScript value, or a class whose
 * toJSON can answer undefined. */
export function jsonStringifyRootMaybeUndefined(lowerer: Lowerer, root: ts.Expression): boolean {
  const type = lowerer.typeOf(root);
  const mapped = lowerer.mapTypeOf(type);
  if (mapped === null) return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  if (mapped.kind === "dyn") return true;
  if (jsonTypeMaybeUndefined(lowerer, mapped)) return true;
  return (
    mapped.kind === "object" &&
    lowerer.findMethodOn(lowerer.classes.get(mapped.className) ?? null, "toJSON") !== null
  );
}

/** A `JSON.stringify` root that may be undefined: Node answers undefined
 * for it (JSON.stringify(undefined) is not a string at all), so the runtime
 * walker carries the missing root through and the result keeps the
 * undefined arm instead of being narrowed to the lib type's string. */
function lowerMaybeUndefinedStringifyRoot(
  lowerer: Lowerer,
  value: IrExpr,
  indent: string,
  loc: SrcLoc,
  argNode: ts.Expression,
  call: ts.CallExpression,
): IrExpr | null {
  if (value.type.kind === "undefinedT" || value.type.kind === "void") {
    const missing = lowerer.wrappedUndefined(lowerer.withUndefinedArm(STRING), loc);
    if (!missing)
      throw new InternalCompilerError("JSON.stringify of undefined needs an undefined arm");
    return constantStringifyRoot(lowerer, call, value, missing, loc);
  }
  if (!jsonTypeMaybeUndefined(lowerer, value.type)) return null;
  if (!lowerer.dynConvertible(value.type)) {
    lowerer.unsupported(
      "SC1090",
      argNode,
      `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
        `(the value may be undefined and cannot cross into the checked-dynamic boundary)`,
    );
  }
  // A record, array or class root stays a live reference while the walker
  // visits it: a toJSON hook can mutate a later field, as in Node. A union
  // of scalars only holds no container and converts by value.
  const boxed: IrExpr = {
    kind: "dynFrom",
    value,
    ...(isLiveDynRefType(value.type, (id) => lowerer.unions.get(id))
      ? { liveRef: true as const }
      : {}),
    type: DYN,
    loc,
  };
  const raw: IrExpr = {
    kind: "libCall",
    fn: "json.stringifyReplacer",
    args: [boxed, dynUndefinedExpr(loc), { kind: "strLit", value: indent, type: STRING, loc }],
    type: DYN,
    loc,
  };
  return { kind: "dynCheck", value: raw, type: lowerer.withUndefinedArm(STRING), loc };
}

/** A root whose answer is fixed by its value still evaluates every argument
 * expression, in source order: Node runs the root's own expression (a
 * `(f(), null)` operand keeps its call) and the replacer/space expressions
 * before the serializer can answer. */
function constantStringifyRoot(
  lowerer: Lowerer,
  call: ts.CallExpression,
  rootValue: IrExpr | null,
  result: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const stmts: IrStmt[] = [];
  call.arguments.nodes.forEach((node, index) => {
    const value = index === 0 && rootValue !== null ? rootValue : lowerer.lowerExpr(node);
    for (const stmt of evalOnlyStmts(value)) stmts.push(stmt);
  });
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** The statements that evaluate `value` for its effects alone: a unit or a
 * sequence ending in one contributes only its own effects (a bare unit
 * literal is not a value the emitter may write). */
function evalOnlyStmts(value: IrExpr): IrStmt[] {
  if (value.kind === "unitLit") return [];
  if (value.kind === "seqExpr") return [...value.stmts, ...evalOnlyStmts(value.result)];
  return [{ kind: "exprStmt", expr: value, loc: value.loc }];
}

function lowerOptionalStringifyRoot(
  lowerer: Lowerer,
  value: IrExpr,
  indent: string,
  loc: SrcLoc,
): IrExpr | null {
  const tags = optionalStringTags(lowerer, value.type);
  if (!tags || value.type.kind !== "union") return null;
  const resultT = lowerer.withUndefinedArm(STRING);
  const key = `json.optionalString:${value.type.unionId}:${JSON.stringify(indent)}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%json.optionalString", key);
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", value.type, loc);
    const serialized: IrExpr = {
      kind: "jsonStringify",
      value: {
        kind: "unionNarrow",
        unionId: value.type.unionId,
        tag: tags.stringTag,
        value: input,
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    };
    if (indent !== "") serialized.indent = indent;
    const missing = lowerer.wrappedUndefined(resultT, loc);
    if (!missing)
      throw new InternalCompilerError("optional JSON.stringify result needs an undefined arm");
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: value.type }],
      returnType: resultT,
      locals: [{ id: "value.0", name: "value", type: value.type, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: value.type.unionId,
            tag: tags.undefinedTag,
            negated: false,
            value: input,
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: missing, loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: lowerer.coerceToExpected(serialized, resultT), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: resultT, loc };
}

/** True when no use of a `JSON.stringify` result can tell undefined from
 * the text "undefined": the call is itself such a use (textOnlyUse), or it
 * initializes an unannotated `const` or `let` binding whose every
 * reference is one. The lib types say `string`, but the result is
 * undefined for a root that is undefined, a function or a symbol; every
 * other use (a comparison, `typeof`, a truth test, an array element, an
 * argument, a return value, a field) keeps the actual undefined. */
export function jsonResultTextOnly(lowerer: Lowerer, call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  if (textOnlyUse(lowerer, node as ts.Expression)) return true;
  const parent = node.parent;
  if (
    !ts.isVariableDeclaration(parent) ||
    parent.initializer !== node ||
    parent.type ||
    !ts.isIdentifier(parent.name) ||
    !ts.isVariableDeclarationList(parent.parent) ||
    !ts.isVariableStatement(parent.parent.parent) ||
    (ts.getModifiers(parent.parent.parent) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  )
    return false;
  const name = parent.name;
  const symbol = lowerer.checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  let textOnly = true;
  const visit = (current: ts.Node): void => {
    if (!textOnly) return;
    if (ts.isIdentifier(current)) {
      if (
        current !== name &&
        current.text === name.text &&
        lowerer.checker.getSymbolAtLocation(current) === symbol &&
        !textOnlyUse(lowerer, current)
      )
        textOnly = false;
      return;
    }
    ts.forEachChild(current, visit);
  };
  // The binding's references all lie in the block that declares it.
  let scope: ts.Node = parent;
  while (scope.parent && !ts.isBlock(scope.parent) && !ts.isSourceFile(scope.parent))
    scope = scope.parent;
  visit(scope.parent ?? scope);
  return textOnly;
}

/** A use that reads undefined and the text "undefined" alike: a discarded
 * value, a template span, a string literal's `+` operand, the argument of
 * `String(...)`, or a console argument that no format specifier renders. */
function textOnlyUse(lowerer: Lowerer, expr: ts.Expression): boolean {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
  if (ts.isTemplateSpan(parent)) return ts.isTemplateExpression(parent.parent);
  const text = (other: ts.Node): boolean => {
    while (ts.isParenthesizedExpression(other)) other = other.expression;
    return (
      ts.isStringLiteral(other) ||
      ts.isNoSubstitutionTemplateLiteral(other) ||
      ts.isTemplateExpression(other)
    );
  };
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return text(parent.left === node ? parent.right : parent.left);
  if (!ts.isCallExpression(parent) || !parent.arguments.nodes.includes(node as ts.Expression))
    return false;
  const callee = parent.expression;
  if (ts.isIdentifier(callee))
    return parent.arguments.nodes.length === 1 && lowerer.isStdlibGlobal(callee, "String");
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    !lowerer.isStdlibGlobal(callee.expression, "console") ||
    !["log", "error", "warn", "info", "debug"].includes(callee.name.text)
  )
    return false;
  // A leading string with a specifier formats the arguments after it.
  const first = parent.arguments.nodes[0]!;
  return first === node || !text(first) || !ts.getTextOfNode(first).includes("%");
}

/** True when a class field type holds a RegExp or a Promise outside a
 * nested class instance (whose own fields are checked separately): Node
 * writes both as {}, and the runtime JSON traversal has no writer for them. */
function holdsUnwritable(lowerer: Lowerer, t: IrType, visiting: Set<string>): boolean {
  switch (t.kind) {
    case "regex":
    case "promise":
      return true;
    case "array":
      return holdsUnwritable(lowerer, t.elem, visiting);
    case "record": {
      if (visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      return (
        (shape?.fields ?? []).some((field) => holdsUnwritable(lowerer, field.type, visiting)) ||
        (shape?.indexValue !== undefined && holdsUnwritable(lowerer, shape.indexValue, visiting))
      );
    }
    case "union": {
      if (visiting.has(t.unionId)) return false;
      visiting.add(t.unionId);
      return (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) =>
        holdsUnwritable(lowerer, arm, visiting),
      );
    }
    default:
      return false;
  }
}

/** The first class field reachable from a stringify input that the class's
 * checked-dynamic property view cannot represent, or that holds a RegExp or
 * a Promise, which the runtime JSON traversal cannot write. The traversal
 * reads class instances through that view, so such a class is refused at
 * compile time instead of throwing when the view is built or written. */
export function classFieldWithoutJsonView(
  lowerer: Lowerer,
  t: IrType,
  visiting: Set<string>,
): { className: string; field: string; type: IrType; reason: "read" | "write" } | null {
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  switch (t.kind) {
    case "array":
      return classFieldWithoutJsonView(lowerer, t.elem, visiting);
    case "record": {
      if (visiting.has(t.shapeId)) return null;
      visiting.add(t.shapeId);
      const shape = getRecord(t.shapeId);
      for (const field of shape?.fields ?? []) {
        const found = classFieldWithoutJsonView(lowerer, field.type, visiting);
        if (found) return found;
      }
      return shape?.indexValue
        ? classFieldWithoutJsonView(lowerer, shape.indexValue, visiting)
        : null;
    }
    case "union": {
      if (visiting.has(t.unionId)) return null;
      visiting.add(t.unionId);
      for (const arm of getUnion(t.unionId)?.arms ?? []) {
        const found = classFieldWithoutJsonView(lowerer, arm, visiting);
        if (found) return found;
      }
      return null;
    }
    case "object": {
      if (!isDynTypedRefType(t) || visiting.has(t.className)) return null;
      visiting.add(t.className);
      const info = lowerer.classes.get(t.className);
      for (const field of info?.def.fields ?? []) {
        if (!isClassOwnEnumerableFieldName(field.name)) continue;
        const unreadable = !classDynViewSupported([field], getRecord, getUnion);
        if (unreadable || holdsUnwritable(lowerer, field.type, new Set())) {
          const className =
            info?.def.jsName ?? info?.decl?.name?.text ?? t.className.replace(/^%/, "");
          return {
            className,
            field: field.name,
            type: field.type,
            reason: unreadable ? "read" : "write",
          };
        }
        const found = classFieldWithoutJsonView(lowerer, field.type, visiting);
        if (found) return found;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Only explicit null/undefined select the no-callback path. */
function jsonNullishArgument(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return jsonNullishArgument(lowerer, node.expression);
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (!ts.isIdentifier(node) || node.text !== "undefined") return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  return (
    symbol !== undefined &&
    symbol.declarations.every((decl) => lowerer.isStdlibFile(ts.getSourceFileOfNode(decl)))
  );
}

/** JSON callbacks cross the same checked native function boundary as other
 * runtime callbacks. Reviver source contexts need parser source tracking;
 * refuse signatures that request one until that protocol is implemented.
 * A replacer may also be an array of property names, which the runtime
 * reads as Node's PropertyList. */
function lowerJsonCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  role: "replacer" | "reviver",
): IrExpr {
  const callback = lowerer.lowerExpr(node);
  // Node passes a reviver three arguments: the key, the value and the
  // source context, which has no native form. A reviver that names two
  // parameters cannot tell; one that takes every argument can, whatever
  // type its value arrives as (held untyped by a constant, or lowered
  // against the two-parameter signature), so it takes the refusal below.
  const context = role === "reviver" && callbackTakesEveryArgument(lowerer, node);
  if (callback.type.kind === "dyn" && !context) return callback;
  if (
    !context &&
    role === "replacer" &&
    callback.type.kind === "array" &&
    lowerer.dynConvertible(callback.type)
  )
    return lowerer.coerceToExpected(callback, DYN);
  if (
    !context &&
    callback.type.kind === "union" &&
    lowerer.dynConvertible(callback.type) &&
    lowerer.unions
      .get(callback.type.unionId)
      ?.arms.every(
        (arm) =>
          isUnitType(arm) ||
          (role === "replacer" && arm.kind === "array") ||
          (arm.kind === "func" &&
            arm.params.length <= 2 &&
            (role !== "reviver" || (!arm.rest && !arm.argumentsAll))),
      )
  )
    return lowerer.coerceToExpected(callback, DYN);
  if (
    !context &&
    callback.type.kind === "func" &&
    callback.type.params.length <= 2 &&
    (role !== "reviver" || (!callback.type.rest && !callback.type.argumentsAll)) &&
    canBoxFuncIntoDyn(
      callback.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { kind: "dynFrom", value: callback, type: DYN, loc: locOf(node) };
  }
  lowerer.noLowering(
    `JSON ${role} of type '${lowerer.fmt(callback.type)}'`,
    node,
    role === "replacer"
      ? "use a native function taking key and value, or an array of property names"
      : "use a native function taking key and value; reviver source contexts are not supported yet",
  );
}

/** Compile-time Node gap rules: numbers clamp to 0–10 spaces and strings
 * truncate to ten UTF-16 code units. Callback validation is independent. */
function stringifySpaceIndent(lowerer: Lowerer, call: ts.CallExpression): string {
  const fence = (): never =>
    lowerer.noLowering(
      "JSON.stringify with replacer/space parameters",
      call,
      "the serializer is type-directed — shape the value before stringifying",
    );
  if (call.arguments.nodes.length <= 1) return "";
  const isUndefined = (e: ts.Expression): boolean => jsonNullishArgument(lowerer, e);
  if (call.arguments.nodes.length === 2) return "";
  const space = withoutParentheses(call.arguments.nodes[2]!);
  if (space.kind === ts.SyntaxKind.NullKeyword || isUndefined(space)) return "";
  if (ts.isNumericLiteral(space)) {
    const n = Number(space.text.replace(/_/g, ""));
    return " ".repeat(Math.min(10, Math.max(0, Math.trunc(n))));
  }
  // A negative space literal (`-2`) clamps to 0 — compact, like Node.
  if (
    ts.isPrefixUnaryExpression(space) &&
    space.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(withoutParentheses(space.operand))
  ) {
    return "";
  }
  if (ts.isStringLiteral(space) || ts.isNoSubstitutionTemplateLiteral(space)) {
    return space.text.slice(0, 10); // first 10 code units, like Node
  }
  fence();
  throw new InternalCompilerError("unreachable"); // fence() never returns
}

/** Stored stringify uses the same native serializer and keeps omitted roots
 * as undefined. Other JSON method values retain a named refusal. */
export function lowerJsonProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "JSON");
  if (member === null) return null;
  const value = jsonMemberValue(lowerer, member, locOf(expr));
  if (value !== null) return value;
  lowerer.unsupported("SC1090", expr, `JSON methods as values (call '${member}' directly)`);
}

/** The function value of the JSON member `member` (stringify and parse),
 * or null for members without one. */
export function jsonMemberValue(lowerer: Lowerer, member: string, loc: SrcLoc): IrExpr | null {
  if (member === "stringify") {
    const name = "%builtin.JSON.stringify";
    if (!lowerer.builtinCallableValueFns.has(name)) {
      lowerer.builtinCallableValueFns.set(name, name);
      const params = ["value", "replacer", "space"].map((name) => ({
        localId: name,
        name,
        type: DYN,
      }));
      lowerer.liftedFns.push({
        name,
        params,
        returnType: DYN,
        locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "json.stringifyValue",
              args: params.map((p) => varRef(p.localId, DYN, loc)),
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      });
    }
    return {
      kind: "dynFrom",
      value: {
        kind: "closure",
        fnName: name,
        captures: [],
        type: { kind: "func", params: [DYN, DYN, DYN], ret: DYN },
        loc,
      },
      fnName: "stringify",
      type: DYN,
      loc,
    };
  }
  if (member === "parse") {
    // JSON.parse as a value: ToString of the text, then the reviver form
    // (a reviver that is not a function is ignored, as in Node).
    const name = "%builtin.JSON.parse";
    if (!lowerer.builtinCallableValueFns.has(name)) {
      lowerer.builtinCallableValueFns.set(name, name);
      const params = ["text", "reviver"].map((name) => ({ localId: name, name, type: DYN }));
      lowerer.liftedFns.push({
        name,
        params,
        returnType: DYN,
        locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "json.parseReviver",
              args: [
                {
                  kind: "libCall",
                  fn: "dyn.toStringCoerce",
                  args: [varRef("text", DYN, loc)],
                  type: STRING,
                  loc,
                },
                varRef("reviver", DYN, loc),
              ],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      });
    }
    return {
      kind: "dynFrom",
      value: {
        kind: "closure",
        fnName: name,
        captures: [],
        type: { kind: "func", params: [DYN, DYN], ret: DYN },
        loc,
      },
      fnName: "parse",
      type: DYN,
      loc,
    };
  }
  return null;
}
