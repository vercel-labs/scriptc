import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf, withoutTypeCasts } from "./surfaces.js";

/* Node 24 globals the native runtime does not implement. Reading one is NOT
 * a feature probe for an absent capability: Node has the value, so answering
 * `undefined` would silently diverge (pi's Codex transport stops running its
 * WebSocket path). Every static read refuses instead (SC2020, reason
 * "host-global"), and a module that does it can run in a Node island.
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

/** Whether `access` reads one of those globals off the global object —
 * `globalThis.X`, `(globalThis as T).X`, `alias.X` (`const alias =
 * globalThis`), through parentheses and type casts. */
export function hostGlobalNameOfMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): string | null {
  const name = access.name.text;
  if (!NODE_GLOBALS_WITHOUT_NATIVE.has(name)) return null;
  return stdlibGlobalNameOf(lowerer, withoutTypeCasts(access.expression)) === "globalThis"
    ? name
    : null;
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
  return stdlibGlobalNameOf(lowerer, withoutTypeCasts(access.expression)) === "globalThis"
    ? key.text
    : null;
}

/** The listed global a `typeof` operand reads, in any of the read forms. */
export function hostGlobalNameOfTypeofOperand(
  lowerer: Lowerer,
  operand: ts.Expression,
): string | null {
  const unwrapped = withoutTypeCasts(operand);
  if (ts.isIdentifier(unwrapped)) return hostGlobalNameOfIdentifier(lowerer, unwrapped);
  if (ts.isPropertyAccessExpression(unwrapped)) return hostGlobalNameOfMember(lowerer, unwrapped);
  if (ts.isElementAccessExpression(unwrapped)) return hostGlobalNameOfElement(lowerer, unwrapped);
  return null;
}
