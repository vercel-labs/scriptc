/* A write to a member of a built-in object is refused only where the
 * program also uses that member through code that does not look at the
 * object (SC1092).
 *
 * Lowering records the writes it meets (builtin-member-writes.ts) and
 * lowers them as it always did. When the whole program is lowered, and only
 * if it recorded a write, this module walks the syntax of every module once
 * and finds what reads each written member natively:
 *
 *  - a reference to the member itself: a call through a value of the
 *    built-in (`xs.push(1)` after `Array.prototype.push = f`), a call or a
 *    read through the built-in object (`Math.random()`, `Array.isArray`);
 *  - a use of another built-in member that reads it (`promise.catch()`
 *    reads `then`, `String(array)` and `array.toString()` read `join`);
 *  - a language construct that reads it: a string or numeric conversion
 *    (`toString`, `valueOf`, `Symbol.toPrimitive`), an iteration
 *    (`Symbol.iterator`), an awaited or resolved value (`then`), a JSON
 *    serialization (`toJSON`);
 *  - a feature test of it that lowering decided from the census.
 *
 * What each construct and each built-in member reads is measured under the
 * pinned Node release (builtin-object-members.generated.ts). Which class a
 * receiver or an operand is comes from its static type, so `s.includes(x)`
 * on a string is no use of `Array.prototype.includes`, and a member a
 * program's own class implements is no use of a built-in's.
 *
 * The readers the runtime does serve from the object are not uses. They are
 * few, each is pinned by a corpus program (builtin-member-writes-unread*,
 * js-array-prototype-method-getters, the collection constructor programs),
 * and all but the last concern `Array.prototype`: a value read of its member
 * through the prototype object or through an untyped value; its iterator
 * read by for…of, array spread or `Array.from` over an untyped value (by
 * `Array.from` in any JavaScript source); and the adder a collection
 * constructor calls. A use that runs before
 * every write of the member is none either (`const original = Date.now`
 * in front of `Date.now = …`). A write nothing reads natively keeps the
 * lowering it has always had. */
import { dirname, relative } from "node:path";
import { builtinMemberWriteDiag } from "../../diagnostics/diagnostic.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { isCheckerPanic } from "../../diagnostics/diagnostic.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import {
  type BuiltinMember,
  type BuiltinMemberWrite,
  builtinMemberName,
  builtinMembersTested,
  builtinObjectChain,
  builtinObjectOf,
  builtinOwnMemberKind,
  isAssignmentOperator,
  isBuiltinObjectName,
  mayNameBuiltinObject,
  staticMemberKey,
} from "./builtin-member-writes.js";
import {
  BUILTIN_CALLEE_READS,
  BUILTIN_CONSTRUCT_READS,
  BUILTIN_INSTANCE_OWN_MEMBERS,
  BUILTIN_MEMBER_READS,
} from "./builtin-object-members.generated.js";
import type { Lowerer } from "./lowerer.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** What one operation reads: `keys` through its operand's prototype chain,
 * `others` from named objects ("Promise resolve"). */
interface Reads {
  keys: ReadonlySet<string>;
  others: ReadonlySet<string>;
}

function parseReads(text: string): Reads {
  const bar = text.indexOf(" | ");
  const through = bar < 0 ? text : text.slice(0, bar);
  const keys = through.split(" ").filter((key) => key !== "");
  const others = bar < 0 ? [] : text.slice(bar + 3).split(", ");
  return { keys: new Set(keys), others: new Set(others) };
}

/** The class of a primitive is its wrapper's prototype: that is where a
 * member read through the primitive starts. */
const PRIMITIVE_WRAPPERS: Readonly<Record<string, string>> = {
  string: "String.prototype",
  number: "Number.prototype",
  boolean: "Boolean.prototype",
  symbol: "Symbol.prototype",
  bigint: "BigInt.prototype",
};

interface ReaderTables {
  /** construct → operand class → what it reads. */
  constructs: Map<string, Map<string, Reads>>;
  /** "Owner key" of a prototype member → what calling it reads. */
  members: Map<string, Reads>;
  /** member name → the prototypes whose member of that name reads something. */
  memberOwners: Map<string, string[]>;
  /** callee ("Array.from", "new:Map") → what it reads from its argument. */
  callees: Map<string, Reads>;
  /** prototype → the members its instances hold themselves. */
  instanceOwn: Map<string, ReadonlySet<string>>;
  /** Every prototype of the census: the classes an untyped value may be. */
  classes: string[];
}

let tables: ReaderTables | null = null;

function readerTables(): ReaderTables {
  if (tables !== null) return tables;
  const constructs = new Map<string, Map<string, Reads>>();
  for (const [construct, rows] of Object.entries(BUILTIN_CONSTRUCT_READS)) {
    const byClass = new Map<string, Reads>();
    for (const [text, classes] of Object.entries(rows)) {
      const reads = parseReads(text);
      for (const name of classes.split(", ")) byClass.set(name, reads);
    }
    constructs.set(construct, byClass);
  }
  const members = new Map<string, Reads>();
  const memberOwners = new Map<string, string[]>();
  for (const [member, text] of Object.entries(BUILTIN_MEMBER_READS)) {
    members.set(member, parseReads(text));
    const space = member.indexOf(" ");
    const name = member.slice(space + 1);
    const owners = memberOwners.get(name);
    if (owners === undefined) memberOwners.set(name, [member.slice(0, space)]);
    else owners.push(member.slice(0, space));
  }
  const callees = new Map<string, Reads>();
  for (const [text, names] of Object.entries(BUILTIN_CALLEE_READS)) {
    const reads = parseReads(text);
    for (const name of names.split(", ")) callees.set(name, reads);
  }
  const instanceOwn = new Map<string, ReadonlySet<string>>();
  for (const [prototype, names] of Object.entries(BUILTIN_INSTANCE_OWN_MEMBERS))
    instanceOwn.set(prototype, new Set(names.split(" ")));
  const classes: string[] = [];
  for (const byClass of constructs.values())
    for (const name of byClass.keys())
      if (name.endsWith(".prototype") && !classes.includes(name)) classes.push(name);
  tables = { constructs, members, memberOwners, callees, instanceOwn, classes };
  return tables;
}

/** The built-in object a member read through a value of `cls` starts at. */
function chainStart(cls: string): string {
  return PRIMITIVE_WRAPPERS[cls] ?? cls;
}

/** Whether a read of `key` that starts at the built-in object `start` reads
 * the member `owner` holds or would hold: `owner` is on the chain, at or
 * before the first object that has the key. */
function readReaches(start: string, owner: string, key: string): boolean {
  for (const at of builtinObjectChain(start)) {
    if (at === owner) return true;
    if (builtinOwnMemberKind(at, key) !== null) return false;
  }
  return false;
}

/** Whether a value of the class holds `key` itself (an array's `length`), so
 * that its read never reaches a prototype. */
function instanceHolds(cls: string, key: string): boolean {
  const own = readerTables().instanceOwn;
  for (const at of builtinObjectChain(chainStart(cls))) if (own.get(at)?.has(key)) return true;
  return false;
}

/** Whether a read of `key` through a value of the class reads `owner`'s. */
function instanceReads(cls: string, owner: string, key: string): boolean {
  return !instanceHolds(cls, key) && readReaches(chainStart(cls), owner, key);
}

/** The classes a value may be: prototypes' names and primitives' types.
 * Null when its static type does not say, and it may be of any class. */
type Classes = readonly string[] | null;

function someClass(classes: Classes, test: (cls: string) => boolean): boolean {
  const list = classes === null ? readerTables().classes : classes;
  for (const cls of list) if (test(cls)) return true;
  return false;
}

/** The census prototype a standard-library type of this name is the
 * instance type of: `Map`, and the views TypeScript declares beside it
 * (`ReadonlyMap`, `PromiseLike`, `CallableFunction`). */
function stdlibPrototype(name: string): string | null {
  const direct = `${name}.prototype`;
  if (isBuiltinObjectName(direct)) return direct;
  for (const prefix of ["Readonly", "Concat", "Callable", "Newable"]) {
    if (!name.startsWith(prefix)) continue;
    const rest = `${name.slice(prefix.length)}.prototype`;
    if (isBuiltinObjectName(rest)) return rest;
  }
  if (name.endsWith("Like")) {
    const rest = `${name.slice(0, -4)}.prototype`;
    // An ArrayLike value is anything with a length.
    if (rest !== "Array.prototype" && isBuiltinObjectName(rest)) return rest;
  }
  return null;
}

/** The primitive a type is, by its flags, or null. */
function primitiveClass(flags: number): string | null {
  if ((flags & ts.TypeFlags.StringLike) !== 0) return "string";
  if ((flags & ts.TypeFlags.NumberLike) !== 0) return "number";
  if ((flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
  if ((flags & ts.TypeFlags.BigIntLike) !== 0) return "bigint";
  if ((flags & ts.TypeFlags.ESSymbolLike) !== 0) return "symbol";
  return null;
}

function classesOfType(lowerer: Lowerer, type: ts.Type, depth: number): Classes {
  const flags = type.flags;
  if ((flags & ts.TypeFlags.AnyOrUnknown) !== 0) return null;
  if ((flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) !== 0) {
    const all: string[] = [];
    for (const part of type.getTypes()) {
      const classes = classesOfType(lowerer, part, depth + 1);
      if (classes === null) return null;
      for (const cls of classes) if (!all.includes(cls)) all.push(cls);
    }
    return all;
  }
  const none = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never;
  if ((flags & none) !== 0) return [];
  const primitive = primitiveClass(flags);
  if (primitive !== null) return [primitive];
  if ((flags & ts.TypeFlags.Object) === 0 || depth > 8) return null;
  const checker = lowerer.checker;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return ["Array.prototype"];
  const symbol = type.getSymbol();
  if (symbol === undefined) return null;
  const stdlib = lowerer.isStdlibSymbol(symbol);
  if (stdlib) {
    const prototype = stdlibPrototype(ts.symbolName(symbol));
    if (prototype !== null) return [prototype];
  }
  const isClassOrInterface =
    (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) !== 0;
  if (isClassOrInterface) {
    for (const base of checker.getBaseTypes(type as ts.InterfaceType)) {
      const classes = classesOfType(lowerer, base, depth + 1);
      if (classes !== null && classes.length > 0) return classes;
    }
  }
  // A standard-library type that is no built-in class (an Iterable, a
  // host object) says nothing about the value behind it.
  if (stdlib) return null;
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return ["Object.prototype"];
  if (checker.getCallSignatures(type).length > 0) return ["Function.prototype"];
  return ["Object.prototype"];
}

/** Whether a checker query failed without an answer: a panic inside the
 * checker, which a query about a node that never lowered can still meet. The
 * caller then takes the answer that assumes least. */
function unanswered(e: unknown): boolean {
  return isCheckerPanic(e) || ts.isUnreadableConstituentsPanic(e);
}

/** The classes the value of `expr` may be, as lowering saw its type. */
function classesOf(lowerer: Lowerer, expr: ts.Expression): Classes {
  try {
    return classesOfType(lowerer, lowerer.typeOf(expr), 0);
  } catch (e) {
    if (!unanswered(e)) throw e;
    return null;
  }
}

/** Whether a member declaration is an implementation: a class member, an
 * object literal's member, a function. An interface's or a type literal's
 * member only describes a value some other code made. */
function isImplementation(decl: ts.Node): boolean {
  return (
    ts.isMethodDeclaration(decl) ||
    ts.isPropertyDeclaration(decl) ||
    ts.isGetAccessorDeclaration(decl) ||
    ts.isSetAccessorDeclaration(decl) ||
    ts.isPropertyAssignment(decl) ||
    ts.isShorthandPropertyAssignment(decl) ||
    ts.isFunctionDeclaration(decl)
  );
}

/** What declares the member a symbol stands for: "user" when the program
 * implements it (its own class, an object literal), "described" when the
 * program only declares it on an interface or a type literal (the value
 * behind it may be anything), "stdlib" otherwise. */
function memberOrigin(
  lowerer: Lowerer,
  symbol: ts.Symbol | undefined,
): "user" | "described" | "stdlib" {
  if (symbol === undefined || symbol.declarations.length === 0) return "stdlib";
  if (lowerer.isStdlibSymbol(symbol)) return "stdlib";
  for (const decl of symbol.declarations) if (!isImplementation(decl)) return "described";
  return "user";
}

/** Whether the program implements the member `key` of the operand's type
 * itself, so that an operation that asks the operand for it never reaches
 * a built-in's. */
function operandImplements(lowerer: Lowerer, operand: ts.Expression | null, key: string): boolean {
  if (operand === null || key.startsWith("@@")) return false;
  try {
    const type = lowerer.typeOf(operand);
    if ((type.flags & (ts.TypeFlags.Union | ts.TypeFlags.AnyOrUnknown)) !== 0) return false;
    return memberOrigin(lowerer, lowerer.checker.getPropertyOfType(type, key)) === "user";
  } catch (e) {
    if (!unanswered(e)) throw e;
    return false;
  }
}

/** A place in the program that may read a built-in member natively. */
type Site =
  /** `receiver.key`, called or read. `object` is the built-in object the
   * receiver names; otherwise `classes` are the receiver's. `through` marks
   * `X.prototype.key.call(receiver, …)`, whose receiver's classes are
   * `throughClasses`. */
  | {
      kind: "member";
      node: ts.Node;
      key: string;
      object: string | null;
      classes: Classes;
      called: boolean;
      through: boolean;
      throughClasses: Classes;
    }
  /** A conversion, an iteration, an await, a resolution or a serialization
   * of `operand`. `served` marks the forms the runtime serves from the
   * object when the operand is untyped. */
  | {
      kind: "construct";
      node: ts.Node;
      construct: string;
      classes: Classes;
      operand: ts.Expression | null;
      served: boolean;
    }
  /** A call of a built-in function with `classes` as its first argument. */
  | {
      kind: "callee";
      node: ts.Node;
      callee: string;
      classes: Classes;
      operand: ts.Expression | null;
    }
  /** A feature test lowering decided from the census. */
  | { kind: "test"; node: ts.Node; members: BuiltinMember[] }
  /** A reference to a global by its name. */
  | { kind: "global"; node: ts.Node; name: string };

/** The constructs whose operand is read at any depth or at a later time,
 * where the static type of the expression says too little: every class
 * counts. */
const DEEP_CONSTRUCTS: ReadonlySet<string> = new Set(["await", "resolve", "json"]);
/** The keys a callee reads from what its argument holds or resolves to. */
const DEEP_KEYS: ReadonlySet<string> = new Set(["then", "constructor", "toJSON"]);
/** The adder a collection constructor reads from the new collection: the
 * runtime's constructors read it from the prototype object. */
export const SERVED_ADDERS: Readonly<Record<string, string>> = {
  "new:Map": "Map.prototype set",
  "new:Set": "Set.prototype add",
  "new:WeakMap": "WeakMap.prototype set",
  "new:WeakSet": "WeakSet.prototype add",
};

/** The constructs the walk collects, with the words a refusal uses for
 * each: every one has its measured row in BUILTIN_CONSTRUCT_READS. */
export const CONSTRUCT_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  string: ["the string conversion", "the conversion"],
  concat: ["the conversion", "the conversion"],
  number: ["the numeric conversion", "the conversion"],
  iterate: ["the iteration", "the iteration"],
  await: ["the await", "the await"],
  resolve: ["the promise resolution", "the resolution"],
  json: ["the JSON serialization", "the serialization"],
};

/** `node`'s position as `file:line:column`, the file relative to the
 * directory of the file that holds the refused write. */
function positionText(node: ts.Node, from: string): string {
  const sf = ts.getSourceFileOfNode(node);
  const at = ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(node));
  const file = relative(dirname(from), sf.fileName).split("\\").join("/");
  return `${file}:${at.line + 1}:${at.character + 1}`;
}

const NO_OBJECT = ", and compiled code does not read a built-in member from its object, so ";

/** How the site reads the member the write changes, as the text that
 * completes the refusal, or null when it does not read it. */
function siteReads(lowerer: Lowerer, site: Site, write: BuiltinMemberWrite): string | null {
  const { owner, member: key } = write;
  const where = positionText(site.node, ts.getSourceFileOfNode(write.node).fileName);
  const t = readerTables();
  const wanted = `${owner} ${key}`;
  if (site.kind === "test") {
    for (const tested of site.members)
      if (tested.member === key && readReaches(tested.owner, owner, key))
        return `the feature test at ${where} reads it and was decided when the program was built, so it would not see the change`;
    return null;
  }
  if (site.kind === "global")
    return owner === "globalThis" && site.name === key
      ? `the program uses it at ${where}${NO_OBJECT}the use would not see the change`
      : null;
  if (site.kind === "construct") {
    const byClass = t.constructs.get(site.construct);
    if (byClass === undefined) return null;
    const untyped = site.classes === null;
    const classes: Classes = DEEP_CONSTRUCTS.has(site.construct) ? null : site.classes;
    // The runtime's untyped iteration reads an array's iterator from the object.
    const servedKey = site.served && untyped && key === "@@iterator" && owner === "Array.prototype";
    const reads = someClass(classes, (cls) => {
      const row = byClass.get(cls);
      if (row === undefined) return false;
      if (row.others.has(wanted)) return true;
      return row.keys.has(key) && !servedKey && instanceReads(cls, owner, key);
    });
    if (!reads || operandImplements(lowerer, site.operand, key)) return null;
    const [name, short] = CONSTRUCT_NAMES[site.construct]!;
    return `${name} at ${where} reads it${NO_OBJECT}${short} would not see the change`;
  }
  if (site.kind === "callee") {
    const row = t.callees.get(site.callee);
    if (row === undefined) return null;
    let reads = row.others.has(wanted) && SERVED_ADDERS[site.callee] !== wanted;
    if (!reads && row.keys.has(key)) {
      const untyped = site.classes === null;
      // The runtime's Array.from reads the iterator from the object when its
      // argument is untyped, and in every JavaScript source.
      const served =
        site.callee === "Array.from" &&
        key === "@@iterator" &&
        owner === "Array.prototype" &&
        (untyped || isJsSourceFile(ts.getSourceFileOfNode(site.node)));
      const classes: Classes = DEEP_KEYS.has(key) ? null : site.classes;
      reads =
        !served &&
        someClass(classes, (cls) => instanceReads(cls, owner, key)) &&
        !operandImplements(lowerer, site.operand, key);
    }
    return reads
      ? `the program calls '${site.callee.replace("new:", "new ")}' at ${where}, which reads it${NO_OBJECT}the call would not see the change`
      : null;
  }
  // A reference to a member: the written member itself, or one that reads it.
  const verb = site.called ? "calls" : "reads";
  const noun = site.called ? "the call" : "the read";
  if (site.key === key) {
    let reads: boolean;
    if (site.object !== null) {
      // The runtime serves a value read through Array.prototype from the object.
      const served = site.object === "Array.prototype" && !site.called;
      reads = !served && readReaches(site.object, owner, key);
    } else if (!owner.endsWith(".prototype")) {
      // A constructor's or a namespace's member is read through that object
      // alone; a value that holds the object is served by the runtime.
      reads = false;
    } else if (site.classes === null) {
      // The runtime serves a value read of an array's member through an
      // untyped value from the object; a call through an untyped value
      // reaches the built-in directly.
      const served = owner === "Array.prototype" && !site.called;
      reads = !served && !instanceHolds(owner, key);
    } else reads = someClass(site.classes, (cls) => instanceReads(cls, owner, key));
    if (reads)
      return `the program ${verb} it at ${where}${NO_OBJECT}${noun} would not see the change`;
  }
  const owners = t.memberOwners.get(site.key);
  if (owners === undefined) return null;
  // The classes the member is called on: the receiver's, or the first
  // argument's for `X.prototype.key.call(receiver)`.
  const receivers: Classes = site.through
    ? site.throughClasses
    : site.object !== null
      ? site.object.endsWith(".prototype")
        ? [site.object]
        : []
      : site.classes;
  for (const prototype of owners) {
    // An accessor reads when it is read; a method reads when it is called.
    if (!site.called && builtinOwnMemberKind(prototype, site.key) !== "a") continue;
    const row = t.members.get(`${prototype} ${site.key}`)!;
    const dispatches = (cls: string): boolean => {
      for (const at of builtinObjectChain(chainStart(cls))) {
        if (at === prototype) return true;
        if (builtinOwnMemberKind(at, site.key) !== null) return false;
      }
      return false;
    };
    const reads = someClass(receivers, (cls) => {
      if (!dispatches(cls)) return false;
      return row.others.has(wanted) || (row.keys.has(key) && instanceReads(cls, owner, key));
    });
    if (reads)
      return `the program ${verb} '${builtinMemberName(prototype, site.key)}' at ${where}, which reads it${NO_OBJECT}${noun} would not see the change`;
  }
  return null;
}

/** What the walk looks for, from the writes: the names of members and
 * callees worth resolving and the constructs worth collecting. Nearly every
 * node of a program is passed over by a name test. */
interface Interest {
  /** Member names: the written keys and the members that read one. */
  members: Set<string>;
  callees: Set<string>;
  /** The last name of each callee ("from" for "Array.from"). */
  calleeNames: Set<string>;
  constructs: Set<string>;
  /** Global names the program replaces. */
  globals: Set<string>;
}

function interestOf(writes: readonly BuiltinMemberWrite[]): Interest {
  const t = readerTables();
  const interest: Interest = {
    members: new Set(),
    callees: new Set(),
    calleeNames: new Set(),
    constructs: new Set(),
    globals: new Set(),
  };
  const touches = (row: Reads): boolean => {
    for (const write of writes)
      if (row.keys.has(write.member) || row.others.has(`${write.owner} ${write.member}`))
        return true;
    return false;
  };
  for (const write of writes) {
    interest.members.add(write.member);
    if (write.owner === "globalThis") interest.globals.add(write.member);
  }
  for (const [member, row] of t.members)
    if (touches(row)) interest.members.add(member.slice(member.indexOf(" ") + 1));
  for (const [callee, row] of t.callees) {
    if (!touches(row)) continue;
    interest.callees.add(callee);
    interest.calleeNames.add(
      callee.slice(Math.max(callee.lastIndexOf("."), callee.lastIndexOf(":")) + 1),
    );
  }
  for (const [construct, byClass] of t.constructs)
    for (const row of byClass.values())
      if (touches(row)) {
        interest.constructs.add(construct);
        break;
      }
  // The member calls that hold an operand of a construct: a reaction's
  // result is resolved, and join converts each element.
  if (interest.constructs.has("resolve"))
    for (const name of ["then", "catch", "finally"]) interest.members.add(name);
  if (interest.constructs.has("string")) interest.members.add("join");
  return interest;
}

/** `node`'s parent, looking out through parentheses and type-only wrappers,
 * with the child of that parent `node` sits in. */
function outerParent(node: ts.Node): { parent: ts.Node | undefined; child: ts.Node } {
  let child = node;
  let parent = node.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
}

/** How a member access is used: written (the target of an assignment, an
 * update or a `delete`), called, called through `.call`/`.apply`/`.bind`
 * (`call` is then that call), or read. */
interface AccessUse {
  how: "write" | "call" | "through" | "read";
  call: ts.CallExpression | null;
}

function accessUse(access: ts.Node): AccessUse {
  const { parent, child } = outerParent(access);
  const use = (how: "write" | "call" | "read"): AccessUse => ({ how, call: null });
  if (parent === undefined) return use("read");
  if (ts.isBinaryExpression(parent))
    return use(
      parent.left === child && isAssignmentOperator(parent.operatorToken.kind) ? "write" : "read",
    );
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    const op = parent.operator;
    return use(
      op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken ? "write" : "read",
    );
  }
  if (ts.isDeleteExpression(parent)) return use("write");
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    return use(parent.expression === child ? "call" : "read");
  if (ts.isTaggedTemplateExpression(parent)) return use(parent.tag === child ? "call" : "read");
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
    const name = parent.name.text;
    if (name !== "call" && name !== "apply" && name !== "bind") return use("read");
    const outer = outerParent(parent);
    if (outer.parent !== undefined && ts.isCallExpression(outer.parent))
      if (outer.parent.expression === outer.child) return { how: "through", call: outer.parent };
  }
  return use("read");
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === kind) === true;
}

/** The sites of one module that the writes make worth looking at. */
function collectSites(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  interest: Interest,
  sites: Site[],
): void {
  const construct = (
    name: string,
    node: ts.Node,
    operand: ts.Expression | null,
    served = false,
  ): void => {
    if (!interest.constructs.has(name)) return;
    const classes: Classes =
      operand === null || DEEP_CONSTRUCTS.has(name) ? null : classesOf(lowerer, operand);
    sites.push({ kind: "construct", node, construct: name, classes, operand, served });
  };
  /** The conversion of an operand that is not a primitive. */
  const conversion = (name: string, operand: ts.Expression): void => {
    if (interest.constructs.has(name)) construct(name, operand, operand);
  };
  ts.walkPreorder(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      // A computed key is converted to a property key.
      if (ts.isElementAccessExpression(n)) conversion("string", n.argumentExpression);
      const key = ts.isPropertyAccessExpression(n)
        ? ts.isIdentifier(n.name)
          ? n.name.text
          : null
        : interest.members.size > 0
          ? staticMemberKey(lowerer, n)
          : null;
      if (key === null || !interest.members.has(key)) return undefined;
      const use = accessUse(n);
      if (use.how === "write") return undefined;
      const object = mayNameBuiltinObject(lowerer, n.expression)
        ? builtinObjectOf(lowerer, n.expression)
        : null;
      let classes: Classes = null;
      if (object === null) {
        const origin = ts.isPropertyAccessExpression(n)
          ? memberOrigin(lowerer, safeSymbol(lowerer, n.name))
          : "stdlib";
        // A member the program implements itself is not a built-in's.
        if (origin === "user") return undefined;
        if (origin === "stdlib") classes = classesOf(lowerer, n.expression);
      }
      let throughClasses: Classes = null;
      if (use.call !== null) {
        const receiver = use.call.arguments.nodes[0];
        if (receiver !== undefined && !ts.isSpreadElement(receiver))
          throughClasses = classesOf(lowerer, receiver);
      }
      sites.push({
        kind: "member",
        node: n,
        key,
        object,
        classes,
        called: use.how !== "read",
        through: use.call !== null,
        throughClasses,
      });
      // A reaction's result and an array's elements are operands of their own.
      if (use.how === "call" && (key === "then" || key === "catch" || key === "finally"))
        construct("resolve", n, null);
      if (use.how === "call" && key === "join" && interest.constructs.has("string"))
        sites.push({
          kind: "construct",
          node: n,
          construct: "string",
          classes: elementClasses(lowerer, n.expression),
          operand: null,
          served: false,
        });
      return undefined;
    }
    if (ts.isObjectBindingPattern(n)) {
      // `const { random } = Math` reads each named member through its source.
      const holder = n.parent;
      if (holder === undefined || !ts.isVariableDeclaration(holder)) return undefined;
      const source = holder.initializer;
      if (source === undefined) return undefined;
      let resolved = false;
      let object: string | null = null;
      let classes: Classes = null;
      for (const element of n.elements.nodes) {
        const name = element.propertyName ?? element.name;
        if (!ts.isIdentifier(name) || !interest.members.has(name.text)) continue;
        if (!resolved) {
          resolved = true;
          object = mayNameBuiltinObject(lowerer, source) ? builtinObjectOf(lowerer, source) : null;
          if (object === null) classes = classesOf(lowerer, source);
        }
        sites.push({
          kind: "member",
          node: element,
          key: name.text,
          object,
          classes,
          called: false,
          through: false,
          throughClasses: null,
        });
      }
      return undefined;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      if (interest.callees.size === 0) return undefined;
      const callee = calleeOf(lowerer, n, interest);
      if (callee === null) return undefined;
      const first = n.arguments?.nodes[0];
      const operand = first === undefined || ts.isSpreadElement(first) ? null : first;
      const classes: Classes =
        first === undefined ? [] : operand === null ? null : classesOf(lowerer, operand);
      sites.push({ kind: "callee", node: n, callee, classes, operand });
      if (callee === "JSON.stringify") construct("json", n, null);
      if (callee === "new:Promise") construct("resolve", n, null);
      return undefined;
    }
    if (interest.globals.size > 0 && ts.isIdentifier(n)) {
      if (!interest.globals.has(n.text) || !readsGlobal(lowerer, n)) return undefined;
      sites.push({ kind: "global", node: n, name: n.text });
      return undefined;
    }
    if (interest.constructs.size === 0) return undefined;
    if (ts.isTemplateExpression(n)) {
      for (const span of n.templateSpans.nodes) conversion("string", span.expression);
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        conversion("concat", n.left);
        conversion("concat", n.right);
      } else if (isNumericOperator(op)) {
        conversion("number", n.left);
        conversion("number", n.right);
      } else if (op === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(n.left))
        construct("iterate", n, n.right);
      else if (op === ts.SyntaxKind.InKeyword) conversion("string", n.left);
    } else if (ts.isPrefixUnaryExpression(n)) {
      // `!` alone converts nothing.
      if (n.operator !== ts.SyntaxKind.ExclamationToken) conversion("number", n.operand);
    } else if (ts.isPostfixUnaryExpression(n)) {
      conversion("number", n.operand);
    } else if (ts.isForOfStatement(n)) {
      // for await falls back to the sync iterator, which no reader serves.
      construct("iterate", n, n.expression, n.awaitModifier === undefined);
    } else if (ts.isSpreadElement(n)) {
      construct(
        "iterate",
        n,
        n.expression,
        n.parent !== undefined && ts.isArrayLiteralExpression(n.parent),
      );
    } else if (ts.isArrayBindingPattern(n)) {
      const holder = n.parent;
      const source =
        holder !== undefined && ts.isVariableDeclaration(holder) && holder.initializer !== undefined
          ? holder.initializer
          : null;
      construct("iterate", n, source);
    } else if (ts.isYieldExpression(n)) {
      if (n.asteriskToken !== undefined && n.expression !== undefined)
        construct("iterate", n, n.expression);
    } else if (ts.isAwaitExpression(n)) {
      construct("await", n, null);
      construct("resolve", n, null);
    } else if (ts.isFunctionLike(n) && hasModifier(n, ts.SyntaxKind.AsyncKeyword))
      construct("resolve", n, null);
    return undefined;
  });
}

/** The operators that convert their operands to numbers: arithmetic,
 * bitwise, shifts, the relational comparisons, and the compound assignments
 * of those (`+=` converts as `+` does, and the logical assignments convert
 * nothing). */
function isNumericOperator(op: ts.SyntaxKind): boolean {
  if (
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  )
    return false;
  if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
    return true;
  return (
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

function safeSymbol(lowerer: Lowerer, node: ts.Node): ts.Symbol | undefined {
  try {
    return lowerer.checker.getSymbolAtLocation(node);
  } catch (e) {
    if (!unanswered(e)) throw e;
    return undefined;
  }
}

/** The classes of the elements of the array `expr` is. */
function elementClasses(lowerer: Lowerer, expr: ts.Expression): Classes {
  try {
    const type = lowerer.typeOf(expr);
    if (!lowerer.checker.isArrayType(type)) return null;
    const element = lowerer.checker.getTypeArguments(type as ts.TypeReference)[0];
    return element === undefined ? null : classesOfType(lowerer, element, 0);
  } catch (e) {
    if (!unanswered(e)) throw e;
    return null;
  }
}

/** The built-in function a call or a `new` calls, as the reader table names
 * it ("Array.from", "String", "new:Map"), when the writes make it worth
 * knowing. */
function calleeOf(
  lowerer: Lowerer,
  call: ts.CallExpression | ts.NewExpression,
  interest: Interest,
): string | null {
  const callee = withoutParenthesesTypeWrappers(call.expression);
  if (ts.isIdentifier(callee)) {
    if (!interest.calleeNames.has(callee.text)) return null;
    const name = ts.isNewExpression(call) ? `new:${callee.text}` : callee.text;
    if (!interest.callees.has(name)) return null;
    return stdlibGlobalNameOf(lowerer, callee) === callee.text ? name : null;
  }
  if (!ts.isPropertyAccessExpression(callee) || !interest.calleeNames.has(callee.name.text))
    return null;
  if (!mayNameBuiltinObject(lowerer, callee.expression)) return null;
  const object = builtinObjectOf(lowerer, callee.expression);
  if (object === null) return null;
  const name = object === "globalThis" ? callee.name.text : `${object}.${callee.name.text}`;
  return interest.callees.has(name) ? name : null;
}

/** Whether an identifier reads the standard library's global of its name:
 * not a declaration's or a member's name, and not the target of the write. */
function readsGlobal(lowerer: Lowerer, id: ts.Identifier): boolean {
  const parent = id.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === id)
    return false;
  if (accessUse(id).how === "write") return false;
  try {
    return stdlibGlobalNameOf(lowerer, id) === id.text;
  } catch (e) {
    if (!unanswered(e)) throw e;
    return false;
  }
}

/** The outermost function or class around `node`, or null when `node` is
 * module code that runs as the module evaluates. */
function outermostScope(node: ts.Node): ts.Node | null {
  let outer: ts.Node | null = null;
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (ts.isFunctionLike(at) || ts.isClassDeclaration(at) || ts.isClassExpression(at)) outer = at;
  return outer;
}

function insideLoop(node: ts.Node): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (
      ts.isForStatement(at) ||
      ts.isForInStatement(at) ||
      ts.isForOfStatement(at) ||
      ts.isWhileStatement(at) ||
      ts.isDoStatement(at)
    )
      return true;
  return false;
}

/** The statement of the module's top level that holds `node`. */
function topLevelStatement(node: ts.Node): ts.Node {
  let at = node;
  while (at.parent !== undefined && !ts.isSourceFile(at.parent)) at = at.parent;
  return at;
}

const IDENTIFIERS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.Identifier]);

/** Whether code that runs before `end` can reach the function `name`
 * declares: the module names it before `end` (other than at `except`, its
 * declaration), or exports it by name, which lets a module of an import
 * cycle call it before this module's own code runs. */
function reachableBefore(sf: ts.SourceFile, name: string, end: number, except: ts.Node): boolean {
  let found = false;
  ts.walkPreorder(
    sf,
    (n) => {
      if (n === except || !ts.isIdentifier(n) || n.text !== name) return undefined;
      const exported =
        n.parent !== undefined &&
        (ts.isExportSpecifier(n.parent) || ts.isExportAssignment(n.parent));
      if (!exported && ts.tokenStartOfNode(n) >= end) return undefined;
      found = true;
      return "stop";
    },
    IDENTIFIERS,
  );
  return found;
}

/** Whether the site runs before every one of the writes, so that it reads
 * the member the built-in has: the site is module code outside every
 * function and loop, in the module that holds all of the writes, and each
 * write comes after it. A write inside a function comes after it when the
 * function cannot have been called yet: a function expression made later,
 * or a declared function the module neither names before the site nor
 * exports. */
function runsBeforeWrites(site: ts.Node, writes: readonly BuiltinMemberWrite[]): boolean {
  // A function's own site (an async function resolves what it returns)
  // stands for its body, which runs when it is called.
  if (ts.isFunctionLike(site) || outermostScope(site) !== null || insideLoop(site)) return false;
  const sf = ts.getSourceFileOfNode(site);
  const end = site.end;
  for (const write of writes) {
    if (ts.getSourceFileOfNode(write.node) !== sf) return false;
    // A read inside the write's own expression is evaluated first
    // (`Date.now = wrap(Date.now)`).
    if (ts.tokenStartOfNode(write.node) <= ts.tokenStartOfNode(site) && end <= write.node.end)
      continue;
    const scope = outermostScope(write.node);
    if (scope === null) {
      if (ts.tokenStartOfNode(write.node) < end) return false;
      continue;
    }
    if (ts.isFunctionDeclaration(scope)) {
      // Hoisted: only code that names it can have called it.
      if (scope.name === undefined || hasModifier(scope, ts.SyntaxKind.ExportKeyword)) return false;
      if (reachableBefore(sf, scope.name.text, end, scope.name)) return false;
    } else if (ts.tokenStartOfNode(topLevelStatement(scope)) < end) return false;
  }
  return true;
}

/** Refuses each recorded write to a built-in member that the program also
 * reads natively (SC1092), at the write, naming the first such read. A
 * program that recorded no write pays one size test. */
export function refuseUnseenBuiltinMemberWrites(lowerer: Lowerer): void {
  if (lowerer.builtinMemberWrites.size === 0) return;
  const writes = [...lowerer.builtinMemberWrites.values()];
  const interest = interestOf(writes);
  const sites: Site[] = [];
  for (const test of lowerer.builtinFeatureTests) {
    const members = builtinMembersTested(lowerer, test);
    if (members.length > 0) sites.push({ kind: "test", node: test, members });
  }
  const modules = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  for (const sf of modules) if (!sf.isDeclarationFile) collectSites(lowerer, sf, interest, sites);
  const refused: ScrDiagnostic[] = [];
  for (const write of writes) {
    const same = writes.filter((w) => w.owner === write.owner && w.member === write.member);
    for (const site of sites) {
      const use = siteReads(lowerer, site, write);
      if (use === null || runsBeforeWrites(site.node, same)) continue;
      refused.push(
        builtinMemberWriteDiag(
          builtinMemberName(write.owner, write.member),
          write.action,
          use,
          locOf(write.at),
        ),
      );
      dropSupersededDiags(lowerer, write);
      break;
    }
  }
  for (const d of refused) lowerer.pushDiag(d);
}

/** A refusal lowering raised for the write itself (at the write, or at the
 * member it names) says the write has no lowering; the refusal by name
 * replaces it. A refusal inside the value the write assigns stays. */
function dropSupersededDiags(lowerer: Lowerer, write: BuiltinMemberWrite): void {
  const whole = locOf(write.node);
  const target = locOf(write.at);
  for (let i = lowerer.diags.length - 1; i >= 0; i--) {
    const d = lowerer.diags[i]!;
    if (d.code === "SC9001" || d.loc.file !== whole.file) continue;
    const atWrite = d.loc.start === whole.start && d.loc.end <= whole.end;
    const atTarget = d.loc.start >= target.start && d.loc.end <= target.end;
    if (atWrite || atTarget) lowerer.diags.splice(i, 1);
  }
}
