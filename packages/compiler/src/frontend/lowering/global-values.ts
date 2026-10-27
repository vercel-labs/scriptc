/* Builtin globals read through the global object by a name the compiler
 * does not see (`globalThis[name]`, `for (name in globalThis)` followed by
 * `globalThis[name]`). Such a read answers what the name's static spelling
 * reads in a JavaScript source: the interned function and constructor
 * values, the WebCrypto object and Buffer, and the opaque
 * identity token for the other declared globals.
 *
 * The values come from one lookup function per program
 * (`%global.builtinValue`), which a JavaScript module with such a read
 * installs on the global object when its body starts
 * (scr_global_values_install). The runtime answers the global object,
 * console, fetch and the constants itself and calls the lookup for the
 * other declared names: a value, `undefined` for the token, or `null` for
 * a name without one, whose read keeps its SC2020 refusal. */
import * as ts from "../ts7/adapter.js";
import {
  BYTES_ELEMENT_NAME,
  DYN,
  STRING,
  UNDEFINED_T,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { TEMPORAL_GLOBAL } from "../builtin-modules.js";
import { stdlibGlobalNameOf } from "./surfaces.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import { builtinNamespaceValue } from "./builtin-namespaces.js";
import { uriFunctionValue } from "./expressions/identifiers.js";
import { navigatorValue } from "./builtins/navigator.js";
import { primitiveCtorClosure } from "./lower-exprs.js";

const LOOKUP_FN = "%global.builtinValue";

/** Names the runtime answers before the lookup runs. */
const RUNTIME_ANSWERED = new Set([
  "globalThis",
  "global",
  "console",
  "fetch",
  "undefined",
  "NaN",
  "Infinity",
]);

/** Declared globals whose reads through the global object stay refused:
 * WebAssembly's namespace links the translated modules a program that
 * names it statically carries. */
const REFUSED = new Set(["WebAssembly"]);

/** The receiver of the first element read of the global object
 * (`globalThis[name]`, `globalThis["name"]`), or of the first for-in over
 * it, in the JavaScript source `sf`; null when it has none. */
export function computedGlobalReadOf(lowerer: Lowerer, sf: ts.SourceFile): ts.Expression | null {
  if (!isJsSourceFile(sf)) return null;
  const cached = lowerer.computedGlobalReads.get(sf);
  if (cached !== undefined) return cached;
  let found: ts.Expression | null = null;
  // An iterative walk: sources can nest expressions thousands deep.
  ts.walkPreorder(sf, (node) => {
    if (
      (ts.isElementAccessExpression(node) || ts.isForInStatement(node)) &&
      isGlobalObjectRead(lowerer, node.expression) &&
      (ts.isForInStatement(node) || readsBuiltinByName(lowerer, node))
    ) {
      found = node.expression;
      return "stop";
    }
    return undefined;
  });
  lowerer.computedGlobalReads.set(sf, found);
  return found;
}

/** Whether `expr` reads the global object: a spelling of it, or a variable
 * whose only declaration initializes it with one (`const g = globalThis`).
 * The scan runs before function bodies are lowered, so the alias of a
 * variable declared in a function is not registered yet. */
function isGlobalObjectRead(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (stdlibGlobalNameOf(lowerer, expr) === "globalThis") return true;
  let inner = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isIdentifier(inner)) return false;
  const declarations = lowerer.checker.getSymbolAtLocation(inner)?.declarations ?? [];
  const declaration = declarations[0];
  return (
    declarations.length === 1 &&
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    stdlibGlobalNameOf(lowerer, declaration.initializer) === "globalThis"
  );
}

/** Whether the element access `node` of the global object can read a
 * builtin global by name: its key is not a symbol (`globalThis[key]` with
 * `key = Symbol.for(...)` reads the global object's symbol properties),
 * and it is neither the target of `=` nor the operand of `delete`. */
function readsBuiltinByName(lowerer: Lowerer, node: ts.ElementAccessExpression): boolean {
  if (lowerer.typeOf(node.argumentExpression).flags & ts.TypeFlags.ESSymbolLike) return false;
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if (ts.isDeleteExpression(parent)) return false;
  return !(
    ts.isBinaryExpression(parent) &&
    parent.left === outer &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** The value a JavaScript source reads for the declared global `name`
 * taken as a value, whatever its spelling (`name`, `globalThis.name`,
 * `const { name } = globalThis`, `globalThis[name]`), or null when it
 * reads the opaque identity token. */
export function jsGlobalValueByName(lowerer: Lowerer, name: string, loc: SrcLoc): IrExpr | null {
  return (
    jsSpecialGlobalValue(lowerer, name, loc) ??
    builtinNamespaceValue(lowerer, name, loc) ??
    builtinGlobalValue(name, loc, true)
  );
}

/** jsGlobalValueByName for the globals other than the interned builtin
 * functions and constructors (builtinGlobalValue). */
export function jsSpecialGlobalValue(lowerer: Lowerer, name: string, loc: SrcLoc): IrExpr | null {
  if (name === "String" || name === "Number" || name === "Boolean" || name === "BigInt")
    return primitiveCtorClosure(lowerer, name, loc, true);
  if (name === "ArrayBuffer")
    return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
  if (name === "Array")
    return { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc };
  if ((Object.values(BYTES_ELEMENT_NAME) as string[]).includes(name))
    return {
      kind: "libCall",
      fn: "bytes.constructor",
      args: [{ kind: "strLit", value: name, type: STRING, loc }],
      type: DYN,
      loc,
    };
  if (URI_FUNCTIONS.has(name)) return uriFunctionValue(lowerer, name, loc);
  if (name === "crypto")
    return { kind: "libCall", fn: "webcrypto.object", args: [], type: DYN, loc };
  if (name === "navigator") return navigatorValue(loc);
  if (name === "Buffer")
    return { kind: "libCall", fn: "buffer.constructor", args: [], type: DYN, loc };
  if (name === "fetch") return { kind: "libCall", fn: "fetch.function", args: [], type: DYN, loc };
  if (name === "console")
    return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
  return null;
}

const URI_FUNCTIONS = new Set([
  "encodeURIComponent",
  "encodeURI",
  "decodeURI",
  "decodeURIComponent",
]);

/** The statement that installs the program's lookup, built on first use
 * from the names the checker declares on `receiver` (a global object). */
export function globalValuesInstall(
  lowerer: Lowerer,
  receiver: ts.Expression,
  loc: SrcLoc,
): IrStmt {
  const fnType: IrType & { kind: "func" } = { kind: "func", params: [STRING], ret: DYN };
  if (!lowerer.liftedFnNamed(LOOKUP_FN)) {
    const names = lowerer.checker
      .getPropertiesOfType(lowerer.typeOf(receiver))
      .map((property) => ts.symbolName(property))
      .filter((name) => name !== TEMPORAL_GLOBAL && !RUNTIME_ANSWERED.has(name));
    const name: IrExpr = { kind: "varRef", localId: "name.0", type: STRING, loc };
    const body: IrStmt[] = [];
    for (const global of [...new Set(names)].sort()) {
      const value: IrExpr | null = REFUSED.has(global)
        ? { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc }
        : jsGlobalValueByName(lowerer, global, loc);
      if (value === null) continue;
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: name,
          right: { kind: "strLit", value: global, type: STRING, loc },
          type: { kind: "bool" },
          loc,
        },
        then: [{ kind: "return", value: lowerer.coerceToExpected(value, DYN), loc }],
        else_: null,
        loc,
      });
    }
    body.push({
      kind: "return",
      value: lowerer.coerceToExpected(
        { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        DYN,
      ),
      loc,
    });
    lowerer.liftedFns.push({
      name: LOOKUP_FN,
      params: [{ localId: "name.0", name: "name", type: STRING }],
      returnType: DYN,
      locals: [{ id: "name.0", name: "name", type: STRING, mutable: false }],
      body,
      loc,
    });
  }
  const lookup = lowerer.coerceToExpected(
    { kind: "closure", fnName: LOOKUP_FN, captures: [], type: fnType, loc },
    DYN,
  );
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "global.installValues",
      args: [lookup],
      type: { kind: "void" },
      loc,
    },
    loc,
  };
}

/** Builtin module members that are the global objects of the same name in
 * Node 24 (`require("buffer").atob === globalThis.atob`). */
const GLOBAL_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  buffer: new Set(["atob", "btoa", "Blob", "File", "Buffer"]),
  timers: new Set([
    "setTimeout",
    "setInterval",
    "setImmediate",
    "clearTimeout",
    "clearInterval",
    "clearImmediate",
  ]),
  perf_hooks: new Set([
    "performance",
    "PerformanceEntry",
    "PerformanceMark",
    "PerformanceMeasure",
    "PerformanceObserver",
    "PerformanceObserverEntryList",
    "PerformanceResourceTiming",
  ]),
  util: new Set(["TextEncoder", "TextDecoder"]),
  url: new Set(["URL", "URLSearchParams"]),
  worker_threads: new Set(["BroadcastChannel", "MessageChannel", "MessagePort"]),
  "stream/web": new Set([
    "ReadableStream",
    "ReadableStreamDefaultReader",
    "ReadableStreamBYOBReader",
    "ReadableStreamBYOBRequest",
    "ReadableByteStreamController",
    "ReadableStreamDefaultController",
    "TransformStream",
    "TransformStreamDefaultController",
    "WritableStream",
    "WritableStreamDefaultWriter",
    "WritableStreamDefaultController",
    "ByteLengthQueuingStrategy",
    "CountQueuingStrategy",
    "TextEncoderStream",
    "TextDecoderStream",
    "CompressionStream",
    "DecompressionStream",
  ]),
};

/** In a JavaScript source, the value of a builtin module member that is a
 * global object (GLOBAL_MEMBERS): what the global's own spelling reads,
 * so identity holds across the spellings. Null for other members. */
export function globalMemberValue(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (!GLOBAL_MEMBERS[bi.module]?.has(bi.member)) return null;
  return (
    jsGlobalValueByName(lowerer, bi.member, loc) ?? {
      kind: "strLit",
      value: `[builtin ${bi.member}]`,
      type: STRING,
      loc,
    }
  );
}
