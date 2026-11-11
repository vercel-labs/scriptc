/* Builtin globals read through the global object by a name the compiler
 * does not see (`globalThis[name]`, `for (name in globalThis)` followed by
 * `globalThis[name]`). Such a read answers what the name's static spelling
 * reads in a JavaScript source: the interned function and constructor
 * values, the WebCrypto object and Buffer, and for a function or class no
 * lowering has a value for, the function value that refuses when it is
 * called or constructed (builtin-function-fences.ts).
 *
 * The values come from one lookup function per program
 * (`%global.builtinValue`), which a JavaScript module with such a read
 * installs on the global object when its body starts
 * (scr_global_values_install). The runtime answers the global object,
 * console, fetch and the constants itself and calls the lookup for the
 * other declared names: a value, or `null` for a name without one, whose
 * read keeps its SC2020 refusal. A declared global Node 24 does not define
 * (lower-namespaces.ts) is not among the names: the global object has no
 * such property and the read answers undefined. The lookup never answers
 * `undefined`, which the runtime would read as a request for a placeholder
 * string.
 *
 * A module that stores the global object as a value the compiler does not
 * follow (storesGlobalObject) installs the lookup too. The reads off such a
 * value reach the runtime by name, so the lookup then holds the names the
 * program reads by name off a value that can be one (storedGlobalReadNames)
 * and not every declared global: a program pays for the builtins it names. */
import * as ts from "../ts7/adapter.js";
import { withoutParentheses } from "../outer-expressions.js";
import {
  arrayOf,
  BYTES_ELEMENT_NAME,
  DYN,
  F64,
  STRING,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import { isStrictCode } from "./strict-mode.js";
import type { Lowerer } from "./lowerer.js";
import { COMMONJS_MODULE_BINDINGS } from "../builtin-modules.js";
import { nodeUndefinedGlobalName } from "./lower-namespaces.js";
import { stdlibGlobalNameOf } from "./surfaces.js";
import { NODE_GLOBALS_WITHOUT_NATIVE } from "./host-globals.js";
import { hostGlobalValue } from "./host-global-values.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import { builtinNamespaceValue } from "./builtin-namespaces.js";
import { uriFunctionValue } from "./expressions/identifiers.js";
import { navigatorValue } from "./builtins/navigator.js";
import { primitiveCtorClosure } from "./lower-exprs.js";
import { globalFunctionValue, isUnloweredGlobal } from "./global-function-values.js";
import { storedGlobalValue, unloweredGlobalValue } from "./node-value-reads.js";
import {
  WEB_STREAM_CLASSES,
  programNamesWebStreamClass,
  webStreamClassValue,
} from "./builtins/web-streams-dyn.js";

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
 * `const { name } = globalThis`, `globalThis[name]`), or null when no
 * lowering has a value for it (node-value-reads.ts answers those). `reportFences` is false for the
 * program's lookup, which holds every declared global's value whether or
 * not the program reads it. */
export function jsGlobalValueByName(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  reportFences = true,
): IrExpr | null {
  return (
    jsSpecialGlobalValue(lowerer, name, loc, reportFences) ??
    builtinNamespaceValue(lowerer, name, loc, reportFences) ??
    builtinGlobalValue(name, loc, true)
  );
}

/** Globals whose values a TypeScript read keeps refused: the Array
 * constructor value has none of Array's static members (`o.Array.isArray`
 * would read undefined), and the timer values lack the
 * util.promisify.custom getter Node's util.inspect lists. */
const UNTYPED_UNMODELED: ReadonlySet<string> = new Set(["Array", "setTimeout", "setImmediate"]);

/** The value a TypeScript source reads for the declared global `name` at
 * `node` when the checker types the slot it flows into as any or unknown
 * (`const o: any = { j: JSON }`, a call to a parameter typed unknown): the
 * value a JavaScript source reads. Null in JavaScript sources, in typed
 * slots, and for a global without a value, whose read keeps its SC2020
 * refusal. Null for the primitive constructors too: a TypeScript read of
 * String, Number, Boolean or BigInt is the closure with the typed
 * signature (lowerIdentifierExpr), and `{ String }` must equal it. */
export function tsUntypedGlobalValue(
  lowerer: Lowerer,
  node: ts.Expression,
  name: string,
  loc: SrcLoc,
): IrExpr | null {
  if (
    isJsSourceFile(ts.getSourceFileOfNode(node)) ||
    UNTYPED_UNMODELED.has(name) ||
    isUnloweredGlobal(name)
  )
    return null;
  if (name === "String" || name === "Number" || name === "Boolean" || name === "BigInt")
    return null;
  if (!flowsIntoUntypedSlot(lowerer, node)) return null;
  return jsGlobalValueByName(lowerer, name, loc);
}

/** Whether the checker types the slot `node` flows into as any or unknown.
 * A member of an object or array literal whose own slot is any has no
 * contextual type, so the literal's slot decides. */
function flowsIntoUntypedSlot(lowerer: Lowerer, node: ts.Expression): boolean {
  let value: ts.Expression = node;
  for (;;) {
    const slot = lowerer.checker.getContextualType(value);
    if (slot !== undefined) return (slot.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const parent = value.parent;
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === value) ||
      ts.isShorthandPropertyAssignment(parent)
    ) {
      value = parent.parent as ts.ObjectLiteralExpression;
    } else if (ts.isArrayLiteralExpression(parent) || ts.isParenthesizedExpression(parent)) {
      value = parent;
    } else {
      return false;
    }
  }
}

/** jsGlobalValueByName for the globals other than the interned builtin
 * functions and constructors (builtinGlobalValue). `reportFences` is false
 * for the program's lookup (jsGlobalValueByName). */
export function jsSpecialGlobalValue(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  reportFences = true,
): IrExpr | null {
  if (name === "NaN" || name === "Infinity")
    return { kind: "numLit", value: name === "NaN" ? NaN : Infinity, type: F64, loc };
  if (name === "String" || name === "Number" || name === "Boolean" || name === "BigInt")
    return primitiveCtorClosure(lowerer, name, loc);
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
  return globalFunctionValue(lowerer, name, loc, reportFences);
}

const URI_FUNCTIONS = new Set([
  "encodeURIComponent",
  "encodeURI",
  "decodeURI",
  "decodeURIComponent",
]);

/** The builtin globals that sloppy-mode functions of the JavaScript source
 * `sf` read through their `this` (`this.Array`, `this["Array"]`) or through
 * a variable it initializes (`var root = this; root.Array`); every declared
 * global when such a read takes a computed key (`this[name]`). Called with
 * undefined or null as `this`, such a function reads them on the global
 * object, which answers them through the program's lookup. */
export function sloppyThisGlobalReadsOf(lowerer: Lowerer, sf: ts.SourceFile): ReadonlySet<string> {
  const cached = lowerer.sloppyThisGlobalReads.get(sf);
  if (cached !== undefined) return cached;
  const reads = new Set<string>();
  if (isJsSourceFile(sf)) {
    const declared = new Set(declaredGlobalNames(lowerer, sf));
    // Element reads of `this` or of a variable, and the names of the
    // variables initialized with `this`: the checker resolves only the
    // element reads of `this` and of those variables.
    const elementReads: ts.ElementAccessExpression[] = [];
    const thisAliases = new Set<string>();
    ts.walkPreorder(sf, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.name) &&
        declared.has(node.name.text) &&
        readsSloppyThis(lowerer, node.expression)
      )
        reads.add(node.name.text);
      else if (ts.isElementAccessExpression(node)) {
        const target = withoutParentheses(node.expression);
        if (target.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(target))
          elementReads.push(node);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        withoutParentheses(node.initializer).kind === ts.SyntaxKind.ThisKeyword
      )
        thisAliases.add(node.name.text);
      return undefined;
    });
    for (const node of elementReads) {
      const target = withoutParentheses(node.expression);
      if (ts.isIdentifier(target) && !thisAliases.has(target.text)) continue;
      if (!readsSloppyThis(lowerer, node.expression) || !readsBuiltinByName(lowerer, node))
        continue;
      const key = withoutParentheses(node.argumentExpression);
      if (ts.isStringLiteralLike(key)) {
        if (declared.has(key.text)) reads.add(key.text);
      } else if (!ts.isNumericLiteral(key)) {
        for (const name of declared) reads.add(name);
        break;
      }
    }
  }
  lowerer.sloppyThisGlobalReads.set(sf, reads);
  return reads;
}

/** Whether `expr` is the `this` of a sloppy-mode function, or a variable
 * whose only declaration initializes it with that `this`. */
function readsSloppyThis(lowerer: Lowerer, expr: ts.Expression): boolean {
  const inner = withoutParentheses(expr);
  if (inner.kind === ts.SyntaxKind.ThisKeyword) return sloppyReceiverOf(inner);
  if (!ts.isIdentifier(inner)) return false;
  const declarations = lowerer.checker.getSymbolAtLocation(inner)?.declarations ?? [];
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration)
  )
    return false;
  const init =
    declaration.initializer === undefined ? undefined : withoutParentheses(declaration.initializer);
  return init !== undefined && init.kind === ts.SyntaxKind.ThisKeyword && sloppyReceiverOf(init);
}

/** Whether the `this` at `node` is a sloppy-mode function's receiver
 * (lower-functions.ts declareCallReceiver): arrows take the enclosing one. */
function sloppyReceiverOf(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionLike(parent)) return parent.body !== undefined && !isStrictCode(parent.body);
    if (
      ts.isSourceFile(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isClassStaticBlockDeclaration(parent)
    )
      return false;
  }
  return false;
}

/** The global object's members that are the global object again. */
const GLOBAL_SELF_MEMBERS = new Set(["globalThis", "global"]);

/** Whether the JavaScript source `sf` stores the global object as a value
 * whose identity the compiler does not follow: a spelling of it, a followed
 * `const` alias of it, or the `this` of a sloppy-mode function expression
 * called in place, anywhere but where the value ends (storedAt). Such a
 * value reaches member reads the compiler cannot resolve (`var root =
 * typeof globalThis !== "undefined" ? globalThis : self; root.Headers`,
 * `function pick(root) { return root.URL }`), which the runtime answers
 * from the program's lookup. */
export function storesGlobalObject(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  if (!isJsSourceFile(sf)) return false;
  const cached = lowerer.storedGlobalObjects.get(sf);
  if (cached !== undefined) return cached;
  let stored = false;
  const aliases = new Set<string>();
  const visit =
    (named: (text: string) => boolean, withThis: boolean) =>
    (node: ts.Node): "stop" | undefined => {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        if (withThis && calledInPlaceSloppyThis(node) && storedAt(globalValueOf(lowerer, node)))
          stored = true;
      } else if (ts.isIdentifier(node) && named(node.text) && spellsGlobalObject(lowerer, node)) {
        const value = globalValueOf(lowerer, node);
        if (storedAt(value)) stored = true;
        else if (ts.isVariableDeclaration(value.parent) && ts.isIdentifier(value.parent.name))
          // A followed alias (`const g = globalThis`) is a spelling too.
          aliases.add(value.parent.name.text);
      }
      return stored ? "stop" : undefined;
    };
  ts.walkPreorder(
    sf,
    visit((text) => GLOBAL_SELF_MEMBERS.has(text), true),
  );
  // An alias can be read above its declaration (a hoisted function).
  if (!stored && aliases.size > 0)
    ts.walkPreorder(
      sf,
      visit((text) => aliases.has(text), false),
    );
  lowerer.storedGlobalObjects.set(sf, stored);
  return stored;
}

/** The parent of `node` above its parentheses. */
function withoutParenthesesParent(node: ts.Node): ts.Node | undefined {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

/** Whether the identifier `node` is read as a value and reads the global
 * object: not a member name, a property key or a declared name. */
function spellsGlobalObject(lowerer: Lowerer, node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node)
  )
    return false;
  return isGlobalObjectRead(lowerer, node);
}

/** Whether the `this` at `node` is the global object by construction: the
 * receiver of a sloppy-mode function expression that is called in place
 * (`(function () { return this; })()`); arrows take the enclosing one. */
function calledInPlaceSloppyThis(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionExpression(parent)) {
      if (parent.body === undefined || isStrictCode(parent.body)) return false;
      const call = withoutParenthesesParent(parent);
      return ts.isCallExpression(call) && withoutParentheses(call.expression) === parent;
    }
    if (
      ts.isFunctionLike(parent) ||
      ts.isSourceFile(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isClassStaticBlockDeclaration(parent)
    )
      return false;
  }
  return false;
}

/** The outermost expression that is the global object read by `spelling`:
 * above its parentheses, the global object's members that are the global
 * object again, and a detection chain that selects its arm statically. */
function globalValueOf(lowerer: Lowerer, spelling: ts.Node): ts.Node {
  let value = spelling;
  for (;;) {
    const parent = value.parent;
    if (ts.isParenthesizedExpression(parent)) value = parent;
    else if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === value &&
      GLOBAL_SELF_MEMBERS.has(parent.name.text)
    )
      // `globalThis.globalThis`, `global.global`: the global object again.
      value = parent;
    else if (
      ts.isConditionalExpression(parent) &&
      parent.condition !== value &&
      stdlibGlobalNameOf(lowerer, parent) === "globalThis"
    )
      // The arm a detection chain selects statically is the chain's value.
      value = parent;
    else return value;
  }
}

/** Whether the global object that the expression `value` reads is stored:
 * it goes on to a place that holds it (a mutable binding, an argument, a
 * returned or assigned value, an arm of a choice the compiler does not
 * decide, an operand that can be a logical expression's result). It ends,
 * and is not stored, as the receiver of a member or element read, the
 * operand of `typeof`, `void`, `delete`, `!` or a comparison, a condition,
 * a statement, or the initializer of a `const` the compiler follows. */
function storedAt(value: ts.Node): boolean {
  const parent = value.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return false;
  if (ts.isConditionalExpression(parent)) return parent.condition !== value;
  if (ts.isIfStatement(parent) || ts.isExpressionStatement(parent)) return false;
  switch (parent.kind) {
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.DeleteExpression:
    case ts.SyntaxKind.PrefixUnaryExpression:
      return false;
    default:
  }
  if (ts.isBinaryExpression(parent)) {
    switch (parent.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.InKeyword:
      case ts.SyntaxKind.InstanceOfKeyword:
        return false;
      // The global object is truthy: `global && x` never answers it.
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.EqualsToken:
        return parent.right === value;
      default:
        return true;
    }
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === value)
    return !(
      ts.isIdentifier(parent.name) && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0
    );
  return true;
}

/** The declared globals the program's JavaScript sources read by name off a
 * value that can be a stored global object, when a source stores one
 * (storesGlobalObject): the names of member reads (`root.Headers`), of
 * element reads by a literal key (`root["Headers"]`) and of object patterns
 * (`var { Headers } = root`). A receiver the checker types as an object
 * other than the global object is not one: `require("url").URL` reads the
 * module's member. `fetch` is among them (the runtime answers it only in a
 * program that also spells it bare), and so are the Node globals native
 * code does not provide (host-globals.ts), whose reads answer the
 * constructor Node has. Empty when no source stores the global object. */
function storedGlobalReadNames(lowerer: Lowerer): ReadonlySet<string> {
  if (lowerer.storedGlobalReadNames !== undefined) return lowerer.storedGlobalReadNames;
  const modules = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  const names = new Set<string>();
  lowerer.storedGlobalReadNames = names;
  if (!modules.some((sf) => storesGlobalObject(lowerer, sf))) return names;
  const declared = new Set(declaredGlobalNames(lowerer, lowerer.entry));
  declared.add("fetch");
  for (const name of NODE_GLOBALS_WITHOUT_NATIVE) declared.add(name);
  for (const sf of modules) {
    if (!isJsSourceFile(sf)) continue;
    ts.walkPreorder(sf, (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        if (
          ts.isIdentifier(node.name) &&
          declared.has(node.name.text) &&
          !names.has(node.name.text) &&
          !isAssignmentTarget(node) &&
          canHoldGlobalObject(lowerer, node.expression, node.name.text)
        )
          names.add(node.name.text);
      } else if (ts.isElementAccessExpression(node)) {
        const key = withoutParentheses(node.argumentExpression);
        if (
          ts.isStringLiteralLike(key) &&
          declared.has(key.text) &&
          !names.has(key.text) &&
          !isAssignmentTarget(node) &&
          canHoldGlobalObject(lowerer, node.expression, key.text)
        )
          names.add(key.text);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && declared.has(key.text))
          names.add(key.text);
      }
      return undefined;
    });
  }
  return names;
}

/** Whether `node` is the target of `=`. */
function isAssignmentTarget(node: ts.Expression): boolean {
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === outer &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** Whether the read of `name` off `receiver` can read a stored global
 * object: the checker types the receiver as any, unknown, a type parameter
 * or the global object's own type, or as a type that declares no member
 * `name` (the `{}` of `a || b || {}`), or as a union with such a member. A
 * type that declares the member owns the read. A sloppy-mode `this` has its
 * own rule (sloppyThisGlobalReadsOf). */
function canHoldGlobalObject(lowerer: Lowerer, receiver: ts.Expression, name: string): boolean {
  const inner = withoutParentheses(receiver);
  if (inner.kind === ts.SyntaxKind.ThisKeyword) return false;
  const can = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
      return true;
    if (type.isUnionType()) return ts.constituentTypes(type).some(can);
    if (lowerer.checker.getPropertyOfType(type, name) === undefined) return true;
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      ts.symbolName(symbol) === "globalThis" &&
      symbol.declarations.length === 0
    );
  };
  return can(lowerer.typeOf(inner));
}

/** The names of the global object's declared properties that the lookup can
 * answer. */
function declaredGlobalNames(lowerer: Lowerer, at: ts.Node): string[] {
  const symbol = lowerer.checker.resolveName(
    "globalThis",
    ts.SymbolFlags.Value,
    ts.getSourceFileOfNode(at),
    false,
  );
  if (symbol === undefined) return [];
  return lowerer.checker
    .getPropertiesOfType(lowerer.checker.getTypeOfSymbol(symbol))
    .map((property) => ts.symbolName(property))
    .filter(
      (name) =>
        !nodeUndefinedGlobalName(name) &&
        !RUNTIME_ANSWERED.has(name) &&
        !COMMONJS_MODULE_BINDINGS.has(name),
    );
}

/** The names the program's lookup answers: every declared global when a
 * module reads the global object by computed names, else the ones its
 * sloppy-mode functions read through `this` and the ones its sources read
 * by name off a value that can be a stored global object. */
function lookupNames(lowerer: Lowerer): readonly string[] {
  if (lowerer.globalLookupNames !== undefined) return lowerer.globalLookupNames;
  const modules = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  const names = modules.some((sf) => computedGlobalReadOf(lowerer, sf) !== null)
    ? [...declaredGlobalNames(lowerer, lowerer.entry), ...storedOnlyNames(lowerer)]
    : [
        ...modules.flatMap((sf) => [...sloppyThisGlobalReadsOf(lowerer, sf)]),
        ...storedGlobalReadNames(lowerer),
      ];
  lowerer.globalLookupNames = [...new Set(names)].sort();
  return lowerer.globalLookupNames;
}

/** The names the program reads off a stored global object that the list of
 * every declared global does not hold: `fetch`, which that list leaves to
 * the runtime, and the Node globals native code does not provide. */
function storedOnlyNames(lowerer: Lowerer): string[] {
  return [...storedGlobalReadNames(lowerer)].filter(
    (name) => name === "fetch" || NODE_GLOBALS_WITHOUT_NATIVE.has(name),
  );
}

/** Whether the JavaScript source `sf` installs the program's lookup when its
 * body starts: it reads builtin globals through the global object by
 * computed names or through a sloppy-mode function's `this`, or it stores
 * the global object as a value and the program reads builtin globals by
 * name off such a value. */
export function installsGlobalValues(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  return (
    computedGlobalReadOf(lowerer, sf) !== null ||
    sloppyThisGlobalReadsOf(lowerer, sf).size > 0 ||
    (storesGlobalObject(lowerer, sf) && lookupNames(lowerer).length > 0)
  );
}

/** The statement that installs the program's lookup, built on first use
 * from the names it answers (lookupNames). `at` is the module that
 * installs it, which a value's refusal names. */
export function globalValuesInstall(lowerer: Lowerer, loc: SrcLoc, at: ts.Node): IrStmt[] {
  const fnType: IrType & { kind: "func" } = { kind: "func", params: [STRING], ret: DYN };
  if (!lowerer.liftedFnNamed(LOOKUP_FN)) {
    const name: IrExpr = { kind: "varRef", localId: "name.0", type: STRING, loc };
    const body: IrStmt[] = [];
    const stored = storedGlobalReadNames(lowerer);
    for (const global of lookupNames(lowerer)) {
      const webStream = (WEB_STREAM_CLASSES as readonly string[]).indexOf(global);
      const value: IrExpr | null = REFUSED.has(global)
        ? { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc }
        : webStream >= 0
          ? programNamesWebStreamClass(lowerer)
            ? webStreamClassValue(webStream, loc)
            : null
          : NODE_GLOBALS_WITHOUT_NATIVE.has(global)
            ? hostGlobalValue(lowerer, global, at)
            : jsGlobalValueByName(lowerer, global, loc, false);
      // A global no lowering has a value for reads what its bare spelling
      // reads (node-value-reads.ts): the refusing function value for a
      // function or class, the object the census describes for `process`
      // and `performance`. Any other value is refused by the runtime's
      // SC2020, as the bare spelling refuses it.
      const answered: IrExpr = value ??
        storedGlobalValue(lowerer, global, at, loc, stored.has(global)) ?? {
          kind: "unitLit",
          unit: "null",
          type: { kind: "nullT" },
          loc,
        };
      // A function boxed here has no source spelling to take its name from
      // (the identifier read's rule): it takes the global's name, as
      // `globalThis.String.name` is "String".
      const boxed = lowerer.coerceToExpected(answered, DYN);
      const named: IrExpr =
        boxed.kind === "dynFrom" && boxed.value.type.kind === "func" && boxed.fnName === undefined
          ? { ...boxed, fnName: global }
          : boxed;
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
        then: [{ kind: "return", value: named, loc }],
        else_: null,
        loc,
      });
    }
    // The runtime asks only for the names above; any other name is refused.
    body.push({
      kind: "return",
      value: lowerer.coerceToExpected(
        { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc },
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
  const install: IrStmt = {
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
  // The runtime asks the lookup only for the names it knows as the global
  // object's (lower-global-value.ts): the Node globals native code does not
  // provide join them in a program that reads one off a stored global object.
  const hostNames = lookupNames(lowerer).filter((name) => NODE_GLOBALS_WITHOUT_NATIVE.has(name));
  if (hostNames.length === 0) return [install];
  const known: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "global.native",
      args: [
        {
          kind: "templateStrings",
          key: `%globalThis.hostNames:${hostNames.join(",")}`,
          cooked: hostNames,
          type: arrayOf(STRING),
          loc,
        },
      ],
      type: DYN,
      loc,
    },
    loc,
  };
  return [known, install];
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

/** Whether the builtin module member `bi` is the global object of the same
 * name (GLOBAL_MEMBERS). */
export function isGlobalMember(bi: { module: string; member: string }): boolean {
  return GLOBAL_MEMBERS[bi.module]?.has(bi.member) === true;
}

/** In a JavaScript source, the value of a builtin module member that is a
 * global object (GLOBAL_MEMBERS): what the global's own spelling reads at
 * `node`, so identity holds across the spellings. Null for other members. */
export function globalMemberValue(
  lowerer: Lowerer,
  bi: { module: string; member: string },
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (!GLOBAL_MEMBERS[bi.module]?.has(bi.member)) return null;
  return (
    jsGlobalValueByName(lowerer, bi.member, loc) ??
    unloweredGlobalValue(lowerer, bi.member, node, loc)
  );
}
