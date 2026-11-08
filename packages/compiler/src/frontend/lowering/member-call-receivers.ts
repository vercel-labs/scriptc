/* Which typed member calls supply their receiver.
 *
 * JavaScript calls `holder.f()` with `holder` as `this`. A function that
 * reads the receiver of its call (a function with its own `this`: a
 * declaration, a function expression or an object-literal method; an arrow
 * has none, and a class method checks the receiver it is given) takes it
 * from the receiver the call supplied.
 *
 * The rule. Such a function escapes unless every use of its value, anywhere
 * in the program, is in one of these places:
 *
 *  - it is called: `f(…)`, `new f(…)`, `f.call(…)`, `f.apply(…)`,
 *    `f.bind(…)`;
 *  - it is tested: a condition, `!`, `typeof`, a comparison, the left of
 *    `&&`; or its value is dropped (a statement, `void`, a template span,
 *    `f.length`, `f.name`, `f.toString`);
 *  - it is stored under a name: an object-literal method, property or
 *    shorthand, a class field's initializer, `x.name = f`, `x["name"] = f`;
 *  - it is the value of `a || f`, `a ?? f`, `a && f`, `c ? f : g` or `a, f`
 *    that is itself in one of these places.
 *
 * A member that holds one is held to the same list: every read of that
 * member's name, anywhere in the program, is one of the places above, with
 * "called" meaning `holder.name(…)`. A read of any member under a key that
 * is not known, and the standard library's reads of an object's members by
 * value (`Object.values`, `Object.entries`, `Reflect.get`, property
 * descriptors), could be a read of it and count as escapes.
 *
 * The guarantee. If no function reads its receiver, no member call carries.
 * If none escapes, the member calls of exactly the names they are stored
 * under carry, and so do calls under a key that is not known.
 *
 * Once one escapes (a variable, an argument, a return value, an array
 * element, a destructured member, a store under a computed key, a renamed
 * import, a closure), it may be the value of any expression that is not,
 * by its own syntax, something else: an arrow, a class, a function that
 * does not read its receiver, a bound function, a value that is not a
 * function, an unassigned `const` of one of those, or a read of a member
 * that cannot hold it. A member can hold it only if a store under the
 * member's name stores an expression that may be it, so a member call in a
 * TypeScript source on a record, a tuple, an array, a field of a class
 * instance or of an untyped value, or a union of them carries its holder
 * when some store under the member's name does: an object-literal
 * property, shorthand or getter, a class field or parameter property, an
 * assignment, a destructuring or loop target, `Object.defineProperty` and
 * `Reflect.set`. A copy (a spread, `Object.assign`, a rest pattern, a
 * record converted to another record type) keeps each member's name, which
 * is why the fact is by name and not by declaring symbol, or makes it an
 * index, and indexes always carry. A store under a name that is not known
 * (a computed key, `Object.fromEntries`, `Object.defineProperties`, a
 * proxy) that may store it makes every member carry. Nothing is followed. */
import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import type { Lowerer } from "./lowerer.js";
import { bindingNeverReassigned } from "./binding-analysis.js";

export interface MemberCallReceivers {
  /** Whether a call of member `name` on a record passes the record. */
  carries(name: string): boolean;
  /** Whether a call of a member read by a computed key or an index does. */
  keyed(): boolean;
  /** Whether any member does (false for a program with no function that
   * reads the receiver of its call). */
  readonly any: boolean;
}

const NONE: MemberCallReceivers = { carries: () => false, keyed: () => false, any: false };

const ASSIGNMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** The expression `node` is the whole value of, through parentheses and
 * type-only syntax. */
function valueRoot(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertion(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** Whether a function reads the receiver of its own call: a `this` in its
 * parameters or body outside nested functions and classes, which bind
 * their own, or a declared `this` parameter. */
function readsOwnReceiver(fn: ts.FunctionLikeDeclaration): boolean {
  if (
    fn.parameters.nodes.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "this",
    )
  )
    return true;
  const reads = (node: ts.Node): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
      return true;
    if (
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return false;
    return ts.forEachChild(node, (child) => (reads(child) ? true : undefined)) === true;
  };
  return ts.forEachChild(fn, (child) => (reads(child) ? true : undefined)) === true;
}

/** The census of one program. It walks every compiled source once to find
 * the functions that read their receiver; a program with none ends there,
 * and its member calls are the calls they are without this fact. */
export function memberCallReceivers(lowerer: Lowerer): MemberCallReceivers {
  // One program is lowered more than once (each stream mode is a pass of
  // its own), and the answer is a property of the program: its analysis
  // owns it.
  const analysis = lowerer.program.analysis;
  const facts = (analysis.memberCallReceivers ??= takeCensus(lowerer));
  if (!facts.any) return NONE;
  if (facts.all) return { carries: () => true, keyed: () => true, any: true };
  return {
    carries: (name) => facts.names.has(name) || INDEX_NAME.test(name),
    keyed: () => facts.keyed,
    any: true,
  };
}

interface CensusFacts {
  any: boolean;
  /** A function that reads its receiver escaped: every member carries. */
  all: boolean;
  names: Set<string>;
  keyed: boolean;
}
const NO_READERS: CensusFacts = { any: false, all: false, names: new Set(), keyed: false };

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** `f.call(…)`, `f.apply(…)` and `f.bind(…)` name the receiver. */
const RECEIVER_MEMBERS = new Set(["call", "apply", "bind"]);
/** Members of a function that are not the function. */
const DROPPED_MEMBERS = new Set(["length", "name", "toString"]);
/** The standard library's reads of an object's members by value. */
const REFLECTIVE_READS = new Set([
  "values",
  "entries",
  "get",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
]);
/** An index: the name an array element has when a copy makes it a member. */
const INDEX_NAME = /^(?:0|[1-9]\d*)$/;

function takeCensus(lowerer: Lowerer): CensusFacts {
  const start = process.env["SCRIPTC_TIMING"] === "1" ? Date.now() : 0;
  const sources = lowerer.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
  /** Functions with their own `this` that read it, outside classes. */
  const readers = new Set<ts.Node>();
  /** The names the declarations among them have. */
  const declared = new Set<string>();
  for (const sf of sources)
    ts.walkPreorder(sf, (node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent))) &&
        node.body !== undefined &&
        readsOwnReceiver(node)
      ) {
        readers.add(node);
        if (ts.isFunctionDeclaration(node) && node.name?.text !== undefined)
          declared.add(node.name.text);
      }
    });
  if (readers.size === 0) return NO_READERS;

  /** The name a member is stored under: an identifier, a literal, or a
   * computed key that folds to a string. Null when it is not known. */
  const keyName = (name: ts.PropertyName | undefined): string | null => {
    if (name === undefined) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
      return name.text ?? null;
    if (ts.isPrivateIdentifier(name)) return name.text ?? null;
    if (ts.isComputedPropertyName(name)) return elementKey(name.expression);
    return null;
  };
  /** The name a key expression names, as `x[key]` and `[key]: v` do. */
  const elementKey = (key: ts.Expression | undefined): string | null => {
    if (key === undefined) return null;
    const literal = withoutParenthesesTypeWrappers(key);
    if (ts.isStringLiteralLike(literal) || ts.isNumericLiteral(literal))
      return literal.text ?? null;
    return lowerer.foldedStringKeyOf(key);
  };

  /** Every use of a name a receiver-reading declaration has. */
  const uses = new Map<string, ts.Identifier[]>();
  /** Every read of a member, by name. A destructuring pattern's read is
   * the pattern's element. */
  const reads = new Map<string, ts.Node[]>();
  /** A read under a key that is not known and is not an index; a read of
   * an object's members by the standard library. */
  let unnamedRead = false;
  /** `import { a as b }`, `export { a as b }`: `a` has another name. */
  const renamed = new Set<string>();
  /** A destructuring assignment's target reads the members it names. */
  const patternReads = (pattern: ts.Expression): void => {
    const target = withoutParenthesesTypeWrappers(pattern);
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties.nodes) {
        if (ts.isSpreadAssignment(property)) continue;
        const name = keyName(property.name);
        if (name === null) unnamedRead = true;
        else push(reads, name, property);
        if (ts.isPropertyAssignment(property)) patternReads(property.initializer);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements.nodes)
        if (ts.isSpreadElement(element)) patternReads(element.expression);
        else if (!ts.isOmittedExpression(element)) patternReads(element);
    } else if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      patternReads(target.left);
  };
  for (const sf of sources)
    ts.walkPreorder(sf, (node) => {
      if (ts.isIdentifier(node)) {
        if (declared.has(node.text ?? "")) push(uses, node.text ?? "", node);
      } else if (ts.isPropertyAccessExpression(node)) {
        push(reads, node.name.text ?? "", node);
        const owner = withoutParenthesesTypeWrappers(node.expression);
        if (
          ts.isIdentifier(owner) &&
          (owner.text === "Object" || owner.text === "Reflect") &&
          REFLECTIVE_READS.has(node.name.text ?? "")
        )
          unnamedRead = true;
      } else if (ts.isElementAccessExpression(node)) {
        const name = elementKey(node.argumentExpression);
        if (name !== null) push(reads, name, node);
        else if (
          (lowerer.typeOf(node.argumentExpression).flags & ts.TypeFlags.NumberLike) === 0 &&
          !isCallee(node) &&
          !isAssigned(node)
        )
          unnamedRead = true;
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        if (node.dotDotDotToken !== undefined) return;
        const name = keyName(
          node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined),
        );
        if (name === null) unnamedRead = true;
        else push(reads, name, node);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = withoutParenthesesTypeWrappers(node.left);
        if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))
          patternReads(target);
      } else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        ts.isExpression(node.initializer)
      )
        patternReads(node.initializer);
      else if (
        (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
        node.propertyName !== undefined &&
        ts.isIdentifier(node.propertyName)
      )
        renamed.add(node.propertyName.text ?? "");
    });

  const checker = lowerer.checker;
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };

  let escaped = false;
  /** The member names a receiver-reading function is stored under. */
  const names = new Set<string>();
  const pending: string[] = [];
  const hold = (name: string | null): void => {
    // A name that is not known, or an index, is every member's name.
    if (name === null || INDEX_NAME.test(name)) escaped = true;
    else if (!names.has(name)) {
      names.add(name);
      pending.push(name);
    }
  };
  /** The place a value that may be such a function is in: one of the
   * list's, or an escape. */
  const place = (value: ts.Node): void => {
    if (escaped) return;
    const root = valueRoot(value);
    const parent = root.parent;
    if (parent === undefined) return;
    // Called.
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === root)
      return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === root) {
      const member = parent.name.text ?? "";
      if (DROPPED_MEMBERS.has(member)) return;
      const access = valueRoot(parent);
      const call = access.parent;
      if (
        RECEIVER_MEMBERS.has(member) &&
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.expression === access
      )
        return;
      escaped = true;
      return;
    }
    // `x[f]`: a key.
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === root) return;
    // Tested, or dropped.
    if (
      ts.isExpressionStatement(parent) ||
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === root) ||
      (ts.isForStatement(parent) && parent.condition === root) ||
      (ts.isConditionalExpression(parent) && parent.condition === root) ||
      (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      ts.isTemplateSpan(parent)
    )
      return;
    // Stored under a name.
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === root &&
      ts.isObjectLiteralExpression(parent.parent) &&
      !isAssignmentPattern(parent.parent)
    ) {
      hold(keyName(parent.name));
      return;
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === root) {
      hold(keyName(parent.name));
      return;
    }
    // The value of a choice is in the place the choice is in.
    if (ts.isConditionalExpression(parent)) {
      place(parent);
      return;
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (operator === ts.SyntaxKind.EqualsToken && parent.right === root) {
        const target = withoutParenthesesTypeWrappers(parent.left);
        if (ts.isPropertyAccessExpression(target)) hold(target.name.text ?? null);
        else if (ts.isElementAccessExpression(target)) hold(elementKey(target.argumentExpression));
        else escaped = true;
        // The assignment is itself a value (`a = x.f = g`).
        place(parent);
        return;
      }
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        place(parent);
        return;
      }
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.CommaToken
      ) {
        // A falsy left side of `&&` is not a function.
        if (parent.right === root) place(parent);
        return;
      }
      // A comparison.
      if (COMPARISONS.has(operator)) return;
    }
    escaped = true;
  };
  for (const reader of readers) {
    if (escaped) break;
    if (ts.isMethodDeclaration(reader)) hold(keyName(reader.name));
    else if (ts.isFunctionExpression(reader)) place(reader);
    else if (ts.isFunctionDeclaration(reader)) {
      const name = reader.name;
      const symbol = name === undefined ? undefined : symbolOf(name);
      // A default export and a renamed import are other names.
      if (
        name === undefined ||
        symbol === undefined ||
        renamed.has(name.text ?? "") ||
        (reader.modifiers?.nodes ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )
      ) {
        escaped = true;
        break;
      }
      for (const use of uses.get(name.text ?? "") ?? []) {
        if (escaped) break;
        const parent = use.parent;
        if (use === name || parent === undefined) continue;
        // `{ f }`: stored under its own name.
        if (ts.isShorthandPropertyAssignment(parent)) {
          let value = checker.getShorthandAssignmentValueSymbol(parent) ?? undefined;
          if (value !== undefined && (value.flags & ts.SymbolFlags.Alias) !== 0)
            value = checker.getAliasedSymbol(value);
          if (value !== symbol) continue;
          if (isAssignmentPattern(parent.parent)) escaped = true;
          else hold(use.text ?? null);
          continue;
        }
        if (symbolOf(use) !== symbol) continue;
        // Names, not uses: an import or export specifier, a type query, the
        // target of an assignment.
        if (
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isTypeQueryNode(parent) ||
          (ts.isBinaryExpression(parent) &&
            ASSIGNMENTS.has(parent.operatorToken.kind) &&
            parent.left === use)
        )
          continue;
        // `ns.f`: read through its module's namespace.
        if (ts.isPropertyAccessExpression(parent) && parent.name === use) {
          escaped = true;
          continue;
        }
        place(use);
      }
    }
  }
  // Each member that holds one answers for every read of its name.
  while (pending.length > 0 && !escaped) {
    if (unnamedRead) {
      escaped = true;
      break;
    }
    for (const read of reads.get(pending.pop()!) ?? []) {
      if (escaped) break;
      // A destructured member is a variable.
      if (!ts.isPropertyAccessExpression(read) && !ts.isElementAccessExpression(read)) {
        escaped = true;
        break;
      }
      // The target of an assignment is a store.
      if (isAssigned(read)) {
        const assignment = valueRoot(read).parent;
        // `x.f ??= g` is also a read, when its value is used.
        if (
          assignment !== undefined &&
          ts.isBinaryExpression(assignment) &&
          assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        )
          place(assignment);
        continue;
      }
      place(read);
    }
  }
  if (!escaped) {
    if (start !== 0) report(start, readers.size, names.size, false, false);
    return names.size === 0 ? NO_READERS : { any: true, all: false, names, keyed: true };
  }

  // One escaped: it may be the value of any expression that is not, by its
  // own syntax, something else. A member can hold it only if a store under
  // the member's name stores such an expression, so the stores decide, name
  // by name. (By name and not by declaring symbol: a record converted to
  // another record type, spread or assigned keeps its members' names and
  // not their declarations.)
  /** Every store into a member, by name; a null value is one the census
   * cannot see. */
  const stores = new Map<string, (ts.Expression | null)[]>();
  /** The stores under names that are not known. */
  const unnamedStores: (ts.Expression | null)[] = [];
  /** The calls of `Object.fromEntries`. */
  const entryObjects: ts.CallExpression[] = [];
  /** Names something assigns: a function declaration's among them, in
   * JavaScript. */
  const assigned = new Set<string>();
  const store = (name: string | null, value: ts.Expression | null): void => {
    if (name === null) unnamedStores.push(value);
    else push(stores, name, value);
  };
  /** A destructuring or loop target: each member it names is stored into,
   * with a value taken apart elsewhere. */
  const storeTarget = (node: ts.Expression): void => {
    const target = withoutParenthesesTypeWrappers(node);
    if (ts.isIdentifier(target)) assigned.add(target.text ?? "");
    else if (ts.isPropertyAccessExpression(target)) store(target.name.text ?? null, null);
    else if (ts.isElementAccessExpression(target))
      store(elementKey(target.argumentExpression), null);
    else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties.nodes)
        if (ts.isPropertyAssignment(property)) storeTarget(property.initializer);
        else if (ts.isSpreadAssignment(property)) storeTarget(property.expression);
        else if (ts.isShorthandPropertyAssignment(property)) assigned.add(property.name.text ?? "");
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements.nodes)
        if (ts.isSpreadElement(element)) storeTarget(element.expression);
        else if (!ts.isOmittedExpression(element)) storeTarget(element);
    } else if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      storeTarget(target.left);
  };
  /** The standard library's stores under a name given as a value. */
  const libraryStore = (call: ts.CallExpression): void => {
    const callee = withoutParenthesesTypeWrappers(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const owner = withoutParenthesesTypeWrappers(callee.expression);
    if (!ts.isIdentifier(owner) || (owner.text !== "Object" && owner.text !== "Reflect")) return;
    const member = callee.name.text;
    const args = call.arguments.nodes;
    if (member === "defineProperty") {
      const name = elementKey(args[1]);
      const descriptor =
        args[2] === undefined ? undefined : withoutParenthesesTypeWrappers(args[2]);
      if (descriptor === undefined || !ts.isObjectLiteralExpression(descriptor)) {
        store(name, null);
        return;
      }
      for (const property of descriptor.properties.nodes) {
        const field = ts.isSpreadAssignment(property) ? null : keyName(property.name);
        if (field === "value" && ts.isPropertyAssignment(property))
          store(name, property.initializer);
        else if (field === "value" || field === "get" || field === null) store(name, null);
      }
    } else if (owner.text === "Reflect" && member === "set")
      store(elementKey(args[1]), args[2] ?? null);
    else if (owner.text === "Object" && member === "fromEntries") entryObjects.push(call);
    else if (
      owner.text === "Object" &&
      (member === "defineProperties" || (member === "create" && args.length > 1))
    )
      store(null, null);
  };
  for (const sf of sources)
    ts.walkPreorder(sf, (node) => {
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent))
        store(keyName(node.name), node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name))
        store(node.name.text ?? null, node.name);
      else if (ts.isPropertyDeclaration(node) && node.initializer !== undefined)
        store(keyName(node.name), node.initializer);
      else if (ts.isParameter(node) && isParameterProperty(node))
        store(ts.isIdentifier(node.name) ? (node.name.text ?? null) : null, null);
      // A getter's member is whatever it returns.
      else if (ts.isGetAccessorDeclaration(node)) store(keyName(node.name), null);
      else if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
        const target = withoutParenthesesTypeWrappers(node.left);
        if (ts.isIdentifier(target)) assigned.add(target.text ?? "");
        else if (ts.isPropertyAccessExpression(target)) store(target.name.text ?? null, node.right);
        else if (ts.isElementAccessExpression(target))
          store(elementKey(target.argumentExpression), node.right);
        else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))
          storeTarget(target);
      } else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        ts.isExpression(node.initializer)
      )
        storeTarget(node.initializer);
      else if (ts.isCallExpression(node)) libraryStore(node);
      // A module's namespace object holds each export under its name.
      else if (ts.isExportSpecifier(node) && ts.isIdentifier(node.name))
        store(
          node.name.text ?? null,
          node.propertyName !== undefined && ts.isIdentifier(node.propertyName)
            ? node.propertyName
            : node.name,
        );
      else if (ts.isExportAssignment(node)) store("default", node.expression);
      else if (
        ts.isVariableDeclaration(node) &&
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
      )
        store(
          ts.isIdentifier(node.name) ? (node.name.text ?? null) : null,
          ts.isVariableDeclarationList(node.parent) &&
            (node.parent.flags & ts.NodeFlags.Const) !== 0
            ? (node.initializer ?? null)
            : null,
        );
      // A proxy answers every member's read with what its handler returns.
      else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Proxy"
      )
        store(null, null);
    });

  /** What a stored value is: not such a function (`free`), possibly one
   * (`held`), or whatever member `member` holds. */
  type Verdict = { kind: "free" | "held" } | { kind: "member"; member: string };
  const FREE: Verdict = { kind: "free" };
  const HELD: Verdict = { kind: "held" };
  const join = (a: Verdict, b: Verdict): Verdict => {
    if (a.kind === "held" || b.kind === "held") return HELD;
    if (a.kind === "free") return b;
    if (b.kind === "free") return a;
    // Two member reads: the same member, or anything.
    return a.kind === "member" && b.kind === "member" && a.member === b.member ? a : HELD;
  };
  const verdicts = new Map<ts.Node, Verdict>();
  const classify = (value: ts.Expression | null, depth: number): Verdict => {
    if (value === null) return HELD;
    const known = verdicts.get(value);
    if (known !== undefined) return known;
    const verdict = classifyValue(withoutParenthesesTypeWrappers(value), depth);
    verdicts.set(value, verdict);
    return verdict;
  };
  /** The closed list of expressions that are not a receiver-reading
   * function. Everything else may be the one that escaped. */
  const classifyValue = (value: ts.Expression, depth: number): Verdict => {
    if (ts.isArrowFunction(value) || ts.isClassExpression(value)) return FREE;
    if (ts.isFunctionExpression(value)) return readers.has(value) ? HELD : FREE;
    if (ts.isConditionalExpression(value))
      return join(classify(value.whenTrue, depth), classify(value.whenFalse, depth));
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      )
        return join(classify(value.left, depth), classify(value.right, depth));
      // `a && b` is `b` or a falsy `a`, which is not a function.
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.CommaToken ||
        operator === ts.SyntaxKind.EqualsToken
      )
        return classify(value.right, depth);
      // Arithmetic and comparison results are not functions.
      return FREE;
    }
    if (ts.isCallExpression(value)) {
      // `f.bind(x)` fixes the receiver, when `f` is a function.
      const callee = withoutParenthesesTypeWrappers(value.expression);
      return ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "bind" &&
        checker.getCallSignatures(lowerer.typeOf(callee.expression)).length > 0
        ? FREE
        : HELD;
    }
    if (ts.isIdentifier(value)) {
      if (value.text === "undefined") return FREE;
      const symbol =
        value.parent !== undefined && ts.isShorthandPropertyAssignment(value.parent)
          ? (checker.getShorthandAssignmentValueSymbol(value.parent) ?? undefined)
          : symbolOf(value);
      const declarations = symbol?.declarations ?? [];
      if (declarations.length === 0 || assigned.has(value.text ?? "")) return HELD;
      let verdict: Verdict = FREE;
      for (const declaration of declarations) {
        if (ts.isFunctionDeclaration(declaration))
          verdict = join(verdict, readers.has(declaration) ? HELD : FREE);
        else if (ts.isClassDeclaration(declaration)) continue;
        else if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          ts.isIdentifier(declaration.name) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
          depth < 4
        )
          verdict = join(verdict, classify(declaration.initializer, depth + 1));
        else return HELD;
      }
      return verdict;
    }
    // A read of a member is whatever the member holds; a function read
    // through its module's namespace is that function.
    if (ts.isPropertyAccessExpression(value)) {
      const declarations = symbolOf(value.name)?.declarations ?? [];
      if (declarations.some((declaration) => readers.has(declaration))) return HELD;
      return { kind: "member", member: value.name.text ?? "" };
    }
    if (ts.isElementAccessExpression(value)) {
      const name = elementKey(value.argumentExpression);
      return name === null ? HELD : { kind: "member", member: name };
    }
    // Values that are not functions.
    if (
      ts.isStringLiteralLike(value) ||
      ts.isNumericLiteral(value) ||
      ts.isBigIntLiteral(value) ||
      ts.isRegularExpressionLiteral(value) ||
      ts.isTemplateExpression(value) ||
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isPrefixUnaryExpression(value) ||
      ts.isPostfixUnaryExpression(value) ||
      ts.isTypeOfExpression(value) ||
      ts.isVoidExpression(value) ||
      ts.isDeleteExpression(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword
    )
      return FREE;
    return HELD;
  };
  /** Whether the checker types a value as something that cannot be called. */
  const neverCallable = (type: ts.Type): boolean => {
    const open =
      ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Object;
    const parts = type.flags & ts.TypeFlags.Union ? ts.constituentTypes(type) : [type];
    return parts.every(
      (part) =>
        (part.flags & open) === 0 ||
        ((part.flags & ts.TypeFlags.Object) !== 0 &&
          (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) ===
            0 &&
          checker.getCallSignatures(part).length === 0 &&
          checker.getPropertiesOfType(part).length > 0),
    );
  };

  // A store under a name that is not known can put it into any member:
  // then every member carries.
  let all = false;
  for (const reader of readers)
    if (ts.isMethodDeclaration(reader) && keyName(reader.name) === null) all = true;
  for (const value of unnamedStores) {
    if (all) break;
    all =
      value === null ||
      (classify(value, 0).kind !== "free" && !neverCallable(lowerer.typeOf(value)));
  }
  // `Object.fromEntries` names its members from data: they hold what the
  // result's index signature says.
  for (const made of entryObjects) {
    if (all) break;
    const values = checker.getIndexInfosOfType(lowerer.typeOf(made));
    all = values.length === 0 || !values.every((info) => neverCallable(info.type));
  }
  if (all) {
    if (start !== 0) report(start, readers.size, stores.size, true, true);
    return { any: true, all: true, names: new Set(), keyed: true };
  }

  /** The names a reader has by its declaration: an object-literal method's,
   * and an exported function's in its module's namespace object. The walk
   * above stopped at the first escape, so `names` may lack some. */
  const declaredUnder = new Set<string>(names);
  for (const reader of readers) {
    if (ts.isMethodDeclaration(reader)) {
      const name = keyName(reader.name);
      if (name !== null) declaredUnder.add(name);
    } else if (
      ts.isFunctionDeclaration(reader) &&
      (ts.getCombinedModifierFlags(reader) & ts.ModifierFlags.Export) !== 0
    )
      declaredUnder.add(
        (ts.getCombinedModifierFlags(reader) & ts.ModifierFlags.Default) !== 0
          ? "default"
          : (reader.name?.text ?? "default"),
      );
  }
  const answers = new Map<string, boolean>();
  const visiting = new Set<string>();
  const holds = (name: string): boolean => {
    const known = answers.get(name);
    if (known !== undefined) return known;
    // A cycle of member reads adds nothing by itself.
    if (visiting.has(name)) return false;
    visiting.add(name);
    // A member a reader was stored under, and an index: the name an array
    // element has when a copy makes it a member.
    let answer = declaredUnder.has(name) || INDEX_NAME.test(name);
    for (const value of stores.get(name) ?? []) {
      if (answer) break;
      const verdict = classify(value, 0);
      answer =
        verdict.kind === "held" ||
        (verdict.kind === "member" && verdict.member !== name && holds(verdict.member));
    }
    visiting.delete(name);
    // A "no" reached while another member was being decided may have cut a
    // cycle through it; only the outermost question's "no" is final.
    if (answer || visiting.size === 0) answers.set(name, answer);
    return answer;
  };
  const carriers = new Set<string>(declaredUnder);
  for (const name of stores.keys()) if (holds(name)) carriers.add(name);
  if (start !== 0) report(start, readers.size, carriers.size, true, false);
  return { any: true, all: false, names: carriers, keyed: true };
}

function isParameterProperty(parameter: ts.ParameterDeclaration): boolean {
  return (
    ts.isConstructorDeclaration(parameter.parent) &&
    (parameter.modifiers?.nodes ?? []).some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PublicKeyword ||
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    )
  );
}

const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/** Whether `access` is the callee of a call: `x.f(…)`, `(x.f)(…)`. */
function isCallee(access: ts.Node): boolean {
  const root = valueRoot(access);
  const parent = root.parent;
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === root;
}

/** Whether `access` is the target of an assignment. */
function isAssigned(access: ts.Node): boolean {
  const root = valueRoot(access);
  const parent = root.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    ASSIGNMENTS.has(parent.operatorToken.kind) &&
    parent.left === root
  );
}

/** Whether an object literal is the target of a destructuring assignment,
 * where a property reads a member instead of storing one. */
function isAssignmentPattern(literal: ts.Node | undefined): boolean {
  for (let node = literal; node !== undefined;) {
    const root = valueRoot(node);
    const parent = root.parent;
    if (parent === undefined) return false;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === root
    )
      return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === root)
      return true;
    // A pattern nested in a pattern.
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === root) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      node = ts.isPropertyAssignment(parent) ? parent.parent : parent;
      continue;
    }
    return false;
  }
  return false;
}

function report(
  start: number,
  readers: number,
  names: number,
  escaped: boolean,
  all: boolean,
): void {
  process.stderr.write(
    `scriptc lowering ${JSON.stringify({ phase: "member-call-receivers", phase_ms: Date.now() - start, readers, names, escaped, all })}\n`,
  );
}

/** The holder of a call's member callee (`x` in `x.f(…)`, `x["f"](…)`,
 * `x[i](…)`, `x.f!(…)`, `(x.f)(…)`, `x?.["f"](…)`, `x?.f?.(…)`), when the
 * call passes it as the receiver: the member can hold a function that reads
 * the receiver of its call, and `x` is a record, a tuple, an array, a class
 * instance, a class or an untyped value whose member is a field, or a union
 * of them. JavaScript sources pass their receivers through the dynamic calls
 * they already lower to, and a method is called on its receiver by its own
 * lowering. */
export function memberCallHolder(lowerer: Lowerer, call: ts.CallExpression): ts.Expression | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  const callee = withoutParenthesesTypeWrappers(call.expression);
  let name: string | null;
  if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
  else if (ts.isElementAccessExpression(callee))
    // An index names an element, not a member a store names.
    name =
      (lowerer.typeOf(callee.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0
        ? null
        : lowerer.foldedStringKeyOf(callee.argumentExpression);
  else return null;
  const census = lowerer.memberCallReceiverCensus();
  if (!census.any || !(name === null ? census.keyed() : census.carries(name))) return null;
  // `x?.f` holds `x` when it is not nullish, and the call is not reached
  // when it is.
  const holderType =
    lowerer.chainNarrowedType.get(callee.expression) ?? lowerer.typeOf(callee.expression);
  // A binding keeps the representation it was stored with, whatever the
  // checker calls it (`const loose: any = record`).
  const stored = ts.isIdentifier(callee.expression)
    ? (lowerer.peekLocal(callee.expression)?.type ?? lowerer.globalOf(callee.expression)?.type)
    : undefined;
  const holder =
    stored?.kind === "record"
      ? stored
      : (lowerer.mapTypeOf(holderType) ??
        ((holderType.flags & ts.TypeFlags.Any) !== 0 ? DYN : null));
  const structural = (type: IrType | null | undefined): boolean =>
    type?.kind === "record" || type?.kind === "array";
  // A class is the holder of its static fields.
  const nominal = (type: IrType | null | undefined): boolean =>
    type?.kind === "object" || type?.kind === "dyn" || type?.kind === "classval";
  // A class instance's method, and the standard library's members, have
  // their own calls; a field is called through its value.
  const field = (): boolean => {
    if (name === null) return holder?.kind === "dyn";
    const member = lowerer.checker.getPropertyOfType(
      lowerer.checker.getNonNullableType(holderType),
      name,
    );
    if (member === undefined) return true;
    return (
      !lowerer.isStdlibSymbol(member) &&
      !(member.declarations ?? []).some(
        (declaration) =>
          ts.isMethodDeclaration(declaration) || ts.isMethodSignatureDeclaration(declaration),
      )
    );
  };
  if (structural(holder)) return callee.expression;
  if (nominal(holder)) return field() ? callee.expression : null;
  if (holder?.kind !== "union") return null;
  const arms = lowerer.unions.get(holder.unionId)?.arms ?? [];
  const held = arms.filter((arm) => structural(arm) || nominal(arm));
  if (
    held.length === 0 ||
    !arms.every((arm) => held.includes(arm) || arm.kind === "undefinedT" || arm.kind === "nullT")
  )
    return null;
  return held.every(structural) || field() ? callee.expression : null;
}

/** Whether `value`, the lowered `node`, reads a binding that holds the same
 * object until the enclosing function returns: an immutable local or module
 * binding, or a parameter or variable nothing assigns after its
 * declaration. */
export function stableBinding(lowerer: Lowerer, value: IrExpr, node: ts.Expression): boolean {
  if (value.kind !== "varRef") return false;
  const local = lowerer.ctx.locals.find((candidate) => candidate.id === value.localId);
  if (local !== undefined && !local.mutable && local.tdz !== true) return true;
  const global = lowerer.globalsList.find((candidate) => candidate.id === value.localId);
  if (global !== undefined && !global.mutable && global.tdz !== true) return true;
  if (local === undefined || local.tdz === true) return false;
  const name = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(name)) return false;
  const symbol = lowerer.resolveValueSymbol(name);
  const declaration = symbol?.valueDeclaration;
  return (
    symbol !== null &&
    symbol !== undefined &&
    declaration !== undefined &&
    (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
    bindingNeverReassigned(lowerer.bindingScope(), symbol, declaration)
  );
}

/** Lowers a call through its callee's value with the holder evaluated once
 * and passed as the call's receiver. `lower` builds the call while reads of
 * the holder answer the saved value, and is handed the receiver to attach
 * (undefined when the holder has no dynamic form). */
export function withMemberCallReceiver(
  lowerer: Lowerer,
  call: ts.CallExpression,
  holderNode: ts.Expression,
  lower: (receiver: IrExpr | undefined) => IrExpr,
): IrExpr {
  const loc = locOf(call);
  const holder = lowerer.lowerExpr(holderNode);
  const boxes = (value: IrExpr): IrExpr | undefined =>
    value.type.kind === "dyn"
      ? value
      : (value.type.kind === "record" ||
            value.type.kind === "array" ||
            value.type.kind === "object" ||
            value.type.kind === "classval" ||
            value.type.kind === "union") &&
          lowerer.dynConvertible(value.type)
        ? lowerer.coerceToExpected(value, DYN)
        : undefined;
  // A binding nothing can reassign is the holder for the whole call.
  if (stableBinding(lowerer, holder, holderNode)) return lower(boxes(holder));
  const local = lowerer.declareHiddenLocal("%callReceiver", holder.type);
  const reference = varRef(local.id, holder.type, loc);
  const receiver = boxes(reference);
  const result = lowerer.withExpressionOverride(holderNode, reference, () => lower(receiver));
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: holder, loc }],
    result,
    type: result.type,
    loc,
  };
}
