/* Own properties that JavaScript adds to a native handle: a ChildProcess
 * (execa's mixin assigns `spawned.kill = ...` and defines then/catch/finally
 * with Reflect.defineProperty, and its callers await the child as a
 * thenable), a Date, RegExp, Map, Set, WeakMap, WeakSet, ArrayBuffer,
 * SharedArrayBuffer or FinalizationRegistry (`d = new Date(); d.tag = 1`).
 *
 * The runtime keeps such properties in a side table per handle
 * (scr_dyn_handle_props.c). Only programs that can add one link it: a
 * JavaScript write of a property onto a typed handle, a type-visible
 * definition or integrity call on one, or JavaScript that calls
 * defineProperty in a program whose JavaScript loads child_process. Those
 * programs install the table at start, and their defineProperty,
 * getOwnPropertyDescriptor, thenable await and typed `child.on(event,
 * listener)` calls take the entries that consult it. Every other program
 * lowers exactly as before.
 *
 * A write or definition of a name the handle's class DECLARES is a grant:
 * the compiler censuses the shadowed names per class (`d.getTime = f` on a
 * Date) and hands them to the runtime at start, and the typed readers,
 * calls and deletes of those names go through the checked-dynamic box so
 * the own property wins. Names a builtin algorithm or an implicit
 * conversion reads natively (exec, constructor, then, lastIndex, size, …)
 * keep the refusal, and so does a typed implicit conversion
 * (`String(d)`, `` `${d}` ``, `d == "x"`) of a class whose toString the
 * program replaces. */
import * as ts from "../ts7/adapter.js";
import { constituentTypes } from "../ts7/checker.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { IrExpr, IrFunction, IrLibFn, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { DYN, F64, STRING, VOID } from "../../ir/ir.js";
import { everyStmt, transformStmtList } from "../../ir/traverse.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";
import { GUARDED_CONSUMERS, consumerName } from "./primitive-wrappers.js";
import {
  childStreamSetsEncoding,
  lowerWithCheckedParams,
} from "./builtins/child-process-methods.js";

/** `child.name = value` in a JavaScript file over a typed child: the write
 * lands in the child's property table through its checked-dynamic box. */
export function lowerChildPropertyWrite(
  lowerer: Lowerer,
  recv: IrExpr,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  loc: SrcLoc,
): IrStmt {
  lowerer.writesOntoChildren = true;
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [
        lowerer.coerceToExpected(recv, DYN),
        { kind: "strLit", value: target.name.text, type: STRING, loc },
        lowerer.lowerExprExpecting(value, DYN),
      ],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `child.kill` as a value in a JavaScript file (`spawned.kill.bind(spawned)`):
 * the method read off the child's checked-dynamic box, which answers a
 * function acting on that child. */
export function lowerChildMethodValue(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(node))) return null;
  const recv = tryLowerExpression(lowerer, node.expression);
  if (recv?.type.kind !== "child") return null;
  lowerer.writesOntoChildren = true;
  const loc = locOf(node);
  return {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(recv, DYN),
    key: { kind: "strLit", value: node.name.text, type: STRING, loc },
    type: DYN,
    loc,
  };
}

/** ChildProcess and EventEmitter member names: reads and calls of these on
 * a typed child keep their typed lowering (or its diagnostic) unless the
 * program assigns the name onto a child. */
const CHILD_MEMBERS: ReadonlySet<string> = new Set([
  "addListener",
  "channel",
  "connected",
  "disconnect",
  "emit",
  "eventNames",
  "exitCode",
  "getMaxListeners",
  "kill",
  "killed",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "pid",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "ref",
  "removeAllListeners",
  "removeListener",
  "send",
  "setMaxListeners",
  "signalCode",
  "spawnargs",
  "spawnfile",
  "stderr",
  "stdin",
  "stdio",
  "stdout",
  "unref",
]);

interface ChildAdditions {
  /** Names JavaScript assigns or defines onto typed children. */
  written: ReadonlySet<string>;
  /** Whether a write or definition uses a key that is not a literal. */
  everyName: boolean;
  /** Whether the program can add properties to children at all. */
  any: boolean;
}

/** What the program's JavaScript adds to children: `child.name = value`
 * writes onto typed children in any JavaScript file of a program that
 * loads child_process, and defineProperty calls in such a program. */
function childAdditions(lowerer: Lowerer): ChildAdditions {
  let known = lowerer.childAdditions;
  if (known) return known;
  const written = new Set<string>();
  const files = lowerer.program
    .getImplementationSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isJsSourceFile(sf));
  const spawns = files.some((sf) => sf.text.includes("child_process"));
  const defines = files.some((sf) => sf.text.includes("defineProperty"));
  // A child can reach any module (`module.exports = (child) => { child.x =
  // ... }`), so once some file loads child_process every JavaScript file's
  // writes onto children count.
  // A key that is not a literal may name any member, so every member then
  // goes through the child's box.
  let everyName = false;
  const isChild = (e: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(e))?.kind === "child";
  const key = (k: ts.Expression | ts.PropertyName): void => {
    if (ts.isIdentifier(k) || ts.isStringLiteralLike(k) || ts.isNumericLiteral(k))
      written.add(k.text);
    else everyName = true;
  };
  for (const sf of spawns ? files : []) {
    // Iterative: a whole-file walk must not recurse (a 7000-level
    // expression is a named deferred fence, not a stack overflow).
    walkFile(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        isChild(node.left.expression)
      ) {
        if (ts.isPropertyAccessExpression(node.left)) written.add(node.left.name.text);
        else key(node.left.argumentExpression);
      }
      // `Object.defineProperty(child, "kill", { value })`, its Reflect
      // twin, and `Object.defineProperties(child, { kill: ... })`.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === "Object" ||
          node.expression.expression.text === "Reflect")
      ) {
        const method = node.expression.name.text;
        const [target, second] = node.arguments.nodes;
        if (target && second && isChild(target)) {
          if (method === "defineProperty") key(second);
          else if (method === "defineProperties") {
            if (!ts.isObjectLiteralExpression(second)) everyName = true;
            else
              for (const prop of second.properties.nodes) {
                const name = prop.name;
                if (
                  name !== undefined &&
                  (ts.isIdentifier(name) ||
                    ts.isStringLiteralLike(name) ||
                    ts.isNumericLiteral(name))
                )
                  written.add(name.text);
                else everyName = true;
              }
          }
        }
      }
      return true;
    });
  }
  known = { written, everyName, any: written.size > 0 || everyName || (spawns && defines) };
  lowerer.childAdditions = known;
  return known;
}

/** Stdlib classes whose instances are runtime handles with an own-property
 * table (scr_dyn_handle_props.c's HP_TAGS). */
const HANDLE_CLASSES: ReadonlySet<string> = new Set([
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "FinalizationRegistry",
]);

/** Visits the file's nodes outermost first, iteratively: these censuses
 * walk every body before reachability is known, and a recursively nested
 * expression (a 7000-level chain is a named deferred fence at lowering,
 * not a compiler stack overflow) must not overflow here either. */
function walkFile(sf: ts.SourceFile, visit: (node: ts.Node) => boolean): void {
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!visit(node)) return;
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
}

/** The handle class `node`'s checker type names (a union names one only
 * when every constituent is that class), or null. */
export function handleClassOf(lowerer: Lowerer, node: ts.Node): string | null {
  const names = new Set<string>();
  const visit = (t: ts.Type): boolean => {
    if (t.flags & ts.TypeFlags.Union) return constituentTypes(t).every(visit);
    const sym = t.getAliasSymbol() ?? t.getSymbol();
    if (!sym || !HANDLE_CLASSES.has(ts.symbolName(sym))) return false;
    if (!sym.declarations.some((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d))))
      return false;
    names.add(ts.symbolName(sym));
    return true;
  };
  return visit(lowerer.typeOf(node)) && names.size === 1 ? [...names][0]! : null;
}

/** Member names a grant never opens (the runtime's deny list,
 * scr_dyn_handle_props.c): a builtin algorithm reads them from the native
 * object (RegExpExec, species, thenables, lastIndex, the RegExp flag
 * getters, Map/Set iteration and size), JSON.stringify looks for toJSON,
 * and the Object.prototype probes have lowerings of their own. The write
 * keeps H1's refusal. */
const DENIED_HANDLE_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "then",
  "exec",
  "lastIndex",
  "flags",
  "global",
  "source",
  "ignoreCase",
  "multiline",
  "dotAll",
  "sticky",
  "unicode",
  "unicodeSets",
  "hasIndices",
  "size",
  "toJSON",
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Member names a grant never opens for one class, because a builtin
 * algorithm reads them from the native object in a way the wrapper cannot
 * route: Set and Map composition methods read the argument's `has` and
 * `keys` through GetSetRecord, and Date.prototype.toJSON reads
 * `toISOString` from its receiver. A denied grant keeps the H1 refusal. */
const DENIED_HANDLE_MEMBERS_BY_CLASS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Date", new Set(["toISOString"])],
  ["Map", new Set(["has", "keys"])],
  ["Set", new Set(["has", "keys"])],
]);

/** Classes whose implicit conversions reach an own property: the runtime's
 * ToPrimitive path calls the tag's ops, which the wrapper routes to the
 * table. Anywhere else an implicit reader would still read the native
 * object, so the grant is refused rather than diverging silently. */
const GRANTABLE_IMPLICIT_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Date", new Set(["toString", "toLocaleString", "valueOf"])],
  ["RegExp", new Set(["toString", "toLocaleString"])],
]);

/** Whether an own property may shadow member `name` of `cls`. */
function handleMemberGrantable(cls: string, name: string): boolean {
  if (DENIED_HANDLE_MEMBERS.has(name)) return false;
  if (DENIED_HANDLE_MEMBERS_BY_CLASS.get(cls)?.has(name) === true) return false;
  if (name === "toString" || name === "valueOf" || name === "toLocaleString")
    return GRANTABLE_IMPLICIT_MEMBERS.get(cls)?.has(name) ?? false;
  return true;
}

/** A granted name has to survive the grant string's `<Class>:<name>,<name>`
 * encoding, so a name holding one of its separators (or a non-printable
 * character) grants nothing and keeps the refusal. */
function encodableGrantName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 0x2c || c === 0x3b || c === 0x3a) return false;
  }
  return true;
}

/** What the program's JavaScript adds to handles: per class, the member
 * names it writes or defines (their typed readers and calls reroute through
 * the checked-dynamic box), and whether it adds an own property at all — a
 * name the class does not declare needs no grant. */
interface HandleAdditions {
  readonly grants: ReadonlyMap<string, ReadonlySet<string>>;
  readonly any: boolean;
}

/** The literal name a write or delete target names, or null when the key is
 * computed (which can name any member, so it grants nothing). */
function literalKeyOf(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const key = access.argumentExpression;
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null;
}

/** Whether the program's JavaScript adds own properties to handles: a
 * write or delete of a name the handle class does not declare, a
 * defineProperty/defineProperties/preventExtensions/seal/freeze call on a
 * handle, or a write or definition of a member name the class's own
 * properties may shadow (a grant). TypeScript files never count. */
function handleAdditions(lowerer: Lowerer): HandleAdditions {
  const known = lowerer.handleAdditions;
  if (known) return known;
  const grants = new Map<string, Set<string>>();
  let any = false;
  const files = lowerer.program
    .getImplementationSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isJsSourceFile(sf));
  const integrity = new Set([
    "defineProperty",
    "defineProperties",
    "preventExtensions",
    "seal",
    "freeze",
  ]);
  // A grant for `name` of `cls`: a member name is granted when the class's
  // own properties may shadow it; any other name is an ordinary table entry.
  const grant = (cls: string, name: string): void => {
    if (!encodableGrantName(name)) return;
    let names = grants.get(cls);
    if (!names) grants.set(cls, (names = new Set()));
    names.add(name);
  };
  // A write or delete of `name` on a `cls` handle. A member name counts as
  // an addition only when it may be granted: a denied one keeps H1's
  // ordinary-member lowering and installs no table on its own.
  const record = (cls: string, name: string | null, member: boolean): void => {
    if (name !== null && member && !handleMemberGrantable(cls, name)) return;
    any = true;
    if (name !== null && member) grant(cls, name);
  };
  // `Object.defineProperty(handle, "name", …)`'s key: a literal names the
  // entry, anything else can name any member and grants nothing. Any
  // definition on a handle counts as an addition (H1), so the table answers
  // a denied member with its refusal instead of the ordinary path.
  const recordDefined = (
    cls: string,
    target: ts.Expression,
    key: ts.Node,
    literal: boolean,
  ): void => {
    any = true;
    const name =
      literal && (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
        ? key.text
        : null;
    if (name === null) return;
    const member = hasDeclaredProperty(lowerer, target, name);
    if (member && !handleMemberGrantable(cls, name)) return;
    if (member) grant(cls, name);
  };
  // A whole-program census visits every body, reached or not, so no
  // statement owns the local-class refusal a type query here may trigger
  // (collectLocalClassForType leaves it reported instead of poisoning the
  // compile).
  lowerer.speculativeTypeQueries(() => {
    for (const sf of files) {
      walkFile(sf, (node) => {
        if (
          ts.isBinaryExpression(node) &&
          ts.isAssignmentOperator(node.operatorToken.kind) &&
          (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        ) {
          const cls = handleClassOf(lowerer, node.left.expression);
          const name = literalKeyOf(node.left);
          if (cls)
            record(
              cls,
              name,
              name !== null && hasDeclaredProperty(lowerer, node.left.expression, name),
            );
        } else if (
          ts.isDeleteExpression(node) &&
          (ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression))
        ) {
          const cls = handleClassOf(lowerer, node.expression.expression);
          const name = literalKeyOf(node.expression);
          // Deleting a name the class declares removes no own property of a
          // handle that has none, and the ordinary delete keeps its answer.
          if (
            cls &&
            (name === null || !hasDeclaredProperty(lowerer, node.expression.expression, name))
          )
            record(cls, name, false);
        } else if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (node.expression.expression.text === "Object" ||
            node.expression.expression.text === "Reflect") &&
          integrity.has(node.expression.name.text)
        ) {
          const [target, second] = node.arguments.nodes;
          if (!target) return true;
          const cls = handleClassOf(lowerer, target);
          if (!cls) return true;
          const method = node.expression.name.text;
          if (method !== "defineProperty" && method !== "defineProperties") {
            any = true;
            return true;
          }
          if (!second) return true;
          if (method === "defineProperty" || !ts.isObjectLiteralExpression(second)) {
            recordDefined(cls, target, second, method === "defineProperty");
          } else {
            for (const prop of second.properties.nodes) {
              const nameNode = prop.name;
              if (nameNode !== undefined) recordDefined(cls, target, nameNode, true);
              else any = true;
            }
          }
        }
        return true;
      });
    }
  });
  const frozen = { grants, any } as HandleAdditions;
  lowerer.handleAdditions = frozen;
  return frozen;
}

/** Whether the program's JavaScript adds own properties to handles. */
export function programAddsHandleProperties(lowerer: Lowerer): boolean {
  return handleAdditions(lowerer).any;
}

/** Whether the program's JavaScript writes or defines member `name` of the
 * handle class `receiver` names, so its typed readers and calls reroute
 * through the checked-dynamic box. */
function memberGranted(lowerer: Lowerer, receiver: ts.Expression, name: string): boolean {
  const additions = handleAdditions(lowerer);
  if (additions.grants.size === 0) return false;
  const cls = handleClassOf(lowerer, receiver);
  return cls !== null && additions.grants.get(cls)?.has(name) === true;
}

/** The nodes the own-property census above reads the type of: every
 * JavaScript write receiver, delete target and integrity-call target, plus
 * the expression chain `Lowerer.typeOf` walks for a property-access
 * receiver. `Lowerer.emitReachable` batches their types ahead of
 * collection so the census makes no per-node checker request inside a
 * deferred body. */
export function handlePropertyScanRoots(sourceFiles: readonly ts.SourceFile[]): ts.Node[] {
  const roots: ts.Node[] = [];
  const receiver = (e: ts.Expression): void => {
    for (let n: ts.Expression = e; ;) {
      roots.push(n);
      if (
        ts.isPropertyAccessExpression(n) ||
        ts.isElementAccessExpression(n) ||
        ts.isParenthesizedExpression(n) ||
        ts.isNonNullExpression(n) ||
        ts.isAsExpression(n)
      )
        n = n.expression;
      else return;
    }
  };
  for (const sf of sourceFiles) {
    if (sf.isDeclarationFile || !isJsSourceFile(sf)) continue;
    walkFile(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      )
        receiver(node.left.expression);
      else if (
        ts.isDeleteExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression))
      )
        receiver(node.expression.expression);
      else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === "Object" ||
          node.expression.expression.text === "Reflect") &&
        (node.expression.name.text === "defineProperty" ||
          node.expression.name.text === "defineProperties" ||
          node.expression.name.text === "preventExtensions" ||
          node.expression.name.text === "seal" ||
          node.expression.name.text === "freeze") &&
        node.arguments.nodes[0] !== undefined
      )
        receiver(node.arguments.nodes[0]);
      return true;
    });
  }
  return roots;
}

/** The typed handle kinds a JavaScript program can hold (Date, ArrayBuffer,
 * WeakMap, WeakSet and FinalizationRegistry are already checked-dynamic
 * values there). */
export const TYPED_HANDLE_KINDS: ReadonlySet<string> = new Set(["date", "regex", "map", "set"]);

/** Whether the program has a JavaScript implementation file: only such a
 * program can add own properties to a handle, so every other program keeps
 * its typed handle lowerings untouched. */
function programHasJsSource(lowerer: Lowerer): boolean {
  let known = lowerer.handleJsSources;
  if (known === undefined) {
    known = lowerer.program
      .getImplementationSourceFiles()
      .some((sf) => !sf.isDeclarationFile && isJsSourceFile(sf));
    lowerer.handleJsSources = known;
  }
  return known;
}

/** A typed handle receiver of a program that adds properties to handles,
 * boxed into its checked-dynamic value; null otherwise. A program without a
 * JavaScript file never adds one, so its typed reads and writes stay typed. */
export function boxedHandleReceiver(lowerer: Lowerer, recv: IrExpr | null): IrExpr | null {
  if (!recv || !TYPED_HANDLE_KINDS.has(recv.type.kind)) return null;
  if (!programHasJsSource(lowerer) || !programAddsHandleProperties(lowerer)) return null;
  return lowerer.coerceToExpected(recv, DYN);
}

/** `m.label = 1` in a JavaScript file over a typed handle: the write lands
 * in the handle's property table through its checked-dynamic box. */
export function lowerHandlePropertyWrite(
  lowerer: Lowerer,
  recv: IrExpr,
  key: IrExpr,
  value: ts.Expression,
  loc: SrcLoc,
): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: key.type.kind === "string" ? "dyn.keySet" : "dyn.keySetComputed",
      args: [recv, key, lowerer.lowerExprExpecting(value, DYN)],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** `m.label` as a value over a typed handle in a JavaScript file of a
 * program that adds properties to handles, and `d.getTime` when the program
 * shadows that member: the box answers its own property first. */
export function lowerHandlePropertyRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr | null {
  if (access.questionDotToken) return null;
  // A typed handle receiver only: the grant query below is a whole-program
  // census, and every other receiver reads its member statically.
  if (!TYPED_HANDLE_KINDS.has(recv.type.kind)) return null;
  const name = access.name.text;
  const declared = hasDeclaredProperty(lowerer, access.expression, name);
  // A member name keeps its typed read unless the program's JavaScript
  // writes or defines it onto the handle.
  if (declared && !memberGranted(lowerer, access.expression, name)) return null;
  const boxed = boxedHandleReceiver(lowerer, recv);
  if (!boxed) return null;
  const loc = locOf(access);
  return {
    kind: "dynKeyGet",
    value: boxed,
    key: { kind: "strLit", value: name, type: STRING, loc },
    type: DYN,
    loc,
  };
}

/** `d.getTime()` (or `d["getTime"]()`) over a handle in a JavaScript file that
 * shadows the member: the call of the handle's own property. A Date in
 * JavaScript is already a checked-dynamic value, so its receiver is called as
 * it is; a typed handle receiver calls through its box. */
export function lowerHandleMemberCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  elementName?: string,
): IrExpr | null {
  if (call.questionDotToken) return null;
  // `d?.getTime()`: the chain lowering re-dispatches a member call whose
  // receiver it proved never nullish with the member marked handled, and
  // then the guard cannot short-circuit: the step is the plain call.
  if (access.questionDotToken && !lowerer.chainHandled.has(access)) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  // Only a program with a JavaScript file can shadow a member; every other
  // program's call stays with its typed lowering.
  if (!programHasJsSource(lowerer)) return null;
  // A receiver whose checker type names a handle class: the cheap test that
  // keeps the whole-program census below out of every other call. The typed
  // Date call lowering would otherwise claim a shadowed member.
  if (handleClassOf(lowerer, access.expression) === null) return null;
  const name = ts.isPropertyAccessExpression(access) ? access.name.text : elementName;
  if (name === undefined) return null;
  if (!memberGranted(lowerer, access.expression, name)) return null;
  const recv = tryLowerExpression(lowerer, access.expression);
  if (!recv) return null;
  const boxed =
    boxedHandleReceiver(lowerer, recv) ??
    (recv.type.kind === "dyn" && programAddsHandleProperties(lowerer) ? recv : null);
  if (!boxed) return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv: boxed,
    method: name,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** Whether `access` names a member the program's JavaScript shadows on a
 * handle (`d?.getTime` in `d?.getTime()`). The optional-chain lowering
 * consults it before it guards a member call whose receiver it proved never
 * nullish: the guarded step is then the plain shadowed call. */
export function shadowedHandleMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if (!programHasJsSource(lowerer)) return false;
  if (handleClassOf(lowerer, access.expression) === null) return false;
  const name = ts.isPropertyAccessExpression(access) ? access.name.text : literalKeyOf(access);
  return name !== null && memberGranted(lowerer, access.expression, name);
}

/** Whether the program's JavaScript writes or defines `name` onto a handle
 * of the receiver's class: a typed read, write, call or delete of the member
 * then goes through the checked-dynamic box. */
export function handleMemberGranted(
  lowerer: Lowerer,
  receiver: ts.Expression,
  name: string,
): boolean {
  return programHasJsSource(lowerer) && memberGranted(lowerer, receiver, name);
}

/** Refuses a typed implicit conversion of a handle whose class the program's
 * JavaScript granted the method the conversion would read: Node's
 * ToPrimitive reads the own property, which the typed lowering cannot see. */
export function refuseShadowedImplicitReader(
  lowerer: Lowerer,
  node: ts.Node,
  type: IrType,
  name: string,
  operation: string,
): void {
  const cls = type.kind === "date" ? "Date" : type.kind === "regex" ? "RegExp" : null;
  if (!cls || !programHasJsSource(lowerer)) return;
  const additions = handleAdditions(lowerer);
  if (additions.grants.get(cls)?.has(name) !== true) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `${operation} of a ${cls} whose ${name} the program replaces (read the property itself, or delete it first)`,
  );
}

/** Whether the checker declares `name` as a property of `receiver`'s type.
 * A member name (H2's territory) keeps its own lowering or fence; only an
 * undeclared name can be a property table entry. */
function hasDeclaredProperty(lowerer: Lowerer, receiver: ts.Expression, name: string): boolean {
  return !!lowerer.checker.getPropertyOfType(lowerer.typeOf(receiver), name);
}

/** The typed child a JavaScript member access reads from, when the member
 * is one the program may have added to it. `untyped` is the last resort
 * when no typed lowering claimed the access (a receiver the checker does
 * not type as a child, such as an untyped parameter the call site
 * instantiated with one, or a member without a typed lowering): every
 * member goes through the child's box. */
function childReceiverOf(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  untyped: boolean,
): IrExpr | null {
  if (access.questionDotToken || !isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  const additions = childAdditions(lowerer);
  const typed = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind === "child";
  if (!untyped && (!typed || !additions.any)) return null;
  const name = access.name.text;
  if (!untyped && CHILD_MEMBERS.has(name) && !additions.everyName && !additions.written.has(name))
    return null;
  const recv = tryLowerExpression(lowerer, access.expression);
  if (recv?.type.kind !== "child") return null;
  if (additions.any) lowerer.writesOntoChildren = true;
  return recv;
}

/** `child.name(...)` in JavaScript for a name the program adds to children
 * (execa's `spawned.then(...)`, its replaced `spawned.kill(...)`), or on an
 * untyped receiver holding a child (`untyped`): a member call on the
 * child's checked-dynamic box. */
export function lowerChildPropertyCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  untyped = false,
): IrExpr | null {
  if (call.questionDotToken || call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const child = childReceiverOf(lowerer, access, untyped);
  // `spawned.stdin.on(...)` over an untyped child: the member read off
  // the child's box, then the call on that value.
  const recv: IrExpr | null = child
    ? lowerer.coerceToExpected(child, DYN)
    : untyped && ts.isPropertyAccessExpression(access.expression)
      ? lowerChildPropertyRead(lowerer, access.expression)
      : null;
  if (!recv) return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv,
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg, i) =>
      i === 1 && dataListenerOfEncodedStream(lowerer, call, access)
        ? lowerer.coerceToExpected(lowerUntypedChunkListener(lowerer, arg), DYN)
        : lowerer.lowerExprExpecting(arg, DYN),
    ),
    type: DYN,
    loc,
  };
}

const LISTENER_METHODS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** `stream.on("data", (chunk) => ...)` with an unannotated chunk, on a
 * stream the program calls `setEncoding` on. The declarations type the
 * chunk as a Buffer, but after `setEncoding` Node passes strings. */
function dataListenerOfEncodedStream(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): boolean {
  const [event, listener] = call.arguments.nodes;
  if (!LISTENER_METHODS.has(access.name.text) || event === undefined || listener === undefined)
    return false;
  if (!ts.isStringLiteralLike(event) || event.text !== "data") return false;
  if (!ts.isArrowFunction(listener) && !ts.isFunctionExpression(listener)) return false;
  const chunk = listener.parameters.nodes[0];
  if (chunk === undefined || chunk.type !== undefined || !ts.isIdentifier(chunk.name)) return false;
  return childStreamSetsEncoding(lowerer, access.expression);
}

/** The listener with its chunk parameter bound as a checked-dynamic value,
 * which holds a string or a Buffer as Node passes it. */
function lowerUntypedChunkListener(lowerer: Lowerer, listener: ts.Expression): IrExpr {
  const fn = listener as ts.ArrowFunction | ts.FunctionExpression;
  const symbol = lowerer.checker.getSymbolAtLocation(fn.parameters.nodes[0]!.name);
  return symbol ? lowerWithCheckedParams(lowerer, listener, [symbol]) : lowerer.lowerExpr(listener);
}

/** `child.name` in JavaScript over an untyped receiver holding a child, or
 * for a name the program adds to children. */
export function lowerChildPropertyRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const recv = childReceiverOf(lowerer, access, true) ?? childReceiverOf(lowerer, access, false);
  if (!recv) return null;
  const loc = locOf(access);
  return {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(recv, DYN),
    key: { kind: "strLit", value: access.name.text, type: STRING, loc },
    type: DYN,
    loc,
  };
}

/** `await child` in JavaScript in a program that adds properties to
 * children: the child may be a thenable (execa's mixin). */
export function awaitsChildThenable(lowerer: Lowerer, node: ts.Node, value: IrExpr): boolean {
  if (
    value.type.kind !== "child" ||
    !isJsSourceFile(ts.getSourceFileOfNode(node)) ||
    !childAdditions(lowerer).any
  )
    return false;
  lowerer.writesOntoChildren = true;
  return true;
}

const RENAMES: ReadonlyMap<IrLibFn, IrLibFn> = new Map<IrLibFn, IrLibFn>([
  ["dyn.defineProperty", "child.propsDefine"],
  ["dyn.getOwnPropertyDescriptor", "child.propsDescriptor"],
  ["dyn.promiseResolve", "child.propsResolve"],
  ["child.onDyn", "child.propsOnDyn"],
]);

/** The member-name grants `<Class>:<name>,<name>;<Class>:…` the program's
 * JavaScript produced, sorted for a deterministic IR; null without grants. */
function grantString(lowerer: Lowerer): string | null {
  const grants = handleAdditions(lowerer).grants;
  const parts: string[] = [];
  for (const cls of [...grants.keys()].sort()) {
    const names = [...grants.get(cls)!].sort();
    if (names.length > 0) parts.push(`${cls}:${names.join(",")}`);
  }
  return parts.length > 0 ? parts.join(";") : null;
}

/** Switches a program that can add properties to handles onto the
 * property-table entries (in place), installs the table in %main, hands the
 * runtime the member names the program shadows, and guards the graph
 * walkers of a program that adds properties to handles. */
export function applyHandleProperties(lowerer: Lowerer, functions: IrFunction[]): void {
  const child = lowerer.writesOntoChildren || childAdditions(lowerer).any;
  const handle = programAddsHandleProperties(lowerer);
  if (!child && !handle) return;
  const renames = new Map<IrLibFn, IrLibFn>(child ? RENAMES : []);
  // Object.defineProperties reads every descriptor before defining any, a
  // rule only the table-aware entry point keeps.
  if (handle) renames.set("dyn.defineProps", "handle.propsDefineProps");
  // A node the IR shares at several places is renamed once.
  const calls = new Set<IrExpr & { kind: "libCall" }>();
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && renames.has(e.fn)) calls.add(e);
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) for (const s of fn.body) everyStmt(s, visitor);
  for (const call of calls) (call as { fn: IrLibFn }).fn = renames.get(call.fn)!;
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (main) {
    const loc = main.loc;
    const grants = grantString(lowerer);
    const prologue: IrStmt[] = [];
    if (grants) {
      prologue.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "handle.propsGrant",
          args: [{ kind: "strLit", value: grants, type: STRING, loc }],
          type: VOID,
          loc,
        },
        loc,
      });
    }
    prologue.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "handle.propsInstall",
        args: [{ kind: "numLit", value: child ? 1 : 0, type: F64, loc }],
        type: VOID,
        loc,
      },
      loc,
    });
    main.body.unshift(...prologue);
  }
  if (handle) guardHandleConsumers(lowerer, functions);
}

/** Whether a type holds a typed handle anywhere the dyn copy of the value
 * walks: itself, an array element, a record field, a union arm, a promise
 * payload or a collection element. */
function containsHandleKind(lowerer: Lowerer, type: IrType): boolean {
  const seen = new Set<string>();
  const visit = (t: IrType): boolean => {
    switch (t.kind) {
      case "date":
      case "regex":
      case "map":
      case "set":
        return true;
      case "array":
        return visit(t.elem);
      case "promise":
        return visit(t.inner);
      case "record":
        return (lowerer.shapes.get(t.shapeId)?.fields ?? []).some((f) => visit(f.type));
      case "union": {
        if (seen.has(t.unionId)) return false;
        seen.add(t.unionId);
        return (lowerer.unions.get(t.unionId)?.arms ?? []).some(visit);
      }
      default:
        return false;
    }
  };
  return visit(type);
}

/** The graph walkers that cannot print or compare a handle's own properties
 * refuse a value whose graph holds one: a dynamic argument passes through
 * handle.propsGuard, and a typed argument keeps its typed lowering with a
 * handle.propsCheck on a copy of the value first. */
function guardHandleConsumers(lowerer: Lowerer, functions: IrFunction[]): void {
  for (const fn of functions) {
    const guarded = (arg: IrExpr, fnName: string): IrExpr => {
      if (arg.type.kind === "dyn" || (arg.type.kind === "array" && arg.type.elem.kind === "dyn")) {
        return {
          kind: "libCall",
          fn: arg.type.kind === "dyn" ? "handle.propsGuard" : "handle.propsGuardList",
          args: [arg, { kind: "strLit", value: consumerName(fnName), type: STRING, loc: arg.loc }],
          type: arg.type,
          loc: arg.loc,
        };
      }
      if (!containsHandleKind(lowerer, arg.type)) return arg;
      const id = `%handleCheck.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type: arg.type, mutable: false });
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: id, init: arg, loc: arg.loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "handle.propsCheck",
              args: [
                {
                  kind: "dynFrom",
                  value: { kind: "varRef", localId: id, type: arg.type, loc: arg.loc },
                  type: DYN,
                  loc: arg.loc,
                },
                { kind: "strLit", value: consumerName(fnName), type: STRING, loc: arg.loc },
              ],
              type: VOID,
              loc: arg.loc,
            },
            loc: arg.loc,
          },
        ],
        result: { kind: "varRef", localId: id, type: arg.type, loc: arg.loc },
        type: arg.type,
        loc: arg.loc,
      };
    };
    fn.body = transformStmtList(fn.body, {
      expr: (expr) => {
        if (expr.kind === "libCall" && GUARDED_CONSUMERS.has(expr.fn))
          return { ...expr, args: expr.args.map((arg) => guarded(arg, expr.fn)) };
        if (
          expr.kind === "intrinsic" &&
          (expr.name === "console.log" || expr.name === "console.error")
        )
          return { ...expr, args: expr.args.map((arg) => guarded(arg, expr.name)) };
        return expr;
      },
      stmt: (stmt) => stmt,
    });
  }
}
