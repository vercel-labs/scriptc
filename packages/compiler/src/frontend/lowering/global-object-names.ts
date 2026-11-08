import * as ts from "../ts7/adapter.js";
import { STRING, arrayOf, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { COMMONJS_MODULE_BINDINGS, TEMPORAL_GLOBAL } from "../builtin-modules.js";
import { NODE_GLOBALS_WITHOUT_NATIVE } from "./host-globals.js";

/** Globals the bundled declarations type and Node 24's global object does
 * not have: scriptc's own primitives, and the Web Storage pair Node defines
 * only behind a flag. The temporal global and the CommonJS module bindings
 * are named by their own constants. */
const DECLARED_NOT_IN_NODE: ReadonlySet<string> = new Set([
  "comptime",
  "__scriptcInferredCollections",
  "localStorage",
  "sessionStorage",
]);

/** Properties of Node's global object that no standard-library declaration
 * lists as a member of `typeof globalThis`: the checker's own `undefined`
 * and `globalThis`, and two the runtime answers itself. */
const UNDECLARED_IN_NODE: readonly string[] = ["undefined", "globalThis", "console", "navigator"];

/** Own string keys of Object.prototype, which the global object inherits. */
const OBJECT_PROTOTYPE_NAMES: readonly string[] = [
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
];

/** The string keys `key in <global object>` answers true for before the
 * program adds a property of its own: the names of Node 24's global object
 * and of Object.prototype (packages/compiler/test/global-object-names.test.ts
 * holds the list against the running Node). The names come from the standard
 * library's declarations of `typeof globalThis`, without the ones Node does
 * not define and without the ones native code does not provide, which the
 * runtime refuses by name before it asks this list. A global the program
 * declares itself is its own property and is present once it is written. */
export function globalObjectPresentNames(lowerer: Lowerer, node: ts.Node): string[] {
  const symbol = lowerer.checker.resolveName(
    "globalThis",
    ts.SymbolFlags.Value,
    ts.getSourceFileOfNode(node),
    false,
  );
  const names = new Set<string>([...UNDECLARED_IN_NODE, ...OBJECT_PROTOTYPE_NAMES]);
  if (symbol !== undefined) {
    for (const property of lowerer.checker.getPropertiesOfType(
      lowerer.checker.getTypeOfSymbol(symbol),
    )) {
      const name = ts.symbolName(property);
      if (
        name === TEMPORAL_GLOBAL ||
        COMMONJS_MODULE_BINDINGS.has(name) ||
        DECLARED_NOT_IN_NODE.has(name) ||
        NODE_GLOBALS_WITHOUT_NATIVE.has(name) ||
        !lowerer.isStdlibSymbol(property)
      )
        continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The list above as the runtime's immortal table: one per program, keyed
 * by its contents. */
export function globalObjectPresentNamesArg(lowerer: Lowerer, node: ts.Node, loc: SrcLoc): IrExpr {
  const names = globalObjectPresentNames(lowerer, node);
  return {
    kind: "templateStrings",
    key: `%globalThis.present:${names.join(",")}`,
    cooked: names,
    type: arrayOf(STRING),
    loc,
  };
}
