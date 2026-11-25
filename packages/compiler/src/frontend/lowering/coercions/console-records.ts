/* The console object flowing into a record type (`const logger: Logger =
 * console`, `run(console)` into a `{ log, error }` parameter, a `logger ??
 * console` default): tsc accepts the flow because console has every member
 * the record declares.
 *
 * In Node the record IS console. Native code holds console as a
 * checked-dynamic handle and a record as a struct, so the flow is a copy,
 * as every width conversion is (SEMANTICS.md): each declared member is
 * read off console by name, and the value read is console's own function
 * for that member, adapted to the member's declared signature by the
 * ordinary checked conversion. A call through the record therefore runs
 * console's method with the arguments the caller passed, and
 * `logger.log === console.log` holds where the member's type lets the two
 * be compared.
 *
 * The decision is made here, at build time, from the record's declared
 * members:
 * - a member console answers as a function value (log, info, debug, warn,
 *   error) is that function;
 * - a member Node's console has but native code only lowers as a direct
 *   call (table, dir, time, trace, ...) refuses the flow by name;
 * - a member console does not have is `undefined` when the record lets it
 *   be absent, and refuses the flow by name otherwise (reachable only
 *   through an assertion: tsc rejects the plain flow).
 * No shape reaches the run-time "expected object, got console" check. */
import * as ts from "../../ts7/adapter.js";
import { BOOL, DYN, STRING, UNDEFINED_T, typeEquals } from "../../../ir/ir.js";
import type { IrExpr, IrRecordField, IrType, SrcLoc } from "../../../ir/ir.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { unsupportedDiag } from "../../../diagnostics/diagnostic.js";
import { isJsSourceFile } from "../../program.js";
import { keyedHelperName } from "../stable-names.js";
import { PoisonError, type Lowerer } from "../lowerer.js";

/** The console members that are function values (scr_console_native.c):
 * each formats its arguments with util.format and writes one line. */
export const CONSOLE_VALUE_MEMBERS: ReadonlySet<string> = new Set([
  "log",
  "info",
  "debug",
  "warn",
  "error",
]);

/** Node's enumeration order of the console object's own keys: the value
 * members above, then the keys whose only lowering is the direct call (or
 * `new console.Console`). A copy of console (an object spread) lists them
 * in this order; scr_console_native.c answers each as a function. */
export const CONSOLE_KEY_ORDER: readonly string[] = [
  "log",
  "info",
  "debug",
  "warn",
  "error",
  "dir",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "assert",
  "clear",
  "count",
  "countReset",
  "group",
  "groupEnd",
  "table",
  "dirxml",
  "groupCollapsed",
  "Console",
  "profile",
  "profileEnd",
  "timeStamp",
  "context",
  "createTask",
];

const CONSOLE_KEYS: ReadonlySet<string> = new Set(CONSOLE_KEY_ORDER);

/** The read of the global console object (identifiers.ts,
 * property-access.ts, global-values.ts). */
export function isConsoleObjectRead(expr: IrExpr): boolean {
  return expr.kind === "libCall" && expr.fn === "console.native";
}

/** Whether `node`, with its wrappers peeled, spells the global console. */
export function isConsoleExpression(lowerer: Lowerer, node: ts.Expression): boolean {
  let source = node;
  while (
    ts.isParenthesizedExpression(source) ||
    ts.isAsExpression(source) ||
    ts.isTypeAssertion(source) ||
    ts.isSatisfiesExpression(source) ||
    ts.isNonNullExpression(source)
  )
    source = source.expression;
  return ts.isIdentifier(source) && lowerer.isStdlibGlobal(source, "console");
}

/** The record type a slot of type `t` holds when it holds exactly one,
 * beside `undefined` and `null` (`Logger`, `Logger | undefined`). */
export function soleRecordArm(lowerer: Lowerer, t: IrType): IrType | null {
  if (t.kind === "record") return t;
  if (t.kind !== "union") return null;
  const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
  const values = arms.filter((arm) => arm.kind !== "undefinedT" && arm.kind !== "nullT");
  return values.length === 1 && values[0]!.kind === "record" ? values[0]! : null;
}

/** Whether `node`, with its assertions peeled, is typed as the standard
 * library's console object: @types/node's global `interface Console`, or
 * the object type the fallback declarations give `console`. A binding of
 * that type holds the checked-dynamic console value (type-mapper.ts). */
export function isConsoleTyped(lowerer: Lowerer, node: ts.Node): boolean {
  let source = node;
  while (
    ts.isParenthesizedExpression(source) ||
    ts.isAsExpression(source) ||
    ts.isTypeAssertion(source) ||
    ts.isSatisfiesExpression(source) ||
    ts.isNonNullExpression(source)
  )
    source = source.expression;
  const type = lowerer.typeOf(source);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return false;
  if (ts.symbolName(symbol) === "Console") return true;
  return symbol.declarations.some((declaration) => {
    if (!ts.isTypeLiteralNode(declaration)) return false;
    const holder = declaration.parent;
    return (
      holder !== undefined &&
      ts.isVariableDeclaration(holder) &&
      ts.isIdentifier(holder.name) &&
      holder.name.text === "console"
    );
  });
}

/** console's own keys that are not enumerable (Node's internal slots). */
const CONSOLE_HIDDEN_KEYS: readonly string[] = [
  "_stdout",
  "_stderr",
  "_stdoutErrorHandler",
  "_stderrErrorHandler",
  "_ignoreErrors",
  "_times",
];

/** The members console inherits from Object.prototype. */
const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Every key `in` finds on console: its own keys, enumerable or not, and
 * the members it inherits from Object.prototype. */
const CONSOLE_IN_KEYS: readonly string[] = [
  ...CONSOLE_KEY_ORDER,
  ...CONSOLE_HIDDEN_KEYS,
  ...OBJECT_PROTOTYPE_KEYS,
];

/** `key in console`: a key known at build time folds to Node's answer; a
 * string computed at run time is tested against the same set of keys, so
 * the two spellings agree. The set is a table keyed by `"k:" + name`: the
 * prefix keeps names such as `__proto__` and `constructor` ordinary table
 * keys. Null for a key of another type, which keeps the ordinary
 * lowering. */
export function consoleHasKey(
  lowerer: Lowerer,
  keyNode: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  const folded = lowerer.foldedStringKeyOf(keyNode);
  if (folded !== null)
    return { kind: "boolLit", value: CONSOLE_IN_KEYS.includes(folded), type: BOOL, loc };
  const key = lowerer.lowerExpr(keyNode);
  if (key.type.kind !== "string") return null;
  const prefix = (name: IrExpr): IrExpr => ({
    kind: "strConcat",
    left: { kind: "strLit", value: "k:", type: STRING, loc },
    right: name,
    type: STRING,
    loc,
  });
  const table: IrExpr = {
    kind: "dynObjLit",
    fields: CONSOLE_IN_KEYS.map((name) => ({
      key: { kind: "strLit", value: `k:${name}`, type: STRING, loc },
      value: lowerer.coerceToExpected({ kind: "boolLit", value: true, type: BOOL, loc }, DYN),
    })),
    type: DYN,
    loc,
  };
  return {
    kind: "dynTest",
    test: "undefined",
    negated: true,
    value: { kind: "dynKeyGet", value: table, key: prefix(key), type: DYN, loc },
    type: BOOL,
    loc,
  };
}

/** Whether the value `node` reads is only tested, never kept: the operand
 * of `typeof`, of `!`, the left of `&&`, or a condition. Such a read of any
 * console key answers as Node does (every key holds a function). */
function isTestedOnly(node: ts.Expression): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    current = parent;
    parent = current.parent;
  }
  if (parent === undefined) return false;
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isConditionalExpression(parent)) return parent.condition === current;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
    return parent.expression === current;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

/** A TypeScript source naming a console key as a VALUE (`const t =
 * console.table`, `const { time } = console`, `onError = console.trace`):
 * only log, info, debug, warn and error are function values. The others
 * lower as direct calls alone, so keeping one as a value is refused here,
 * by name, rather than at the call that would later go through it.
 * JavaScript sources keep the dynamic tier's rule: the read answers a
 * function, and calling it is the boundary (scr_console_native.c). */
export function fenceConsoleMemberValue(
  lowerer: Lowerer,
  member: string,
  node: ts.Expression | ts.BindingElement,
): void {
  if (!CONSOLE_KEYS.has(member) || CONSOLE_VALUE_MEMBERS.has(member)) return;
  if (isJsSourceFile(ts.getSourceFileOfNode(node))) return;
  if (!ts.isBindingElement(node) && isTestedOnly(node)) return;
  lowerer.noLowering(
    `console.${member} as a value`,
    node,
    `console's log, info, debug, warn and error are function values; call console.${member} directly, or keep a function that does, such as (...args: unknown[]) => console.${member}(...args)`,
  );
}

/** A TypeScript source assigning a member of console (`console.log =
 * capture`): direct calls compile to the native writers and never read
 * the member, so the replacement could not take effect. Refused here, by
 * name, where the write is visible; a write through an untyped value
 * keeps the run-time refusal (scr_console_native.c). */
export function fenceConsoleMutation(lowerer: Lowerer, expr: ts.Expression): void {
  if (!ts.isBinaryExpression(expr)) return;
  const op = expr.operatorToken.kind;
  if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
  let target: ts.Expression = expr.left;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return;
  if (!lowerer.isStdlibGlobal(target.expression, "console")) return;
  if (isJsSourceFile(ts.getSourceFileOfNode(expr))) return;
  lowerer.noLowering(
    `assigning to '${ts.getTextOfNode(target)}'`,
    target,
    "console's members cannot be replaced: direct console calls compile to the native writers; route the output through a function or object the program owns instead",
  );
}

/** A plain object holding console's own enumerable keys, in Node's order:
 * what an object spread of console copies (`{ ...console, log: quiet }`).
 * `console` is the read of the console object, which has no effects. */
export function consoleOwnKeysObject(console: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "dynObjLit",
    fields: CONSOLE_KEY_ORDER.map((name) => {
      const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
      return { key, value: { kind: "dynKeyGet", value: console, key, type: DYN, loc } };
    }),
    type: DYN,
    loc,
  };
}

function refuse(lowerer: Lowerer, loc: SrcLoc, detail: string): never {
  lowerer.pushDiag(
    unsupportedDiag(
      "SC1090",
      loc,
      detail,
      "console's log, info, debug, warn and error are function values; pass an object literal that calls the other members, such as { table: (data: unknown) => console.table(data) }",
    ),
  );
  throw new PoisonError();
}

/** Whether a slot of type `t` can hold `undefined`. */
function admitsUndefined(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind === "dyn" || t.kind === "undefinedT") return true;
  return t.kind === "union" && lowerer.armTag(t.unionId, UNDEFINED_T) >= 0;
}

/** The value of one declared member, read off the console view `o`. */
function memberValue(lowerer: Lowerer, field: IrRecordField, target: string, loc: SrcLoc): IrExpr {
  if (field.name.startsWith("%"))
    refuse(lowerer, loc, `console flowing into '${target}', whose layout console cannot fill`);
  if (!CONSOLE_KEYS.has(field.name)) {
    if (!admitsUndefined(lowerer, field.type))
      refuse(
        lowerer,
        loc,
        `console flowing into '${target}', which requires the member '${field.name}' that console does not have`,
      );
    return lowerer.coerceToExpected(dynUndefinedExpr(loc), field.type);
  }
  if (!CONSOLE_VALUE_MEMBERS.has(field.name))
    refuse(
      lowerer,
      loc,
      `console flowing into '${target}', which declares 'console.${field.name}' as a member (only its direct call has a lowering)`,
    );
  const read: IrExpr = {
    kind: "dynKeyGet",
    value: varRef("o.0", DYN, loc),
    key: { kind: "strLit", value: field.name, type: STRING, loc },
    type: DYN,
    loc,
  };
  const value = lowerer.coerceToExpected(read, field.type);
  if (!typeEquals(value.type, field.type))
    refuse(
      lowerer,
      loc,
      `console flowing into '${target}', whose member '${field.name}' of type '${lowerer.fmt(field.type)}' cannot hold console's function`,
    );
  return value;
}

/** Interned `%console.record.<n>(o)`: the record of console's members the
 * shape declares. `expr` is the checked-dynamic console value. */
export function consoleRecord(
  lowerer: Lowerer,
  expr: IrExpr,
  shapeId: string,
  loc: SrcLoc,
): IrExpr {
  const type: IrType = { kind: "record", shapeId };
  const shape = lowerer.shapes.get(shapeId);
  const target = lowerer.fmt(type);
  if (!shape || shape.tuple || shape.indexValue)
    refuse(lowerer, loc, `console flowing into '${target}', which is not a record of members`);
  const key = `console-record:${shapeId}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const fields = shape.fields.map((field) => ({
      name: field.name,
      value: memberValue(lowerer, field, target, loc),
    }));
    name = keyedHelperName(lowerer, "%console.record", key);
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "o.0", name: "o", type: DYN }],
      returnType: type,
      locals: [{ id: "o.0", name: "o", type: DYN, mutable: false }],
      body: [{ kind: "return", value: { kind: "recordLit", fields, type, loc }, loc }],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [expr], type, loc };
}

/** `logger === console` where `logger` is a record: the record is a copy
 * of console's members, so the comparison Node answers `true` for could
 * only answer `false`. Refused by name; comparing a member
 * (`logger.log === console.log`) is the question a record can answer. */
export function refuseConsoleRecordComparison(
  lowerer: Lowerer,
  node: ts.Node,
  leftNode: ts.Node,
  rightNode: ts.Node,
  left: IrExpr,
  right: IrExpr,
): void {
  const holdsRecord = (t: IrType): boolean =>
    t.kind === "record" ||
    (t.kind === "union" &&
      (lowerer.unions.get(t.unionId)?.arms.some((arm) => arm.kind === "record") ?? false));
  const isConsole = (expr: IrExpr, site: ts.Node): boolean =>
    isConsoleObjectRead(expr) || (expr.type.kind === "dyn" && isConsoleTyped(lowerer, site));
  const other = holdsRecord(right.type) && isConsole(left, leftNode) ? right : null;
  const record = other ?? (holdsRecord(left.type) && isConsole(right, rightNode) ? left : null);
  if (record === null) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `comparing console with a '${lowerer.fmt(record.type)}' value (a record that console flowed into holds console's members, not console itself)`,
    "compare a member instead, such as logger.log === console.log, or keep the logger in a slot typed 'unknown' or 'Console'",
  );
}

/** Console into a slot of type `expected`: the record itself, or the one
 * record arm of a union (`logger?: Logger`). Null when `expected` holds no
 * record, so the caller's ordinary conversion decides. */
export function consoleInto(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (expected.kind === "record") return consoleRecord(lowerer, expr, expected.shapeId, loc);
  if (expected.kind !== "union") return null;
  const arms = lowerer.unions.get(expected.unionId)?.arms ?? [];
  // A union that can hold the checked-dynamic value keeps console itself.
  if (arms.some((arm) => arm.kind === "dyn")) return null;
  const records = arms.filter((arm) => arm.kind === "record");
  if (records.length === 0) return null;
  if (records.length > 1)
    refuse(
      lowerer,
      loc,
      `console flowing into '${lowerer.fmt(expected)}', which has more than one record type console could fill`,
    );
  const record = records[0] as IrType & { kind: "record" };
  return lowerer.coerceToExpected(consoleRecord(lowerer, expr, record.shapeId, loc), expected);
}
