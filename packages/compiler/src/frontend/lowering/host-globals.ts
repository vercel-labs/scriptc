import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf, withoutTypeCasts } from "./surfaces.js";

/* Node 24 globals the native runtime does not implement. Reading one is NOT
 * a feature probe for an absent capability: Node has the value, so answering
 * `undefined` would silently diverge (pi's Codex transport stops running its
 * WebSocket path). A read answers the constructor Node has
 * (host-global-values.ts), so a module-init `instanceOf(globalThis.FormData,
 * …)` keeps loading; constructing it, calling it, or reading a member the
 * value does not carry refuses (SC2020, reason "host-global"), and a module
 * that does one can run in a Node island.
 *
 * The set is derived, not typed by hand — see
 * packages/compiler/test/host-globals.test.ts, which recomputes it from
 * internal/compatibility/generated/node-v24-internal.json:
 *
 *   globals chapter, depth 1, not flag-gated (an "Enable this API with …"
 *   stability note means Node 24 does not define it by default)
 *   − names the compiler's bundled declarations know
 *     (packages/compiler/ambient/*.d.ts: such a read is lowered or throws a
 *     loud runtime SC2020, never answers undefined)
 *   − the CommonJS wrapper bindings (require, module, exports, __dirname,
 *     __filename)
 *   − rows the ledger's implementation-owned static status does not call
 *     "not-implemented".
 *
 * Performance is the one Node 24 global the docs chapter omits (Node
 * documents the class under perf_hooks, which has no Performance row either);
 * the runtime oracle in the design repro pins it as a global whose typeof is
 * "function", and it is listed here explicitly.
 *
 * Node's enumerable global list for `for (key in globalThis)` is
 * scr_global_for_in_object's node_names (package runtime): these names are
 * non-enumerable in Node, so they do not belong there.
 *
 * Temporal is deliberately absent: Node 24 does not define it, so "undefined"
 * is the exact answer. Bun, Deno, window, self and document are absent for the
 * same reason.
 */
export const NODE_GLOBALS_WITHOUT_NATIVE: ReadonlySet<string> = new Set([
  "BroadcastChannel",
  "CloseEvent",
  "CompressionStream",
  "DecompressionStream",
  "FormData",
  "Navigator",
  "Performance",
  "PerformanceEntry",
  "PerformanceMark",
  "PerformanceMeasure",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
  "PerformanceResourceTiming",
  "ReadableByteStreamController",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "URLPattern",
  "WebSocket",
]);

/** Node 24's `length` for each listed global's constructor — the `Function`
 * length of the class (`WebSocket.length` is 1, `FormData.length` 0). A read
 * answers a constructor carrying it, so a program reading `name`, `length` or
 * `typeof` off the value sees what Node shows. Values are pinned against the
 * running Node in packages/compiler/test/host-globals.test.ts. */
const HOST_GLOBAL_LENGTHS: ReadonlyMap<string, number> = new Map([
  ["BroadcastChannel", 1],
  ["CloseEvent", 1],
  ["CompressionStream", 1],
  ["DecompressionStream", 1],
  ["FormData", 0],
  ["Navigator", 0],
  ["Performance", 0],
  ["PerformanceEntry", 0],
  ["PerformanceMark", 1],
  ["PerformanceMeasure", 0],
  ["PerformanceObserver", 1],
  ["PerformanceObserverEntryList", 0],
  ["PerformanceResourceTiming", 0],
  ["ReadableByteStreamController", 0],
  ["ReadableStreamBYOBReader", 1],
  ["ReadableStreamBYOBRequest", 0],
  ["URLPattern", 0],
  ["WebSocket", 1],
]);

/** Node's `length` for the listed global `name`, or undefined when the table
 * does not know it (the value is then built with the closure's own arity). */
export function hostGlobalLength(name: string): number | undefined {
  return HOST_GLOBAL_LENGTHS.get(name);
}

/** Whether the read is the callee of a call or `new` — the one use a listed
 * global's value refuses. A bare read answers the constructor (see
 * host-global-values.ts); constructing or calling it can only produce an
 * instance native code does not have, so the compile fence stays (and a
 * JavaScript source defers it to the throw at that statement). */
export function hostGlobalCallTarget(node: ts.Expression): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      if (parent.expression !== current) return false;
      current = parent;
      continue;
    }
    return (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === current
    );
  }
}

/** Whether `id` reads one of those globals. Own bindings — imports, locals
 * with an initializer, program classes and functions — keep their ordinary
 * lowering; a declaration-file binding (the bundled lib, @types/node) or a
 * program's ambient `declare var` is the global, and an unresolvable name
 * (JavaScript) is Node's. */
export function hostGlobalNameOfIdentifier(lowerer: Lowerer, id: ts.Identifier): string | null {
  const name = id.text;
  if (!NODE_GLOBALS_WITHOUT_NATIVE.has(name)) return null;
  // `{ WebSocket }` reads the binding through the object literal's property:
  // the name's own symbol is that property, and the value the shorthand
  // copies is the checker's shorthand-value symbol. Read it here rather than
  // through resolveValueSymbol, which also follows import aliases — this is
  // a classification probe, and an alias of the name is the program's own
  // binding, whatever it resolves to.
  const own = lowerer.checker.getSymbolAtLocation(id);
  const symbol =
    id.parent !== undefined && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? (lowerer.checker.getShorthandAssignmentValueSymbol(id.parent) ?? own)
      : own;
  if (symbol === undefined) return name;
  // An import (or require alias) of the same name is the program's binding
  // of somebody else's value, never the global.
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) return null;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return null;
  // Type-world partners declare no value: lib.dom and @types/node write
  // `interface WebSocket` beside `declare var WebSocket`, and that merged
  // symbol is still the global. Only the value declarations decide — a
  // symbol with none is a type (a read of it is a type error elsewhere).
  const valueDeclarations = declarations.filter(
    (decl) => !ts.isInterfaceDeclaration(decl) && !ts.isTypeAliasDeclaration(decl),
  );
  if (valueDeclarations.length === 0) return null;
  const ambient = (decl: ts.Node): boolean =>
    ts.getSourceFileOfNode(decl).isDeclarationFile ||
    (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) !== 0;
  const declaresGlobal = valueDeclarations.every((decl) => {
    if (ts.isVariableDeclaration(decl)) return decl.initializer === undefined && ambient(decl);
    if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return ambient(decl);
    return false;
  });
  return declaresGlobal ? name : null;
}

/** Whether `receiver` is the global object: `globalThis`, a cast of it
 * (`(globalThis as T)`), or a `const` initialized with either (`const g =
 * globalThis as Record<string, unknown>`). The last shape is how most
 * programs spell the global object, and the runtime's dynamic global object
 * answers undefined for these names. A `let` is not followed: it can be
 * reassigned to another object. */
function isGlobalObjectRead(lowerer: Lowerer, receiver: ts.Expression): boolean {
  const uncast = withoutTypeCasts(receiver);
  if (stdlibGlobalNameOf(lowerer, uncast) === "globalThis") return true;
  if (!ts.isIdentifier(uncast)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(uncast);
  const decl = symbol?.declarations?.[0];
  return (
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.parent !== undefined &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
    decl.initializer !== undefined &&
    stdlibGlobalNameOf(lowerer, withoutTypeCasts(decl.initializer)) === "globalThis"
  );
}

/** Whether `access` reads one of those globals off the global object —
 * `globalThis.X`, `(globalThis as T).X`, `alias.X` (`const alias =
 * globalThis`), through parentheses and type casts. */
export function hostGlobalNameOfMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): string | null {
  const name = access.name.text;
  if (!NODE_GLOBALS_WITHOUT_NATIVE.has(name)) return null;
  return isGlobalObjectRead(lowerer, access.expression) ? name : null;
}

/** `globalThis["X"]` with a static string key: the same read as `globalThis.X`
 * (the runtime's dynamic path cannot tell the name is Node's). */
export function hostGlobalNameOfElement(
  lowerer: Lowerer,
  access: ts.ElementAccessExpression,
): string | null {
  const key = access.argumentExpression;
  if (!ts.isStringLiteralLike(key)) return null;
  if (!NODE_GLOBALS_WITHOUT_NATIVE.has(key.text)) return null;
  return isGlobalObjectRead(lowerer, access.expression) ? key.text : null;
}

/** The members a read of a listed global's value answers: the function
 * intrinsics every constructor carries. Node also has the class's own
 * static members (`WebSocket.OPEN`, `FormData.prototype.append`) and its
 * instances' methods, which native code does not provide; reading one is a
 * use of that surface and refuses (SC2020, host-global) rather than
 * answering undefined. */
export const HOST_GLOBAL_VALUE_MEMBERS: ReadonlySet<string> = new Set([
  "length",
  "name",
  "prototype",
]);

/** The members the value's `prototype` object answers: `constructor`, the
 * link back to the value, which is the same in Node. Node's prototype also
 * carries the class's instance methods (`FormData.prototype.append`), which
 * native code does not have; reading one refuses (SC2020, host-global). */
export const HOST_GLOBAL_PROTOTYPE_MEMBERS: ReadonlySet<string> = new Set(["constructor"]);

/** The listed global whose `prototype` object `node` reads — a member read's
 * receiver (`FormData.prototype.append`) or the `Object.setPrototypeOf`
 * target shape. Null for every other expression. */
export function hostGlobalPrototypeOf(lowerer: Lowerer, node: ts.Expression): string | null {
  const uncast = withoutTypeCasts(node);
  if (ts.isPropertyAccessExpression(uncast) && uncast.name.text === "prototype")
    return hostGlobalNameOfRead(lowerer, uncast.expression);
  if (
    ts.isElementAccessExpression(uncast) &&
    ts.isStringLiteralLike(uncast.argumentExpression) &&
    uncast.argumentExpression.text === "prototype"
  )
    return hostGlobalNameOfRead(lowerer, uncast.expression);
  return null;
}

/** The listed global whose prototype member a call reads —
 * `FormData.prototype.append(...)`, `globalThis.WebSocket["send"](...)`.
 * A call reaches lowering without the member-read hook seeing the callee,
 * so the call site asks the same question. Null for `constructor` and for
 * every other expression. */
export function hostGlobalPrototypeMemberOf(
  lowerer: Lowerer,
  callee: ts.Expression,
): string | null {
  const uncast = withoutTypeCasts(callee);
  if (ts.isPropertyAccessExpression(uncast))
    return HOST_GLOBAL_PROTOTYPE_MEMBERS.has(uncast.name.text)
      ? null
      : hostGlobalPrototypeOf(lowerer, uncast.expression);
  if (ts.isElementAccessExpression(uncast) && ts.isStringLiteralLike(uncast.argumentExpression))
    return HOST_GLOBAL_PROTOTYPE_MEMBERS.has(uncast.argumentExpression.text)
      ? null
      : hostGlobalPrototypeOf(lowerer, uncast.expression);
  return null;
}

/** The listed global an operand reads, in any of the read forms — the
 * expression itself (`typeof X`, a `new` callee, a call callee). */
export function hostGlobalNameOfRead(lowerer: Lowerer, operand: ts.Expression): string | null {
  const unwrapped = withoutTypeCasts(operand);
  if (ts.isIdentifier(unwrapped)) return hostGlobalNameOfIdentifier(lowerer, unwrapped);
  if (ts.isPropertyAccessExpression(unwrapped)) return hostGlobalNameOfMember(lowerer, unwrapped);
  if (ts.isElementAccessExpression(unwrapped)) return hostGlobalNameOfElement(lowerer, unwrapped);
  return null;
}

/** The listed global a `typeof` operand reads, in any of the read forms. */
export function hostGlobalNameOfTypeofOperand(
  lowerer: Lowerer,
  operand: ts.Expression,
): string | null {
  return hostGlobalNameOfRead(lowerer, operand);
}
