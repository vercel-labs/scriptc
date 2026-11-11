/** What a JavaScript source reads for a Node value no lowering has a value
 * for: the one rule of node-values.ts, applied at the read.
 *
 * Every function here is the LAST answer for its spelling. The lowerings
 * that have a real value (the call tables' function values, the interned
 * constructors, the class kinds, the constants) run first; what reaches here
 * is answered from the census of the pinned Node:
 *
 *   - Node does not have it: `undefined` (a property read) or Node's
 *     ReferenceError (a bare identifier).
 *   - Node has a function or class: the refusing function value.
 *   - Node has another value: the handful that are cheap and exact
 *     (`process.debugPort`, `performance.timeOrigin`), else the named
 *     refusal of the read. */
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { boolLit, dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import { nodeObjectMemberWriteDiag, nodeValueDiag } from "../../diagnostics/diagnostic.js";
import { isJsSourceFile, isNodeEsmFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import {
  builtinFunctionFenceValue,
  defineRefusingFunction,
  globalFunctionFenceValue,
  locatedFenceMessage,
  refusingFunctionRef,
} from "./builtin-function-fences.js";
import { builtinModuleHasMember, builtinModuleMemberCensus } from "./builtin-module-members.js";
import {
  isTruthinessOnlyRead,
  processDataMemberValue,
  processFunctionMemberValue,
  processHasIpc,
} from "./builtins/process.js";
import { NODE_GLOBALS_WITHOUT_NATIVE } from "./host-globals.js";
import { hostGlobalValue } from "./host-global-values.js";
import {
  nodeGlobalKind,
  nodeGlobalObjectMemberKind,
  nodeGlobalObjectMembers,
  nodeModuleMemberKind,
  processMemberNeedsCommonJsMain,
  processMemberNeedsIpc,
  type NodeValueKind,
} from "./node-values.js";
import { builtinFenceHintOf, stdlibGlobalNameOf } from "./surfaces.js";
import { isGlobalMember, jsGlobalValueByName } from "./global-values.js";

/** A bare read of the global `name`, or `globalThis.name`. `property` is
 * the second spelling: a name Node does not define reads undefined there
 * and throws ReferenceError as an identifier. Callers have already answered
 * the names Node does not define that the declarations type
 * (lower-namespaces.ts), so one reaching here is a module binding or a
 * compiler primitive read as a value, which stays refused. */
export function unloweredGlobalValue(
  lowerer: Lowerer,
  name: string,
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const kind = nodeGlobalKind(name);
  if (kind === null) lowerer.noLowering(name, node);
  if (kind.kind === "function") {
    if (NODE_GLOBALS_WITHOUT_NATIVE.has(name)) return hostGlobalValue(lowerer, name, node);
    refuseUnmodeledMember(lowerer, name, node);
    return globalFunctionFenceValue(lowerer, name, loc);
  }
  if (kind.type === "undefined") return dynUndefinedExpr(loc);
  // An object the census describes member by member (`process`,
  // `performance`) reads as one object that answers each member by this
  // file's rule.
  if (nodeGlobalObjectMembers(name) !== undefined) {
    // The receiver of a member access is not a read of the object: the
    // member's own lowering answers it (a lowering that probes its receiver
    // first takes the refusal as "no value" and goes on), and a member none
    // answers is refused by name. Building the object here would leave it,
    // and the object model it needs, in every program that writes
    // `process.exitCode = 1`.
    const member = receiverOfMember(node);
    if (member !== null) lowerer.nodeValueFence(`${name}.${member}`, node.parent ?? node);
    // A read whose value only feeds a truthiness test (`if (process)`,
    // `process && process.env`) needs no object either: Node's is truthy.
    if (truthinessOnly(lowerer, node)) return boolLit(true, loc);
    return nodeObjectValue(lowerer, name, node, loc);
  }
  lowerer.nodeValueFence(name, node);
}

/** The member `node` is the receiver of (`node.member`, `node["member"]`,
 * through parentheses), "[…]" for a computed key, or null when `node` is
 * not the receiver of a member access. */
function receiverOfMember(node: ts.Node): string | null {
  let read: ts.Node = node;
  while (read.parent !== undefined && ts.isParenthesizedExpression(read.parent)) read = read.parent;
  const parent = read.parent;
  if (parent === undefined) return null;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === read) return parent.name.text;
  if (ts.isElementAccessExpression(parent) && parent.expression === read) {
    const key = parent.argumentExpression;
    return ts.isStringLiteralLike(key) ? key.text : "[…]";
  }
  return null;
}

/** The value the program's global lookup (global-values.ts) holds for the
 * global `name` when no lowering has one: what the bare spelling reads,
 * without a refusal of its own. Null for a value whose read is refused,
 * which the runtime refuses when the name is asked for. `readStored` says
 * the program reads the name off a stored global object (`root.process`):
 * that read is a read of the object, wherever its value goes. */
export function storedGlobalValue(
  lowerer: Lowerer,
  name: string,
  node: ts.Node,
  loc: SrcLoc,
  readStored = false,
): IrExpr | null {
  const kind = nodeGlobalKind(name);
  if (kind === null) return null;
  if (kind.kind === "function") return globalFunctionFenceValue(lowerer, name, loc);
  // The object of `process` or `performance` is held only by a program that
  // reads it as a value somewhere: its bare spelling then answers the same
  // object, and identity across the spellings is what the stored read is
  // for. A program that never reads it keeps the refusal, and does not
  // carry the object.
  return nodeGlobalObjectMembers(name) !== undefined &&
    (readStored || programReadsGlobalValue(lowerer, name))
    ? nodeObjectValue(lowerer, name, node, loc)
    : null;
}

/** Whether `node` is an expression whose value only feeds a truthiness test. */
function truthinessOnly(lowerer: Lowerer, node: ts.Node): boolean {
  return (
    (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
    isTruthinessOnlyRead(lowerer, node)
  );
}

/** Whether a JavaScript source of the program spells the global `name` as a
 * value: the bare name or `globalThis.name`, in a position that reads the
 * object. Decided from the syntax tree and the symbols, once per name
 * (program-facts.ts, "reads-node-object-value"). */
function programReadsGlobalValue(lowerer: Lowerer, name: string): boolean {
  const cached = lowerer.nodeObjectValueReads.get(name);
  if (cached !== undefined) return cached;
  const modules = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  let found = false;
  for (const sf of modules) {
    if (found) break;
    if (!isJsSourceFile(sf)) continue;
    ts.walkPreorder(sf, (node) => {
      if (!ts.isIdentifier(node) || node.text !== name) return undefined;
      const parent = node.parent;
      // `globalThis.name`: the access is the read.
      const read: ts.Expression =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node
          ? parent
          : node;
      // Neither the receiver of a member access, nor a `typeof` operand, nor
      // a truthiness test reads the object (unloweredGlobalValue).
      if (receiverOfMember(read) !== null || truthinessOnly(lowerer, read)) return undefined;
      let outer: ts.Node | undefined = read.parent;
      while (outer !== undefined && ts.isParenthesizedExpression(outer)) outer = outer.parent;
      if (outer !== undefined && ts.isTypeOfExpression(outer)) return undefined;
      if (stdlibGlobalNameOf(lowerer, read) !== name) return undefined;
      found = true;
      return "stop";
    });
  }
  lowerer.nodeObjectValueReads.set(name, found);
  return found;
}

/** The value of a Node global object native code has no object for
 * (`process`, `performance`): one object per program, built on first read,
 * that has every member Node's object has. A function member is its real
 * function value where the spelled member has one and the refusing function
 * value otherwise, the same function either way; a data member the runtime
 * answers exactly is a getter over the same read the spelled member
 * performs, so it is as live as that read; every other member is a getter
 * that throws the refusal naming it, including one whose value in a fresh
 * Node process is undefined (`exitCode`): the program can assign it, and a
 * value fixed when the object was built would go stale. A write to a data
 * member through the object is refused by name too: the state is the
 * runtime's, written where the member is spelled. The object is frozen:
 * redefining a member, replacing a function member or adding a key throws
 * a TypeError, because the spelled members never read this object and
 * could not follow the change. So `typeof`, identity
 * (`perf === performance`, membership in the harness's known-globals Set),
 * `in` and the `typeof` of each function member are Node's, a name Node's
 * object does not have reads undefined, and nothing the object cannot
 * answer is answered wrongly. The spelled members (`process.argv`, `performance.now()`)
 * never come here: they are lowered where they are written. */
function nodeObjectValue(lowerer: Lowerer, name: string, node: ts.Node, loc: SrcLoc): IrExpr {
  const helper = `%builtin.object.${name}`;
  if (lowerer.liftedFnNamed(helper) === undefined) defineNodeObject(lowerer, name, helper, node);
  lowerer.noteEdge(helper);
  return { kind: "call", callee: helper, args: [], type: DYN, loc };
}

function defineNodeObject(lowerer: Lowerer, name: string, helper: string, node: ts.Node): void {
  const loc = locOf(node);
  const storage = `%g.${helper}`;
  const ready = `${storage}%ready`;
  lowerer.globalsList.push(
    { id: storage, name: `${name} object value`, type: DYN, mutable: true },
    { id: ready, name: "%ready", type: BOOL, mutable: true },
  );
  const dyn = (value: IrExpr): IrExpr => lowerer.coerceToExpected(value, DYN);
  const field = (key: string, value: IrExpr): { key: IrExpr; value: IrExpr } => ({
    key: strLit(key, loc),
    value,
  });
  // Node's own enumerable properties are the module census's keys (the
  // process module's exports object is the process object); an object the
  // module census does not describe has its members on its prototype, so
  // none is enumerable here.
  const module = builtinModuleMemberCensus(name);
  const order = new Map((module?.ownNames ?? []).map((member, index) => [member, index]));
  const members = [...(nodeGlobalObjectMembers(name) ?? [])].sort(
    ([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size),
  );
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: varRef(ready, BOOL, loc),
      then: [{ kind: "return", value: varRef(storage, DYN, loc), loc }],
      else_: null,
      loc,
    },
    {
      kind: "assign",
      localId: storage,
      value: { kind: "dynObjLit", fields: [], type: DYN, loc },
      loc,
    },
  ];
  // One setter for every accessor member: a write through the held object
  // is refused by name. Without it the write would be dropped in a sloppy
  // source and `process.exitCode` would keep its value, silently.
  const assign = `%builtin.assign.${name}`;
  const assignDiag = nodeObjectMemberWriteDiag(name, loc);
  defineRefusingFunction(lowerer, assign, assignDiag, locatedFenceMessage(assignDiag, node), loc);
  const setter = field("set", refusingFunctionRef(assign, "set", 1, loc));
  for (const [member, kind] of members) {
    const display = `${name}.${member}`;
    const enumerable = field(
      "enumerable",
      dyn(boolLit(module?.keys.includes(member) === true, loc)),
    );
    const configurable = field("configurable", dyn(boolLit(true, loc)));
    let descriptor: { key: IrExpr; value: IrExpr }[];
    const exact =
      kind.kind === "value" ? exactObjectMember(lowerer, name, member, node, loc) : null;
    if (kind.kind === "function") {
      // The function the spelled member reads (`held.nextTick ===
      // process.nextTick`, and a call through the stored object runs it);
      // the refusing function the spelled read answers otherwise.
      const real =
        name === "process" ? processFunctionMemberValue(lowerer, member, loc, true, true) : null;
      descriptor = [
        field("value", dyn(real ?? memberFunctionFence(lowerer, display, member, kind, node, loc))),
        field("writable", dyn(boolLit(true, loc))),
        enumerable,
        configurable,
      ];
    } else if (exact !== null) {
      const getter = `%builtin.get.${display}`;
      lowerer.liftedFns.push({
        name: getter,
        params: [],
        locals: [],
        returnType: DYN,
        body: [{ kind: "return", value: dyn(exact), loc }],
        loc,
      });
      descriptor = [
        field("get", refusingFunctionRef(getter, member, 0, loc)),
        setter,
        enumerable,
        configurable,
      ];
    } else {
      const lifted = `%builtin.fence.${display}`;
      const diag = nodeValueDiag(display, loc);
      defineRefusingFunction(lowerer, lifted, diag, locatedFenceMessage(diag, node), loc);
      descriptor = [
        field("get", refusingFunctionRef(lifted, member, 0, loc)),
        setter,
        enumerable,
        configurable,
      ];
    }
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.defineProperty",
        args: [
          varRef(storage, DYN, loc),
          dyn(strLit(member, loc)),
          { kind: "dynObjLit", fields: descriptor, type: DYN, loc },
        ],
        type: DYN,
        loc,
      },
      loc,
    });
  }
  // The object is frozen once it is built. The spelled members
  // (`process.pid`, `process.nextTick(f)`) are lowered where they are
  // written and never consult this object, so a member the program could
  // redefine or replace through a held reference would make the object and
  // the spelled read disagree, silently. Frozen, a redefinition, a
  // replaced function member and a new key each throw a TypeError where
  // they are made; a write to a data member is still refused by name by
  // the setter above.
  body.push(
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.freeze",
        args: [varRef(storage, DYN, loc)],
        type: DYN,
        loc,
      },
      loc,
    },
    { kind: "assign", localId: ready, value: boolLit(true, loc), loc },
    { kind: "return", value: varRef(storage, DYN, loc), loc },
  );
  lowerer.liftedFns.push({ name: helper, params: [], locals: [], returnType: DYN, body, loc });
  lowerer.shareHelper(helper);
}

/** A data member of a Node global object whose value the runtime answers
 * exactly, as an expression that needs no local of its own (it becomes the
 * body of a getter): the process members a destructuring reads
 * (processDataMemberValue), the two process constants, and
 * `performance.timeOrigin`. Null for the others. */
function exactObjectMember(
  lowerer: Lowerer,
  object: string,
  member: string,
  node: ts.Node,
  loc: SrcLoc,
): IrExpr | null {
  if (object === "performance")
    return member === "timeOrigin" ? performanceTimeOrigin(lowerer, loc) : null;
  if (object !== "process") return null;
  if (member === "debugPort") return numLit(9229, loc);
  if (member === "sourceMapsEnabled") return boolLit(false, loc);
  // `env` is a snapshot typed by its binding and has none here.
  return member === "env" ? null : processDataMemberValue(lowerer, member, node, loc);
}

/** The value of the member `bi` of a builtin module. `esmNamed` is a named
 * ES import binding, which Node refuses to link for a name the module does
 * not export; the other spellings (a member of the exports object, a
 * destructured require) read undefined for such a name. */
export function unloweredModuleMemberValue(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  node: ts.Expression,
  loc: SrcLoc,
  esmNamed: boolean,
): IrExpr {
  const display = `${bi.module}.${bi.member}`;
  const hint = builtinFenceHintOf(bi.module, bi.member);
  const kind = nodeModuleMemberKind(bi.module, bi.member);
  // A module the census does not describe keeps the refusal that names the
  // member.
  if (kind === undefined) {
    const symbol = ts.isIdentifier(node) ? lowerer.resolveValueSymbol(node) : undefined;
    lowerer.noLowering(display, node, hint, symbol);
  }
  if (kind === null) {
    // Not an own property of the exports object: a name it inherits
    // (`fs.hasOwnProperty`) is Node's and stays refused; any other name
    // reads undefined, except through a named import.
    const inherited = builtinModuleMemberCensus(bi.module)?.inherited.includes(bi.member) === true;
    if (inherited || esmNamed) lowerer.nodeValueFence(display, node, hint);
    return dynUndefinedExpr(loc);
  }
  if (kind.kind === "function") {
    refuseUnmodeledMember(lowerer, display, node);
    return builtinFunctionFenceValue(lowerer, bi, node, loc);
  }
  lowerer.nodeValueFence(display, node, hint);
}

/** The members a refusing function value answers as Node does. */
const FUNCTION_VALUE_MEMBERS: ReadonlySet<string> = new Set(["name", "length"]);

/** Refuses, by name, a member read spelled on a function native code has no
 * value for (`fs.realpath.native`, `process.memoryUsage.rss`, `URL.prototype`
 * where nothing lowers it): the refusing function value models `name` and
 * `length` only, so any other member read off it would answer undefined
 * where Node has the function's own property. A read that is not the
 * receiver of such an access returns. */
function refuseUnmodeledMember(lowerer: Lowerer, display: string, node: ts.Node): void {
  const member = receiverOfMember(node);
  if (member === null || FUNCTION_VALUE_MEMBERS.has(member)) return;
  lowerer.nodeValueFence(
    member === "[…]" ? `${display}[…]` : `${display}.${member}`,
    node.parent ?? node,
  );
}

/** A member read whose Node answer the member's declared type does not
 * describe, in a JavaScript source. The caller answers these before the
 * typed lowerings and does not narrow the result to the declared type:
 *
 *   - An ES module namespace object has exactly the module's exports. A
 *     name the exports object owns but does not enumerate is not one of
 *     them (`import * as zlib` has no `Z_NO_FLUSH`; the default import and
 *     require() have it), and Node reads undefined. The declaration
 *     describes the exports object.
 *   - `process.connected` is declared boolean and is undefined in a process
 *     that was not started with an IPC channel.
 *
 * TypeScript sources keep the typed read: a value of undefined would
 * contradict the declaration the program was checked against. */
export function untypedNodeMemberRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  const shape = lowerer.builtinNamespaceShapeOf(expr.expression);
  if (
    shape?.flavor === "esm" &&
    builtinModuleHasMember(shape.module, "esm", expr.name.text) === false
  )
    return dynUndefinedExpr(loc);
  if (expr.name.text === "connected" && nodeGlobalObjectOf(lowerer, expr.expression) === "process")
    return exactProcessMember(lowerer, "connected", expr, loc);
  return null;
}

/** The Node global object `expr` names, as the census names it: "process",
 * "performance", "console", "crypto", "navigator" through any spelling of
 * the global (the bare name, `globalThis.name`, an alias, the builtin module
 * member that is the same object), a global function or class that has
 * statics ("URL", "AbortSignal"), and "crypto.subtle" for the `subtle`
 * member of the WebCrypto object. Null for anything else. */
export function nodeGlobalObjectOf(lowerer: Lowerer, expr: ts.Expression): string | null {
  let inner = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  const name = stdlibGlobalNameOf(lowerer, inner);
  if (name !== null)
    return nodeGlobalObjectMemberKind(name, "constructor") === undefined ? null : name;
  // `import { performance } from "node:perf_hooks"`, `perf_hooks.performance`,
  // `crypto.webcrypto`: the module member that is the global object.
  const bi = ts.isIdentifier(inner)
    ? lowerer.builtinImportOf(inner)
    : ts.isPropertyAccessExpression(inner) && !inner.questionDotToken
      ? lowerer.builtinMemberOf(inner)
      : null;
  if (bi !== null) {
    if (bi.module === "crypto" && bi.member === "webcrypto") return "crypto";
    if (isGlobalMember(bi) && nodeGlobalObjectMemberKind(bi.member, "constructor") !== undefined)
      return bi.member;
    return null;
  }
  if (
    ts.isPropertyAccessExpression(inner) &&
    !inner.questionDotToken &&
    inner.name.text === "subtle" &&
    nodeGlobalObjectOf(lowerer, inner.expression) === "crypto"
  )
    return "crypto.subtle";
  return null;
}

/** The value of the member `member` of the Node global object `object`
 * ("process", "performance", "console", "crypto", "navigator",
 * "crypto.subtle"), or null when the census does not describe `object`. */
export function unloweredGlobalObjectMember(
  lowerer: Lowerer,
  object: string,
  member: string,
  node: ts.Node,
  loc: SrcLoc,
  declared = false,
): IrExpr | null {
  const kind = nodeGlobalObjectMemberKind(object, member);
  if (kind === undefined) return null;
  const staticOf = nodeGlobalKind(object)?.kind === "function";
  // A global function's census lists its own statics. A name it does not
  // list is not thereby absent: every function has `name` and `length` and
  // inherits Function.prototype's members, which the function value answers.
  if (kind === null && staticOf) return null;
  // A member the declarations name (`declared`) may have a lowering after
  // this rule, or a run-time object that answers it: `crypto.subtle` is a
  // member of the WebCrypto object, `Float32Array.BYTES_PER_ELEMENT` a
  // constant. It is answered here only where native code is known to answer
  // members at their spelling alone: on an object it has no run-time object
  // for (`process`, `performance`, and a nested object such as
  // `crypto.subtle`), and for a static function, whose value nothing else
  // provides.
  if (declared) {
    const spelledOnly = staticOf
      ? kind?.kind === "function"
      : object.includes(".") || jsGlobalValueByName(lowerer, object, loc, false) === null;
    if (!spelledOnly) return null;
  }
  // The member is itself read for a member the function value would not
  // model (`process.memoryUsage.rss`): leave it to the lowering or the
  // fence that names it.
  if (kind?.kind === "function" && declared && readsMemberOf(node)) return null;
  const display = `${object}.${member}`;
  if (object === "process") {
    const exact = exactProcessMember(lowerer, member, node, loc);
    if (exact !== null) return exact;
  }
  if (object === "performance" && member === "timeOrigin")
    return performanceTimeOrigin(lowerer, loc);
  if (kind === null) return dynUndefinedExpr(loc);
  if (kind.kind === "function") {
    refuseUnmodeledMember(lowerer, display, node);
    return memberFunctionFence(lowerer, display, member, kind, node, loc);
  }
  lowerer.nodeValueFence(display, node);
}

/** Whether `node` is the receiver of a member access other than `name` and
 * `length`. */
function readsMemberOf(node: ts.Node): boolean {
  const member = receiverOfMember(node);
  return member !== null && !FUNCTION_VALUE_MEMBERS.has(member);
}

/** A refusing function value for the member function `display`. */
function memberFunctionFence(
  lowerer: Lowerer,
  display: string,
  name: string,
  kind: NodeValueKind & { kind: "function" },
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const lifted = `%builtin.fence.${display}`;
  const diag = nodeValueDiag(display, loc);
  defineRefusingFunction(lowerer, lifted, diag, locatedFenceMessage(diag, node), loc);
  return refusingFunctionRef(lifted, name, kind.length, loc);
}

/** The process members whose Node value is cheap and exact, and the ones
 * the process object has only in some processes. Null for the others.
 *
 *   - `debugPort` is 9229 unless a flag moves it, and no flag reaches a
 *     compiled program.
 *   - `sourceMapsEnabled` is false without `--enable-source-maps`;
 *     `process.setSourceMapsEnabled` is refused, so it stays false.
 *   - `connected` is the channel's state in a process started with an IPC
 *     channel and undefined in any other.
 *   - The other IPC members (`channel`) are undefined without a channel and
 *     refused by name with one.
 *   - `mainModule` is the entry module when the entry is CommonJS (refused:
 *     native code has no module object) and undefined when it is an ES
 *     module. */
function exactProcessMember(
  lowerer: Lowerer,
  member: string,
  node: ts.Node,
  loc: SrcLoc,
): IrExpr | null {
  if (member === "debugPort") return numLit(9229, loc);
  if (member === "sourceMapsEnabled") return boolLit(false, loc);
  if (processMemberNeedsIpc(member)) {
    const display = `process.${member}`;
    const withChannel: IrExpr =
      member === "connected"
        ? lowerer.coerceToExpected(
            { kind: "libCall", fn: "process.connected", args: [], type: BOOL, loc },
            DYN,
          )
        : refusalCall(lowerer, display, node, loc);
    return {
      kind: "ternary",
      cond: processHasIpc(lowerer, loc),
      then: withChannel,
      else_: dynUndefinedExpr(loc),
      type: DYN,
      loc,
    };
  }
  if (processMemberNeedsCommonJsMain(member)) {
    if (isNodeEsmFile(lowerer.entry, lowerer.program)) return dynUndefinedExpr(loc);
    lowerer.nodeValueFence(`process.${member}`, node);
  }
  return null;
}

/** An expression that throws the named refusal of `display` when it is
 * evaluated: the call of its refusing function. Used where only one arm of
 * a run-time condition refuses. */
function refusalCall(lowerer: Lowerer, display: string, node: ts.Node, loc: SrcLoc): IrExpr {
  const lifted = `%builtin.fence.${display}`;
  const diag = nodeValueDiag(display, loc);
  defineRefusingFunction(lowerer, lifted, diag, locatedFenceMessage(diag, node), loc);
  lowerer.noteEdge(lifted);
  return { kind: "call", callee: lifted, args: [], type: DYN, loc };
}

/** `performance.timeOrigin`: the Unix time, in fractional milliseconds, at
 * which `performance.now()` read zero. The runtime's clock is anchored at
 * process start, so the origin is the wall clock minus that clock, taken
 * once and kept: every read answers the same number, and
 * `timeOrigin + now()` is the wall clock, as in Node. */
function performanceTimeOrigin(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const helper = "%perf.timeOrigin";
  if (lowerer.liftedFnNamed(helper) === undefined) {
    const storage = `%g.${helper}`;
    const ready = `${storage}%ready`;
    lowerer.globalsList.push(
      { id: storage, name: "performance.timeOrigin", type: F64, mutable: true },
      { id: ready, name: "%ready", type: BOOL, mutable: true },
    );
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: varRef(ready, BOOL, loc),
        then: [{ kind: "return", value: varRef(storage, F64, loc), loc }],
        else_: null,
        loc,
      },
      {
        kind: "assign",
        localId: storage,
        value: {
          kind: "bin",
          op: "-",
          left: { kind: "libCall", fn: "date.now", args: [], type: F64, loc },
          right: { kind: "libCall", fn: "perf.now", args: [], type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "assign", localId: ready, value: boolLit(true, loc), loc },
      { kind: "return", value: varRef(storage, F64, loc), loc },
    ];
    lowerer.liftedFns.push({ name: helper, params: [], locals: [], returnType: F64, body, loc });
    lowerer.shareHelper(helper);
  }
  lowerer.noteEdge(helper);
  return { kind: "call", callee: helper, args: [], type: F64, loc };
}

/** Node's `typeof` for the Node value `expr` names (a builtin import
 * binding, a member of a builtin module, a global, a member of a Node
 * global object), from the census; null when `expr` names none, or when
 * Node's answer depends on the platform or the read throws. typeof.ts asks
 * only after the operand's own lowering refused: `typeof` needs no value, so
 * a value native code does not have still answers Node's type
 * (`typeof SHARE_ENV` is "symbol"). */
export function nodeValueTypeof(lowerer: Lowerer, expr: ts.Expression): string | null {
  let inner = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  let kind: NodeValueKind | null | undefined;
  if (ts.isIdentifier(inner)) {
    const bi = lowerer.builtinImportOf(inner);
    if (bi !== null) kind = nodeModuleMemberKind(bi.module, bi.member);
    else {
      const name = stdlibGlobalNameOf(lowerer, inner);
      kind = name === null ? null : nodeGlobalKind(name);
    }
  } else if (ts.isPropertyAccessExpression(inner) && !inner.questionDotToken) {
    const object = nodeGlobalObjectOf(lowerer, inner.expression);
    if (object !== null) kind = nodeGlobalObjectMemberKind(object, inner.name.text);
    else if (stdlibGlobalNameOf(lowerer, inner.expression) === "globalThis") {
      const name = stdlibGlobalNameOf(lowerer, inner);
      kind = name === null ? null : nodeGlobalKind(name);
    } else {
      const bi = lowerer.builtinMemberOf(inner);
      kind = bi === null ? null : nodeModuleMemberKind(bi.module, bi.member);
    }
  }
  if (kind === null || kind === undefined) return null;
  if (kind.kind === "function") return "function";
  return TYPEOF_ANSWERS.has(kind.type) ? kind.type : null;
}

/** The `typeof` answers a census value can have. "throws" marks a getter
 * that throws and "platform" a value that depends on the operating system,
 * neither of which is an answer; a member that is undefined in a fresh
 * Node process (`process.exitCode`, an emitter's `_maxListeners`) is state
 * the program can set, so its type is not a fact about the name either. */
const TYPEOF_ANSWERS: ReadonlySet<string> = new Set([
  "object",
  "number",
  "string",
  "boolean",
  "symbol",
  "bigint",
]);
