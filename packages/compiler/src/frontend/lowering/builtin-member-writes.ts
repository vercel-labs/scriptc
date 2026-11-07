/* Existing members of built-in objects are read-only in a compiled
 * executable. Compiled code calls a built-in member's native entry point and
 * never reads the member from its object, so a program that replaces or
 * deletes one (`Array.prototype.push = f`, `Math.random = f`, `delete
 * JSON.parse`) would keep running the built-in: the build refuses every such
 * write it can see (SC1092), and the runtime throws for the ones it cannot
 * (ScrDynEntry.fenced). Adding a member the object does not have is not a
 * replacement and keeps its existing lowering.
 *
 * "Existing" is a fact of the pinned Node release (builtin-object-members
 * .generated.ts): an own member of the object, or one it inherits from
 * another built-in object, which the write would shadow. Because existing
 * members cannot change, a feature test of one (`if (!Array.prototype.at)`)
 * has one answer, and the polyfill it guards is code Node 24 never runs. */
import * as ts from "../ts7/adapter.js";
import {
  builtinMemberCopyDiag,
  builtinMemberWriteDiag,
  builtinPrototypeAddDiag,
} from "../../diagnostics/diagnostic.js";
import { locOf } from "../program.js";
import {
  BUILTIN_OBJECT_INHERITS,
  BUILTIN_OBJECT_MEMBERS,
} from "./builtin-object-members.generated.js";
import { type Lowerer, PoisonError } from "./lowerer.js";
import { stdlibGlobalNameOf, withoutTypeCasts } from "./surfaces.js";

/** f: a function; a: an accessor; t: other data that is truthy; z: other
 * data that is falsy. */
export type BuiltinMemberKind = "f" | "a" | "t" | "z";

let rows: Map<string, Map<string, BuiltinMemberKind>> | null = null;
let memberNames: Set<string> | null = null;

function table(): Map<string, Map<string, BuiltinMemberKind>> {
  if (rows !== null) return rows;
  rows = new Map();
  memberNames = new Set();
  for (const [owner, row] of Object.entries(BUILTIN_OBJECT_MEMBERS)) {
    const members = new Map<string, BuiltinMemberKind>();
    for (const item of row.split(" ")) {
      if (item === "") continue;
      members.set(item.slice(1), item[0] as BuiltinMemberKind);
      memberNames.add(item.slice(1));
    }
    rows.set(owner, members);
  }
  return rows;
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

/** A key the language itself reads from an object: a well-known symbol,
 * `toJSON` (JSON.stringify) and `then` (promise resolution). The runtime's
 * own readers answer for a built-in value without consulting its prototype
 * object, so a program that adds one to a built-in object would not see it
 * take effect; the write is refused like a replacement. */
function isProtocolKey(member: string): boolean {
  return member.startsWith("@@") || member === "toJSON" || member === "then";
}

function displayName(owner: string, member: string): string {
  return member.startsWith("@@") ? `${owner}[Symbol.${member.slice(2)}]` : `${owner}.${member}`;
}

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
  const e = withoutTypeCasts(expr);
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
  const callee = withoutTypeCasts(e.expression);
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
  const v = withoutTypeCasts(value);
  if (ts.isArrayLiteralExpression(v)) return "Array.prototype";
  if (ts.isObjectLiteralExpression(v)) return "Object.prototype";
  if (ts.isRegularExpressionLiteral(v)) return "RegExp.prototype";
  if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) return "Function.prototype";
  if (ts.isNewExpression(v) && ts.isIdentifier(v.expression)) {
    const name = stdlibGlobalNameOf(lowerer, v.expression);
    return name !== null && table().has(`${name}.prototype`) ? `${name}.prototype` : null;
  }
  return null;
}

/** The key a member access names without evaluating anything: a property
 * name, a string or number literal, or a well-known symbol. */
function staticKey(lowerer: Lowerer, access: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(access))
    return ts.isIdentifier(access.name) ? access.name.text : null;
  if (!ts.isElementAccessExpression(access)) return null;
  const key = withoutTypeCasts(access.argumentExpression);
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
  let e = withoutTypeCasts(init);
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text === "__proto__") return true;
      e = withoutTypeCasts(e.expression);
    } else if (ts.isElementAccessExpression(e)) e = withoutTypeCasts(e.expression);
    else break;
  }
  if (ts.isIdentifier(e)) return ownerRootNames().has(e.text) || aliases.has(e.text);
  if (!ts.isCallExpression(e)) return false;
  const callee = withoutTypeCasts(e.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getPrototypeOf";
}

/** The file `aliasNames` answered last, and its answer. Lowering works
 * through one file at a time, and the answer is a function of the file
 * alone, so one remembered file is the whole cache. */
let aliasFile: ts.SourceFile | null = null;
let aliasFileNames: Set<string> = new Set();
const VARIABLE_DECLARATIONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableDeclaration,
]);

/** The `const` names of a file whose initializer can denote a built-in
 * object (`const proto = Array.prototype`), found once per file by syntax
 * alone. Nearly every member write in a program starts at some other name,
 * and this set is what lets it skip the checker. */
function aliasNames(sf: ts.SourceFile): Set<string> {
  if (aliasFile === sf) return aliasFileNames;
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
  aliasFile = sf;
  aliasFileNames = found;
  return found;
}

/** Whether the member chain `expr` can reach a built-in object, by syntax
 * alone: it starts at a built-in global, at a `const` alias of one, or reads
 * a value's prototype (`Object.getPrototypeOf([])`, `[].__proto__`). The
 * cheap test in front of every checker query here. */
function mayNameBuiltin(expr: ts.Expression): boolean {
  let e = withoutTypeCasts(expr);
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text === "__proto__") return true;
      e = withoutTypeCasts(e.expression);
    } else if (ts.isElementAccessExpression(e)) e = withoutTypeCasts(e.expression);
    else break;
  }
  if (ts.isIdentifier(e))
    return ownerRootNames().has(e.text) || aliasNames(ts.getSourceFileOfNode(e)).has(e.text);
  if (!ts.isCallExpression(e)) return false;
  const callee = withoutTypeCasts(e.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "getPrototypeOf";
}

/** The built-in member `expr` reads or writes: `Array.prototype.push`,
 * `Math["random"]`, `globalThis.JSON`, or a bare `Array` (a member of the
 * global object). Null when the object is not a built-in, the key is not
 * static, or the object has no such member. */
export function builtinMemberOf(lowerer: Lowerer, expr: ts.Expression): BuiltinMember | null {
  const e = withoutTypeCasts(expr);
  table();
  if (ts.isIdentifier(e)) {
    const kind = builtinOwnMemberKind("globalThis", e.text);
    if (kind === null || stdlibGlobalNameOf(lowerer, e) !== e.text) return null;
    return { owner: "globalThis", member: e.text, kind };
  }
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return null;
  if (e.questionDotToken !== undefined) return null;
  const member = staticKey(lowerer, e);
  if (member === null || !memberNames!.has(member) || !mayNameBuiltin(e.expression)) return null;
  const owner = builtinObjectOf(lowerer, e.expression);
  if (owner === null) return null;
  const kind = builtinMemberKind(owner, member);
  return kind === null ? null : { owner, member, kind };
}

/** The built-in member a write to `target` changes: an existing member, or
 * a protocol key the object does not have yet (`added`). */
function writtenMemberOf(lowerer: Lowerer, target: ts.Expression): WrittenMember | null {
  const existing = builtinMemberOf(lowerer, target);
  if (existing !== null) return existing;
  const e = withoutTypeCasts(target);
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return null;
  if (e.questionDotToken !== undefined) return null;
  const member = staticKey(lowerer, e);
  if (member === null || !mayNameBuiltin(e.expression)) return null;
  const owner = builtinObjectOf(lowerer, e.expression);
  return owner === null ? null : addedMember(owner, member);
}

/** A built-in member a write changes; `added` when the object has no such
 * member yet: "protocol" for a key the language reads itself, "unread" for
 * any other key on a prototype whose instances would never read it. */
type WrittenMember = BuiltinMember & { added?: "protocol" | "unread" };

/** Whether instances read a member a program adds to this prototype object.
 * Arrays do: a member read on an untyped array consults Array.prototype.
 * No other built-in's instances look at their prototype object, so
 * `Map.prototype.added = 7` would leave `new Map().added` undefined. */
function instancesReadAddedMembers(owner: string): boolean {
  return owner === "Array.prototype";
}

/** The refusal an added member of `owner` needs, or null when adding it is
 * what the object model supports: a member of a constructor, a namespace
 * object or Array.prototype that the language does not read itself. */
function addedMember(owner: string, member: string): WrittenMember | null {
  if (isProtocolKey(member)) return { owner, member, kind: "f", added: "protocol" };
  if (owner.endsWith(".prototype") && !instancesReadAddedMembers(owner))
    return { owner, member, kind: "f", added: "unread" };
  return null;
}

/** A built-in member the runtime models as program state: assigning it is
 * what the member is for, and compiled code reads the assigned value. */
function isAssignableState(target: BuiltinMember): boolean {
  return target.owner === "Error" && target.member === "stackTraceLimit";
}

/** Whether a read of the member always answers a value that is neither
 * undefined nor null, and truthy: a function or truthy data. An accessor
 * runs code, and falsy data is falsy. */
function alwaysTruthy(member: BuiltinMember): boolean {
  return member.kind === "f" || member.kind === "t";
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    (kind >= ts.SyntaxKind.FirstCompoundAssignment && kind <= ts.SyntaxKind.LastCompoundAssignment)
  );
}

/** `X.m ||= v` and `X.m ??= v` over a member that is always truthy never
 * assign, and `X.m = X.m || v` / `X.m = X.m ?? v` assign the member's own
 * value: the polyfill spellings that have no guard statement. */
function keepsOwnValue(
  lowerer: Lowerer,
  write: ts.BinaryExpression,
  target: BuiltinMember,
): boolean {
  if (!alwaysTruthy(target)) return false;
  const op = write.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken)
    return true;
  if (op !== ts.SyntaxKind.EqualsToken) return false;
  const value = withoutTypeCasts(write.right);
  if (!ts.isBinaryExpression(value)) return false;
  const inner = value.operatorToken.kind;
  if (inner !== ts.SyntaxKind.BarBarToken && inner !== ts.SyntaxKind.QuestionQuestionToken)
    return false;
  const read = builtinMemberOf(lowerer, value.left);
  return read !== null && read.owner === target.owner && read.member === target.member;
}

/** A refused write: the member, whether the write deletes it, and the node
 * to report. `unknownMembers` is a call that copies members the build cannot
 * name onto a built-in object. */
interface RefusedWrite {
  target: WrittenMember & { unknownMembers?: true };
  deletes: boolean;
  at: ts.Node;
}

/** The built-in member a write expression replaces or deletes, with the
 * node to report: an assignment, a compound assignment, `++`/`--` or
 * `delete` whose target is an existing member, or a call that defines,
 * assigns or deletes one (`Object.defineProperty(Array.prototype, "push",
 * …)`). Null for every other node, for a write that keeps the member's own
 * value, and for a member the runtime models as assignable state. */
function refusedWriteOf(lowerer: Lowerer, node: ts.Node): RefusedWrite | null {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const target = writtenMemberOf(lowerer, node.left);
    if (target === null || isAssignableState(target)) return null;
    if (target.added === undefined && keepsOwnValue(lowerer, node, target)) return null;
    return { target, deletes: false, at: node.left };
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const target = builtinMemberOf(lowerer, node.operand);
    return target === null || isAssignableState(target)
      ? null
      : { target, deletes: false, at: node.operand };
  }
  if (ts.isDeleteExpression(node)) {
    const target = builtinMemberOf(lowerer, node.expression);
    return target === null ? null : { target, deletes: true, at: node.expression };
  }
  if (ts.isCallExpression(node)) return refusedWriteCall(lowerer, node);
  return null;
}

/** The static name of an object literal member, for the keys an
 * `Object.assign` or `Object.defineProperties` source spells. */
function literalMemberName(member: ts.ObjectLiteralElementLike): string | null {
  const name = member.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
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

function refusedWriteCall(lowerer: Lowerer, call: ts.CallExpression): RefusedWrite | null {
  const callee = withoutTypeCasts(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const holder = callee.expression.text;
  const method = callee.name.text;
  if (!isWriteCall(holder, method)) return null;
  const args = call.arguments.nodes;
  const first = args[0];
  if (first === undefined || !mayNameBuiltin(first)) return null;
  if (stdlibGlobalNameOf(lowerer, callee.expression) !== holder) return null;
  const owner = builtinObjectOf(lowerer, first);
  if (owner === null) return null;
  const hit = (member: string | null): WrittenMember | null => {
    if (member === null) return null;
    const kind = builtinMemberKind(owner, member);
    if (kind === null) return addedMember(owner, member);
    const target = { owner, member, kind };
    return isAssignableState(target) ? null : target;
  };
  if (method === "defineProperties" || method === "assign") {
    for (const source of args.slice(1)) {
      const literal = withoutTypeCasts(source);
      // A source the build cannot read member by member may replace any of
      // the object's members.
      if (!ts.isObjectLiteralExpression(literal))
        return {
          target: { owner, member: "", kind: "f", unknownMembers: true },
          deletes: false,
          at: source,
        };
      for (const member of literal.properties.nodes) {
        if (ts.isSpreadAssignment(member))
          return {
            target: { owner, member: "", kind: "f", unknownMembers: true },
            deletes: false,
            at: member,
          };
        const target = hit(literalMemberName(member));
        if (target !== null) return { target, deletes: false, at: member };
      }
    }
    return null;
  }
  const key = args[1] === undefined ? null : withoutTypeCasts(args[1]);
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
  if (
    method === "defineProperty" &&
    target.added === undefined &&
    keepsMemberValue(lowerer, args[2], target)
  )
    return null;
  return { target, deletes: method === "deleteProperty", at: call };
}

/** Whether a property descriptor changes only the member's attributes: an
 * object literal with no accessor, and no value or the member's own
 * (`Object.defineProperty(Math, "trunc", { value: Math.trunc, writable:
 * false })`). The member compiled code calls stays the one the object
 * holds, and the runtime applies the attributes. */
function keepsMemberValue(
  lowerer: Lowerer,
  descriptor: ts.Expression | undefined,
  target: BuiltinMember,
): boolean {
  const literal = descriptor === undefined ? undefined : withoutTypeCasts(descriptor);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return false;
  for (const member of literal.properties.nodes) {
    const name = literalMemberName(member);
    if (name === null || name === "get" || name === "set") return false;
    if (name !== "value") continue;
    if (!ts.isPropertyAssignment(member)) return false;
    const read = builtinMemberOf(lowerer, member.initializer);
    if (read === null || read.owner !== target.owner || read.member !== target.member) return false;
  }
  return true;
}

/** The SC1092 refusal of a write that replaces or deletes an existing
 * built-in member; `node` is the assignment, update, `delete` or call. A
 * build error in every source: a deferred fence would let a `catch` swallow
 * it, and the program would go on calling the built-in. */
export function fenceBuiltinMemberWrite(lowerer: Lowerer, node: ts.Node): void {
  const write = refusedWriteOf(lowerer, node);
  if (write === null) return;
  const { target } = write;
  lowerer.pushDiag(
    target.unknownMembers === true
      ? builtinMemberCopyDiag(target.owner, locOf(write.at))
      : target.added === "unread"
        ? builtinPrototypeAddDiag(displayName(target.owner, target.member), locOf(write.at))
        : builtinMemberWriteDiag(
            displayName(target.owner, target.member),
            write.deletes ? "delete" : target.added === "protocol" ? "add" : "replace",
            locOf(write.at),
          ),
  );
  throw new PoisonError();
}

/** Whether `node` contains a write the fence refuses, at any depth. */
export function containsBuiltinMemberWrite(lowerer: Lowerer, node: ts.Node): boolean {
  let found = false;
  ts.walkPreorder(
    node,
    (n) => {
      if (refusedWriteOf(lowerer, n) === null) return undefined;
      found = true;
      return "stop";
    },
    WRITE_KINDS,
  );
  return found;
}

/** The node kinds a refused write can be (refusedWriteOf). */
const WRITE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.CallExpression,
]);

function unparenthesized(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isUndefinedOrNull(e: ts.Expression): boolean {
  const x = unparenthesized(e);
  return (
    x.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(x) ||
    (ts.isIdentifier(x) && x.text === "undefined")
  );
}

/** `typeof X.m` for a member whose answer is fixed: "function" for a
 * function. Truthy data is some other type, which is enough to answer a
 * comparison against "function" or "undefined". */
function typeofComparison(lowerer: Lowerer, operand: ts.Expression, text: string): boolean | null {
  const member = builtinMemberOf(lowerer, operand);
  if (member === null) return null;
  if (member.kind === "f") return text === "function";
  if (member.kind === "t") return text === "function" || text === "undefined" ? false : null;
  return null;
}

/** The value of a feature test of existing built-in members, or null when
 * any part of it needs evaluation: `X.m`, `typeof X.m === "function"`,
 * `X.m === undefined`, `X.m == null`, `"m" in X`, `X.hasOwnProperty("m")`,
 * and `!`, `&&`, `||` over them. Existing members cannot be replaced or
 * deleted, so the answer at startup is the answer everywhere. Without
 * `skipped` the answer is one that needs no evaluation at all: every operand
 * that would run is such a test. With it, the answer may also be one that an
 * operand with effects cannot change, and `skipped.operand` says so: the
 * caller then has to keep the test's evaluation. */
export function builtinPresenceTest(
  lowerer: Lowerer,
  expr: ts.Expression,
  depth = 0,
  skipped?: { operand: boolean },
): boolean | null {
  // A feature test is a handful of operands; a chain of thousands is not
  // one, and must not cost a frame per operand.
  if (depth > 16) return null;
  const e = unparenthesized(expr);
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
      const key = unparenthesized(e.left);
      if (!ts.isStringLiteral(key) || !mayNameBuiltin(e.right)) return null;
      const owner = builtinObjectOf(lowerer, e.right);
      return owner !== null && builtinMemberKind(owner, key.text) !== null ? true : null;
    }
    const equal =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const unequal =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !unequal) return null;
    const left = unparenthesized(e.left);
    const right = unparenthesized(e.right);
    let answer: boolean | null = null;
    if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right))
      answer = typeofComparison(lowerer, left.expression, right.text);
    else if (ts.isTypeOfExpression(right) && ts.isStringLiteral(left))
      answer = typeofComparison(lowerer, right.expression, left.text);
    else {
      const read = isUndefinedOrNull(right) ? left : isUndefinedOrNull(left) ? right : null;
      const member = read === null ? null : builtinMemberOf(lowerer, read);
      if (member !== null && alwaysTruthy(member)) answer = false;
    }
    return answer === null ? null : equal ? answer : !answer;
  }
  if (ts.isCallExpression(e)) {
    const callee = unparenthesized(e.expression);
    const key = e.arguments.nodes[0];
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "hasOwnProperty" ||
      e.arguments.nodes.length !== 1 ||
      key === undefined ||
      !ts.isStringLiteral(key) ||
      !mayNameBuiltin(callee.expression)
    )
      return null;
    const owner = builtinObjectOf(lowerer, callee.expression);
    return owner !== null && builtinOwnMemberKind(owner, key.text) !== null ? true : null;
  }
  const member = builtinMemberOf(lowerer, e);
  if (member === null || member.kind === "a") return null;
  return member.kind !== "z";
}

/** The decided value of an `if` test that guards a polyfill: a feature test
 * of existing built-in members whose arm that never runs contains a write
 * the fence refuses. Null otherwise, so a feature test that guards anything
 * else keeps its ordinary lowering; null too when that arm `mustLower` (it
 * declares a binding the rest of the scope sees), where the write in it is
 * refused like any other. `pure` is false when the test has an operand that
 * runs for its effects (`effect() && !Array.prototype.at`): the arm is
 * still dead, and the test still has to be evaluated. */
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
  return containsBuiltinMemberWrite(lowerer, dead) ? { value, pure: !skipped.operand } : null;
}

/** Whether an expression statement is a polyfill that never runs: a logical
 * expression whose left operand is a decided feature test and whose right
 * operand, which that answer skips, contains a refused write
 * (`Array.prototype.at || (Array.prototype.at = f)`), or an assignment that
 * keeps the member's own value (`X.m = X.m || f`, `X.m ??= f`). Its operands
 * that run are reads of built-in members and have no effects, so the
 * statement lowers to nothing. */
export function isDeadBuiltinPolyfill(lowerer: Lowerer, expr: ts.Expression): boolean {
  const e = unparenthesized(expr);
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (isAssignmentOperator(op)) {
    const target = builtinMemberOf(lowerer, e.left);
    return target !== null && !isAssignableState(target) && keepsOwnValue(lowerer, e, target);
  }
  let skipsRight: boolean;
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    const member = builtinMemberOf(lowerer, e.left);
    skipsRight = member !== null && alwaysTruthy(member);
  } else if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const left = builtinPresenceTest(lowerer, e.left);
    skipsRight = left !== null && left === (op === ts.SyntaxKind.BarBarToken);
  } else return false;
  return skipsRight && containsBuiltinMemberWrite(lowerer, e.right);
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
 * statements after it never run. */
export function isBuiltinPolyfillEarlyExit(
  lowerer: Lowerer,
  stmts: readonly ts.Statement[],
  index: number,
): boolean {
  const stmt = stmts[index]!;
  if (!ts.isIfStatement(stmt) || stmt.elseStatement !== undefined) return false;
  if (!endsAbruptly(stmt.thenStatement)) return false;
  if (builtinPresenceTest(lowerer, stmt.expression) !== true) return false;
  for (let i = index + 1; i < stmts.length; i++)
    if (containsBuiltinMemberWrite(lowerer, stmts[i]!)) return true;
  return false;
}
