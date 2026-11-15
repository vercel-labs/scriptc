import { callbackTakesEveryArgument } from "../callback-arg.js";
import { widensReducedRecords } from "../function-returns.js";
import { keyedHelperName } from "../stable-names.js";
import { isDateJsonSource } from "./dates.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParentheses } from "../../outer-expressions.js";
import { type Lowerer } from "../lowerer.js";
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
        !widensReducedRecords(lowerer, narrowed, value.type)
      ) {
        const helper =
          narrowed.kind === "union"
            ? lowerer.narrowedRetagHelper(argNode, value.type.unionId, narrowed.unionId, loc)
            : lowerer.narrowedArmHelper(value.type.unionId, narrowed, loc);
        if (helper) value = { kind: "call", callee: helper, args: [value], type: narrowed, loc };
      }
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
    const optionalString = lowerOptionalStringifyRoot(lowerer, value, indent, loc);
    if (optionalString) return optionalString;
    // A program class instance whose class (or a base) declares toJSON:
    // JSON.stringify serializes whatever toJSON(key) returns, so the
    // instance crosses into the runtime walker, which calls the hook
    // through the checked-dynamic class view.
    const toJsonClass =
      value.type.kind === "object" &&
      lowerer.findMethodOn(lowerer.classes.get(value.type.className) ?? null, "toJSON") !== null &&
      lowerer.dynConvertible(value.type);
    // A Buffer serializes through its toJSON ({ type: "Buffer", data }), and
    // another typed array as an object keyed by index: the runtime walker
    // tells them apart by the box.
    if (
      value.type.kind === "url" ||
      value.type.kind === "dyn" ||
      value.type.kind === "bytes" ||
      toJsonClass ||
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
      return (value.type.kind === "dyn" || toJsonClass) && jsonResultTextOnly(lowerer, call)
        ? { kind: "toString", operand: raw, type: STRING, loc }
        : { kind: "dynCheck", value: raw, type: lowerer.withUndefinedArm(STRING), loc };
    }

    if (!lowerer.jsonStringifySafe(value.type)) {
      // Bare undefined-armed unions get their own wording: Node's
      // stringify of bare undefined is not a string at all — per-type
      // serialization cannot match that exactly, so the fence is
      // deliberate, not a gap. (Undefined-armed RECORD FIELDS pass the
      // fence: the field drops from the output, exactly Node.)
      if (lowerer.bareUndefinedArmedUnion(value.type)) {
        lowerer.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify of '${lowerer.fmt(value.type)}' values ` +
            `(Node's stringify of bare undefined is not a string at all — ` +
            `narrow with '!== undefined' first, model absence with a null arm, ` +
            `or use an optional record field ('{ a?: string }'), which drops ` +
            `from the output like Node's)`,
        );
      }
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
