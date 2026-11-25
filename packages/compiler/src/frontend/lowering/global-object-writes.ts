/* The names a program writes on the global object.
 *
 * A built-in global named through the global object (`globalThis.fetch(…)`)
 * is the built-in its bare name names, unless the program replaces that
 * member: then the program means its own value there, and a compiled
 * program has only the built-in to give. This census finds every spelling
 * of such a write, in any source of the program, so that no call or read
 * through the global object answers the built-in for a member the program
 * wrote:
 *
 *   G.name = v, every compound assignment, G["name"] = v, delete G.name,
 *   Object.defineProperty(G, "name", …), Reflect.defineProperty(G, "name", …),
 *   Reflect.set(G, "name", v), Object.defineProperties(G, { name: … }),
 *   Object.assign(G, { name: v })
 *
 * where G is any spelling of the global object: `globalThis`, `global`, a
 * binding or an expression the checker types as the global object.
 *
 * A name that is not written out may be any name where nothing else
 * stops it: the key of a defining call, a spread or a value that is no
 * literal in one. An ASSIGNMENT by a computed key (`G[key] = v`, how a
 * package keeps its own state on the global object) does not count as a
 * REPLACEMENT: the runtime refuses such a write when the key names a
 * built-in, where it runs ("setting 'setTimeout' on a dynamic Object is not
 * supported"), so it cannot replace one. It does create an ordinary
 * property, so it is recorded as `unknownNames` for the question whether a
 * name can exist at all, as is a `this.<key> = v` write in sloppy-mode code
 * (whose `this` is the global object when the function is called with
 * undefined or null). A key the checker types as a symbol does not count
 * either way, in any spelling (`Reflect.set(G, KEY, v)` with `KEY` a
 * `Symbol.for(…)`): a symbol names no property an identifier reads.
 *
 * The scan reads a source only when its text can spell one of those writes:
 * `globalThis` and `global` contain "global", and a sloppy-mode `this`
 * write — the one spelling that does not — contains "this".
 *
 * The same census answers a TypeScript question: a bare reference to a
 * DECLARED global (`declare var document: T` in a script-style declaration
 * file, `declare const`, a `declare global` block) has no run-time variable
 * either, because TypeScript erases the declaration, so Node resolves the
 * reference through the global object too. Such a read keeps its static
 * lowering unless the census can give the name a value
 * (erasedGlobalBindingOf, programMayWriteGlobalName). */
import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { isStrictCode } from "./strict-mode.js";
import { inGlobalScope } from "./lower-namespaces.js";
import { globalObjectType } from "./global-object-names.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

export interface GlobalObjectWrites {
  /** The names written by a literal key. */
  names: Set<string>;
  /** Some write names its member only when the program runs. */
  computed: boolean;
  /** A write the census recognizes on a spelling of the global object names
   * the property only when the program runs in a way the built-in question
   * ignores: an assignment by a computed key, which the runtime refuses when
   * the key names a built-in, or a `this.<key>` assignment in sloppy-mode
   * code, whose receiver is the global object when the function is called
   * with undefined or null. Unlike `computed`, such a write can create any
   * ordinary property, so `typeof` of a name it does not spell can exist. */
  unknownNames: boolean;
}

const DEFINERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Object", new Set(["defineProperty", "defineProperties", "assign"])],
  ["Reflect", new Set(["defineProperty", "set", "deleteProperty"])],
]);

/** Whether a read of the undeclared `name` anywhere in the program may find
 * a property the program itself put on the global object before the read
 * runs: a censused write of that name, or a write whose property name the
 * program does not spell. Only the census knows; it reaches the whole
 * program, so a name it does not report is absent from the global object at
 * every point of the program, and a `typeof name` of it keeps its static
 * answer. A program whose global object the checker cannot name stays
 * conservative (true). `node` places the check in the read's own source
 * file. */
export function programMayWriteGlobalName(lowerer: Lowerer, name: string, node: ts.Node): boolean {
  const globalType = globalObjectType(lowerer, node);
  if (globalType === undefined) return true;
  const writes = globalObjectWrites(lowerer, globalType);
  return writes.computed || writes.unknownNames || writes.names.has(name);
}

/** Whether `id` reads a GLOBAL binding the program declares and TypeScript
 * erases: an ambient variable declaration with no initializer (`declare
 * var/let/const`, also the module form `declare global { const x: T }`).
 * The declaration never exists at run time, so Node resolves the reference
 * through the global object, exactly as it resolves a name nothing declares.
 * A merged value declaration that is not such a declaration (a real `var` in
 * a script file, an import alias) answers false, as does a member of an
 * ambient namespace or a `.d.ts` module, and a STANDARD-LIBRARY global
 * (`Infinity`, `NaN`, `undefined`, `globalThis`, the constructors, Math,
 * JSON): TypeScript erases those declarations too, but Node's global object
 * has the built-in value.
 *
 * The read keeps that answer only where the program may have written the
 * name on the global object (programMayWriteGlobalName); every other read
 * keeps its static answer, so a program that never writes the name pays
 * nothing for the rule. */
export function erasedGlobalBindingOf(lowerer: Lowerer, id: ts.Identifier): boolean {
  // An import of the same name is the program's binding of an export, not
  // the global object's property.
  const symbol = lowerer.checker.getSymbolAtLocation(id);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) !== 0) return false;
  // A STANDARD-LIBRARY global (Infinity, NaN, undefined, globalThis, the
  // constructors, Math, JSON, the @types/node globals) does not use the
  // global object's program-owned table: Node's global object defines the
  // property with the built-in value, so a read answers the built-in even
  // when the program may have written OTHER properties there. TypeScript
  // erases the declaration, but the run-time binding exists.
  if (lowerer.isStdlibSymbol(symbol)) return false;
  const declarations = lowerer.resolveValueSymbol(id)?.declarations ?? [];
  let sawValue = false;
  for (const declaration of declarations) {
    // Type-world partners (the interface a global's declaration merges
    // with) declare no value.
    if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) continue;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== undefined)
      return false;
    if (!inGlobalScope(declaration) || !isAmbientDeclaration(declaration)) return false;
    sawValue = true;
  }
  return sawValue;
}

/** Whether the declaration is ambient (or in a `.d.ts`): TypeScript emits
 * nothing for it, so no runtime binding exists. `declare global` passes the
 * modifier down to the declarations inside it. */
function isAmbientDeclaration(declaration: ts.Node): boolean {
  for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
    if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0) return true;
    if (ts.isSourceFile(node)) return node.isDeclarationFile;
  }
  return false;
}

/** The census, made on first use. `globalType` is the checker's type of
 * the global object. */
export function globalObjectWrites(lowerer: Lowerer, globalType: ts.Type): GlobalObjectWrites {
  const known = lowerer.globalObjectWrites;
  if (known !== null) return known;
  const writes: GlobalObjectWrites = { names: new Set(), computed: false, unknownNames: false };
  lowerer.globalObjectWrites = writes;
  const isGlobalObject = (expr: ts.Expression): boolean => {
    const value = withoutParenthesesTypeWrappers(expr);
    return (
      lowerer.typeOf(value) === globalType || stdlibGlobalNameOf(lowerer, value) === "globalThis"
    );
  };
  const isSymbol = (expr: ts.Expression): boolean =>
    (lowerer.typeOf(expr).flags & ts.TypeFlags.ESSymbolLike) !== 0;
  const key = (name: ts.Node | undefined): void => {
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)))
      writes.names.add(name.text);
    else if (name === undefined || !ts.isComputedPropertyName(name) || !isSymbol(name.expression))
      writes.computed = true;
  };
  /** A member write's name: a literal key is a name, and any other string
   * key names one the program computes (a symbol key names no property an
   * identifier reads). */
  const memberKey = (
    member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    assignment: boolean,
  ): void => {
    if (ts.isPropertyAccessExpression(member)) key(member.name);
    else {
      const argument = withoutParenthesesTypeWrappers(member.argumentExpression);
      if (ts.isStringLiteralLike(argument)) key(argument);
      else if (assignment && !isSymbol(argument)) writes.unknownNames = true;
    }
  };
  /** A `this.<key> = v` write in sloppy-mode code: called with undefined or
   * null, the function's `this` is the global object, so the write lands
   * there. Strict code's `this` is the receiver the caller passed. */
  const sloppyThis = (member: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean =>
    member.expression.kind === ts.SyntaxKind.ThisKeyword && !isStrictCode(member);
  const member = (target: ts.Expression, assignment: boolean): void => {
    const written = withoutParenthesesTypeWrappers(target);
    if (!ts.isPropertyAccessExpression(written) && !ts.isElementAccessExpression(written)) return;
    if (isGlobalObject(written.expression)) memberKey(written, assignment);
    else if (assignment && sloppyThis(written)) memberKey(written, true);
  };
  const literalMembers = (value: ts.Expression | undefined): void => {
    const literal = value === undefined ? undefined : withoutParenthesesTypeWrappers(value);
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
      writes.computed = true;
      return;
    }
    for (const property of literal.properties.nodes) {
      if (ts.isSpreadAssignment(property)) writes.computed = true;
      else key(property.name);
    }
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    // `globalThis` and `global` spell "global"; a sloppy-mode `this.<name> = v`
    // write, the one spelling that does not, spells "this".
    if (
      sf.isDeclarationFile ||
      (!ts.sourceTextIncludes(sf, "global") && !ts.sourceTextIncludes(sf, "this"))
    )
      continue;
    ts.walkPreorder(sf, (node) => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        member(node.left, true);
      } else if (ts.isDeleteExpression(node)) {
        member(node.expression, false);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const methods = DEFINERS.get(node.expression.expression.text);
        const method = node.expression.name.text;
        const target = node.arguments.nodes[0];
        if (methods?.has(method) && target !== undefined && !ts.isSpreadElement(target)) {
          if (isGlobalObject(target)) {
            if (method === "defineProperties") literalMembers(node.arguments.nodes[1]);
            else if (method === "assign")
              for (const source of node.arguments.nodes.slice(1)) literalMembers(source);
            else {
              const name = node.arguments.nodes[1];
              const literal = name === undefined ? undefined : withoutParenthesesTypeWrappers(name);
              if (literal === undefined || ts.isSpreadElement(literal) || !isSymbol(literal))
                key(literal !== undefined && ts.isStringLiteralLike(literal) ? literal : undefined);
            }
          }
        }
      }
      return undefined;
    });
  }
  return writes;
}
