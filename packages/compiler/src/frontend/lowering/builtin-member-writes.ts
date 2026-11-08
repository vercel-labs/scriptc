/* The writes to members of built-in objects that a program spells out.
 *
 * Compiled code reaches a built-in member through its native entry point and
 * never reads the member from its object, so a program that replaces or
 * deletes one (`Array.prototype.push = f`, `Math.random = f`, `delete
 * JSON.parse`) and then uses it natively would keep running the built-in.
 * This module finds the write: the object, the key and the node. Lowering
 * records each one it meets and lowers it as before; when the program is
 * lowered, builtin-member-readers.ts refuses the writes whose member the
 * program also uses through code that does not look at the object (SC1092).
 * A write the build cannot see, where the object or the key arrives as a
 * value, is not recorded.
 *
 * A write counts when the member exists, which is a fact of the pinned Node
 * release (builtin-object-members.generated.ts): an own member of the
 * object, or one it inherits from another built-in object, which the write
 * would shadow. Adding a member the object does not have is not a
 * replacement, except for the names built-in operations ask every object
 * for (`then`, `toJSON`, `Symbol.iterator`, `Symbol.toPrimitive`): added to
 * a built-in prototype, such a member changes what those operations do.
 *
 * A feature test of an existing member (`if (!Array.prototype.at)`) in
 * front of such a write has one answer in a program that does not change
 * the member elsewhere, and the polyfill it guards is code Node 24 never
 * runs: lowering decides the test, records that it did, and a program that
 * also writes the tested member where the test would see it is refused. */
import * as ts from "../ts7/adapter.js";
import {
  BUILTIN_OBJECT_INHERITS,
  BUILTIN_OBJECT_MEMBERS,
} from "./builtin-object-members.generated.js";
import type { Lowerer } from "./lowerer.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { isStrictCode } from "../program.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** f: a function; a: an accessor; t: other data that is truthy; z: other
 * data that is falsy. */
export type BuiltinMemberKind = "f" | "a" | "t" | "z";

let rows: Map<string, Map<string, BuiltinMemberKind>> | null = null;
let memberNames: Set<string> | null = null;
/** The members ("Owner name") an assignment cannot change, and the ones
 * that are not configurable. */
let unassignable: Set<string> | null = null;
let unconfigurable: Set<string> | null = null;

function table(): Map<string, Map<string, BuiltinMemberKind>> {
  if (rows !== null) return rows;
  rows = new Map();
  memberNames = new Set();
  unassignable = new Set();
  unconfigurable = new Set();
  for (const [owner, row] of Object.entries(BUILTIN_OBJECT_MEMBERS)) {
    const members = new Map<string, BuiltinMemberKind>();
    for (const item of row.split(" ")) {
      if (item === "") continue;
      let at = 1;
      const fixed = item[at] === "-";
      if (fixed) at++;
      const sealed = item[at] === "=";
      if (sealed) at++;
      const name = item.slice(at);
      members.set(name, item[0] as BuiltinMemberKind);
      memberNames.add(name);
      if (fixed) unassignable.add(`${owner} ${name}`);
      if (sealed) unconfigurable.add(`${owner} ${name}`);
    }
    rows.set(owner, members);
  }
  return rows;
}

/** How a write reaches a member: an assignment (`=`, `Reflect.set`,
 * `Object.assign`), a definition (`Object.defineProperty`) or a deletion. */
type WriteForm = "assign" | "define" | "delete";

/** Whether Node lets the write change what a read of `owner.member` finds.
 * An assignment to data that is not writable, or to an accessor without a
 * setter, changes nothing (and throws in strict code), also when the member
 * is inherited; a deletion of an own member that is not configurable is
 * refused, and so is a definition over one unless it is writable data, whose
 * value a definition may still change (`Array.prototype.length`); deleting
 * a member the object only inherits deletes nothing. */
function writeTakesEffect(owner: string, member: string, form: WriteForm): boolean {
  table();
  const own = builtinOwnMemberKind(owner, member) !== null;
  const name = `${owner} ${member}`;
  if (form === "delete") return own && !unconfigurable!.has(name);
  if (form === "define") return !own || !unconfigurable!.has(name) || !unassignable!.has(name);
  for (let at: string | undefined = owner; at !== undefined; at = BUILTIN_OBJECT_INHERITS[at])
    if (builtinOwnMemberKind(at, member) !== null) return !unassignable!.has(`${at} ${member}`);
  return true;
}

/** The kind of `owner`'s own member `member`, or null when the built-in
 * object has no such own member. */
export function builtinOwnMemberKind(owner: string, member: string): BuiltinMemberKind | null {
  return table().get(owner)?.get(member) ?? null;
}

/** The kind of the member a read of `owner.member` finds: the object's own
 * member, or the one it inherits from another built-in object. Null when no
 * built-in object on the chain has it. */
export function builtinMemberKind(owner: string, member: string): BuiltinMemberKind | null {
  for (let at: string | undefined = owner; at !== undefined; at = BUILTIN_OBJECT_INHERITS[at]) {
    const kind = builtinOwnMemberKind(at, member);
    if (kind !== null) return kind;
  }
  return null;
}

/** A member of a built-in object, as a program spells it. */
export interface BuiltinMember {
  /** The object: "Array", "Array.prototype", "Math", "globalThis". */
  owner: string;
  /** The key; a well-known symbol is "@@iterator". */
  member: string;
  kind: BuiltinMemberKind;
}

/** A built-in member as a program names it: `Array.prototype.push`,
 * `Array.prototype[Symbol.iterator]`. */
export function builtinMemberName(owner: string, member: string): string {
  return member.startsWith("@@") ? `${owner}[Symbol.${member.slice(2)}]` : `${owner}.${member}`;
}

/** The built-in objects a read of a member through `start` passes, nearest
 * first: the object, then each built-in it inherits from. */
export function builtinObjectChain(start: string): string[] {
  const chain: string[] = [];
  for (let at: string | undefined = start; at !== undefined; at = BUILTIN_OBJECT_INHERITS[at])
    chain.push(at);
  return chain;
}

/** Whether `name` is a built-in object of the census. */
export function isBuiltinObjectName(name: string): boolean {
  return table().has(name);
}

/** The names built-in operations ask every object for, whether or not a
 * built-in defines them: adding one to a built-in prototype changes what
 * awaiting, serializing, iterating or converting its values does. */
const PROTOCOL_MEMBERS: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "@@iterator",
  "@@toPrimitive",
]);

/** The `const` initializer an identifier is bound to, for an alias of a
 * built-in object (`const proto = Array.prototype`). A `let` or `var` can be
 * reassigned, so only the runtime can tell what it holds. */
function constInitializer(lowerer: Lowerer, id: ts.Identifier): ts.Expression | null {
  const symbol = lowerer.checker.getSymbolAtLocation(id);
  const decl = symbol?.declarations[0];
  if (decl === undefined || symbol!.declarations.length !== 1) return null;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  if (decl.initializer === undefined || !ts.isVariableDeclarationList(decl.parent)) return null;
  return (decl.parent.flags & ts.NodeFlags.Const) !== 0 ? decl.initializer : null;
}

/** The built-in object `expr` denotes ("Array", "Array.prototype", "Math",
 * "globalThis"), through parentheses, type-only wrappers, the global
 * object's spellings and `const` aliases. Null for every other expression. */
export function builtinObjectOf(lowerer: Lowerer, expr: ts.Expression, depth = 0): string | null {
  const e = withoutParenthesesTypeWrappers(expr);
  if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && e.name.text === "prototype") {
    const base = builtinObjectOf(lowerer, e.expression, depth);
    if (base !== null) return table().has(`${base}.prototype`) ? `${base}.prototype` : null;
  }
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const name = stdlibGlobalNameOf(lowerer, e);
    if (name !== null) return table().has(name) ? name : null;
  }
  if (ts.isIdentifier(e) && depth < 4) {
    const init = constInitializer(lowerer, e);
    if (init !== null) return builtinObjectOf(lowerer, init, depth + 1);
  }
  const instance = prototypeOperand(lowerer, e);
  return instance === null ? null : literalPrototype(lowerer, instance);
}

/** The value whose prototype `e` reads: `Object.getPrototypeOf(v)`,
 * `Reflect.getPrototypeOf(v)` or `v.__proto__`. */
function prototypeOperand(lowerer: Lowerer, e: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(e) && e.name.text === "__proto__") return e.expression;
  if (!ts.isCallExpression(e) || e.arguments.nodes.length !== 1) return null;
  const callee = withoutParenthesesTypeWrappers(e.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "getPrototypeOf" ||
    !ts.isIdentifier(callee.expression)
  )
    return null;
  const holder = callee.expression.text;
  if (holder !== "Object" && holder !== "Reflect") return null;
  return stdlibGlobalNameOf(lowerer, callee.expression) === holder ? e.arguments.nodes[0]! : null;
}

/** The built-in prototype of a value the source spells out: an array,
 * object, regular expression or function literal, or `new X(…)` of a
 * built-in constructor. */
function literalPrototype(lowerer: Lowerer, value: ts.Expression): string | null {
  const v = withoutParenthesesTypeWrappers(value);
  if (ts.isArrayLiteralExpression(v)) return "Array.prototype";
  if (ts.isObjectLiteralExpression(v)) return setsOwnPrototype(v) ? null : "Object.prototype";
  if (ts.isRegularExpressionLiteral(v)) return "RegExp.prototype";
  if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) return "Function.prototype";
  if (ts.isNewExpression(v) && ts.isIdentifier(v.expression)) {
    const name = stdlibGlobalNameOf(lowerer, v.expression);
    return name !== null && table().has(`${name}.prototype`) ? `${name}.prototype` : null;
  }
  return null;
}

/** Whether an object literal names its prototype (`{ __proto__: null }`):
 * the one member that sets the prototype instead of defining a property. */
function setsOwnPrototype(literal: ts.ObjectLiteralExpression): boolean {
  for (const member of literal.properties.nodes) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = member.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "__proto__")
      return true;
  }
  return false;
}

/** A literal that is a value and nothing else: a number, a string, a
 * boolean or null. */
function isPlainLiteral(e: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Whether making a value the source spells out runs none of the program's
 * code and cannot throw: a literal, a function, or an array or object
 * literal of such values under plain names. Anything else in it (a call, a
 * read of a binding, a spread, a computed key, `new X(…)`) is evaluated for
 * what it does. */
function spellsInertValue(value: ts.Expression, depth = 0): boolean {
  const v = withoutParenthesesTypeWrappers(value);
  if (
    isPlainLiteral(v) ||
    ts.isNoSubstitutionTemplateLiteral(v) ||
    ts.isBigIntLiteral(v) ||
    ts.isRegularExpressionLiteral(v) ||
    ts.isFunctionExpression(v) ||
    ts.isArrowFunction(v)
  )
    return true;
  if (depth > 8) return false;
  if (ts.isArrayLiteralExpression(v)) {
    for (const element of v.elements.nodes)
      if (!ts.isOmittedExpression(element) && !spellsInertValue(element, depth + 1)) return false;
    return true;
  }
  if (!ts.isObjectLiteralExpression(v)) return false;
  for (const member of v.properties.nodes) {
    // A method or an accessor is defined, not run.
    if (ts.isSpreadAssignment(member) || ts.isShorthandPropertyAssignment(member)) return false;
    if (member.name === undefined || ts.isComputedPropertyName(member.name)) return false;
    if (ts.isPropertyAssignment(member) && !spellsInertValue(member.initializer, depth + 1))
      return false;
  }
  return true;
}

/** Whether a read of `id` can come before the binding it names is
 * initialized, where Node throws (`const`) or reads undefined (`var`): the
 * name of a variable this file declares with an initializer, read anywhere
 * but after the declaring statement in that statement's own list. The
 * earlier statement of a list has run when a later one does, and a function
 * a later statement creates cannot be called before it; a function
 * declaration is hoisted, so one in the list can be. A global has no such
 * declaration. */
function mayReadBeforeInitializer(lowerer: Lowerer, id: ts.Identifier): boolean {
  const decl = lowerer.checker.getSymbolAtLocation(id)?.declarations[0];
  if (decl === undefined || ts.getSourceFileOfNode(decl) !== ts.getSourceFileOfNode(id))
    return false;
  if (ts.isVariableDeclaration(decl)) {
    if (decl.initializer === undefined) return false;
  } else if (!ts.isBindingElement(decl)) return false;
  let statement: ts.Node | undefined = decl;
  while (statement !== undefined && !ts.isVariableStatement(statement)) {
    if (ts.isFunctionLike(statement) || ts.isStatement(statement)) return true;
    statement = statement.parent;
  }
  const list = statement?.parent;
  if (statement === undefined || list === undefined) return true;
  if (!ts.isBlock(list) && !ts.isSourceFile(list) && !ts.isModuleBlock(list)) return true;
  // The outermost function between the read and the list decides: one the
  // list declares can run before the list's statements do.
  let hoisted = false;
  let child: ts.Node = id;
  for (let at = id.parent; at !== undefined; child = at, at = at.parent) {
    if (at === list) return hoisted || child === statement || child.pos < statement.end;
    if (ts.isFunctionLike(at)) hoisted = ts.isFunctionDeclaration(at);
  }
  return true;
}

/** Whether evaluating a member access or a built-in object expression
 * (builtinMemberOf, builtinObjectOf) can do anything but answer: it reads
 * the prototype of a value the source spells out, and making that value runs
 * code (`Object.getPrototypeOf([effect()]).at`, `new Map(entries())
 * .__proto__`), or it starts at an alias that may not be initialized yet
 * (`probe(); const proto = Array.prototype`, where `probe` reads `proto`).
 * A global, an alias declared by an earlier statement and the prototype of
 * an inert literal (`Object.getPrototypeOf([])`) only answer. Every other
 * part of such an expression is a name or a literal key. */
function readRuns(lowerer: Lowerer, expr: ts.Expression): boolean {
  let e = withoutParenthesesTypeWrappers(expr);
  for (;;) {
    const instance = prototypeOperand(lowerer, e);
    if (instance !== null) return !spellsInertValue(instance);
    if (ts.isIdentifier(e)) return mayReadBeforeInitializer(lowerer, e);
    if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
    e = withoutParenthesesTypeWrappers(e.expression);
  }
}

/** The key a member access names without evaluating anything: a property
 * name, a string or number literal, or a well-known symbol. */
export function staticMemberKey(lowerer: Lowerer, access: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(access))
    return ts.isIdentifier(access.name) ? access.name.text : null;
  if (!ts.isElementAccessExpression(access)) return null;
  const key = withoutParenthesesTypeWrappers(access.argumentExpression);
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  if (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    stdlibGlobalNameOf(lowerer, key.expression) === "Symbol"
  )
    return `@@${key.name.text}`;
  return null;
}

/** The names a chain that reaches a built-in object can start at: the
 * built-in globals and the global object's spellings. */
let ownerRoots: Set<string> | null = null;

function ownerRootNames(): Set<string> {
  if (ownerRoots !== null) return ownerRoots;
  ownerRoots = new Set(["globalThis", "global"]);
  for (const name of table().get("globalThis")!.keys()) ownerRoots.add(name);
  return ownerRoots;
}

/** Whether `init` can denote a built-in object by its syntax alone: a chain
 * rooted at a built-in global or at an alias already found, or a read of a
 * value's prototype. */
function initializerMayNameBuiltin(init: ts.Expression, aliases: ReadonlySet<string>): boolean {
  let e = withoutParenthesesTypeWrappers(init);
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text === "__proto__") return true;
      e = withoutParenthesesTypeWrappers(e.expression);
    } else if (ts.isElementAccessExpression(e)) e = withoutParenthesesTypeWrappers(e.expression);
    else break;
  }
  if (ts.isIdentifier(e)) return ownerRootNames().has(e.text) || aliases.has(e.text);
  if (!ts.isCallExpression(e)) return false;
  const callee = withoutParenthesesTypeWrappers(e.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getPrototypeOf";
}

const VARIABLE_DECLARATIONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableDeclaration,
]);

/** The `const` names of a file whose initializer can denote a built-in
 * object (`const proto = Array.prototype`), found once per file by syntax
 * alone and kept on the lowering pass (lowering moves between files as it
 * follows what is reached). Nearly every member write in a program starts
 * at some other name, and this set is what lets it skip the checker. */
function aliasNames(lowerer: Lowerer, sf: ts.SourceFile): Set<string> {
  const known = lowerer.builtinAliasNames.get(sf);
  if (known !== undefined) return known;
  const found = new Set<string>();
  ts.walkPreorder(
    sf,
    (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer !== undefined &&
        ts.isVariableDeclarationList(n.parent) &&
        (n.parent.flags & ts.NodeFlags.Const) !== 0 &&
        initializerMayNameBuiltin(n.initializer, found)
      )
        found.add(n.name.text);
    },
    VARIABLE_DECLARATIONS,
  );
  lowerer.builtinAliasNames.set(sf, found);
  return found;
}

/** Whether the member chain `expr` can reach a built-in object, by syntax
 * alone: it starts at a built-in global, at a `const` alias of one, or reads
 * a value's prototype (`Object.getPrototypeOf([])`, `[].__proto__`). The
 * cheap test in front of every checker query here. */
function mayNameBuiltin(lowerer: Lowerer, expr: ts.Expression): boolean {
  let e = withoutParenthesesTypeWrappers(expr);
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text === "__proto__") return true;
      e = withoutParenthesesTypeWrappers(e.expression);
    } else if (ts.isElementAccessExpression(e)) e = withoutParenthesesTypeWrappers(e.expression);
    else break;
  }
  if (ts.isIdentifier(e))
    return (
      ownerRootNames().has(e.text) || aliasNames(lowerer, ts.getSourceFileOfNode(e)).has(e.text)
    );
  if (!ts.isCallExpression(e)) return false;
  const callee = withoutParenthesesTypeWrappers(e.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getPrototypeOf";
}

/** The built-in member `expr` reads or writes: `Array.prototype.push`,
 * `Math["random"]`, `globalThis.JSON`, or a bare `Array` (a member of the
 * global object). Null when the object is not a built-in, the key is not
 * static, or the object has no such member. */
export function builtinMemberOf(lowerer: Lowerer, expr: ts.Expression): BuiltinMember | null {
  const e = withoutParenthesesTypeWrappers(expr);
  table();
  if (ts.isIdentifier(e)) {
    const kind = builtinOwnMemberKind("globalThis", e.text);
    if (kind === null || stdlibGlobalNameOf(lowerer, e) !== e.text) return null;
    return { owner: "globalThis", member: e.text, kind };
  }
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return null;
  if (e.questionDotToken !== undefined) return null;
  const member = staticMemberKey(lowerer, e);
  if (member === null || !memberNames!.has(member) || !mayNameBuiltin(lowerer, e.expression))
    return null;
  const owner = builtinObjectOf(lowerer, e.expression);
  if (owner === null) return null;
  const kind = builtinMemberKind(owner, member);
  return kind === null ? null : { owner, member, kind };
}

/** Whether `expr` may name a built-in object by its syntax alone
 * (mayNameBuiltin), for callers that resolve it with builtinObjectOf. */
export function mayNameBuiltinObject(lowerer: Lowerer, expr: ts.Expression): boolean {
  return mayNameBuiltin(lowerer, expr);
}

/** A member a write would give a built-in object: an existing member it
 * replaces, deletes or shadows, or a protocol member it adds to a
 * prototype. */
interface WriteTarget {
  owner: string;
  member: string;
  /** Null when the object has no such member and the write adds it. */
  kind: BuiltinMemberKind | null;
}

function writeTargetIn(owner: string, member: string): WriteTarget | null {
  const kind = builtinMemberKind(owner, member);
  if (kind !== null) return { owner, member, kind };
  return owner.endsWith(".prototype") && PROTOCOL_MEMBERS.has(member)
    ? { owner, member, kind: null }
    : null;
}

/** The member the target of an assignment, update or `delete` names
 * (builtinMemberOf), or the protocol member it would add. */
function writeTargetOf(lowerer: Lowerer, expr: ts.Expression): WriteTarget | null {
  const e = withoutParenthesesTypeWrappers(expr);
  if (ts.isIdentifier(e)) return builtinMemberOf(lowerer, e);
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return null;
  if (e.questionDotToken !== undefined) return null;
  const member = staticMemberKey(lowerer, e);
  table();
  // Every protocol member is some built-in's member, so one name test
  // serves both kinds of write.
  if (member === null || !memberNames!.has(member) || !mayNameBuiltin(lowerer, e.expression))
    return null;
  const owner = builtinObjectOf(lowerer, e.expression);
  return owner === null ? null : writeTargetIn(owner, member);
}

/** A built-in member the runtime models as program state: assigning it is
 * what the member is for, and compiled code reads the assigned value. */
function isAssignableState(target: { owner: string; member: string }): boolean {
  return target.owner === "Error" && target.member === "stackTraceLimit";
}

/** Whether a read of the member always answers a value that is neither
 * undefined nor null, and truthy: a function or truthy data. An accessor
 * runs code, and falsy data is falsy. */
function alwaysTruthy(member: BuiltinMember): boolean {
  return member.kind === "f" || member.kind === "t";
}

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    (kind >= ts.SyntaxKind.FirstCompoundAssignment && kind <= ts.SyntaxKind.LastCompoundAssignment)
  );
}

/** `X.m ||= v` and `X.m ??= v` over a member that is always truthy never
 * assign, and `X.m = X.m || v` / `X.m = X.m ?? v` assign the member's own
 * value: the polyfill spellings that have no guard statement. `X.m = X.m`
 * over a data member assigns what it read. None of them replaces the
 * member; the ones that assign still lower as assignments
 * (isDeadBuiltinPolyfill). */
function keepsOwnValue(lowerer: Lowerer, write: ts.BinaryExpression, target: WriteTarget): boolean {
  if (target.kind === null) return false;
  const op = write.operatorToken.kind;
  const sameMember = (read: BuiltinMember | null): boolean =>
    read !== null && read.owner === target.owner && read.member === target.member;
  if (op === ts.SyntaxKind.EqualsToken && target.kind !== "a") {
    if (sameMember(builtinMemberOf(lowerer, write.right))) return true;
  }
  if (!alwaysTruthy({ ...target, kind: target.kind })) return false;
  if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken)
    return true;
  if (op !== ts.SyntaxKind.EqualsToken) return false;
  const value = withoutParenthesesTypeWrappers(write.right);
  if (!ts.isBinaryExpression(value)) return false;
  const inner = value.operatorToken.kind;
  if (inner !== ts.SyntaxKind.BarBarToken && inner !== ts.SyntaxKind.QuestionQuestionToken)
    return false;
  return sameMember(builtinMemberOf(lowerer, value.left));
}

/** A write to a member of a built-in object that the program spells out. */
export interface BuiltinMemberWrite {
  /** The object: "Array.prototype", "Math", "globalThis". */
  owner: string;
  /** The key; a well-known symbol is "@@iterator". */
  member: string;
  /** What the write does to the member: replace an existing one (or shadow
   * an inherited one), delete it, or add a protocol member the object does
   * not have. */
  action: "replace" | "delete" | "add";
  /** The assignment, update, `delete` or call. */
  node: ts.Node;
  /** The node to report: the member access, the call, or the literal member
   * of an `Object.assign` source. */
  at: ts.Node;
}

function writeOf(
  target: WriteTarget,
  form: WriteForm,
  node: ts.Node,
  at: ts.Node,
): BuiltinMemberWrite | null {
  if (!writeTakesEffect(target.owner, target.member, form)) return null;
  const action = form === "delete" ? "delete" : target.kind === null ? "add" : "replace";
  return { owner: target.owner, member: target.member, action, node, at };
}

/** The write to a built-in member that `node` is: an assignment, a compound
 * assignment, `++`/`--` or `delete` whose target is a member of a built-in
 * object, or a call that defines, assigns or deletes one
 * (`Object.defineProperty(Array.prototype, "push", …)`). Null for every
 * other node, for a write that keeps the member's own value, and for a
 * member the runtime models as assignable state. */
export function builtinMemberWriteOf(lowerer: Lowerer, node: ts.Node): BuiltinMemberWrite | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const target = writeTargetOf(lowerer, node.left);
    if (target === null || isAssignableState(target)) return null;
    if (keepsOwnValue(lowerer, node, target)) return null;
    return writeOf(target, "assign", node, node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const target = writeTargetOf(lowerer, node.operand);
    return target === null || isAssignableState(target)
      ? null
      : writeOf(target, "assign", node, node.operand);
  }
  if (ts.isDeleteExpression(node)) {
    const target = writeTargetOf(lowerer, node.expression);
    return target === null ? null : writeOf(target, "delete", node, node.expression);
  }
  if (ts.isCallExpression(node)) return builtinMemberWriteCall(lowerer, node);
  return null;
}

/** The static name of an object literal member, for the keys an
 * `Object.assign` or `Object.defineProperties` source spells: a name, a
 * string, or a well-known symbol (`[Symbol.iterator]`). */
function literalMemberName(lowerer: Lowerer, member: ts.ObjectLiteralElementLike): string | null {
  const name = member.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const key = withoutParenthesesTypeWrappers(name.expression);
    if (
      ts.isPropertyAccessExpression(key) &&
      ts.isIdentifier(key.expression) &&
      key.expression.text === "Symbol" &&
      stdlibGlobalNameOf(lowerer, key.expression) === "Symbol"
    )
      return `@@${key.name.text}`;
  }
  return null;
}

/** The calls that write a property of their first argument. */
function isWriteCall(holder: string, method: string): boolean {
  if (holder === "Object")
    return method === "defineProperty" || method === "defineProperties" || method === "assign";
  if (holder === "Reflect")
    return method === "defineProperty" || method === "set" || method === "deleteProperty";
  return false;
}

/** The write a call makes, as builtinMemberWriteOf answers it. A call that
 * copies or defines several members (`Object.assign`,
 * `Object.defineProperties`) makes one write per member: the first is the
 * answer, and with `all` every one is collected. */
function builtinMemberWriteCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  all: BuiltinMemberWrite[] | null = null,
): BuiltinMemberWrite | null {
  const callee = withoutParenthesesTypeWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const holder = callee.expression.text;
  const method = callee.name.text;
  if (!isWriteCall(holder, method)) return null;
  const args = call.arguments.nodes;
  const first = args[0];
  if (first === undefined || !mayNameBuiltin(lowerer, first)) return null;
  if (stdlibGlobalNameOf(lowerer, callee.expression) !== holder) return null;
  const owner = builtinObjectOf(lowerer, first);
  if (owner === null) return null;
  const hit = (member: string | null): WriteTarget | null => {
    if (member === null) return null;
    const target = writeTargetIn(owner, member);
    return target === null || isAssignableState(target) ? null : target;
  };
  if (method === "defineProperties" || method === "assign") {
    let found: BuiltinMemberWrite | null = null;
    for (const source of args.slice(1)) {
      const literal = withoutParenthesesTypeWrappers(source);
      if (!ts.isObjectLiteralExpression(literal)) continue;
      for (const member of literal.properties.nodes) {
        const target = hit(literalMemberName(lowerer, member));
        if (target === null) continue;
        // A descriptor that only changes the member's attributes is no
        // write, as for Object.defineProperty.
        if (
          method === "defineProperties" &&
          ts.isPropertyAssignment(member) &&
          keepsMemberValue(lowerer, member.initializer, target)
        )
          continue;
        const write = writeOf(target, method === "assign" ? "assign" : "define", call, member);
        if (write === null) continue;
        if (all === null) return write;
        all.push(write);
        found ??= write;
      }
    }
    return found;
  }
  const key = args[1] === undefined ? null : withoutParenthesesTypeWrappers(args[1]);
  if (key === null) return null;
  let member: string | null = null;
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) member = key.text;
  else if (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    stdlibGlobalNameOf(lowerer, key.expression) === "Symbol"
  )
    member = `@@${key.name.text}`;
  const target = hit(member);
  if (target === null) return null;
  if (method === "defineProperty" && keepsMemberValue(lowerer, args[2], target)) return null;
  const form = method === "deleteProperty" ? "delete" : method === "set" ? "assign" : "define";
  return writeOf(target, form, call, call);
}

/** Whether a property descriptor changes only the member's attributes: an
 * object literal with no accessor, and no value or the member's own
 * (`Object.defineProperty(Math, "trunc", { value: Math.trunc, writable:
 * false })`). The member compiled code calls stays the one the object
 * holds, and the runtime applies the attributes. */
function keepsMemberValue(
  lowerer: Lowerer,
  descriptor: ts.Expression | undefined,
  target: WriteTarget,
): boolean {
  if (target.kind === null) return false;
  const literal = descriptor === undefined ? undefined : withoutParenthesesTypeWrappers(descriptor);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return false;
  for (const member of literal.properties.nodes) {
    const name = literalMemberName(lowerer, member);
    if (name === null || name === "get" || name === "set") return false;
    if (name !== "value") continue;
    if (!ts.isPropertyAssignment(member)) return false;
    const read = builtinMemberOf(lowerer, member.initializer);
    if (read === null || read.owner !== target.owner || read.member !== target.member) return false;
  }
  return true;
}

/** Records the write to a built-in member that `node` is, if it is one, for
 * the check at the end of lowering (builtin-member-readers.ts). The write
 * itself lowers as it always did. */
export function noteBuiltinMemberWrite(lowerer: Lowerer, node: ts.Node): void {
  // Lowering asks this of every expression: nearly all are of no kind a
  // write can be, and leave on one read of the kind.
  const kind = node.kind;
  if (
    kind !== ts.SyntaxKind.BinaryExpression &&
    kind !== ts.SyntaxKind.CallExpression &&
    kind !== ts.SyntaxKind.PrefixUnaryExpression &&
    kind !== ts.SyntaxKind.PostfixUnaryExpression &&
    kind !== ts.SyntaxKind.DeleteExpression
  )
    return;
  const write = builtinMemberWriteOf(lowerer, node);
  if (write === null) return;
  lowerer.builtinMemberWrites.set(write.at, write);
  // A call reported at a member of its source may write more members.
  if (write.at === node || !ts.isCallExpression(node)) return;
  const all: BuiltinMemberWrite[] = [];
  builtinMemberWriteCall(lowerer, node, all);
  for (const each of all) lowerer.builtinMemberWrites.set(each.at, each);
}

/** The built-in members a feature test reads: each member access, `"m" in
 * X` and `X.hasOwnProperty("m")` in it. */
export function builtinMembersTested(lowerer: Lowerer, test: ts.Expression): BuiltinMember[] {
  const found: BuiltinMember[] = [];
  ts.walkPreorder(test, (n) => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const member = builtinMemberOf(lowerer, n);
      if (member !== null) found.push(member);
      return undefined;
    }
    let owner: ts.Expression | undefined;
    let key: ts.Expression | undefined;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      owner = n.right;
      key = withoutParentheses(n.left);
    } else if (ts.isCallExpression(n) && n.arguments.nodes.length === 1) {
      const callee = withoutParentheses(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "hasOwnProperty") {
        owner = callee.expression;
        key = n.arguments.nodes[0];
      }
    }
    if (owner === undefined || key === undefined || !ts.isStringLiteral(key)) return undefined;
    if (!mayNameBuiltin(lowerer, owner)) return undefined;
    const object = builtinObjectOf(lowerer, owner);
    const kind = object === null ? null : builtinMemberKind(object, key.text);
    if (object !== null && kind !== null) found.push({ owner: object, member: key.text, kind });
    return undefined;
  });
  return found;
}

/** Whether `node` contains a write to a built-in member, at any depth. */
export function containsBuiltinMemberWrite(lowerer: Lowerer, node: ts.Node): boolean {
  let found = false;
  ts.walkPreorder(
    node,
    (n) => {
      if (builtinMemberWriteOf(lowerer, n) === null) return undefined;
      found = true;
      return "stop";
    },
    WRITE_KINDS,
  );
  return found;
}

/** The node kinds a write to a built-in member can be (builtinMemberWriteOf). */
const WRITE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.CallExpression,
]);

function isUndefinedOrNull(e: ts.Expression): boolean {
  const x = withoutParentheses(e);
  return (
    x.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(x) ||
    (ts.isIdentifier(x) && x.text === "undefined")
  );
}

/** Whether an operand isUndefinedOrNull accepts has to run: `void e` is
 * undefined whatever `e` is, and evaluates it. `void 0` and the other
 * literals are the spellings of undefined and do nothing; any other operand
 * (`void f()`, `void x`, which may throw) is evaluated for what it does. */
function unitOperandRuns(e: ts.Expression): boolean {
  const x = withoutParentheses(e);
  if (!ts.isVoidExpression(x)) return false;
  return !isPlainLiteral(withoutParentheses(x.expression));
}

/** Whether a test that reads `read` (readRuns) may be decided: yes when the
 * read runs nothing; when it does, only for a caller that keeps the test's
 * evaluation, which `skipped.operand` then asks for. */
function mayDecide(
  lowerer: Lowerer,
  read: ts.Expression,
  skipped: { operand: boolean } | undefined,
): boolean {
  if (!readRuns(lowerer, read)) return true;
  if (skipped === undefined) return false;
  skipped.operand = true;
  return true;
}

/** `typeof X.m` for a member whose answer is fixed: "function" for a
 * function. Truthy data is some other type, which is enough to answer a
 * comparison against "function" or "undefined". */
/** The built-in member a feature test reads and can be decided from: not
 * one the program may assign as state (`Error.stackTraceLimit`), whose
 * value is whatever the program last gave it. */
function testedMemberOf(lowerer: Lowerer, expr: ts.Expression): BuiltinMember | null {
  const member = builtinMemberOf(lowerer, expr);
  return member === null || isAssignableState(member) ? null : member;
}

function typeofComparison(lowerer: Lowerer, operand: ts.Expression, text: string): boolean | null {
  const member = testedMemberOf(lowerer, operand);
  if (member === null) return null;
  if (member.kind === "f") return text === "function";
  if (member.kind === "t") return text === "function" || text === "undefined" ? false : null;
  return null;
}

/** The value of a feature test of existing built-in members, or null when
 * any part of it needs evaluation: `X.m`, `typeof X.m === "function"`,
 * `X.m === undefined`, `X.m == null`, `"m" in X`, `X.hasOwnProperty("m")`,
 * and `!`, `&&`, `||` over them: the answer at startup, which is the answer
 * everywhere in a program that does not change the member (a caller that
 * uses the answer records the test with noteBuiltinFeatureTest). Without
 * `skipped` the answer is one that needs no evaluation at all: every operand
 * that would run is such a test. With it, the answer may also be one that an
 * operand with effects cannot change (`effect() && !X.m`, `X.m === void
 * effect()`, `Object.getPrototypeOf([effect()]).m`), and `skipped.operand`
 * says so: the caller then has to keep the test's evaluation. */
export function builtinPresenceTest(
  lowerer: Lowerer,
  expr: ts.Expression,
  depth = 0,
  skipped?: { operand: boolean },
): boolean | null {
  // A feature test is a handful of operands; a chain of thousands is not
  // one, and must not cost a frame per operand.
  if (depth > 16) return null;
  const e = withoutParentheses(expr);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = builtinPresenceTest(lowerer, e.operand, depth + 1, skipped);
    return inner === null ? null : !inner;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      const left = builtinPresenceTest(lowerer, e.left, depth + 1, skipped);
      if (left !== null && left !== isAnd) return left;
      const right = builtinPresenceTest(lowerer, e.right, depth + 1, skipped);
      // The right operand decides whatever the left one answers
      // (`effect() && !Array.prototype.at`), but the left one still runs:
      // only a caller that keeps the test's evaluation may use this answer.
      if (right !== null && right !== isAnd) {
        if (left !== null) return right;
        if (skipped === undefined) return null;
        skipped.operand = true;
        return right;
      }
      return left === null || right === null ? null : isAnd;
    }
    if (op === ts.SyntaxKind.InKeyword) {
      const key = withoutParentheses(e.left);
      if (!ts.isStringLiteral(key) || !mayNameBuiltin(lowerer, e.right)) return null;
      const owner = builtinObjectOf(lowerer, e.right);
      if (owner === null || builtinMemberKind(owner, key.text) === null) return null;
      return mayDecide(lowerer, e.right, skipped) ? true : null;
    }
    const equal =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const unequal =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !unequal) return null;
    const left = withoutParentheses(e.left);
    const right = withoutParentheses(e.right);
    let answer: boolean | null = null;
    // The member access the comparison reads, which runs where it reads the
    // prototype of a value that is made for it.
    let read: ts.Expression | null = null;
    if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right)) {
      read = left.expression;
      answer = typeofComparison(lowerer, read, right.text);
    } else if (ts.isTypeOfExpression(right) && ts.isStringLiteral(left)) {
      read = right.expression;
      answer = typeofComparison(lowerer, read, left.text);
    } else {
      const unit = isUndefinedOrNull(right) ? right : isUndefinedOrNull(left) ? left : null;
      read = unit === null ? null : unit === right ? left : right;
      const member = read === null ? null : testedMemberOf(lowerer, read);
      if (unit !== null && member !== null && alwaysTruthy(member)) {
        // `X.m === void effect()`: the operand does not change the answer
        // and still runs, so only a caller that keeps the test's
        // evaluation may use it.
        if (unitOperandRuns(unit)) {
          if (skipped === undefined) return null;
          skipped.operand = true;
        }
        answer = false;
      }
    }
    if (answer === null || read === null || !mayDecide(lowerer, read, skipped)) return null;
    return equal ? answer : !answer;
  }
  if (ts.isCallExpression(e)) {
    const callee = withoutParentheses(e.expression);
    const key = e.arguments.nodes[0];
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "hasOwnProperty" ||
      e.arguments.nodes.length !== 1 ||
      key === undefined ||
      !ts.isStringLiteral(key) ||
      !mayNameBuiltin(lowerer, callee.expression)
    )
      return null;
    const owner = builtinObjectOf(lowerer, callee.expression);
    if (owner === null || builtinOwnMemberKind(owner, key.text) === null) return null;
    return mayDecide(lowerer, callee.expression, skipped) ? true : null;
  }
  const member = testedMemberOf(lowerer, e);
  if (member === null || member.kind === "a" || !mayDecide(lowerer, e, skipped)) return null;
  return member.kind !== "z";
}

/** The decided value of an `if` test that guards a polyfill: a feature test
 * of existing built-in members whose arm that never runs contains a write
 * the fence refuses. Null otherwise, so a feature test that guards anything
 * else keeps its ordinary lowering; null too when that arm `mustLower` (it
 * declares a binding the rest of the scope sees), where the write in it is
 * refused like any other. `pure` is false when the test has an operand that
 * runs for its effects (`effect() && !Array.prototype.at`,
 * `!Object.getPrototypeOf([effect()]).at`): the arm is still dead, and the
 * test still has to be evaluated. */
export function builtinPolyfillGuard(
  lowerer: Lowerer,
  test: ts.Expression,
  whenTrue: ts.Statement | undefined,
  whenFalse: ts.Statement | undefined,
  mustLower: (arm: ts.Statement) => boolean,
): { value: boolean; pure: boolean } | null {
  const skipped = { operand: false };
  const value = builtinPresenceTest(lowerer, test, 0, skipped);
  if (value === null) return null;
  const dead = value ? whenFalse : whenTrue;
  if (dead === undefined || mustLower(dead)) return null;
  if (!containsBuiltinMemberWrite(lowerer, dead)) return null;
  noteBuiltinFeatureTest(lowerer, test);
  return { value, pure: !skipped.operand };
}

/** Records a feature test lowering decided from the census, for the check
 * at the end of lowering: a program that changes a member the test reads,
 * where the test would see the change, is refused. */
function noteBuiltinFeatureTest(lowerer: Lowerer, test: ts.Expression): void {
  lowerer.builtinFeatureTests.add(test);
}

/** Whether an expression statement is a polyfill in which nothing happens:
 * a logical expression whose left operand is a decided feature test and
 * whose right operand, which that answer skips, contains a refused write
 * (`Array.prototype.at || (Array.prototype.at = f)`), or a logical
 * assignment that never assigns (`X.m ||= f`, `X.m ??= f` over a member that
 * is always truthy). Node writes nothing in such a statement, and its
 * operands that run are reads of built-in members with no effects, so it
 * lowers to nothing; one whose read makes a value first
 * (`Object.getPrototypeOf([effect()]).at || …`) is not such a statement.
 *
 * `X.m = X.m || f` does assign: the member's own value. In sloppy code that
 * is nothing too, over a data member the object itself holds: a writable
 * one keeps its value, and a write to a read-only one, or to a member of a
 * frozen object, is ignored. In strict code that write throws
 * (`Math.PI = Math.PI || 3.14`), and whether the member is writable when the
 * statement runs is not a fact of the build, so there the statement lowers
 * as the assignment it is and the runtime answers as Node does. It is not a
 * replacement of the member either way (keepsOwnValue), so nothing refuses
 * it. */
export function isDeadBuiltinPolyfill(lowerer: Lowerer, expr: ts.Expression): boolean {
  const e = withoutParentheses(expr);
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (isAssignmentOperator(op)) {
    const target = builtinMemberOf(lowerer, e.left);
    if (target === null || isAssignableState(target) || !keepsOwnValue(lowerer, e, target))
      return false;
    if (op === ts.SyntaxKind.EqualsToken) {
      if (isStrictCode(e) || builtinOwnMemberKind(target.owner, target.member) === null)
        return false;
      // The read of `X.m = X.m || f`, or of `X.m = X.m`, runs too.
      const kept = withoutParenthesesTypeWrappers(e.right);
      if (readRuns(lowerer, ts.isBinaryExpression(kept) ? kept.left : kept)) return false;
    }
    if (readRuns(lowerer, e.left)) return false;
    noteBuiltinFeatureTest(lowerer, e.left);
    return true;
  }
  let skipsRight: boolean;
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    const member = testedMemberOf(lowerer, e.left);
    skipsRight = member !== null && alwaysTruthy(member) && !readRuns(lowerer, e.left);
  } else if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const left = builtinPresenceTest(lowerer, e.left);
    skipsRight = left !== null && left === (op === ts.SyntaxKind.BarBarToken);
  } else return false;
  if (!skipsRight || !containsBuiltinMemberWrite(lowerer, e.right)) return false;
  noteBuiltinFeatureTest(lowerer, e.left);
  return true;
}

function endsAbruptly(stmt: ts.Statement): boolean {
  if (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isBreakStatement(stmt) ||
    ts.isContinueStatement(stmt)
  )
    return true;
  if (!ts.isBlock(stmt)) return false;
  const last = stmt.statements.nodes[stmt.statements.nodes.length - 1];
  return last !== undefined && endsAbruptly(last);
}

/** Whether `stmts[index]` is a guard that always leaves (`if
 * (Array.prototype.flat) return;`) in front of a refused write: the
 * statements after it never run. The guard itself lowers as any other
 * `if`, so its test is evaluated, and an operand of it that runs
 * (`Object.getPrototypeOf([effect()]).flat`) runs there. */
export function isBuiltinPolyfillEarlyExit(
  lowerer: Lowerer,
  stmts: readonly ts.Statement[],
  index: number,
): boolean {
  const stmt = stmts[index]!;
  if (!ts.isIfStatement(stmt) || stmt.elseStatement !== undefined) return false;
  if (!endsAbruptly(stmt.thenStatement)) return false;
  if (builtinPresenceTest(lowerer, stmt.expression, 0, { operand: false }) !== true) return false;
  for (let i = index + 1; i < stmts.length; i++)
    if (containsBuiltinMemberWrite(lowerer, stmts[i]!)) {
      noteBuiltinFeatureTest(lowerer, stmt.expression);
      return true;
    }
  return false;
}
